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
 * - Read PR identity, mergeability, and check-rollup facts through `gh`
 * - Simulate merges locally when a branch does not have a PR yet
 * - Persist hosted and local branch-status facts on tasks
 * - Poll on adaptive interval based on panel visibility
 * - Start/stop polling per workspace
 * - Deduplicate unchanged PR state
 */

import { existsSync } from 'node:fs'
import { Context, Duration, Effect, Fiber, Layer, Ref, Schema } from 'effect'
import { spawn } from '../lib/spawn.js'
import { runGhPrViewWithOriginFallback } from './github-pr-view.js'
import { LaborerDatabase } from './laborer-database.js'
import {
  PR_BACKGROUND_POLL_INTERVAL_MS,
  PR_VISIBLE_POLL_INTERVAL_MS,
} from './polling-intervals.js'
import { PrTaskTransitions } from './pr-task-transitions.js'
import { getVisibleWorkspaceIds } from './visible-workspaces.js'
import {
  findWorkspaceRecord,
  listWorkspaceRecords,
} from './workspace-records.js'
import {
  findWorkspaceTask,
  updateServerTaskFacts,
} from './workspace-task-facts.js'

/**
 * Shape of PR data returned by `gh pr view --json ...`.
 * All fields are nullable because the branch may not have a PR.
 */
interface PrData {
  readonly baseBranch: string | null
  readonly checkStatus: 'pending' | 'success' | 'failure' | null
  readonly isDraft: boolean
  readonly mergeStatus: 'clean' | 'conflicting' | 'unknown' | null
  readonly number: number | null
  readonly state: string | null
  readonly title: string | null
  readonly url: string | null
}

const GhCheck = Schema.Struct({
  conclusion: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
})

