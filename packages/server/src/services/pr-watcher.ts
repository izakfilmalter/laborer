/**
 * PrWatcher — Effect Service
 *
 * Monitors active workspaces for associated pull requests by running
 * `gh pr view` in their worktree directories. Uses the `gh` CLI so
 * authentication is handled by the user's existing GitHub login
 * (no API tokens needed in the app).
 *
 * Responsibilities:
 * - Run `gh pr view --json number,url,title,state` in a workspace's worktree
 * - Commit WorkspacePrUpdated events to LiveStore when PR state changes
 * - Poll on interval (default 60s) for active workspaces
 * - Start/stop polling per workspace
 * - Deduplicate unchanged PR state to avoid unnecessary LiveStore events
 *
 * Modeled after DiffService's polling architecture with daemon fibers
 * per workspace, Ref-based fiber tracking, and Effect.addFinalizer
 * for cleanup.
 */

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
  Schedule,
} from 'effect'
import { spawn } from '../lib/spawn.js'
import { LaborerStore } from './laborer-store.js'

/**
 * Shape of PR data returned by `gh pr view --json ...`.
 * All fields are nullable because the branch may not have a PR.
 */
interface PrData {
  readonly number: number | null
  readonly state: string | null
  readonly title: string | null
  readonly url: string | null
}

/** Serialized PR state for deduplication. */
const serializePrData = (data: PrData): string =>
  JSON.stringify([data.number, data.url, data.title, data.state])

/** Empty PR data (no PR found). */
const EMPTY_PR: PrData = {
  number: null,
  url: null,
  title: null,
  state: null,
}

/**
 * Default polling interval in milliseconds.
 * PR state changes infrequently so 60 seconds is sufficient.
 */
const DEFAULT_POLL_INTERVAL_MS = 60_000

class PrWatcher extends Context.Tag('@laborer/PrWatcher')<
  PrWatcher,
  {
    /**
     * Check the current PR status for a workspace.
     *
     * Runs `gh pr view` in the workspace's worktree directory.
     * Commits a WorkspacePrUpdated event if the PR state has changed.
     *
     * @param workspaceId - ID of the workspace to check
     */
    readonly checkPr: (workspaceId: string) => Effect.Effect<PrData>

    /**
     * Start polling PR status for a workspace on an interval.
     *
     * Runs `checkPr` every `intervalMs` milliseconds (default 60000).
     * Calling on an already-polled workspace is a no-op.
     *
     * @param workspaceId - ID of the workspace to poll
     * @param intervalMs - Polling interval in milliseconds (default 60000)
     */
    readonly startPolling: (
      workspaceId: string,
      intervalMs?: number
    ) => Effect.Effect<void>

    /**
     * Stop polling PR status for a workspace.
     *
     * Interrupts the polling fiber. If not polling, this is a no-op.
     *
     * @param workspaceId - ID of the workspace to stop polling
     */
    readonly stopPolling: (workspaceId: string) => Effect.Effect<void>

    /**
     * Stop polling for all workspaces.
     *
     * Used during graceful shutdown.
     */
    readonly stopAllPolling: () => Effect.Effect<void>

    /**
     * Check if a workspace is currently being polled.
     *
     * @param workspaceId - ID of the workspace to check
     */
    readonly isPolling: (workspaceId: string) => Effect.Effect<boolean>
  }
