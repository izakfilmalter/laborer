import { events, schema, tables } from "@laborer/shared/schema";
import { makeAdapter } from "@livestore/adapter-node";
import { createStore, provideOtel } from "@livestore/livestore";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { LaborerStore } from "../src/services/laborer-store.js";
import {
	PrdTaskImporter,
	parsePrdGeneratedTasks,
} from "../src/services/prd-task-importer.js";
import { TaskManager } from "../src/services/task-manager.js";

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

const TestLayer = PrdTaskImporter.layer.pipe(
	Layer.provide(TaskManager.layer),
	Layer.provideMerge(TestLaborerStore)
);

const runWithTestServices = <A, E>(
	effect: Effect.Effect<A, E, PrdTaskImporter | LaborerStore>
): Promise<A> =>
	Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const context = yield* Layer.build(TestLayer);
				return yield* Effect.provide(effect, Layer.succeedContext(context));
			})
		)
	);

describe("parsePrdGeneratedTasks", () => {
	it("extracts GitHub issue links and ignores duplicates", () => {
		const output = [
			"Created issues:",
			"- [Add task list filters](https://github.com/acme/laborer/issues/101)",
			"- Add task list filters https://github.com/acme/laborer/issues/101",
			"- Add PRD task importing https://github.com/acme/laborer/issues/102",
		].join("\n");

		expect(parsePrdGeneratedTasks(output)).toEqual([
			{
				externalId: "https://github.com/acme/laborer/issues/101",
				title: "Add task list filters",
			},
			{
				externalId: "https://github.com/acme/laborer/issues/102",
				title: "Add PRD task importing",
			},
		]);
	});

	it("extracts Linear issue keys from common rlph-style lines", () => {
		const output = [
			"Created issue LAB-12: Add task source picker UI",
			"Improve project settings modal (LAB-13)",
		].join("\n");

		expect(parsePrdGeneratedTasks(output)).toEqual([
			{
				externalId: "LAB-12",
				title: "Add task source picker UI",
			},
			{
				externalId: "LAB-13",
				title: "Improve project settings modal",
			},
		]);
	});

	it("strips ANSI escapes before parsing", () => {
		const output =
			"\u001b[32mCreated issue\u001b[0m LAB-77: Add imported PRD tasks";

		expect(parsePrdGeneratedTasks(output)).toEqual([
			{
				externalId: "LAB-77",
				title: "Add imported PRD tasks",
			},
		]);
	});
});

describe("PrdTaskImporter.importParsedTasks", () => {
	it("creates prd tasks and skips existing externalIds", async () => {
		await runWithTestServices(
			Effect.gen(function* () {
				const { store } = yield* LaborerStore;
				store.commit(
					events.projectCreated({
						id: "project-1",
						repoPath: "/repo",
						name: "laborer",
						rlphConfig: null,
					})
				);
				store.commit(
					events.workspaceCreated({
						id: "workspace-1",
						projectId: "project-1",
						branchName: "task/prd-import",
						worktreePath: "/repo/.worktrees/task-prd-import",
						port: 3101,
						status: "running",
						createdAt: new Date().toISOString(),
						taskSource: null,
						origin: "laborer",
						baseSha: null,
					})
				);
				store.commit(
					events.taskCreated({
						id: "existing-task",
						projectId: "project-1",
						source: "prd",
						externalId: "LAB-10",
						title: "Already imported",
						status: "pending",
					})
				);

				const importer = yield* PrdTaskImporter;
				const importedCount = yield* importer.importParsedTasks("workspace-1", [
					{ externalId: "LAB-10", title: "Already imported" },
					{ externalId: "LAB-11", title: "Import PRD tasks" },
				]);

				expect(importedCount).toBe(1);

				const tasks = store.query(tables.tasks.where("projectId", "project-1"));
				expect(tasks).toHaveLength(2);
				expect(tasks).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							source: "prd",
							externalId: "LAB-11",
							title: "Import PRD tasks",
							status: "pending",
						}),
					])
				);
			})
		);
	});
});