const GhPrData = Schema.Struct({
  baseRefName: Schema.optional(Schema.NullOr(Schema.String)),
  isDraft: Schema.optional(Schema.Boolean),
  mergeable: Schema.optional(Schema.NullOr(Schema.String)),
  mergeStateStatus: Schema.optional(Schema.NullOr(Schema.String)),
  number: Schema.optional(Schema.NullOr(Schema.Number)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  statusCheckRollup: Schema.optional(Schema.NullOr(Schema.Array(GhCheck))),
})
const GhPrDataJson = Schema.fromJsonString(GhPrData)

/** Serialized PR state for deduplication. */
const serializePrData = (data: PrData): string =>
  JSON.stringify([
    data.number,
    data.url,
    data.title,
    data.state,
    data.isDraft,
    data.baseBranch,
    data.mergeStatus,
    data.checkStatus,
  ])

const FAILURE_CONCLUSIONS = new Set([
  'ACTION_REQUIRED',
  'ERROR',
  'FAILURE',
  'STARTUP_FAILURE',
  'TIMED_OUT',
])
const SUCCESS_CONCLUSIONS = new Set(['NEUTRAL', 'SKIPPED', 'SUCCESS'])
const REMOTE_BRANCH_PREFIX = /^refs\/remotes\/[^/]+\//

const singleCheckStatus = (
  check: typeof GhCheck.Type
): NonNullable<PrData['checkStatus']> => {
  const state = check.state?.toUpperCase() ?? null
  const status = check.status?.toUpperCase() ?? null
  const conclusion = check.conclusion?.toUpperCase() ?? null
  if (state !== null) {
    if (state === 'PENDING' || state === 'EXPECTED') {
      return 'pending'
    }
    return state === 'SUCCESS' ? 'success' : 'failure'
  }
  if (status !== null && status !== 'COMPLETED') {
    return 'pending'
  }
  if (conclusion === null) {
    return 'pending'
  }
  return FAILURE_CONCLUSIONS.has(conclusion) ||
    !SUCCESS_CONCLUSIONS.has(conclusion)
    ? 'failure'
    : 'success'
}

const checkStatus = (
  checks: readonly (typeof GhCheck.Type)[] | null | undefined
): PrData['checkStatus'] => {
  if (checks == null || checks.length === 0) {
    return null
  }
  let pending = false
  for (const check of checks) {
    const status = singleCheckStatus(check)
    if (status === 'failure') {
      return 'failure'
    }
    pending ||= status === 'pending'
  }
  return pending ? 'pending' : 'success'
}

const mergeStatus = (
  mergeable: string | null | undefined,
  state: string | null | undefined
): PrData['mergeStatus'] => {
  if (
    mergeable?.toUpperCase() === 'CONFLICTING' ||
    state?.toUpperCase() === 'DIRTY'
  ) {
    return 'conflicting'
  }
  if (mergeable?.toUpperCase() === 'MERGEABLE') {
    return 'clean'
  }
  return mergeable == null && state == null ? null : 'unknown'
}

/** Empty PR data (no PR found). */
const EMPTY_PR: PrData = {
  baseBranch: null,
  checkStatus: null,
  isDraft: false,
  mergeStatus: null,
  number: null,
  url: null,
  title: null,
  state: null,
}

const runGit = Effect.fn('PrWatcher.runGit')(function* (
  worktreePath: string,
  args: readonly string[]
) {
  return yield* Effect.promise(async () => {
    try {
      const proc = spawn(['git', ...args], {
        cwd: worktreePath,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const exitCode = await proc.exited
      return {
        exitCode,
        stdout: await new Response(proc.stdout).text(),
      }
    } catch {
      return { exitCode: -1, stdout: '' }
    }
  })
})

const shortBranchName = (ref: string): string =>
  ref.replace(REMOTE_BRANCH_PREFIX, '')

/** GitHub Desktop's advisory merge check, kept local so branches without a PR
 * still say when they conflict with their base branch. */
const loadLocalMergeData = Effect.fn('PrWatcher.loadLocalMergeData')(function* (
  worktreePath: string,
  storedBaseBranch: string | null
) {
  let baseRef = storedBaseBranch
  if (baseRef === null) {
    const remoteHead = yield* runGit(worktreePath, [
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
    ])
    if (remoteHead.exitCode === 0 && remoteHead.stdout.trim().length > 0) {
      baseRef = remoteHead.stdout.trim()
    }
  }
  if (baseRef === null) {
    for (const candidate of ['dev', 'main', 'master']) {
      const exists = yield* runGit(worktreePath, [
        'rev-parse',
        '--verify',
        candidate,
      ])
      if (exists.exitCode === 0) {
        baseRef = candidate
        break
      }
    }
  }
  if (baseRef === null) {
    return EMPTY_PR
  }

  const result = yield* runGit(worktreePath, [
    'merge-tree',
    '--write-tree',
    baseRef,
    'HEAD',
  ])
  let localMergeStatus: NonNullable<PrData['mergeStatus']> = 'unknown'
  if (result.exitCode === 0) {
    localMergeStatus = 'clean'
  } else if (result.exitCode === 1) {
    localMergeStatus = 'conflicting'
  }
  return {
    ...EMPTY_PR,
    baseBranch: shortBranchName(baseRef),
    mergeStatus: localMergeStatus,
  }
})

class PrWatcher extends Context.Service<
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
>()('@laborer/PrWatcher') {
  static readonly layer = Layer.effect(
    PrWatcher,
    Effect.gen(function* () {
      const laborerDatabase = yield* LaborerDatabase
      const taskTransitions = yield* PrTaskTransitions

      // Track active polling fibers per workspace.
      const pollingFibers = yield* Ref.make<
        Map<string, Fiber.Fiber<void, never>>
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
        branchName: string,
        baseBranch: string | null
      ) {
        // A workspace can outlive its directory (for example when its project
        // is removed). Node reports a missing cwd as `spawn gh ENOENT`, which
        // is indistinguishable from a missing executable unless we check the
        // worktree first.
        if (!existsSync(worktreePath)) {
          return EMPTY_PR
        }

        const spawnResult = yield* runGhPrViewWithOriginFallback(
          worktreePath,
          branchName,
          'number,url,title,state,isDraft,baseRefName,mergeable,mergeStateStatus,statusCheckRollup',
          (error) => error
        ).pipe(
          Effect.catch((error) => {
            // The directory may have disappeared between the existence check
            // and spawn. Treat that like the pre-spawn missing-path case.
            if (!existsSync(worktreePath)) {
              return Effect.void
            }

            return Effect.logWarning(
              `[PrWatcher] Failed to run gh pr view in ${worktreePath}: ${String(error)}`
            ).pipe(Effect.as(undefined))
          })
        )

        if (spawnResult === undefined) {
          return EMPTY_PR
        }

        // gh pr view returns exit code 1 when no PR is found
        if (spawnResult.exitCode !== 0) {
          return yield* loadLocalMergeData(worktreePath, baseBranch)
        }

        const parseResult = yield* Schema.decodeUnknownEffect(GhPrDataJson)(
          spawnResult.stdout.trim()
        ).pipe(
          Effect.catch(() =>
            Effect.logWarning(
              '[PrWatcher] Failed to parse gh pr view output'
            ).pipe(Effect.as(undefined))
          )
        )

        if (parseResult === undefined) {
          return EMPTY_PR
        }

        const hostedMergeStatus = mergeStatus(
          parseResult.mergeable,
          parseResult.mergeStateStatus
        )
        const localMergeData = yield* loadLocalMergeData(
          worktreePath,
          parseResult.baseRefName ?? baseBranch
        )
        const localMergeStatus = localMergeData.mergeStatus

        return {
          baseBranch:
            parseResult.baseRefName ?? localMergeData.baseBranch ?? null,
          checkStatus: checkStatus(parseResult.statusCheckRollup),
          isDraft: parseResult.isDraft ?? false,
          mergeStatus:
            localMergeStatus === null || localMergeStatus === 'unknown'
              ? hostedMergeStatus
              : localMergeStatus,
          number: parseResult.number ?? null,
          url: parseResult.url ?? null,
          title: parseResult.title ?? null,
          state: parseResult.state ?? null,
        } satisfies PrData
      })

      const checkPr = Effect.fn('PrWatcher.checkPr')(function* (
        workspaceId: string
      ) {
        const workspace = yield* laborerDatabase.read(
          'find workspace for PR check',
          (database) => findWorkspaceRecord(database, workspaceId)
        )

        if (workspace === null) {
          yield* Effect.logWarning(
            `[PrWatcher] Workspace not found, cleaning up. workspaceId=${workspaceId}`
          )
          yield* stopPolling(workspaceId)

          return EMPTY_PR
        }

        const prData = yield* loadPrData(
          workspace.worktreePath,
          workspace.branchName,
          workspace.baseBranch
        )

        // Deduplicate: only commit event if PR state changed
        const serialized = serializePrData(prData)
        const persistedSerialized = serializePrData({
          baseBranch: workspace.prBaseBranch,
          checkStatus: workspace.prCheckStatus,
          number: workspace.prNumber,
          isDraft: false,
          mergeStatus: workspace.prMergeStatus,
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

        const task = yield* findWorkspaceTask(laborerDatabase, workspace).pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              `[PrWatcher] Failed to find durable task for workspace ${workspaceId}: ${error.message}`
            ).pipe(Effect.as(null))
          )
        )
        if (task !== null) {
          const normalizedState = (() => {
            switch (prData.state?.toUpperCase()) {
              case 'OPEN':
                return 'open' as const
              case 'CLOSED':
                return 'closed' as const
              case 'MERGED':
                return 'merged' as const
              default:
                return null
            }
          })()
          yield* updateServerTaskFacts(laborerDatabase, task.id, {
            prBaseBranch: prData.baseBranch,
            prCheckStatus: prData.checkStatus,
            prIsDraft: prData.isDraft,
            prMergeStatus: prData.mergeStatus,
            prNumber: prData.number,
            prState: normalizedState,
            prTitle: prData.title,
            prUrl: prData.url,
          }).pipe(
            Effect.catch((error) =>
              Effect.logWarning(
                `[PrWatcher] Failed to persist PR facts for task ${task.id}: ${error.message}`
              )
            )
          )
        }

        // PR display state and task-board state are independent durable
        // projections. Attempt the task transition on every check so a prior
        // busy/schema failure can heal even when the PR payload is unchanged.
        const projects = yield* laborerDatabase.read(
          'list projects for PR transition',
          (database) => database.listProjects()
        )
        const project = projects.find(
          (candidate) => candidate.id === workspace.projectId
        )
        if (project !== undefined) {
          yield* taskTransitions
            .transition({
              branchName: workspace.branchName,
              projectRepoPath: project.rootPath,
              registeredProjectRepoPaths: projects.map(
                (candidate) => candidate.rootPath
              ),
              prState: prData.state,
            })
            .pipe(
              Effect.catch((error) =>
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
          const visibleWorkspaces = getVisibleWorkspaceIds()
          const isVisible = visibleWorkspaces.has(workspaceId)
          const interval = isVisible
            ? PR_VISIBLE_POLL_INTERVAL_MS
            : PR_BACKGROUND_POLL_INTERVAL_MS

          yield* checkPr(workspaceId).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning(
                `[PrWatcher] polling check failed for workspace ${workspaceId}: ${String(cause)}`
              )
            )
          )
          yield* Effect.sleep(Duration.millis(interval))
        }).pipe(Effect.forever, Effect.asVoid)

        const fiber = yield* Effect.forkDetach(pollEffect)

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
          const workspaces = yield* laborerDatabase.read(
            'list workspaces for PR polling',
            listWorkspaceRecords
          )
          yield* Effect.forEach(
            workspaces,
            (workspace) => startPolling(workspace.id),
            { discard: true }
          )
        }
      )

      // Re-scan at the background tier so reconciler-adopted worktrees gain a
      // watcher after startup.
      const refreshPollingCoverage = refreshPolling().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(
            `[PrWatcher] polling coverage refresh failed: ${String(cause)}`
          )
        ),
        Effect.andThen(
          Effect.sleep(Duration.millis(PR_BACKGROUND_POLL_INTERVAL_MS))
        )
      )
      yield* refreshPollingCoverage.pipe(Effect.forever, Effect.forkScoped)

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
