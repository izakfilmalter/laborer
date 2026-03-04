/**
 * DiffService — Effect Service
 *
 * Monitors active workspaces for file changes by running `git diff`
 * in their worktree directories. V1 uses a simple on-demand approach
 * where `getDiff` returns the current diff output for a workspace.
 * Future issues (#83-#85) will add polling on an interval, deduplication,
 * and automatic start/stop tied to workspace lifecycle.
 *
 * Responsibilities:
 * - Run `git diff` in a workspace's worktree directory
 * - Run `git diff --staged` to include staged changes
 * - Return raw diff output string
 * - Commit DiffUpdated events to LiveStore
 *
 * Usage:
 * ```ts
 * const program = Effect.gen(function* () {
 *   const diffService = yield* DiffService
 *   const result = yield* diffService.getDiff("workspace-id")
 *   // result.diffContent === "diff --git a/file.ts ..."
 * })
 * ```
 *
 * Issue #82: getDiff method — run `git diff` for a workspace
 */

import { RpcError } from "@laborer/shared/rpc";
import { events, tables } from "@laborer/shared/schema";
import { Array as Arr, Context, Effect, Layer, pipe } from "effect";
import { LaborerStore } from "./laborer-store.js";

/**
 * Shape of a diff result returned by the service.
 * Matches the LiveStore diffs table columns and the DiffResponse RPC schema.
 */
interface DiffResult {
	readonly diffContent: string;
	readonly lastUpdated: string;
	readonly workspaceId: string;
}

class DiffService extends Context.Tag("@laborer/DiffService")<
	DiffService,
	{
		/**
		 * Get the current git diff for a workspace.
		 *
		 * Runs `git diff` (unstaged) and `git diff --staged` (staged)
		 * in the workspace's worktree directory and combines the output.
		 * Commits a DiffUpdated event to LiveStore with the result.
		 *
		 * @param workspaceId - ID of the workspace to diff
		 * @returns DiffResult with the combined diff content and timestamp
		 */
		readonly getDiff: (
			workspaceId: string
		) => Effect.Effect<DiffResult, RpcError>;
	}
>() {
	static readonly layer = Layer.effect(
		DiffService,
		Effect.gen(function* () {
			const { store } = yield* LaborerStore;

			const getDiff = Effect.fn("DiffService.getDiff")(function* (
				workspaceId: string
			) {
				// 1. Look up the workspace in LiveStore to get the worktree path
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

				// 2. Validate workspace is in an active state
				if (workspace.status !== "running" && workspace.status !== "creating") {
					return yield* new RpcError({
						message: `Workspace ${workspaceId} is in "${workspace.status}" state and cannot be diffed`,
						code: "INVALID_STATE",
					});
				}

				// 3. Run `git diff` for unstaged changes
				const unstagedResult = yield* Effect.tryPromise({
					try: async () => {
						const proc = Bun.spawn(["git", "diff"], {
							cwd: workspace.worktreePath,
							stdout: "pipe",
							stderr: "pipe",
						});
						const exitCode = await proc.exited;
						const stdout = await new Response(proc.stdout).text();
						const stderr = await new Response(proc.stderr).text();
						return { exitCode, stdout, stderr };
					},
					catch: (error) =>
						new RpcError({
							message: `Failed to spawn git diff: ${String(error)}`,
							code: "GIT_DIFF_FAILED",
						}),
				});

				if (unstagedResult.exitCode !== 0) {
					return yield* new RpcError({
						message: `git diff failed (exit ${unstagedResult.exitCode}): ${unstagedResult.stderr.trim()}`,
						code: "GIT_DIFF_FAILED",
					});
				}

				// 4. Run `git diff --staged` for staged changes
				const stagedResult = yield* Effect.tryPromise({
					try: async () => {
						const proc = Bun.spawn(["git", "diff", "--staged"], {
							cwd: workspace.worktreePath,
							stdout: "pipe",
							stderr: "pipe",
						});
						const exitCode = await proc.exited;
						const stdout = await new Response(proc.stdout).text();
						const stderr = await new Response(proc.stderr).text();
						return { exitCode, stdout, stderr };
					},
					catch: (error) =>
						new RpcError({
							message: `Failed to spawn git diff --staged: ${String(error)}`,
							code: "GIT_DIFF_FAILED",
						}),
				});

				if (stagedResult.exitCode !== 0) {
					return yield* new RpcError({
						message: `git diff --staged failed (exit ${stagedResult.exitCode}): ${stagedResult.stderr.trim()}`,
						code: "GIT_DIFF_FAILED",
					});
				}

				// 5. Combine unstaged + staged diff output
				const combinedDiff = [unstagedResult.stdout, stagedResult.stdout]
					.filter((s) => s.length > 0)
					.join("\n");

				const lastUpdated = new Date().toISOString();

				// 6. Commit DiffUpdated event to LiveStore
				store.commit(
					events.diffUpdated({
						workspaceId,
						diffContent: combinedDiff,
						lastUpdated,
					})
				);

				return {
					workspaceId,
					diffContent: combinedDiff,
					lastUpdated,
				} satisfies DiffResult;
			});

			return DiffService.of({
				getDiff,
			});
		})
	);
}

export { DiffService };
