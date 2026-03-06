import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { events, tables } from "@laborer/shared/schema";
import { Effect, Layer } from "effect";
import { afterAll } from "vitest";
import { BranchStateTracker } from "../src/services/branch-state-tracker.js";
import { FileWatcher } from "../src/services/file-watcher.js";
import { LaborerStore } from "../src/services/laborer-store.js";
import { PortAllocator } from "../src/services/port-allocator.js";
import { RepositoryEventBus } from "../src/services/repository-event-bus.js";
import { RepositoryIdentity } from "../src/services/repository-identity.js";
import { RepositoryWatchCoordinator } from "../src/services/repository-watch-coordinator.js";
import { WorktreeDetector } from "../src/services/worktree-detector.js";
import { WorktreeReconciler } from "../src/services/worktree-reconciler.js";
import { git, initRepo } from "./helpers/git-helpers.js";
import { TestLaborerStore } from "./helpers/test-store.js";
import { delay, waitFor } from "./helpers/timing-helpers.js";

const tempRoots: string[] = [];

const TestLayer = RepositoryWatchCoordinator.layer.pipe(
	Layer.provide(BranchStateTracker.layer),
	Layer.provide(RepositoryEventBus.layer),
	Layer.provide(FileWatcher.layer),
	Layer.provide(WorktreeReconciler.layer),
	Layer.provide(WorktreeDetector.layer),
	Layer.provide(RepositoryIdentity.layer),
	Layer.provide(PortAllocator.make(4300, 4310)),
	Layer.provideMerge(TestLaborerStore)
);

afterAll(() => {
	for (const root of tempRoots) {
		if (existsSync(root)) {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

describe("RepositoryWatchCoordinator", () => {
	it.scoped("reconciles on worktree add and remove", () =>
		Effect.gen(function* () {
			const repoPath = initRepo("watcher-add-remove", tempRoots);
			const linkedPath = join(repoPath, ".worktrees", "watcher-one");

			const coordinator = yield* RepositoryWatchCoordinator;
			yield* coordinator.watchProject("project-watch-1", repoPath);

			const { store } = yield* LaborerStore;

			git(`worktree add -b watcher/one ${linkedPath}`, repoPath);

			yield* Effect.promise(() =>
				waitFor(() =>
					Promise.resolve(
						store.query(tables.workspaces.where("projectId", "project-watch-1"))
							.length === 2
					)
				)
			);

			git(`worktree remove --force ${linkedPath}`, repoPath);

			yield* Effect.promise(() =>
				waitFor(() =>
					Promise.resolve(
						store.query(tables.workspaces.where("projectId", "project-watch-1"))
							.length === 1
					)
				)
			);
		}).pipe(Effect.provide(TestLayer))
	);

	it.scoped("unwatchProject stops future reconciliation", () =>
		Effect.gen(function* () {
			const repoPath = initRepo("watcher-unwatch", tempRoots);
			const linkedA = join(repoPath, ".worktrees", "watcher-a");
			const linkedB = join(repoPath, ".worktrees", "watcher-b");

			const coordinator = yield* RepositoryWatchCoordinator;
			yield* coordinator.watchProject("project-watch-2", repoPath);

			const { store } = yield* LaborerStore;

			git(`worktree add -b watcher/a ${linkedA}`, repoPath);

			yield* Effect.promise(() =>
				waitFor(() =>
					Promise.resolve(
						store.query(tables.workspaces.where("projectId", "project-watch-2"))
							.length === 2
					)
				)
			);

			yield* coordinator.unwatchProject("project-watch-2");

			git(`worktree add -b watcher/b ${linkedB}`, repoPath);
			yield* Effect.promise(() => delay(1500));

			const rows = store.query(
				tables.workspaces.where("projectId", "project-watch-2")
			);
			assert.strictEqual(rows.length, 2);
		}).pipe(Effect.provide(TestLayer))
	);

	it.scoped("watchAll reconciles existing projects and starts watchers", () =>
		Effect.gen(function* () {
			const repoA = initRepo("watcher-all-a", tempRoots);
			const repoB = initRepo("watcher-all-b", tempRoots);
			const linkedA = join(repoA, ".worktrees", "watcher-all-a-one");
			const linkedB = join(repoB, ".worktrees", "watcher-all-b-one");
			git(`worktree add -b watcher/all-a ${linkedA}`, repoA);

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

			const coordinator = yield* RepositoryWatchCoordinator;
			yield* coordinator.watchAll();

			yield* Effect.promise(() =>
				waitFor(() => {
					const rowsA = store.query(
						tables.workspaces.where("projectId", "project-watch-all-a")
					);
					const rowsB = store.query(
						tables.workspaces.where("projectId", "project-watch-all-b")
					);
					return Promise.resolve(rowsA.length === 2 && rowsB.length === 1);
				})
			);

			git(`worktree add -b watcher/all-b ${linkedB}`, repoB);

			yield* Effect.promise(() =>
				waitFor(() =>
					Promise.resolve(
						store.query(
							tables.workspaces.where("projectId", "project-watch-all-b")
						).length === 2
					)
				)
			);
		}).pipe(Effect.provide(TestLayer))
	);

	it.scoped(
		"handles repos with no .git/worktrees until first linked worktree",
		() =>
			Effect.gen(function* () {
				const repoPath = initRepo("watcher-missing-worktrees", tempRoots);
				const linkedPath = join(repoPath, ".worktrees", "watcher-late-create");

				const coordinator = yield* RepositoryWatchCoordinator;
				yield* coordinator.watchProject("project-watch-3", repoPath);

				const { store } = yield* LaborerStore;

				git(`worktree add -b watcher/late ${linkedPath}`, repoPath);

				yield* Effect.promise(() =>
					waitFor(() =>
						Promise.resolve(
							store.query(
								tables.workspaces.where("projectId", "project-watch-3")
							).length === 2
						)
					)
				);
			}).pipe(Effect.provide(TestLayer))
	);
});
