import { execFile } from "node:child_process";
import { existsSync, type FSWatcher, watch } from "node:fs";
import { join, resolve } from "node:path";
import { tables } from "@laborer/shared/schema";
import { Context, Effect, Layer, Ref } from "effect";
import { LaborerStore } from "./laborer-store.js";
import { WorktreeReconciler } from "./worktree-reconciler.js";

interface ProjectWatchState {
	readonly gitDirPath: string;
	readonly projectId: string;
	readonly repoPath: string;
	readonly target: "gitDir" | "worktrees";
	timer: ReturnType<typeof setTimeout> | null;
	readonly watcher: FSWatcher;
}

const DEBOUNCE_MS = 500;

const runGit = (
	repoPath: string,
	args: readonly string[]
): Effect.Effect<string, Error> =>
	Effect.tryPromise({
		try: () =>
			new Promise<string>((resolvePromise, rejectPromise) => {
				execFile(
					"git",
					[...args],
					{ cwd: repoPath },
					(error, stdout, stderr) => {
						if (error) {
							rejectPromise(
								new Error(
									`git ${args.join(" ")} failed: ${stderr.trim() || String(error)}`
								)
							);
							return;
						}

						resolvePromise(stdout.trim());
					}
				);
			}),
		catch: (error) =>
			error instanceof Error ? error : new Error(String(error)),
	});

const resolveGitCommonDir = (repoPath: string): Effect.Effect<string, Error> =>
	Effect.gen(function* () {
		const raw = yield* runGit(repoPath, ["rev-parse", "--git-common-dir"]);
		return resolve(repoPath, raw);
	});

class WorktreeWatcher extends Context.Tag("@laborer/WorktreeWatcher")<
	WorktreeWatcher,
	{
		readonly watchAll: () => Effect.Effect<void, never>;
		readonly watchProject: (
			projectId: string,
			repoPath: string
		) => Effect.Effect<void, never>;
		readonly unwatchProject: (projectId: string) => Effect.Effect<void, never>;
	}
>() {
	static readonly layer = Layer.scoped(
		WorktreeWatcher,
		Effect.gen(function* () {
			const { store } = yield* LaborerStore;
			const reconciler = yield* WorktreeReconciler;
			const statesRef = yield* Ref.make(new Map<string, ProjectWatchState>());

			const clearTimer = (state: ProjectWatchState): void => {
				if (state.timer !== null) {
					clearTimeout(state.timer);
					state.timer = null;
				}
			};

			const closeState = (state: ProjectWatchState): void => {
				clearTimer(state);
				state.watcher.close();
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
				state: ProjectWatchState,
				reason: string
			): void => {
				clearTimer(state);
				state.timer = setTimeout(() => {
					state.timer = null;
					Effect.runPromise(
						reconcileWithWarning(state.projectId, state.repoPath, reason)
					).catch(() => undefined);
				}, DEBOUNCE_MS);
			};

			const switchToWorktreesWatcher = (state: ProjectWatchState): void => {
				const worktreesDir = join(state.gitDirPath, "worktrees");
				if (state.target !== "gitDir" || !existsSync(worktreesDir)) {
					return;
				}

				Effect.runPromise(
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

			const unwatchProject = Effect.fn("WorktreeWatcher.unwatchProject")(
				function* (projectId: string) {
					yield* Ref.update(statesRef, (states) => {
						const next = new Map(states);
						const existing = next.get(projectId);
						if (existing !== undefined) {
							closeState(existing);
							next.delete(projectId);
						}
						return next;
					});
				}
			);

			const createWatcher = (
				projectId: string,
				repoPath: string,
				gitDirPath: string,
				target: "gitDir" | "worktrees"
			): Effect.Effect<ProjectWatchState | null, never> => {
				const watchPath =
					target === "worktrees" ? join(gitDirPath, "worktrees") : gitDirPath;

				if (!existsSync(watchPath)) {
					return Effect.succeed(null);
				}

				return Effect.try({
					try: () => {
						let stateRef: ProjectWatchState | null = null;
						const watcher = watch(watchPath, (_eventType, fileName) => {
							if (stateRef === null) {
								return;
							}

							if (target === "gitDir") {
								if (fileName === "worktrees") {
									switchToWorktreesWatcher(stateRef);
									scheduleReconcile(stateRef, "worktrees-created");
								}
								return;
							}

							scheduleReconcile(stateRef, "filesystem-change");
						});

						stateRef = {
							projectId,
							repoPath,
							gitDirPath,
							target,
							watcher,
							timer: null,
						};

						watcher.on("error", () => {
							if (stateRef !== null) {
								scheduleReconcile(stateRef, "watcher-error");
							}
						});

						return stateRef;
					},
					catch: (error) =>
						error instanceof Error ? error : new Error(String(error)),
				}).pipe(
					Effect.catchAll((error) =>
						Effect.logWarning(
							`Failed to watch worktrees for project ${projectId}: ${error.message}`
						).pipe(Effect.as(null))
					)
				);
			};

			const watchProject = Effect.fn("WorktreeWatcher.watchProject")(function* (
				projectId: string,
				repoPath: string
			) {
				yield* unwatchProject(projectId);

				const gitDirPath = yield* resolveGitCommonDir(repoPath).pipe(
					Effect.catchAll((error) =>
						Effect.logWarning(
							`Failed to resolve git common dir for project ${projectId}: ${error.message}`
						).pipe(Effect.as(null))
					)
				);

				if (gitDirPath === null) {
					return;
				}

				const initialTarget = existsSync(join(gitDirPath, "worktrees"))
					? "worktrees"
					: "gitDir";

				const state = yield* createWatcher(
					projectId,
					repoPath,
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
			});

			const watchAll = Effect.fn("WorktreeWatcher.watchAll")(function* () {
				const projects = store.query(tables.projects);
				yield* Effect.forEach(projects, (project) =>
					reconcileWithWarning(project.id, project.repoPath, "startup")
				);
				yield* Effect.forEach(projects, (project) =>
					watchProject(project.id, project.repoPath)
				);
			});

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

			const service = WorktreeWatcher.of({
				watchProject,
				unwatchProject,
				watchAll,
			});

			yield* watchAll();

			return service;
		})
	);
}

export { WorktreeWatcher };
