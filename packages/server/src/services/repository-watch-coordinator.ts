/**
 * RepositoryWatchCoordinator — Scoped Effect Service
 *
 * Owns all watcher lifecycle for registered repositories. For each
 * project, the coordinator subscribes to:
 *   1. The canonical common git directory — for metadata changes that
 *      affect branch state, worktree membership, and HEAD.
 *   2. The canonical checkout root — for repo-wide file change events
 *      that are normalized and published through the RepositoryEventBus.
 *
 * Watch events are treated as invalidation signals only. The
 * coordinator does not mutate project or workspace state directly;
 * instead, it debounces events and delegates to refresh services:
 *   - WorktreeReconciler for worktree membership changes
 *   - BranchStateTracker for branch metadata refresh
 *   - RepositoryEventBus for normalized file change fanout
 *
 * Events are classified by concern and debounced independently so
 * that rapid branch switches do not delay worktree reconciliation
 * and vice versa.
 *
 * The coordinator is scoped: project removal tears down that
 * project's watchers, and server shutdown tears down all watchers
 * via the Effect finalizer.
 *
 * @see PRD-opencode-inspired-repo-watching.md — Issues 3, 4 & 5
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { tables } from "@laborer/shared/schema";
import { Context, Data, Effect, Layer, Ref, Runtime } from "effect";
import { BranchStateTracker } from "./branch-state-tracker.js";
import {
	FileWatcher,
	type WatchEvent,
	type WatchSubscription,
} from "./file-watcher.js";
import { LaborerStore } from "./laborer-store.js";
import { RepositoryEventBus } from "./repository-event-bus.js";
import { RepositoryIdentity } from "./repository-identity.js";
import { WorktreeReconciler } from "./worktree-reconciler.js";

/**
 * Per-project watcher state. Tracks active subscriptions so they
 * can be individually torn down on project removal.
 */
interface ProjectWatcherState {
	/** Pending debounce timer for branch state refresh */
	branchTimer: ReturnType<typeof setTimeout> | null;
	/** Canonical path to the git common directory */
	readonly gitDirPath: string;
	/** Subscription to the git metadata root for HEAD/refs changes */
	gitDirRootSubscription: WatchSubscription | null;
	/** Project identifier */
	readonly projectId: string;
	/** Pending retry timer for watcher recovery */
	recoveryTimer: ReturnType<typeof setTimeout> | null;
	/** Canonical repo checkout root */
	readonly repoPath: string;
	/** Subscription to the repo checkout root for file change events */
	repoRootSubscription: WatchSubscription | null;
	/** Subscription to the shared worktrees directory for linked-worktree metadata */
	worktreesSubscription: WatchSubscription | null;
	/** Pending debounce timer for worktree reconciliation */
	worktreeTimer: ReturnType<typeof setTimeout> | null;
}

const DEBOUNCE_MS = 500;
const RECOVERY_RETRY_MS = 1000;

/**
 * Files in the git directory that indicate branch-related changes.
 * HEAD is modified on branch switches, refs/ contains branch pointers,
 * MERGE_HEAD and REBASE_HEAD appear during merge/rebase operations.
 */
const BRANCH_RELATED_FILES = new Set([
	"HEAD",
	"MERGE_HEAD",
	"REBASE_HEAD",
	"ORIG_HEAD",
	"FETCH_HEAD",
]);

/**
 * Determine whether a filesystem event from the git directory
 * is branch-related based on the fileName.
 */
const isBranchRelatedEvent = (fileName: string | null): boolean => {
	if (fileName === null) {
		// If fileName is unavailable, treat as both concerns
		return true;
	}
	if (BRANCH_RELATED_FILES.has(fileName)) {
		return true;
	}
	// refs/ directory changes (e.g., refs/heads/main) indicate branch updates
	if (fileName.startsWith("refs")) {
		return true;
	}
	return false;
};

/**
 * Determine whether a filesystem event from the git directory
 * is worktree-related based on the fileName.
 */
const isWorktreeRelatedEvent = (fileName: string | null): boolean => {
	if (fileName === null) {
		// If fileName is unavailable, treat as both concerns
		return true;
	}
	if (fileName === "worktrees" || fileName.startsWith("worktrees")) {
		return true;
	}
	return false;
};

class RepositoryWatchCoordinatorError extends Data.TaggedError(
	"RepositoryWatchCoordinatorError"
)<{
	readonly message: string;
}> {}

