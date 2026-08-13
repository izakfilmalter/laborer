import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assert, describe, it } from '@effect/vitest'
import { Deferred, Effect, Fiber } from 'effect'
import {
  type ApplicationPublicOutput,
  type ApplicationShape,
  ConversationBlocked,
  ExternalInputEvent,
  ParticipantInputEvent,
} from '../src/application.ts'
import {
  MessageId,
  NormalizedImageInput,
  NormalizedMessage,
  ThreadId,
  TurnId,
} from '../src/core/domain.ts'
import { HandlerFailure } from '../src/core/errors.ts'
import {
  type AcceptImplementationAgentResponse,
  type ConversationAgentRequest,
  type ConversationAgentShape,
  type ConversationPromptAttemptOutcome,
  makeFileApplicationRepository,
  makeReferenceCodingApplication,
  type ReferenceCodingApplicationRepository,
} from '../src/reference-coding-application.ts'
import type { ConversationAdoptionHistorySnapshot } from '../src/slack/conversation-adoption-history.ts'
import { makeTempDirectoryScoped } from './support/temp-directory.ts'

const CONVERSATION_ID = 'workspace:T255:C255:255.000001'

const participantEvent = (turn: number): ParticipantInputEvent =>
  ParticipantInputEvent.make({
    attemptNumber: 1,
    channelId: 'C255',
    context: [],
    conversationId: ThreadId.make(CONVERSATION_ID),
    initializationStatus: 'not_applicable',
    messages: [
      NormalizedMessage.make({
        authorKind: 'human',
        authorSlackId: 'U255',
        classification: 'input',
        id: MessageId.make(`workspace:T255:C255:255.00000${turn + 1}`),
        isActivation: turn === 1,
        slackTs: `255.00000${turn + 1}`,
        text: `triggering turn ${turn}`,
      }),
    ],
    rootTs: '255.000001',
    source: 'slack',
    turnId: TurnId.make(`turn-255-${turn}`),
    workingDirectory: null,
  })

const acceptEvent = () =>
  Effect.succeed({
    decision: { _tag: 'Accepted' as const, eventId: 'accepted' },
    scheduling: 'Scheduled' as const,
  })

const historyRendered =
  '<conversation-adoption-history trust="untrusted-reference-only"><slack-message author-kind="human" author-slack-id="U-OLD" slack-ts="255.000001">old current history</slack-message></conversation-adoption-history>'

const historySnapshot: ConversationAdoptionHistorySnapshot = {
  bytes: Buffer.byteLength(historyRendered, 'utf8'),
  degradation: 'complete',
  diagnosticCodes: [],
  digest: createHash('sha256')
    .update(historyRendered, 'utf8')
    .digest('base64url'),
  firstSlackTs: '255.000001',
  images: [],
  lastSlackTs: '255.000001',
  messageCount: 1,
  rendered: historyRendered,
  requestCount: 1,
  truncation: { age: false, bytes: false, count: false },
}

const makeApplication = (
  repository: ReferenceCodingApplicationRepository,
  conversationAgent: ConversationAgentShape,
  adoptionHistory: ConversationAdoptionHistorySnapshot = historySnapshot,
  historyReadStatus: 'session_created' | 'staged' = 'staged'
) =>
  makeReferenceCodingApplication({
    conversationAdoptionHistory: {
      read: () =>
        repository.load.pipe(
          Effect.orDie,
          Effect.tap((state) =>
            Effect.sync(() => {
              assert.strictEqual(
                state.conversationAdoptions[0]?.status,
                historyReadStatus
              )
              assert.strictEqual(
                state.conversationAdoptions[0]?.cutoffSlackTs,
                '255.000003'
              )
            })
          ),
          Effect.as(adoptionHistory)
        ),
    },
    conversationAgent,
    implementationAgent: {
      start: () =>
        Effect.die(new Error('Execution start is outside this test')),
    },
    now: () => 255_000,
    repository,
    worktreeManager: {
      create: () => Effect.die(new Error('Action start is outside this test')),
    },
  })

const runTurn = (
  application: ApplicationShape,
  turn: number,
  published: ApplicationPublicOutput[] = []
) =>
  application.handle(
    participantEvent(turn),
    (output) =>
      Effect.sync(() => {
        published.push(output)
      }),
    acceptEvent
  )

const createLegacyV14Conversation = Effect.fnUntraced(function* (
  path: string,
  root: string
) {
  const repository = yield* makeFileApplicationRepository(path, root)
  const application = yield* makeApplication(repository, {
    handle: () => Effect.succeed([]),
  })
  yield* runTurn(application, 1)
  const persisted = JSON.parse(
    yield* Effect.promise(() => readFile(path, 'utf8'))
  ) as {
    conversationAdoptions?: unknown
    conversations: { origin?: string }[]
    schemaVersion: number
  }
  const v14 = {
    ...persisted,
    conversationAdoptions: undefined,
    conversations: persisted.conversations.map((conversation) => ({
      ...conversation,
      origin: undefined,
    })),
    schemaVersion: 14,
  }
  yield* Effect.promise(() =>
    writeFile(path, JSON.stringify(v14), { mode: 0o600 })
  )
})

