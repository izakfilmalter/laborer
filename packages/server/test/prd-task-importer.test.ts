import { assert, describe, it } from "@effect/vitest";
import { events, tables } from "@laborer/shared/schema";
import { Effect, Layer } from "effect";
import { LaborerStore } from "../src/services/laborer-store.js";
import {
	PrdTaskImporter,
	parsePrdGeneratedTasks,
} from "../src/services/prd-task-importer.js";
import { TaskManager } from "../src/services/task-manager.js";
import { TestLaborerStore } from "./helpers/test-store.js";

const TestLayer = PrdTaskImporter.layer.pipe(
	Layer.provide(TaskManager.layer),
	Layer.provideMerge(TestLaborerStore)
);

describe("parsePrdGeneratedTasks", () => {
	it("extracts GitHub issue links and ignores duplicates", () => {
		const output = [
			"Created issues:",
			"- [Add task list filters](https://github.com/acme/laborer/issues/101)",
			"- Add task list filters https://github.com/acme/laborer/issues/101",
			"- Add PRD task importing https://github.com/acme/laborer/issues/102",
		].join("\n");

		assert.deepStrictEqual(parsePrdGeneratedTasks(output), [
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

		assert.deepStrictEqual(parsePrdGeneratedTasks(output), [
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

		assert.deepStrictEqual(parsePrdGeneratedTasks(output), [
			{
				externalId: "LAB-77",
				title: "Add imported PRD tasks",
			},
		]);
	});
});

describe("PrdTaskImporter.importParsedTasks", () => {
	it.scoped("creates prd tasks and skips existing externalIds", () =>
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
					prdId: null,
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

			assert.strictEqual(importedCount, 1);

			const tasks = store.query(tables.tasks.where("projectId", "project-1"));
			assert.strictEqual(tasks.length, 2);

			const newTask = tasks.find((t) => t.externalId === "LAB-11");
			assert.isDefined(newTask);
			if (newTask === undefined) {
				assert.fail("Expected newly imported task to exist");
			}
			assert.strictEqual(newTask.source, "prd");
			assert.strictEqual(newTask.title, "Import PRD tasks");
			assert.strictEqual(newTask.status, "pending");
		}).pipe(Effect.provide(TestLayer))
	);
});
