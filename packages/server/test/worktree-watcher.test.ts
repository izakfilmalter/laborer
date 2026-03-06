import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { events, tables } from "@laborer/shared/schema";
import { Effect, Exit, Layer, Scope } from "effect";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { LaborerStore } from "../src/services/laborer-store.js";
import { PortAllocator } from "../src/services/port-allocator.js";
import { WorktreeDetector } from "../src/services/worktree-detector.js";
import { WorktreeReconciler } from "../src/services/worktree-reconciler.js";
import { WorktreeWatcher } from "../src/services/worktree-watcher.js";
import { git, initRepo } from "./helpers/git-helpers.js";
import { TestLaborerStore } from "./helpers/test-store.js";
import { delay, waitFor } from "./helpers/timing-helpers.js";

const tempRoots: string[] = [];

const TestLayer = WorktreeWatcher.layer.pipe(
	Layer.provide(WorktreeReconciler.layer),
	Layer.provide(WorktreeDetector.layer),
	Layer.provide(PortAllocator.make(4300, 4310)),
	Layer.provideMerge(TestLaborerStore)
);

let scope: Scope.CloseableScope;
let runEffect: <A, E>(
	effect: Effect.Effect<A, E, WorktreeWatcher | LaborerStore>
) => Promise<A>;

beforeEach(async () => {
	scope = Effect.runSync(Scope.make());
	const context = await Effect.runPromise(
		Layer.buildWithScope(TestLayer, scope)
	);
	runEffect = <A, E>(
		effect: Effect.Effect<A, E, WorktreeWatcher | LaborerStore>
	) => Effect.runPromise(Effect.provide(effect, Layer.succeedContext(context)));
});

afterEach(async () => {
	if (scope) {
		await Effect.runPromise(Scope.close(scope, Exit.void));
	}
});

afterAll(() => {
	for (const root of tempRoots) {
		if (existsSync(root)) {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

describe("WorktreeWatcher", () => {
	it("reconciles on worktree add and remove", async () => {
		const repoPath = initRepo("watcher-add-remove", tempRoots);
		const linkedPath = join(repoPath, ".worktrees", "watcher-one");

		await runEffect(
			Effect.gen(function* () {
				const watcher = yield* WorktreeWatcher;
				yield* watcher.watchProject("project-watch-1", repoPath);
			})
		);

		git(`worktree add -b watcher/one ${linkedPath}`, repoPath);

		await waitFor(async () =>
			runEffect(
				Effect.gen(function* () {
					const { store } = yield* LaborerStore;
					const rows = store.query(
						tables.workspaces.where("projectId", "project-watch-1")
					);
					return rows.length === 2;
				})
			)
		);

		git(`worktree remove --force ${linkedPath}`, repoPath);

		await waitFor(async () =>
			runEffect(
				Effect.gen(function* () {
					const { store } = yield* LaborerStore;
					const rows = store.query(
						tables.workspaces.where("projectId", "project-watch-1")
					);
					return rows.length === 1;
				})
			)
		);
	});

	it("unwatchProject stops future reconciliation", async () => {
		const repoPath = initRepo("watcher-unwatch", tempRoots);
		const linkedA = join(repoPath, ".worktrees", "watcher-a");
		const linkedB = join(repoPath, ".worktrees", "watcher-b");

		await runEffect(
			Effect.gen(function* () {
				const watcher = yield* WorktreeWatcher;
				yield* watcher.watchProject("project-watch-2", repoPath);
			})
		);

		git(`worktree add -b watcher/a ${linkedA}`, repoPath);

		await waitFor(async () =>
			runEffect(
				Effect.gen(function* () {
					const { store } = yield* LaborerStore;
					const rows = store.query(
						tables.workspaces.where("projectId", "project-watch-2")
					);
					return rows.length === 2;
				})
			)
		);

		await runEffect(
			Effect.gen(function* () {
				const watcher = yield* WorktreeWatcher;
				yield* watcher.unwatchProject("project-watch-2");
			})
		);

		git(`worktree add -b watcher/b ${linkedB}`, repoPath);
		await delay(1500);

		const rowCount = await runEffect(
			Effect.gen(function* () {
				const { store } = yield* LaborerStore;
				const rows = store.query(
					tables.workspaces.where("projectId", "project-watch-2")
				);
				return rows.length;
			})
		);

		expect(rowCount).toBe(2);
	});

	it("watchAll reconciles existing projects and starts watchers", async () => {
		const repoA = initRepo("watcher-all-a", tempRoots);
		const repoB = initRepo("watcher-all-b", tempRoots);
		const linkedA = join(repoA, ".worktrees", "watcher-all-a-one");
		const linkedB = join(repoB, ".worktrees", "watcher-all-b-one");
		git(`worktree add -b watcher/all-a ${linkedA}`, repoA);

		await runEffect(
			Effect.gen(function* () {
				const { store } = yield* LaborerStore;
				store.commit(
					events.projectCreated({
						id: "project-watch-all-a",
						repoPath: repoA,
						name: "watch-all-a",
						rlphConfig: null,
					})
				);
				store.commit(
					events.projectCreated({
						id: "project-watch-all-b",
						repoPath: repoB,
						name: "watch-all-b",
						rlphConfig: null,
					})
				);
			})
		);

		await runEffect(
			Effect.gen(function* () {
				const watcher = yield* WorktreeWatcher;
				yield* watcher.watchAll();
			})
		);

		await waitFor(async () =>
			runEffect(
				Effect.gen(function* () {
					const { store } = yield* LaborerStore;
					const rowsA = store.query(
						tables.workspaces.where("projectId", "project-watch-all-a")
					);
					const rowsB = store.query(
						tables.workspaces.where("projectId", "project-watch-all-b")
					);
					return rowsA.length === 2 && rowsB.length === 1;
				})
			)
		);

		git(`worktree add -b watcher/all-b ${linkedB}`, repoB);

		await waitFor(async () =>
			runEffect(
				Effect.gen(function* () {
					const { store } = yield* LaborerStore;
					const rowsB = store.query(
						tables.workspaces.where("projectId", "project-watch-all-b")
					);
					return rowsB.length === 2;
				})
			)
		);
	});

	it("handles repos with no .git/worktrees until first linked worktree", async () => {
		const repoPath = initRepo("watcher-missing-worktrees", tempRoots);
		const linkedPath = join(repoPath, ".worktrees", "watcher-late-create");

		await runEffect(
			Effect.gen(function* () {
				const watcher = yield* WorktreeWatcher;
				yield* watcher.watchProject("project-watch-3", repoPath);
			})
		);

		git(`worktree add -b watcher/late ${linkedPath}`, repoPath);

		await waitFor(async () =>
			runEffect(
				Effect.gen(function* () {
					const { store } = yield* LaborerStore;
					const rows = store.query(
						tables.workspaces.where("projectId", "project-watch-3")
					);
					return rows.length === 2;
				})
			)
		);
	});
});
