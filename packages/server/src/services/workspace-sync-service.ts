import { RpcError } from '@laborer/shared/rpc'
import { Context, Duration, Effect, Fiber, Layer, Ref, Schedule } from 'effect'
import { spawn } from '../lib/spawn.js'
import { BackgroundFetchService } from './background-fetch-service.js'
import { LaborerDatabase } from './laborer-database.js'
import { SYNC_STATUS_POLL_INTERVAL_MS } from './polling-intervals.js'
import { PrWatcher } from './pr-watcher.js'
import { withFsmonitorDisabled } from './repo-watching-git.js'
import {
  findWorkspaceRecord,
  listWorkspaceRecords,
} from './workspace-records.js'

interface WorkspaceSyncStatus {
  readonly aheadCount: number | null
  readonly behindCount: number | null
}

const EMPTY_SYNC_STATUS: WorkspaceSyncStatus = {
  aheadCount: null,
  behindCount: null,
}

const BRANCH_AB_RE = /^# branch\.ab \+(\d+) -(\d+)$/u
const LINE_SPLIT_RE = /\r?\n/u

const parseSyncStatus = (output: string): WorkspaceSyncStatus => {
  const lines = output.split(LINE_SPLIT_RE)
  const hasUpstream = lines.some((line) =>
    line.startsWith('# branch.upstream ')
  )

  if (!hasUpstream) {
    return EMPTY_SYNC_STATUS
  }

  for (const line of lines) {
    const match = BRANCH_AB_RE.exec(line)
    if (!match) {
      continue
    }

    const aheadCount = Number(match[1])
    const behindCount = Number(match[2])

    return {
      aheadCount: Number.isFinite(aheadCount) ? aheadCount : 0,
      behindCount: Number.isFinite(behindCount) ? behindCount : 0,
    }
  }

  return {
    aheadCount: 0,
    behindCount: 0,
  }
}

