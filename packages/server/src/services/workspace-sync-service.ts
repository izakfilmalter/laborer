import { RpcError } from '@laborer/shared/rpc'
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
import { PrWatcher } from './pr-watcher.js'
import { withFsmonitorDisabled } from './repo-watching-git.js'

interface WorkspaceSyncStatus {
  readonly aheadCount: number | null
  readonly behindCount: number | null
}

const EMPTY_SYNC_STATUS: WorkspaceSyncStatus = {
  aheadCount: null,
  behindCount: null,
}

const DEFAULT_POLL_INTERVAL_MS = 5000

const BRANCH_AB_RE = /^# branch\.ab \+(\d+) -(\d+)$/u
const LINE_SPLIT_RE = /\r?\n/u

const serializeSyncStatus = (status: WorkspaceSyncStatus): string =>
  JSON.stringify([status.aheadCount, status.behindCount])

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

class WorkspaceSyncService extends Context.Tag('@laborer/WorkspaceSyncService')<
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
>() {
  static readonly layer = Layer.scoped(
    WorkspaceSyncService,
    Effect.gen(function* () {
      const { store } = yield* LaborerStore
      const prWatcher = yield* PrWatcher

      const pollingFibers = yield* Ref.make<
        Map<string, Fiber.RuntimeFiber<void, never>>
      >(new Map())
      const previousStatuses = yield* Ref.make<Map<string, string>>(new Map())

      const getWorkspace = Effect.fn('WorkspaceSyncService.getWorkspace')(
        function* (workspaceId: string) {
          const workspaceOpt = pipe(
            store.query(tables.workspaces),
            Arr.findFirst((workspace) => workspace.id === workspaceId)
          )

          if (workspaceOpt._tag === 'None') {
            return yield* new RpcError({
              code: 'WORKSPACE_NOT_FOUND',
              message: `Workspace not found: ${workspaceId}`,
            })
          }

          return workspaceOpt.value
        }
      )

      const commitSyncStatus = Effect.fn(
        'WorkspaceSyncService.commitSyncStatus'
      )(function* (workspaceId: string, status: WorkspaceSyncStatus) {
        const serialized = serializeSyncStatus(status)
        const previousSerialized = yield* Ref.modify(
          previousStatuses,
          (cache) => {
            const previousValue = cache.get(workspaceId)
            const next = new Map(cache)
            next.set(workspaceId, serialized)
            return [previousValue, next] as const
          }
        )

        if (previousSerialized === serialized) {
          return
        }

        store.commit(
          events.workspaceSyncStatusUpdated({
            id: workspaceId,
            aheadCount: status.aheadCount,
            behindCount: status.behindCount,
          })
        )
      })

      const checkStatus = Effect.fn('WorkspaceSyncService.checkStatus')(
        function* (workspaceId: string) {
          const workspace = yield* getWorkspace(workspaceId)

          if (workspace.status === 'destroyed') {
            yield* commitSyncStatus(workspaceId, EMPTY_SYNC_STATUS)
            return EMPTY_SYNC_STATUS
          }

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

          const status = parseSyncStatus(result.stdout)
          yield* commitSyncStatus(workspaceId, status)
          return status
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

          const interval = intervalMs ?? DEFAULT_POLL_INTERVAL_MS
          const fiber = yield* checkStatus(workspaceId).pipe(
            Effect.catchAll(() => Effect.void),
            Effect.repeat(Schedule.spaced(Duration.millis(interval))),
            Effect.asVoid,
            Effect.forkDaemon
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

          yield* Ref.update(previousStatuses, (cache) => {
            const next = new Map(cache)
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
          yield* Ref.set(previousStatuses, new Map())
        }
      )

      const bootstrapPolling = Effect.fn(
        'WorkspaceSyncService.bootstrapPolling'
      )(function* () {
        const workspaces = store
          .query(tables.workspaces)
          .filter((workspace) => workspace.status !== 'destroyed')

        yield* Effect.forEach(
          workspaces.filter(
            (workspace) =>
              workspace.status === 'running' || workspace.status === 'creating'
          ),
          (workspace) => startPolling(workspace.id),
          { discard: true }
        )

        yield* Effect.forEach(
          workspaces.filter(
            (workspace) =>
              workspace.status !== 'running' && workspace.status !== 'creating'
          ),
          (workspace) => checkStatus(workspace.id).pipe(Effect.ignore),
          { discard: true }
        )
      })

      yield* bootstrapPolling()
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
