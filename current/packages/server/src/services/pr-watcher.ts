/**
 * PrWatcher — Effect Service
 *
 * Monitors non-destroyed workspaces for associated pull requests by running
 * `gh pr view` in their worktree directories. Uses the `gh` CLI so
 * authentication is handled by the user's existing GitHub login
 * (no API tokens needed in the app).
 *
 * Adaptive polling based on panel visibility:
 * - 5s when workspace has an open panel (responsive)
 * - 30s when workspace has no open panel (background)
 *
 * Responsibilities:
 * - Run `gh pr view --json number,url,title,state` in a workspace's worktree
 * - Commit WorkspacePrUpdated events to LiveStore when PR state changes
 * - Poll on adaptive interval based on panel visibility
 * - Start/stop polling per workspace
 * - Deduplicate unchanged PR state to avoid unnecessary LiveStore events
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
} from 'effect'
import { runGhPrViewWithOriginFallback } from './github-pr-view.js'
import { LaborerStore } from './laborer-store.js'
import {
  PR_BACKGROUND_POLL_INTERVAL_MS,
  PR_VISIBLE_POLL_INTERVAL_MS,
} from './polling-intervals.js'
import { PrTaskTransitions } from './pr-task-transitions.js'
import { getVisibleWorkspaceIds } from './visible-workspaces.js'

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
     * Start polling PR status for a workspace.
     *
     * Uses adaptive polling: 5s when workspace has an open panel,
     * 30s when running in background (no open panel).
     * Calling on an already-polled workspace is a no-op.
     *
     * @param workspaceId - ID of the workspace to poll
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

    /** Ensure every currently non-destroyed workspace has a polling fiber. */
    readonly refreshPolling: () => Effect.Effect<void>
  }
