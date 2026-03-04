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
 * Issue #36: inject PORT env var
 * Issue #43: destroyWorktree method
 */

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

					// 9. Generate workspace ID and commit to LiveStore
					const id = crypto.randomUUID();
					const createdAt = new Date().toISOString();

					const workspace: WorkspaceRecord = {
						id,
						projectId,
						taskSource: taskId ?? null,
						branchName: resolvedBranch,
						worktreePath,
						port,
						status: "running",
						createdAt,
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
