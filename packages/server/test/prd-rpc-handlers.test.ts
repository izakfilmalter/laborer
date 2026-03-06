import { assert, describe, it } from "@effect/vitest";
import { events, tables } from "@laborer/shared/schema";
import { Effect, Either, Layer } from "effect";
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
import { TestLaborerStore } from "./helpers/test-store.js";

const project = {
	id: "project-1",
	name: "laborer",
	repoPath: "/repo/laborer",
	rlphConfig: null,
} as const;

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
	it.scoped(
		"creates a PRD, writes the file, and lists the saved metadata",
		() => {
			const calls: [string, string, string, string][] = [];
			const createPrdFile: PrdStorageService["Type"]["createPrdFile"] = (
				repoPath,
				name,
				title,
				content
			) => {
				calls.push([repoPath, name, title, content]);
				return Effect.succeed("/tmp/prds/PRD-mcp-server-prd-workflow.md");
			};

			return Effect.gen(function* () {
				const created = yield* handlePrdCreate({
					projectId: project.id,
					title: "MCP Server & PRD Workflow",
					content: "# PRD\n",
				});

				assert.strictEqual(created.projectId, project.id);
				assert.strictEqual(created.title, "MCP Server & PRD Workflow");
				assert.strictEqual(created.slug, "mcp-server-prd-workflow");
				assert.strictEqual(
					created.filePath,
					"/tmp/prds/PRD-mcp-server-prd-workflow.md"
				);
				assert.strictEqual(created.status, "draft");

				const listed = yield* handlePrdList({ projectId: project.id });
				assert.deepStrictEqual(listed, [created]);

				assert.strictEqual(calls.length, 1);
				assert.strictEqual(calls[0]?.[0], project.repoPath);
				assert.strictEqual(calls[0]?.[1], project.name);
				assert.strictEqual(calls[0]?.[2], "MCP Server & PRD Workflow");
				assert.strictEqual(calls[0]?.[3], "# PRD\n");
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						makeProjectRegistryLayer(),
						makePrdStorageLayer({ createPrdFile })
					).pipe(Layer.provideMerge(TestTaskManager))
				)
			);
		}
	);

	it.scoped("rejects duplicate PRD titles within the same project", () =>
		Effect.gen(function* () {
			yield* handlePrdCreate({
				projectId: project.id,
				title: "Shared plan",
				content: "# First\n",
			});

			const result = yield* handlePrdCreate({
				projectId: project.id,
				title: "Shared plan",
				content: "# Second\n",
			}).pipe(Effect.either);

			assert.isTrue(Either.isLeft(result));
			if (Either.isLeft(result)) {
				assert.strictEqual(result.left.code, "ALREADY_EXISTS");
				assert.include(result.left.message, "Shared plan");
			}
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					makeProjectRegistryLayer(),
					makePrdStorageLayer({
						createPrdFile: (
							_repoPath: string,
							_name: string,
							title: string,
							_content: string
						) => Effect.succeed(`/tmp/prds/PRD-${title}.md`),
					})
				).pipe(Layer.provideMerge(TestTaskManager))
			)
		)
	);

	it.scoped(
		"creates a PRD issue, appends it to the issues file, and returns the PRD task",
		() => {
			let appendIssueCalls: unknown[][] = [];
			const appendIssue: PrdStorageService["Type"]["appendIssue"] = (
				...args
			) => {
				appendIssueCalls.push(args);
				return Effect.succeed({
					issueFilePath: "/tmp/prds/PRD-mcp-server-prd-workflow-issues.md",
					issueNumber: 2,
				});
			};

			return Effect.gen(function* () {
				appendIssueCalls = [];
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

				assert.strictEqual(createdIssue.projectId, project.id);
				assert.strictEqual(createdIssue.source, "prd");
				assert.strictEqual(createdIssue.prdId, createdPrd.id);
				assert.strictEqual(createdIssue.externalId, `${createdPrd.id}:issue:2`);
				assert.strictEqual(createdIssue.title, "Create issue RPC");
				assert.strictEqual(createdIssue.status, "pending");

				assert.strictEqual(appendIssueCalls.length, 1);
				assert.strictEqual(
					appendIssueCalls[0]?.[0],
					"/tmp/prds/PRD-mcp-server-prd-workflow.md"
				);
				assert.strictEqual(appendIssueCalls[0]?.[1], "Create issue RPC");
				assert.strictEqual(
					appendIssueCalls[0]?.[2],
					["### Parent PRD", "", "PRD-mcp-prd-driven-tasks.md"].join("\n")
				);
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						makeProjectRegistryLayer(),
						makePrdStorageLayer({
							createPrdFile: () =>
								Effect.succeed("/tmp/prds/PRD-mcp-server-prd-workflow.md"),
							appendIssue,
						})
					).pipe(Layer.provideMerge(TestTaskManager))
				)
			);
		}
	);

	it.scoped("reads PRD metadata and markdown content from disk", () => {
		let readPrdFileCalls: string[] = [];
		const readPrdFile: PrdStorageService["Type"]["readPrdFile"] = (
			filePath
		) => {
			readPrdFileCalls.push(filePath);
			return Effect.succeed("# Stored PRD\n");
		};

		return Effect.gen(function* () {
			readPrdFileCalls = [];
			const created = yield* handlePrdCreate({
				projectId: project.id,
				title: "Readable PRD",
				content: "# Draft\n",
			});

			const read = yield* handlePrdRead({ prdId: created.id });

			assert.deepStrictEqual(read, {
				...created,
				content: "# Stored PRD\n",
			});

			assert.strictEqual(readPrdFileCalls.length, 1);
			assert.strictEqual(readPrdFileCalls[0], "/tmp/prds/PRD-readable-prd.md");
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					makeProjectRegistryLayer(),
					makePrdStorageLayer({
						createPrdFile: () =>
							Effect.succeed("/tmp/prds/PRD-readable-prd.md"),
						readPrdFile,
					})
				).pipe(Layer.provideMerge(TestTaskManager))
			)
		);
	});

	it.scoped("reads issues markdown for an existing PRD", () => {
		let readIssuesFileCalls: string[] = [];
		const readIssuesFile: PrdStorageService["Type"]["readIssuesFile"] = (
			filePath
		) => {
			readIssuesFileCalls.push(filePath);
			return Effect.succeed(
				"## Issue 1: Create issue RPC\n\n### What to build\n"
			);
		};

		return Effect.gen(function* () {
			readIssuesFileCalls = [];
			const created = yield* handlePrdCreate({
				projectId: project.id,
				title: "Readable Issues PRD",
				content: "# Draft\n",
			});

			const issues = yield* handlePrdReadIssues({ prdId: created.id });

			assert.strictEqual(
				issues,
				"## Issue 1: Create issue RPC\n\n### What to build\n"
			);

			assert.strictEqual(readIssuesFileCalls.length, 1);
			assert.strictEqual(
				readIssuesFileCalls[0],
				"/tmp/prds/PRD-readable-issues-prd.md"
			);
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					makeProjectRegistryLayer(),
					makePrdStorageLayer({
						createPrdFile: () =>
							Effect.succeed("/tmp/prds/PRD-readable-issues-prd.md"),
						readIssuesFile,
					})
				).pipe(Layer.provideMerge(TestTaskManager))
			)
		);
	});

	it.scoped("returns an empty string when a PRD has no issues file yet", () =>
		Effect.gen(function* () {
			const created = yield* handlePrdCreate({
				projectId: project.id,
				title: "No Issues Yet",
				content: "# Draft\n",
			});

			const issues = yield* handlePrdReadIssues({ prdId: created.id });

			assert.strictEqual(issues, "");
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					makeProjectRegistryLayer(),
					makePrdStorageLayer({
						createPrdFile: () =>
							Effect.succeed("/tmp/prds/PRD-no-issues-yet.md"),
						readIssuesFile: () => Effect.succeed(""),
					})
				).pipe(Layer.provideMerge(TestTaskManager))
			)
		)
	);

	it.scoped(
		"updates PRD markdown content and returns the existing metadata",
		() => {
			let updatePrdFileCalls: [string, string][] = [];
			const updatePrdFile: PrdStorageService["Type"]["updatePrdFile"] = (
				filePath,
				content
			) => {
				updatePrdFileCalls.push([filePath, content]);
				return Effect.void;
			};

			return Effect.gen(function* () {
				updatePrdFileCalls = [];
				const created = yield* handlePrdCreate({
					projectId: project.id,
					title: "Editable PRD",
					content: "# Draft\n",
				});

				const updated = yield* handlePrdUpdate({
					prdId: created.id,
					content: "# Final\n",
				});

				assert.deepStrictEqual(updated, created);

				assert.strictEqual(updatePrdFileCalls.length, 1);
				assert.strictEqual(
					updatePrdFileCalls[0]?.[0],
					"/tmp/prds/PRD-editable-prd.md"
				);
				assert.strictEqual(updatePrdFileCalls[0]?.[1], "# Final\n");
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						makeProjectRegistryLayer(),
						makePrdStorageLayer({
							createPrdFile: () =>
								Effect.succeed("/tmp/prds/PRD-editable-prd.md"),
							updatePrdFile,
						})
					).pipe(Layer.provideMerge(TestTaskManager))
				)
			);
		}
	);

	it.scoped("updates PRD status and persists the new value", () =>
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

			assert.strictEqual(updated.status, "active");

			const listed = yield* handlePrdList({ projectId: project.id });
			assert.strictEqual(listed.length, 1);
			assert.strictEqual(listed[0]?.id, created.id);
			assert.strictEqual(listed[0]?.status, "active");
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					makeProjectRegistryLayer(),
					makePrdStorageLayer({
						createPrdFile: () =>
							Effect.succeed("/tmp/prds/PRD-statusful-prd.md"),
					})
				).pipe(Layer.provideMerge(TestTaskManager))
			)
		)
	);

	it.scoped("returns not found when reading a missing PRD", () =>
		Effect.gen(function* () {
			const result = yield* handlePrdRead({ prdId: "missing-prd" }).pipe(
				Effect.either
			);

			assert.isTrue(Either.isLeft(result));
			if (Either.isLeft(result)) {
				assert.strictEqual(result.left.code, "NOT_FOUND");
				assert.include(result.left.message, "missing-prd");
			}
		}).pipe(
			Effect.provide(
				makePrdStorageLayer({
					createPrdFile: () => Effect.die("not used in this test"),
				}).pipe(Layer.provideMerge(TestTaskManager))
			)
		)
	);

	it.scoped("returns not found when updating a missing PRD", () =>
		Effect.gen(function* () {
			const result = yield* handlePrdUpdate({
				prdId: "missing-prd",
				content: "# Updated\n",
			}).pipe(Effect.either);

			assert.isTrue(Either.isLeft(result));
			if (Either.isLeft(result)) {
				assert.strictEqual(result.left.code, "NOT_FOUND");
				assert.include(result.left.message, "missing-prd");
			}
		}).pipe(
			Effect.provide(
				makePrdStorageLayer({
					createPrdFile: () => Effect.die("not used in this test"),
				}).pipe(Layer.provideMerge(TestTaskManager))
			)
		)
	);

	it.scoped("rejects invalid PRD status updates", () =>
		Effect.gen(function* () {
			const created = yield* handlePrdCreate({
				projectId: project.id,
				title: "Validated PRD",
				content: "# Draft\n",
			});

			const result = yield* handlePrdUpdateStatus({
				prdId: created.id,
				status: "pending",
			}).pipe(Effect.either);

			assert.isTrue(Either.isLeft(result));
			if (Either.isLeft(result)) {
				assert.strictEqual(result.left.code, "INVALID_STATUS");
				assert.include(result.left.message, "pending");
			}
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					makeProjectRegistryLayer(),
					makePrdStorageLayer({
						createPrdFile: () =>
							Effect.succeed("/tmp/prds/PRD-validated-prd.md"),
					})
				).pipe(Layer.provideMerge(TestTaskManager))
			)
		)
	);

	it.scoped(
		"lists only pending and in-progress PRD issues for the requested PRD",
		() =>
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

				assert.strictEqual(remainingIssues.length, 2);
				assert.strictEqual(remainingIssues[0]?.id, pendingIssue.id);
				assert.strictEqual(remainingIssues[0]?.prdId, createdPrd.id);
				assert.strictEqual(remainingIssues[0]?.status, "pending");
				assert.strictEqual(remainingIssues[0]?.title, "Pending issue");
				assert.strictEqual(remainingIssues[1]?.id, inProgressIssue.id);
				assert.strictEqual(remainingIssues[1]?.prdId, createdPrd.id);
				assert.strictEqual(remainingIssues[1]?.status, "in_progress");
				assert.strictEqual(remainingIssues[1]?.title, "In-progress issue");
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						makeProjectRegistryLayer(),
						makePrdStorageLayer({
							createPrdFile: (
								_repoPath: string,
								_name: string,
								title: string,
								_content: string
							) => Effect.succeed(`/tmp/prds/PRD-${title}.md`),
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
					).pipe(Layer.provideMerge(TestTaskManager))
				)
			)
	);

	it.scoped(
		"updates PRD issue body and status for an existing PRD task",
		() => {
			let updateIssueCalls: unknown[][] = [];
			const updateIssue: PrdStorageService["Type"]["updateIssue"] = (
				...args
			) => {
				updateIssueCalls.push(args);
				return Effect.void;
			};

			return Effect.gen(function* () {
				updateIssueCalls = [];
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

				assert.strictEqual(updatedIssue.id, createdIssue.id);
				assert.strictEqual(updatedIssue.status, "completed");
				assert.strictEqual(updatedIssue.title, "Editable issue");

				const persistedTask = store.query(
					tables.tasks.where("id", createdIssue.id)
				)[0];
				assert.strictEqual(persistedTask?.status, "completed");

				assert.strictEqual(updateIssueCalls.length, 1);
				assert.strictEqual(
					updateIssueCalls[0]?.[0],
					"/tmp/prds/PRD-update-issues-prd.md"
				);
				assert.strictEqual(updateIssueCalls[0]?.[1], "Editable issue");
				assert.strictEqual(
					updateIssueCalls[0]?.[2],
					"### What to build\n\nUpdated body."
				);
				assert.strictEqual(updateIssueCalls[0]?.[3], 3);
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
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
					).pipe(Layer.provideMerge(TestTaskManager))
				)
			);
		}
	);

	it.scoped("updates only PRD issue status when no body is provided", () =>
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
			assert.strictEqual(persistedTask?.status, "in_progress");
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
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
				).pipe(Layer.provideMerge(TestTaskManager))
			)
		)
	);

	it.scoped("removes PRD files, linked PRD tasks, and the PRD record", () => {
		let removePrdArtifactsCalls: string[] = [];
		const removePrdArtifacts: PrdStorageService["Type"]["removePrdArtifacts"] =
			(filePath) => {
				removePrdArtifactsCalls.push(filePath);
				return Effect.void;
			};

		return Effect.gen(function* () {
			removePrdArtifactsCalls = [];
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

			assert.strictEqual(
				store.query(tables.prds.where("id", createdPrd.id)).length,
				0
			);
			assert.strictEqual(
				store.query(tables.tasks.where("prdId", createdPrd.id)).length,
				0
			);
			assert.strictEqual(manualTasks.length, 1);

			assert.strictEqual(removePrdArtifactsCalls.length, 1);
			assert.strictEqual(
				removePrdArtifactsCalls[0],
				"/tmp/prds/PRD-disposable-prd.md"
			);
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
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
				).pipe(Layer.provideMerge(TestTaskManager))
			)
		);
	});

	it.scoped("returns not found when removing a missing PRD", () =>
		Effect.gen(function* () {
			const result = yield* handlePrdRemove({ prdId: "missing-prd" }).pipe(
				Effect.either
			);

			assert.isTrue(Either.isLeft(result));
			if (Either.isLeft(result)) {
				assert.strictEqual(result.left.code, "NOT_FOUND");
				assert.include(result.left.message, "missing-prd");
			}
		}).pipe(
			Effect.provide(
				makePrdStorageLayer({
					createPrdFile: () => Effect.die("not used in this test"),
				}).pipe(Layer.provideMerge(TestTaskManager))
			)
		)
	);

	it.scoped("returns not found when reading issues for a missing PRD", () =>
		Effect.gen(function* () {
			const result = yield* handlePrdReadIssues({
				prdId: "missing-prd",
			}).pipe(Effect.either);

			assert.isTrue(Either.isLeft(result));
			if (Either.isLeft(result)) {
				assert.strictEqual(result.left.code, "NOT_FOUND");
				assert.include(result.left.message, "missing-prd");
			}
		}).pipe(
			Effect.provide(
				makePrdStorageLayer({
					createPrdFile: () => Effect.die("not used in this test"),
				}).pipe(Layer.provideMerge(TestTaskManager))
			)
		)
	);

	it.scoped(
		"returns not found when listing remaining issues for a missing PRD",
		() =>
			Effect.gen(function* () {
				const result = yield* handlePrdListRemainingIssues({
					prdId: "missing-prd",
				}).pipe(Effect.either);

				assert.isTrue(Either.isLeft(result));
				if (Either.isLeft(result)) {
					assert.strictEqual(result.left.code, "NOT_FOUND");
					assert.include(result.left.message, "missing-prd");
				}
			}).pipe(
				Effect.provide(
					makePrdStorageLayer({
						createPrdFile: () => Effect.die("not used in this test"),
					}).pipe(Layer.provideMerge(TestTaskManager))
				)
			)
	);

	it.scoped("returns not found when creating an issue for a missing PRD", () =>
		Effect.gen(function* () {
			const result = yield* handlePrdCreateIssue({
				prdId: "missing-prd",
				title: "Create issue RPC",
				body: "### What to build",
			}).pipe(Effect.either);

			assert.isTrue(Either.isLeft(result));
			if (Either.isLeft(result)) {
				assert.strictEqual(result.left.code, "NOT_FOUND");
				assert.include(result.left.message, "missing-prd");
			}
		}).pipe(
			Effect.provide(
				makePrdStorageLayer({
					createPrdFile: () => Effect.die("not used in this test"),
				}).pipe(Layer.provideMerge(TestTaskManager))
			)
		)
	);

	it.scoped("returns not found when updating a missing PRD issue task", () =>
		Effect.gen(function* () {
			const result = yield* handlePrdUpdateIssue({
				taskId: "missing-task",
				body: "### What to build\n\nUpdated body.",
			}).pipe(Effect.either);

			assert.isTrue(Either.isLeft(result));
			if (Either.isLeft(result)) {
				assert.strictEqual(result.left.code, "NOT_FOUND");
				assert.include(result.left.message, "missing-task");
			}
		}).pipe(
			Effect.provide(
				makePrdStorageLayer({
					createPrdFile: () => Effect.die("not used in this test"),
				}).pipe(Layer.provideMerge(TestTaskManager))
			)
		)
	);
});
