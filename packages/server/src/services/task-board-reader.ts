import { RpcError, type TaskBoardEvent } from '@laborer/shared/rpc'
import type { TaskRead } from '@laborer/task-db'
import { taskDatabasePath } from '@laborer/task-db/path'
import { Duration, Effect, Result, Schedule, Stream } from 'effect'
import { NodeTaskBoardDatabase } from './node-task-board-database.js'
import { inspectTaskWorktree } from './task-worktree.js'

/**
 * Safety-net cadence, not the interactive path. Same-process writes reach
 * clients immediately through the wakeup-driven shared-state stream
 * (`subscribeToSharedState`); this ledger tail only bounds how stale a
 * cross-process write can appear, so 2 s keeps the timer cheap.
 */
const DEFAULT_POLL_INTERVAL = Duration.millis(2000)

const boardReadError = (cause: unknown) =>
  new RpcError({
    code: 'TASK_BOARD_READ_FAILED',
    message:
      cause instanceof Error ? cause.message : 'Unable to read the task board',
  })

const toEvent = (read: TaskRead): TaskBoardEvent => ({
  ...read,
  tasks: read.tasks.map((task) => {
    const worktree = inspectTaskWorktree(task.worktreePath, task.executionId)
    return {
      ...task,
      worktreeBotOwned: worktree.botOwned,
      worktreeExists: worktree.exists,
    }
  }),
})

/**
 * Server-owned shared task database reader. A subscription receives one
 * consistent snapshot, then tails the change ledger. Because the polling
 * stream and SQLite handle are scoped to the RPC subscription,
 * interruption/board hiding stops polling and closes the handle immediately.
 */
export const subscribeToTaskBoard = (
  path?: string,
  pollInterval: Duration.Input = DEFAULT_POLL_INTERVAL
): Stream.Stream<TaskBoardEvent, RpcError> =>
  Stream.unwrap(
    Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => NodeTaskBoardDatabase.open(path ?? taskDatabasePath()),
        catch: boardReadError,
      }),
      (database) => Effect.sync(() => database.close())
    ).pipe(
      Effect.map((database) =>
        Stream.unwrap(
          Effect.sync(() => {
            let cursor = 0
            const readSnapshot = Effect.try({
              try: () => database.snapshot(),
              catch: boardReadError,
            }).pipe(
              Effect.tap((snapshot) =>
                Effect.sync(() => {
                  cursor = snapshot.cursor
                })
              ),
              Effect.map(toEvent)
            )
            const deltas = Stream.fromSchedule(
              Schedule.spaced(pollInterval)
            ).pipe(
              Stream.mapEffect(() =>
                Effect.try({
                  try: () => database.readChanges(cursor),
                  catch: boardReadError,
                }).pipe(
                  Effect.map((read) => {
                    cursor = read.cursor
                    return read._tag === 'delta' &&
                      read.tasks.length === 0 &&
                      read.deletedTaskIds.length === 0
                      ? Result.fail(undefined)
                      : Result.succeed(toEvent(read))
                  })
                )
              ),
              Stream.filterMap((event) => event)
            )

            return Stream.concat(Stream.fromEffect(readSnapshot), deltas)
          })
        )
      )
    )
  )
