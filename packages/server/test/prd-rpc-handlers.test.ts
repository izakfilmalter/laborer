import { events, schema, tables } from "@laborer/shared/schema";
import { makeAdapter } from "@livestore/adapter-node";
import { createStore, provideOtel } from "@livestore/livestore";
import { Effect, Either, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
	handlePrdCreate,
	handlePrdCreateIssue,
	handlePrdList,
	handlePrdListRemainingIssues,
	handlePrdRead,
	handlePrdReadIssues,
	handlePrdRemove,
	handlePrdUpdate,
	handlePrdUpdateIssue,
	handlePrdUpdateStatus,
} from "../src/rpc/handlers.js";
import { LaborerStore } from "../src/services/laborer-store.js";
import { PrdStorageService } from "../src/services/prd-storage-service.js";
import { ProjectRegistry } from "../src/services/project-registry.js";
import { TaskManager } from "../src/services/task-manager.js";

const project = {
	id: "project-1",
	name: "laborer",
	repoPath: "/repo/laborer",
	rlphConfig: null,
} as const;

const makeTestStore = Effect.gen(function* () {
	const adapter = makeAdapter({ storage: { type: "in-memory" } });
	const store = yield* createStore({
		schema,
		storeId: `test-${crypto.randomUUID()}`,
		adapter,
		batchUpdates: (run) => run(),
		disableDevtools: true,
	});

	return { store };
}).pipe(provideOtel({}));

const TestLaborerStore = Layer.scoped(LaborerStore, makeTestStore).pipe(
	Layer.orDie
);

const TestTaskManager = TaskManager.layer.pipe(
	Layer.provideMerge(TestLaborerStore)
);

const makeProjectRegistryLayer = () =>
	Layer.succeed(
		ProjectRegistry,
		ProjectRegistry.of({
			addProject: () => Effect.die("not used in this test"),
			removeProject: () => Effect.die("not used in this test"),
			listProjects: () => Effect.succeed([project]),
			getProject: (projectId: string) =>
				projectId === project.id
					? Effect.succeed(project)
					: Effect.die(`unexpected project lookup: ${projectId}`),
		})
	);

const makePrdStorageLayer = ({
	appendIssue,
	createPrdFile,
	readIssuesFile,
	readPrdFile,
	removePrdArtifacts,
	updateIssue,
	updatePrdFile,
}: {
	appendIssue?: PrdStorageService["Type"]["appendIssue"];
	createPrdFile: PrdStorageService["Type"]["createPrdFile"];
	readIssuesFile?: PrdStorageService["Type"]["readIssuesFile"];
	readPrdFile?: PrdStorageService["Type"]["readPrdFile"];
	removePrdArtifacts?: PrdStorageService["Type"]["removePrdArtifacts"];
	updateIssue?: PrdStorageService["Type"]["updateIssue"];
	updatePrdFile?: PrdStorageService["Type"]["updatePrdFile"];
}) =>
	Layer.succeed(
		PrdStorageService,
		PrdStorageService.of({
			createPrdFile,
			readPrdFile: readPrdFile ?? (() => Effect.die("not used in this test")),
			readIssuesFile:
				readIssuesFile ?? (() => Effect.die("not used in this test")),
			updatePrdFile:
				updatePrdFile ?? (() => Effect.die("not used in this test")),
			appendIssue: appendIssue ?? (() => Effect.die("not used in this test")),
			updateIssue: updateIssue ?? (() => Effect.die("not used in this test")),
			removePrdArtifacts:
				removePrdArtifacts ?? (() => Effect.die("not used in this test")),
			resolvePrdsDir: () => Effect.die("not used in this test"),
		})
	);

