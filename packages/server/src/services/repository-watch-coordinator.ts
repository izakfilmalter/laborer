/**
 * RepositoryWatchCoordinator — Scoped Effect Service
 *
 * Owns all watcher lifecycle for registered repositories. For each
 * project, the coordinator subscribes to:
 *   1. The canonical common git directory — for metadata changes that
 *      affect branch state, worktree membership, and HEAD.
 *   2. (Future: the canonical checkout root — for repo-wide file change
 *      events, to be wired in Issue 5.)
 *
 * Watch events are treated as invalidation signals only. The
 * coordinator does not mutate project or workspace state directly;
 * instead, it debounces events and delegates to refresh services
 * (currently WorktreeReconciler, later BranchStateTracker and
 * RepositoryStateRefresher from Issue 4).
 *
 * The coordinator is scoped: project removal tears down that
 * project's watchers, and server shutdown tears down all watchers
 * via the Effect finalizer.
 *
 * @see PRD-opencode-inspired-repo-watching.md — Issue 3
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { tables } from "@laborer/shared/schema";
import { Context, Data, Effect, Layer, Ref, Runtime } from "effect";
import {
	FileWatcher,
	type WatchEvent,
	type WatchSubscription,
} from "./file-watcher.js";
import { LaborerStore } from "./laborer-store.js";
import { RepositoryIdentity } from "./repository-identity.js";
import { WorktreeReconciler } from "./worktree-reconciler.js";

/**
 * Per-project watcher state. Tracks active subscriptions so they
 * can be individually torn down on project removal.
 */
interface ProjectWatcherState {
	/** Canonical path to the git common directory */
	readonly gitDirPath: string;
	/** Subscription to the git metadata directory */
	readonly gitDirSubscription: WatchSubscription | null;
	/** Project identifier */
	readonly projectId: string;
	/** Canonical repo checkout root */
	readonly repoPath: string;
	/** Current git dir watching target (gitDir or worktrees subdirectory) */
	readonly target: "gitDir" | "worktrees";
	/** Pending debounce timer for git metadata changes */
	timer: ReturnType<typeof setTimeout> | null;
}

const DEBOUNCE_MS = 500;

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
			const repoIdentity = yield* RepositoryIdentity;
			const fileWatcher = yield* FileWatcher;
			const runtime = yield* Effect.runtime<never>();
			const statesRef = yield* Ref.make(new Map<string, ProjectWatcherState>());

			const runPromise = Runtime.runPromise(runtime);

			// ── Helpers ──────────────────────────────────────────────

			const clearTimer = (state: ProjectWatcherState): void => {
				if (state.timer !== null) {
					clearTimeout(state.timer);
					state.timer = null;
				}
			};

			const closeState = (state: ProjectWatcherState): void => {
				clearTimer(state);
				if (state.gitDirSubscription !== null) {
					state.gitDirSubscription.close();
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

			const scheduleReconcile = (
				state: ProjectWatcherState,
				reason: string
			): void => {
				clearTimer(state);
				state.timer = setTimeout(() => {
					state.timer = null;
					runPromise(
						reconcileWithWarning(state.projectId, state.repoPath, reason)
					).catch(() => undefined);
				}, DEBOUNCE_MS);
			};

			// ── Git metadata watcher ─────────────────────────────────

			/**
			 * Attempt to switch from watching the gitDir to watching
			 * the more specific worktrees subdirectory. Called when a
			 * "worktrees" directory appears inside the git dir.
			 */
			const switchToWorktreesWatcher = (state: ProjectWatcherState): void => {
				const worktreesDir = join(state.gitDirPath, "worktrees");
				if (state.target !== "gitDir" || !existsSync(worktreesDir)) {
					return;
				}

				runPromise(
					Ref.get(statesRef).pipe(
						Effect.flatMap((states) => {
							const latest = states.get(state.projectId);
							if (latest === undefined || latest.target !== "gitDir") {
								return Effect.void;
							}
							return watchProject(latest.projectId, latest.repoPath);
						})
					)
				).catch(() => undefined);
			};

			const handleGitDirEvent = (
				state: ProjectWatcherState,
				event: WatchEvent
			): void => {
				if (state.target === "gitDir") {
					// Only react to the appearance of the worktrees directory
					// when watching the whole git dir
					if (event.fileName === "worktrees") {
						switchToWorktreesWatcher(state);
						scheduleReconcile(state, "worktrees-created");
					}
					return;
				}

				// Watching the worktrees subdirectory — any change schedules
				// reconciliation
				scheduleReconcile(state, "filesystem-change");
			};

			const subscribeGitDir = (
				projectId: string,
				repoPath: string,
				gitDirPath: string,
				target: "gitDir" | "worktrees"
			): Effect.Effect<ProjectWatcherState | null, never> => {
				const watchPath =
					target === "worktrees" ? join(gitDirPath, "worktrees") : gitDirPath;

				return Effect.gen(function* () {
					let stateRef: ProjectWatcherState | null = null;

					const subscription = yield* fileWatcher.subscribe(
						watchPath,
						(event) => {
							if (stateRef !== null) {
								handleGitDirEvent(stateRef, event);
							}
						},
						(_error) => {
							if (stateRef !== null) {
								scheduleReconcile(stateRef, "watcher-error");
							}
						}
					);

					if (subscription === null) {
						return null;
					}

					stateRef = {
						projectId,
						repoPath,
						gitDirPath,
						target,
						gitDirSubscription: subscription,
						timer: null,
					};

					return stateRef;
				}).pipe(
					Effect.catchAll((error) =>
						Effect.logWarning(
							`Failed to watch git dir for project ${projectId}: ${error.message}`
						).pipe(Effect.as(null))
					)
				);
			};

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

					// Pick the most specific watch target
					const initialTarget = existsSync(join(gitDirPath, "worktrees"))
						? "worktrees"
						: "gitDir";

					const state = yield* subscribeGitDir(
						projectId,
						identity.canonicalRoot,
						gitDirPath,
						initialTarget
					);

					if (state === null) {
						return;
					}

					yield* Ref.update(statesRef, (states) => {
						const next = new Map(states);
						next.set(projectId, state);
						return next;
					});
				}
			);

			const watchAll = Effect.fn("RepositoryWatchCoordinator.watchAll")(
				function* () {
					const projects = store.query(tables.projects);
					yield* Effect.forEach(projects, (project) =>
						reconcileWithWarning(project.id, project.repoPath, "startup")
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
