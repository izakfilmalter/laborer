import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { NodeRuntime } from '@effect/platform-node'
import { SqliteClient } from '@effect/sql-sqlite-node'
import { Console, Effect, Layer, Schema } from 'effect'
import {
  defineAction,
  defineApplication,
} from '../../src/durable-runtime/action.ts'
import {
  makeRootDurableRuntimeLayer,
  RootDurableRuntime,
} from '../../src/durable-runtime/root-runtime.ts'

const databasePath = process.argv[2]
const evidenceDirectory = process.argv[3]
const mode = process.argv[4]
if (
  databasePath === undefined ||
  evidenceDirectory === undefined ||
  (mode !== 'seed' && mode !== 'missing-registration' && mode !== 'recover')
) {
  throw new Error('invalid cold recovery fixture arguments')
}

const rootIdentity = 'cold-recovery-root'
const workspaceId = 'T-COLD-RECOVERY'
const conversationId = 'workspace:T-COLD-RECOVERY:thread:C-COLD-RECOVERY:275.0'
const privateInput = 'COLD_RECOVERY_PRIVATE_INPUT'

const AttemptRecord = Schema.Struct({
  attempts: Schema.Int.check(Schema.isGreaterThan(0)),
  executionId: Schema.String,
})
type AttemptRecord = typeof AttemptRecord.Type

const recordPath = (name: string) => join(evidenceDirectory, `${name}.json`)

const readRecord = (name: string) =>
  Effect.tryPromise({
    catch: () => undefined,
    try: async () => JSON.parse(await readFile(recordPath(name), 'utf8')),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(AttemptRecord)),
    Effect.catch(() => Effect.void)
  )

const writeRecord = (name: string, record: AttemptRecord) => {
  const destination = recordPath(name)
  const temporary = `${destination}.${String(process.pid)}.tmp`
  return Effect.promise(async () => {
    await writeFile(temporary, JSON.stringify(record), {
      encoding: 'utf8',
      mode: 0o600,
    })
    await rename(temporary, destination)
  })
}

const completedAction = defineAction({
  annotations: { idempotentHint: true },
  description: 'Complete before the fixture root process dies.',
  input: Schema.Struct({ privateValue: Schema.String }),
  name: 'fixture/cold-completed',
  recoveryPolicy: 'idempotent-retry',
  result: Schema.Struct({ stable: Schema.String }),
  revision: 'v1',
  run: (_input, context) =>
    Effect.gen(function* () {
      const prior = yield* readRecord('completed')
      yield* writeRecord('completed', {
        attempts: (prior?.attempts ?? 0) + 1,
        executionId: context.executionId,
      })
      return { stable: context.executionId }
    }),
})

const recoverableAction = defineAction({
  annotations: { idempotentHint: true },
  description: 'Reconcile an interrupted fixture operation by Execution ID.',
  input: Schema.Struct({ privateValue: Schema.String }),
  name: 'fixture/cold-idempotent',
  recoveryPolicy: 'idempotent-retry',
  result: Schema.Struct({ stable: Schema.String }),
  revision: 'v1',
  run: (_input, context) =>
    Effect.gen(function* () {
      const prior = yield* readRecord('idempotent')
      if (prior !== undefined) {
        if (prior.executionId !== context.executionId) {
          return yield* Effect.die('recovery changed stable Execution identity')
        }
        yield* writeRecord('idempotent', {
          attempts: prior.attempts + 1,
          executionId: context.executionId,
        })
        return { stable: context.executionId }
      }
      yield* context.reportProgress('external-boundary', { phase: 'started' })
      yield* writeRecord('idempotent', {
        attempts: 1,
        executionId: context.executionId,
      })
      return yield* Effect.never
    }),
})

const ambiguousAction = defineAction({
  description: 'Cross one ambiguous non-idempotent fixture boundary.',
  input: Schema.Struct({ privateValue: Schema.String }),
  name: 'fixture/cold-ambiguous',
  result: Schema.Struct({ stable: Schema.String }),
  revision: 'v1',
  run: (_input, context) =>
    Effect.gen(function* () {
      const prior = yield* readRecord('ambiguous')
      yield* writeRecord('ambiguous', {
        attempts: (prior?.attempts ?? 0) + 1,
        executionId: context.executionId,
      })
      if (prior !== undefined) {
        return { stable: context.executionId }
      }
      yield* context.reportProgress('external-boundary', { phase: 'started' })
      return yield* Effect.never
    }),
})

