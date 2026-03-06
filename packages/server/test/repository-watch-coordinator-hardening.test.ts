import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { BranchStateTracker } from "../src/services/branch-state-tracker.js";
import {
	FileWatcher,
	type WatchEvent,
	type WatchSubscription,
} from "../src/services/file-watcher.js";
import { withFsmonitorDisabled } from "../src/services/repo-watching-git.js";
import { RepositoryEventBus } from "../src/services/repository-event-bus.js";
import { RepositoryIdentity } from "../src/services/repository-identity.js";
import { RepositoryWatchCoordinator } from "../src/services/repository-watch-coordinator.js";
import { WorktreeReconciler } from "../src/services/worktree-reconciler.js";
import { TestLaborerStore } from "./helpers/test-store.js";
import { waitFor } from "./helpers/timing-helpers.js";

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
		Layer.provide(RepositoryEventBus.layer),
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
