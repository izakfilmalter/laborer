import {
  RpcError,
  type SharedStateUpdate,
  type SharedTaskRow,
} from '@laborer/shared/rpc'
import { taskDatabasePath } from '@laborer/task-db/path'
import { Cause, Effect, Queue, Stream } from 'effect'
import { onLaborerDatabaseWrite } from './laborer-database-wakeup.js'
import {
  type LaborerDatabaseSnapshot,
  NativeLaborerDatabase,
  type NativeStateUpdates,
  type NativeTableUpdate,
} from './native-laborer-database.js'
import { inspectTaskWorktree } from './task-worktree.js'

/**
 * Cross-process safety net only. Same-process writes wake readers
 * immediately via `onLaborerDatabaseWrite`, so this interval only bounds
 * how stale another process's write can appear; 2 s keeps the timer cheap.
 */
export const SHARED_STATE_POLL_INTERVAL_MS = 2000

const readError = (cause: unknown) =>
  new RpcError({
    code: 'SHARED_STATE_READ_FAILED',
    message:
      cause instanceof Error ? cause.message : 'Unable to read shared state',
  })

const taskRow = (
  task: LaborerDatabaseSnapshot['tasks'][number]
): SharedTaskRow => {
  const worktree = inspectTaskWorktree(task.worktreePath, task.executionId)
  return {
    ...task,
    worktreeBotOwned: worktree.botOwned,
    worktreeExists: worktree.exists,
  }
}

const taskUpdate = (
  update: NativeTableUpdate<LaborerDatabaseSnapshot['tasks'][number]>
) => ({ ...update, rows: update.rows.map(taskRow) })

const snapshotUpdate = (
  snapshot: LaborerDatabaseSnapshot
): SharedStateUpdate => ({
  labels: {
    cursor: snapshot.stateCursor,
    rows: snapshot.labels,
    type: 'snapshot',
  },
  projects: {
    cursor: snapshot.stateCursor,
    rows: snapshot.projects,
    type: 'snapshot',
  },
  reviewComments: {
    cursor: snapshot.stateCursor,
    rows: snapshot.reviewComments,
    type: 'snapshot',
  },
  settings: {
    cursor: snapshot.stateCursor,
    rows: snapshot.settings,
    type: 'snapshot',
  },
  tasks: {
    cursor: snapshot.taskCursor,
    rows: snapshot.tasks.map(taskRow),
    type: 'snapshot',
  },
})

const deltaUpdate = (
  tasks: NativeTableUpdate<LaborerDatabaseSnapshot['tasks'][number]> | null,
  state: NativeStateUpdates | null
): SharedStateUpdate | null =>
  tasks === null && state === null
    ? null
    : {
        ...(state === null ? {} : state),
        ...(tasks === null ? {} : { tasks: taskUpdate(tasks) }),
      }

/**
 * Combined authoritative stream. The process-local wakeup makes server writes
 * immediate; the interval remains the durable source of truth for other
 * processes and for any missed wakeup.
 */
export const subscribeToSharedState = (
  path = taskDatabasePath(),
  pollIntervalMs = SHARED_STATE_POLL_INTERVAL_MS
): Stream.Stream<SharedStateUpdate, RpcError> =>
  Stream.callback<SharedStateUpdate, RpcError>(
    (queue) =>
      Effect.acquireRelease(
        Effect.try({
          try: () => {
            if (
              !(Number.isSafeInteger(pollIntervalMs) && pollIntervalMs >= 1)
            ) {
              throw new Error('Shared state poll interval must be positive')
            }
            const database = NativeLaborerDatabase.open(path)
            let taskCursor = 0
            let stateCursor = 0
            let reading = false
            let readAgain = false
            let snapshotRequired = false

            const emitSnapshot = () => {
              const snapshot = database.snapshot()
              taskCursor = snapshot.taskCursor
              stateCursor = snapshot.stateCursor
              snapshotRequired = !Queue.offerUnsafe(
                queue,
                snapshotUpdate(snapshot)
              )
            }

            const emitDeltas = () => {
              const tasks = database.taskUpdateAfter(taskCursor)
              const state = database.stateUpdatesAfter(stateCursor)
              if (tasks !== null) {
                taskCursor = tasks.cursor
              }
              if (state !== null) {
                stateCursor = state.projects.cursor
              }
              const update = deltaUpdate(tasks, state)
              if (update !== null) {
                snapshotRequired = !Queue.offerUnsafe(queue, update)
              }
            }

            const readOnce = () => {
              try {
                if (snapshotRequired) {
                  emitSnapshot()
                } else {
                  emitDeltas()
                }
              } catch {
                // A gap, pruning, cursor regression, or row decode failure
                // invalidates deltas. A fresh transaction restores authority.
                emitSnapshot()
              }
            }

            const drainReads = () => {
              do {
                readAgain = false
                readOnce()
              } while (readAgain)
            }

            const read = () => {
              if (reading) {
                readAgain = true
                return
              }
              reading = true
              try {
                drainReads()
              } catch (cause) {
                Queue.failCauseUnsafe(queue, Cause.fail(readError(cause)))
              } finally {
                reading = false
              }
            }

            // Register before snapshotting: a commit racing the snapshot either
            // lands in that transaction or leaves a wakeup to tail afterward.
            const unsubscribe = onLaborerDatabaseWrite(path, read)
            const timer = setInterval(read, pollIntervalMs)
            try {
              emitSnapshot()
            } catch (cause) {
              clearInterval(timer)
              unsubscribe()
              database.close()
              throw cause
            }
            return { database, timer, unsubscribe }
          },
          catch: readError,
        }),
        ({ database, timer, unsubscribe }) =>
          Effect.sync(() => {
            clearInterval(timer)
            unsubscribe()
            database.close()
          })
      ),
    // Bound a stalled subscriber. A dropped delta sets snapshotRequired, so
    // the next wakeup or poll restores the subscriber's authoritative state.
    { bufferSize: 16, strategy: 'dropping' }
  )
