import { join } from 'node:path'
import { layer as makeSqliteLayer } from '@effect/sql-sqlite-node/SqliteClient'
import { assert, describe, it } from '@effect/vitest'
import { Deferred, Effect, Ref, Schema } from 'effect'
import {
  ApplicationConversationMessageChunk,
  ApplicationPublicReply,
  type ApplicationShape,
  type ExternalInputEvent,
  ParticipantInputEvent,
} from '../src/application.ts'
import {
  MessageId,
  NormalizedMessage,
  ThreadId,
  TurnId,
} from '../src/core/domain.ts'
import {
  defineAction,
  defineApplication,
} from '../src/durable-runtime/action.ts'
import { applicationThroughRootConversationRuntime } from '../src/durable-runtime/conversation-application.ts'
import type { ExecutionTaskProjection } from '../src/durable-runtime/execution-task-emitter.ts'
import {
  ExecutionEvent,
  makeRootDurableRuntimeLayer,
  RootDurableRuntime,
  RUNTIME_MAX_CONCURRENT_EXECUTIONS,
  RUNTIME_PAYLOAD_MAX_BYTES,
} from '../src/durable-runtime/root-runtime.ts'
import { runConversationRpcLocally } from '../src/durable-runtime/rpc.ts'
import { makeTempDirectoryScoped } from './support/temp-directory.ts'

const waitForTerminal = Effect.fn('waitForTerminal')(function* (
  executionId: string,
  conversationId: string,
  workspaceId: string
) {
  const runtime = yield* RootDurableRuntime
  let lastStatus = 'missing'
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const snapshot = yield* runtime.getExecution(
      executionId,
      conversationId,
      workspaceId
    )
    lastStatus = snapshot.status
    if (
      snapshot.status === 'completed' ||
      snapshot.status === 'failed' ||
      snapshot.status === 'needs-attention'
    ) {
      return snapshot
    }
    yield* Effect.sleep('10 millis')
  }
  return yield* Effect.die(
    new Error(`Execution did not settle from ${lastStatus}`)
  )
})