const persistedExecution = (
  executionId: string,
  status:
    | 'worktree_staged'
    | 'implementation_ready'
    | 'implementation_start_staged'
    | 'running'
    | 'cancelling'
    | 'completed'
    | 'failed'
    | 'cancelled',
  worktreeName = `worktree-${executionId.replaceAll(':', '-')}`
) => ({
  actionInvocationId: `operation-${executionId}`,
  actionName: 'create-feature',
  attachment: {
    reason: null,
    state: 'attached',
    updatedAt: 254_000,
  },
  cancellation: null,
  conversationId: CONVERSATION_ID,
  events: [
    {
      eventId: `${executionId}:terminal-evidence`,
      payload: {
        actionName: 'create-feature',
        executionId,
        status: 'completed',
      },
      source: 'action-terminal',
      status: 'staged',
    },
  ],
  executionId,
  implementationSessionId: `implementation-session-${executionId}`,
  ownerWorkspaceId: 'T255',
  prompts: [
    {
      attempt: {
        admittedAt: 254_002,
        certainty: 'admitted',
        completedAt: null,
        preparedAt: 254_001,
        promptId: `implementation-prompt-${executionId}`,
        runningAt: 254_003,
        sessionId: `implementation-session-${executionId}`,
        state: 'running',
        submittingAt: 254_002,
        unresolvedAt: null,
      },
      kind: 'initial',
      promptId: `implementation-prompt-${executionId}`,
      status: 'running',
      text: `private implementation prompt ${executionId}`,
    },
  ],
  recoveryFailure: null,
  responses: [
    {
      eventId: `${executionId}:response-event:before`,
      responseId: `${executionId}:response:before`,
      status: 'staged',
      text: `private implementation output ${executionId}`,
    },
  ],
  status,
  workingDirectory: `/private/worktrees/${executionId}`,
  worktreeAttempt: {
    attemptId: `worktree-attempt-${executionId}`,
    branch: `private/branch/${executionId}`,
    confirmedAt: 254_001,
    markerIdentityHash: `marker-${executionId}`,
    operationId: `operation-${executionId}`,
    preparedAt: 254_000,
    provisioningAt: 254_000,
    state: 'confirmed',
    updatedAt: 254_001,
    workingDirectory: `/private/worktrees/${executionId}`,
  },
  worktreeName,
})

const writeV15State = Effect.fnUntraced(function* (
  path: string,
  executions: readonly ReturnType<typeof persistedExecution>[]
) {
  const first = executions[0]
  const firstResponse = first?.responses[0]
  const firstEvent = first?.events[0]
  const executionEventOutbox =
    first === undefined ||
    firstResponse === undefined ||
    firstEvent === undefined
      ? []
      : [
          {
            contentHash: createHash('sha256')
              .update('laborer-execution-response-content-v1\0', 'utf8')
              .update(
                JSON.stringify({
                  eventId: firstResponse.eventId,
                  responseId: firstResponse.responseId,
                  text: firstResponse.text,
                }),
                'utf8'
              )
              .digest('base64url'),
            conversationId: CONVERSATION_ID,
            executionId: first.executionId,
            outboxId: 'pre-linearization-outbox-id',
            recordId: firstResponse.responseId,
            recordKind: 'response',
            sequence: 1,
            status: 'staged',
          },
          {
            contentHash: createHash('sha256')
              .update('laborer-execution-event-content-v1\0', 'utf8')
              .update(
                JSON.stringify({
                  eventId: firstEvent.eventId,
                  payload: firstEvent.payload,
                  source: firstEvent.source,
                }),
                'utf8'
              )
              .digest('base64url'),
            conversationId: CONVERSATION_ID,
            executionId: first.executionId,
            outboxId: 'pre-linearization-event-outbox-id',
            recordId: firstEvent.eventId,
            recordKind: 'event',
            sequence: 2,
            status: 'staged',
          },
        ]
  yield* Effect.promise(() =>
    writeFile(
      path,
      JSON.stringify({
        actionOperationTombstones:
          first === undefined
            ? []
            : [
                {
                  actionName: 'create-feature',
                  catalogFingerprint: 'catalog',
                  conversationId: CONVERSATION_ID,
                  failureCode: 'retained-failure',
                  identityVersion: 'action-operation-v2',
                  inputHash: 'input',
                  operationId: 'retained-tombstone',
                  ownerScopeDigest: 'owner',
                  retentionExpiresAt: Number.MAX_SAFE_INTEGER,
                  state: 'failed',
                  terminalAt: 254_000,
                  turnId: 'old-turn',
                },
              ],
        actionOperations:
          first === undefined
            ? []
            : [
                {
                  actionName: 'create-feature',
                  catalogFingerprint: 'catalog',
                  conversationId: CONVERSATION_ID,
                  createdAt: 254_000,
                  executionId: first.executionId,
                  failureCode: null,
                  identityVersion: 'action-operation-v2',
                  inputHash: 'input',
                  operationId: `operation-${first.executionId}`,
                  ownerScopeDigest: 'owner',
                  retentionExpiresAt: Number.MAX_SAFE_INTEGER,
                  state: 'running',
                  terminalEventId: null,
                  turnId: 'old-turn',
                  updatedAt: 254_001,
                },
              ],
        conversationAdoptions: [],
        conversations: [
          {
            agentSessionBinding: null,
            conversationId: CONVERSATION_ID,
            origin: 'legacy',
            prompts: [],
            sessionId: 'legacy-conversation-session',
          },
        ],
        executionEventOutbox,
        executionPromptOperations:
          first === undefined
            ? []
            : [
                {
                  catalogFingerprint: 'catalog',
                  conversationId: CONVERSATION_ID,
                  createdAt: 254_000,
                  executionId: first.executionId,
                  failureCode: null,
                  inputHash: 'prompt-input',
                  operationId: 'retained-prompt-operation',
                  ownerScopeDigest: 'owner',
                  promptId: `implementation-prompt-${first.executionId}`,
                  retentionExpiresAt: Number.MAX_SAFE_INTEGER,
                  state: 'running',
                  toolName: 'prompt-execution',
                  turnId: 'old-turn',
                  updatedAt: 254_001,
                },
              ],
        executions,
        recoveryDecisions: [],
        schemaVersion: 15,
      }),
      { mode: 0o600 }
    )
  )
})

