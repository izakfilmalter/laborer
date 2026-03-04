/**
 * DiffService — Effect Service
 *
 * Monitors active workspaces for file changes by running `git diff`
 * in their worktree directories. Supports both on-demand diffing and
 * automatic polling on a configurable interval.
 *
 * Responsibilities:
 * - Run `git diff` in a workspace's worktree directory
 * - Run `git diff --staged` to include staged changes
 * - Return raw diff output string
 * - Commit DiffUpdated events to LiveStore
 * - Poll on interval (default 2s) for active workspaces
 * - Start/stop polling per workspace
 *
 * Usage:
 * ```ts
 * const program = Effect.gen(function* () {
 *   const diffService = yield* DiffService
 *   const result = yield* diffService.getDiff("workspace-id")
 *   // result.diffContent === "diff --git a/file.ts ..."
 *
 *   // Start polling every 2 seconds
 *   yield* diffService.startPolling("workspace-id")
 *
 *   // Stop polling when workspace is destroyed
 *   yield* diffService.stopPolling("workspace-id")
 * })
 * ```
 *
 * Issue #82: getDiff method — run `git diff` for a workspace
 * Issue #83: startPolling/stopPolling — poll on interval
 */

import { RpcError } from "@laborer/shared/rpc";
import { events, tables } from "@laborer/shared/schema";
import {
	Array as Arr,
	Context,
	Duration,
	Effect,
	Fiber,
	Layer,
	pipe,
	Ref,
	Schedule,
} from "effect";
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

/**
 * Default polling interval in milliseconds.
 * The PRD specifies 1-2 seconds; we default to 2 seconds.
 */
const DEFAULT_POLL_INTERVAL_MS = 2000;

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

		/**
		 * Start polling git diff for a workspace on an interval.
		 *
		 * Runs `getDiff` every `intervalMs` milliseconds (default 2000ms).
		 * The polling fiber runs in the background and commits DiffUpdated
		 * events to LiveStore on each poll. Errors during individual polls
		 * are logged but do not stop the polling loop.
		 *
		 * Calling `startPolling` on a workspace that is already being polled
		 * is a no-op.
		 *
		 * @param workspaceId - ID of the workspace to poll
		 * @param intervalMs - Polling interval in milliseconds (default 2000)
		 */
		readonly startPolling: (
			workspaceId: string,
			intervalMs?: number
		) => Effect.Effect<void>;

		/**
		 * Stop polling git diff for a workspace.
		 *
		 * Interrupts the polling fiber and removes it from the active
		 * polling map. If the workspace is not being polled, this is a no-op.
		 *
		 * @param workspaceId - ID of the workspace to stop polling
		 */
		readonly stopPolling: (workspaceId: string) => Effect.Effect<void>;

		/**
		 * Stop polling for all workspaces.
		 *
		 * Interrupts all active polling fibers and clears the polling map.
		 * Used during graceful shutdown.
		 */
		readonly stopAllPolling: () => Effect.Effect<void>;

		/**
		 * Check if a workspace is currently being polled.
		 *
		 * @param workspaceId - ID of the workspace to check
		 * @returns true if polling is active for this workspace
		 */
		readonly isPolling: (workspaceId: string) => Effect.Effect<boolean>;
	}
>() {
	static readonly layer = Layer.effect(
		DiffService,
		Effect.gen(function* () {
			const { store } = yield* LaborerStore;

			// Track active polling fibers per workspace.
			// Uses Ref for fiber-safe concurrent access.
			const pollingFibers = yield* Ref.make<
				Map<string, Fiber.RuntimeFiber<void, never>>
			>(new Map());

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

			const startPolling = Effect.fn("DiffService.startPolling")(function* (
				workspaceId: string,
				intervalMs?: number
			) {
				// Check if already polling this workspace
				const currentFibers = yield* Ref.get(pollingFibers);
				if (currentFibers.has(workspaceId)) {
					// Already polling — no-op
					return;
				}

				const interval = intervalMs ?? DEFAULT_POLL_INTERVAL_MS;

				// Create a polling effect that runs getDiff on a schedule.
				// Errors during individual polls are logged but do not stop the loop.
				const pollEffect = getDiff(workspaceId).pipe(
					Effect.catchAll((error) =>
						Effect.logWarning(
							`DiffService polling error for workspace ${workspaceId}: ${error.message}`
						)
					),
					Effect.repeat(Schedule.spaced(Duration.millis(interval))),
					Effect.asVoid
				);

				// Fork the polling as a daemon fiber so it runs in the background
				const fiber = yield* Effect.forkDaemon(pollEffect);

				// Track the fiber
				yield* Ref.update(pollingFibers, (fibers) => {
					const next = new Map(fibers);
					next.set(workspaceId, fiber);
					return next;
				});

				yield* Effect.log(
					`DiffService: started polling for workspace ${workspaceId} every ${interval}ms`
				);
			});

			const stopPolling = Effect.fn("DiffService.stopPolling")(function* (
				workspaceId: string
			) {
				// Atomically remove the fiber from the map
				const fiber = yield* Ref.modify(pollingFibers, (fibers) => {
					const existing = fibers.get(workspaceId);
					if (existing === undefined) {
						return [undefined, fibers] as const;
					}
					const next = new Map(fibers);
					next.delete(workspaceId);
					return [existing, next] as const;
				});

				if (fiber === undefined) {
					// Not polling — no-op
					return;
				}

				// Interrupt the polling fiber
				yield* Fiber.interrupt(fiber);

				yield* Effect.log(
					`DiffService: stopped polling for workspace ${workspaceId}`
				);
			});

			const stopAllPolling = Effect.fn("DiffService.stopAllPolling")(
				function* () {
					const fibers = yield* Ref.getAndSet(pollingFibers, new Map());

					yield* Effect.forEach(
						[...fibers.values()],
						(fiber) => Fiber.interrupt(fiber),
						{ discard: true }
					);

					yield* Effect.log(
						`DiffService: stopped all polling (${fibers.size} workspaces)`
					);
				}
			);

			const isPolling = Effect.fn("DiffService.isPolling")(function* (
				workspaceId: string
			) {
				const currentFibers = yield* Ref.get(pollingFibers);
				return currentFibers.has(workspaceId);
			});

			return DiffService.of({
				getDiff,
				startPolling,
				stopPolling,
				stopAllPolling,
				isPolling,
			});
		})
	);
}

export { DiffService };
