import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { taskDatabasePath } from '@laborer/task-db/path'
import { Context, Effect, Layer } from 'effect'
import {
  LaborerDatabaseBusyError,
  type LaborerDatabaseOptions,
  LaborerDatabaseSchemaTooNewError,
  LaborerDatabaseStaleRevisionError,
  NativeLaborerDatabase,
} from './native-laborer-database.js'

export class LaborerDatabaseError extends Error {
  readonly _tag = 'LaborerDatabaseError'
  override readonly cause: unknown
  readonly operation: string
  constructor(operation: string, cause: unknown) {
    super(`Laborer database ${operation} failed`)
    this.operation = operation
    this.cause = cause
  }
}

export type LaborerDatabaseFailure =
  | LaborerDatabaseBusyError
  | LaborerDatabaseError
  | LaborerDatabaseSchemaTooNewError
  | LaborerDatabaseStaleRevisionError<unknown>

const mapFailure = (
  operation: string,
  cause: unknown
): LaborerDatabaseFailure =>
  cause instanceof LaborerDatabaseBusyError ||
  cause instanceof LaborerDatabaseSchemaTooNewError ||
  cause instanceof LaborerDatabaseStaleRevisionError
    ? cause
    : new LaborerDatabaseError(operation, cause)

const attempt = <A>(
  operation: string,
  run: () => A
): Effect.Effect<A, LaborerDatabaseFailure> =>
  Effect.try({ try: run, catch: (cause) => mapFailure(operation, cause) })

export interface LaborerDatabaseService {
  readonly database: NativeLaborerDatabase
  /** Read/projection helper. A read failure is an invariant defect. */
  readonly read: <A>(
    operation: string,
    read: (database: NativeLaborerDatabase) => A
  ) => Effect.Effect<A>
  readonly run: <A>(
    operation: string,
    run: (database: NativeLaborerDatabase) => A
  ) => Effect.Effect<A, LaborerDatabaseFailure>
}

export class LaborerDatabase extends Context.Tag(
  '@laborer/server/LaborerDatabase'
)<LaborerDatabase, LaborerDatabaseService>() {
  static layer(
    path = taskDatabasePath(),
    options: LaborerDatabaseOptions = {}
  ): Layer.Layer<LaborerDatabase, LaborerDatabaseFailure> {
    return makeLaborerDatabaseLayer(path, options)
  }

  static testLayer(
    options: LaborerDatabaseOptions = {}
  ): Layer.Layer<LaborerDatabase, LaborerDatabaseFailure> {
    return makeLaborerDatabaseLayer(':memory:', options)
  }

  static temporaryLayer(
    options: LaborerDatabaseOptions = {}
  ): Layer.Layer<LaborerDatabase, LaborerDatabaseFailure> {
    return makeTemporaryLaborerDatabaseLayer(options)
  }
}

export const makeLaborerDatabaseLayer = (
  path: string,
  options: LaborerDatabaseOptions = {}
): Layer.Layer<LaborerDatabase, LaborerDatabaseFailure> =>
  Layer.scoped(
    LaborerDatabase,
    Effect.acquireRelease(
      attempt('open', () => NativeLaborerDatabase.connect(path, options)),
      (database) => Effect.sync(() => database.close())
    ).pipe(
      Effect.tap((database) =>
        attempt('migrate', () => database.initialize(options.busyTimeoutMs))
      ),
      Effect.map((database) =>
        LaborerDatabase.of({
          database,
          read: (operation, read) =>
            attempt(operation, () => read(database)).pipe(Effect.orDie),
          run: (operation, run) => attempt(operation, () => run(database)),
        })
      )
    )
  )

export const TestLaborerDatabase = LaborerDatabase.testLayer()

export const LaborerDatabaseLive = LaborerDatabase.layer()

export const makeTemporaryLaborerDatabaseLayer = (
  options: LaborerDatabaseOptions = {}
): Layer.Layer<LaborerDatabase, LaborerDatabaseFailure> =>
  Layer.unwrapScoped(
    Effect.acquireRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), 'laborer-database-'))),
      (directory) =>
        Effect.sync(() => rmSync(directory, { recursive: true, force: true }))
    ).pipe(
      Effect.map((directory) =>
        makeLaborerDatabaseLayer(join(directory, 'laborer.sqlite'), options)
      )
    )
  )