>() {
  static readonly layer = Layer.scoped(
    PrWatcher,
    Effect.gen(function* () {
      const { store } = yield* LaborerStore
      const taskTransitions = yield* PrTaskTransitions

      // Track active polling fibers per workspace.
      const pollingFibers = yield* Ref.make<
        Map<string, Fiber.RuntimeFiber<void, never>>
      >(new Map())
      const startingWorkspaces = yield* Ref.make<ReadonlySet<string>>(new Set())

      // Cache previous PR state per workspace for deduplication.
      const previousPrState = yield* Ref.make<Map<string, string>>(new Map())

      /**
       * Run `gh pr view` in a worktree directory and parse the JSON output.
       * Returns EMPTY_PR if no PR is found (exit code 1) or on any error.
       */
      const loadPrData = Effect.fn('PrWatcher.loadPrData')(function* (
        worktreePath: string,
        branchName: string
      ) {
        const spawnResult = yield* runGhPrViewWithOriginFallback(
          worktreePath,
          branchName,
          'number,url,title,state',
          () => 'gh-spawn-failed' as const
        ).pipe(
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
            `[PrWatcher] Workspace not found in LiveStore, cleaning up. workspaceId=${workspaceId}`
          )

          store.commit(events.workspaceDestroyed({ id: workspaceId }))
          yield* stopPolling(workspaceId)

          return EMPTY_PR
        }

        const workspace = workspaceOpt.value

        if (workspace.status === 'destroyed') {
          return EMPTY_PR
        }

        const prData = yield* loadPrData(
          workspace.worktreePath,
          workspace.branchName
        )

        // Deduplicate: only commit event if PR state changed
        const serialized = serializePrData(prData)
        const persistedSerialized = serializePrData({
          number: workspace.prNumber,
          url: workspace.prUrl,
          title: workspace.prTitle,
          state: workspace.prState,
        })
        const previousSerialized = yield* Ref.modify(
          previousPrState,
          (cache) => {
            const prev = cache.get(workspaceId)
            const next = new Map(cache)
            next.set(workspaceId, serialized)
            return [prev, next] as const
          }
        )

        if (
          previousSerialized !== serialized &&
          persistedSerialized !== serialized
        ) {
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

        // PR display state and task-board state are independent durable
        // projections. Attempt the task transition on every check so a prior
        // busy/schema failure can heal even when the PR payload is unchanged.
        const projects = store.query(tables.projects)
        const project = pipe(
          projects,
          Arr.findFirst((candidate) => candidate.id === workspace.projectId)
        )
        if (project._tag === 'Some') {
          yield* taskTransitions
            .transition({
              branchName: workspace.branchName,
              projectRepoPath: project.value.repoPath,
              registeredProjectRepoPaths: projects.map(
                (candidate) => candidate.repoPath
              ),
              prState: prData.state,
            })
            .pipe(
              Effect.catchAll((error) =>
                Effect.logWarning(
                  `[PrWatcher] Failed to move task for workspace ${workspaceId}: ${error.message}`
                )
              )
            )
        }

        return prData
      })

      const startPolling = Effect.fn('PrWatcher.startPolling')(function* (
        workspaceId: string,
        _intervalMs?: number
      ) {
        const reserved = yield* Ref.modify(startingWorkspaces, (starting) => {
          if (starting.has(workspaceId)) {
            return [false, starting] as const
          }
          const next = new Set(starting)
          next.add(workspaceId)
          return [true, next] as const
        })
        if (!reserved) {
          return
        }

        const currentFibers = yield* Ref.get(pollingFibers)
        if (currentFibers.has(workspaceId)) {
          yield* Ref.update(startingWorkspaces, (starting) => {
            const next = new Set(starting)
            next.delete(workspaceId)
            return next
          })
          return
        }

        // Adaptive polling: check visibility on each tick and sleep
        // for the appropriate interval.
        const pollEffect = Effect.gen(function* () {
          const visibleWorkspaces = getVisibleWorkspaceIds(store)
          const isVisible = visibleWorkspaces.has(workspaceId)
          const interval = isVisible
            ? PR_VISIBLE_POLL_INTERVAL_MS
            : PR_BACKGROUND_POLL_INTERVAL_MS

          yield* checkPr(workspaceId).pipe(
            Effect.catchAllCause((cause) =>
              Effect.logWarning(
                `[PrWatcher] polling check failed for workspace ${workspaceId}: ${String(cause)}`
              )
            )
          )
          yield* Effect.sleep(Duration.millis(interval))
        }).pipe(Effect.forever, Effect.asVoid)

        const fiber = yield* Effect.forkDaemon(pollEffect)

        yield* Ref.update(pollingFibers, (fibers) => {
          const next = new Map(fibers)
          next.set(workspaceId, fiber)
          return next
        })
        yield* Ref.update(startingWorkspaces, (starting) => {
          const next = new Set(starting)
          next.delete(workspaceId)
          return next
        })

        yield* Effect.log(
          `[PrWatcher] started polling for workspace ${workspaceId} (adaptive: ${PR_VISIBLE_POLL_INTERVAL_MS}ms visible / ${PR_BACKGROUND_POLL_INTERVAL_MS}ms background)`
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

      const refreshPolling = Effect.fn('PrWatcher.refreshPolling')(
        function* () {
          const workspaces = store
            .query(tables.workspaces)
            .filter((workspace) => workspace.status !== 'destroyed')
          yield* Effect.forEach(
            workspaces,
            (workspace) => startPolling(workspace.id),
            { discard: true }
          )
        }
      )

      // Re-scan at the background tier so reconciler-adopted worktrees gain a
      // watcher even when their LiveStore row is created after startup.
      yield* refreshPolling().pipe(
        Effect.zipRight(
          Effect.sleep(Duration.millis(PR_BACKGROUND_POLL_INTERVAL_MS))
        ),
        Effect.forever,
        Effect.catchAllCause((cause) =>
          Effect.logWarning(
            `[PrWatcher] polling coverage refresh failed: ${String(cause)}`
          )
        ),
        Effect.forkScoped
      )

      // Clean up all polling fibers on service shutdown
      yield* Effect.addFinalizer(() => stopAllPolling())

      return PrWatcher.of({
        checkPr,
        startPolling,
        stopPolling,
        stopAllPolling,
        isPolling,
        refreshPolling,
      })
    })
  )
}

export { PrWatcher }