>() {
  static readonly layer = Layer.scoped(
    PrWatcher,
    Effect.gen(function* () {
      const { store } = yield* LaborerStore

      // Track active polling fibers per workspace.
      const pollingFibers = yield* Ref.make<
        Map<string, Fiber.RuntimeFiber<void, never>>
      >(new Map())

      // Cache previous PR state per workspace for deduplication.
      const previousPrState = yield* Ref.make<Map<string, string>>(new Map())

      /**
       * Run `gh pr view` in a worktree directory and parse the JSON output.
       * Returns EMPTY_PR if no PR is found (exit code 1) or on any error.
       */
      const runGhPrView = Effect.fn('PrWatcher.runGhPrView')(function* (
        worktreePath: string
      ) {
        const spawnResult = yield* Effect.tryPromise({
          try: async () => {
            const proc = spawn(
              ['gh', 'pr', 'view', '--json', 'number,url,title,state'],
              {
                cwd: worktreePath,
                stdout: 'pipe',
                stderr: 'pipe',
              }
            )
            const exitCode = await proc.exited
            const stdout = await new Response(proc.stdout).text()
            const stderr = await new Response(proc.stderr).text()
            return { exitCode, stdout, stderr }
          },
          catch: () => 'gh-spawn-failed' as const,
        }).pipe(
          Effect.catchAll((tag) => {
            return Effect.logWarning(
              `[PrWatcher] Failed to run gh pr view: ${tag}`
            ).pipe(Effect.as(undefined))
          })
        )

        if (spawnResult === undefined) {
          return EMPTY_PR
        }

        // gh pr view returns exit code 1 when no PR is found
        if (spawnResult.exitCode !== 0) {
          return EMPTY_PR
        }

        const parseResult = yield* Effect.try({
          try: () =>
            JSON.parse(spawnResult.stdout.trim()) as {
              number?: number
              url?: string
              title?: string
              state?: string
            },
          catch: () => 'json-parse-failed' as const,
        }).pipe(
          Effect.catchAll(() =>
            Effect.logWarning(
              `[PrWatcher] Failed to parse gh pr view output: ${spawnResult.stdout.slice(0, 200)}`
            ).pipe(Effect.as(undefined))
          )
        )

        if (parseResult === undefined) {
          return EMPTY_PR
        }

        return {
          number: parseResult.number ?? null,
          url: parseResult.url ?? null,
          title: parseResult.title ?? null,
          state: parseResult.state ?? null,
        } satisfies PrData
      })

      const checkPr = Effect.fn('PrWatcher.checkPr')(function* (
        workspaceId: string
      ) {
        // Look up the workspace in LiveStore
        const allWorkspaces = store.query(tables.workspaces)
        const workspaceOpt = pipe(
          allWorkspaces,
          Arr.findFirst((w) => w.id === workspaceId)
        )

        if (workspaceOpt._tag === 'None') {
          yield* Effect.logWarning(
            `[PrWatcher] Workspace not found: ${workspaceId}`
          )
          return EMPTY_PR
        }

        const workspace = workspaceOpt.value

        // Only check active workspaces
        if (workspace.status !== 'running' && workspace.status !== 'creating') {
          return EMPTY_PR
        }

        const prData = yield* runGhPrView(workspace.worktreePath)

        // Deduplicate: only commit event if PR state changed
        const serialized = serializePrData(prData)
        const previousSerialized = yield* Ref.modify(
          previousPrState,
          (cache) => {
            const prev = cache.get(workspaceId)
            const next = new Map(cache)
            next.set(workspaceId, serialized)
            return [prev, next] as const
          }
        )

        if (previousSerialized !== serialized) {
          store.commit(
            events.workspacePrUpdated({
              id: workspaceId,
              prNumber: prData.number,
              prUrl: prData.url,
              prTitle: prData.title,
              prState: prData.state,
            })
          )

          if (prData.number != null) {
            yield* Effect.log(
              `[PrWatcher] workspace=${workspaceId} PR #${prData.number} (${prData.state})`
            )
          } else {
            yield* Effect.log(
              `[PrWatcher] workspace=${workspaceId} no PR found`
            )
          }
        }

        return prData
      })

      const startPolling = Effect.fn('PrWatcher.startPolling')(function* (
        workspaceId: string,
        intervalMs?: number
      ) {
        // Check if already polling
        const currentFibers = yield* Ref.get(pollingFibers)
        if (currentFibers.has(workspaceId)) {
          return
        }

        const interval = intervalMs ?? DEFAULT_POLL_INTERVAL_MS

        // Create polling effect that runs checkPr on a schedule.
        const pollEffect = checkPr(workspaceId).pipe(
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
          `[PrWatcher] started polling for workspace ${workspaceId} every ${interval}ms`
        )
      })

      const stopPolling = Effect.fn('PrWatcher.stopPolling')(function* (
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

        // Clear cached state
        yield* Ref.update(previousPrState, (cache) => {
          const next = new Map(cache)
          next.delete(workspaceId)
          return next
        })

        yield* Effect.log(
          `[PrWatcher] stopped polling for workspace ${workspaceId}`
        )
      })

      const stopAllPolling = Effect.fn('PrWatcher.stopAllPolling')(
        function* () {
          const fibers = yield* Ref.getAndSet(pollingFibers, new Map())

          yield* Effect.forEach(
            [...fibers.values()],
            (fiber) => Fiber.interrupt(fiber),
            { discard: true }
          )

          yield* Ref.set(previousPrState, new Map())

          yield* Effect.log(
            `[PrWatcher] stopped all polling (${fibers.size} workspaces)`
          )
        }
      )

      const isPolling = Effect.fn('PrWatcher.isPolling')(function* (
        workspaceId: string
      ) {
        const currentFibers = yield* Ref.get(pollingFibers)
        return currentFibers.has(workspaceId)
      })

      const bootstrapPolling = Effect.fn('PrWatcher.bootstrapPolling')(
        function* () {
          const activeWorkspaces = store
            .query(tables.workspaces)
            .filter(
              (workspace) =>
                workspace.status === 'running' ||
                workspace.status === 'creating'
            )

          yield* Effect.forEach(
            activeWorkspaces,
            (workspace) => startPolling(workspace.id),
            { discard: true }
          )
        }
      )

      yield* bootstrapPolling()

      // Clean up all polling fibers on service shutdown
      yield* Effect.addFinalizer(() => stopAllPolling())

      return PrWatcher.of({
        checkPr,
        startPolling,
        stopPolling,
        stopAllPolling,
        isPolling,
      })
    })
  )
}

export { PrWatcher }
