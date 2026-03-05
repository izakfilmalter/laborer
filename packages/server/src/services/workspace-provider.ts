/**
 * WorkspaceProvider — Effect Service
 *
 * Manages isolated workspace environments via git worktrees. Each workspace
 * gets its own branch, directory, and allocated port. The provider interface
 * is designed to be pluggable — v1 ships with git worktrees, but future
 * implementations could use Docker or Daytona.
 *
 * Responsibilities:
 * - Worktree creation via `git worktree add`
 * - Worktree destruction via `git worktree remove` + `git branch -D`
 * - Port allocation via PortAllocator
 * - Project validation via ProjectRegistry
 * - Workspace state tracking via LiveStore
 * - Branch management and naming
 * - Environment variable injection (PORT, etc.) for workspace processes
 * - Setup script execution after worktree creation (Issue #35)
 * - Full rollback on setup script failure (Issue #37)
 *
 * Setup scripts are defined in a `.laborer.json` file at the project root:
 * ```json
 * {
 *   "setupScripts": ["bun install", "cp .env.example .env"]
 * }
 * ```
 *
 * Each script is executed in the worktree directory with the workspace
 * environment variables (PORT, etc.) injected. Scripts run sequentially
 * and any non-zero exit code aborts the remaining scripts. On failure,
 * the workspace is rolled back: worktree removed, port freed, branch
 * deleted. The error includes the script's stdout + stderr output.
 *
 * Usage:
 * ```ts
 * const program = Effect.gen(function* () {
 *   const provider = yield* WorkspaceProvider
 *   const workspace = yield* provider.createWorktree("project-id", "feature/my-branch")
 *   const env = yield* provider.getWorkspaceEnv("workspace-id")
 *   // env.PORT === "3142"
 *   yield* provider.destroyWorktree("workspace-id")
 * })
 * ```
 *
 * Issue #33: createWorktree method
 * Issue #35: run setup scripts in worktree
 * Issue #36: inject PORT env var
 * Issue #37: handle setup script failure (rollback)
 * Issue #43: destroyWorktree method
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { RpcError } from "@laborer/shared/rpc";
import { events, tables } from "@laborer/shared/schema";
import { Array as Arr, Context, Effect, Layer, pipe } from "effect";
import { LaborerStore } from "./laborer-store.js";
import { PortAllocator } from "./port-allocator.js";
import { ProjectRegistry } from "./project-registry.js";

/**
 * Shape of a workspace record returned by the provider.
 * Matches the LiveStore workspaces table columns.
 */
interface WorkspaceRecord {
	/** SHA of the parent branch HEAD when the worktree was created. Used by DiffService as the diff base. */
	readonly baseSha: string | null;
	readonly branchName: string;
	readonly createdAt: string;
	readonly id: string;
	readonly port: number;
	readonly projectId: string;
	readonly status: string;
	readonly taskSource: string | null;
	readonly worktreePath: string;
}

/**
 * Default directory name for worktrees, relative to the repo root.
 * Worktrees are created at `<repoPath>/.worktrees/<branchSlug>`.
 */
const WORKTREE_DIR = ".worktrees";

/**
 * Slugify a branch name for use as a directory name.
 * Replaces non-alphanumeric characters (except hyphens) with hyphens.
 */
