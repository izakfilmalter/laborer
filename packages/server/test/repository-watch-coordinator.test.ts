import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { tables } from "@laborer/shared/schema";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { afterAll } from "vitest";
import { BranchStateTracker } from "../src/services/branch-state-tracker.js";
import {
	FileWatcher,
	type WatchSubscription,
} from "../src/services/file-watcher.js";
import { LaborerStore } from "../src/services/laborer-store.js";
import { PortAllocator } from "../src/services/port-allocator.js";
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
	Layer.provide(FileWatcher.layer),
	Layer.provide(WorktreeReconciler.layer),
	Layer.provide(WorktreeDetector.layer),
	Layer.provide(RepositoryIdentity.layer),
	Layer.provide(PortAllocator.make(4500, 4510)),
	Layer.provideMerge(TestLaborerStore)
);

afterAll(() => {
	for (const root of tempRoots) {
		if (existsSync(root)) {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

describe("RepositoryWatchCoordinator scoped lifecycle", () => {
	it.scoped(
		"each registered project gets a scoped watcher coordinator tied to its lifecycle",
		() =>
			Effect.gen(function* () {
				const repoPath = initRepo("coord-scoped-1", tempRoots);
				const linkedPath = join(repoPath, ".worktrees", "coord-one");

				const coordinator = yield* RepositoryWatchCoordinator;
				yield* coordinator.watchProject("project-coord-1", repoPath);

				const { store } = yield* LaborerStore;

				// Creating a worktree should trigger reconciliation via watcher
				git(`worktree add -b coord/one ${linkedPath}`, repoPath);

				yield* Effect.promise(() =>
					waitFor(() =>
						Promise.resolve(
							store.query(
								tables.workspaces.where("projectId", "project-coord-1")
							).length === 2
						)
					)
				);

				const workspaces = store.query(
					tables.workspaces.where("projectId", "project-coord-1")
				);
				assert.strictEqual(workspaces.length, 2);
			}).pipe(Effect.provide(TestLayer))
	);

	it.scoped(
		"coordinator watches the canonical common git dir for metadata changes",
		() =>
			Effect.gen(function* () {
				const repoPath = initRepo("coord-gitdir-1", tempRoots);
				const linkedPath = join(repoPath, ".worktrees", "coord-gitdir");

				const coordinator = yield* RepositoryWatchCoordinator;
				yield* coordinator.watchProject("project-coord-gitdir", repoPath);

				const { store } = yield* LaborerStore;

				// Adding a worktree modifies the git common dir (creates
				// .git/worktrees/<name>), which should trigger reconciliation
				git(`worktree add -b coord/gitdir ${linkedPath}`, repoPath);

				yield* Effect.promise(() =>
					waitFor(() =>
						Promise.resolve(
							store.query(
								tables.workspaces.where("projectId", "project-coord-gitdir")
							).length === 2
						)
					)
				);
			}).pipe(Effect.provide(TestLayer))
	);

	it.scoped("removing a project tears down its watchers cleanly", () =>
		Effect.gen(function* () {
			const repoPath = initRepo("coord-teardown-1", tempRoots);
			const linkedA = join(repoPath, ".worktrees", "coord-teardown-a");
			const linkedB = join(repoPath, ".worktrees", "coord-teardown-b");

			const coordinator = yield* RepositoryWatchCoordinator;
			yield* coordinator.watchProject("project-coord-teardown", repoPath);

			const { store } = yield* LaborerStore;

			// First worktree should be detected
			git(`worktree add -b coord/teardown-a ${linkedA}`, repoPath);

			yield* Effect.promise(() =>
				waitFor(() =>
					Promise.resolve(
						store.query(
							tables.workspaces.where("projectId", "project-coord-teardown")
						).length === 2
					)
				)
			);

			// Tear down watchers for this project
			yield* coordinator.unwatchProject("project-coord-teardown");

			// Creating another worktree after teardown should NOT be detected
			git(`worktree add -b coord/teardown-b ${linkedB}`, repoPath);
			yield* Effect.promise(() => delay(1500));

			const workspaces = store.query(
				tables.workspaces.where("projectId", "project-coord-teardown")
			);
			assert.strictEqual(
				workspaces.length,
				2,
				"No new workspace should be created after unwatching"
			);
		}).pipe(Effect.provide(TestLayer))
	);

	it.scoped(
		"server shutdown tears down watcher resources through scoped service disposal",
		() =>
			Effect.gen(function* () {
				// Track subscribe/close calls through a recording FileWatcher
				// Using mutable counters because close() is a synchronous callback
				let subscribeCalls = 0;
				let closeCalls = 0;

				const RecordingFileWatcher = Layer.succeed(
					FileWatcher,
					FileWatcher.of({
						subscribe: (_path, _onChange, _onError, _options) =>
							Effect.sync(() => {
								subscribeCalls += 1;
								return {
									close: () => {
										closeCalls += 1;
									},
								} satisfies WatchSubscription;
							}),
					})
				);

				const repoPath = initRepo("coord-shutdown-1", tempRoots);

				// Build a scoped layer with the recording watcher
				const ScopedTestLayer = RepositoryWatchCoordinator.layer.pipe(
					Layer.provide(BranchStateTracker.layer),
					Layer.provide(RecordingFileWatcher),
					Layer.provide(WorktreeReconciler.layer),
					Layer.provide(WorktreeDetector.layer),
					Layer.provide(RepositoryIdentity.layer),
					Layer.provide(PortAllocator.make(4511, 4520)),
					Layer.provideMerge(TestLaborerStore)
				);

				// Create a manual scope to simulate server lifecycle
				const scope = yield* Scope.make();

				const ctx = yield* Layer.buildWithScope(ScopedTestLayer, scope);
				const coordinator = Context.get(ctx, RepositoryWatchCoordinator);

				yield* coordinator.watchProject("project-coord-shutdown", repoPath);

				// Verify watchers were subscribed
				assert.isAbove(subscribeCalls, 0, "Should have subscribed watchers");

				// Close the scope (simulates server shutdown)
				yield* Scope.close(scope, Exit.succeed(undefined));

				// Verify all watchers were closed
				assert.strictEqual(
					closeCalls,
					subscribeCalls,
					"All subscribed watchers should be closed on scope cleanup"
				);
			}).pipe(Effect.provide(TestLayer))
	);

	it.scoped(
		"uses FileWatcher abstraction for subscriptions instead of raw fs.watch",
		() =>
			Effect.gen(function* () {
				// Use a recording FileWatcher to verify the abstraction is used
				const subscribedPaths: string[] = [];

				const RecordingFileWatcher = Layer.succeed(
					FileWatcher,
					FileWatcher.of({
						subscribe: (path, _onChange, _onError, _options) =>
							Effect.sync(() => {
								subscribedPaths.push(path);
								return {
									close: () => undefined,
								} satisfies WatchSubscription;
							}),
					})
				);

				const repoPath = initRepo("coord-abstraction-1", tempRoots);

				const ScopedTestLayer = RepositoryWatchCoordinator.layer.pipe(
					Layer.provide(BranchStateTracker.layer),
					Layer.provide(RecordingFileWatcher),
					Layer.provide(WorktreeReconciler.layer),
					Layer.provide(WorktreeDetector.layer),
					Layer.provide(RepositoryIdentity.layer),
					Layer.provide(PortAllocator.make(4521, 4530)),
					Layer.provideMerge(TestLaborerStore)
				);

				const scope = yield* Scope.make();
				const ctx = yield* Layer.buildWithScope(ScopedTestLayer, scope);
				const coordinator = Context.get(ctx, RepositoryWatchCoordinator);

				yield* coordinator.watchProject("project-coord-abs", repoPath);

				assert.isAbove(
					subscribedPaths.length,
					0,
					"Should subscribe through FileWatcher abstraction"
				);

				// The subscribed path should be a git metadata directory
				const hasGitPath = subscribedPaths.some(
					(p) => p.includes(".git") || p.endsWith(".git")
				);
				assert.isTrue(
					hasGitPath,
					"Should subscribe to the git metadata directory"
				);

				yield* Scope.close(scope, Exit.succeed(undefined));
			}).pipe(Effect.provide(TestLayer))
	);
});
