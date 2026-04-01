/**
 * DiffService — Effect Service
 *
 * Monitors active workspaces for file changes by running `git diff`
 * in their worktree directories. Supports both on-demand diffing,
 * automatic polling on a configurable interval, and event-driven
 * invalidation from the RepositoryEventBus.
 *
 * Key design choices (performance):
 * - Polling is gated by panel visibility: only workspaces with an
 *   open panel are polled. Workspaces without a panel can still be
 *   diffed on-demand via `getDiff`.
 * - Merge-base resolution is cached per workspace and only recomputed
 *   when the workspace's baseSha changes or the cache is cleared.
 * - Event-driven refreshes are debounced at 1000ms (matching VS Code)
 *   with a 5s cooldown after each triggered refresh to prevent
 *   overwhelming git during heavy churn.
 * - In-flight `getDiff` calls are deduplicated per workspace: if a
 *   diff is already running, concurrent callers share the result.
 * - Git subprocesses use `-c core.fsmonitor=false` for consistent
 *   behavior with the rest of the repo-watching stack.
 *
 * Responsibilities:
 * - Run `git diff` in a workspace's worktree directory
 * - Run `git diff --staged` to include staged changes
 * - Return raw diff output string
 * - Commit DiffUpdated events to LiveStore
 * - Poll on interval (default 5s) for visible workspaces
 * - Start/stop polling per workspace
 * - Subscribe to RepositoryEventBus for event-driven diff refresh
 *   when file changes are detected, reducing latency vs pure polling
 *
 * Usage:
 * ```ts
 * const program = Effect.gen(function* () {
 *   const diffService = yield* DiffService
 *   const result = yield* diffService.getDiff("workspace-id")
 *   // result.diffContent === "diff --git a/file.ts ..."
 *
 *   // Start polling every 5 seconds (only if workspace has open panel)
 *   yield* diffService.startPolling("workspace-id")
 *
 *   // Stop polling when workspace is destroyed
 *   yield* diffService.stopPolling("workspace-id")
 * })
 * ```
 */

import { RpcError, type WatchFileEvent } from '@laborer/shared/rpc'
import { events, tables } from '@laborer/shared/schema'
import {
  Array as Arr,
  Context,
  Duration,
  Effect,
  Fiber,
  Layer,
  pipe,
  Ref,
  Runtime,
  Schedule,
} from 'effect'
import { spawn } from '../lib/spawn.js'
import { FileWatcherClient } from './file-watcher-client.js'
import { LaborerStore } from './laborer-store.js'
import {
  DIFF_EVENT_COOLDOWN_MS,
  DIFF_EVENT_DEBOUNCE_MS,
  DIFF_POLL_INTERVAL_MS,
} from './polling-intervals.js'
import { withFsmonitorDisabled } from './repo-watching-git.js'
import { getVisibleWorkspaceIds } from './visible-workspaces.js'

/**
 * Shape of a diff result returned by the service.
 * Matches the LiveStore diffs table columns and the DiffResponse RPC schema.
 */
interface DiffResult {
  readonly diffContent: string
  readonly lastUpdated: string
  readonly workspaceId: string
}

/**
 * Helper: spawn a git command in a worktree and capture stdout/stderr.
 * Uses `-c core.fsmonitor=false` for consistent behavior with the
 * rest of the repo-watching stack.
 */
