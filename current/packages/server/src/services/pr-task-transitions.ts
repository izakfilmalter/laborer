import { taskDatabasePath } from '@laborer/task-db/path'
import { Context, Effect, Layer } from 'effect'
import {
  NodeTaskBoardDatabase,
  type PrTaskTransitionInput,
} from './node-task-board-database.js'

class PrTaskTransitionError extends Error {
  readonly _tag = 'PrTaskTransitionError'
  override readonly cause: unknown

  constructor(cause: unknown) {
    super(
      cause instanceof Error
        ? cause.message
        : 'Unable to apply a task PR transition'
    )
    this.cause = cause
  }
}

class PrTaskTransitions extends Context.Tag('@laborer/PrTaskTransitions')<
  PrTaskTransitions,
  {
    readonly transition: (
      input: PrTaskTransitionInput
    ) => Effect.Effect<void, PrTaskTransitionError>
  }
>() {
  static readonly layer = Layer.scoped(
    PrTaskTransitions,
    Effect.acquireRelease(
      Effect.try({
        try: () => NodeTaskBoardDatabase.open(taskDatabasePath()),
        catch: (cause) => new PrTaskTransitionError(cause),
      }),
      (database) => Effect.sync(() => database.close())
    ).pipe(
      Effect.map((database) =>
        PrTaskTransitions.of({
          transition: (input) =>
            Effect.try({
              try: () => {
                database.transitionTaskForPr(input)
              },
              catch: (cause) => new PrTaskTransitionError(cause),
            }),
        })
      ),
      Effect.catchAll((error) =>
        Effect.succeed(
          PrTaskTransitions.of({ transition: () => Effect.fail(error) })
        )
      )
    )
  )

  static readonly noopLayer = Layer.succeed(
    PrTaskTransitions,
    PrTaskTransitions.of({ transition: () => Effect.void })
  )
}

export { PrTaskTransitions }
