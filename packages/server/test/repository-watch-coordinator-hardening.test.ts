import { assert, describe, it } from "@effect/vitest";
import { events, tables } from "@laborer/shared/schema";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { BranchStateTracker } from "../src/services/branch-state-tracker.js";
import { ConfigService } from "../src/services/config-service.js";
import {
	FileWatcher,
	type WatchEvent,
	type WatchSubscription,
} from "../src/services/file-watcher.js";
import { LaborerStore } from "../src/services/laborer-store.js";
import { withFsmonitorDisabled } from "../src/services/repo-watching-git.js";
import { RepositoryEventBus } from "../src/services/repository-event-bus.js";
import { RepositoryIdentity } from "../src/services/repository-identity.js";
import {
	formatWatcherWarning,
	RepositoryWatchCoordinator,
} from "../src/services/repository-watch-coordinator.js";
import { WorktreeReconciler } from "../src/services/worktree-reconciler.js";
import { TestLaborerStore } from "./helpers/test-store.js";
import { delay, waitFor } from "./helpers/timing-helpers.js";

interface RecordedWatcher {
	closed: boolean;
	readonly onChange: (event: WatchEvent) => void;
	readonly onError: (error: Error) => void;
	readonly path: string;
	readonly recursive: boolean;
}

const createTestLayer = (params: {
	readonly branchRefreshCalls: { current: number };
	readonly reconcileCalls: { current: number };
	readonly watchersByPath: Map<string, RecordedWatcher[]>;
	readonly subscribePaths: string[];
	readonly closedPaths: string[];
}) => {
	const fileWatcherLayer = Layer.succeed(
		FileWatcher,
		FileWatcher.of({
			subscribe: (path, onChange, onError, options) =>
				Effect.sync(() => {
					const recorded: RecordedWatcher = {
						path,
						onChange,
						onError,
						recursive: options?.recursive ?? false,
						closed: false,
					};
					params.subscribePaths.push(path);
					const existing = params.watchersByPath.get(path) ?? [];
					existing.push(recorded);
					params.watchersByPath.set(path, existing);
					return {
						close: () => {
							recorded.closed = true;
							params.closedPaths.push(path);
						},
					} satisfies WatchSubscription;
				}),
		})
	);

	const repoIdentityLayer = Layer.succeed(
		RepositoryIdentity,
		RepositoryIdentity.of({
			resolve: (_inputPath) =>
				Effect.succeed({
					canonicalRoot: "/virtual/repo",
					canonicalGitCommonDir: "/virtual/repo/.git",
					repoId: "repo-1",
					isMainWorktree: true,
				}),
		})
	);

	const reconcilerLayer = Layer.succeed(
		WorktreeReconciler,
		WorktreeReconciler.of({
			reconcile: (_projectId, _repoPath) =>
				Effect.sync(() => {
					params.reconcileCalls.current += 1;
					return { added: 0, removed: 0, unchanged: 0 };
				}),
		})
	);

	const branchTrackerLayer = Layer.succeed(
		BranchStateTracker,
		BranchStateTracker.of({
			refreshBranches: (_projectId) =>
				Effect.sync(() => {
					params.branchRefreshCalls.current += 1;
					return { checked: 0, updated: 0 };
				}),
		})
	);

	return RepositoryWatchCoordinator.layer.pipe(
		Layer.provide(branchTrackerLayer),
		Layer.provide(ConfigService.layer),
		Layer.provideMerge(RepositoryEventBus.layer),
		Layer.provide(fileWatcherLayer),
		Layer.provide(reconcilerLayer),
		Layer.provide(repoIdentityLayer),
		Layer.provideMerge(TestLaborerStore)
	);
};

