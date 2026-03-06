import { existsSync, rmSync } from "node:fs";
import { basename } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { tables } from "@laborer/shared/schema";
import { Effect, type Scope } from "effect";
import { initRepo } from "../helpers/git-helpers.js";
import { makeScopedTestRpcContext } from "./test-layer.js";

type RpcTestContext = Effect.Effect.Success<typeof makeScopedTestRpcContext>;

const cleanupTempRoots = (tempRoots: readonly string[]) => {
	for (const root of tempRoots) {
		if (existsSync(root)) {
			rmSync(root, { recursive: true, force: true });
		}
	}
};

const runWithRpcTestContext = <A, E>(
	run: (context: RpcTestContext) => Effect.Effect<A, E, Scope.Scope>
): Effect.Effect<A, E, Scope.Scope> =>
	Effect.gen(function* () {
		const context = yield* makeScopedTestRpcContext;
		return yield* run(context);
	}) as Effect.Effect<A, E, Scope.Scope>;

const createProject = (
	client: RpcTestContext["client"],
	tempRoots: string[]
) => {
	const repoPath = initRepo("rpc-task-management", tempRoots);
	return client.project.add({ repoPath });
};

describe("LaborerRpcs task management", () => {
	it.scoped("task.create creates a manual task and materializes it", () =>
		runWithRpcTestContext(({ client, store }) =>
			Effect.gen(function* () {
				const tempRoots: string[] = [];
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => cleanupTempRoots(tempRoots))
				);

				const project = yield* createProject(client, tempRoots);
				const task = yield* client.task.create({
					projectId: project.id,
					title: "Write RPC task tests",
				});

				assert.strictEqual(task.projectId, project.id);
				assert.strictEqual(task.source, "manual");
				assert.strictEqual(task.prdId, undefined);
				assert.strictEqual(task.externalId, undefined);
				assert.strictEqual(task.title, "Write RPC task tests");
				assert.strictEqual(task.status, "pending");

				assert.deepStrictEqual(store.query(tables.tasks.where("id", task.id)), [
					{
						id: task.id,
						projectId: project.id,
						source: "manual",
						prdId: null,
						externalId: null,
						title: "Write RPC task tests",
						status: "pending",
					},
				]);
			})
		)
	);

	it.scoped("task.create preserves an optional prdId link", () =>
		runWithRpcTestContext(({ client, store }) =>
			Effect.gen(function* () {
				const tempRoots: string[] = [];
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => cleanupTempRoots(tempRoots))
				);

				const project = yield* createProject(client, tempRoots);
				const task = yield* client.task.create({
					projectId: project.id,
					prdId: "prd-123",
					title: "Implement linked task",
				});

				assert.strictEqual(task.source, "manual");
				assert.strictEqual(task.prdId, "prd-123");

				const storedTask = store.query(tables.tasks.where("id", task.id))[0];
				assert.isDefined(storedTask);
				if (storedTask === undefined) {
					assert.fail("Expected task.create to materialize a linked task row");
				}

				assert.strictEqual(storedTask.prdId, "prd-123");
				assert.strictEqual(storedTask.projectId, project.id);
			})
		)
	);

	it.scoped(
		"task.updateStatus transitions a task through the RPC contract",
		() =>
			runWithRpcTestContext(({ client, store }) =>
				Effect.gen(function* () {
					const tempRoots: string[] = [];
					yield* Effect.addFinalizer(() =>
						Effect.sync(() => cleanupTempRoots(tempRoots))
					);

					const project = yield* createProject(client, tempRoots);
					const task = yield* client.task.create({
						projectId: project.id,
						title: "Ship status update",
					});

					yield* client.task.updateStatus({
						taskId: task.id,
						status: "completed",
					});

					const storedTask = store.query(tables.tasks.where("id", task.id))[0];
					assert.isDefined(storedTask);
					if (storedTask === undefined) {
						assert.fail("Expected task.updateStatus to keep the task row");
					}

					assert.strictEqual(storedTask.status, "completed");
				})
			)
	);

	it.scoped("task.remove deletes a task created through the RPC contract", () =>
		runWithRpcTestContext(({ client, store }) =>
			Effect.gen(function* () {
				const tempRoots: string[] = [];
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => cleanupTempRoots(tempRoots))
				);

				const project = yield* createProject(client, tempRoots);
				const task = yield* client.task.create({
					projectId: project.id,
					title: `Remove task from ${basename(project.repoPath)}`,
				});

				yield* client.task.remove({ taskId: task.id });

				assert.deepStrictEqual(
					store.query(tables.tasks.where("id", task.id)),
					[]
				);
			})
		)
	);
});
