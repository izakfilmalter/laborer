import { events, schema, tables } from "@laborer/shared/schema";
import { makeAdapter } from "@livestore/adapter-node";
import { createStore, provideOtel } from "@livestore/livestore";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { LaborerStore } from "../src/services/laborer-store.js";
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

const TestLayer = TaskManager.layer.pipe(Layer.provideMerge(TestLaborerStore));

const runWithTestServices = <A, E>(
	effect: Effect.Effect<A, E, TaskManager | LaborerStore>
): Promise<A> =>
	Effect.runPromise(Effect.scoped(Effect.provide(effect, TestLayer)));

describe("TaskManager.createTask", () => {
	it("accepts an optional prdId and persists it on PRD tasks", async () => {
		await runWithTestServices(
			Effect.gen(function* () {
				const { store } = yield* LaborerStore;
				store.commit(
					events.projectCreated({
						id: "project-1",
						repoPath: "/tmp/project-1",
						name: "project-1",
						rlphConfig: null,
					})
				);

				const taskManager = yield* TaskManager;
				const task = yield* taskManager.createTask(
					"project-1",
					"Build PRD issue import",
					"prd",
					undefined,
					"prd-1"
				);

				expect(task).toEqual(
					expect.objectContaining({
						projectId: "project-1",
						source: "prd",
						prdId: "prd-1",
						title: "Build PRD issue import",
						status: "pending",
					})
				);

				expect(store.query(tables.tasks.where("id", task.id))).toEqual([
					expect.objectContaining({
						id: task.id,
						prdId: "prd-1",
						source: "prd",
					}),
				]);
			})
		);
	});
});
