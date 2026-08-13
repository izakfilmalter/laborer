import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { assert, describe, it } from '@effect/vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { Deferred, Effect, Exit, Ref, Scope } from 'effect'
import { makeAcpAuthorityRepository } from '../src/acp-runtime/acp-authority.ts'
import { preflightReservedMcpNames } from '../src/acp-runtime/acp-config-source-inventory.ts'
import { makeLaborerActionMcpBridge } from '../src/acp-runtime/action-mcp.ts'
import { productionActionCatalog } from '../src/action-catalog.ts'
import { ExternalInputEvent } from '../src/application.ts'
import { ThreadId } from '../src/core/domain.ts'
import { productionGeneratedMutationCatalog } from '../src/generated-mutation-catalog.ts'
import {
  type ConversationAction,
  type ConversationExecutionControl,
  ImplementationAgent,
  makeFileApplicationRepository,
  makeReferenceCodingApplication,
  type TrustedActionInvocation,
  WorktreeManager,
} from '../src/reference-coding-application.ts'
import { makeTempDirectoryScoped } from './support/temp-directory.ts'

const allowRequest = (options: {
  readonly input: unknown
  readonly permission: string
  readonly sessionId: string
  readonly toolCallId: string
}) => ({
  options: [
    {
      kind: 'allow_once' as const,
      name: 'Allow once',
      optionId: 'allow-action-once',
    },
    {
      kind: 'reject_once' as const,
      name: 'Reject',
      optionId: 'reject-action',
    },
  ],
  sessionId: options.sessionId,
  toolCall: {
    kind: 'other' as const,
    rawInput: options.input,
    status: 'pending' as const,
    title: options.permission,
    toolCallId: options.toolCallId,
  },
})