const slugify = (branchName: string): string =>
	branchName
		.replace(/\//g, "-")
		.replace(/[^a-zA-Z0-9-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");

/**
 * Configuration file name for project-specific settings.
 * Located at the project root (e.g., `/path/to/repo/.laborer.json`).
 */
const CONFIG_FILE = ".laborer.json";

/**
 * Module-level log annotation for structured logging.
 */
const logPrefix = "WorkspaceProvider";

/**
 * Shape of the `.laborer.json` project configuration file.
 * Currently only supports `setupScripts` — an array of shell commands
 * to execute in the worktree after creation.
 */
interface LaborerConfig {
	readonly setupScripts?: readonly string[];
}

/**
 * Read and parse the `.laborer.json` config file from a project root.
 * Returns an empty config if the file doesn't exist or is invalid JSON.
 * Logs a warning if the file exists but can't be parsed.
 */
const readProjectConfig = (
	repoPath: string
): Effect.Effect<LaborerConfig, never> => {
	const configPath = join(repoPath, CONFIG_FILE);

	return Effect.gen(function* () {
		if (!existsSync(configPath)) {
			return {} as LaborerConfig;
		}

		const content = yield* Effect.try({
			try: () => readFileSync(configPath, "utf-8"),
			catch: (error) => error,
		}).pipe(
			Effect.catchAll((error) =>
				Effect.gen(function* () {
					yield* Effect.logWarning(
						`Failed to read ${CONFIG_FILE}: ${String(error)}`
					).pipe(Effect.annotateLogs("module", logPrefix));
					return "" as string;
				})
			)
		);

		if (content.length === 0) {
			return {} as LaborerConfig;
		}

		const parsed = yield* Effect.try({
			try: () => JSON.parse(content) as LaborerConfig,
			catch: (error) => error,
		}).pipe(
			Effect.catchAll((error) =>
				Effect.gen(function* () {
					yield* Effect.logWarning(
						`Failed to parse ${CONFIG_FILE}: ${String(error)}`
					).pipe(Effect.annotateLogs("module", logPrefix));
					return {} as LaborerConfig;
				})
			)
		);

		return parsed;
	});
};

/**
 * Result of running a single setup script.
 */
interface SetupScriptResult {
	readonly command: string;
	readonly exitCode: number;
	readonly stderr: string;
	readonly stdout: string;
}

/**
 * Execute a single shell command in a given directory with the provided
 * environment variables. Captures stdout and stderr for logging.
 */
const runSetupScript = (
	command: string,
	cwd: string,
	env: Record<string, string>
): Effect.Effect<SetupScriptResult, RpcError> =>
	Effect.tryPromise({
		try: async () => {
			const proc = Bun.spawn(["sh", "-c", command], {
				cwd,
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, ...env },
			});
			const exitCode = await proc.exited;
			const stdout = await new Response(proc.stdout).text();
			const stderr = await new Response(proc.stderr).text();
			return { command, exitCode, stdout, stderr };
		},
		catch: (error) =>
			new RpcError({
				message: `Failed to spawn setup script '${command}': ${String(error)}`,
				code: "SETUP_SCRIPT_FAILED",
			}),
	});

/**
 * Execute all setup scripts from the project config in the worktree directory.
 * Scripts run sequentially. Captures stdout/stderr for each script.
 * Returns an array of results. If any script has a non-zero exit code,
 * execution stops and the remaining scripts are skipped.
 *
 * @param scripts - Array of shell commands to execute
 * @param worktreePath - Directory to execute scripts in
 * @param env - Environment variables to inject (PORT, etc.)
 * @returns Array of results for each executed script
 */
const executeSetupScripts = (
	scripts: readonly string[],
	worktreePath: string,
	env: Record<string, string>
): Effect.Effect<readonly SetupScriptResult[], RpcError> =>
	Effect.gen(function* () {
		const results: SetupScriptResult[] = [];

		for (const script of scripts) {
			yield* Effect.logInfo(`Running setup script: ${script}`).pipe(
				Effect.annotateLogs("module", logPrefix)
			);

			const result = yield* runSetupScript(script, worktreePath, env);
			results.push(result);

			if (result.stdout.length > 0) {
				yield* Effect.logDebug(
					`Setup script stdout: ${result.stdout.trim()}`
				).pipe(Effect.annotateLogs("module", logPrefix));
			}

			if (result.exitCode !== 0) {
				yield* Effect.logWarning(
					`Setup script failed (exit ${result.exitCode}): ${script}\nstderr: ${result.stderr.trim()}`
				).pipe(Effect.annotateLogs("module", logPrefix));
				// Stop executing remaining scripts — the caller will handle rollback
				break;
			}

			yield* Effect.logInfo(
				`Setup script completed successfully: ${script}`
			).pipe(Effect.annotateLogs("module", logPrefix));
		}

		return results;
	});

/**
 * Result of running setup scripts. Either all scripts succeeded,
 * or one failed with details about the failure.
 */
type SetupResult =
	| { readonly _tag: "Success" }
	| {
			readonly _tag: "Failure";
			readonly command: string;
			readonly exitCode: number;
			readonly stdout: string;
			readonly stderr: string;
	  };

/**
 * Run setup scripts from the project config in the worktree directory.
 * Returns a SetupResult indicating success or failure with details.
 * Does nothing (returns Success) if no scripts are configured.
 *
 * @param repoPath - Path to the project repo (for reading .laborer.json)
 * @param worktreePath - Directory to execute scripts in
 * @param env - Environment variables to inject (PORT, etc.)
 */
const runProjectSetupScripts = (
	repoPath: string,
	worktreePath: string,
	env: Record<string, string>
): Effect.Effect<SetupResult, RpcError> =>
	Effect.gen(function* () {
		const config = yield* readProjectConfig(repoPath);

		if (config.setupScripts === undefined || config.setupScripts.length === 0) {
			return { _tag: "Success" } as SetupResult;
		}

		const scriptResults = yield* executeSetupScripts(
			config.setupScripts,
			worktreePath,
			env
		);

		const failedScript = pipe(
			scriptResults,
			Arr.findFirst((r) => r.exitCode !== 0)
		);

		if (failedScript._tag === "Some") {
			const failed = failedScript.value;
			yield* Effect.logWarning(
				`Workspace setup failed: script '${failed.command}' exited with code ${failed.exitCode}`
			).pipe(Effect.annotateLogs("module", logPrefix));

			return {
				_tag: "Failure",
				command: failed.command,
				exitCode: failed.exitCode,
				stdout: failed.stdout,
				stderr: failed.stderr,
			} as SetupResult;
		}

		yield* Effect.logInfo(
			`All ${config.setupScripts.length} setup script(s) completed successfully`
		).pipe(Effect.annotateLogs("module", logPrefix));

		return { _tag: "Success" } as SetupResult;
	});

/**
 * Build the error message for a failed setup script, including
 * stdout and stderr output for user visibility.
 */
const buildSetupFailureMessage = (failure: {
	readonly command: string;
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}): string => {
	const outputParts: string[] = [];
	if (failure.stdout.trim().length > 0) {
		outputParts.push(`stdout: ${failure.stdout.trim()}`);
	}
	if (failure.stderr.trim().length > 0) {
		outputParts.push(`stderr: ${failure.stderr.trim()}`);
	}
	const outputSuffix =
		outputParts.length > 0 ? `\n${outputParts.join("\n")}` : "";

	return `Setup script '${failure.command}' failed with exit code ${failure.exitCode}.${outputSuffix}`;
};

/**
 * Rollback a partially-created workspace. Cleans up in order:
 * 1. Set workspace status to "errored" in LiveStore (if workspace was committed)
 * 2. Remove the git worktree directory via `git worktree remove --force`
 * 3. Delete the branch via `git branch -D`
 * 4. Free the allocated port
 *
 * All steps are best-effort — failures are logged but don't prevent
 * subsequent cleanup steps from running.
 *
 * @param repoPath - Path to the main git repo
 * @param worktreePath - Path to the worktree directory to remove
 * @param branchName - Branch name to delete
 * @param port - Port to free
 * @param portAllocator - PortAllocator service instance
 */
const rollbackWorktree = (
	repoPath: string,
	worktreePath: string,
	branchName: string,
	port: number,
	portAllocator: {
		readonly free: (port: number) => Effect.Effect<void, RpcError>;
	}
): Effect.Effect<void, never> =>
	Effect.gen(function* () {
		yield* Effect.logInfo(
			`Rolling back workspace: removing worktree, branch, and freeing port ${port}`
		).pipe(Effect.annotateLogs("module", logPrefix));

		// 1. Remove the git worktree directory
		yield* Effect.tryPromise({
			try: async () => {
				const proc = Bun.spawn(
					["git", "worktree", "remove", "--force", worktreePath],
					{
						cwd: repoPath,
						stdout: "pipe",
						stderr: "pipe",
					}
				);
				const exitCode = await proc.exited;
				const stderr = await new Response(proc.stderr).text();
				return { exitCode, stderr };
			},
			catch: (error) =>
				new Error(`Failed to spawn git worktree remove: ${String(error)}`),
		}).pipe(
			Effect.tap(({ exitCode, stderr }) =>
				exitCode !== 0
					? Effect.logWarning(
							`Rollback: git worktree remove failed (exit ${exitCode}): ${stderr.trim()}`
						).pipe(Effect.annotateLogs("module", logPrefix))
					: Effect.logDebug("Rollback: worktree removed").pipe(
							Effect.annotateLogs("module", logPrefix)
						)
			),
			Effect.catchAll((error) =>
				Effect.logWarning(
					`Rollback: failed to remove worktree: ${String(error)}`
				).pipe(Effect.annotateLogs("module", logPrefix))
			)
		);

		// 2. Delete the branch
		yield* Effect.tryPromise({
			try: async () => {
				const proc = Bun.spawn(["git", "branch", "-D", branchName], {
					cwd: repoPath,
					stdout: "pipe",
					stderr: "pipe",
				});
				const exitCode = await proc.exited;
				const stderr = await new Response(proc.stderr).text();
				return { exitCode, stderr };
			},
			catch: (error) =>
				new Error(`Failed to spawn git branch -D: ${String(error)}`),
		}).pipe(
			Effect.tap(({ exitCode, stderr }) =>
				exitCode !== 0
					? Effect.logWarning(
							`Rollback: git branch -D failed (exit ${exitCode}): ${stderr.trim()}`
						).pipe(Effect.annotateLogs("module", logPrefix))
					: Effect.logDebug("Rollback: branch deleted").pipe(
							Effect.annotateLogs("module", logPrefix)
						)
			),
			Effect.catchAll((error) =>
				Effect.logWarning(
					`Rollback: failed to delete branch: ${String(error)}`
				).pipe(Effect.annotateLogs("module", logPrefix))
			)
		);

		// 3. Free the allocated port
		yield* portAllocator.free(port).pipe(
			Effect.tap(() =>
				Effect.logDebug(`Rollback: freed port ${port}`).pipe(
					Effect.annotateLogs("module", logPrefix)
				)
			),
			Effect.catchAll((error) =>
				Effect.logWarning(
					`Rollback: failed to free port ${port}: ${String(error)}`
				).pipe(Effect.annotateLogs("module", logPrefix))
			)
		);

		yield* Effect.logInfo(
			"Rollback complete: worktree, branch, and port cleaned up"
		).pipe(Effect.annotateLogs("module", logPrefix));
	});

class WorkspaceProvider extends Context.Tag("@laborer/WorkspaceProvider")<
	WorkspaceProvider,
	{
		/**
		 * Create a new git worktree for a project.
		 *
		 * 1. Validates the project exists
		 * 2. Generates a branch name if not provided
		 * 3. Allocates a port from the PortAllocator
		 * 4. Runs `git worktree add` to create the isolated directory
		 * 5. Commits WorkspaceCreated event to LiveStore
		 *
		 * @param projectId - ID of the registered project
		 * @param branchName - Optional branch name (auto-generated if omitted)
		 * @param taskId - Optional task ID to link workspace to a task
		 */
		readonly createWorktree: (
			projectId: string,
			branchName?: string,
			taskId?: string
		) => Effect.Effect<WorkspaceRecord, RpcError>;

		/**
		 * Destroy a workspace by removing its git worktree, deleting the branch,
		 * freeing the allocated port, and committing a WorkspaceDestroyed event
		 * to LiveStore.
		 *
		 * Steps:
		 * 1. Look up the workspace in LiveStore
		 * 2. Look up the project to get the repo path
		 * 3. Run `git worktree remove --force` to remove the worktree directory
		 * 4. Delete the branch via `git branch -D`
		 * 5. Free the allocated port via PortAllocator
		 * 6. Commit WorkspaceDestroyed event to LiveStore
		 *
		 * @param workspaceId - ID of the workspace to destroy
		 */
		readonly destroyWorktree: (
			workspaceId: string
		) => Effect.Effect<void, RpcError>;

		/**
		 * Get environment variables for a workspace.
		 *
		 * Returns a Record of env vars that should be injected into all
		 * processes running in the workspace (setup scripts, terminals,
		 * dev servers). Includes:
		 * - PORT: the allocated port for dev servers
		 * - LABORER_WORKSPACE_ID: the workspace ID
		 * - LABORER_WORKSPACE_PATH: the worktree directory path
		 * - LABORER_BRANCH: the workspace branch name
		 *
		 * @param workspaceId - ID of the workspace
		 */
		readonly getWorkspaceEnv: (
			workspaceId: string
		) => Effect.Effect<Record<string, string>, RpcError>;
	}
>() {
	static readonly layer = Layer.effect(
		WorkspaceProvider,
		Effect.gen(function* () {
			const { store } = yield* LaborerStore;
			const portAllocator = yield* PortAllocator;
			const registry = yield* ProjectRegistry;

			const createWorktree = Effect.fn("WorkspaceProvider.createWorktree")(
				function* (projectId: string, branchName?: string, taskId?: string) {
					// 1. Validate the project exists and get its repo path
					const project = yield* registry.getProject(projectId);

					// 2. Generate or validate branch name
					const resolvedBranch =
						branchName ?? `laborer/${crypto.randomUUID().slice(0, 8)}`;

					// 3. Check if a branch with this name already exists
					const branchExists = yield* Effect.tryPromise({
						try: async () => {
							const proc = Bun.spawn(
								["git", "rev-parse", "--verify", resolvedBranch],
								{
									cwd: project.repoPath,
									stdout: "pipe",
									stderr: "pipe",
								}
							);
							const exitCode = await proc.exited;
							return exitCode === 0;
						},
						catch: () =>
							new RpcError({
								message: `Failed to check branch existence: ${resolvedBranch}`,
								code: "GIT_CHECK_FAILED",
							}),
					});

					if (branchExists) {
						return yield* new RpcError({
							message: `Branch already exists: ${resolvedBranch}. Choose a different branch name.`,
							code: "BRANCH_EXISTS",
						});
					}

					// 4. Allocate a port for this workspace
					const port = yield* portAllocator.allocate();

					// 5. Compute worktree path
					const worktreeDir = resolve(project.repoPath, WORKTREE_DIR);
					const worktreePath = join(worktreeDir, slugify(resolvedBranch));

					// 6. Ensure the .worktrees directory exists
					yield* Effect.tryPromise({
						try: async () => {
							const proc = Bun.spawn(["mkdir", "-p", worktreeDir], {
								cwd: project.repoPath,
								stdout: "pipe",
								stderr: "pipe",
							});
							await proc.exited;
						},
						catch: () =>
							new RpcError({
								message: `Failed to create worktrees directory: ${worktreeDir}`,
								code: "FILESYSTEM_ERROR",
							}),
					});

					// 7. Create the git worktree with a new branch
					const worktreeResult = yield* Effect.tryPromise({
						try: async () => {
							const proc = Bun.spawn(
								["git", "worktree", "add", "-b", resolvedBranch, worktreePath],
								{
									cwd: project.repoPath,
									stdout: "pipe",
									stderr: "pipe",
								}
							);
							const exitCode = await proc.exited;
							const stderr = await new Response(proc.stderr).text();
							return { exitCode, stderr };
						},
						catch: (error) =>
							new RpcError({
								message: `Failed to spawn git worktree command: ${String(error)}`,
								code: "GIT_WORKTREE_FAILED",
							}),
					});

					if (worktreeResult.exitCode !== 0) {
						// Clean up: free the allocated port since worktree creation failed
						yield* portAllocator
							.free(port)
							.pipe(Effect.catchAll(() => Effect.void));

						return yield* new RpcError({
							message: `git worktree add failed (exit ${worktreeResult.exitCode}): ${worktreeResult.stderr.trim()}`,
							code: "GIT_WORKTREE_FAILED",
						});
					}

					// 7b. Capture the base SHA — the commit the worktree was branched from.
					// `git worktree add -b <branch> <path>` creates the new branch at HEAD of
					// the main repo, so `git rev-parse HEAD` in the project repo gives us the
					// exact commit the worktree diverged from. This is stored in LiveStore and
					// used by DiffService as the base for `git diff <baseSha>`.
					const baseSha = yield* Effect.tryPromise({
						try: async () => {
							const proc = Bun.spawn(["git", "rev-parse", "HEAD"], {
								cwd: project.repoPath,
								stdout: "pipe",
								stderr: "pipe",
							});
							const exitCode = await proc.exited;
							const stdout = await new Response(proc.stdout).text();
							if (exitCode === 0) {
								return stdout.trim();
							}
							return null;
						},
						catch: () =>
							new RpcError({
								message: "Failed to capture base SHA for worktree",
								code: "GIT_REV_PARSE_FAILED",
							}),
					});

					// 8. Verify the worktree was created
					const verifyResult = yield* Effect.tryPromise({
						try: async () => {
							const proc = Bun.spawn(
								["git", "rev-parse", "--is-inside-work-tree"],
								{
									cwd: worktreePath,
									stdout: "pipe",
									stderr: "pipe",
								}
							);
							const exitCode = await proc.exited;
							return exitCode === 0;
						},
						catch: () =>
							new RpcError({
								message: `Failed to verify worktree at: ${worktreePath}`,
								code: "WORKTREE_VERIFY_FAILED",
							}),
					});

					if (!verifyResult) {
						// Clean up: free port
						yield* portAllocator
							.free(port)
							.pipe(Effect.catchAll(() => Effect.void));

						return yield* new RpcError({
							message: `Worktree verification failed: ${worktreePath} is not a valid git working tree`,
							code: "WORKTREE_VERIFY_FAILED",
						});
					}

					// 9. Generate workspace ID early (needed for env var injection)
					const id = crypto.randomUUID();
					const createdAt = new Date().toISOString();

					// 10. Run setup scripts from .laborer.json (Issue #35, #37)
					// Scripts run in the worktree directory with workspace env vars
					// injected. If any script fails, the workspace is fully rolled
					// back: worktree removed, port freed, branch deleted.
					const scriptEnv = {
						PORT: String(port),
						LABORER_WORKSPACE_ID: id,
						LABORER_WORKSPACE_PATH: worktreePath,
						LABORER_BRANCH: resolvedBranch,
					};

					const setupResult = yield* runProjectSetupScripts(
						project.repoPath,
						worktreePath,
						scriptEnv
					);

					if (setupResult._tag === "Failure") {
						// Commit "errored" status briefly so the UI sees the failure
						// before rollback removes the workspace
						store.commit(
							events.workspaceCreated({
								id,
								projectId,
								taskSource: taskId ?? null,
								branchName: resolvedBranch,
								worktreePath,
								port,
								status: "errored",
								createdAt,
								baseSha,
							})
						);

						// Full rollback: remove worktree, delete branch, free port
						yield* rollbackWorktree(
							project.repoPath,
							worktreePath,
							resolvedBranch,
							port,
							portAllocator
						);

						// Remove the errored workspace from LiveStore after rollback
						store.commit(events.workspaceDestroyed({ id }));

						return yield* new RpcError({
							message: buildSetupFailureMessage(setupResult),
							code: "SETUP_SCRIPT_FAILED",
						});
					}

					// 11. Commit to LiveStore

					const workspace: WorkspaceRecord = {
						id,
						projectId,
						taskSource: taskId ?? null,
						branchName: resolvedBranch,
						worktreePath,
						port,
						status: "running",
						createdAt,
						baseSha,
					};

					store.commit(
						events.workspaceCreated({
							id: workspace.id,
							projectId: workspace.projectId,
							taskSource: workspace.taskSource,
							branchName: workspace.branchName,
							worktreePath: workspace.worktreePath,
							port: workspace.port,
							status: workspace.status,
							createdAt: workspace.createdAt,
							baseSha: workspace.baseSha,
						})
					);

					return workspace;
				}
			);

			const destroyWorktree = Effect.fn("WorkspaceProvider.destroyWorktree")(
				function* (workspaceId: string) {
					// 1. Look up the workspace in LiveStore
					const allWorkspaces = store.query(tables.workspaces);
					const workspaceOpt = pipe(
						allWorkspaces,
						Arr.findFirst((w) => w.id === workspaceId)
					);

					if (workspaceOpt._tag === "None") {
						return yield* new RpcError({
							message: `Workspace not found: ${workspaceId}`,
							code: "NOT_FOUND",
						});
					}

					const workspace = workspaceOpt.value;

					// 2. Look up the project to get the repo path for git commands
					const project = yield* registry.getProject(workspace.projectId);

					// 3. Update workspace status to "destroyed" in LiveStore first
					//    (so the UI reflects the state change even if cleanup takes time)
					store.commit(
						events.workspaceStatusChanged({
							id: workspaceId,
							status: "destroyed",
						})
					);

					// 4. Remove the git worktree using --force to handle dirty state
					const removeResult = yield* Effect.tryPromise({
						try: async () => {
							const proc = Bun.spawn(
								[
									"git",
									"worktree",
									"remove",
									"--force",
									workspace.worktreePath,
								],
								{
									cwd: project.repoPath,
									stdout: "pipe",
									stderr: "pipe",
								}
							);
							const exitCode = await proc.exited;
							const stderr = await new Response(proc.stderr).text();
							return { exitCode, stderr };
						},
						catch: (error) =>
							new RpcError({
								message: `Failed to spawn git worktree remove: ${String(error)}`,
								code: "GIT_WORKTREE_FAILED",
							}),
					});

					if (removeResult.exitCode !== 0) {
						// Log the error but continue cleanup — the worktree directory
						// may have been manually deleted already
						yield* Effect.logWarning(
							`git worktree remove failed (exit ${removeResult.exitCode}): ${removeResult.stderr.trim()}`
						);
					}

					// 5. Delete the branch via git branch -D
					const branchResult = yield* Effect.tryPromise({
						try: async () => {
							const proc = Bun.spawn(
								["git", "branch", "-D", workspace.branchName],
								{
									cwd: project.repoPath,
									stdout: "pipe",
									stderr: "pipe",
								}
							);
							const exitCode = await proc.exited;
							const stderr = await new Response(proc.stderr).text();
							return { exitCode, stderr };
						},
						catch: (error) =>
							new RpcError({
								message: `Failed to spawn git branch delete: ${String(error)}`,
								code: "GIT_BRANCH_DELETE_FAILED",
							}),
					});

					if (branchResult.exitCode !== 0) {
						// Log but continue — the branch may have been manually deleted
						yield* Effect.logWarning(
							`git branch -D failed (exit ${branchResult.exitCode}): ${branchResult.stderr.trim()}`
						);
					}

					// 6. Free the allocated port
					yield* portAllocator
						.free(workspace.port)
						.pipe(
							Effect.catchAll((err) =>
								Effect.logWarning(
									`Failed to free port ${workspace.port}: ${err.message}`
								)
							)
						);

					// 7. Commit WorkspaceDestroyed event to LiveStore
					//    This removes the row from the workspaces table
					store.commit(events.workspaceDestroyed({ id: workspaceId }));
				}
			);

			const getWorkspaceEnv = Effect.fn("WorkspaceProvider.getWorkspaceEnv")(
				function* (workspaceId: string) {
					// Look up the workspace from LiveStore
					const allWorkspaces = store.query(tables.workspaces);
					const workspace = pipe(
						allWorkspaces,
						Arr.findFirst((w) => w.id === workspaceId)
					);

					if (workspace._tag === "None") {
						return yield* new RpcError({
							message: `Workspace not found: ${workspaceId}`,
							code: "NOT_FOUND",
						});
					}

					const ws = workspace.value;

					// Build the environment variables for this workspace
					return {
						PORT: String(ws.port),
						LABORER_WORKSPACE_ID: ws.id,
						LABORER_WORKSPACE_PATH: ws.worktreePath,
						LABORER_BRANCH: ws.branchName,
					} as Record<string, string>;
				}
			);

			return WorkspaceProvider.of({
				createWorktree,
				destroyWorktree,
				getWorkspaceEnv,
			});
		})
	);
}

export { WorkspaceProvider };