const adoptingAgent = (
  requests: ConversationAgentRequest[]
): ConversationAgentShape => ({
  handle: (request) =>
    Effect.gen(function* () {
      requests.push(request)
      const bindingStore = request.sessionBindingStore
      const attemptStore = request.promptAttemptStore
      if (
        bindingStore === undefined ||
        bindingStore.beginSessionCreation === undefined ||
        attemptStore === undefined ||
        request.promptAttemptId === undefined
      ) {
        return yield* HandlerFailure.make({
          category: 'protocol',
          safeDetail: 'adoption stores unavailable',
        })
      }
      yield* bindingStore.beginSessionCreation()
      const binding = yield* bindingStore.replace(null, {
        ambiguousPromptId: null,
        cwd: '/tmp/laborer-255',
        cwdIdentity: 'device:inode',
        effectiveMetadata: null,
        effectiveMetadataFingerprint: null,
        initializationPhase: 'pending',
        introducedParticipantIds: [],
        lastAttachedProcessGeneration: 1,
        pendingParticipantIds: [],
        requiresReplacement: false,
        sessionId: 'fresh-acp-session-255',
      })
      yield* attemptStore.prepare({
        attemptId: request.promptAttemptId,
        bindingGeneration: binding.generation,
        preparedAt: 255_001,
        processGeneration: 1,
        sessionDigest: 'fresh-session-digest',
      })
      yield* bindingStore.beginPrompt(
        binding.generation,
        ['U255'],
        true,
        request.promptId
      )
      yield* attemptStore.markSubmitting(request.promptAttemptId, 255_002)
      yield* attemptStore.markTerminalAndCompleteBinding(
        request.promptAttemptId,
        'end_turn',
        255_003,
        binding.generation
      )
      return []
    }),
})

const adoptionOutcomeAgent = (
  outcome: ConversationPromptAttemptOutcome
): ConversationAgentShape => ({
  handle: (request) =>
    Effect.gen(function* () {
      const bindingStore = request.sessionBindingStore
      const attemptStore = request.promptAttemptStore
      const attemptId = request.promptAttemptId
      if (
        bindingStore === undefined ||
        bindingStore.beginSessionCreation === undefined ||
        attemptStore === undefined ||
        attemptId === undefined
      ) {
        return yield* HandlerFailure.make({
          category: 'protocol',
          safeDetail: 'adoption stores unavailable',
        })
      }
      yield* bindingStore.beginSessionCreation()
      const binding = yield* bindingStore.replace(null, {
        ambiguousPromptId: null,
        cwd: '/tmp/laborer-255-outcome',
        cwdIdentity: 'device:inode',
        effectiveMetadata: null,
        effectiveMetadataFingerprint: null,
        initializationPhase: 'pending',
        introducedParticipantIds: [],
        lastAttachedProcessGeneration: 1,
        pendingParticipantIds: [],
        requiresReplacement: false,
        sessionId: 'fresh-acp-session-255-outcome',
      })
      yield* attemptStore.prepare({
        attemptId,
        bindingGeneration: binding.generation,
        preparedAt: 255_001,
        processGeneration: 1,
        sessionDigest: 'fresh-session-digest',
      })
      yield* bindingStore.beginPrompt(
        binding.generation,
        ['U255'],
        true,
        request.promptId
      )
      yield* attemptStore.markSubmitting(attemptId, 255_002)
      if (outcome === 'unknown_stop') {
        yield* attemptStore.markUnknownStop(attemptId, 255_003)
      } else {
        yield* attemptStore.markTerminalAndCompleteBinding(
          attemptId,
          outcome,
          255_003,
          binding.generation
        )
      }
      return yield* HandlerFailure.make({
        category: outcome.startsWith('cancelled') ? 'signal' : 'protocol',
        safeDetail: 'simulated non-success adoption seed',
      })
    }),
})