const spawnGit = async (
  args: readonly string[],
  cwd: string
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const proc = spawn(['git', ...withFsmonitorDisabled(args)], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const exitCode = await proc.exited
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  return { exitCode, stdout, stderr }
}

class DiffService extends Context.Tag('@laborer/DiffService')<
  DiffService,
  {
    /**
     * Get the current git diff for a workspace.
     *
     * Runs `git diff` in the workspace's worktree directory.
     * Only commits a DiffUpdated event to LiveStore when the diff
     * content has changed compared to the previous call (Issue #84).
     *
     * If a getDiff call is already in-flight for this workspace,
     * the caller shares the existing result (deduplication).
     *
     * @param workspaceId - ID of the workspace to diff
     * @returns DiffResult with the combined diff content and timestamp
     */
    readonly getDiff: (
      workspaceId: string
    ) => Effect.Effect<DiffResult, RpcError>

    /**
     * Start polling git diff for a workspace on an interval.
     *
     * Runs `getDiff` every `intervalMs` milliseconds (default 5000ms).
     * Polling is gated by panel visibility: on each tick, the service
     * checks if the workspace has an open panel. If not, the poll is
     * skipped (the workspace's diff can still be fetched on-demand).
     *
     * Calling `startPolling` on a workspace that is already being polled
     * is a no-op.
     *
     * @param workspaceId - ID of the workspace to poll
     * @param intervalMs - Polling interval in milliseconds (default 5000)
     */
    readonly startPolling: (
      workspaceId: string,
      intervalMs?: number
    ) => Effect.Effect<void>

    /**
     * Stop polling git diff for a workspace.
     *
     * Interrupts the polling fiber and removes it from the active
     * polling map. If the workspace is not being polled, this is a no-op.
     *
     * @param workspaceId - ID of the workspace to stop polling
     */
    readonly stopPolling: (workspaceId: string) => Effect.Effect<void>

    /**
     * Stop polling for all workspaces.
     *
     * Interrupts all active polling fibers and clears the polling map.
     * Used during graceful shutdown.
     */
    readonly stopAllPolling: () => Effect.Effect<void>

    /**
     * Check if a workspace is currently being polled.
     *
     * @param workspaceId - ID of the workspace to check
     * @returns true if polling is active for this workspace
     */
    readonly isPolling: (workspaceId: string) => Effect.Effect<boolean>
  }
>() {
  static readonly layer = Layer.scoped(
    DiffService,
    Effect.gen(function* () {
      const { store } = yield* LaborerStore
      const fileWatcherClient = yield* FileWatcherClient
      const runtime = yield* Effect.runtime<never>()
      const runPromise = Runtime.runPromise(runtime)

      // Track active polling fibers per workspace.
      const pollingFibers = yield* Ref.make<
        Map<string, Fiber.RuntimeFiber<void, never>>
      >(new Map())

      // Cache of previous diff content per workspace for deduplication (Issue #84).
      const previousDiffs = yield* Ref.make<Map<string, string>>(new Map())

      // ── Merge-base cache ───────────────────────────────────
      // Cache resolved merge-base per workspace to avoid spawning
      // up to 12 git subprocesses on every poll cycle.
      const mergeBaseCache = yield* Ref.make<Map<string, string | undefined>>(
        new Map()
      )

      // Track the baseSha that was used to compute the cached merge-base.
      const mergeBaseShaSnapshot = yield* Ref.make<
        Map<string, string | undefined | null>
      >(new Map())

      // ── In-flight deduplication ────────────────────────────
      // If getDiff is already running for a workspace, concurrent
      // callers share the same Promise (VS Code @throttle pattern).
      const inFlightDiffs = new Map<string, Promise<DiffResult>>()

      // Resolve the merge-base commit for diffing (cached).
      const resolveMergeBase = Effect.fn('DiffService.resolveMergeBase')(
        function* (
          workspaceId: string,
          baseSha: string | undefined | null,
          worktreePath: string
        ) {
          // Check cache: if baseSha hasn't changed, reuse cached result
          const cachedSha = yield* Ref.get(mergeBaseShaSnapshot)
          const previousBaseSha = cachedSha.get(workspaceId)
          if (previousBaseSha === baseSha) {
            const cached = yield* Ref.get(mergeBaseCache)
            if (cached.has(workspaceId)) {
              const cachedResult = cached.get(workspaceId)
              yield* Effect.logDebug(
                `[DiffService.resolveMergeBase] workspace=${workspaceId} using cached mergeBase=${cachedResult?.slice(0, 8) ?? 'undefined'}`
              )
              return cachedResult
            }
          }

          // Cache miss or baseSha changed — recompute
          if (baseSha) {
            yield* Effect.logDebug(
              `[DiffService.resolveMergeBase] using provided baseSha=${baseSha.slice(0, 8)}`
            )
            yield* Ref.update(mergeBaseCache, (cache) => {
              const next = new Map(cache)
              next.set(workspaceId, baseSha)
              return next
            })
            yield* Ref.update(mergeBaseShaSnapshot, (cache) => {
              const next = new Map(cache)
              next.set(workspaceId, baseSha)
              return next
            })
            return baseSha
          }

          yield* Effect.logDebug(
            '[DiffService.resolveMergeBase] no baseSha provided, trying merge-base candidates'
          )

          const result = yield* Effect.tryPromise({
            try: async () => {
              for (const candidate of [
                'main',
                'master',
                'develop',
                'origin/main',
                'origin/master',
              ]) {
                const res = await spawnGit(
                  ['merge-base', candidate, 'HEAD'],
                  worktreePath
                )
                if (res.exitCode === 0) {
                  return res.stdout.trim()
                }
              }
              return undefined
            },
            catch: () =>
              new RpcError({
                message: 'Failed to compute merge-base',
                code: 'GIT_DIFF_FAILED',
              }),
          })

          // Cache the result
          yield* Ref.update(mergeBaseCache, (cache) => {
            const next = new Map(cache)
            next.set(workspaceId, result)
            return next
          })
          yield* Ref.update(mergeBaseShaSnapshot, (cache) => {
            const next = new Map(cache)
            next.set(workspaceId, baseSha)
            return next
          })

          return result
        }
      )

      // Compute the diff using unstaged + staged as a fallback.
      const computeFallbackDiff = Effect.fn('DiffService.computeFallbackDiff')(
        function* (workspaceId: string, worktreePath: string) {
          yield* Effect.logDebug(
            `[DiffService] workspace=${workspaceId} no merge-base found, falling back to unstaged+staged diff`
          )

          const unstagedResult = yield* Effect.tryPromise({
            try: () => spawnGit(['diff'], worktreePath),
            catch: (error) =>
              new RpcError({
                message: `Failed to spawn git diff: ${String(error)}`,
                code: 'GIT_DIFF_FAILED',
              }),
          })

          if (unstagedResult.exitCode !== 0) {
            return yield* new RpcError({
              message: `git diff failed (exit ${unstagedResult.exitCode}): ${unstagedResult.stderr.trim()}`,
              code: 'GIT_DIFF_FAILED',
            })
          }

          const stagedResult = yield* Effect.tryPromise({
            try: () => spawnGit(['diff', '--staged'], worktreePath),
            catch: (error) =>
              new RpcError({
                message: `Failed to spawn git diff --staged: ${String(error)}`,
                code: 'GIT_DIFF_FAILED',
              }),
          })

          if (stagedResult.exitCode !== 0) {
            return yield* new RpcError({
              message: `git diff --staged failed (exit ${stagedResult.exitCode}): ${stagedResult.stderr.trim()}`,
              code: 'GIT_DIFF_FAILED',
            })
          }

          const combinedDiff = [unstagedResult.stdout, stagedResult.stdout]
            .filter((s) => s.length > 0)
            .join('\n')

          return combinedDiff
        }
      )

      /** Internal getDiff (no deduplication). */
      const getDiffInternal = Effect.fn('DiffService.getDiffInternal')(
        function* (workspaceId: string) {
          // 1. Look up the workspace in LiveStore
          const workspaceOpt = pipe(
            store.query(tables.workspaces),
            Arr.findFirst((w) => w.id === workspaceId)
          )

          if (workspaceOpt._tag === 'None') {
            yield* Effect.logWarning(
              `[DiffService.getDiff] workspace=${workspaceId} NOT FOUND`
            )
            return yield* new RpcError({
              message: `Workspace not found: ${workspaceId}`,
              code: 'NOT_FOUND',
            })
          }

          const workspace = workspaceOpt.value

          // 2. Validate workspace is not destroyed
          if (workspace.status === 'destroyed') {
            return yield* new RpcError({
              message: `Workspace ${workspaceId} has been destroyed`,
              code: 'INVALID_STATE',
            })
          }

          // 3. Determine the base commit to diff against (cached).
          const baseSha = workspace.baseSha
          const mergeBase = yield* resolveMergeBase(
            workspaceId,
            baseSha,
            workspace.worktreePath
          )

          let combinedDiff: string

          if (mergeBase) {
            // 4a. Diff the working tree against the merge-base.
            const fullDiffResult = yield* Effect.tryPromise({
              try: () => spawnGit(['diff', mergeBase], workspace.worktreePath),
              catch: (error) =>
                new RpcError({
                  message: `Failed to spawn git diff ${mergeBase}: ${String(error)}`,
                  code: 'GIT_DIFF_FAILED',
                }),
            })

            if (fullDiffResult.exitCode !== 0) {
              return yield* new RpcError({
                message: `git diff ${mergeBase} failed (exit ${fullDiffResult.exitCode}): ${fullDiffResult.stderr.trim()}`,
                code: 'GIT_DIFF_FAILED',
              })
            }

            combinedDiff = fullDiffResult.stdout
          } else {
            combinedDiff = yield* computeFallbackDiff(
              workspaceId,
              workspace.worktreePath
            )
          }

          const lastUpdated = new Date().toISOString()

          // 5. Deduplicate: only commit DiffUpdated if content changed
          const previousContent = yield* Ref.modify(previousDiffs, (cache) => {
            const prev = cache.get(workspaceId)
            const next = new Map(cache)
            next.set(workspaceId, combinedDiff)
            return [prev, next] as const
          })

          if (previousContent !== combinedDiff) {
            yield* Effect.log(
              `[DiffService.getDiff] workspace=${workspaceId} COMMITTING DiffUpdated (diffLen=${combinedDiff.length}, previousLen=${previousContent?.length ?? 'none'})`
            )
            store.commit(
              events.diffUpdated({
                workspaceId,
                diffContent: combinedDiff,
                lastUpdated,
              })
            )
          }

          return {
            workspaceId,
            diffContent: combinedDiff,
            lastUpdated,
          } satisfies DiffResult
        }
      )

      /**
       * Public getDiff with in-flight deduplication.
       *
       * If a getDiff call is already running for this workspace,
       * the caller shares the existing Promise. This prevents the
       * polling fiber and event-driven refresh from racing and
       * spawning duplicate git processes.
       */
      const getDiff = Effect.fn('DiffService.getDiff')(function* (
        workspaceId: string
      ) {
        const existing = inFlightDiffs.get(workspaceId)
        if (existing !== undefined) {
          yield* Effect.logDebug(
            `[DiffService.getDiff] workspace=${workspaceId} joining in-flight diff`
          )
          return yield* Effect.tryPromise({
            try: () => existing,
            catch: (error) =>
              new RpcError({
                message: `In-flight diff failed: ${String(error)}`,
                code: 'GIT_DIFF_FAILED',
              }),
          })
        }

        const promise = runPromise(getDiffInternal(workspaceId))
        inFlightDiffs.set(workspaceId, promise)

        try {
          return yield* Effect.tryPromise({
            try: () => promise,
            catch: (error) =>
              new RpcError({
                message: `getDiff failed: ${String(error)}`,
                code: 'GIT_DIFF_FAILED',
              }),
          })
        } finally {
          inFlightDiffs.delete(workspaceId)
        }
      })

      const startPolling = Effect.fn('DiffService.startPolling')(function* (
        workspaceId: string,
        intervalMs?: number
      ) {
        const currentFibers = yield* Ref.get(pollingFibers)
        if (currentFibers.has(workspaceId)) {
          return
        }

        const interval = intervalMs ?? DIFF_POLL_INTERVAL_MS

        yield* Effect.log(
          `[DiffService.startPolling] workspace=${workspaceId} starting polling fiber (interval=${interval}ms)`
        )

        // Each tick checks panel visibility — if the workspace has no
        // open panel, the poll is skipped.
        let pollCount = 0
        const pollEffect = Effect.gen(function* () {
          pollCount += 1

          const visibleWorkspaces = getVisibleWorkspaceIds(store)
          if (!visibleWorkspaces.has(workspaceId)) {
            yield* Effect.logDebug(
              `[DiffService.poll] workspace=${workspaceId} poll #${pollCount} SKIPPED — no open panel`
            )
            return
          }

          yield* getDiff(workspaceId)
        }).pipe(
          Effect.catchAll((error) =>
            Effect.logWarning(
              `[DiffService.poll] workspace=${workspaceId} poll #${pollCount} ERROR: ${error.message} (code=${error.code})`
            )
          ),
          Effect.repeat(Schedule.spaced(Duration.millis(interval))),
          Effect.asVoid
        )

        const fiber = yield* Effect.forkDaemon(pollEffect)

        yield* Ref.update(pollingFibers, (fibers) => {
          const next = new Map(fibers)
          next.set(workspaceId, fiber)
          return next
        })

        yield* Effect.log(
          `[DiffService.startPolling] workspace=${workspaceId} polling STARTED every ${interval}ms`
        )
      })

      const stopPolling = Effect.fn('DiffService.stopPolling')(function* (
        workspaceId: string
      ) {
        const fiber = yield* Ref.modify(pollingFibers, (fibers) => {
          const existing = fibers.get(workspaceId)
          if (existing === undefined) {
            return [undefined, fibers] as const
          }
          const next = new Map(fibers)
          next.delete(workspaceId)
          return [existing, next] as const
        })

        if (fiber === undefined) {
          return
        }

        yield* Fiber.interrupt(fiber)

        // Clear caches for this workspace
        yield* Ref.update(previousDiffs, (cache) => {
          const next = new Map(cache)
          next.delete(workspaceId)
          return next
        })
        yield* Ref.update(mergeBaseCache, (cache) => {
          const next = new Map(cache)
          next.delete(workspaceId)
          return next
        })
        yield* Ref.update(mergeBaseShaSnapshot, (cache) => {
          const next = new Map(cache)
          next.delete(workspaceId)
          return next
        })

        yield* Effect.log(
          `[DiffService.stopPolling] workspace=${workspaceId} polling STOPPED`
        )
      })

      const stopAllPolling = Effect.fn('DiffService.stopAllPolling')(
        function* () {
          const fibers = yield* Ref.getAndSet(pollingFibers, new Map())

          yield* Effect.forEach(
            [...fibers.values()],
            (fiber) => Fiber.interrupt(fiber),
            { discard: true }
          )

          yield* Ref.set(previousDiffs, new Map())
          yield* Ref.set(mergeBaseCache, new Map())
          yield* Ref.set(mergeBaseShaSnapshot, new Map())

          yield* Effect.log(
            `DiffService: stopped all polling (${fibers.size} workspaces)`
          )
        }
      )

      const isPolling = Effect.fn('DiffService.isPolling')(function* (
        workspaceId: string
      ) {
        const currentFibers = yield* Ref.get(pollingFibers)
        return currentFibers.has(workspaceId)
      })

      // ── Event-driven diff invalidation ─────────────────────
      //
      // VS Code approach: 1000ms debounce + 5s cooldown.
      // Only refreshes visible workspaces.

      const eventDebounceTimers = new Map<
        string,
        ReturnType<typeof setTimeout>
      >()

      let lastEventRefreshAt = 0

      const handleFileEvent = (event: WatchFileEvent): void => {
        const existing = eventDebounceTimers.get(event.subscriptionId)
        if (existing !== undefined) {
          clearTimeout(existing)
        }

        eventDebounceTimers.set(
          event.subscriptionId,
          setTimeout(() => {
            eventDebounceTimers.delete(event.subscriptionId)

            // Enforce cooldown
            const now = Date.now()
            if (now - lastEventRefreshAt < DIFF_EVENT_COOLDOWN_MS) {
              return
            }

            refreshVisiblePolledDiffs()
          }, DIFF_EVENT_DEBOUNCE_MS)
        )
      }

      const refreshVisiblePolledDiffs = (): void => {
        const visibleWorkspaces = getVisibleWorkspaceIds(store)

        runPromise(Ref.get(pollingFibers))
          .then((fibers) => {
            const targetIds = [...fibers.keys()].filter((id) =>
              visibleWorkspaces.has(id)
            )

            if (targetIds.length === 0) {
              return
            }

            runPromise(
              Effect.log(
                `[DiffService.refreshVisiblePolledDiffs] triggering refresh for ${targetIds.length} visible workspace(s): ${targetIds.map((id) => id.slice(0, 8)).join(', ')}`
              )
            ).catch(() => undefined)

            const promises: Promise<unknown>[] = []
            for (const workspaceId of targetIds) {
              promises.push(
                runPromise(
                  getDiff(workspaceId).pipe(
                    Effect.catchAll((error) =>
                      Effect.logWarning(
                        `[DiffService.refreshVisiblePolledDiffs] workspace=${workspaceId} ERROR: ${error.message}`
                      )
                    )
                  )
                ).catch(() => undefined)
              )
            }

            Promise.all(promises)
              .then(() => {
                lastEventRefreshAt = Date.now()
              })
              .catch(() => undefined)
          })
          .catch(() => undefined)
      }

      const subscription = fileWatcherClient.onFileEvent(handleFileEvent)

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          subscription.unsubscribe()
          for (const timer of eventDebounceTimers.values()) {
            clearTimeout(timer)
          }
          eventDebounceTimers.clear()
        })
      )

      // ── Bootstrap polling ──────────────────────────────────
      const bootstrapPolling = Effect.fn('DiffService.bootstrapPolling')(
        function* () {
          const allWorkspaces = store.query(tables.workspaces)
          const activeWorkspaces = allWorkspaces.filter(
            (w) => w.status !== 'destroyed'
          )

          yield* Effect.log(
            `[DiffService.bootstrapPolling] found ${allWorkspaces.length} total workspaces, ${activeWorkspaces.length} active. Active: ${activeWorkspaces.map((w) => `${w.id.slice(0, 8)}(${w.status}/${w.branchName})`).join(', ') || 'none'}`
          )

          yield* Effect.forEach(
            activeWorkspaces,
            (workspace) => startPolling(workspace.id),
            { discard: true }
          )
        }
      )

      yield* bootstrapPolling()
      yield* Effect.addFinalizer(() => stopAllPolling())

      return DiffService.of({
        getDiff,
        startPolling,
        stopPolling,
        stopAllPolling,
        isPolling,
      })
    })
  )
}

export { DiffService }