class RepositoryWatchCoordinator extends Context.Tag(
	"@laborer/RepositoryWatchCoordinator"
)<
	RepositoryWatchCoordinator,
	{
		/**
		 * Start watching a project's repository. Resolves canonical
		 * identity, subscribes to git metadata, and sets up debounced
		 * refresh. Idempotent — re-calling for the same project
		 * replaces the previous watchers.
		 */
		readonly watchProject: (
			projectId: string,
			repoPath: string
		) => Effect.Effect<void, never>;

		/**
		 * Stop watching a project. Closes all subscriptions and
		 * clears pending timers for the given project.
		 */
		readonly unwatchProject: (projectId: string) => Effect.Effect<void, never>;

		/**
		 * Reconcile and start watching all persisted projects.
		 * Used during startup bootstrapping.
		 */
		readonly watchAll: () => Effect.Effect<void, never>;
	}
>() {
	static readonly layer = Layer.scoped(
		RepositoryWatchCoordinator,
		Effect.gen(function* () {
			const { store } = yield* LaborerStore;
			const reconciler = yield* WorktreeReconciler;
			const branchTracker = yield* BranchStateTracker;
			const repoIdentity = yield* RepositoryIdentity;
			const fileWatcher = yield* FileWatcher;
			const eventBus = yield* RepositoryEventBus;
			const runtime = yield* Effect.runtime<never>();
			const statesRef = yield* Ref.make(new Map<string, ProjectWatcherState>());

			const runPromise = Runtime.runPromise(runtime);

			// ── Helpers ──────────────────────────────────────────────

			const clearTimers = (state: ProjectWatcherState): void => {
				if (state.worktreeTimer !== null) {
					clearTimeout(state.worktreeTimer);
					state.worktreeTimer = null;
				}
				if (state.branchTimer !== null) {
					clearTimeout(state.branchTimer);
					state.branchTimer = null;
				}
				if (state.recoveryTimer !== null) {
					clearTimeout(state.recoveryTimer);
					state.recoveryTimer = null;
				}
			};

			const closeState = (state: ProjectWatcherState): void => {
				clearTimers(state);
				if (state.gitDirRootSubscription !== null) {
					state.gitDirRootSubscription.close();
				}
				if (state.worktreesSubscription !== null) {
					state.worktreesSubscription.close();
				}
				if (state.repoRootSubscription !== null) {
					state.repoRootSubscription.close();
				}
			};

			const reconcileWithWarning = (
				projectId: string,
				repoPath: string,
				reason: string
			): Effect.Effect<void, never> =>
				reconciler.reconcile(projectId, repoPath).pipe(
					Effect.asVoid,
					Effect.catchAll((error) =>
						Effect.logWarning(
							`Worktree reconciliation failed for project ${projectId} (${reason}): ${error.message}`
						)
					)
				);

			const refreshBranchesWithWarning = (
				projectId: string,
				reason: string
			): Effect.Effect<void, never> =>
				branchTracker.refreshBranches(projectId).pipe(
					Effect.asVoid,
					Effect.catchAll((error) =>
						Effect.logWarning(
							`Branch refresh failed for project ${projectId} (${reason}): ${error.message}`
						)
					)
				);

			const scheduleReconcile = (
				state: ProjectWatcherState,
				reason: string
			): void => {
				if (state.worktreeTimer !== null) {
					clearTimeout(state.worktreeTimer);
				}
				state.worktreeTimer = setTimeout(() => {
					state.worktreeTimer = null;
					runPromise(
						reconcileWithWarning(state.projectId, state.repoPath, reason)
					).catch(() => undefined);
				}, DEBOUNCE_MS);
			};

			const scheduleBranchRefresh = (
				state: ProjectWatcherState,
				reason: string
			): void => {
				if (state.branchTimer !== null) {
					clearTimeout(state.branchTimer);
				}
				state.branchTimer = setTimeout(() => {
					state.branchTimer = null;
					runPromise(refreshBranchesWithWarning(state.projectId, reason)).catch(
						() => undefined
					);
				}, DEBOUNCE_MS);
			};

			const scheduleRecovery = (
				state: ProjectWatcherState,
				reason: string
			): void => {
				if (state.recoveryTimer !== null) {
					return;
				}

				state.recoveryTimer = setTimeout(() => {
					state.recoveryTimer = null;
					runPromise(
						Effect.logWarning(
							`Watcher degraded for project ${state.projectId} (${reason}); attempting recovery`
						).pipe(
							Effect.zipRight(
								Ref.get(statesRef).pipe(
									Effect.flatMap((states) => {
										const latest = states.get(state.projectId);
										if (latest === undefined) {
											return Effect.void;
										}

										return watchProject(latest.projectId, latest.repoPath);
									})
								)
							)
						)
					).catch(() => undefined);
				}, RECOVERY_RETRY_MS);
			};

			// ── Git metadata watcher ─────────────────────────────────

			/**
			 * Attempt to add the dedicated worktrees watcher when the
			 * shared worktrees directory appears inside the git dir.
			 */
			const switchToWorktreesWatcher = (state: ProjectWatcherState): void => {
				const worktreesDir = join(state.gitDirPath, "worktrees");
				if (state.worktreesSubscription !== null || !existsSync(worktreesDir)) {
					return;
				}

				runPromise(
					Ref.get(statesRef).pipe(
						Effect.flatMap((states) => {
							const latest = states.get(state.projectId);
							if (
								latest === undefined ||
								latest.worktreesSubscription !== null
							) {
								return Effect.void;
							}
							return watchProject(latest.projectId, latest.repoPath);
						})
					)
				).catch(() => undefined);
			};

			const handleGitDirRootEvent = (
				state: ProjectWatcherState,
				event: WatchEvent
			): void => {
				if (event.fileName === "worktrees") {
					switchToWorktreesWatcher(state);
					scheduleReconcile(state, "worktrees-created");
				}

				if (isBranchRelatedEvent(event.fileName)) {
					scheduleBranchRefresh(state, "git-metadata-change");
				}

				if (isWorktreeRelatedEvent(event.fileName)) {
					scheduleReconcile(state, "git-metadata-change");
				}
			};

			const handleWorktreesEvent = (
				state: ProjectWatcherState,
				_event: WatchEvent
			): void => {
				scheduleReconcile(state, "worktree-metadata-change");
				scheduleBranchRefresh(state, "worktree-metadata-change");
			};

			const subscribeGitDirRoot = (
				projectId: string,
				gitDirPath: string,
				state: ProjectWatcherState
			): Effect.Effect<WatchSubscription | null, never> =>
				fileWatcher
					.subscribe(
						gitDirPath,
						(event) => {
							handleGitDirRootEvent(state, event);
						},
						(error) => {
							runPromise(
								Effect.logWarning(
									`Git watcher error for project ${projectId} at ${gitDirPath}: ${error.message}`
								)
							).catch(() => undefined);
							scheduleReconcile(state, "watcher-error");
							scheduleBranchRefresh(state, "watcher-error");
							scheduleRecovery(state, "git-watcher-error");
						},
						{ recursive: true }
					)
					.pipe(
						Effect.tap((subscription) =>
							subscription === null
								? Effect.logWarning(
										`Git watch target unavailable for project ${projectId}: ${gitDirPath}`
									)
								: Effect.void
						),
						Effect.catchAll((error) =>
							Effect.logWarning(
								`Failed to watch git dir for project ${projectId}: ${error.message}`
							).pipe(Effect.as(null))
						)
					);

			const subscribeWorktreesDir = (
				projectId: string,
				gitDirPath: string,
				state: ProjectWatcherState
			): Effect.Effect<WatchSubscription | null, never> => {
				const worktreesDir = join(gitDirPath, "worktrees");

				return fileWatcher
					.subscribe(
						worktreesDir,
						(event) => {
							handleWorktreesEvent(state, event);
						},
						(error) => {
							runPromise(
								Effect.logWarning(
									`Worktrees watcher error for project ${projectId} at ${worktreesDir}: ${error.message}`
								)
							).catch(() => undefined);
							scheduleReconcile(state, "watcher-error");
							scheduleBranchRefresh(state, "watcher-error");
							scheduleRecovery(state, "worktrees-watcher-error");
						},
						{ recursive: true }
					)
					.pipe(
						Effect.tap((subscription) =>
							subscription === null
								? Effect.logWarning(
										`Git worktrees watch target unavailable for project ${projectId}: ${worktreesDir}`
									)
								: Effect.void
						),
						Effect.catchAll((error) =>
							Effect.logWarning(
								`Failed to watch worktrees dir for project ${projectId}: ${error.message}`
							).pipe(Effect.as(null))
						)
					);
			};

			// ── Repo-root file watcher ───────────────────────────────

			/**
			 * Subscribe to the canonical repo checkout root for file-level
			 * change events. Events are normalized and published through
			 * the RepositoryEventBus. Ignored paths are suppressed before
			 * publishing.
			 */
			const subscribeRepoRoot = (
				projectId: string,
				repoPath: string
			): Effect.Effect<WatchSubscription | null, never> =>
				fileWatcher
					.subscribe(
						repoPath,
						(event) => {
							const normalized = eventBus.normalizeEvent({
								type: event.type === "rename" ? "add" : "change",
								fileName: event.fileName,
								repoRoot: repoPath,
								projectId,
							});
							if (normalized !== null) {
								Runtime.runSync(runtime)(eventBus.publish(normalized));
							}
						},
						(error) => {
							runPromise(
								Effect.logWarning(
									`Repo watcher error for project ${projectId} at ${repoPath}: ${error.message}`
								)
							).catch(() => undefined);
							runPromise(
								Ref.get(statesRef).pipe(
									Effect.flatMap((states) => {
										const state = states.get(projectId);
										if (state === undefined) {
											return Effect.void;
										}
										scheduleRecovery(state, "repo-watcher-error");
										return Effect.void;
									})
								)
							).catch(() => undefined);
						},
						{ recursive: true }
					)
					.pipe(
						Effect.tap((subscription) =>
							subscription === null
								? Effect.logWarning(
										`Repo watch target unavailable for project ${projectId}: ${repoPath}`
									)
								: Effect.void
						),
						Effect.catchAll((error) =>
							Effect.logWarning(
								`Failed to watch repo root for project ${projectId}: ${error.message}`
							).pipe(Effect.as(null))
						)
					);

			// ── Public methods ───────────────────────────────────────

			const unwatchProject = Effect.fn(
				"RepositoryWatchCoordinator.unwatchProject"
			)(function* (projectId: string) {
				yield* Ref.update(statesRef, (states) => {
					const next = new Map(states);
					const existing = next.get(projectId);
					if (existing !== undefined) {
						closeState(existing);
						next.delete(projectId);
					}
					return next;
				});
			});

			const watchProject = Effect.fn("RepositoryWatchCoordinator.watchProject")(
				function* (projectId: string, repoPath: string) {
					// Tear down existing watchers for this project
					yield* unwatchProject(projectId);

					// Resolve canonical git common dir
					const identity = yield* repoIdentity
						.resolve(repoPath)
						.pipe(
							Effect.catchAll((error) =>
								Effect.logWarning(
									`Failed to resolve repo identity for project ${projectId}: ${error.message}`
								).pipe(Effect.as(null))
							)
						);

					if (identity === null) {
						return;
					}

					const gitDirPath = identity.canonicalGitCommonDir;
					const hasWorktreesDir = existsSync(join(gitDirPath, "worktrees"));

					const state: ProjectWatcherState = {
						projectId,
						repoPath: identity.canonicalRoot,
						gitDirPath,
						gitDirRootSubscription: null,
						worktreesSubscription: null,
						repoRootSubscription: null,
						worktreeTimer: null,
						branchTimer: null,
						recoveryTimer: null,
					};

					state.gitDirRootSubscription = yield* subscribeGitDirRoot(
						projectId,
						gitDirPath,
						state
					);

					if (hasWorktreesDir) {
						state.worktreesSubscription = yield* subscribeWorktreesDir(
							projectId,
							gitDirPath,
							state
						);
					}

					// Subscribe to the repo checkout root for file-level events
					state.repoRootSubscription = yield* subscribeRepoRoot(
						projectId,
						identity.canonicalRoot
					);

					yield* Ref.update(statesRef, (states) => {
						const next = new Map(states);
						next.set(projectId, state);
						return next;
					});

					if (
						state.gitDirRootSubscription === null ||
						state.repoRootSubscription === null ||
						(hasWorktreesDir && state.worktreesSubscription === null)
					) {
						scheduleRecovery(state, "watch-target-unavailable");
					}
				}
			);

			const watchAll = Effect.fn("RepositoryWatchCoordinator.watchAll")(
				function* () {
					const projects = store.query(tables.projects);
					yield* Effect.forEach(projects, (project) =>
						reconcileWithWarning(project.id, project.repoPath, "startup")
					);
					yield* Effect.forEach(projects, (project) =>
						refreshBranchesWithWarning(project.id, "startup")
					);
					yield* Effect.forEach(projects, (project) =>
						watchProject(project.id, project.repoPath)
					);
				}
			);

			// ── Lifecycle ────────────────────────────────────────────

			yield* Effect.addFinalizer(() =>
				Ref.get(statesRef).pipe(
					Effect.flatMap((states) =>
						Effect.sync(() => {
							for (const state of states.values()) {
								closeState(state);
							}
						})
					)
				)
			);

			const service = RepositoryWatchCoordinator.of({
				watchProject,
				unwatchProject,
				watchAll,
			});

			// Bootstrap: reconcile and watch all existing projects
			yield* watchAll();

			return service;
		})
	);
}

export { RepositoryWatchCoordinator, RepositoryWatchCoordinatorError };