const spawnGit = async (
  args: readonly string[],
  cwd: string
): Promise<{
  readonly exitCode: number
  readonly stderr: string
  readonly stdout: string
}> => {
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

class WorkspaceSyncService extends Context.Service<
  WorkspaceSyncService,
  {
    readonly checkStatus: (
      workspaceId: string
    ) => Effect.Effect<WorkspaceSyncStatus, RpcError>
    readonly pull: (
      workspaceId: string
    ) => Effect.Effect<WorkspaceSyncStatus, RpcError>
    readonly push: (
      workspaceId: string
    ) => Effect.Effect<WorkspaceSyncStatus, RpcError>
    readonly startPolling: (
      workspaceId: string,
      intervalMs?: number
    ) => Effect.Effect<void>
    readonly stopPolling: (workspaceId: string) => Effect.Effect<void>
    readonly stopAllPolling: () => Effect.Effect<void>
  }
>()('@laborer/WorkspaceSyncService') {
  static readonly layer = Layer.effect(
    WorkspaceSyncService,
    Effect.gen(function* () {
      const laborerDatabase = yield* LaborerDatabase
      const prWatcher = yield* PrWatcher
      const backgroundFetch = yield* BackgroundFetchService

      const pollingFibers = yield* Ref.make<
        Map<string, Fiber.Fiber<void, never>>
      >(new Map())
      /**
       * Workspaces whose repo already has a background fetch schedule, so a
       * repeated status read does not re-resolve the repo root every time.
       */
      const fetchedWorkspaces = yield* Ref.make<Set<string>>(new Set())

      const getWorkspace = Effect.fn('WorkspaceSyncService.getWorkspace')(
        function* (workspaceId: string) {
          const workspace = yield* laborerDatabase.read(
            'find workspace for sync operation',
            (database) => findWorkspaceRecord(database, workspaceId)
          )

          if (workspace === null) {
            return yield* new RpcError({
              code: 'WORKSPACE_NOT_FOUND',
              message: `Workspace not found: ${workspaceId}`,
            })
          }

          return workspace
        }
      )

      /**
       * Ahead/behind counts are only as fresh as the repo's tracking refs, so
       * asking for a workspace's status enrolls its repo in background
       * fetching. Schedules are deduplicated per repo, and the main checkout
       * enrolls itself here because it has no task row to provision one.
       */
      const ensureBackgroundFetch = Effect.fn(
        'WorkspaceSyncService.ensureBackgroundFetch'
      )(function* (workspaceId: string) {
        const alreadyFetching = yield* Ref.modify(
          fetchedWorkspaces,
          (workspaces) => {
            if (workspaces.has(workspaceId)) {
              return [true, workspaces] as const
            }
            const next = new Set(workspaces)
            next.add(workspaceId)
            return [false, next] as const
          }
        )

        if (alreadyFetching) {
          return
        }

        yield* backgroundFetch.startFetching(workspaceId)
      })

      const checkStatus = Effect.fn('WorkspaceSyncService.checkStatus')(
        function* (workspaceId: string) {
          const workspace = yield* getWorkspace(workspaceId)
          yield* ensureBackgroundFetch(workspaceId)

          const result = yield* Effect.tryPromise({
            try: () =>
              spawnGit(
                ['status', '--porcelain=v2', '--branch'],
                workspace.worktreePath
              ),
            catch: (error) =>
              new RpcError({
                code: 'GIT_SYNC_STATUS_FAILED',
                message: `Failed to read sync status: ${String(error)}`,
              }),
          })

          if (result.exitCode !== 0) {
            return yield* new RpcError({
              code: 'GIT_SYNC_STATUS_FAILED',
              message: result.stderr.trim() || 'git status failed',
            })
          }

          return parseSyncStatus(result.stdout)
        }
      )

      const push = Effect.fn('WorkspaceSyncService.push')(function* (
        workspaceId: string
      ) {
        const workspace = yield* getWorkspace(workspaceId)

        const result = yield* Effect.tryPromise({
          try: () => spawnGit(['push'], workspace.worktreePath),
          catch: (error) =>
            new RpcError({
              code: 'GIT_PUSH_FAILED',
              message: `Failed to push commits: ${String(error)}`,
            }),
        })

        if (result.exitCode !== 0) {
          return yield* new RpcError({
            code: 'GIT_PUSH_FAILED',
            message: result.stderr.trim() || 'git push failed',
          })
        }

        const status = yield* checkStatus(workspaceId)
        yield* prWatcher.checkPr(workspaceId).pipe(Effect.ignore)
        return status
      })

      const pull = Effect.fn('WorkspaceSyncService.pull')(function* (
        workspaceId: string
      ) {
        const workspace = yield* getWorkspace(workspaceId)

        const result = yield* Effect.tryPromise({
          try: () => spawnGit(['pull', '--ff-only'], workspace.worktreePath),
          catch: (error) =>
            new RpcError({
              code: 'GIT_PULL_FAILED',
              message: `Failed to pull commits: ${String(error)}`,
            }),
        })

        if (result.exitCode !== 0) {
          return yield* new RpcError({
            code: 'GIT_PULL_FAILED',
            message: result.stderr.trim() || 'git pull failed',
          })
        }

        return yield* checkStatus(workspaceId)
      })

      const startPolling = Effect.fn('WorkspaceSyncService.startPolling')(
        function* (workspaceId: string, intervalMs?: number) {
          const currentFibers = yield* Ref.get(pollingFibers)
          if (currentFibers.has(workspaceId)) {
            return
          }

          // Start background fetching so tracking refs stay fresh
          yield* ensureBackgroundFetch(workspaceId)

          const interval = intervalMs ?? SYNC_STATUS_POLL_INTERVAL_MS
          const fiber = yield* checkStatus(workspaceId).pipe(
            Effect.catch(() => Effect.void),
            Effect.repeat(Schedule.spaced(Duration.millis(interval))),
            Effect.asVoid,
            Effect.forkDetach
          )

          yield* Ref.update(pollingFibers, (fibers) => {
            const next = new Map(fibers)
            next.set(workspaceId, fiber)
            return next
          })
        }
      )

      const stopPolling = Effect.fn('WorkspaceSyncService.stopPolling')(
        function* (workspaceId: string) {
          const fiber = yield* Ref.modify(pollingFibers, (fibers) => {
            const existing = fibers.get(workspaceId)
            if (existing === undefined) {
              return [undefined, fibers] as const
            }
            const next = new Map(fibers)
            next.delete(workspaceId)
            return [existing, next] as const
          })

          if (fiber !== undefined) {
            yield* Fiber.interrupt(fiber)
          }

          // Stop background fetching for this workspace
          yield* backgroundFetch.stopFetching(workspaceId)

          yield* Ref.update(fetchedWorkspaces, (workspaces) => {
            const next = new Set(workspaces)
            next.delete(workspaceId)
            return next
          })
        }
      )

      const stopAllPolling = Effect.fn('WorkspaceSyncService.stopAllPolling')(
        function* () {
          const fibers = yield* Ref.getAndSet(pollingFibers, new Map())
          yield* Effect.forEach([...fibers.values()], Fiber.interrupt, {
            discard: true,
          })
          yield* backgroundFetch.stopAllFetching()
          yield* Ref.set(fetchedWorkspaces, new Set())
        }
      )

      const bootstrapPolling = Effect.fn(
        'WorkspaceSyncService.bootstrapPolling'
      )(function* () {
        const workspaces = yield* laborerDatabase.read(
          'list workspaces for sync polling',
          listWorkspaceRecords
        )

        yield* Effect.forEach(
          workspaces,
          (workspace) => startPolling(workspace.id),
          { discard: true }
        )
      })

      yield* Effect.forkDetach(
        bootstrapPolling().pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning('Workspace sync bootstrap failed', { cause })
          )
        )
      )
      yield* Effect.addFinalizer(() => stopAllPolling())

      return WorkspaceSyncService.of({
        checkStatus,
        pull,
        push,
        startPolling,
        stopPolling,
        stopAllPolling,
      })
    })
  )
}

export { WorkspaceSyncService }
