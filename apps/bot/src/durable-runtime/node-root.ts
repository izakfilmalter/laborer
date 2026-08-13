import { layer as makeSqliteLayer } from '@effect/sql-sqlite-node/SqliteClient'
import { taskDatabasePath } from '@laborer/task-db/path'
import { Effect, Layer } from 'effect'
import { defineApplication, type LaborerApplication } from './action.ts'
import {
  noopExecutionTaskEmitter,
  openExecutionTaskEmitter,
  TaskEmissionDiagnostic,
} from './execution-task-emitter.ts'
import {
  makeRootDurableRuntimeLayer,
  RootDurableRuntime,
  type RootDurableRuntimeShape,
} from './root-runtime.ts'

const conversationOnlyApplication = defineApplication({ actions: [] })
export const CONVERSATION_ONLY_ACTION_CATALOG_FINGERPRINT =
  conversationOnlyApplication.actions.fingerprint

export const makeNodeRootDurableRuntime = Effect.fn(
  'makeNodeRootDurableRuntime'
)(function* (options: {
  readonly databasePath: string
  readonly application?: LaborerApplication
  readonly resolveSlackPermalink?: (request: {
    readonly channelId: string
    readonly rootTs: string
    readonly workspaceId: string
  }) => Promise<string>
  readonly repositoryPath?: string
  readonly rootIdentity: string
  readonly taskDatabasePath?: string
}): Effect.fn.Return<
  RootDurableRuntimeShape,
  unknown,
  import('effect').Scope.Scope
> {
  const taskEmitter = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        openExecutionTaskEmitter({
          databasePath: options.taskDatabasePath ?? taskDatabasePath(),
          ...(options.resolveSlackPermalink === undefined
            ? {}
            : { resolveSlackPermalink: options.resolveSlackPermalink }),
          ...(options.repositoryPath === undefined
            ? {}
            : { repositoryPath: options.repositoryPath }),
          rootPath: options.rootIdentity,
        }),
      catch: (cause) => new TaskEmissionDiagnostic(null, cause),
    }).pipe(
      Effect.catch((diagnostic) =>
        Effect.logError(diagnostic).pipe(Effect.as(noopExecutionTaskEmitter))
      )
    ),
    (emitter) =>
      'close' in emitter ? Effect.sync(() => emitter.close()) : Effect.void
  )
  const context = yield* Layer.build(
    makeRootDurableRuntimeLayer(
      makeSqliteLayer({ filename: options.databasePath }),
      options.application?.actions ?? conversationOnlyApplication.actions,
      options.rootIdentity,
      taskEmitter
    )
  )
  return yield* RootDurableRuntime.pipe(Effect.provide(context))
})