describe("PRD RPC handlers", () => {
	it("creates a PRD, writes the file, and lists the saved metadata", async () => {
		const createPrdFile = vi.fn(() =>
			Effect.succeed("/tmp/prds/PRD-mcp-server-prd-workflow.md")
		);

		await Effect.runPromise(
			Effect.gen(function* () {
				const created = yield* handlePrdCreate({
					projectId: project.id,
					title: "MCP Server & PRD Workflow",
					content: "# PRD\n",
				});

				expect(created).toEqual(
					expect.objectContaining({
						projectId: project.id,
						title: "MCP Server & PRD Workflow",
						slug: "mcp-server-prd-workflow",
						filePath: "/tmp/prds/PRD-mcp-server-prd-workflow.md",
						status: "draft",
					})
				);

				const listed = yield* handlePrdList({ projectId: project.id });
				expect(listed).toEqual([created]);
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						TestLaborerStore,
						TestTaskManager,
						makeProjectRegistryLayer(),
						makePrdStorageLayer({ createPrdFile })
					)
				)
			)
		);

		expect(createPrdFile).toHaveBeenCalledWith(
			project.repoPath,
			project.name,
			"MCP Server & PRD Workflow",
			"# PRD\n"
		);
	});

	it("rejects duplicate PRD titles within the same project", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				yield* handlePrdCreate({
					projectId: project.id,
					title: "Shared plan",
					content: "# First\n",
				});

				return yield* handlePrdCreate({
					projectId: project.id,
					title: "Shared plan",
					content: "# Second\n",
				}).pipe(Effect.either);
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						TestLaborerStore,
						TestTaskManager,
						makeProjectRegistryLayer(),
						makePrdStorageLayer({
							createPrdFile: (_, __, title) =>
								Effect.succeed(`/tmp/prds/PRD-${title}.md`),
						})
					)
				)
			)
		);

		expect(Either.isLeft(result)).toBe(true);
		if (Either.isLeft(result)) {
			expect(result.left.code).toBe("ALREADY_EXISTS");
			expect(result.left.message).toContain("Shared plan");
		}
	});

	it("creates a PRD issue, appends it to the issues file, and returns the PRD task", async () => {
		const appendIssue = vi.fn(() =>
			Effect.succeed({
				issueFilePath: "/tmp/prds/PRD-mcp-server-prd-workflow-issues.md",
				issueNumber: 2,
			})
		);

		await Effect.runPromise(
			Effect.gen(function* () {
				const { store } = yield* LaborerStore;
				store.commit(
					events.projectCreated({
						id: project.id,
						repoPath: project.repoPath,
						name: project.name,
						rlphConfig: project.rlphConfig,
					})
				);

				const createdPrd = yield* handlePrdCreate({
					projectId: project.id,
					title: "MCP Server & PRD Workflow",
					content: "# PRD\n",
				});

				const createdIssue = yield* handlePrdCreateIssue({
					prdId: createdPrd.id,
					title: "Create issue RPC",
					body: ["### Parent PRD", "", "PRD-mcp-prd-driven-tasks.md"].join(
						"\n"
					),
				});

				expect(createdIssue).toEqual(
					expect.objectContaining({
						projectId: project.id,
						source: "prd",
						prdId: createdPrd.id,
						externalId: `${createdPrd.id}:issue:2`,
						title: "Create issue RPC",
						status: "pending",
					})
				);
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						TestLaborerStore,
						TestTaskManager,
						makeProjectRegistryLayer(),
						makePrdStorageLayer({
							createPrdFile: () =>
								Effect.succeed("/tmp/prds/PRD-mcp-server-prd-workflow.md"),
							appendIssue,
						})
					)
				)
			)
		);

		expect(appendIssue).toHaveBeenCalledWith(
			"/tmp/prds/PRD-mcp-server-prd-workflow.md",
			"Create issue RPC",
			["### Parent PRD", "", "PRD-mcp-prd-driven-tasks.md"].join("\n")
		);
	});

	it("reads PRD metadata and markdown content from disk", async () => {
		const readPrdFile = vi.fn(() => Effect.succeed("# Stored PRD\n"));

		await Effect.runPromise(
			Effect.gen(function* () {
				const created = yield* handlePrdCreate({
					projectId: project.id,
					title: "Readable PRD",
					content: "# Draft\n",
				});

				const read = yield* handlePrdRead({ prdId: created.id });

				expect(read).toEqual({
					...created,
					content: "# Stored PRD\n",
				});
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						TestLaborerStore,
						TestTaskManager,
						makeProjectRegistryLayer(),
						makePrdStorageLayer({
							createPrdFile: () =>
								Effect.succeed("/tmp/prds/PRD-readable-prd.md"),
							readPrdFile,
						})
					)
				)
			)
		);

		expect(readPrdFile).toHaveBeenCalledWith("/tmp/prds/PRD-readable-prd.md");
	});

	it("reads issues markdown for an existing PRD", async () => {
		const readIssuesFile = vi.fn(() =>
			Effect.succeed("## Issue 1: Create issue RPC\n\n### What to build\n")
		);

		await Effect.runPromise(
			Effect.gen(function* () {
				const created = yield* handlePrdCreate({
					projectId: project.id,
					title: "Readable Issues PRD",
					content: "# Draft\n",
				});

				const issues = yield* handlePrdReadIssues({ prdId: created.id });

				expect(issues).toBe(
					"## Issue 1: Create issue RPC\n\n### What to build\n"
				);
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						TestLaborerStore,
						TestTaskManager,
						makeProjectRegistryLayer(),
						makePrdStorageLayer({
							createPrdFile: () =>
								Effect.succeed("/tmp/prds/PRD-readable-issues-prd.md"),
							readIssuesFile,
						})
					)
				)
			)
		);

		expect(readIssuesFile).toHaveBeenCalledWith(
			"/tmp/prds/PRD-readable-issues-prd.md"
		);
	});

	it("returns an empty string when a PRD has no issues file yet", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const created = yield* handlePrdCreate({
					projectId: project.id,
					title: "No Issues Yet",
					content: "# Draft\n",
				});

				const issues = yield* handlePrdReadIssues({ prdId: created.id });

				expect(issues).toBe("");
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						TestLaborerStore,
						TestTaskManager,
						makeProjectRegistryLayer(),
						makePrdStorageLayer({
							createPrdFile: () =>
								Effect.succeed("/tmp/prds/PRD-no-issues-yet.md"),
							readIssuesFile: () => Effect.succeed(""),
						})
					)
				)
			)
		);
	});

	it("updates PRD markdown content and returns the existing metadata", async () => {
		const updatePrdFile = vi.fn(() => Effect.void);

		await Effect.runPromise(
			Effect.gen(function* () {
				const created = yield* handlePrdCreate({
					projectId: project.id,
					title: "Editable PRD",
					content: "# Draft\n",
				});

				const updated = yield* handlePrdUpdate({
					prdId: created.id,
					content: "# Final\n",
				});

				expect(updated).toEqual(created);
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						TestLaborerStore,
						TestTaskManager,
						makeProjectRegistryLayer(),
						makePrdStorageLayer({
							createPrdFile: () =>
								Effect.succeed("/tmp/prds/PRD-editable-prd.md"),
							updatePrdFile,
						})
					)
				)
			)
		);

		expect(updatePrdFile).toHaveBeenCalledWith(
			"/tmp/prds/PRD-editable-prd.md",
			"# Final\n"
		);
	});

	it("updates PRD status and persists the new value", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const created = yield* handlePrdCreate({
					projectId: project.id,
					title: "Statusful PRD",
					content: "# Draft\n",
				});

				const updated = yield* handlePrdUpdateStatus({
					prdId: created.id,
					status: "active",
				});

				expect(updated.status).toBe("active");

				const listed = yield* handlePrdList({ projectId: project.id });
				expect(listed).toEqual([
					expect.objectContaining({
						id: created.id,
						status: "active",
					}),
				]);
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						TestLaborerStore,
						TestTaskManager,
						makeProjectRegistryLayer(),
						makePrdStorageLayer({
							createPrdFile: () =>
								Effect.succeed("/tmp/prds/PRD-statusful-prd.md"),
						})
					)
				)
			)
		);
	});

	it("returns not found when reading a missing PRD", async () => {
		const result = await Effect.runPromise(
			handlePrdRead({ prdId: "missing-prd" }).pipe(
				Effect.either,
				Effect.provide(
					Layer.mergeAll(
						TestLaborerStore,
						TestTaskManager,
						makePrdStorageLayer({
							createPrdFile: () => Effect.die("not used in this test"),
						})
					)
				)
			)
		);

		expect(Either.isLeft(result)).toBe(true);
		if (Either.isLeft(result)) {
			expect(result.left.code).toBe("NOT_FOUND");
			expect(result.left.message).toContain("missing-prd");
		}
	});

	it("returns not found when updating a missing PRD", async () => {
		const result = await Effect.runPromise(
			handlePrdUpdate({ prdId: "missing-prd", content: "# Updated\n" }).pipe(
				Effect.either,
				Effect.provide(
					Layer.mergeAll(
						TestLaborerStore,
						TestTaskManager,
						makePrdStorageLayer({
							createPrdFile: () => Effect.die("not used in this test"),
						})
					)
				)
			)
		);

		expect(Either.isLeft(result)).toBe(true);
		if (Either.isLeft(result)) {
			expect(result.left.code).toBe("NOT_FOUND");
			expect(result.left.message).toContain("missing-prd");
		}
	});

	it("rejects invalid PRD status updates", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const created = yield* handlePrdCreate({
					projectId: project.id,
					title: "Validated PRD",
					content: "# Draft\n",
				});

				return yield* handlePrdUpdateStatus({
					prdId: created.id,
					status: "pending",
				}).pipe(Effect.either);
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						TestLaborerStore,
						TestTaskManager,
						makeProjectRegistryLayer(),
						makePrdStorageLayer({
							createPrdFile: () =>
								Effect.succeed("/tmp/prds/PRD-validated-prd.md"),
						})
					)
				)
			)
		);

		expect(Either.isLeft(result)).toBe(true);
		if (Either.isLeft(result)) {
			expect(result.left.code).toBe("INVALID_STATUS");
			expect(result.left.message).toContain("pending");
		}
	});

	it("lists only pending and in-progress PRD issues for the requested PRD", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const { store } = yield* LaborerStore;
				store.commit(
					events.projectCreated({
						id: project.id,
						repoPath: project.repoPath,
						name: project.name,
						rlphConfig: project.rlphConfig,
					})
				);

				const createdPrd = yield* handlePrdCreate({
					projectId: project.id,
					title: "Remaining Issues PRD",
					content: "# PRD\n",
				});
				const otherPrd = yield* handlePrdCreate({
					projectId: project.id,
					title: "Other PRD",
					content: "# PRD\n",
				});

				const pendingIssue = yield* handlePrdCreateIssue({
					prdId: createdPrd.id,
					title: "Pending issue",
					body: "### What to build\n\nKeep this pending.",
				});
				const inProgressIssue = yield* handlePrdCreateIssue({
					prdId: createdPrd.id,
					title: "In-progress issue",
					body: "### What to build\n\nStart this now.",
				});
				const completedIssue = yield* handlePrdCreateIssue({
					prdId: createdPrd.id,
					title: "Completed issue",
					body: "### What to build\n\nAlready done.",
				});
				yield* handlePrdCreateIssue({
					prdId: otherPrd.id,
					title: "Other PRD issue",
					body: "### What to build\n\nExclude this.",
				});
				const taskManager = yield* TaskManager;
				yield* taskManager.updateTaskStatus(inProgressIssue.id, "in_progress");
				yield* taskManager.updateTaskStatus(completedIssue.id, "completed");

				const remainingIssues = yield* handlePrdListRemainingIssues({
					prdId: createdPrd.id,
				});

				expect(remainingIssues).toEqual([
					expect.objectContaining({
						id: pendingIssue.id,
						prdId: createdPrd.id,
						status: "pending",
						title: "Pending issue",
					}),
					expect.objectContaining({
						id: inProgressIssue.id,
						prdId: createdPrd.id,
						status: "in_progress",
						title: "In-progress issue",
					}),
				]);
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						TestLaborerStore,
						TestTaskManager,
						makeProjectRegistryLayer(),
						makePrdStorageLayer({
							createPrdFile: (_, __, title) =>
								Effect.succeed(`/tmp/prds/PRD-${title}.md`),
							appendIssue: (() => {
								let issueNumber = 0;
								return () => {
									issueNumber += 1;
									return Effect.succeed({
										issueFilePath: "/tmp/prds/issues.md",
										issueNumber,
									});
								};
							})(),
						})
					)
				)
			)
		);
	});

	it("updates PRD issue body and status for an existing PRD task", async () => {
		const updateIssue = vi.fn(() => Effect.void);

		await Effect.runPromise(
			Effect.gen(function* () {
				const { store } = yield* LaborerStore;
				store.commit(
					events.projectCreated({
						id: project.id,
						repoPath: project.repoPath,
						name: project.name,
						rlphConfig: project.rlphConfig,
					})
				);

				const createdPrd = yield* handlePrdCreate({
					projectId: project.id,
					title: "Update Issues PRD",
					content: "# PRD\n",
				});
				const createdIssue = yield* handlePrdCreateIssue({
					prdId: createdPrd.id,
					title: "Editable issue",
					body: "### What to build\n\nOriginal body.",
				});

				const updatedIssue = yield* handlePrdUpdateIssue({
					taskId: createdIssue.id,
					body: "### What to build\n\nUpdated body.",
					status: "completed",
				});

				expect(updatedIssue).toEqual(
					expect.objectContaining({
						id: createdIssue.id,
						status: "completed",
						title: "Editable issue",
					})
				);

				const persistedTask = store.query(
					tables.tasks.where("id", createdIssue.id)
				)[0];
				expect(persistedTask?.status).toBe("completed");
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						TestLaborerStore,
						TestTaskManager,
						makeProjectRegistryLayer(),
						makePrdStorageLayer({
							createPrdFile: () =>
								Effect.succeed("/tmp/prds/PRD-update-issues-prd.md"),
							appendIssue: () =>
								Effect.succeed({
									issueFilePath: "/tmp/prds/PRD-update-issues-prd-issues.md",
									issueNumber: 3,
								}),
							updateIssue,
						})
					)
				)
			)
		);

		expect(updateIssue).toHaveBeenCalledWith(
			"/tmp/prds/PRD-update-issues-prd.md",
			"Editable issue",
			"### What to build\n\nUpdated body.",
			3
		);
	});

	it("updates only PRD issue status when no body is provided", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const { store } = yield* LaborerStore;
				store.commit(
					events.projectCreated({
						id: project.id,
						repoPath: project.repoPath,
						name: project.name,
						rlphConfig: project.rlphConfig,
					})
				);

				const createdPrd = yield* handlePrdCreate({
					projectId: project.id,
					title: "Status-only PRD",
					content: "# PRD\n",
				});
				const createdIssue = yield* handlePrdCreateIssue({
					prdId: createdPrd.id,
					title: "Status-only issue",
					body: "### What to build\n\nOnly update status.",
				});

				yield* handlePrdUpdateIssue({
					taskId: createdIssue.id,
					status: "in_progress",
				});

				const persistedTask = store.query(
					tables.tasks.where("id", createdIssue.id)
				)[0];
				expect(persistedTask?.status).toBe("in_progress");
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						TestLaborerStore,
						TestTaskManager,
						makeProjectRegistryLayer(),
						makePrdStorageLayer({
							createPrdFile: () =>
								Effect.succeed("/tmp/prds/PRD-status-only-prd.md"),
							appendIssue: () =>
								Effect.succeed({
									issueFilePath: "/tmp/prds/PRD-status-only-prd-issues.md",
									issueNumber: 1,
								}),
						})
					)
				)
			)
		);
	});

	it("removes PRD files, linked PRD tasks, and the PRD record", async () => {
		const removePrdArtifacts = vi.fn(() => Effect.void);

		await Effect.runPromise(
			Effect.gen(function* () {
				const { store } = yield* LaborerStore;
				store.commit(
					events.projectCreated({
						id: project.id,
						repoPath: project.repoPath,
						name: project.name,
						rlphConfig: project.rlphConfig,
					})
				);

				const createdPrd = yield* handlePrdCreate({
					projectId: project.id,
					title: "Disposable PRD",
					content: "# PRD\n",
				});

				yield* handlePrdCreateIssue({
					prdId: createdPrd.id,
					title: "PRD-linked task",
					body: "### What to build\n\nRemove this task.",
				});

				const taskManager = yield* TaskManager;
				yield* taskManager.createTask(project.id, "Manual task", "manual");

				yield* handlePrdRemove({ prdId: createdPrd.id });

				const manualTasks = store
					.query(tables.tasks.where("projectId", project.id))
					.filter((task) => task.source === "manual");

				expect(
					store.query(tables.prds.where("id", createdPrd.id))
				).toHaveLength(0);
				expect(
					store.query(tables.tasks.where("prdId", createdPrd.id))
				).toHaveLength(0);
				expect(manualTasks).toHaveLength(1);
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						TestLaborerStore,
						TestTaskManager,
						makeProjectRegistryLayer(),
						makePrdStorageLayer({
							createPrdFile: () =>
								Effect.succeed("/tmp/prds/PRD-disposable-prd.md"),
							appendIssue: () =>
								Effect.succeed({
									issueFilePath: "/tmp/prds/PRD-disposable-prd-issues.md",
									issueNumber: 1,
								}),
							removePrdArtifacts,
						})
					)
				)
			)
		);

		expect(removePrdArtifacts).toHaveBeenCalledWith(
			"/tmp/prds/PRD-disposable-prd.md"
		);
	});

	it("returns not found when removing a missing PRD", async () => {
		const result = await Effect.runPromise(
			handlePrdRemove({ prdId: "missing-prd" }).pipe(
				Effect.either,
				Effect.provide(
					Layer.mergeAll(
						TestLaborerStore,
						TestTaskManager,
						makePrdStorageLayer({
							createPrdFile: () => Effect.die("not used in this test"),
						})
					)
				)
			)
		);

		expect(Either.isLeft(result)).toBe(true);
		if (Either.isLeft(result)) {
			expect(result.left.code).toBe("NOT_FOUND");
			expect(result.left.message).toContain("missing-prd");
		}
	});

	it("returns not found when reading issues for a missing PRD", async () => {
		const result = await Effect.runPromise(
			handlePrdReadIssues({ prdId: "missing-prd" }).pipe(
				Effect.either,
				Effect.provide(
					Layer.mergeAll(
						TestLaborerStore,
						TestTaskManager,
						makePrdStorageLayer({
							createPrdFile: () => Effect.die("not used in this test"),
						})
					)
				)
			)
		);

		expect(Either.isLeft(result)).toBe(true);
		if (Either.isLeft(result)) {
			expect(result.left.code).toBe("NOT_FOUND");
			expect(result.left.message).toContain("missing-prd");
		}
	});

	it("returns not found when listing remaining issues for a missing PRD", async () => {
		const result = await Effect.runPromise(
			handlePrdListRemainingIssues({ prdId: "missing-prd" }).pipe(
				Effect.either,
				Effect.provide(
					Layer.mergeAll(
						TestLaborerStore,
						TestTaskManager,
						makePrdStorageLayer({
							createPrdFile: () => Effect.die("not used in this test"),
						})
					)
				)
			)
		);

		expect(Either.isLeft(result)).toBe(true);
		if (Either.isLeft(result)) {
			expect(result.left.code).toBe("NOT_FOUND");
			expect(result.left.message).toContain("missing-prd");
		}
	});

	it("returns not found when creating an issue for a missing PRD", async () => {
		const result = await Effect.runPromise(
			handlePrdCreateIssue({
				prdId: "missing-prd",
				title: "Create issue RPC",
				body: "### What to build",
			}).pipe(
				Effect.either,
				Effect.provide(
					Layer.mergeAll(
						TestLaborerStore,
						TestTaskManager,
						makePrdStorageLayer({
							createPrdFile: () => Effect.die("not used in this test"),
						})
					)
				)
			)
		);

		expect(Either.isLeft(result)).toBe(true);
		if (Either.isLeft(result)) {
			expect(result.left.code).toBe("NOT_FOUND");
			expect(result.left.message).toContain("missing-prd");
		}
	});

	it("returns not found when updating a missing PRD issue task", async () => {
		const result = await Effect.runPromise(
			handlePrdUpdateIssue({
				taskId: "missing-task",
				body: "### What to build\n\nUpdated body.",
			}).pipe(
				Effect.either,
				Effect.provide(
					Layer.mergeAll(
						TestLaborerStore,
						TestTaskManager,
						makePrdStorageLayer({
							createPrdFile: () => Effect.die("not used in this test"),
						})
					)
				)
			)
		);

		expect(Either.isLeft(result)).toBe(true);
		if (Either.isLeft(result)) {
			expect(result.left.code).toBe("NOT_FOUND");
			expect(result.left.message).toContain("missing-task");
		}
	});
});