const actions =
  mode === 'missing-registration'
    ? [completedAction, recoverableAction]
    : [completedAction, recoverableAction, ambiguousAction]
const application = defineApplication({ actions })
const runtimeLayer = makeRootDurableRuntimeLayer(
  SqliteClient.layer({ filename: databasePath }),
  application.actions,
  rootIdentity
)

const waitFor = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  predicate: (value: A) => boolean
) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const value = yield* effect
      if (predicate(value)) {
        return value
      }
      yield* Effect.sleep('10 millis')
    }
    return yield* Effect.die('cold recovery fixture timed out')
  })

const seed = Effect.gen(function* () {
  const runtime = yield* RootDurableRuntime
  const start = (actionName: string, invocationId: string) =>
    runtime.startExecution({
      actionName,
      conversationId,
      input: { privateValue: privateInput },
      invocationId,
      rootIdentity,
      workspaceId,
    })
  const completed = yield* start(completedAction.name, 'cold-completed')
  yield* waitFor(
    runtime.getExecution(completed.executionId, conversationId, workspaceId),
    ({ status }) => status === 'completed'
  )
  const idempotent = yield* start(recoverableAction.name, 'cold-idempotent')
  const ambiguous = yield* start(ambiguousAction.name, 'cold-ambiguous')
  yield* waitFor(readRecord('idempotent'), (record) => record !== undefined)
  yield* waitFor(readRecord('ambiguous'), (record) => record !== undefined)
  yield* Console.log(
    `COLD_RECOVERY_READY:${JSON.stringify({
      ambiguousExecutionId: ambiguous.executionId,
      completedExecutionId: completed.executionId,
      idempotentExecutionId: idempotent.executionId,
      rootProcessId: process.pid,
    })}`
  )
  return yield* Effect.never
})

const recover = Effect.gen(function* () {
  const runtime = yield* RootDurableRuntime
  const execution = (name: string) =>
    readRecord(name).pipe(
      Effect.flatMap((record) =>
        record === undefined
          ? Effect.die(`missing ${name} recovery record`)
          : runtime.getExecution(
              record.executionId,
              conversationId,
              workspaceId
            )
      )
    )
  const completed = yield* waitFor(
    execution('completed'),
    ({ status }) => status === 'completed'
  )
  const idempotent = yield* waitFor(
    execution('idempotent'),
    ({ status }) => status === 'completed'
  )
  const ambiguous = yield* waitFor(
    execution('ambiguous'),
    ({ status }) => status === 'needs-attention'
  )
  const pending = yield* runtime.pendingEvents(conversationId, workspaceId)
  yield* Console.log(
    `COLD_RECOVERY_EVIDENCE:${JSON.stringify({
      ambiguous,
      ambiguousRecord: yield* readRecord('ambiguous'),
      completed,
      completedRecord: yield* readRecord('completed'),
      idempotent,
      idempotentRecord: yield* readRecord('idempotent'),
      pending: pending.map(({ eventId, executionId, kind, sequence }) => ({
        eventId,
        executionId,
        kind,
        sequence,
      })),
      rootProcessId: process.pid,
    })}`
  )
})

const missingRegistration = Effect.gen(function* () {
  const outcome = yield* Effect.exit(
    Effect.scoped(Layer.build(runtimeLayer).pipe(Effect.asVoid))
  )
  yield* Console.log(
    `COLD_RECOVERY_REGISTRATION:${outcome._tag === 'Failure' ? 'rejected' : 'accepted'}`
  )
})

const program =
  mode === 'missing-registration'
    ? missingRegistration
    : (mode === 'seed' ? seed : recover).pipe(Effect.provide(runtimeLayer))

program.pipe(Effect.scoped, NodeRuntime.runMain)