describe('private Action MCP bridge', () => {
  it.effect(
    'routes prompt-execution through the shared generated bridge',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            'laborer-execution-control-mcp-'
          )
          const conversationId = ThreadId.make(
            'workspace:T247CONTROL:C247:247.1'
          )
          const repository = yield* makeFileApplicationRepository(
            join(root, 'application.json'),
            root
          )
          const controlRef =
            yield* Ref.make<ConversationExecutionControl | null>(null)
          const inspectRef =
            yield* Ref.make<ConversationExecutionControl | null>(null)
          const foreignControlRef =
            yield* Ref.make<ConversationExecutionControl | null>(null)
          const executionIdRef = yield* Ref.make<string | null>(null)
          const resumes = yield* Ref.make(0)
          const cancellationOperationIds: string[] = []
          const finishInitial = yield* Deferred.make<void>()
          const application = yield* makeReferenceCodingApplication({
            conversationAgent: {
              handle: (request) =>
                Effect.gen(function* () {
                  if (request.conversationId !== conversationId) {
                    const foreignControl = request.executionControls.find(
                      (candidate) => candidate.name === 'prompt-execution'
                    )
                    assert.ok(foreignControl)
                    yield* Ref.set(foreignControlRef, foreignControl)
                    return []
                  }
                  const action = request.actions.find(
                    (candidate) => candidate.name === 'create-feature'
                  )
                  const control = request.executionControls.find(
                    (candidate) => candidate.name === 'prompt-execution'
                  )
                  const inspect = request.executionControls.find(
                    (candidate) => candidate.name === 'inspect-executions'
                  )
                  assert.ok(action)
                  assert.ok(control)
                  assert.ok(inspect)
                  const started = yield* action.invoke({
                    prompt: 'Start generated control work.',
                    title: 'Execution task',
                    worktreeName: 'generated-control-work',
                  })
                  yield* Ref.set(executionIdRef, started.executionId)
                  yield* Ref.set(controlRef, control)
                  yield* Ref.set(inspectRef, inspect)
                  return []
                }),
            },
            implementationAgent: ImplementationAgent.of({
              start: (request) =>
                Effect.succeed({
                  completion: Deferred.await(finishInitial),
                  resume: () => Ref.update(resumes, (count) => count + 1),
                  sessionId: request.implementationSessionId,
                }),
            }),
            repository,
            worktreeManager: WorktreeManager.of({
              create: () =>
                Effect.succeed({ workingDirectory: join(root, 'worktree') }),
            }),
          })
          yield* application.handle(
            ExternalInputEvent.make({
              conversationId,
              eventId: 'event:generated-control-start',
              payload: {},
              source: 'test',
            }),
            () => Effect.void,
            (event) =>
              Effect.succeed({
                decision: {
                  _tag: 'Accepted' as const,
                  eventId: event.eventId,
                },
                scheduling: 'Scheduled' as const,
              })
          )
          const executionId = yield* Ref.get(executionIdRef)
          const control = yield* Ref.get(controlRef)
          const inspect = yield* Ref.get(inspectRef)
          assert.ok(executionId)
          assert.ok(control)
          assert.ok(inspect)
          const authority = yield* makeAcpAuthorityRepository({
            keyPath: join(root, 'authority.key'),
            statePath: join(root, 'authority.json'),
            trustedRoot: root,
          })
          const cancelControl: ConversationExecutionControl = {
            description: 'Cancel an owned Execution',
            invoke: (_input, trustedInvocation) => {
              assert.ok(trustedInvocation)
              const deduplicated = cancellationOperationIds.includes(
                trustedInvocation.operationId
              )
              cancellationOperationIds.push(trustedInvocation.operationId)
              return Effect.succeed({
                deduplicated,
                execution: {
                  actionName: 'create-feature',
                  canCancel: false,
                  canPrompt: false,
                  executionId: 'execution-control-duplicate-249',
                  status: 'cancelled',
                  worktreeName: 'preserved-control-worktree',
                },
                schemaVersion: 1,
              } as never)
            },
            name: 'cancel-execution',
          }
          const bridge = yield* makeLaborerActionMcpBridge({
            authorityRepository: authority,
            bootstrapPath: join(root, 'bootstrap'),
            processGeneration: 247,
            root,
            rootAuthority: 'execution-control-root',
            statePath: join(root, 'capabilities.json'),
            trustedRuntimeRoot: root,
            workspaceId: 'T247CONTROL',
          })
          const registration = yield* bridge.prepareRegistration
          const client = new Client({
            name: 'execution-control',
            version: '1',
          })
          const transport = new StdioClientTransport({
            args: [...registration.server.args],
            command: registration.server.command,
            env: Object.fromEntries(
              registration.server.env.map(({ name, value }) => [name, value])
            ),
            stderr: 'pipe',
          })
          yield* Effect.acquireRelease(
            Effect.promise(() => client.connect(transport)),
            () => Effect.promise(() => client.close())
          )
          yield* bridge.awaitReadiness(registration)
          const sessionId = 'session-control-247'
          const input = {
            executionId,
            prompt: 'Continue safely.',
          }
          const permission = `${bridge.serverName}_prompt-execution`
          const toolCallId = 'control-call-247'
          const closeTurn = yield* bridge.activateTurn({
            actionServerGeneration: registration.actionServerGeneration,
            actions: [],
            controls: [control, inspect, cancelControl],
            scope: {
              bindingGeneration: 1,
              channelId: 'C247',
              conversationId,
              processGeneration: 247,
              promptId: 'prompt-control-247',
              rootTs: '247.1',
              sessionId,
              turnId: 'turn-control-247',
              workspaceId: 'T247CONTROL',
            },
          })
          const inspectInput = { limit: 20 }
          const inspectPermission = `${bridge.serverName}_inspect-executions`
          const inspectToolCallId = 'inspect-call-247'
          bridge.observeToolCall({
            sessionId,
            update: {
              kind: 'other',
              name: inspectPermission,
              rawInput: inspectInput,
              sessionUpdate: 'tool_call',
              status: 'pending',
              title: inspectPermission,
              toolCallId: inspectToolCallId,
            },
          })
          assert.strictEqual(
            (yield* bridge.tryAuthorizePermission(
              allowRequest({
                input: inspectInput,
                permission: inspectPermission,
                sessionId,
                toolCallId: inspectToolCallId,
              })
            ))?.outcome.outcome,
            'selected'
          )
          const inspected = yield* Effect.promise(() =>
            client.callTool({
              arguments: inspectInput,
              name: 'inspect-executions',
            })
          )
          assert.deepStrictEqual(inspected.structuredContent, {
            executions: [
              {
                actionName: 'create-feature',
                canCancel: false,
                canPrompt: true,
                executionId,
                status: 'running',
                worktreeName: 'generated-control-work',
              },
            ],
            schemaVersion: 1,
            truncated: false,
          })
          assert.ok(
            Buffer.byteLength(JSON.stringify(inspected.structuredContent)) <
              64 * 1024
          )
          const cancelInput = {
            executionId: 'execution-control-duplicate-249',
          }
          const cancelPermission = `${bridge.serverName}_cancel-execution`
          for (const cancelToolCallId of [
            'cancel-call-249-first',
            'cancel-call-249-second',
          ]) {
            bridge.observeToolCall({
              sessionId,
              update: {
                kind: 'other',
                name: cancelPermission,
                rawInput: cancelInput,
                sessionUpdate: 'tool_call',
                status: 'pending',
                title: cancelPermission,
                toolCallId: cancelToolCallId,
              },
            })
            assert.strictEqual(
              (yield* bridge.tryAuthorizePermission(
                allowRequest({
                  input: cancelInput,
                  permission: cancelPermission,
                  sessionId,
                  toolCallId: cancelToolCallId,
                })
              ))?.outcome.outcome,
              'selected'
            )
            const result = yield* Effect.promise(() =>
              client.callTool({
                arguments: cancelInput,
                name: 'cancel-execution',
              })
            )
            assert.strictEqual(result.isError, undefined)
          }
          const cancellationRetry = yield* Effect.promise(() =>
            client.callTool({
              arguments: cancelInput,
              name: 'cancel-execution',
            })
          )
          assert.deepStrictEqual(cancellationRetry.structuredContent, {
            deduplicated: true,
            execution: {
              actionName: 'create-feature',
              canCancel: false,
              canPrompt: false,
              executionId: 'execution-control-duplicate-249',
              status: 'cancelled',
              worktreeName: 'preserved-control-worktree',
            },
            schemaVersion: 1,
          })
          assert.strictEqual(cancellationOperationIds.length, 3)
          assert.strictEqual(new Set(cancellationOperationIds).size, 1)
          bridge.observeToolCall({
            sessionId,
            update: {
              kind: 'other',
              name: permission,
              rawInput: input,
              sessionUpdate: 'tool_call',
              status: 'pending',
              title: permission,
              toolCallId,
            },
          })
          assert.strictEqual(
            (yield* bridge.tryAuthorizePermission(
              allowRequest({ input, permission, sessionId, toolCallId })
            ))?.outcome.outcome,
            'selected'
          )
          const first = yield* Effect.promise(() =>
            client.callTool({ arguments: input, name: 'prompt-execution' })
          )
          const duplicate = yield* Effect.promise(() =>
            client.callTool({ arguments: input, name: 'prompt-execution' })
          )
          assert.deepStrictEqual(first.structuredContent, {
            deduplicated: false,
            executionId,
            status: 'running',
          })
          assert.deepStrictEqual(duplicate.structuredContent, {
            deduplicated: true,
            executionId,
            status: 'running',
          })
          assert.strictEqual(
            (yield* repository.load).executions[0]?.prompts.length,
            2
          )
          yield* Deferred.succeed(finishInitial, undefined)
          for (let attempt = 0; attempt < 100; attempt += 1) {
            if (
              (yield* Ref.get(resumes)) === 1 &&
              (yield* repository.load).executions[0]?.status === 'completed'
            ) {
              break
            }
            yield* Effect.promise(
              () => new Promise<void>((resolve) => setTimeout(resolve, 5))
            )
          }
          assert.strictEqual(
            (yield* repository.load).executions[0]?.status,
            'completed'
          )
          assert.strictEqual(yield* Ref.get(resumes), 1)
          yield* closeTurn

          const completedSessionId = 'session-control-247-completed'
          const completedInput = {
            executionId,
            prompt: 'Continue completed work.',
          }
          const closeCompletedTurn = yield* bridge.activateTurn({
            actionServerGeneration: registration.actionServerGeneration,
            actions: [],
            controls: [control],
            scope: {
              bindingGeneration: 2,
              channelId: 'C247',
              conversationId,
              processGeneration: 247,
              promptId: 'prompt-control-247-completed',
              rootTs: '247.1',
              sessionId: completedSessionId,
              turnId: 'turn-control-247-completed',
              workspaceId: 'T247CONTROL',
            },
          })
          const completedToolCallId = 'control-call-247-completed'
          bridge.observeToolCall({
            sessionId: completedSessionId,
            update: {
              kind: 'other',
              name: permission,
              rawInput: completedInput,
              sessionUpdate: 'tool_call',
              status: 'pending',
              title: permission,
              toolCallId: completedToolCallId,
            },
          })
          assert.strictEqual(
            (yield* bridge.tryAuthorizePermission(
              allowRequest({
                input: completedInput,
                permission,
                sessionId: completedSessionId,
                toolCallId: completedToolCallId,
              })
            ))?.outcome.outcome,
            'selected'
          )
          const completedResult = yield* Effect.promise(() =>
            client.callTool({
              arguments: completedInput,
              name: 'prompt-execution',
            })
          )
          assert.strictEqual(completedResult.isError, undefined)
          for (let attempt = 0; attempt < 100; attempt += 1) {
            if ((yield* Ref.get(resumes)) === 2) {
              break
            }
            yield* Effect.promise(
              () => new Promise<void>((resolve) => setTimeout(resolve, 5))
            )
          }
          assert.strictEqual(yield* Ref.get(resumes), 2)
          assert.strictEqual(
            (yield* repository.load).executions[0]?.prompts.length,
            3
          )
          for (let attempt = 0; attempt < 100; attempt += 1) {
            if (
              (yield* repository.load).executions[0]?.status === 'completed'
            ) {
              break
            }
            yield* Effect.promise(
              () => new Promise<void>((resolve) => setTimeout(resolve, 5))
            )
          }
          yield* closeCompletedTurn

          const changedInput = {
            ...completedInput,
            prompt: 'Conflicting completed follow-up.',
          }
          const changedSessionId = 'session-control-247-changed'
          const closeChangedTurn = yield* bridge.activateTurn({
            actionServerGeneration: registration.actionServerGeneration,
            actions: [],
            controls: [control],
            scope: {
              bindingGeneration: 3,
              channelId: 'C247',
              conversationId,
              processGeneration: 247,
              promptId: 'prompt-control-247-completed',
              rootTs: '247.1',
              sessionId: changedSessionId,
              turnId: 'turn-control-247-completed',
              workspaceId: 'T247CONTROL',
            },
          })
          const changedToolCallId = 'control-call-247-changed'
          bridge.observeToolCall({
            sessionId: changedSessionId,
            update: {
              kind: 'other',
              name: permission,
              rawInput: changedInput,
              sessionUpdate: 'tool_call',
              status: 'pending',
              title: permission,
              toolCallId: changedToolCallId,
            },
          })
          assert.strictEqual(
            (yield* bridge.tryAuthorizePermission(
              allowRequest({
                input: changedInput,
                permission,
                sessionId: changedSessionId,
                toolCallId: changedToolCallId,
              })
            ))?.outcome.outcome,
            'selected'
          )
          const changedResult = yield* Effect.promise(() =>
            client.callTool({
              arguments: changedInput,
              name: 'prompt-execution',
            })
          )
          assert.strictEqual(changedResult.isError, true)
          assert.strictEqual(
            (yield* repository.load).executions[0]?.prompts.length,
            3
          )
          yield* closeChangedTurn

          const foreignConversationId = ThreadId.make(
            'workspace:T247CONTROL:C247:247.2'
          )
          yield* application.handle(
            ExternalInputEvent.make({
              conversationId: foreignConversationId,
              eventId: 'event:generated-control-foreign',
              payload: {},
              source: 'test',
            }),
            () => Effect.void,
            (event) =>
              Effect.succeed({
                decision: {
                  _tag: 'Accepted' as const,
                  eventId: event.eventId,
                },
                scheduling: 'Scheduled' as const,
              })
          )
          const foreignControl = yield* Ref.get(foreignControlRef)
          assert.ok(foreignControl)
          const beforeForeign = JSON.stringify(yield* repository.load)
          const foreignSessionId = 'session-control-247-foreign'
          const closeForeignTurn = yield* bridge.activateTurn({
            actionServerGeneration: registration.actionServerGeneration,
            actions: [],
            controls: [foreignControl],
            scope: {
              bindingGeneration: 4,
              channelId: 'C247',
              conversationId: foreignConversationId,
              processGeneration: 247,
              promptId: 'prompt-control-247-foreign',
              rootTs: '247.2',
              sessionId: foreignSessionId,
              turnId: 'turn-control-247-foreign',
              workspaceId: 'T247CONTROL',
            },
          })
          const foreignToolCallId = 'control-call-247-foreign'
          bridge.observeToolCall({
            sessionId: foreignSessionId,
            update: {
              kind: 'other',
              name: permission,
              rawInput: completedInput,
              sessionUpdate: 'tool_call',
              status: 'pending',
              title: permission,
              toolCallId: foreignToolCallId,
            },
          })
          assert.strictEqual(
            (yield* bridge.tryAuthorizePermission(
              allowRequest({
                input: completedInput,
                permission,
                sessionId: foreignSessionId,
                toolCallId: foreignToolCallId,
              })
            ))?.outcome.outcome,
            'selected'
          )
          const foreignResult = yield* Effect.promise(() =>
            client.callTool({
              arguments: completedInput,
              name: 'prompt-execution',
            })
          )
          assert.strictEqual(foreignResult.isError, true)
          assert.strictEqual(
            JSON.stringify(yield* repository.load),
            beforeForeign
          )
          assert.strictEqual(yield* Ref.get(resumes), 2)
          yield* closeForeignTurn
        })
      ),
    20_000
  )

  it.effect(
    'rejects malformed, wrong-tagged, incomplete, and excess raw handler results',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const invalidResults: readonly {
            readonly label: string
            readonly value: unknown
          }[] = [
            { label: 'malformed', value: 'not-an-action-result' },
            {
              label: 'wrong-tag',
              value: {
                actionName: 'create-feature',
                deduplicated: false,
                executionId: 'execution:wrong-tag',
                status: 'running',
              },
            },
            {
              label: 'missing-deduplicated',
              value: {
                actionName: 'deal-with-bug',
                executionId: 'execution:missing-deduplicated',
                status: 'running',
              },
            },
            {
              label: 'private-extra',
              value: {
                actionName: 'deal-with-bug',
                deduplicated: false,
                executionId: 'execution:private-extra',
                privatePath: '/private/raw-handler-secret-248',
                status: 'running',
              },
            },
          ]
          for (const invalid of invalidResults) {
            yield* Effect.scoped(
              Effect.gen(function* () {
                const root = yield* makeTempDirectoryScoped(
                  `laborer-action-invalid-result-${invalid.label}-`
                )
                const statePath = join(root, 'capabilities.json')
                const authority = yield* makeAcpAuthorityRepository({
                  keyPath: join(root, 'authority.key'),
                  statePath: join(root, 'authority.json'),
                  trustedRoot: root,
                })
                const bridge = yield* makeLaborerActionMcpBridge({
                  authorityRepository: authority,
                  bootstrapPath: join(root, 'bootstrap'),
                  processGeneration: 248,
                  root,
                  rootAuthority: 'invalid-result-root',
                  statePath,
                  trustedRuntimeRoot: root,
                  workspaceId: 'T248INVALIDRESULT',
                })
                const registration = yield* bridge.prepareRegistration
                const client = new Client({
                  name: `invalid-result-${invalid.label}`,
                  version: '1.0.0',
                })
                const transport = new StdioClientTransport({
                  args: [...registration.server.args],
                  command: registration.server.command,
                  env: Object.fromEntries(
                    registration.server.env.map(({ name, value }) => [
                      name,
                      value,
                    ])
                  ),
                  stderr: 'pipe',
                })
                yield* Effect.acquireRelease(
                  Effect.promise(() => client.connect(transport)),
                  () => Effect.promise(() => client.close())
                )
                yield* bridge.awaitReadiness(registration)
                const action: ConversationAction = {
                  description: 'Return a deliberately invalid raw result',
                  invoke: () => Effect.succeed(invalid.value as never),
                  name: 'deal-with-bug',
                }
                const sessionId = `session-invalid-${invalid.label}`
                const input = {
                  prompt: `Reject ${invalid.label} raw result.`,
                  title: 'Execution task',
                  worktreeName: `invalid-${invalid.label}`,
                }
                const permission = `${bridge.serverName}_deal-with-bug`
                const toolCallId = `call-invalid-${invalid.label}`
                const closeTurn = yield* bridge.activateTurn({
                  actionServerGeneration: registration.actionServerGeneration,
                  actions: [action],
                  scope: {
                    bindingGeneration: 1,
                    channelId: 'C248',
                    conversationId: `workspace:T248INVALIDRESULT:C248:${invalid.label}`,
                    processGeneration: 248,
                    promptId: `prompt-${invalid.label}`,
                    rootTs: invalid.label,
                    sessionId,
                    turnId: `turn-${invalid.label}`,
                    workspaceId: 'T248INVALIDRESULT',
                  },
                })
                bridge.observeToolCall({
                  sessionId,
                  update: {
                    kind: 'other',
                    name: permission,
                    rawInput: input,
                    sessionUpdate: 'tool_call',
                    status: 'pending',
                    title: permission,
                    toolCallId,
                  },
                })
                assert.strictEqual(
                  (yield* bridge.tryAuthorizePermission(
                    allowRequest({
                      input,
                      permission,
                      sessionId,
                      toolCallId,
                    })
                  ))?.outcome.outcome,
                  'selected'
                )
                const result = yield* Effect.promise(() =>
                  client.callTool({ arguments: input, name: 'deal-with-bug' })
                )
                assert.strictEqual(result.isError, true, invalid.label)
                const persisted = yield* Effect.promise(() =>
                  readFile(statePath, 'utf8')
                )
                assert.ok(
                  !persisted.includes('/private/raw-handler-secret-248'),
                  invalid.label
                )
                const records = JSON.parse(persisted) as {
                  readonly records: readonly {
                    readonly failureCode: string | null
                    readonly result: unknown
                  }[]
                }
                assert.strictEqual(
                  records.records[0]?.failureCode,
                  'action-invocation-failed',
                  invalid.label
                )
                assert.strictEqual(
                  records.records[0]?.result,
                  null,
                  invalid.label
                )
                yield* closeTurn
              })
            )
          }
        })
      )
  )

  it.live(
    'interrupts delayed generation observations before replacement authority writes',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            'laborer-action-observation-generation-'
          )
          const authority = yield* makeAcpAuthorityRepository({
            keyPath: join(root, 'authority.key'),
            statePath: join(root, 'authority.json'),
            trustedRoot: root,
          })
          let releaseObservation: () => void = () => undefined
          const observationRelease = new Promise<void>((resolveRelease) => {
            releaseObservation = resolveRelease
          })
          let markObservationStarted: () => void = () => undefined
          const observationStarted = new Promise<void>((resolveStarted) => {
            markObservationStarted = resolveStarted
          })
          const firstScope = yield* Scope.make()
          const first = yield* makeLaborerActionMcpBridge({
            authorityRepository: authority,
            bootstrapPath: join(root, 'action-bootstrap-1'),
            processGeneration: 1,
            root,
            rootAuthority: `${root}:retained`,
            statePath: join(root, 'action-capabilities.json'),
            testHooks: {
              beforeObservationPersist: async () => {
                markObservationStarted()
                await observationRelease
              },
            },
            trustedRuntimeRoot: root,
            workspaceId: 'T252OBSERVATION',
          }).pipe(Effect.provideService(Scope.Scope, firstScope))
          const registration = yield* first.prepareRegistration
          const client = new Client({
            name: 'action-observation-generation-test',
            version: '1.0.0',
          })
          const transport = new StdioClientTransport({
            args: [...registration.server.args],
            command: registration.server.command,
            env: Object.fromEntries(
              registration.server.env.map(({ name, value }) => [name, value])
            ),
            stderr: 'pipe',
          })
          yield* Effect.promise(() => client.connect(transport))
          yield* first.awaitReadiness(registration)
          const action: ConversationAction = {
            description: productionActionCatalog.tools[0]?.description ?? '',
            invoke: () =>
              Effect.succeed({
                actionName: 'create-feature' as const,
                deduplicated: false,
                executionId: 'execution:stale-observation',
                status: 'running' as const,
              }),
            name: 'create-feature',
          }
          const closeFirstTurn = yield* first.activateTurn({
            actionServerGeneration: registration.actionServerGeneration,
            actions: [action],
            scope: {
              bindingGeneration: 1,
              channelId: 'C252',
              conversationId: 'workspace:T252OBSERVATION:C252:1.0',
              processGeneration: 1,
              promptId: 'prompt:old-generation',
              rootTs: '1.0',
              sessionId: 'session:old-generation',
              turnId: 'turn:old-generation',
              workspaceId: 'T252OBSERVATION',
            },
          })
          assert.ok(closeFirstTurn)
          const permission = `${first.serverName}_create-feature`
          first.observeToolCall({
            sessionId: 'session:old-generation',
            update: {
              kind: 'other',
              name: permission,
              rawInput: {
                prompt: 'stale',
                title: 'Execution task',
                worktreeName: 'stale-observation',
              },
              sessionUpdate: 'tool_call',
              status: 'pending',
              title: permission,
              toolCallId: 'call:old-generation',
            },
          })
          yield* Effect.promise(() => observationStarted)
          yield* Scope.close(firstScope, Exit.void)
          yield* Effect.promise(() => client.close())

          const secondScope = yield* Scope.make()
          yield* makeLaborerActionMcpBridge({
            authorityRepository: authority,
            bootstrapPath: join(root, 'action-bootstrap-2'),
            processGeneration: 2,
            root,
            rootAuthority: `${root}:retained`,
            statePath: join(root, 'action-capabilities.json'),
            trustedRuntimeRoot: root,
            workspaceId: 'T252OBSERVATION',
          }).pipe(Effect.provideService(Scope.Scope, secondScope))
          releaseObservation()
          yield* Effect.sleep('25 millis')
          const persisted = JSON.parse(
            yield* Effect.promise(() =>
              readFile(join(root, 'action-capabilities.json'), 'utf8')
            )
          ) as {
            readonly records: readonly { readonly processGeneration: number }[]
          }
          assert.strictEqual(
            persisted.records.some(
              ({ processGeneration }) => processGeneration === 1
            ),
            false
          )
          yield* Scope.close(secondScope, Exit.void)
        })
      ),
    30_000
  )

  it.effect(
    'publishes generated tools, rejects the stale pre-promotion client, and consumes one correlated capability',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped('laborer-action-mcp-')
          const authority = yield* makeAcpAuthorityRepository({
            keyPath: join(root, 'authority.key'),
            statePath: join(root, 'authority.json'),
            trustedRoot: root,
          })
          let capabilityTime = 1000
          let expireBeforeActionInvocation = false
          const bridge = yield* makeLaborerActionMcpBridge({
            authorityRepository: authority,
            bootstrapPath: join(root, 'action-bootstrap'),
            capabilityTtlMillis: 100,
            processGeneration: 17,
            root,
            rootAuthority: `${root}:retained`,
            statePath: join(root, 'action-capabilities.json'),
            testHooks: {
              beforeRunInvocation: () => {
                if (expireBeforeActionInvocation) {
                  capabilityTime += 101
                }
                return Promise.resolve()
              },
              currentTimeMillis: () => capabilityTime,
            },
            trustedRuntimeRoot: root,
            workspaceId: 'T246ACTION',
          })
          const registration = yield* bridge.prepareRegistration
          const client = new Client({
            name: 'action-mcp-test',
            version: '1.0.0',
          })
          const transport = new StdioClientTransport({
            args: [...registration.server.args],
            command: registration.server.command,
            env: {
              ...process.env,
              LABORER_CANARY_SECRET: 'must-not-reach-action-server',
              OPENAI_API_KEY: 'must-not-reach-action-server',
              SLACK_BOT_TOKEN: 'must-not-reach-action-server',
              ...Object.fromEntries(
                registration.server.env.map(({ name, value }) => [name, value])
              ),
            },
            stderr: 'pipe',
          })
          yield* Effect.acquireRelease(
            Effect.promise(() => client.connect(transport)),
            () => Effect.promise(() => client.close())
          )
          const environmentNames = yield* bridge.awaitReadiness(registration)
          assert.ok(!environmentNames.includes('LABORER_CANARY_SECRET'))
          assert.ok(!environmentNames.includes('OPENAI_API_KEY'))
          assert.ok(!environmentNames.includes('SLACK_BOT_TOKEN'))
          assert.ok(!environmentNames.includes('HOME'))
          assert.deepStrictEqual(
            (yield* Effect.promise(() => client.listTools())).tools as unknown,
            productionGeneratedMutationCatalog.tools as unknown
          )
          const currentRegistration = yield* bridge.prepareRegistration
          const currentClient = new Client({
            name: 'action-mcp-current-generation-test',
            version: '1.0.0',
          })
          const currentTransport = new StdioClientTransport({
            args: [...currentRegistration.server.args],
            command: currentRegistration.server.command,
            env: Object.fromEntries(
              currentRegistration.server.env.map(({ name, value }) => [
                name,
                value,
              ])
            ),
            stderr: 'pipe',
          })
          yield* Effect.acquireRelease(
            Effect.promise(() => currentClient.connect(currentTransport)),
            () => Effect.promise(() => currentClient.close())
          )
          yield* bridge.awaitReadiness(currentRegistration)

          const invocationCount = yield* Ref.make(0)
          const trustedInvocations = yield* Ref.make<
            readonly TrustedActionInvocation[]
          >([])
          const action: ConversationAction = {
            description: productionActionCatalog.tools[0]?.description ?? '',
            invoke: (_input, trusted) =>
              Effect.gen(function* () {
                assert.ok(trusted)
                const priorInvocations = yield* Ref.get(trustedInvocations)
                const deduplicated = priorInvocations.some(
                  ({ operationId }) => operationId === trusted.operationId
                )
                if (!deduplicated) {
                  yield* Ref.update(invocationCount, (count) => count + 1)
                }
                yield* Ref.update(trustedInvocations, (current) => [
                  ...current,
                  trusted,
                ])
                return {
                  actionName: 'create-feature' as const,
                  deduplicated,
                  executionId: 'execution:opaque-246',
                  status: 'running' as const,
                }
              }),
            name: 'create-feature',
          }
          const sessionId = 'session-action-246'
          const closeTurn = yield* bridge.activateTurn({
            actionServerGeneration: currentRegistration.actionServerGeneration,
            actions: [action],
            scope: {
              bindingGeneration: 3,
              channelId: 'C246',
              conversationId: 'workspace:T246ACTION:C246:1.0',
              processGeneration: 17,
              promptId: 'prompt-246',
              rootTs: '1.0',
              sessionId,
              turnId: 'turn-246',
              workspaceId: 'T246ACTION',
            },
          })
          const input = {
            prompt: 'Implement the private Action path.',
            title: 'Execution task',
            worktreeName: 'action-246',
          }
          const permission = `${bridge.serverName}_create-feature`
          bridge.observeToolCall({
            sessionId,
            update: {
              kind: 'other',
              name: permission,
              rawInput: input,
              sessionUpdate: 'tool_call',
              status: 'pending',
              title: permission,
              toolCallId: 'call-246',
            },
          })
          assert.deepStrictEqual(
            yield* bridge.tryAuthorizePermission(
              allowRequest({
                input,
                permission,
                sessionId,
                toolCallId: 'call-246',
              })
            ),
            {
              outcome: {
                optionId: 'allow-action-once',
                outcome: 'selected',
              },
            }
          )
          const staleClientCall = yield* Effect.promise(() =>
            client.callTool({ arguments: input, name: 'create-feature' })
          )
          assert.strictEqual(staleClientCall.isError, true)
          const called = yield* Effect.promise(() =>
            currentClient.callTool({ arguments: input, name: 'create-feature' })
          )
          assert.deepStrictEqual(called.structuredContent, {
            actionName: 'create-feature',
            deduplicated: false,
            executionId: 'execution:opaque-246',
            status: 'running',
          })
          assert.strictEqual(yield* Ref.get(invocationCount), 1)
          assert.strictEqual((yield* Ref.get(trustedInvocations)).length, 1)

          const duplicate = yield* Effect.promise(() =>
            currentClient.callTool({
              arguments: input,
              name: 'create-feature',
            })
          )
          assert.deepStrictEqual(duplicate.structuredContent, {
            actionName: 'create-feature',
            deduplicated: true,
            executionId: 'execution:opaque-246',
            status: 'running',
          })
          assert.strictEqual(yield* Ref.get(invocationCount), 1)
          assert.strictEqual((yield* Ref.get(trustedInvocations)).length, 2)
          const persisted = yield* Effect.promise(() =>
            readFile(join(root, 'action-capabilities.json'), 'utf8')
          )
          assert.ok(!persisted.includes(input.prompt))
          assert.ok(!persisted.includes(root))
          const persistedCapabilities = JSON.parse(persisted) as {
            readonly records: readonly {
              readonly failureCode: string | null
              readonly result: {
                readonly actionName: string
                readonly deduplicated: boolean
                readonly executionId: string
                readonly status: string
              } | null
              readonly state: string
            }[]
          }
          assert.deepStrictEqual(persistedCapabilities.records.at(-1)?.result, {
            actionName: 'create-feature',
            deduplicated: true,
            executionId: 'execution:opaque-246',
            status: 'running',
          })
          assert.strictEqual(
            persistedCapabilities.records.at(-1)?.failureCode,
            null
          )
          assert.strictEqual(
            persistedCapabilities.records.at(-1)?.state,
            'consumed'
          )
          const changedInput = yield* Effect.promise(() =>
            currentClient.callTool({
              arguments: { ...input, prompt: 'changed after authorization' },
              name: 'create-feature',
            })
          )
          assert.strictEqual(changedInput.isError, true)
          assert.strictEqual(yield* Ref.get(invocationCount), 1)
          yield* closeTurn

          const unreadyRegistration = yield* bridge.prepareRegistration
          assert.ok(
            unreadyRegistration.actionServerGeneration >
              currentRegistration.actionServerGeneration
          )

          const secondSessionId = 'session-action-246-b'
          const secondInput = {
            prompt: 'Implement the second private Action path.',
            title: 'Execution task',
            worktreeName: 'action-246-b',
          }
          const closeSecondTurn = yield* bridge.activateTurn({
            actionServerGeneration: currentRegistration.actionServerGeneration,
            actions: [action],
            scope: {
              bindingGeneration: 4,
              channelId: 'C246B',
              conversationId: 'workspace:T246ACTION:C246B:2.0',
              processGeneration: 17,
              promptId: 'prompt-246-b',
              rootTs: '2.0',
              sessionId: secondSessionId,
              turnId: 'turn-246-b',
              workspaceId: 'T246ACTION',
            },
          })
          bridge.observeToolCall({
            sessionId: secondSessionId,
            update: {
              kind: 'other',
              name: permission,
              rawInput: secondInput,
              sessionUpdate: 'tool_call',
              status: 'pending',
              title: permission,
              toolCallId: 'call-246-b',
            },
          })
          assert.strictEqual(
            (yield* bridge.tryAuthorizePermission(
              allowRequest({
                input: secondInput,
                permission,
                sessionId: secondSessionId,
                toolCallId: 'call-246-b',
              })
            ))?.outcome.outcome,
            'selected'
          )
          const secondCalled = yield* Effect.promise(() =>
            currentClient.callTool({
              arguments: secondInput,
              name: 'create-feature',
            })
          )
          assert.deepStrictEqual(secondCalled.structuredContent, {
            actionName: 'create-feature',
            deduplicated: false,
            executionId: 'execution:opaque-246',
            status: 'running',
          })
          assert.strictEqual(yield* Ref.get(invocationCount), 2)
          yield* closeSecondTurn

          const expiredSessionId = 'session-action-246-expired'
          const expiredInput = {
            prompt: 'This capability must expire before invocation.',
            title: 'Execution task',
            worktreeName: 'action-246-expired',
          }
          const closeExpiredTurn = yield* bridge.activateTurn({
            actionServerGeneration: currentRegistration.actionServerGeneration,
            actions: [action],
            scope: {
              bindingGeneration: 5,
              channelId: 'C246EXPIRED',
              conversationId: 'workspace:T246ACTION:C246EXPIRED:3.0',
              processGeneration: 17,
              promptId: 'prompt-246-expired',
              rootTs: '3.0',
              sessionId: expiredSessionId,
              turnId: 'turn-246-expired',
              workspaceId: 'T246ACTION',
            },
          })
          const expiredToolCallId = 'call-246-expired'
          bridge.observeToolCall({
            sessionId: expiredSessionId,
            update: {
              kind: 'other',
              name: permission,
              rawInput: expiredInput,
              sessionUpdate: 'tool_call',
              status: 'pending',
              title: permission,
              toolCallId: expiredToolCallId,
            },
          })
          assert.strictEqual(
            (yield* bridge.tryAuthorizePermission(
              allowRequest({
                input: expiredInput,
                permission,
                sessionId: expiredSessionId,
                toolCallId: expiredToolCallId,
              })
            ))?.outcome.outcome,
            'selected'
          )
          expireBeforeActionInvocation = true
          const expiredCall = yield* Effect.promise(() =>
            currentClient.callTool({
              arguments: expiredInput,
              name: 'create-feature',
            })
          )
          expireBeforeActionInvocation = false
          assert.strictEqual(expiredCall.isError, true)
          assert.strictEqual(yield* Ref.get(invocationCount), 2)
          yield* closeExpiredTurn

          const staleGeneration = yield* Effect.result(
            bridge.activateTurn({
              actionServerGeneration: registration.actionServerGeneration,
              actions: [action],
              scope: {
                bindingGeneration: 6,
                channelId: 'C246-stale',
                conversationId: 'workspace:T246ACTION:C246-stale:3.0',
                processGeneration: 17,
                promptId: 'prompt-stale',
                rootTs: '3.0',
                sessionId: 'session-stale',
                turnId: 'turn-stale',
                workspaceId: 'T246ACTION',
              },
            })
          )
          assert.strictEqual(staleGeneration._tag, 'Failure')
        })
      )
  )

  it.effect(
    'clears active calls when consumed-capability persistence fails',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            'laborer-action-persistence-failure-'
          )
          const statePath = join(root, 'capabilities.json')
          const authority = yield* makeAcpAuthorityRepository({
            keyPath: join(root, 'authority.key'),
            statePath: join(root, 'authority.json'),
            trustedRoot: root,
          })
          const bridge = yield* makeLaborerActionMcpBridge({
            authorityRepository: authority,
            bootstrapPath: join(root, 'bootstrap'),
            processGeneration: 19,
            root,
            rootAuthority: 'retained-root',
            statePath,
            trustedRuntimeRoot: root,
            workspaceId: 'T246PERSIST',
          })
          const registration = yield* bridge.prepareRegistration
          const client = new Client({
            name: 'action-persistence-failure-test',
            version: '1.0.0',
          })
          const transport = new StdioClientTransport({
            args: [...registration.server.args],
            command: registration.server.command,
            env: Object.fromEntries(
              registration.server.env.map(({ name, value }) => [name, value])
            ),
            stderr: 'pipe',
          })
          yield* Effect.acquireRelease(
            Effect.promise(() => client.connect(transport)),
            () => Effect.promise(() => client.close())
          )
          yield* bridge.awaitReadiness(registration)
          const action: ConversationAction = {
            description: 'must not run',
            invoke: () => Effect.die(new Error('Action unexpectedly ran')),
            name: 'create-feature',
          }
          const sessionId = 'session-persistence-246'
          const input = {
            prompt: 'Do not run after persistence failure.',
            title: 'Execution task',
            worktreeName: 'persistence-failure',
          }
          const permission = `${bridge.serverName}_create-feature`
          const closeTurn = yield* bridge.activateTurn({
            actionServerGeneration: registration.actionServerGeneration,
            actions: [action],
            scope: {
              bindingGeneration: 1,
              channelId: 'C246',
              conversationId: 'workspace:T246PERSIST:C246:1.0',
              processGeneration: 19,
              promptId: 'prompt-persistence',
              rootTs: '1.0',
              sessionId,
              turnId: 'turn-persistence',
              workspaceId: 'T246PERSIST',
            },
          })
          bridge.observeToolCall({
            sessionId,
            update: {
              kind: 'other',
              name: permission,
              rawInput: input,
              sessionUpdate: 'tool_call',
              status: 'pending',
              title: permission,
              toolCallId: 'persistence-call',
            },
          })
          assert.strictEqual(
            (yield* bridge.tryAuthorizePermission(
              allowRequest({
                input,
                permission,
                sessionId,
                toolCallId: 'persistence-call',
              })
            ))?.outcome.outcome,
            'selected'
          )
          yield* Effect.promise(async () => {
            await rm(statePath)
            await mkdir(statePath)
          })
          const failed = yield* Effect.promise(() =>
            client.callTool({ arguments: input, name: 'create-feature' })
          )
          assert.strictEqual(failed.isError, true)
          assert.strictEqual(yield* bridge.activeCallCount, 0)
          yield* bridge.awaitCallsDrained
          const replacement = yield* bridge.prepareRegistration
          assert.ok(
            replacement.actionServerGeneration >
              registration.actionServerGeneration
          )
          yield* closeTurn
        })
      )
  )

  it.effect(
    'deduplicates a response-lost retry while the first external effect is active',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            'laborer-action-response-lost-'
          )
          const authority = yield* makeAcpAuthorityRepository({
            keyPath: join(root, 'authority.key'),
            statePath: join(root, 'authority.json'),
            trustedRoot: root,
          })
          const bridge = yield* makeLaborerActionMcpBridge({
            authorityRepository: authority,
            bootstrapPath: join(root, 'bootstrap'),
            processGeneration: 29,
            root,
            rootAuthority: 'retained-root',
            statePath: join(root, 'capabilities.json'),
            trustedRuntimeRoot: root,
            workspaceId: 'T246RESPONSELOST',
          })
          const registration = yield* bridge.prepareRegistration
          const client = new Client({
            name: 'action-response-lost-test',
            version: '1.0.0',
          })
          const transport = new StdioClientTransport({
            args: [...registration.server.args],
            command: registration.server.command,
            env: Object.fromEntries(
              registration.server.env.map(({ name, value }) => [name, value])
            ),
            stderr: 'pipe',
          })
          yield* Effect.acquireRelease(
            Effect.promise(() => client.connect(transport)),
            () => Effect.promise(() => client.close())
          )
          yield* bridge.awaitReadiness(registration)
          const started = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const duplicateStarted = yield* Deferred.make<void>()
          const failureStarted = yield* Deferred.make<void>()
          const releaseFailure = yield* Deferred.make<void>()
          const blockDeduplicatedInvocation = yield* Ref.make(false)
          const failDeduplicatedInvocation = yield* Ref.make(false)
          const operationIds = yield* Ref.make<ReadonlySet<string>>(new Set())
          const externalEffects = yield* Ref.make(0)
          const action: ConversationAction = {
            description: 'Create once',
            invoke: (_input, trusted) =>
              Effect.gen(function* () {
                assert.ok(trusted)
                const first = yield* Ref.modify(operationIds, (current) => {
                  if (current.has(trusted.operationId)) {
                    return [false, current] as const
                  }
                  return [
                    true,
                    new Set([...current, trusted.operationId]),
                  ] as const
                })
                if (first) {
                  yield* Ref.update(externalEffects, (count) => count + 1)
                  yield* Deferred.succeed(started, undefined)
                  yield* Deferred.await(release)
                } else if (yield* Ref.get(blockDeduplicatedInvocation)) {
                  yield* Deferred.succeed(duplicateStarted, undefined)
                  return yield* Effect.never
                } else if (yield* Ref.get(failDeduplicatedInvocation)) {
                  yield* Deferred.succeed(failureStarted, undefined)
                  yield* Deferred.await(releaseFailure)
                  return yield* Effect.die(
                    new Error('shared Action invocation failed')
                  )
                }
                return {
                  actionName: 'create-feature' as const,
                  deduplicated: !first,
                  executionId: 'execution:response-lost',
                  status: 'running' as const,
                }
              }),
            name: 'create-feature',
          }
          const sessionId = 'session-response-lost'
          const input = {
            prompt: 'Run one external effect.',
            title: 'Execution task',
            worktreeName: 'response-lost',
          }
          const permission = `${bridge.serverName}_create-feature`
          const closeTurn = yield* bridge.activateTurn({
            actionServerGeneration: registration.actionServerGeneration,
            actions: [action],
            scope: {
              bindingGeneration: 1,
              channelId: 'C246',
              conversationId: 'workspace:T246RESPONSELOST:C246:1.0',
              processGeneration: 29,
              promptId: 'prompt-response-lost',
              rootTs: '1.0',
              sessionId,
              turnId: 'turn-response-lost',
              workspaceId: 'T246RESPONSELOST',
            },
          })
          bridge.observeToolCall({
            sessionId,
            update: {
              kind: 'other',
              name: permission,
              rawInput: input,
              sessionUpdate: 'tool_call',
              status: 'pending',
              title: permission,
              toolCallId: 'response-lost-call',
            },
          })
          assert.strictEqual(
            (yield* bridge.tryAuthorizePermission(
              allowRequest({
                input,
                permission,
                sessionId,
                toolCallId: 'response-lost-call',
              })
            ))?.outcome.outcome,
            'selected'
          )
          const firstCall = client.callTool({
            arguments: input,
            name: 'create-feature',
          })
          yield* Deferred.await(started)
          const retries = Array.from({ length: 200 }, () =>
            client.callTool({ arguments: input, name: 'create-feature' })
          )
          yield* Effect.promise(
            () =>
              new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 100))
          )
          assert.strictEqual(yield* Ref.get(externalEffects), 1)
          yield* Deferred.succeed(release, undefined)
          const [firstResult, retryResults] = yield* Effect.all([
            Effect.promise(() => firstCall),
            Effect.promise(() => Promise.all(retries)),
          ])
          assert.deepStrictEqual(firstResult.structuredContent, {
            actionName: 'create-feature',
            deduplicated: false,
            executionId: 'execution:response-lost',
            status: 'running',
          })
          assert.strictEqual(retryResults.length, 200)
          for (const retryResult of retryResults) {
            assert.deepStrictEqual(retryResult.structuredContent, {
              actionName: 'create-feature',
              deduplicated: true,
              executionId: 'execution:response-lost',
              status: 'running',
            })
          }
          yield* Ref.set(blockDeduplicatedInvocation, true)
          const interruption = new AbortController()
          const interruptedOwner = client.callTool(
            { arguments: input, name: 'create-feature' },
            undefined,
            { signal: interruption.signal }
          )
          yield* Deferred.await(duplicateStarted)
          const interruptedWaiter = client.callTool({
            arguments: input,
            name: 'create-feature',
          })
          yield* Effect.promise(
            () =>
              new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50))
          )
          interruption.abort()
          const ownerRejected = yield* Effect.promise(() =>
            interruptedOwner.then(
              () => false,
              () => true
            )
          )
          assert.strictEqual(ownerRejected, true)
          assert.strictEqual(
            (yield* Effect.promise(() => interruptedWaiter)).isError,
            true
          )
          assert.strictEqual(yield* bridge.activeCallCount, 0)
          yield* bridge.awaitCallsDrained
          yield* Ref.set(blockDeduplicatedInvocation, false)
          yield* Ref.set(failDeduplicatedInvocation, true)
          const failedOwner = client.callTool({
            arguments: input,
            name: 'create-feature',
          })
          yield* Deferred.await(failureStarted)
          const failedWaiter = client.callTool({
            arguments: input,
            name: 'create-feature',
          })
          yield* Effect.promise(
            () =>
              new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50))
          )
          yield* Deferred.succeed(releaseFailure, undefined)
          const [failedOwnerResult, failedWaiterResult] = yield* Effect.promise(
            () => Promise.all([failedOwner, failedWaiter])
          )
          assert.strictEqual(failedOwnerResult.isError, true)
          assert.strictEqual(failedWaiterResult.isError, true)
          assert.strictEqual(yield* bridge.activeCallCount, 0)
          yield* closeTurn
        })
      ),
    // Two hundred concurrent retries through a real MCP child exceed the
    // default five-second budget when the host is running a parallel gate.
    30_000
  )

  it.effect('rejects an invocation when the active prompt lease swaps', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped(
          'laborer-action-lease-swap-'
        )
        const authority = yield* makeAcpAuthorityRepository({
          keyPath: join(root, 'authority.key'),
          statePath: join(root, 'authority.json'),
          trustedRoot: root,
        })
        let announceValidation: (() => void) | undefined
        const validationStarted = new Promise<void>((resolveStarted) => {
          announceValidation = resolveStarted
        })
        let releaseValidation: (() => void) | undefined
        const validationRelease = new Promise<void>((resolveRelease) => {
          releaseValidation = resolveRelease
        })
        const invocationCount = yield* Ref.make(0)
        const bridge = yield* makeLaborerActionMcpBridge({
          authorityRepository: authority,
          bootstrapPath: join(root, 'bootstrap'),
          processGeneration: 31,
          root,
          rootAuthority: 'retained-root',
          statePath: join(root, 'capabilities.json'),
          testHooks: {
            beforeInvokeLeaseValidation: async () => {
              announceValidation?.()
              await validationRelease
            },
          },
          trustedRuntimeRoot: root,
          workspaceId: 'T246LEASESWAP',
        })
        const registration = yield* bridge.prepareRegistration
        const client = new Client({
          name: 'action-lease-swap-test',
          version: '1.0.0',
        })
        const transport = new StdioClientTransport({
          args: [...registration.server.args],
          command: registration.server.command,
          env: Object.fromEntries(
            registration.server.env.map(({ name, value }) => [name, value])
          ),
          stderr: 'pipe',
        })
        yield* Effect.acquireRelease(
          Effect.promise(() => client.connect(transport)),
          () => Effect.promise(() => client.close())
        )
        yield* bridge.awaitReadiness(registration)
        const action: ConversationAction = {
          description: 'Must not cross a prompt lease',
          invoke: () =>
            Ref.update(invocationCount, (count) => count + 1).pipe(
              Effect.as({
                actionName: 'create-feature' as const,
                deduplicated: false,
                executionId: 'must-not-run',
                status: 'running' as const,
              })
            ),
          name: 'create-feature',
        }
        const input = {
          prompt: 'Attempt the original prompt action.',
          title: 'Execution task',
          worktreeName: 'lease-swap',
        }
        const permission = `${bridge.serverName}_create-feature`
        const sessionId = 'session-lease-original'
        const closeOriginal = yield* bridge.activateTurn({
          actionServerGeneration: registration.actionServerGeneration,
          actions: [action],
          scope: {
            bindingGeneration: 1,
            channelId: 'C246',
            conversationId: 'workspace:T246LEASESWAP:C246:1.0',
            processGeneration: 31,
            promptId: 'prompt-original',
            rootTs: '1.0',
            sessionId,
            turnId: 'turn-original',
            workspaceId: 'T246LEASESWAP',
          },
        })
        bridge.observeToolCall({
          sessionId,
          update: {
            kind: 'other',
            name: permission,
            rawInput: input,
            sessionUpdate: 'tool_call',
            status: 'pending',
            title: permission,
            toolCallId: 'lease-swap-call',
          },
        })
        assert.strictEqual(
          (yield* bridge.tryAuthorizePermission(
            allowRequest({
              input,
              permission,
              sessionId,
              toolCallId: 'lease-swap-call',
            })
          ))?.outcome.outcome,
          'selected'
        )
        const invocation = client.callTool({
          arguments: input,
          name: 'create-feature',
        })
        yield* Effect.promise(() => validationStarted)
        yield* closeOriginal
        const closeReplacement = yield* bridge.activateTurn({
          actionServerGeneration: registration.actionServerGeneration,
          actions: [action],
          scope: {
            bindingGeneration: 2,
            channelId: 'COTHER',
            conversationId: 'workspace:T246LEASESWAP:COTHER:2.0',
            processGeneration: 31,
            promptId: 'prompt-replacement',
            rootTs: '2.0',
            sessionId: 'session-lease-replacement',
            turnId: 'turn-replacement',
            workspaceId: 'T246LEASESWAP',
          },
        })
        releaseValidation?.()
        const result = yield* Effect.promise(() => invocation)
        assert.strictEqual(result.isError, true)
        assert.strictEqual(yield* Ref.get(invocationCount), 0)
        yield* closeReplacement
        const withoutLease = yield* Effect.promise(() =>
          client.callTool({ arguments: input, name: 'create-feature' })
        )
        assert.strictEqual(withoutLease.isError, true)
      })
    )
  )

  it.effect('bounds duplicate waiters per operation and workspace', () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const limits of [
          { name: 'operation', operation: 1, workspace: 10 },
          { name: 'workspace', operation: 10, workspace: 1 },
        ] as const) {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const root = yield* makeTempDirectoryScoped(
                `laborer-action-${limits.name}-waiter-limit-`
              )
              const authority = yield* makeAcpAuthorityRepository({
                keyPath: join(root, 'authority.key'),
                statePath: join(root, 'authority.json'),
                trustedRoot: root,
              })
              const bridge = yield* makeLaborerActionMcpBridge({
                authorityRepository: authority,
                bootstrapPath: join(root, 'bootstrap'),
                processGeneration: 32,
                root,
                rootAuthority: 'retained-root',
                statePath: join(root, 'capabilities.json'),
                testHooks: {
                  maxWaitersPerOperation: limits.operation,
                  maxWaitersPerWorkspace: limits.workspace,
                },
                trustedRuntimeRoot: root,
                workspaceId: 'T246WAITERLIMIT',
              })
              const registration = yield* bridge.prepareRegistration
              const client = new Client({
                name: `action-${limits.name}-waiter-limit-test`,
                version: '1.0.0',
              })
              const transport = new StdioClientTransport({
                args: [...registration.server.args],
                command: registration.server.command,
                env: Object.fromEntries(
                  registration.server.env.map(({ name, value }) => [
                    name,
                    value,
                  ])
                ),
                stderr: 'pipe',
              })
              yield* Effect.acquireRelease(
                Effect.promise(() => client.connect(transport)),
                () => Effect.promise(() => client.close())
              )
              yield* bridge.awaitReadiness(registration)
              const started = yield* Deferred.make<void>()
              const release = yield* Deferred.make<void>()
              const invocationCount = yield* Ref.make(0)
              const action: ConversationAction = {
                description: 'Bound duplicate callers',
                invoke: () =>
                  Effect.gen(function* () {
                    yield* Ref.update(invocationCount, (count) => count + 1)
                    yield* Deferred.succeed(started, undefined)
                    yield* Deferred.await(release)
                    return {
                      actionName: 'create-feature' as const,
                      deduplicated: false,
                      executionId: `execution:${limits.name}-waiter-limit`,
                      status: 'running' as const,
                    }
                  }),
                name: 'create-feature',
              }
              const sessionId = `session-${limits.name}-waiter-limit`
              const input = {
                prompt: `Bound ${limits.name} duplicate waiters.`,
                title: 'Execution task',
                worktreeName: `${limits.name}-waiter-limit`,
              }
              const permission = `${bridge.serverName}_create-feature`
              const closeTurn = yield* bridge.activateTurn({
                actionServerGeneration: registration.actionServerGeneration,
                actions: [action],
                scope: {
                  bindingGeneration: 1,
                  channelId: 'C246',
                  conversationId: `workspace:T246WAITERLIMIT:C246:${limits.name}`,
                  processGeneration: 32,
                  promptId: `prompt-${limits.name}-waiter-limit`,
                  rootTs: '1.0',
                  sessionId,
                  turnId: `turn-${limits.name}-waiter-limit`,
                  workspaceId: 'T246WAITERLIMIT',
                },
              })
              bridge.observeToolCall({
                sessionId,
                update: {
                  kind: 'other',
                  name: permission,
                  rawInput: input,
                  sessionUpdate: 'tool_call',
                  status: 'pending',
                  title: permission,
                  toolCallId: `${limits.name}-waiter-limit-call`,
                },
              })
              assert.strictEqual(
                (yield* bridge.tryAuthorizePermission(
                  allowRequest({
                    input,
                    permission,
                    sessionId,
                    toolCallId: `${limits.name}-waiter-limit-call`,
                  })
                ))?.outcome.outcome,
                'selected'
              )
              const owner = client.callTool({
                arguments: input,
                name: 'create-feature',
              })
              yield* Deferred.await(started)
              const duplicates = [
                client.callTool({ arguments: input, name: 'create-feature' }),
                client.callTool({ arguments: input, name: 'create-feature' }),
              ]
              const overflow = yield* Effect.promise(() =>
                Promise.race(duplicates)
              )
              assert.strictEqual(overflow.isError, true, limits.name)
              yield* Deferred.succeed(release, undefined)
              const [ownerResult, duplicateResults] = yield* Effect.all([
                Effect.promise(() => owner),
                Effect.promise(() => Promise.all(duplicates)),
              ])
              assert.strictEqual(ownerResult.isError, undefined)
              assert.strictEqual(
                duplicateResults.filter((result) => result.isError === true)
                  .length,
                1,
                limits.name
              )
              assert.strictEqual(yield* Ref.get(invocationCount), 1)
              yield* closeTurn
            })
          )
        }
      })
    )
  )

  it.live('expires a single-flight owner and every attached waiter', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped(
          'laborer-action-single-flight-expiry-'
        )
        const authority = yield* makeAcpAuthorityRepository({
          keyPath: join(root, 'authority.key'),
          statePath: join(root, 'authority.json'),
          trustedRoot: root,
        })
        const bridge = yield* makeLaborerActionMcpBridge({
          authorityRepository: authority,
          bootstrapPath: join(root, 'bootstrap'),
          capabilityTtlMillis: 300,
          processGeneration: 33,
          root,
          rootAuthority: 'retained-root',
          statePath: join(root, 'capabilities.json'),
          trustedRuntimeRoot: root,
          workspaceId: 'T246EXPIRY',
        })
        const registration = yield* bridge.prepareRegistration
        const client = new Client({
          name: 'action-single-flight-expiry-test',
          version: '1.0.0',
        })
        const transport = new StdioClientTransport({
          args: [...registration.server.args],
          command: registration.server.command,
          env: Object.fromEntries(
            registration.server.env.map(({ name, value }) => [name, value])
          ),
          stderr: 'pipe',
        })
        yield* Effect.acquireRelease(
          Effect.promise(() => client.connect(transport)),
          () => Effect.promise(() => client.close())
        )
        yield* bridge.awaitReadiness(registration)
        const started = yield* Deferred.make<void>()
        const invocationCount = yield* Ref.make(0)
        const action: ConversationAction = {
          description: 'Expire one shared invocation',
          invoke: () =>
            Effect.gen(function* () {
              yield* Ref.update(invocationCount, (count) => count + 1)
              yield* Deferred.succeed(started, undefined)
              return yield* Effect.never
            }),
          name: 'create-feature',
        }
        const sessionId = 'session-single-flight-expiry'
        const input = {
          prompt: 'Expire this shared invocation.',
          title: 'Execution task',
          worktreeName: 'single-flight-expiry',
        }
        const permission = `${bridge.serverName}_create-feature`
        const closeTurn = yield* bridge.activateTurn({
          actionServerGeneration: registration.actionServerGeneration,
          actions: [action],
          scope: {
            bindingGeneration: 1,
            channelId: 'C246',
            conversationId: 'workspace:T246EXPIRY:C246:1.0',
            processGeneration: 33,
            promptId: 'prompt-single-flight-expiry',
            rootTs: '1.0',
            sessionId,
            turnId: 'turn-single-flight-expiry',
            workspaceId: 'T246EXPIRY',
          },
        })
        bridge.observeToolCall({
          sessionId,
          update: {
            kind: 'other',
            name: permission,
            rawInput: input,
            sessionUpdate: 'tool_call',
            status: 'pending',
            title: permission,
            toolCallId: 'single-flight-expiry-call',
          },
        })
        assert.strictEqual(
          (yield* bridge.tryAuthorizePermission(
            allowRequest({
              input,
              permission,
              sessionId,
              toolCallId: 'single-flight-expiry-call',
            })
          ))?.outcome.outcome,
          'selected'
        )
        const owner = client.callTool({
          arguments: input,
          name: 'create-feature',
        })
        yield* Deferred.await(started)
        const waiter = client.callTool({
          arguments: input,
          name: 'create-feature',
        })
        const [ownerResult, waiterResult] = yield* Effect.promise(() =>
          Promise.all([owner, waiter])
        )
        assert.strictEqual(ownerResult.isError, true)
        assert.strictEqual(waiterResult.isError, true)
        assert.strictEqual(yield* Ref.get(invocationCount), 1)
        assert.strictEqual(yield* bridge.activeCallCount, 0)
        yield* bridge.awaitCallsDrained
        yield* closeTurn
      })
    )
  )

  it.effect('interrupts an owner and fails attached waiters on shutdown', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped(
          'laborer-action-single-flight-shutdown-'
        )
        const authority = yield* makeAcpAuthorityRepository({
          keyPath: join(root, 'authority.key'),
          statePath: join(root, 'authority.json'),
          trustedRoot: root,
        })
        const bridgeScope = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(bridgeScope, Exit.void))
        const bridge = yield* makeLaborerActionMcpBridge({
          authorityRepository: authority,
          bootstrapPath: join(root, 'bootstrap'),
          processGeneration: 34,
          root,
          rootAuthority: 'retained-root',
          statePath: join(root, 'capabilities.json'),
          trustedRuntimeRoot: root,
          workspaceId: 'T246SHUTDOWN',
        }).pipe(Effect.provideService(Scope.Scope, bridgeScope))
        const registration = yield* bridge.prepareRegistration
        const client = new Client({
          name: 'action-single-flight-shutdown-test',
          version: '1.0.0',
        })
        const transport = new StdioClientTransport({
          args: [...registration.server.args],
          command: registration.server.command,
          env: Object.fromEntries(
            registration.server.env.map(({ name, value }) => [name, value])
          ),
          stderr: 'pipe',
        })
        yield* Effect.acquireRelease(
          Effect.promise(() => client.connect(transport)),
          () => Effect.promise(() => client.close())
        )
        yield* bridge.awaitReadiness(registration)
        const started = yield* Deferred.make<void>()
        const action: ConversationAction = {
          description: 'Stop one shared invocation',
          invoke: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined)
              return yield* Effect.never
            }),
          name: 'create-feature',
        }
        const sessionId = 'session-single-flight-shutdown'
        const input = {
          prompt: 'Stop this shared invocation.',
          title: 'Execution task',
          worktreeName: 'single-flight-shutdown',
        }
        const permission = `${bridge.serverName}_create-feature`
        yield* bridge
          .activateTurn({
            actionServerGeneration: registration.actionServerGeneration,
            actions: [action],
            scope: {
              bindingGeneration: 1,
              channelId: 'C246',
              conversationId: 'workspace:T246SHUTDOWN:C246:1.0',
              processGeneration: 34,
              promptId: 'prompt-single-flight-shutdown',
              rootTs: '1.0',
              sessionId,
              turnId: 'turn-single-flight-shutdown',
              workspaceId: 'T246SHUTDOWN',
            },
          })
          .pipe(Effect.asVoid)
        bridge.observeToolCall({
          sessionId,
          update: {
            kind: 'other',
            name: permission,
            rawInput: input,
            sessionUpdate: 'tool_call',
            status: 'pending',
            title: permission,
            toolCallId: 'single-flight-shutdown-call',
          },
        })
        assert.strictEqual(
          (yield* bridge.tryAuthorizePermission(
            allowRequest({
              input,
              permission,
              sessionId,
              toolCallId: 'single-flight-shutdown-call',
            })
          ))?.outcome.outcome,
          'selected'
        )
        const owner = client.callTool({
          arguments: input,
          name: 'create-feature',
        })
        yield* Deferred.await(started)
        const waiter = client.callTool({
          arguments: input,
          name: 'create-feature',
        })
        yield* Effect.promise(
          () =>
            new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50))
        )
        yield* Scope.close(bridgeScope, Exit.void)
        const [ownerResult, waiterResult] = yield* Effect.promise(() =>
          Promise.all([owner, waiter])
        )
        assert.strictEqual(ownerResult.isError, true)
        assert.strictEqual(waiterResult.isError, true)
      })
    )
  )

  it.effect(
    'conflicts changed input after restart through the real MCP seam',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            'laborer-action-recorrelation-'
          )
          const statePath = join(root, 'capabilities.json')
          const applicationStatePath = join(root, 'application.json')
          const authority = yield* makeAcpAuthorityRepository({
            keyPath: join(root, 'authority.key'),
            statePath: join(root, 'authority.json'),
            trustedRoot: root,
          })
          const inputA = {
            prompt: 'Implement stable input A.',
            title: 'Execution task',
            worktreeName: 'restart-recorrelation',
          }
          const inputB = {
            prompt: 'Implement conflicting input B.',
            title: 'Execution task',
            worktreeName: 'restart-recorrelation',
          }
          const scopeBase = {
            channelId: 'C246',
            conversationId: 'workspace:T246RESTART:C246:1.0',
            promptId: 'prompt-restart',
            rootTs: '1.0',
            turnId: 'turn-restart',
            workspaceId: 'T246RESTART',
          } as const
          const worktrees = yield* Ref.make(0)
          const implementationStarts = yield* Ref.make(0)
          const actionRef = yield* Ref.make<ConversationAction | null>(null)
          const applicationRepository = yield* makeFileApplicationRepository(
            applicationStatePath,
            root
          )
          const application = yield* makeReferenceCodingApplication({
            conversationAgent: {
              handle: (request) => {
                const action = request.actions.find(
                  (candidate) => candidate.name === 'create-feature'
                )
                assert.ok(action)
                return Ref.set(actionRef, action).pipe(Effect.as([] as const))
              },
            },
            implementationAgent: ImplementationAgent.of({
              start: (request) =>
                Ref.update(implementationStarts, (count) => count + 1).pipe(
                  Effect.as({
                    completion: Effect.never,
                    resume: () => Effect.void,
                    sessionId: request.implementationSessionId,
                  })
                ),
            }),
            repository: applicationRepository,
            worktreeManager: WorktreeManager.of({
              create: () =>
                Ref.update(worktrees, (count) => count + 1).pipe(
                  Effect.as({ workingDirectory: join(root, 'worktree') })
                ),
            }),
          })
          yield* application.handle(
            ExternalInputEvent.make({
              conversationId: ThreadId.make(scopeBase.conversationId),
              eventId: 'event:restart-operation-slot',
              payload: {},
              source: 'test',
            }),
            () => Effect.void,
            (event) =>
              Effect.succeed({
                decision: {
                  _tag: 'Accepted' as const,
                  eventId: event.eventId,
                },
                scheduling: 'Scheduled' as const,
              })
          )
          const action = yield* Ref.get(actionRef)
          assert.ok(action)
          const operationDigests: string[] = []
          const results: unknown[] = []
          for (const [index, input] of [inputA, inputB, inputA].entries()) {
            const attempt = index + 1
            yield* Effect.scoped(
              Effect.gen(function* () {
                const processGeneration = 22 + attempt
                const scope = {
                  ...scopeBase,
                  bindingGeneration: 4 + attempt,
                  processGeneration,
                  sessionId: `session-restart-${attempt}`,
                }
                const bridge = yield* makeLaborerActionMcpBridge({
                  authorityRepository: authority,
                  bootstrapPath: join(root, `bootstrap-${attempt}`),
                  processGeneration,
                  root,
                  rootAuthority: 'retained-root',
                  statePath,
                  trustedRuntimeRoot: root,
                  workspaceId: 'T246RESTART',
                })
                const registration = yield* bridge.prepareRegistration
                const client = new Client({
                  name: `action-restart-${attempt}`,
                  version: '1.0.0',
                })
                const transport = new StdioClientTransport({
                  args: [...registration.server.args],
                  command: registration.server.command,
                  env: Object.fromEntries(
                    registration.server.env.map(({ name, value }) => [
                      name,
                      value,
                    ])
                  ),
                  stderr: 'pipe',
                })
                yield* Effect.acquireRelease(
                  Effect.promise(() => client.connect(transport)),
                  () => Effect.promise(() => client.close())
                )
                yield* bridge.awaitReadiness(registration)
                const closeTurn = yield* bridge.activateTurn({
                  actionServerGeneration: registration.actionServerGeneration,
                  actions: [action],
                  scope,
                })
                const permission = `${bridge.serverName}_create-feature`
                const toolCallId = `restart-call-${attempt}`
                bridge.observeToolCall({
                  sessionId: scope.sessionId,
                  update: {
                    kind: 'other',
                    name: permission,
                    rawInput: input,
                    sessionUpdate: 'tool_call',
                    status: 'pending',
                    title: permission,
                    toolCallId,
                  },
                })
                assert.strictEqual(
                  (yield* bridge.tryAuthorizePermission(
                    allowRequest({
                      input,
                      permission,
                      sessionId: scope.sessionId,
                      toolCallId,
                    })
                  ))?.outcome.outcome,
                  'selected'
                )
                results.push(
                  yield* Effect.promise(() =>
                    client.callTool({
                      arguments: input,
                      name: 'create-feature',
                    })
                  )
                )
                const persisted = JSON.parse(
                  yield* Effect.promise(() => readFile(statePath, 'utf8'))
                ) as {
                  readonly records: readonly {
                    readonly operationDigest: string
                  }[]
                }
                const digest = persisted.records.at(-1)?.operationDigest
                assert.ok(digest)
                operationDigests.push(digest)
                yield* closeTurn
              })
            )
          }
          assert.strictEqual(operationDigests.length, 3)
          assert.strictEqual(new Set(operationDigests).size, 1)
          const decodedResults = results as readonly {
            readonly isError?: boolean
            readonly structuredContent?: { readonly deduplicated?: boolean }
          }[]
          assert.strictEqual(decodedResults[0]?.isError, undefined)
          assert.strictEqual(
            decodedResults[0]?.structuredContent?.deduplicated,
            false
          )
          assert.strictEqual(decodedResults[1]?.isError, true)
          assert.strictEqual(decodedResults[2]?.isError, undefined)
          assert.strictEqual(
            decodedResults[2]?.structuredContent?.deduplicated,
            true
          )
          assert.strictEqual(yield* Ref.get(worktrees), 1)
          assert.strictEqual(yield* Ref.get(implementationStarts), 1)
          const persistedApplication = JSON.parse(
            yield* Effect.promise(() => readFile(applicationStatePath, 'utf8'))
          ) as {
            readonly actionOperations: readonly {
              readonly inputHash: string
              readonly operationId: string
            }[]
            readonly executions: readonly unknown[]
          }
          assert.strictEqual(persistedApplication.actionOperations.length, 1)
          assert.strictEqual(persistedApplication.executions.length, 1)
          assert.ok(persistedApplication.actionOperations[0]?.inputHash)
        })
      )
  )

  it.live(
    'expires and revokes capabilities while rejecting wrong authority scopes',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            'laborer-action-scope-denial-'
          )
          const authority = yield* makeAcpAuthorityRepository({
            keyPath: join(root, 'authority.key'),
            statePath: join(root, 'authority.json'),
            trustedRoot: root,
          })
          const bridge = yield* makeLaborerActionMcpBridge({
            authorityRepository: authority,
            bootstrapPath: join(root, 'bootstrap'),
            capabilityTtlMillis: 1,
            processGeneration: 8,
            root,
            rootAuthority: 'retained-root',
            statePath: join(root, 'capabilities.json'),
            trustedRuntimeRoot: root,
            workspaceId: 'T246SCOPE',
          })
          const action: ConversationAction = {
            description: 'Create a feature',
            invoke: () =>
              Effect.succeed({
                actionName: 'create-feature' as const,
                deduplicated: false,
                executionId: 'must-not-run',
                status: 'running' as const,
              }),
            name: 'create-feature',
          }
          const registration = yield* bridge.prepareRegistration
          const client = new Client({
            name: 'action-scope-denial-test',
            version: '1.0.0',
          })
          const transport = new StdioClientTransport({
            args: [...registration.server.args],
            command: registration.server.command,
            env: Object.fromEntries(
              registration.server.env.map(({ name, value }) => [name, value])
            ),
            stderr: 'pipe',
          })
          yield* Effect.acquireRelease(
            Effect.promise(() => client.connect(transport)),
            () => Effect.promise(() => client.close())
          )
          yield* bridge.awaitReadiness(registration)
          const invalidWorkspace = yield* Effect.result(
            bridge.activateTurn({
              actionServerGeneration: registration.actionServerGeneration,
              actions: [action],
              scope: {
                bindingGeneration: 1,
                channelId: 'C246',
                conversationId: 'workspace:TOTHER:C246:1.0',
                processGeneration: 8,
                promptId: 'prompt-invalid',
                rootTs: '1.0',
                sessionId: 'session-invalid',
                turnId: 'turn-invalid',
                workspaceId: 'TOTHER',
              },
            })
          )
          assert.strictEqual(invalidWorkspace._tag, 'Failure')

          const sessionId = 'session-scope-246'
          const permission = `${bridge.serverName}_create-feature`
          const input = {
            prompt: 'Scoped action',
            title: 'Execution task',
            worktreeName: 'scope-246',
          }
          const closeExpiredTurn = yield* bridge.activateTurn({
            actionServerGeneration: registration.actionServerGeneration,
            actions: [action],
            scope: {
              bindingGeneration: 1,
              channelId: 'C246',
              conversationId: 'workspace:T246SCOPE:C246:1.0',
              processGeneration: 8,
              promptId: 'prompt-expired',
              rootTs: '1.0',
              sessionId,
              turnId: 'turn-expired',
              workspaceId: 'T246SCOPE',
            },
          })
          bridge.observeToolCall({
            sessionId,
            update: {
              kind: 'other',
              name: permission,
              rawInput: input,
              sessionUpdate: 'tool_call',
              status: 'pending',
              title: permission,
              toolCallId: 'expired-call',
            },
          })
          assert.deepStrictEqual(
            yield* bridge.tryAuthorizePermission(
              allowRequest({
                input,
                permission,
                sessionId: 'wrong-session',
                toolCallId: 'expired-call',
              })
            ),
            { outcome: { outcome: 'cancelled' } }
          )
          yield* Effect.sleep('5 millis')
          assert.deepStrictEqual(
            yield* bridge.tryAuthorizePermission(
              allowRequest({
                input,
                permission,
                sessionId,
                toolCallId: 'expired-call',
              })
            ),
            { outcome: { outcome: 'cancelled' } }
          )
          yield* closeExpiredTurn

          const scopeBridge = yield* makeLaborerActionMcpBridge({
            authorityRepository: authority,
            bootstrapPath: join(root, 'scope-bootstrap'),
            processGeneration: 8,
            root,
            rootAuthority: 'retained-root',
            statePath: join(root, 'scope-capabilities.json'),
            trustedRuntimeRoot: root,
            workspaceId: 'T246SCOPE',
          })
          const scopeRegistration = yield* scopeBridge.prepareRegistration
          const scopeClient = new Client({
            name: 'action-cross-thread-denial-test',
            version: '1.0.0',
          })
          const scopeTransport = new StdioClientTransport({
            args: [...scopeRegistration.server.args],
            command: scopeRegistration.server.command,
            env: Object.fromEntries(
              scopeRegistration.server.env.map(({ name, value }) => [
                name,
                value,
              ])
            ),
            stderr: 'pipe',
          })
          yield* Effect.acquireRelease(
            Effect.promise(() => scopeClient.connect(scopeTransport)),
            () => Effect.promise(() => scopeClient.close())
          )
          yield* scopeBridge.awaitReadiness(scopeRegistration)
          const closeOriginalThread = yield* scopeBridge.activateTurn({
            actionServerGeneration: scopeRegistration.actionServerGeneration,
            actions: [action],
            scope: {
              bindingGeneration: 2,
              channelId: 'C246',
              conversationId: 'workspace:T246SCOPE:C246:1.0',
              processGeneration: 8,
              promptId: 'prompt-original',
              rootTs: '1.0',
              sessionId,
              turnId: 'turn-original',
              workspaceId: 'T246SCOPE',
            },
          })
          scopeBridge.observeToolCall({
            sessionId,
            update: {
              kind: 'other',
              name: permission,
              rawInput: input,
              sessionUpdate: 'tool_call',
              status: 'pending',
              title: permission,
              toolCallId: 'cross-thread-call',
            },
          })
          const overlappingThread = yield* Effect.result(
            scopeBridge.activateTurn({
              actionServerGeneration: scopeRegistration.actionServerGeneration,
              actions: [action],
              scope: {
                bindingGeneration: 3,
                channelId: 'COTHER',
                conversationId: 'workspace:T246SCOPE:COTHER:2.0',
                processGeneration: 8,
                promptId: 'prompt-other',
                rootTs: '2.0',
                sessionId,
                turnId: 'turn-other',
                workspaceId: 'T246SCOPE',
              },
            })
          )
          assert.strictEqual(overlappingThread._tag, 'Failure')
          assert.deepStrictEqual(
            yield* scopeBridge.tryAuthorizePermission(
              allowRequest({
                input,
                permission,
                sessionId,
                toolCallId: 'cross-thread-call',
              })
            ),
            {
              outcome: {
                optionId: 'allow-action-once',
                outcome: 'selected',
              },
            }
          )
          yield* closeOriginalThread
          const closeOtherThread = yield* scopeBridge.activateTurn({
            actionServerGeneration: scopeRegistration.actionServerGeneration,
            actions: [action],
            scope: {
              bindingGeneration: 3,
              channelId: 'COTHER',
              conversationId: 'workspace:T246SCOPE:COTHER:2.0',
              processGeneration: 8,
              promptId: 'prompt-other',
              rootTs: '2.0',
              sessionId,
              turnId: 'turn-other',
              workspaceId: 'T246SCOPE',
            },
          })
          scopeBridge.observeToolCall({
            sessionId,
            update: {
              kind: 'other',
              name: permission,
              rawInput: input,
              sessionUpdate: 'tool_call',
              status: 'pending',
              title: permission,
              toolCallId: 'revoked-call',
            },
          })
          yield* closeOtherThread
          assert.deepStrictEqual(
            yield* scopeBridge.tryAuthorizePermission(
              allowRequest({
                input,
                permission,
                sessionId,
                toolCallId: 'revoked-call',
              })
            ),
            { outcome: { outcome: 'cancelled' } }
          )
        })
      )
  )

  it.effect(
    'rejects exact reserved identities from every effective config source',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const sourceKinds = [
            'ancestor',
            'project',
            'project-directory',
            'global',
            'home-directory',
            'custom-file',
            'custom-directory',
            'inline',
          ] as const
          for (const sourceKind of sourceKinds) {
            const root = yield* makeTempDirectoryScoped(
              `laborer-action-name-collision-${sourceKind}-`
            )
            const projectRoot = join(root, 'repository', 'packages', 'app')
            const home = join(root, 'home')
            const xdgConfigHome = join(root, 'xdg')
            const customFile = join(root, 'custom.jsonc')
            const customDirectory = join(root, 'custom-directory')
            const reservedName = `laborer-actions-reserved-${sourceKind}`
            const document = `{
            // JSONC is an effective OpenCode configuration format.
            "mcp": { "${reservedName}": { "enabled": true, }, },
          }`
            const environment: NodeJS.ProcessEnv = {}
            let path: string | null = null
            switch (sourceKind) {
              case 'ancestor':
                path = join(root, 'repository', 'opencode.jsonc')
                break
              case 'project':
                path = join(projectRoot, 'opencode.jsonc')
                break
              case 'project-directory':
                path = join(projectRoot, '.opencode', 'opencode.jsonc')
                break
              case 'global':
                environment.XDG_CONFIG_HOME = xdgConfigHome
                path = join(xdgConfigHome, 'opencode', 'config.json')
                break
              case 'home-directory':
                environment.HOME = home
                path = join(home, '.opencode', 'opencode.jsonc')
                break
              case 'custom-file':
                environment.OPENCODE_CONFIG = customFile
                path = customFile
                break
              case 'custom-directory':
                environment.OPENCODE_CONFIG_DIR = customDirectory
                path = join(customDirectory, 'opencode.jsonc')
                break
              case 'inline':
                environment.OPENCODE_CONFIG_CONTENT = document
                break
              default:
                break
            }
            yield* Effect.promise(async () => {
              await mkdir(projectRoot, { mode: 0o700, recursive: true })
              if (path !== null) {
                await mkdir(dirname(path), { mode: 0o700, recursive: true })
                await writeFile(path, document, { mode: 0o600 })
              }
            })
            const result = yield* Effect.result(
              preflightReservedMcpNames({
                environment,
                names: [reservedName],
                projectRoot,
              })
            )
            assert.strictEqual(result._tag, 'Failure', sourceKind)
          }
        })
      )
  )

  it.effect('ignores reserved-name text outside exact top-level MCP keys', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped(
          'laborer-action-name-false-positive-'
        )
        const reservedName = 'laborer-actions-reserved-false-positive'
        yield* Effect.promise(() =>
          writeFile(
            join(root, 'opencode.jsonc'),
            JSON.stringify({
              description: reservedName,
              mcp: {
                allowed: {
                  command: ['command', reservedName],
                  description: reservedName,
                },
              },
              nested: { mcp: { [reservedName]: { enabled: true } } },
            }),
            { mode: 0o600 }
          )
        )
        yield* preflightReservedMcpNames({
          environment: {},
          names: [reservedName],
          projectRoot: root,
        })
      })
    )
  )

  it.effect(
    'cancels recognized invalid Action permission without broadening authority',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped('laborer-action-denial-')
          const authority = yield* makeAcpAuthorityRepository({
            keyPath: join(root, 'authority.key'),
            statePath: join(root, 'authority.json'),
            trustedRoot: root,
          })
          const bridge = yield* makeLaborerActionMcpBridge({
            authorityRepository: authority,
            bootstrapPath: join(root, 'bootstrap'),
            processGeneration: 1,
            root,
            rootAuthority: 'retained-root',
            statePath: join(root, 'capabilities.json'),
            trustedRuntimeRoot: root,
            workspaceId: 'T246DENIAL',
          })
          const permission = `${bridge.serverName}_create-feature`
          const invalid = allowRequest({
            input: {
              prompt: 'valid',
              title: 'Execution task',
              worktreeName: '../invalid',
            },
            permission,
            sessionId: 'unknown-session',
            toolCallId: 'invalid-call',
          })
          invalid.toolCall.title = permission
          assert.deepStrictEqual(
            yield* bridge.tryAuthorizePermission(invalid),
            { outcome: { outcome: 'cancelled' } }
          )
          assert.strictEqual(
            yield* bridge.tryAuthorizePermission({
              ...invalid,
              toolCall: {
                ...invalid.toolCall,
                title: 'unrelated-tool',
                toolCallId: 'unrelated-call',
              },
            }),
            null
          )
        })
      )
  )
})