describe('issue #255 Conversation adoption', () => {
  for (const outcome of [
    'refusal',
    'cancelled_agent',
    'max_tokens',
    'max_turn_requests',
    'protocol_failed',
    'unknown_stop',
  ] as const) {
    it.live(
      `keeps the seed owner blocked across restart after ${outcome}`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const root = yield* makeTempDirectoryScoped(
              `laborer-255-${outcome}-`
            )
            const path = join(root, 'application.json')
            yield* createLegacyV14Conversation(path, root)
            const repository = yield* makeFileApplicationRepository(path, root)
            const application = yield* makeApplication(
              repository,
              adoptionOutcomeAgent(outcome)
            )
            const failure = yield* Effect.flip(runTurn(application, 2))
            assert.ok(failure instanceof ConversationBlocked)
            const blocked = (yield* repository.load).conversationAdoptions[0]
            assert.strictEqual(blocked?.status, 'unresolved')
            assert.strictEqual(
              blocked?.seedTerminalOutcome,
              outcome === 'unknown_stop' ? null : outcome
            )
            assert.strictEqual(
              blocked?.unresolvedDiagnosticCode,
              'seed-admission-ambiguous'
            )
            const attempt = (yield* repository.load).conversations[0]?.prompts
              .find((prompt) => prompt.promptId === blocked?.seedPromptId)
              ?.attempts.at(-1)
            assert.strictEqual(attempt?.recoveryClass, 'unresolved')

            const restartedRepository = yield* makeFileApplicationRepository(
              path,
              root
            )
            let restartCalls = 0
            const restarted = yield* makeApplication(restartedRepository, {
              handle: () =>
                Effect.sync(() => {
                  restartCalls += 1
                  return []
                }),
              recover: () =>
                Effect.sync(() => {
                  restartCalls += 1
                  return []
                }),
            })
            const restartFailure = yield* Effect.flip(runTurn(restarted, 2))
            assert.ok(restartFailure instanceof ConversationBlocked)
            assert.strictEqual(restartCalls, 0)
            const queuedHuman = yield* Effect.result(runTurn(restarted, 3))
            const queuedExecution = yield* Effect.result(
              restarted.handle(
                ExternalInputEvent.make({
                  conversationId: ThreadId.make(CONVERSATION_ID),
                  eventId: `queued-execution-255-${outcome}`,
                  payload: { executionId: `execution-255-${outcome}` },
                  source: 'test',
                }),
                () => Effect.void,
                acceptEvent
              )
            )
            assert.strictEqual(queuedHuman._tag, 'Failure')
            assert.strictEqual(queuedExecution._tag, 'Failure')
            assert.strictEqual(restartCalls, 0)
            assert.strictEqual(
              (yield* restartedRepository.load).conversationAdoptions[0]
                ?.status,
              'unresolved'
            )
          })
        )
    )
  }

  it.live('migrates v14 and adopts once with a fresh bounded seed', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped('laborer-255-adopt-')
        const path = join(root, 'application.json')
        yield* createLegacyV14Conversation(path, root)
        const repository = yield* makeFileApplicationRepository(path, root)
        const migrated = yield* repository.load
        assert.strictEqual(migrated.schemaVersion, 16)
        assert.deepStrictEqual(migrated.conversationAdoptions, [])

        const requests: ConversationAgentRequest[] = []
        const application = yield* makeApplication(
          repository,
          adoptingAgent(requests)
        )
        yield* runTurn(application, 2)
        assert.strictEqual(requests.length, 1)
        const request = requests[0]
        assert.strictEqual(request?.conversationSessionIsNew, false)
        assert.ok(
          (request?.adoptionHistory ?? '').includes('old current history')
        )
        assert.strictEqual(request?.context.length, 0)
        assert.deepStrictEqual(
          request?.messages.map((message) => message.text),
          ['triggering turn 2']
        )

        const state = yield* repository.load
        const adoption = state.conversationAdoptions[0]
        assert.strictEqual(adoption?.status, 'adopted')
        assert.strictEqual(adoption?.historyDigest, historySnapshot.digest)
        assert.strictEqual(adoption?.acpSessionId, 'fresh-acp-session-255')
        assert.notStrictEqual(
          adoption?.acpSessionId,
          state.conversations[0]?.sessionId
        )
        assert.strictEqual(adoption?.seedTerminalOutcome, 'end_turn')
        const persistedText = yield* Effect.promise(() =>
          readFile(path, 'utf8')
        )
        assert.ok(!persistedText.includes('old current history'))
        assert.ok(persistedText.includes(historySnapshot.digest))

        yield* runTurn(application, 2)
        assert.strictEqual(requests.length, 1)
      })
    )
  )

  it.live('carries hydrated adopted images into the fresh seed request', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped('laborer-303-adopt-image-')
        const path = join(root, 'application.json')
        yield* createLegacyV14Conversation(path, root)
        const repository = yield* makeFileApplicationRepository(path, root)
        const image = NormalizedImageInput.make({
          byteLength: 8,
          contentDigest: 'd'.repeat(64),
          contentPath: `inbound-images/${'d'.repeat(64)}.png`,
          id: 'adopted-image',
          mimeType: 'image/png',
          slackFileId: 'F-ADOPTED',
        })
        const rendered = historyRendered.replace(
          '</slack-message>',
          '<slack-image id="adopted-image" mime-type="image/png" /></slack-message>'
        )
        const snapshot: ConversationAdoptionHistorySnapshot = {
          ...historySnapshot,
          bytes: Buffer.byteLength(rendered, 'utf8'),
          digest: createHash('sha256')
            .update(rendered, 'utf8')
            .digest('base64url'),
          images: [image],
          rendered,
        }
        const requests: ConversationAgentRequest[] = []
        const application = yield* makeApplication(
          repository,
          adoptingAgent(requests),
          snapshot
        )

        yield* runTurn(application, 2)

        assert.deepStrictEqual(requests[0]?.adoptionImages, [image])
        assert.strictEqual(requests[0]?.context.length, 0)
        assert.ok(
          (requests[0]?.adoptionHistory ?? '').includes('adopted-image')
        )
      })
    )
  )

  it.live('rejects malformed history snapshots before ACP side effects', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const changedRendered = historySnapshot.rendered.replace(
          'old current history',
          'different history with a stale digest'
        )
        const oversizedRendered = 'x'.repeat(256 * 1024 + 1)
        const malformedSnapshots: readonly ConversationAdoptionHistorySnapshot[] =
          [
            {
              ...historySnapshot,
              bytes: Buffer.byteLength(changedRendered, 'utf8'),
              rendered: changedRendered,
            },
            {
              ...historySnapshot,
              bytes: Buffer.byteLength(oversizedRendered, 'utf8'),
              digest: createHash('sha256')
                .update(oversizedRendered, 'utf8')
                .digest('base64url'),
              rendered: oversizedRendered,
            },
          ]

        for (const [index, snapshot] of malformedSnapshots.entries()) {
          const root = yield* makeTempDirectoryScoped(
            `laborer-255-invalid-history-${index}-`
          )
          const path = join(root, 'application.json')
          yield* createLegacyV14Conversation(path, root)
          const repository = yield* makeFileApplicationRepository(path, root)
          let agentCalls = 0
          const application = yield* makeApplication(
            repository,
            {
              handle: () =>
                Effect.sync(() => {
                  agentCalls += 1
                  return []
                }),
            },
            snapshot
          )

          const failure = yield* Effect.flip(runTurn(application, 2))
          assert.ok(failure instanceof HandlerFailure)
          assert.strictEqual(
            failure.safeDetail,
            'Conversation adoption history snapshot is invalid'
          )
          assert.strictEqual(agentCalls, 0)
          const adoption = (yield* repository.load).conversationAdoptions[0]
          assert.strictEqual(adoption?.status, 'staged')
          assert.strictEqual(adoption?.historyDigest, null)
          assert.strictEqual(adoption?.sessionCreationAttemptedAt, null)
        }
      })
    )
  )

  it.live(
    'blocks an ambiguous session/new boundary and never blindly creates another session',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped('laborer-255-crash-')
          const path = join(root, 'application.json')
          yield* createLegacyV14Conversation(path, root)
          const repository = yield* makeFileApplicationRepository(path, root)
          let calls = 0
          const crashingAgent: ConversationAgentShape = {
            handle: (request) =>
              Effect.gen(function* () {
                calls += 1
                yield* request.sessionBindingStore?.beginSessionCreation?.() ??
                  Effect.void
                return yield* HandlerFailure.make({
                  category: 'protocol',
                  safeDetail: 'simulated ambiguous session creation',
                })
              }),
          }
          const firstApplication = yield* makeApplication(
            repository,
            crashingAgent
          )
          const firstFailure = yield* Effect.flip(runTurn(firstApplication, 2))
          assert.ok(firstFailure instanceof ConversationBlocked)
          assert.strictEqual(calls, 1)
          const unresolved = (yield* repository.load).conversationAdoptions[0]
          assert.strictEqual(unresolved?.status, 'unresolved')
          assert.strictEqual(
            unresolved?.unresolvedDiagnosticCode,
            'session-creation-outcome-ambiguous'
          )

          const restartedRepository = yield* makeFileApplicationRepository(
            path,
            root
          )
          const restarted = yield* makeApplication(
            restartedRepository,
            crashingAgent
          )
          const restartFailure = yield* Effect.flip(runTurn(restarted, 2))
          assert.ok(restartFailure instanceof ConversationBlocked)
          assert.strictEqual(calls, 1)
        })
      )
  )

  it.live(
    'blocks restart when Slack history changes after the fresh session is durably created',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            'laborer-255-history-change-'
          )
          const path = join(root, 'application.json')
          yield* createLegacyV14Conversation(path, root)
          const repository = yield* makeFileApplicationRepository(path, root)
          const sessionCreated = yield* Deferred.make<void>()
          const interrupted = yield* makeApplication(repository, {
            handle: (request) =>
              Effect.gen(function* () {
                const bindingStore = request.sessionBindingStore
                if (
                  bindingStore === undefined ||
                  bindingStore.beginSessionCreation === undefined
                ) {
                  return yield* HandlerFailure.make({
                    category: 'protocol',
                    safeDetail: 'adoption store unavailable',
                  })
                }
                yield* bindingStore.beginSessionCreation()
                yield* bindingStore.replace(null, {
                  ambiguousPromptId: null,
                  cwd: '/tmp/laborer-255-history-change',
                  cwdIdentity: 'device:inode',
                  effectiveMetadata: null,
                  effectiveMetadataFingerprint: null,
                  initializationPhase: 'pending',
                  introducedParticipantIds: [],
                  lastAttachedProcessGeneration: 1,
                  pendingParticipantIds: [],
                  requiresReplacement: false,
                  sessionId: 'fresh-acp-session-before-history-change',
                })
                yield* Deferred.succeed(sessionCreated, undefined)
                return yield* Effect.never
              }),
          })
          const firstRun = yield* Effect.forkChild(runTurn(interrupted, 2))
          yield* Deferred.await(sessionCreated)
          yield* Fiber.interrupt(firstRun)
          assert.strictEqual(
            (yield* repository.load).conversationAdoptions[0]?.status,
            'session_created'
          )

          const changedRendered = historySnapshot.rendered.replace(
            'old current history',
            'edited after session creation'
          )
          const changedHistory = {
            ...historySnapshot,
            bytes: Buffer.byteLength(changedRendered, 'utf8'),
            digest: createHash('sha256')
              .update(changedRendered, 'utf8')
              .digest('base64url'),
            rendered: changedRendered,
          }
          let restartCalls = 0
          const restartedRepository = yield* makeFileApplicationRepository(
            path,
            root
          )
          const restarted = yield* makeApplication(
            restartedRepository,
            {
              handle: () =>
                Effect.sync(() => {
                  restartCalls += 1
                  return []
                }),
              recover: () =>
                Effect.sync(() => {
                  restartCalls += 1
                  return []
                }),
            },
            changedHistory,
            'session_created'
          )
          const failure = yield* Effect.flip(runTurn(restarted, 2))
          assert.ok(failure instanceof ConversationBlocked)
          assert.strictEqual(restartCalls, 0)
          const adoption = (yield* restartedRepository.load)
            .conversationAdoptions[0]
          assert.strictEqual(adoption?.status, 'unresolved')
          assert.strictEqual(
            adoption?.unresolvedDiagnosticCode,
            'history-digest-changed-before-seed'
          )
          assert.strictEqual(adoption?.historyDigest, historySnapshot.digest)
          assert.ok(
            adoption?.historyDiagnosticCodes.includes(
              'history-digest-changed-before-seed'
            )
          )
        })
      )
  )

  for (const nextOwner of ['human', 'execution'] as const) {
    it.live(
      `finalizes only the seed owner before running a queued ${nextOwner} owner`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const root = yield* makeTempDirectoryScoped(
              `laborer-255-finalized-${nextOwner}-`
            )
            const path = join(root, 'application.json')
            yield* createLegacyV14Conversation(path, root)
            const repository = yield* makeFileApplicationRepository(path, root)
            const seededApplication = yield* makeApplication(repository, {
              handle: (request) =>
                Effect.gen(function* () {
                  const agent = adoptingAgent([])
                  yield* agent.handle(request)
                  return yield* HandlerFailure.make({
                    category: 'protocol',
                    safeDetail: 'simulated crash after successful seed',
                  })
                }),
            })
            yield* Effect.result(runTurn(seededApplication, 2))
            assert.strictEqual(
              (yield* repository.load).conversationAdoptions[0]?.status,
              'seeded'
            )

            const requests: ConversationAgentRequest[] = []
            const restartedRepository = yield* makeFileApplicationRepository(
              path,
              root
            )
            const restarted = yield* makeApplication(restartedRepository, {
              handle: (request) =>
                Effect.sync(() => {
                  requests.push(request)
                  return []
                }),
            })
            if (nextOwner === 'human') {
              yield* runTurn(restarted, 3)
            } else {
              yield* restarted.handle(
                ExternalInputEvent.make({
                  conversationId: ThreadId.make(CONVERSATION_ID),
                  eventId: 'execution-owner-255',
                  payload: { executionId: 'execution-255' },
                  source: 'test',
                }),
                () => Effect.void,
                acceptEvent
              )
            }
            assert.strictEqual(requests.length, 1)
            assert.strictEqual(
              requests[0]?.source,
              nextOwner === 'human' ? 'slack' : 'test'
            )
            assert.strictEqual(requests[0]?.promptAttemptId, undefined)
            assert.strictEqual(
              (yield* restartedRepository.load).conversationAdoptions[0]
                ?.status,
              'adopted'
            )
          })
        )
    )
  }

  it.live(
    'preserves every Execution lifecycle and related durable ledger field during v15 to v16 adoption',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const statuses = [
            'worktree_staged',
            'implementation_ready',
            'implementation_start_staged',
            'running',
            'cancelling',
            'completed',
            'failed',
            'cancelled',
          ] as const
          for (const status of statuses) {
            const root = yield* makeTempDirectoryScoped(
              `laborer-256-lifecycle-${status}-`
            )
            const path = join(root, 'application.json')
            yield* writeV15State(path, [
              persistedExecution(`execution-${status}`, status),
            ])
            const repository = yield* makeFileApplicationRepository(path, root)
            const before = yield* repository.load
            assert.strictEqual(before.schemaVersion, 16)
            const preservedBefore = {
              actionOperationTombstones: before.actionOperationTombstones,
              actionOperations: before.actionOperations,
              executionEventOutbox: before.executionEventOutbox,
              executionPromptOperations: before.executionPromptOperations,
              executions: before.executions,
              recoveryDecisions: before.recoveryDecisions,
            }
            const requests: ConversationAgentRequest[] = []
            const application = yield* makeApplication(
              repository,
              adoptingAgent(requests)
            )
            yield* runTurn(application, 2)
            const after = yield* repository.load
            assert.deepStrictEqual(
              {
                actionOperationTombstones: after.actionOperationTombstones,
                actionOperations: after.actionOperations,
                executionEventOutbox: after.executionEventOutbox,
                executionPromptOperations: after.executionPromptOperations,
                executions: after.executions,
                recoveryDecisions: after.recoveryDecisions,
              },
              preservedBefore
            )
            assert.strictEqual(
              after.conversationAdoptions[0]?.status,
              'adopted'
            )
            assert.strictEqual(
              after.conversationAdoptions[0]?.executionEventOutboxHighWatermark,
              2
            )
            assert.strictEqual(requests.length, 1)
          }
        })
      )
  )

  it.live(
    'keeps recovered live-Execution evidence behind the adoption linearization point',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            'laborer-256-recovery-linearization-'
          )
          const path = join(root, 'application.json')
          const execution = persistedExecution(
            'execution-recovery-linearization',
            'running'
          )
          yield* writeV15State(path, [execution])
          const repository = yield* makeFileApplicationRepository(path, root)
          const requests: ConversationAgentRequest[] = []
          const application = yield* makeReferenceCodingApplication({
            conversationAdoptionHistory: {
              read: () => Effect.succeed(historySnapshot),
            },
            conversationAgent: adoptingAgent(requests),
            implementationAgent: {
              inspect: () =>
                Effect.succeed({
                  certainty: 'definitive' as const,
                  evidence: 'exact-owned-resource' as const,
                  resource: {
                    sessionId: execution.implementationSessionId,
                  },
                  status: 'available' as const,
                }),
              recover: () =>
                Effect.succeed({
                  completion: Effect.never,
                  resume: () => Effect.void,
                  sessionId: execution.implementationSessionId,
                }),
              start: () =>
                Effect.die(new Error('recovery must not start a replacement')),
            },
            now: () => 255_000,
            repository,
            worktreeManager: {
              create: () =>
                Effect.die(new Error('recovery must not create a worktree')),
              inspect: () =>
                Effect.succeed({
                  certainty: 'definitive' as const,
                  evidence: 'exact-owned-resource' as const,
                  resource: {
                    workingDirectory: execution.workingDirectory,
                  },
                  status: 'available' as const,
                }),
            },
          })
          const acceptedBeforeAdoption: ExternalInputEvent[] = []
          yield* application.recover?.((event) =>
            Effect.sync(() => {
              acceptedBeforeAdoption.push(event)
              return {
                decision: { _tag: 'Accepted' as const, eventId: event.eventId },
                scheduling: 'Scheduled' as const,
              }
            })
          ) ?? Effect.void

          assert.deepStrictEqual(acceptedBeforeAdoption, [])
          assert.deepStrictEqual(
            (yield* repository.load).executionEventOutbox.map(
              (item) => item.status
            ),
            ['staged', 'staged']
          )

          yield* runTurn(application, 2)
          assert.strictEqual(requests.length, 1)
          assert.ok(
            !(requests[0]?.adoptionHistory ?? '').includes(
              'private implementation output'
            )
          )
          assert.strictEqual(
            (yield* repository.load).conversationAdoptions[0]?.status,
            'adopted'
          )
        })
      )
  )

  it.live(
    'queues an implementation response arriving after linearization for the adopted ACP binding',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            'laborer-256-response-during-adoption-'
          )
          const path = join(root, 'application.json')
          const execution = persistedExecution(
            'execution-response-during-adoption',
            'running'
          )
          yield* writeV15State(path, [execution])
          const repository = yield* makeFileApplicationRepository(path, root)
          const historyReadStarted = yield* Deferred.make<void>()
          const releaseHistoryRead = yield* Deferred.make<void>()
          let acceptResponse: AcceptImplementationAgentResponse | undefined
          const requests: ConversationAgentRequest[] = []
          const adoptionAgent = adoptingAgent(requests)
          const application = yield* makeReferenceCodingApplication({
            conversationAdoptionHistory: {
              read: () =>
                Deferred.succeed(historyReadStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseHistoryRead)),
                  Effect.as(historySnapshot)
                ),
            },
            conversationAgent: {
              handle: (request, publish) =>
                request.adoptionHistory === undefined
                  ? Effect.sync(() => {
                      requests.push(request)
                      return []
                    })
                  : adoptionAgent.handle(request, publish),
            },
            implementationAgent: {
              inspect: () =>
                Effect.succeed({
                  certainty: 'definitive' as const,
                  evidence: 'exact-owned-resource' as const,
                  resource: {
                    sessionId: execution.implementationSessionId,
                  },
                  status: 'available' as const,
                }),
              recover: (_request, accept) => {
                acceptResponse = accept
                return Effect.succeed({
                  completion: Effect.never,
                  resume: () => Effect.void,
                  sessionId: execution.implementationSessionId,
                })
              },
              start: () =>
                Effect.die(new Error('recovery must not start a replacement')),
            },
            now: () => 255_000,
            repository,
            worktreeManager: {
              create: () =>
                Effect.die(new Error('recovery must not create a worktree')),
              inspect: () =>
                Effect.succeed({
                  certainty: 'definitive' as const,
                  evidence: 'exact-owned-resource' as const,
                  resource: {
                    workingDirectory: execution.workingDirectory,
                  },
                  status: 'available' as const,
                }),
            },
          })
          const accepted: ExternalInputEvent[] = []
          const acceptDuringAdoption = (event: ExternalInputEvent) =>
            Effect.sync(() => {
              accepted.push(event)
              return {
                decision: { _tag: 'Accepted' as const, eventId: event.eventId },
                scheduling: 'Scheduled' as const,
              }
            })
          yield* application.recover?.(acceptDuringAdoption) ?? Effect.void
          assert.ok(acceptResponse !== undefined)

          const adoption = yield* Effect.forkChild(
            application.handle(
              participantEvent(2),
              () => Effect.void,
              acceptDuringAdoption
            )
          )
          yield* Deferred.await(historyReadStarted)
          assert.strictEqual(
            (yield* repository.load).conversationAdoptions[0]
              ?.executionEventOutboxHighWatermark,
            2
          )

          yield* acceptResponse({
            responseId: 'response-during-adoption',
            text: 'implementation response during adoption',
          })
          assert.deepStrictEqual(
            accepted.map((event) => event.eventId),
            [
              'execution-response-during-adoption:response:response-during-adoption',
            ]
          )
          yield* Deferred.succeed(releaseHistoryRead, undefined)
          yield* Fiber.join(adoption)

          const queued = accepted[0]
          assert.ok(queued !== undefined)
          yield* application.handle(queued, () => Effect.void, acceptEvent)
          assert.strictEqual(requests.length, 2)
          assert.strictEqual(requests[1]?.source, 'implementation-agent')
          assert.ok(
            requests[1]?.input.includes(
              'implementation response during adoption'
            )
          )
          const adoptedBindingStore = requests[1]?.sessionBindingStore
          assert.ok(adoptedBindingStore !== undefined)
          assert.strictEqual(
            (yield* adoptedBindingStore.load)?.sessionId,
            'fresh-acp-session-255'
          )
          const response =
            (yield* repository.load).executions[0]?.responses.find(
              (candidate) => candidate.responseId === 'response-during-adoption'
            )
          assert.strictEqual(response?.status, 'delivered')
        })
      )
  )

  it.live(
    'persists a deterministic bounded redacted Execution snapshot and seeds it as untrusted reference only',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            'laborer-256-safe-snapshot-'
          )
          const path = join(root, 'application.json')
          const executions = Array.from({ length: 21 }, (_, index) =>
            persistedExecution(
              `execution-${String(index).padStart(2, '0')}`,
              index === 0 ? 'running' : 'completed',
              index === 0 ? '../private-worktree' : `safe-${index}`
            )
          )
          yield* writeV15State(path, executions)
          const repository = yield* makeFileApplicationRepository(path, root)
          const requests: ConversationAgentRequest[] = []
          const application = yield* makeApplication(
            repository,
            adoptingAgent(requests)
          )
          yield* runTurn(application, 2)

          const adoption = (yield* repository.load).conversationAdoptions[0]
          const rendered = adoption?.executionSnapshotRendered ?? ''
          assert.strictEqual(adoption?.executionSnapshotCount, 20)
          assert.strictEqual(adoption?.executionSnapshotTruncated, true)
          assert.strictEqual(
            adoption?.executionSnapshotBytes,
            Buffer.byteLength(rendered, 'utf8')
          )
          assert.ok(
            (adoption?.executionSnapshotBytes ?? Number.POSITIVE_INFINITY) <=
              64 * 1024
          )
          assert.strictEqual(
            adoption?.executionSnapshotDigest,
            createHash('sha256')
              .update('laborer-conversation-adoption-executions-v1\0', 'utf8')
              .update(rendered, 'utf8')
              .digest('base64url')
          )
          assert.ok(rendered.includes('worktree-label="redacted-worktree"'))
          assert.ok(rendered.includes('can-prompt="true"'))
          assert.ok(rendered.includes('can-cancel="true"'))
          assert.ok(
            rendered.indexOf('execution-00') < rendered.indexOf('execution-01')
          )
          for (const secret of [
            '/private/worktrees/',
            'private/branch/',
            'implementation-session-',
            'private implementation prompt',
            'private implementation output',
          ]) {
            assert.ok(!rendered.includes(secret))
          }
          assert.ok((requests[0]?.adoptionHistory ?? '').startsWith(rendered))
          assert.deepStrictEqual(requests[0]?.executions, [])
          assert.ok(
            (requests[0]?.adoptionHistory ?? '').includes('old current history')
          )
        })
      )
  )

  it.live(
    'routes responses deterministically around the outbox watermark and keeps FIFO on the adopted ACP binding',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped('laborer-256-watermark-')
          const path = join(root, 'application.json')
          const execution = persistedExecution('execution-watermark', 'running')
          yield* writeV15State(path, [execution])
          const repository = yield* makeFileApplicationRepository(path, root)
          const seedRequests: ConversationAgentRequest[] = []
          const application = yield* makeApplication(
            repository,
            adoptingAgent(seedRequests)
          )
          yield* runTurn(application, 2)
          const beforePreEvidence = yield* repository.load
          const preResponse = execution.responses[0]
          assert.ok(preResponse !== undefined)
          yield* application.handle(
            ExternalInputEvent.make({
              conversationId: ThreadId.make(CONVERSATION_ID),
              eventId: preResponse.eventId,
              payload: {
                actionName: execution.actionName,
                executionId: execution.executionId,
                responseId: preResponse.responseId,
                text: preResponse.text,
              },
              source: 'implementation-agent',
            }),
            () => Effect.void,
            acceptEvent
          )
          assert.strictEqual(seedRequests.length, 1)
          assert.deepStrictEqual(
            (yield* repository.load).executionEventOutbox,
            beforePreEvidence.executionEventOutbox
          )

          const raw = JSON.parse(
            yield* Effect.promise(() => readFile(path, 'utf8'))
          ) as {
            executionEventOutbox: Record<string, unknown>[]
            executions: {
              executionId: string
              responses: Record<string, unknown>[]
            }[]
          }
          const persisted = raw.executions.find(
            (candidate) => candidate.executionId === execution.executionId
          )
          assert.ok(persisted !== undefined)
          for (const sequence of [3, 4]) {
            persisted.responses.push({
              eventId: `${execution.executionId}:response-event:${sequence}`,
              responseId: `${execution.executionId}:response:${sequence}`,
              status: 'enqueued',
              text: `post-watermark response ${sequence}`,
            })
            raw.executionEventOutbox.push({
              contentHash: `post-watermark-hash-${sequence}`,
              conversationId: CONVERSATION_ID,
              executionId: execution.executionId,
              outboxId: `post-watermark-outbox-${sequence}`,
              recordId: `${execution.executionId}:response:${sequence}`,
              recordKind: 'response',
              sequence,
              status: 'enqueued',
            })
          }
          yield* Effect.promise(() => writeFile(path, JSON.stringify(raw)))

          const restartedRepository = yield* makeFileApplicationRepository(
            path,
            root
          )
          const delivered: string[] = []
          const bindingSessionIds: (string | undefined)[] = []
          const restarted = yield* makeApplication(restartedRepository, {
            handle: (request) =>
              Effect.gen(function* () {
                delivered.push(request.input)
                const binding = yield* request.sessionBindingStore?.load ??
                  Effect.succeed(null)
                bindingSessionIds.push(binding?.sessionId)
                return []
              }),
          })
          for (const sequence of [3, 4]) {
            yield* restarted.handle(
              ExternalInputEvent.make({
                conversationId: ThreadId.make(CONVERSATION_ID),
                eventId: `${execution.executionId}:response-event:${sequence}`,
                payload: {
                  actionName: execution.actionName,
                  executionId: execution.executionId,
                  responseId: `${execution.executionId}:response:${sequence}`,
                  text: `post-watermark response ${sequence}`,
                },
                source: 'implementation-agent',
              }),
              () => Effect.void,
              acceptEvent
            )
          }
          assert.deepStrictEqual(
            delivered.map((input) =>
              input.includes('post-watermark response 3') ? 3 : 4
            ),
            [3, 4]
          )
          assert.deepStrictEqual(bindingSessionIds, [
            'fresh-acp-session-255',
            'fresh-acp-session-255',
          ])
          const finalState = yield* restartedRepository.load
          assert.strictEqual(
            finalState.executions[0]?.responses.find((response) =>
              response.responseId.endsWith(':3')
            )?.status,
            'delivered'
          )
          assert.strictEqual(
            finalState.executions[0]?.responses.find((response) =>
              response.responseId.endsWith(':4')
            )?.status,
            'delivered'
          )
        })
      )
  )
})