describe('root durable runtime', () => {
  it.live(
    'emits accepted and lifecycle snapshots without duplicating replayed acceptance',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* makeTempDirectoryScoped(
            'laborer-durable-task-emission-'
          )
          const action = defineAction({
            annotations: { idempotentHint: true },
            description: 'Complete one emitted task',
            input: Schema.Struct({
              prompt: Schema.String,
              title: Schema.String,
              worktreeName: Schema.String,
            }),
            name: 'deal-with-bug',
            recoveryPolicy: 'idempotent-retry',
            result: Schema.Struct({ outcome: Schema.String }),
            revision: 'emission-v1',
            run: () => Effect.succeed({ outcome: 'done' }),
          })
          const application = defineApplication({ actions: [action] })
          const emitted: ExecutionTaskProjection[] = []
          const layer = makeRootDurableRuntimeLayer(
            makeSqliteLayer({ filename: join(directory, 'runtime.sqlite') }),
            application.actions,
            directory,
            {
              emit: (projection) =>
                Effect.sync(() => {
                  emitted.push(projection)
                }),
            }
          )
          yield* Effect.gen(function* () {
            const runtime = yield* RootDurableRuntime
            const request = {
              actionName: 'deal-with-bug',
              conversationId: 'workspace:T1:C1:1.0',
              input: {
                prompt: 'Fix it',
                title: 'Fix it',
                worktreeName: 'fix-it',
              },
              invocationId: 'emission-invocation',
              rootIdentity: directory,
              workspaceId: 'T1',
            } as const
            const execution = yield* runtime.startExecution(request)
            yield* waitForTerminal(
              execution.executionId,
              request.conversationId,
              'T1'
            )
            yield* runtime.startExecution(request)

            assert.strictEqual(
              emitted.filter(({ status }) => status === 'queued').length,
              1
            )
            assert.ok(emitted.some(({ status }) => status === 'running'))
            assert.ok(emitted.some(({ status }) => status === 'completed'))
          }).pipe(Effect.provide(layer))

          const reconciled: ExecutionTaskProjection[] = []
          const restartedLayer = makeRootDurableRuntimeLayer(
            makeSqliteLayer({ filename: join(directory, 'runtime.sqlite') }),
            application.actions,
            directory,
            {
              emit: (projection) =>
                Effect.sync(() => {
                  reconciled.push(projection)
                }),
            }
          )
          yield* RootDurableRuntime.pipe(Effect.provide(restartedLayer))
          assert.strictEqual(reconciled.length, 1)
          assert.strictEqual(reconciled[0]?.status, 'completed')
        })
      ),
    20_000
  )

  it.live(
    'runs ordered ordinary Conversation turns through Cluster and resumes one session',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* makeTempDirectoryScoped(
            'laborer-durable-conversation-runtime-'
          )
          const application = defineApplication({ actions: [] })
          const layer = makeRootDurableRuntimeLayer(
            makeSqliteLayer({ filename: join(directory, 'runtime.sqlite') }),
            application.actions,
            'root-conversation-fixture'
          )
          yield* Effect.gen(function* () {
            const runtime = yield* RootDurableRuntime
            const handled: string[] = []
            yield* runtime.attachConversationClient(
              { actionCatalogFingerprint: application.actions.fingerprint },
              'T-CONVERSATION',
              {
                handle: (event) =>
                  Effect.gen(function* () {
                    if (event._tag !== 'ParticipantInput') {
                      return yield* Effect.die('unexpected external event')
                    }
                    handled.push(event.turnId)
                    if (event.turnId === 'turn-3') {
                      return yield* Effect.fail({
                        _tag: 'ScriptedConversationFailure',
                      } as const)
                    }
                    const text = event.messages[0]?.text ?? 'missing'
                    return [
                      ApplicationConversationMessageChunk.make({
                        messageId: `message:${event.turnId}`,
                        text: `ACP ${text}`,
                      }),
                      ApplicationPublicReply.make({
                        replyId: `reply:${event.turnId}`,
                        text: `completed ${text}`,
                      }),
                    ]
                  }),
              }
            )
            const conversationId = ThreadId.make(
              'workspace:T-CONVERSATION:thread:C1:1.0'
            )
            const turn = (number: number, text: string) =>
              ParticipantInputEvent.make({
                attemptNumber: 1,
                channelId: 'C1',
                context: [],
                conversationId,
                initializationStatus: 'not_applicable',
                messages: [
                  NormalizedMessage.make({
                    authorKind: 'human',
                    authorSlackId: 'U1',
                    classification: 'input',
                    id: MessageId.make(`message-${number}`),
                    isActivation: number === 1,
                    slackTs: `${number}.0`,
                    text,
                  }),
                ],
                rootTs: '1.0',
                source: 'slack',
                turnId: TurnId.make(`turn-${number}`),
                workingDirectory: null,
              })
            const request = (event: ParticipantInputEvent) => ({
              event,
              rootIdentity: 'root-conversation-fixture',
              workspaceId: 'T-CONVERSATION',
            })

            const first = yield* runtime.runConversation(
              request(turn(1, 'hello'))
            )
            const replay = yield* runtime.runConversation(
              request(turn(1, 'hello'))
            )
            const second = yield* runtime.runConversation(
              request(turn(2, 'again'))
            )
            const incompatible = yield* Effect.flip(
              runConversationRpcLocally(runtime, {
                ...request(turn(3, 'incompatible')),
                protocolVersion: 5,
              })
            )

            assert.deepStrictEqual(handled, ['turn-1', 'turn-2'])
            assert.strictEqual(incompatible.reason, 'invalid-payload')
            assert.strictEqual(first.sequence, 1)
            assert.strictEqual(replay.sequence, 1)
            assert.strictEqual(second.sequence, 2)
            assert.strictEqual(first.sessionId, second.sessionId)
            assert.deepStrictEqual(
              first.outputs.map((output) => output.text),
              ['ACP hello', 'completed hello']
            )
            assert.deepStrictEqual(
              second.outputs.map((output) => output.text),
              ['ACP again', 'completed again']
            )
            const operatorActivity =
              yield* runtime.workThreadActivity('T-CONVERSATION')
            assert.deepStrictEqual(operatorActivity, [
              {
                channelId: 'C1',
                conversationId,
                conversationInProgress: false,
                evidenceAtUnixMs: 2000,
                excerpt: 'again',
                executions: [],
                rootTs: '1.0',
                workspaceId: 'T-CONVERSATION',
              },
            ])
            yield* runtime.attachConversationClient(
              { actionCatalogFingerprint: application.actions.fingerprint },
              'T-OTHER',
              {
                handle: (event) =>
                  event._tag === 'ParticipantInput'
                    ? Effect.succeed([
                        ApplicationConversationMessageChunk.make({
                          messageId: `other:${event.turnId}`,
                          text: 'other workspace',
                        }),
                      ])
                    : Effect.die('unexpected external event'),
              }
            )
            const otherWorkspace = yield* runtime.runConversation({
              ...request(turn(1, 'same canonical thread')),
              workspaceId: 'T-OTHER',
            })
            assert.strictEqual(otherWorkspace.sequence, 1)
            assert.notStrictEqual(otherWorkspace.sessionId, first.sessionId)
            assert.deepStrictEqual(
              otherWorkspace.outputs.map((output) => output.text),
              ['other workspace']
            )
            const failed = yield* Effect.flip(
              runtime.runConversation(request(turn(3, 'fail')))
            )
            const fourth = yield* runtime.runConversation(
              request(turn(4, 'after failure'))
            )
            assert.strictEqual(
              failed.reason,
              'conversation-handler-unavailable'
            )
            assert.strictEqual(fourth.sequence, 4)
            assert.deepStrictEqual(handled, [
              'turn-1',
              'turn-2',
              'turn-3',
              'turn-4',
            ])

            const accidentallyPublished: string[] = []
            const oversizedApplication: ApplicationShape = {
              handle: (_event, publish) =>
                publish(
                  ApplicationConversationMessageChunk.make({
                    messageId: 'oversized-output',
                    text: 'x'.repeat(RUNTIME_PAYLOAD_MAX_BYTES),
                  })
                ),
            }
            const boundedApplication =
              yield* applicationThroughRootConversationRuntime({
                actionCatalogFingerprint: application.actions.fingerprint,
                application: oversizedApplication,
                rootIdentity: 'root-conversation-fixture',
                runtime,
                workspaceId: 'T-BOUNDED',
              })
            const oversizedFailure = yield* Effect.flip(
              boundedApplication.handle(
                turn(5, 'produce oversized output'),
                (output) =>
                  Effect.sync(() => {
                    accidentallyPublished.push(output.text)
                  }),
                () => Effect.die('unexpected external event')
              )
            )
            assert.strictEqual(
              'safeDetail' in oversizedFailure
                ? oversizedFailure.safeDetail
                : undefined,
              'durable Conversation output invalid'
            )
            assert.deepStrictEqual(accidentallyPublished, [])
          }).pipe(Effect.provide(layer))
        })
      ),
    20_000
  )

  it.live(
    'hands durable Action events back to the Conversation application before publishing output',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* makeTempDirectoryScoped(
            'laborer-durable-action-delivery-'
          )
          const action = defineAction({
            annotations: { idempotentHint: true },
            description: 'Report one fixture update',
            input: Schema.Struct({ value: Schema.String }),
            name: 'fixture/report-update',
            recoveryPolicy: 'idempotent-retry',
            result: Schema.Struct({ value: Schema.String }),
            revision: 'fixture-v1',
            run: (input, context) =>
              Effect.gen(function* () {
                yield* context.reportProgress('reported', {
                  phase: 'reported',
                })
                return input
              }),
          })
          const catalog = defineApplication({ actions: [action] })
          const layer = makeRootDurableRuntimeLayer(
            makeSqliteLayer({ filename: join(directory, 'runtime.sqlite') }),
            catalog.actions,
            'root-delivery-fixture'
          )
          yield* Effect.gen(function* () {
            const runtime = yield* RootDurableRuntime
            const handledExternalEvents: string[] = []
            const acceptedExternalEvents: ExternalInputEvent[] = []
            const published: string[] = []
            const application: ApplicationShape = {
              handle: (event, publish) => {
                if (event._tag === 'ParticipantInput') {
                  return Effect.void
                }
                return Effect.gen(function* () {
                  handledExternalEvents.push(event.eventId)
                  const executionEvent = yield* Schema.decodeUnknownEffect(
                    ExecutionEvent
                  )(event.payload).pipe(Effect.orDie)
                  yield* publish(
                    ApplicationConversationMessageChunk.make({
                      messageId: `message:${event.eventId}`,
                      text: `observed ${executionEvent.kind}`,
                    })
                  )
                })
              },
            }
            const durableApplication =
              yield* applicationThroughRootConversationRuntime({
                actionCatalogFingerprint: catalog.actions.fingerprint,
                application,
                rootIdentity: 'root-delivery-fixture',
                runtime,
                workspaceId: 'T-DELIVERY',
              })
            const conversationId = ThreadId.make(
              'workspace:T-DELIVERY:thread:C1:1.0'
            )
            const acceptEvent = (event: ExternalInputEvent) =>
              Effect.sync(() => {
                acceptedExternalEvents.push(event)
                return {
                  decision: {
                    _tag: 'Accepted' as const,
                    eventId: event.eventId,
                  },
                  scheduling: 'Scheduled' as const,
                }
              })
            yield* durableApplication.handle(
              ParticipantInputEvent.make({
                attemptNumber: 1,
                channelId: 'C1',
                context: [],
                conversationId,
                initializationStatus: 'not_applicable',
                messages: [
                  NormalizedMessage.make({
                    authorKind: 'human',
                    authorSlackId: 'U1',
                    classification: 'input',
                    id: MessageId.make('message-delivery'),
                    isActivation: true,
                    slackTs: '1.0',
                    text: 'activate delivery',
                  }),
                ],
                rootTs: '1.0',
                source: 'slack',
                turnId: TurnId.make('turn-delivery'),
                workingDirectory: null,
              }),
              (output) =>
                Effect.sync(() => {
                  published.push(output.text)
                }),
              acceptEvent
            )
            const execution = yield* runtime.startExecution({
              actionName: action.name,
              conversationId,
              input: { value: 'done' },
              invocationId: 'delivery-invocation',
              rootIdentity: 'root-delivery-fixture',
              workspaceId: 'T-DELIVERY',
            })
            yield* waitForTerminal(
              execution.executionId,
              conversationId,
              'T-DELIVERY'
            )
            for (let attempt = 0; attempt < 500; attempt += 1) {
              if (acceptedExternalEvents.length === 2) {
                break
              }
              yield* Effect.sleep('10 millis')
            }

            assert.deepStrictEqual(handledExternalEvents, [])
            assert.deepStrictEqual(published, [])
            const acceptedKinds = yield* Effect.forEach(
              acceptedExternalEvents,
              (event) =>
                Schema.decodeUnknownEffect(ExecutionEvent)(event.payload).pipe(
                  Effect.map((payload) => payload.kind),
                  Effect.orDie
                )
            )
            assert.deepStrictEqual(acceptedKinds, ['progress', 'completed'])

            for (const event of acceptedExternalEvents) {
              yield* durableApplication.handle(
                event,
                (output) =>
                  Effect.sync(() => {
                    published.push(output.text)
                  }),
                acceptEvent
              )
            }
            assert.deepStrictEqual(handledExternalEvents, [
              acceptedExternalEvents[0]?.eventId,
              acceptedExternalEvents[1]?.eventId,
            ])
            assert.deepStrictEqual(published, [
              'observed progress',
              'observed completed',
            ])
          }).pipe(Effect.provide(layer))
        })
      ),
    20_000
  )

  it.live(
    'runs arbitrary registered Actions through Cluster and a SQLite outbox',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* makeTempDirectoryScoped(
            'laborer-durable-root-runtime-'
          )
          const action = defineAction({
            annotations: { idempotentHint: true },
            description: 'Render a fixture greeting',
            input: Schema.Struct({ name: Schema.String }),
            name: 'fixture/render-greeting',
            recoveryPolicy: 'idempotent-retry',
            result: Schema.Struct({ greeting: Schema.String }),
            revision: 'fixture-v1',
            run: (input, context) =>
              Effect.gen(function* () {
                yield* context.reportProgress('rendering', {
                  phase: 'rendering',
                })
                // Exact repeated reports must not enqueue a durable update twice.
                yield* context.reportProgress('rendering', {
                  phase: 'rendering',
                })
                yield* Effect.yieldNow
                return { greeting: `hello ${input.name}` }
              }),
          })
          const application = defineApplication({
            actions: [action],
          })
          const layer = makeRootDurableRuntimeLayer(
            makeSqliteLayer({ filename: join(directory, 'runtime.sqlite') }),
            application.actions,
            'root-fixture'
          )
          const scene = Effect.gen(function* () {
            const runtime = yield* RootDurableRuntime
            const request = {
              actionName: 'fixture/render-greeting',
              conversationId: 'workspace:T1:thread:C1:1.0',
              input: { name: 'Ada' },
              invocationId: 'invocation-1',
              rootIdentity: 'root-fixture',
              workspaceId: 'T1',
            } as const
            const accepted = yield* runtime.startExecution(request)
            const duplicate = yield* runtime.startExecution(request)
            assert.strictEqual(duplicate.executionId, accepted.executionId)

            const conflict = yield* Effect.result(
              runtime.startExecution({
                ...request,
                input: { name: 'Grace' },
              })
            )
            assert.strictEqual(conflict._tag, 'Failure')
            if (conflict._tag === 'Failure') {
              assert.strictEqual(
                conflict.failure.reason,
                'conflicting-invocation'
              )
            }

            const oversized = yield* Effect.flip(
              runtime.startExecution({
                ...request,
                input: { name: 'x'.repeat(64 * 1024) },
                invocationId: 'invocation-oversized',
              })
            )
            assert.strictEqual(oversized.reason, 'invalid-payload')

            const invalidLimit = yield* Effect.flip(
              runtime.pendingEvents(
                request.conversationId,
                request.workspaceId,
                Number.NaN
              )
            )
            assert.strictEqual(invalidLimit.reason, 'invalid-payload')
            for (const limit of [0, 1.5, 129]) {
              const outOfRangeLimit = yield* Effect.flip(
                runtime.pendingEvents(
                  request.conversationId,
                  request.workspaceId,
                  limit
                )
              )
              assert.strictEqual(outOfRangeLimit.reason, 'invalid-payload')
            }

            const inaccessible = yield* Effect.flip(
              runtime.getExecution(
                accepted.executionId,
                'workspace:T2:thread:C2:2.0',
                'T2'
              )
            )
            assert.strictEqual(inaccessible.reason, 'execution-not-found')

            const terminal = yield* waitForTerminal(
              accepted.executionId,
              request.conversationId,
              request.workspaceId
            )
            assert.strictEqual(terminal.status, 'completed')
            assert.deepStrictEqual(terminal.result, { greeting: 'hello Ada' })

            const events = yield* runtime.pendingEvents(
              request.conversationId,
              request.workspaceId
            )
            assert.deepStrictEqual(
              events.map(({ kind, sequence }) => ({ kind, sequence })),
              [
                { kind: 'progress', sequence: 1 },
                { kind: 'completed', sequence: 2 },
              ]
            )
            const firstEvent = events[0]
            assert.ok(firstEvent)
            yield* runtime.acknowledgeEvent(
              firstEvent.eventId,
              'workspace:T2:thread:C2:2.0',
              'T2'
            )
            const stillPending = yield* runtime.pendingEvents(
              request.conversationId,
              request.workspaceId
            )
            assert.deepStrictEqual(
              stillPending.map(({ sequence }) => sequence),
              [1, 2]
            )
            yield* runtime.acknowledgeEvent(
              firstEvent.eventId,
              request.conversationId,
              request.workspaceId
            )
            const remaining = yield* runtime.pendingEvents(
              request.conversationId,
              request.workspaceId
            )
            assert.deepStrictEqual(
              remaining.map(({ sequence }) => sequence),
              [2]
            )

            return {
              conversationId: request.conversationId,
              executionId: accepted.executionId,
            }
          })
          const evidence = yield* scene.pipe(Effect.provide(layer))
          const restartedLayer = makeRootDurableRuntimeLayer(
            makeSqliteLayer({ filename: join(directory, 'runtime.sqlite') }),
            application.actions,
            'root-fixture'
          )
          yield* Effect.gen(function* () {
            const restarted = yield* RootDurableRuntime
            const snapshot = yield* restarted.getExecution(
              evidence.executionId,
              evidence.conversationId,
              'T1'
            )
            assert.strictEqual(snapshot.status, 'completed')
            const pending = yield* restarted.pendingEvents(
              evidence.conversationId,
              'T1'
            )
            assert.deepStrictEqual(
              pending.map(({ kind, sequence }) => ({ kind, sequence })),
              [{ kind: 'completed', sequence: 2 }]
            )
          }).pipe(Effect.provide(restartedLayer))
        })
      ),
    20_000
  )

  it.live(
    'keeps concurrent Action progress and failures in their owning Conversation streams',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* makeTempDirectoryScoped(
            'laborer-concurrent-actions-'
          )
          const release = yield* Deferred.make<void>()
          const active = yield* Ref.make(0)
          const maximumActive = yield* Ref.make(0)
          const enter = Effect.gen(function* () {
            const count = yield* Ref.updateAndGet(active, (value) => value + 1)
            yield* Ref.update(maximumActive, (value) => Math.max(value, count))
          })
          const leave = Ref.update(active, (value) => value - 1)
          const waitForRelease = Effect.acquireUseRelease(
            enter,
            () => Deferred.await(release),
            () => leave
          )
          const render = defineAction({
            annotations: { idempotentHint: true },
            description: 'Render an isolated fixture artifact',
            input: Schema.Struct({ label: Schema.String }),
            name: 'fixture/render-artifact',
            recoveryPolicy: 'idempotent-retry',
            result: Schema.Struct({ artifact: Schema.String }),
            revision: 'render-v7',
            run: ({ label }, context) =>
              Effect.gen(function* () {
                yield* context.reportProgress('started', {
                  phase: 'rendering',
                })
                yield* context.reportProgress('started', {
                  phase: 'rendering',
                })
                yield* waitForRelease
                return { artifact: `rendered:${label}` }
              }),
          })
          const count = defineAction({
            annotations: { idempotentHint: true },
            description: 'Count an unrelated fixture quantity',
            input: Schema.Struct({ quantity: Schema.Number }),
            name: 'fixture/count-artifacts',
            recoveryPolicy: 'idempotent-retry',
            result: Schema.Struct({ total: Schema.Number }),
            revision: 'count-v3',
            run: ({ quantity }, context) =>
              Effect.gen(function* () {
                yield* context.reportProgress('counting', { quantity })
                yield* waitForRelease
                return { total: quantity * 2 }
              }),
          })
          const declaredFailure = defineAction({
            description: 'Fail through the declared Effect error channel',
            input: Schema.Struct({ code: Schema.String }),
            name: 'fixture/declared-failure',
            result: Schema.Struct({ unreachable: Schema.Boolean }),
            revision: 'declared-v1',
            run: () => Effect.fail({ privateReason: 'fixture declaration' }),
          })
          const unexpectedFailure = defineAction({
            description: 'Defect without exposing private diagnostics',
            input: Schema.Struct({ trigger: Schema.Boolean }),
            name: 'fixture/unexpected-failure',
            result: Schema.Struct({ unreachable: Schema.Boolean }),
            revision: 'unexpected-v1',
            run: () => Effect.die(new Error('private fixture diagnostic')),
          })
          const application = defineApplication({
            actions: [render, count, declaredFailure, unexpectedFailure],
          })
          const layer = makeRootDurableRuntimeLayer(
            makeSqliteLayer({ filename: join(directory, 'runtime.sqlite') }),
            application.actions,
            'root-concurrency-fixture'
          )
          yield* Effect.gen(function* () {
            const runtime = yield* RootDurableRuntime
            const observed = new Map<
              string,
              { readonly kind: string; readonly sequence: number }[]
            >()
            const participantTurns: string[] = []
            const register = (workspaceId: string) =>
              runtime.attachConversationClient(
                { actionCatalogFingerprint: application.actions.fingerprint },
                workspaceId,
                {
                  handle: (event) =>
                    Effect.gen(function* () {
                      if (event._tag === 'ParticipantInput') {
                        participantTurns.push(event.turnId)
                        return [
                          ApplicationConversationMessageChunk.make({
                            messageId: `ordinary:${event.turnId}`,
                            text: 'Conversation handled ordinary input.',
                          }),
                        ]
                      }
                      const executionEvent = yield* Schema.decodeUnknownEffect(
                        ExecutionEvent,
                        {
                          onExcessProperty: 'error',
                        }
                      )(event.payload)
                      const prior =
                        observed.get(executionEvent.executionId) ?? []
                      observed.set(executionEvent.executionId, [
                        ...prior,
                        {
                          kind: executionEvent.kind,
                          sequence: executionEvent.sequence,
                        },
                      ])
                      assert.strictEqual(
                        executionEvent.workspaceId,
                        workspaceId
                      )
                      return [
                        ApplicationConversationMessageChunk.make({
                          messageId: `execution-summary:${event.eventId}`,
                          text: `Conversation observed ${executionEvent.kind}.`,
                        }),
                      ]
                    }),
                }
              )
            yield* register('T-CONCURRENT-A')
            const conversationA = ThreadId.make(
              'workspace:T-CONCURRENT-A:thread:C1:1.0'
            )
            const conversationB = ThreadId.make(
              'workspace:T-CONCURRENT-B:thread:C1:1.0'
            )
            const turn = (
              conversationId: ThreadId,
              turnId: string,
              text: string
            ) =>
              ParticipantInputEvent.make({
                attemptNumber: 1,
                channelId: 'C1',
                context: [],
                conversationId,
                initializationStatus: 'not_applicable',
                messages: [
                  NormalizedMessage.make({
                    authorKind: 'human',
                    authorSlackId: 'U1',
                    classification: 'input',
                    id: MessageId.make(`message:${turnId}`),
                    isActivation: true,
                    slackTs: '1.0',
                    text,
                  }),
                ],
                rootTs: '1.0',
                source: 'slack',
                turnId: TurnId.make(turnId),
                workingDirectory: null,
              })
            const runTurn = (
              workspaceId: string,
              conversationId: ThreadId,
              turnId: string,
              text: string
            ) =>
              runtime.runConversation({
                event: turn(conversationId, turnId, text),
                rootIdentity: 'root-concurrency-fixture',
                workspaceId,
              })
            yield* runTurn(
              'T-CONCURRENT-A',
              conversationA,
              'turn-A-1',
              'activate A'
            )
            yield* Effect.scoped(
              Effect.gen(function* () {
                yield* register('T-CONCURRENT-B')
                yield* runTurn(
                  'T-CONCURRENT-B',
                  conversationB,
                  'turn-B-1',
                  'activate B'
                )
              })
            )

            const successRequests = Array.from(
              { length: RUNTIME_MAX_CONCURRENT_EXECUTIONS + 2 },
              (_, index) => {
                const even = index % 2 === 0
                return {
                  actionName: even
                    ? 'fixture/render-artifact'
                    : 'fixture/count-artifacts',
                  conversationId: even ? conversationA : conversationB,
                  input: even
                    ? { label: `artifact-${index}` }
                    : { quantity: index },
                  invocationId: `success-${index}`,
                  rootIdentity: 'root-concurrency-fixture',
                  workspaceId: even ? 'T-CONCURRENT-A' : 'T-CONCURRENT-B',
                } as const
              }
            )
            const successes = yield* Effect.forEach(
              successRequests,
              runtime.startExecution,
              { concurrency: 'unbounded' }
            )
            for (let attempt = 0; attempt < 500; attempt += 1) {
              if (
                (yield* Ref.get(active)) === RUNTIME_MAX_CONCURRENT_EXECUTIONS
              ) {
                break
              }
              yield* Effect.sleep('10 millis')
            }
            assert.strictEqual(
              yield* Ref.get(active),
              RUNTIME_MAX_CONCURRENT_EXECUTIONS
            )
            const ordinary = yield* runTurn(
              'T-CONCURRENT-A',
              conversationA,
              'turn-A-ordinary',
              'continue while Actions run'
            )
            assert.strictEqual(ordinary.sequence > 1, true)
            yield* Deferred.succeed(release, undefined)

            const declared = yield* runtime.startExecution({
              actionName: 'fixture/declared-failure',
              conversationId: conversationA,
              input: { code: 'DECLARED' },
              invocationId: 'declared-failure',
              rootIdentity: 'root-concurrency-fixture',
              workspaceId: 'T-CONCURRENT-A',
            })
            const unexpected = yield* runtime.startExecution({
              actionName: 'fixture/unexpected-failure',
              conversationId: conversationB,
              input: { trigger: true },
              invocationId: 'unexpected-failure',
              rootIdentity: 'root-concurrency-fixture',
              workspaceId: 'T-CONCURRENT-B',
            })
            const settledSuccesses = yield* Effect.forEach(
              successes,
              (execution) =>
                waitForTerminal(
                  execution.executionId,
                  execution.conversationId,
                  execution.workspaceId
                ),
              { concurrency: 'unbounded' }
            )
            const settledDeclared = yield* waitForTerminal(
              declared.executionId,
              conversationA,
              'T-CONCURRENT-A'
            )
            const settledUnexpected = yield* waitForTerminal(
              unexpected.executionId,
              conversationB,
              'T-CONCURRENT-B'
            )
            assert.ok(
              settledSuccesses.every(({ status }) => status === 'completed')
            )
            assert.strictEqual(settledDeclared.failureCategory, 'action-failed')
            assert.strictEqual(
              settledUnexpected.failureCategory,
              'unexpected-failure'
            )
            assert.strictEqual(
              (yield* Ref.get(maximumActive)) <=
                RUNTIME_MAX_CONCURRENT_EXECUTIONS,
              true
            )

            // B's Actions completed with no Conversation client attached.
            // A replacement handler must receive their already-durable wakes.
            yield* register('T-CONCURRENT-B')
            const expectedEventCount = successes.length * 2 + 2
            for (let attempt = 0; attempt < 500; attempt += 1) {
              const countObserved = [...observed.values()].reduce(
                (total, events) => total + events.length,
                0
              )
              if (countObserved === expectedEventCount) {
                break
              }
              yield* Effect.sleep('10 millis')
            }
            assert.strictEqual(observed.size, successes.length + 2)
            for (const execution of successes) {
              assert.deepStrictEqual(observed.get(execution.executionId), [
                { kind: 'progress', sequence: 1 },
                { kind: 'completed', sequence: 2 },
              ])
            }
            assert.deepStrictEqual(observed.get(declared.executionId), [
              { kind: 'failed', sequence: 1 },
            ])
            assert.deepStrictEqual(observed.get(unexpected.executionId), [
              { kind: 'failed', sequence: 1 },
            ])
            assert.deepStrictEqual(participantTurns, [
              'turn-A-1',
              'turn-B-1',
              'turn-A-ordinary',
            ])
            const wrongWorkspace = yield* Effect.flip(
              runtime.getExecution(
                successes[0]?.executionId ?? 'missing',
                conversationA,
                'T-CONCURRENT-B'
              )
            )
            assert.strictEqual(wrongWorkspace.reason, 'execution-not-found')
          }).pipe(Effect.provide(layer))
        })
      ),
    20_000
  )

  it.live('encodes transformed Action results for durable storage', () =>
    Effect.gen(function* () {
      const action = defineAction({
        description: 'Exercise transformed durable values',
        input: Schema.Struct({ value: Schema.NumberFromString }),
        name: 'fixture/transformed-values',
        result: Schema.Struct({ doubled: Schema.NumberFromString }),
        revision: 'fixture-v1',
        run: ({ value }) => Effect.succeed({ doubled: value * 2 }),
      })
      const result = yield* action.execute(
        { value: '21' },
        {
          conversationId: 'conversation-fixture',
          executionId: 'execution-fixture',
          reportProgress: () => Effect.void,
          rootIdentity: 'root-fixture',
        }
      )
      assert.deepStrictEqual(result, { doubled: 42 })
      const encoded = yield* action.encodeResult(result)
      assert.deepStrictEqual(encoded, { doubled: '42' })
    })
  )

  it('rejects conflicting registrations before publishing a catalog', () => {
    const action = defineAction({
      description: 'One fixture Action',
      input: Schema.Struct({ value: Schema.String }),
      name: 'fixture/action',
      result: Schema.Struct({ value: Schema.String }),
      revision: 'v1',
      run: (input) => Effect.succeed(input),
    })
    assert.throws(() => defineApplication({ actions: [action, action] }))
    assert.throws(() =>
      defineAction({
        annotations: { idempotentHint: false },
        description: 'Unsafe retry declaration',
        input: Schema.String,
        name: 'fixture/unsafe-retry',
        recoveryPolicy: 'idempotent-retry',
        result: Schema.String,
        revision: 'v1',
        run: (input) => Effect.succeed(input),
      })
    )
    assert.throws(() =>
      defineAction({
        annotations: {
          readOnlyHint: 'yes' as unknown as boolean,
        },
        description: 'Malformed annotations',
        input: Schema.String,
        name: 'fixture/malformed-annotations',
        result: Schema.String,
        revision: 'v1',
        run: (input) => Effect.succeed(input),
      })
    )
    assert.throws(() =>
      defineAction({
        description: 'Malformed recovery policy',
        input: Schema.String,
        name: 'fixture/malformed-recovery',
        recoveryPolicy: 'retry-eventually' as 'fail-closed',
        result: Schema.String,
        revision: 'v1',
        run: (input) => Effect.succeed(input),
      })
    )
    assert.throws(() =>
      defineAction({
        annotations: {
          unsupportedHint: true,
        } as unknown as { readOnlyHint: boolean },
        description: 'Unknown annotation key',
        input: Schema.String,
        name: 'fixture/unknown-annotation',
        result: Schema.String,
        revision: 'v1',
        run: (input) => Effect.succeed(input),
      })
    )
    assert.throws(() =>
      defineAction({
        description: 'Oversized generated schema metadata',
        input: Schema.String.annotate({
          description: 'x'.repeat(64 * 1024),
        }),
        name: 'fixture/oversized-schema',
        result: Schema.String,
        revision: 'v1',
        run: (input) => Effect.succeed(input),
      })
    )
  })

  it('keeps the compatibility fingerprint independent of prose', () => {
    const makeAction = (description: string) =>
      defineAction({
        annotations: { readOnlyHint: true },
        description,
        input: Schema.Struct({ value: Schema.String }),
        name: 'fixture/fingerprint',
        result: Schema.Struct({ value: Schema.String }),
        revision: 'v1',
        run: (input) => Effect.succeed(input),
      })
    const first = defineApplication({
      actions: [makeAction('First model-facing description')],
    })
    const second = defineApplication({
      actions: [makeAction('Updated model-facing description')],
    })
    assert.strictEqual(first.actions.fingerprint, second.actions.fingerprint)
    assert.strictEqual(
      first.actions.actions[0]?.fingerprint,
      second.actions.actions[0]?.fingerprint
    )
  })

  it('changes registration identity when a schema changes under one revision', () => {
    const stringAction = defineAction({
      description: 'String-shaped registration',
      input: Schema.Struct({ value: Schema.String }),
      name: 'fixture/revision-integrity',
      result: Schema.String,
      revision: 'v1',
      run: ({ value }) => Effect.succeed(value),
    })
    const numberAction = defineAction({
      description: 'Number-shaped registration',
      input: Schema.Struct({ value: Schema.Number }),
      name: 'fixture/revision-integrity',
      result: Schema.String,
      revision: 'v1',
      run: ({ value }) => Effect.succeed(String(value)),
    })
    assert.notStrictEqual(stringAction.fingerprint, numberAction.fingerprint)
  })

  it.live('distinguishes malformed results from Action failures', () =>
    Effect.gen(function* () {
      const context = {
        conversationId: 'conversation-fixture',
        executionId: 'execution-fixture',
        reportProgress: () => Effect.void,
        rootIdentity: 'root-fixture',
      }
      const malformed = defineAction({
        description: 'Return a malformed fixture result',
        input: Schema.Null,
        name: 'fixture/malformed-result',
        result: Schema.Struct({ value: Schema.String }),
        revision: 'v1',
        run: () =>
          Effect.succeed({ value: 42 } as unknown as { value: string }),
      })
      const malformedFailure = yield* Effect.flip(
        malformed.execute(null, context)
      )
      assert.ok(
        typeof malformedFailure === 'object' &&
          malformedFailure !== null &&
          'reason' in malformedFailure
      )
      if (
        typeof malformedFailure === 'object' &&
        malformedFailure !== null &&
        'reason' in malformedFailure
      ) {
        assert.strictEqual(malformedFailure.reason, 'invalid-result')
      }

      const expectedFailure = new Error('fixture Action failure')
      const failing = defineAction({
        description: 'Fail in user-controlled Action code',
        input: Schema.Null,
        name: 'fixture/failing',
        result: Schema.String,
        revision: 'v1',
        run: () => Effect.fail(expectedFailure),
      })
      const actionFailure = yield* Effect.flip(failing.execute(null, context))
      assert.strictEqual(actionFailure, expectedFailure)
    })
  )
})
