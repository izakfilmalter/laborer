import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { events, schema, tables } from "@laborer/shared/schema";
import { makeAdapter } from "@livestore/adapter-node";
import { createStore, provideOtel } from "@livestore/livestore";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigService } from "../src/services/config-service.js";
import { LaborerStore } from "../src/services/laborer-store.js";
import { LinearTaskImporter } from "../src/services/linear-task-importer.js";
import { TaskManager } from "../src/services/task-manager.js";

const LINEAR_API_ERROR_REGEX = /Linear API request failed \(403\):/;

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

const TestLayer = LinearTaskImporter.layer.pipe(
	Layer.provide(ConfigService.layer),
	Layer.provide(TaskManager.layer),
	Layer.provideMerge(TestLaborerStore)
);

const runWithTestServices = <A, E>(
	effect: Effect.Effect<A, E, LinearTaskImporter | LaborerStore>
): Promise<A> =>
	Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const context = yield* Layer.build(TestLayer);
				return yield* Effect.provide(effect, Layer.succeedContext(context));
			})
		)
	);

describe("LinearTaskImporter.importProjectIssues", () => {
	const createdRepos: string[] = [];
	const originalLinearApiKey = process.env.LINEAR_API_KEY;

	const createProjectWithConfig = (configContent: string): string => {
		const repoPath = mkdtempSync(join(tmpdir(), "laborer-linear-import-"));
		createdRepos.push(repoPath);
		mkdirSync(join(repoPath, ".rlph"), { recursive: true });
		writeFileSync(join(repoPath, ".rlph", "config.toml"), configContent);
		return repoPath;
	};

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		process.env.LINEAR_API_KEY = originalLinearApiKey;
		for (const repoPath of createdRepos.splice(0)) {
			rmSync(repoPath, { force: true, recursive: true });
		}
	});

	it("imports Linear issues and skips duplicates", async () => {
		process.env.LINEAR_API_KEY = "linear-token";
		const repoPath = createProjectWithConfig(
			[
				'label = "ops"',
				"",
				"[linear]",
				'team = "ENG"',
				'project = "Core"',
			].join("\n")
		);

		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				data: {
					issues: {
						nodes: [
							{ identifier: "ENG-101", title: "Already imported" },
							{ identifier: "ENG-102", title: "Import Linear tasks" },
						],
					},
				},
			}),
		});
		vi.stubGlobal("fetch", fetchMock);

		await runWithTestServices(
			Effect.gen(function* () {
				const { store } = yield* LaborerStore;
				store.commit(
					events.projectCreated({
						id: "project-1",
						repoPath,
						name: "laborer",
						rlphConfig: null,
					})
				);
				store.commit(
					events.taskCreated({
						id: "existing-task",
						projectId: "project-1",
						source: "linear",
						externalId: "ENG-101",
						title: "Already imported",
						status: "pending",
					})
				);

				const importer = yield* LinearTaskImporter;
				const result = yield* importer.importProjectIssues("project-1");

				expect(result).toEqual({ importedCount: 1, totalCount: 2 });

				const importedTasks = store.query(
					tables.tasks.where("projectId", "project-1")
				);
				expect(importedTasks).toHaveLength(2);
				expect(importedTasks).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							source: "linear",
							externalId: "ENG-102",
							title: "Import Linear tasks",
							status: "pending",
						}),
					])
				);
			})
		);

		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.linear.app/graphql",
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: "linear-token",
					"Content-Type": "application/json",
				}),
				method: "POST",
			})
		);

		const request = fetchMock.mock.calls[0]?.[1];
		const body =
			typeof request?.body === "string"
				? (JSON.parse(request.body) as {
						variables: { filter: Record<string, unknown> };
					})
				: null;
		expect(body?.variables.filter).toEqual({
			labels: { name: { eq: "ops" } },
			project: { name: { eq: "Core" } },
			state: {
				name: { nin: ["In Progress", "In Review", "Done"] },
				type: { nin: ["completed", "canceled"] },
			},
			team: { key: { eq: "ENG" } },
		});
	});

	it("returns a typed error when the Linear API request fails", async () => {
		process.env.LINEAR_API_KEY = "linear-token";
		const repoPath = createProjectWithConfig(
			['label = "ops"', "", "[linear]", 'team = "ENG"'].join("\n")
		);

		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: false,
				status: 403,
				statusText: "Forbidden",
				json: async () => ({ errors: [{ message: "rate limited" }] }),
			})
		);

		await expect(
			runWithTestServices(
				Effect.gen(function* () {
					const { store } = yield* LaborerStore;
					store.commit(
						events.projectCreated({
							id: "project-1",
							repoPath,
							name: "laborer",
							rlphConfig: null,
						})
					);

					const importer = yield* LinearTaskImporter;
					return yield* importer.importProjectIssues("project-1");
				})
			)
		).rejects.toThrow(LINEAR_API_ERROR_REGEX);
	});
});
