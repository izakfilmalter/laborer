import { join } from 'node:path'
import { layer as makeSqliteLayer } from '@effect/sql-sqlite-node/SqliteClient'
import { assert, describe, it } from '@effect/vitest'
import { Deferred, Effect, Fiber, Ref, Schema } from 'effect'
import {
  defineAction,
  defineApplication,
} from '../src/durable-runtime/action.ts'
import { makeExecutionControlSurface } from '../src/durable-runtime/execution-control.ts'
import {
  makeRootDurableRuntimeLayer,
  RootDurableRuntime,
} from '../src/durable-runtime/root-runtime.ts'
import { makeTempDirectoryScoped } from './support/temp-directory.ts'

const awaitStatus = Effect.fn('awaitExecutionStatus')(function* (
  executionId: string,
  status: string
) {
  const runtime = yield* RootDurableRuntime
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const snapshot = yield* runtime.getExecution(
      executionId,
      'conversation-control',
      'T-CONTROL'
    )
    if (snapshot.status === status) {
      return snapshot
    }
    yield* Effect.sleep('10 millis')
  }
  return yield* Effect.die(`Execution did not reach ${status}`)
})

describe('Cluster Execution controls', () => {
  it.live(
    'accepts a follow-up before delivery finishes and reports delivery failure',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* makeTempDirectoryScoped(
            'laborer-execution-follow-up-'
          )
          const releaseRun = yield* Deferred.make<void>()
          const releaseDelivery = yield* Deferred.make<void>()
          const deliveries = yield* Ref.make<readonly string[]>([])
          const steered = defineAction({
            annotations: { idempotentHint: true },
            controls: {
              followUp: (content) =>
                Ref.update(deliveries, (items) => [...items, content]).pipe(
                  Effect.andThen(Deferred.await(releaseDelivery)),
                  Effect.andThen(
                    content.startsWith('fail')
                      ? Effect.fail(new Error('delivery rejected'))
                      : Effect.void
                  )
                ),
            },
            description: 'A steerable fixture Action',
            input: Schema.Struct({ label: Schema.String }),
            name: 'fixture/steered',
            recoveryPolicy: 'idempotent-retry',
            result: Schema.Struct({ label: Schema.String }),
            revision: 'v1',
            run: (input) => Deferred.await(releaseRun).pipe(Effect.as(input)),
          })
          const application = defineApplication({ actions: [steered] })
          const layer = makeRootDurableRuntimeLayer(
            makeSqliteLayer({ filename: join(directory, 'runtime.sqlite') }),
            application.actions,
            'root-control'
          )

          yield* Effect.gen(function* () {
            const runtime = yield* RootDurableRuntime
            const owner = {
              conversationId: 'conversation-control',
              workspaceId: 'T-CONTROL',
            } as const
            const execution = yield* runtime.startExecution({
              actionName: steered.name,
              ...owner,
              input: { label: 'steered' },
              invocationId: 'invocation-steered',
              rootIdentity: 'root-control',
            })
            yield* awaitStatus(execution.executionId, 'running')

            // The receipt arrives while the capability is still delivering.
            const first = yield* runtime.followUpExecution({
              content: 'Also add a button.',
              controlId: 'follow-up-fast',
              executionId: execution.executionId,
              ...owner,
            })
            assert.strictEqual(first.deduplicated, false)
            assert.strictEqual(first.execution.status, 'running')
            assert.strictEqual(yield* Deferred.isDone(releaseDelivery), false)
            const failing = yield* runtime.followUpExecution({
              content: 'fail this one',
              controlId: 'follow-up-failing',
              executionId: execution.executionId,
              ...owner,
            })
            assert.strictEqual(failing.deduplicated, false)
            const replayed = yield* runtime.followUpExecution({
              content: 'Also add a button.',
              controlId: 'follow-up-fast',
              executionId: execution.executionId,
              ...owner,
            })
            assert.strictEqual(replayed.deduplicated, true)
            assert.deepStrictEqual(yield* Ref.get(deliveries), [
              'Also add a button.',
              'fail this one',
            ])

            yield* Deferred.succeed(releaseDelivery, undefined)
            let failureEvents: readonly unknown[] = []
            for (let attempt = 0; attempt < 500; attempt += 1) {
              const events = yield* runtime.pendingEvents(
                owner.conversationId,
                owner.workspaceId
              )
              failureEvents = events.filter(
                (event) =>
                  event.kind === 'progress' &&
                  typeof event.payload === 'object' &&
                  event.payload !== null &&
                  'kind' in event.payload &&
                  event.payload.kind === 'follow-up-failed'
              )
              if (failureEvents.length > 0) {
                break
              }
              yield* Effect.sleep('10 millis')
            }
            assert.strictEqual(failureEvents.length, 1)
            yield* Deferred.succeed(releaseRun, undefined)
            yield* awaitStatus(execution.executionId, 'completed')
          }).pipe(Effect.provide(layer))
        })
      ),
    20_000
  )

  it.live(
    'authenticates, deduplicates, follows up, and cancels exact Executions',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* makeTempDirectoryScoped(
            'laborer-execution-controls-'
          )
          const releaseControlled = yield* Deferred.make<void>()
          const releaseFollowUpAction = yield* Deferred.make<void>()
          const releaseUnrelated = yield* Deferred.make<void>()
          const followUpEntered = yield* Deferred.make<void>()
          const releaseFollowUp = yield* Deferred.make<void>()
          const followUps = yield* Ref.make<readonly string[]>([])
          const cancellations = yield* Ref.make(0)
          const controlled = defineAction({
            annotations: { idempotentHint: true },
            controls: {
              cancel: () =>
                Ref.update(cancellations, (count) => count + 1).pipe(
                  Effect.andThen(
                    Deferred.succeed(releaseControlled, undefined)
                  ),
                  Effect.asVoid
                ),
              followUp: (content) =>
                Ref.update(followUps, (items) => [...items, content]).pipe(
                  Effect.andThen(Deferred.succeed(followUpEntered, undefined)),
                  Effect.andThen(
                    Deferred.succeed(releaseFollowUpAction, undefined)
                  ),
                  Effect.andThen(Deferred.await(releaseFollowUp))
                ),
            },
            description: 'A controllable fixture Action',
            input: Schema.Struct({ label: Schema.String }),
            name: 'fixture/controlled',
            recoveryPolicy: 'idempotent-retry',
            result: Schema.Struct({ label: Schema.String }),
            revision: 'v1',
            run: (input) =>
              Deferred.await(
                input.label === 'follow-up'
                  ? releaseFollowUpAction
                  : releaseControlled
              ).pipe(Effect.as(input)),
          })
          const unrelated = defineAction({
            annotations: { idempotentHint: true },
            description: 'An unrelated fixture Action',
            input: Schema.Struct({ value: Schema.Number }),
            name: 'fixture/unrelated',
            recoveryPolicy: 'idempotent-retry',
            result: Schema.Struct({ value: Schema.Number }),
            revision: 'v1',
            run: (input) =>
              Deferred.await(releaseUnrelated).pipe(Effect.as(input)),
          })
          const application = defineApplication({
            actions: [controlled, unrelated],
          })
          const layer = makeRootDurableRuntimeLayer(
            makeSqliteLayer({ filename: join(directory, 'runtime.sqlite') }),
            application.actions,
            'root-control'
          )

          yield* Effect.gen(function* () {
            const runtime = yield* RootDurableRuntime
            const owner = {
              conversationId: 'conversation-control',
              workspaceId: 'T-CONTROL',
            } as const
            const controlSurface = makeExecutionControlSurface({
              ...owner,
              runtime,
            })
            assert.deepStrictEqual(
              controlSurface.map(({ name }) => name),
              ['cancel-execution', 'follow-up-execution', 'inspect-execution']
            )
            assert.ok(
              controlSurface.every(
                ({ inputSchema }) =>
                  !JSON.stringify(inputSchema).includes('actionName')
              )
            )
            const accepted = yield* runtime.startExecution({
              actionName: controlled.name,
              ...owner,
              input: { label: 'controlled' },
              invocationId: 'invocation-controlled',
              rootIdentity: 'root-control',
            })
            const other = yield* runtime.startExecution({
              actionName: unrelated.name,
              ...owner,
              input: { value: 42 },
              invocationId: 'invocation-unrelated',
              rootIdentity: 'root-control',
            })
            const steered = yield* runtime.startExecution({
              actionName: controlled.name,
              ...owner,
              input: { label: 'follow-up' },
              invocationId: 'invocation-follow-up',
              rootIdentity: 'root-control',
            })
            yield* awaitStatus(accepted.executionId, 'running')
            yield* awaitStatus(other.executionId, 'running')
            yield* awaitStatus(steered.executionId, 'running')

            const foreign = yield* Effect.flip(
              runtime.inspectExecution({
                controlId: 'inspect-foreign',
                conversationId: 'conversation-foreign',
                executionId: accepted.executionId,
                workspaceId: owner.workspaceId,
              })
            )
            assert.strictEqual(foreign.reason, 'execution-not-found')
            const inspected = yield* runtime.inspectExecution({
              controlId: 'inspect-owned',
              executionId: accepted.executionId,
              ...owner,
            })
            const inspectedAgain = yield* runtime.inspectExecution({
              controlId: 'inspect-owned',
              executionId: accepted.executionId,
              ...owner,
            })
            assert.strictEqual(inspected.execution.canCancel, true)
            assert.strictEqual(inspected.execution.canFollowUp, true)
            assert.strictEqual(inspectedAgain.deduplicated, true)
            assert.strictEqual(
              'result' in inspected.execution || 'input' in inspected.execution,
              false
            )

            const unsupported = yield* Effect.flip(
              runtime.followUpExecution({
                content: 'must remain unsupported',
                controlId: 'follow-up-unsupported',
                executionId: other.executionId,
                ...owner,
              })
            )
            assert.strictEqual(unsupported.reason, 'unsupported-control')

            const caller = yield* Effect.forkChild(
              runtime.followUpExecution({
                content: 'Use the revised fixture direction.',
                controlId: 'follow-up-1',
                executionId: steered.executionId,
                ...owner,
              })
            )
            yield* Deferred.await(followUpEntered)
            const interrupt = yield* Effect.forkChild(Fiber.interrupt(caller))

            // A control for one Execution never serializes an unrelated one.
            yield* Deferred.succeed(releaseUnrelated, undefined)
            const unrelatedTerminal = yield* awaitStatus(
              other.executionId,
              'completed'
            )
            assert.deepStrictEqual(unrelatedTerminal.result, { value: 42 })

            yield* Deferred.succeed(releaseFollowUp, undefined)
            yield* Fiber.await(interrupt)
            const replayedFollowUp = yield* runtime.followUpExecution({
              content: 'Use the revised fixture direction.',
              controlId: 'follow-up-1',
              executionId: steered.executionId,
              ...owner,
            })
            assert.strictEqual(replayedFollowUp.deduplicated, true)
            assert.deepStrictEqual(yield* Ref.get(followUps), [
              'Use the revised fixture direction.',
            ])
            yield* awaitStatus(steered.executionId, 'completed')
            const conflict = yield* Effect.flip(
              runtime.followUpExecution({
                content: 'Conflicting reuse.',
                controlId: 'follow-up-1',
                executionId: steered.executionId,
                ...owner,
              })
            )
            assert.strictEqual(conflict.reason, 'conflicting-control')

            const cancelled = yield* runtime.cancelExecution({
              controlId: 'cancel-1',
              executionId: accepted.executionId,
              ...owner,
            })
            const cancelledAgain = yield* runtime.cancelExecution({
              controlId: 'cancel-1',
              executionId: accepted.executionId,
              ...owner,
            })
            assert.strictEqual(cancelled.execution.status, 'cancelled')
            assert.strictEqual(cancelledAgain.deduplicated, true)
            assert.strictEqual(yield* Ref.get(cancellations), 1)
            yield* awaitStatus(accepted.executionId, 'cancelled')

            const lateFollowUp = yield* Effect.flip(
              runtime.followUpExecution({
                content: 'Too late.',
                controlId: 'follow-up-late',
                executionId: accepted.executionId,
                ...owner,
              })
            )
            assert.strictEqual(lateFollowUp.reason, 'execution-not-active')
            const events = yield* runtime.pendingEvents(
              owner.conversationId,
              owner.workspaceId
            )
            assert.deepStrictEqual(
              events
                .filter(
                  ({ executionId }) => executionId === accepted.executionId
                )
                .map(({ kind }) => kind),
              ['cancelled']
            )
          }).pipe(Effect.provide(layer))
        })
      ),
    20_000
  )
})