describe("RepositoryWatchCoordinator hardening", () => {
	it.scoped("coalesces heavy churn into stable refresh behavior", () => {
		const reconcileCalls = { current: 0 };
		const branchRefreshCalls = { current: 0 };
		const watchersByPath = new Map<string, RecordedWatcher[]>();
		const subscribePaths: string[] = [];
		const closedPaths: string[] = [];

		const TestLayer = createTestLayer({
			reconcileCalls,
			branchRefreshCalls,
			watchersByPath,
			subscribePaths,
			closedPaths,
		});

		return Effect.gen(function* () {
			const coordinator = yield* RepositoryWatchCoordinator;
			yield* coordinator.watchProject("project-hardening", "/input/repo");

			const gitWatcher = watchersByPath.get("/virtual/repo/.git")?.at(-1);
			if (gitWatcher === undefined) {
				throw new Error("Expected git watcher subscription");
			}

			for (let index = 0; index < 10; index += 1) {
				gitWatcher.onChange({ type: "rename", fileName: "worktrees/feature" });
				gitWatcher.onChange({ type: "change", fileName: "HEAD" });
			}

			yield* Effect.promise(() =>
				waitFor(() =>
					Promise.resolve(
						reconcileCalls.current === 1 && branchRefreshCalls.current === 1
					)
				)
			);

			assert.deepStrictEqual(subscribePaths, [
				"/virtual/repo/.git",
				"/virtual/repo",
			]);
			assert.deepStrictEqual(closedPaths, []);
		}).pipe(Effect.provide(TestLayer));
	});

	it.scoped("recovers after watcher degradation and resubscribes", () => {
		const reconcileCalls = { current: 0 };
		const branchRefreshCalls = { current: 0 };
		const watchersByPath = new Map<string, RecordedWatcher[]>();
		const subscribePaths: string[] = [];
		const closedPaths: string[] = [];

		const TestLayer = createTestLayer({
			reconcileCalls,
			branchRefreshCalls,
			watchersByPath,
			subscribePaths,
			closedPaths,
		});

		return Effect.gen(function* () {
			const coordinator = yield* RepositoryWatchCoordinator;
			yield* coordinator.watchProject("project-recovery", "/input/repo");

			const firstGitWatcher = watchersByPath.get("/virtual/repo/.git")?.at(-1);
			if (firstGitWatcher === undefined) {
				throw new Error("Expected initial git watcher subscription");
			}

			firstGitWatcher.onError(new Error("ENOENT: watcher target disappeared"));

			yield* Effect.promise(() =>
				waitFor(() => Promise.resolve(subscribePaths.length === 4))
			);

			assert.deepStrictEqual(closedPaths, [
				"/virtual/repo/.git",
				"/virtual/repo",
			]);

			const recoveredGitWatcher = watchersByPath
				.get("/virtual/repo/.git")
				?.at(-1);
			if (recoveredGitWatcher === undefined) {
				throw new Error("Expected recovered git watcher subscription");
			}
			assert.notStrictEqual(recoveredGitWatcher, firstGitWatcher);

			recoveredGitWatcher.onChange({
				type: "rename",
				fileName: "worktrees/recreated",
			});

			yield* Effect.promise(() =>
				waitFor(() => Promise.resolve(reconcileCalls.current === 1))
			);

			assert.strictEqual(branchRefreshCalls.current, 1);
		}).pipe(Effect.provide(TestLayer));
	});

	it.scoped(
		"startup restore reuses persisted repository identity without re-resolving",
		() => {
			const reconcileCalls = { current: 0 };
			const branchRefreshCalls = { current: 0 };
			const watchersByPath = new Map<string, RecordedWatcher[]>();
			const subscribePaths: string[] = [];
			const closedPaths: string[] = [];
			const resolveCalls = { current: 0 };

			const fileWatcherLayer = Layer.succeed(
				FileWatcher,
				FileWatcher.of({
					subscribe: (path, onChange, onError, options) =>
						Effect.sync(() => {
							const recorded: RecordedWatcher = {
								path,
								onChange,
								onError,
								recursive: options?.recursive ?? false,
								closed: false,
							};
							subscribePaths.push(path);
							const existing = watchersByPath.get(path) ?? [];
							existing.push(recorded);
							watchersByPath.set(path, existing);
							return {
								close: () => {
									recorded.closed = true;
									closedPaths.push(path);
								},
							} satisfies WatchSubscription;
						}),
				})
			);

			const repoIdentityLayer = Layer.succeed(
				RepositoryIdentity,
				RepositoryIdentity.of({
					resolve: () =>
						Effect.sync(() => {
							resolveCalls.current += 1;
							throw new Error("watchAll should use persisted identity");
						}),
				})
			);

			const reconcilerLayer = Layer.succeed(
				WorktreeReconciler,
				WorktreeReconciler.of({
					reconcile: (_projectId, _repoPath) =>
						Effect.sync(() => {
							reconcileCalls.current += 1;
							return { added: 0, removed: 0, unchanged: 0 };
						}),
				})
			);

			const branchTrackerLayer = Layer.succeed(
				BranchStateTracker,
				BranchStateTracker.of({
					refreshBranches: (_projectId) =>
						Effect.sync(() => {
							branchRefreshCalls.current += 1;
							return { checked: 0, updated: 0 };
						}),
				})
			);

			const TestLayer = RepositoryWatchCoordinator.layer.pipe(
				Layer.provide(branchTrackerLayer),
				Layer.provide(ConfigService.layer),
				Layer.provideMerge(RepositoryEventBus.layer),
				Layer.provide(fileWatcherLayer),
				Layer.provide(reconcilerLayer),
				Layer.provide(repoIdentityLayer),
				Layer.provideMerge(TestLaborerStore)
			);

			return Effect.gen(function* () {
				const { store } = yield* LaborerStore;
				store.commit(
					events.projectCreated({
						id: "project-persisted-startup",
						repoPath: "/persisted/repo",
						repoId: "repo-1",
						canonicalGitCommonDir: "/persisted/repo/.git",
						name: "persisted-repo",
						rlphConfig: null,
					})
				);

				const coordinator = yield* RepositoryWatchCoordinator;
				yield* coordinator.watchAll();

				assert.strictEqual(resolveCalls.current, 0);
				assert.strictEqual(reconcileCalls.current, 1);
				assert.strictEqual(branchRefreshCalls.current, 1);
				assert.deepStrictEqual(
					store.query(tables.projects.where("id", "project-persisted-startup")),
					[
						{
							id: "project-persisted-startup",
							repoPath: "/persisted/repo",
							repoId: "repo-1",
							canonicalGitCommonDir: "/persisted/repo/.git",
							name: "persisted-repo",
							rlphConfig: null,
						},
					]
				);
				assert.deepStrictEqual(subscribePaths, [
					"/persisted/repo/.git",
					"/persisted/repo",
				]);
				assert.deepStrictEqual(closedPaths, []);
			}).pipe(Effect.provide(TestLayer));
		}
	);

	it("formats actionable non-blocking watcher warnings", () => {
		assert.strictEqual(
			formatWatcherWarning("Git watcher error", {
				projectId: "project-warning",
				path: "/virtual/repo/.git",
				detail: "ENOENT: watcher target disappeared",
				retrying: true,
			}),
			"Git watcher error for project project-warning at /virtual/repo/.git: ENOENT: watcher target disappeared. Git-backed refresh remains active; retrying watcher setup in 1000ms."
		);

		assert.strictEqual(
			formatWatcherWarning("Watcher degraded", {
				projectId: "project-warning",
				detail: "git-watcher-error; attempting recovery now",
			}),
			"Watcher degraded for project project-warning: git-watcher-error; attempting recovery now."
		);
	});

	it.scoped("ignores late watcher callbacks after project teardown", () => {
		const reconcileCalls = { current: 0 };
		const branchRefreshCalls = { current: 0 };
		const watchersByPath = new Map<string, RecordedWatcher[]>();
		const subscribePaths: string[] = [];
		const closedPaths: string[] = [];

		const TestLayer = createTestLayer({
			reconcileCalls,
			branchRefreshCalls,
			watchersByPath,
			subscribePaths,
			closedPaths,
		});

		return Effect.gen(function* () {
			const coordinator = yield* RepositoryWatchCoordinator;
			yield* coordinator.watchProject("project-teardown", "/input/repo");

			const gitWatcher = watchersByPath.get("/virtual/repo/.git")?.at(-1);
			const repoWatcher = watchersByPath.get("/virtual/repo")?.at(-1);
			if (gitWatcher === undefined || repoWatcher === undefined) {
				throw new Error("Expected initial watcher subscriptions");
			}

			yield* coordinator.unwatchProject("project-teardown");

			gitWatcher.onChange({ type: "change", fileName: "HEAD" });
			gitWatcher.onError(new Error("late git callback"));
			repoWatcher.onChange({ type: "change", fileName: "src/index.ts" });
			repoWatcher.onError(new Error("late repo callback"));

			yield* Effect.promise(() => delay(1600));

			assert.strictEqual(reconcileCalls.current, 0);
			assert.strictEqual(branchRefreshCalls.current, 0);
			assert.deepStrictEqual(subscribePaths, [
				"/virtual/repo/.git",
				"/virtual/repo",
			]);
			assert.deepStrictEqual(closedPaths, [
				"/virtual/repo/.git",
				"/virtual/repo",
			]);
		}).pipe(Effect.provide(TestLayer));
	});

	it.scoped("ignores late watcher callbacks after scope shutdown", () => {
		const reconcileCalls = { current: 0 };
		const branchRefreshCalls = { current: 0 };
		const watchersByPath = new Map<string, RecordedWatcher[]>();
		const subscribePaths: string[] = [];
		const closedPaths: string[] = [];

		const TestLayer = createTestLayer({
			reconcileCalls,
			branchRefreshCalls,
			watchersByPath,
			subscribePaths,
			closedPaths,
		});

		return Effect.gen(function* () {
			const scope = yield* Scope.make();
			const ctx = yield* Layer.buildWithScope(TestLayer, scope);
			const coordinator = Context.get(ctx, RepositoryWatchCoordinator);

			yield* coordinator.watchProject("project-shutdown", "/input/repo");

			const gitWatcher = watchersByPath.get("/virtual/repo/.git")?.at(-1);
			if (gitWatcher === undefined) {
				throw new Error("Expected git watcher subscription");
			}

			yield* Scope.close(scope, Exit.succeed(undefined));

			gitWatcher.onChange({ type: "rename", fileName: "worktrees/late" });
			gitWatcher.onError(new Error("late shutdown callback"));

			yield* Effect.promise(() => delay(1600));

			assert.strictEqual(reconcileCalls.current, 0);
			assert.strictEqual(branchRefreshCalls.current, 0);
			assert.deepStrictEqual(subscribePaths, [
				"/virtual/repo/.git",
				"/virtual/repo",
			]);
			assert.deepStrictEqual(closedPaths, [
				"/virtual/repo/.git",
				"/virtual/repo",
			]);
		});
	});

	it.scoped(
		"ignored repo-root paths stay quiet without triggering refresh work",
		() => {
			const reconcileCalls = { current: 0 };
			const branchRefreshCalls = { current: 0 };
			const watchersByPath = new Map<string, RecordedWatcher[]>();
			const subscribePaths: string[] = [];
			const closedPaths: string[] = [];

			const TestLayer = createTestLayer({
				reconcileCalls,
				branchRefreshCalls,
				watchersByPath,
				subscribePaths,
				closedPaths,
			});

			return Effect.gen(function* () {
				const coordinator = yield* RepositoryWatchCoordinator;
				const eventBus = yield* RepositoryEventBus;
				const receivedRelativePaths: string[] = [];

				yield* eventBus.subscribe((event) => {
					receivedRelativePaths.push(event.relativePath);
				});

				yield* coordinator.watchProject("project-ignored-noise", "/input/repo");

				const repoWatcher = watchersByPath.get("/virtual/repo")?.at(-1);
				if (repoWatcher === undefined) {
					throw new Error("Expected repo watcher subscription");
				}

				repoWatcher.onChange({
					type: "change",
					fileName: "node_modules/lodash/index.js",
				});
				repoWatcher.onChange({
					type: "rename",
					fileName: "dist/bundle.js",
				});
				repoWatcher.onChange({
					type: "change",
					fileName: "src/canary.ts",
				});

				yield* Effect.promise(() =>
					waitFor(() => Promise.resolve(receivedRelativePaths.length === 1))
				);
				yield* Effect.promise(() => delay(700));

				assert.deepStrictEqual(receivedRelativePaths, ["src/canary.ts"]);
				assert.strictEqual(reconcileCalls.current, 0);
				assert.strictEqual(branchRefreshCalls.current, 0);
				assert.deepStrictEqual(subscribePaths, [
					"/virtual/repo/.git",
					"/virtual/repo",
				]);
				assert.deepStrictEqual(closedPaths, []);
			}).pipe(Effect.provide(TestLayer));
		}
	);

	it.scoped(
		"watchProject is idempotent — re-calling for the same project replaces previous watchers",
		() => {
			const reconcileCalls = { current: 0 };
			const branchRefreshCalls = { current: 0 };
			const watchersByPath = new Map<string, RecordedWatcher[]>();
			const subscribePaths: string[] = [];
			const closedPaths: string[] = [];

			const TestLayer = createTestLayer({
				reconcileCalls,
				branchRefreshCalls,
				watchersByPath,
				subscribePaths,
				closedPaths,
			});

			return Effect.gen(function* () {
				const coordinator = yield* RepositoryWatchCoordinator;

				// First watch
				yield* coordinator.watchProject("project-idempotent", "/input/repo");

				const firstGitWatcher = watchersByPath
					.get("/virtual/repo/.git")
					?.at(-1);
				const firstRepoWatcher = watchersByPath.get("/virtual/repo")?.at(-1);
				assert.isDefined(firstGitWatcher);
				assert.isDefined(firstRepoWatcher);

				// Re-watch the same project — should close old watchers and create new ones
				yield* coordinator.watchProject("project-idempotent", "/input/repo");

				// The first watchers should have been closed
				assert.isTrue(
					firstGitWatcher?.closed ?? false,
					"First git watcher should be closed after re-watch"
				);
				assert.isTrue(
					firstRepoWatcher?.closed ?? false,
					"First repo watcher should be closed after re-watch"
				);

				// New watchers should have been created
				const secondGitWatcher = watchersByPath
					.get("/virtual/repo/.git")
					?.at(-1);
				assert.isDefined(secondGitWatcher);
				assert.notStrictEqual(
					secondGitWatcher,
					firstGitWatcher,
					"Should have a new git watcher after re-watch"
				);

				// The new watchers should still work — deliver a branch event
				secondGitWatcher?.onChange({ type: "change", fileName: "HEAD" });

				yield* Effect.promise(() =>
					waitFor(() => Promise.resolve(branchRefreshCalls.current === 1))
				);
			}).pipe(Effect.provide(TestLayer));
		}
	);

	it.scoped(
		"git event classification routes HEAD and refs to branch refresh, worktrees to reconciliation",
		() => {
			const reconcileCalls = { current: 0 };
			const branchRefreshCalls = { current: 0 };
			const watchersByPath = new Map<string, RecordedWatcher[]>();
			const subscribePaths: string[] = [];
			const closedPaths: string[] = [];

			const TestLayer = createTestLayer({
				reconcileCalls,
				branchRefreshCalls,
				watchersByPath,
				subscribePaths,
				closedPaths,
			});

			return Effect.gen(function* () {
				const coordinator = yield* RepositoryWatchCoordinator;
				yield* coordinator.watchProject("project-classify", "/input/repo");

				const gitWatcher = watchersByPath.get("/virtual/repo/.git")?.at(-1);
				if (gitWatcher === undefined) {
					throw new Error("Expected git watcher subscription");
				}

				// Test branch-related events: HEAD, refs/heads/main, MERGE_HEAD,
				// REBASE_HEAD, ORIG_HEAD, FETCH_HEAD
				const branchFiles = [
					"HEAD",
					"refs/heads/main",
					"MERGE_HEAD",
					"REBASE_HEAD",
					"ORIG_HEAD",
					"FETCH_HEAD",
				];

				for (const fileName of branchFiles) {
					gitWatcher.onChange({ type: "change", fileName });
				}

				yield* Effect.promise(() =>
					waitFor(() => Promise.resolve(branchRefreshCalls.current === 1))
				);

				// All branch events debounce to a single branch refresh
				assert.strictEqual(
					branchRefreshCalls.current,
					1,
					"Branch-related events should trigger branch refresh"
				);

				// refs/heads/main also matches isWorktreeRelatedEvent? No —
				// it starts with "refs" not "worktrees". So reconcile should
				// not fire for pure branch events (except the ones that are
				// also worktree-related or have null fileName).
				// Reset and test worktree-specific events
				reconcileCalls.current = 0;
				branchRefreshCalls.current = 0;

				gitWatcher.onChange({
					type: "rename",
					fileName: "worktrees/my-feature",
				});

				yield* Effect.promise(() =>
					waitFor(() => Promise.resolve(reconcileCalls.current === 1))
				);

				assert.strictEqual(
					reconcileCalls.current,
					1,
					"Worktree-related events should trigger reconciliation"
				);

				// Test null fileName — should trigger both branch AND worktree
				reconcileCalls.current = 0;
				branchRefreshCalls.current = 0;

				gitWatcher.onChange({ type: "change", fileName: null });

				yield* Effect.promise(() =>
					waitFor(() =>
						Promise.resolve(
							reconcileCalls.current === 1 && branchRefreshCalls.current === 1
						)
					)
				);

				assert.strictEqual(
					reconcileCalls.current,
					1,
					"null fileName should trigger reconciliation"
				);
				assert.strictEqual(
					branchRefreshCalls.current,
					1,
					"null fileName should trigger branch refresh"
				);
			}).pipe(Effect.provide(TestLayer));
		}
	);
});

describe("repo-watching git command options", () => {
	it("disables fsmonitor for correctness-sensitive git reads", () => {
		assert.deepStrictEqual(withFsmonitorDisabled(["status", "--porcelain"]), [
			"-c",
			"core.fsmonitor=false",
			"status",
			"--porcelain",
		]);
	});
});
