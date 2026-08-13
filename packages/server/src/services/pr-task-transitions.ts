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

class PrTaskTransitions extends Context.Service<
  PrTaskTransitions,
  {
    readonly transition: (
      input: PrTaskTransitionInput
    ) => Effect.Effect<void, PrTaskTransitionError>
  }
>()('@laborer/PrTaskTransitions') {
  static readonly layer = Layer.effect(
    PrTaskTransitions,
    Effect.acquireRelease(
      Effect.sync((): { database: NodeTaskBoardDatabase | undefined } => ({
        database: undefined,
      })),
      (state) =>
        Effect.sync(() => {
          state.database?.close()
        })
    ).pipe(
      Effect.map((state) =>
        PrTaskTransitions.of({
          transition: (input) =>
            Effect.try({
              try: () => {
                // Retain only a successfully initialized connection so a
                // temporary startup lock can heal on a later polling pass.
                const database =
                  state.database ??
                  NodeTaskBoardDatabase.open(taskDatabasePath())
                state.database = database
                database.transitionTaskForPr(input)
              },
              catch: (cause) => new PrTaskTransitionError(cause),
            }),
        })
      )
    )
  )

  static readonly noopLayer = Layer.succeed(
    PrTaskTransitions,
    PrTaskTransitions.of({ transition: () => Effect.void })
  )
}

export { PrTaskTransitions }
