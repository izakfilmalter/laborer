import { existsSync } from 'node:fs'
import { RpcError, type TaskBoardEvent } from '@laborer/shared/rpc'
import type { TaskRead } from '@laborer/task-db'
import { taskDatabasePath } from '@laborer/task-db/path'
import { Duration, Effect, Option, Schedule, Stream } from 'effect'
import { NodeTaskBoardDatabase } from './node-task-board-database.js'

const DEFAULT_POLL_INTERVAL = Duration.millis(350)

const boardReadError = (cause: unknown) =>
  new RpcError({
    code: 'TASK_BOARD_READ_FAILED',
    message:
      cause instanceof Error ? cause.message : 'Unable to read the task board',
  })

const toEvent = (read: TaskRead): TaskBoardEvent => ({
  ...read,
  tasks: read.tasks.map((task) => ({
    ...task,
    worktreeExists: task.worktreePath !== null && existsSync(task.worktreePath),
  })),
})

/**
 * Server-owned shared task database reader. A subscription receives one
 * consistent snapshot, then tails the change ledger. Because the polling
 * stream and SQLite handle are scoped to the RPC subscription,
 * interruption/board hiding stops polling and closes the handle immediately.
 */
export const subscribeToTaskBoard = (
  path?: string,
  pollInterval: Duration.DurationInput = DEFAULT_POLL_INTERVAL
): Stream.Stream<TaskBoardEvent, RpcError> =>
  Stream.unwrapScoped(
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
                      ? Option.none<TaskBoardEvent>()
                      : Option.some(toEvent(read))
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
