import { stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Array as EffectArray, Fiber, Ref } from 'effect'
import { makeAcpConversationAgent } from '../src/acp-runtime/acp-conversation-agent.ts'
import type {
  ConversationAgentRequest,
  ConversationPromptAttempt,
  ConversationPromptAttemptOutcome,
  ConversationPromptAttemptStore,
  PublishConversationAgentMessage,
} from '../src/reference-coding-application.ts'
import { makeTempDirectoryScoped } from './support/temp-directory.ts'

const projectRoot = process.cwd()
const scriptedPeerPath = resolve(
  projectRoot,
  'tests/fixtures/scripted-acp-peer.ts'
)
const OBSERVATION_TIMEOUT_MILLIS = 5000

const waitForFile = Effect.fnUntraced(function* (path: string) {
  const deadline = Date.now() + OBSERVATION_TIMEOUT_MILLIS
  while (Date.now() < deadline) {
    const exists = yield* Effect.promise(async () => {
      try {
        return (await stat(path)).size > 0
      } catch {
        return false
      }
    })
    if (exists) {
      return
    }
    yield* Effect.sleep('10 millis')
  }
  return yield* Effect.die(new Error(`timed out waiting for ${path}`))
})

const waitForPublished = Effect.fnUntraced(function* (
  published: Ref.Ref<readonly string[]>,
  expected: readonly string[]
) {
  const deadline = Date.now() + OBSERVATION_TIMEOUT_MILLIS
  while (Date.now() < deadline) {
    const observed = yield* Ref.get(published)
    if (
      observed.length === expected.length &&
      EffectArray.every(observed, (text, index) => text === expected[index])
    ) {
      return observed
    }
    yield* Effect.sleep('10 millis')
  }
  return yield* Effect.die(
    new Error(`timed out waiting for published text: ${expected.join(' | ')}`)
  )
})

const conversationRequest = (
  promptAttemptStore: ConversationPromptAttemptStore
): ConversationAgentRequest => ({
  actions: [],
  context: [],
  conversationId: 'conversation:silent-reply',
  conversationSessionId: 'logical-session:silent-reply',
  conversationSessionIsNew: true,
  executionControls: [],
  executions: [],
  input: 'Decide whether a visible response is needed.',
  messages: [],
  promptAttemptId: 'attempt:silent-reply',
  promptAttemptStore,
  promptId: 'prompt:silent-reply',
  source: 'slack',
  turnId: 'turn:silent-reply',
})

const makeAttemptStore = (
  onPublicOutputObserved: () => void,
  onTerminal: (outcome: ConversationPromptAttemptOutcome) => void = () =>
    undefined
): ConversationPromptAttemptStore => {
  const attempt: ConversationPromptAttempt = {
    attemptId: 'attempt:silent-reply',
    bindingGeneration: null,
    cancellationIntent: null,
    interruptedAt: null,
    outcome: null,
    phase: 'prepared',
    preparedAt: 0,
    processGeneration: 1,
    publicOutputObserved: false,
    recoveryClass: 'retryable',
    sessionDigest: null,
    submittedAt: null,
    terminalAt: null,
  }
  const unchanged = Effect.succeed(attempt)
  return {
    latest: Effect.succeed(null),
    markCancellationIntent: () => unchanged,
    markInterrupted: () => unchanged,
    markPublicOutputObserved: () =>
      Effect.sync(() => {
        onPublicOutputObserved()
        return attempt
      }),
    markSubmitting: () => unchanged,
    markTerminal: (_attemptId, outcome) =>
      Effect.sync(() => {
        onTerminal(outcome)
        return attempt
      }),
    markTerminalAndCompleteBinding: (_attemptId, outcome) =>
      Effect.sync(() => {
        onTerminal(outcome)
        return attempt
      }),
    markUnknownStop: () => unchanged,
    prepare: () => unchanged,
  }
}

describe('ACP Conversation silent reply', () => {
  it.live(
    'suppresses a whitespace-wrapped NO_REPLY split across ACP chunks',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const temporaryRoot = yield* makeTempDirectoryScoped(
            'laborer-acp-silent-reply-'
          )
          const published = yield* Ref.make<readonly string[]>([])
          let publicOutputObservedCount = 0
          const conversationAgent = yield* makeAcpConversationAgent({
            args: [scriptedPeerPath],
            command: process.execPath,
            cwd: projectRoot,
            environment: {
              HOME: temporaryRoot,
              PATH: process.env.PATH,
              SCRIPTED_ACP_PUBLIC_OUTPUT_CHUNKS_JSON: JSON.stringify([
                '\uFEFF\u2028',
                'NO_',
                'RE',
                'PLY',
                '\t\u00A0',
              ]),
              SCRIPTED_ACP_READY_PATH: resolve(temporaryRoot, 'ready'),
              SCRIPTED_ACP_RELEASE_PATH: resolve(temporaryRoot, 'release'),
            },
          })
          const publishMessage: PublishConversationAgentMessage = (message) =>
            Ref.update(published, (current) =>
              EffectArray.append(current, message.text)
            )

          const result = yield* conversationAgent.handle(
            conversationRequest(
              makeAttemptStore(() => {
                publicOutputObservedCount += 1
              })
            ),
            publishMessage
          )

          assert.deepStrictEqual(result, [])
          assert.deepStrictEqual(yield* Ref.get(published), [])
          assert.strictEqual(publicOutputObservedCount, 0)
        })
      ),
    10_000
  )

  for (const stopReason of ['max_tokens', 'max_turn_requests'] as const) {
    it.live(
      `counts a suppressed NO_REPLY as semantic completion for ${stopReason} without durable public output`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const temporaryRoot = yield* makeTempDirectoryScoped(
              `laborer-acp-silent-${stopReason}-`
            )
            const published = yield* Ref.make<readonly string[]>([])
            const terminalOutcomes: ConversationPromptAttemptOutcome[] = []
            let publicOutputObservedCount = 0
            const conversationAgent = yield* makeAcpConversationAgent({
              args: [scriptedPeerPath],
              command: process.execPath,
              cwd: projectRoot,
              environment: {
                HOME: temporaryRoot,
                PATH: process.env.PATH,
                SCRIPTED_ACP_PUBLIC_OUTPUT_CHUNKS_JSON: JSON.stringify([
                  ' \nNO_',
                  'REPLY',
                  '\t',
                ]),
                SCRIPTED_ACP_PUBLIC_OUTPUT_STOP_REASON: stopReason,
                SCRIPTED_ACP_READY_PATH: resolve(temporaryRoot, 'ready'),
                SCRIPTED_ACP_RELEASE_PATH: resolve(temporaryRoot, 'release'),
              },
            })

            const result = yield* conversationAgent.handle(
              conversationRequest(
                makeAttemptStore(
                  () => {
                    publicOutputObservedCount += 1
                  },
                  (outcome) => {
                    terminalOutcomes.push(outcome)
                  }
                )
              ),
              (message) =>
                Ref.update(published, (current) =>
                  EffectArray.append(current, message.text)
                )
            )

            assert.deepStrictEqual(result, [])
            assert.deepStrictEqual(yield* Ref.get(published), [])
            assert.strictEqual(publicOutputObservedCount, 0)
            assert.deepStrictEqual(terminalOutcomes, [stopReason])
          })
        ),
      10_000
    )
  }

  it.live(
    'flushes held prefix chunks in order as soon as the response diverges',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const temporaryRoot = yield* makeTempDirectoryScoped(
            'laborer-acp-silent-divergence-'
          )
          const readyPath = resolve(temporaryRoot, 'ready')
          const releasePath = resolve(temporaryRoot, 'release')
          const published = yield* Ref.make<readonly string[]>([])
          const conversationAgent = yield* makeAcpConversationAgent({
            args: [scriptedPeerPath],
            command: process.execPath,
            cwd: projectRoot,
            environment: {
              HOME: temporaryRoot,
              PATH: process.env.PATH,
              SCRIPTED_ACP_PAUSE_AFTER_PUBLIC_OUTPUT_CHUNK: '2',
              SCRIPTED_ACP_PUBLIC_OUTPUT_CHUNKS_JSON: JSON.stringify([
                'NO',
                ' response is needed.',
              ]),
              SCRIPTED_ACP_READY_PATH: readyPath,
              SCRIPTED_ACP_RELEASE_PATH: releasePath,
            },
          })
          const publishMessage: PublishConversationAgentMessage = (message) =>
            Ref.update(published, (current) =>
              EffectArray.append(current, message.text)
            )
          const handle = yield* Effect.forkChild(
            conversationAgent.handle(
              conversationRequest(makeAttemptStore(() => undefined)),
              publishMessage
            )
          )

          yield* waitForFile(readyPath)
          assert.strictEqual(handle.pollUnsafe(), undefined)
          assert.deepStrictEqual(
            yield* waitForPublished(published, ['NO', ' response is needed.']),
            ['NO', ' response is needed.']
          )

          yield* Effect.promise(() =>
            writeFile(releasePath, 'release', { mode: 0o600 })
          )
          assert.deepStrictEqual(yield* Fiber.join(handle), [])
        })
      ),
    10_000
  )

  it.live('keeps substantive text containing NO_REPLY visible', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const temporaryRoot = yield* makeTempDirectoryScoped(
          'laborer-acp-silent-containing-'
        )
        const chunks = ['The token ', 'NO_REPLY', ' remains ordinary text.']
        const published = yield* Ref.make<readonly string[]>([])
        const conversationAgent = yield* makeAcpConversationAgent({
          args: [scriptedPeerPath],
          command: process.execPath,
          cwd: projectRoot,
          environment: {
            HOME: temporaryRoot,
            PATH: process.env.PATH,
            SCRIPTED_ACP_PUBLIC_OUTPUT_CHUNKS_JSON: JSON.stringify(chunks),
            SCRIPTED_ACP_READY_PATH: resolve(temporaryRoot, 'ready'),
            SCRIPTED_ACP_RELEASE_PATH: resolve(temporaryRoot, 'release'),
          },
        })
        const publishMessage: PublishConversationAgentMessage = (message) =>
          Ref.update(published, (current) =>
            EffectArray.append(current, message.text)
          )

        const result = yield* conversationAgent.handle(
          conversationRequest(makeAttemptStore(() => undefined)),
          publishMessage
        )

        assert.deepStrictEqual(result, [])
        assert.deepStrictEqual(yield* Ref.get(published), chunks)
      })
    )
  )

  it.live('keeps substantive text ending with NO_REPLY visible', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const temporaryRoot = yield* makeTempDirectoryScoped(
          'laborer-acp-silent-ending-'
        )
        const chunks = ['This substantive response ends with ', 'NO_REPLY']
        const published = yield* Ref.make<readonly string[]>([])
        const conversationAgent = yield* makeAcpConversationAgent({
          args: [scriptedPeerPath],
          command: process.execPath,
          cwd: projectRoot,
          environment: {
            HOME: temporaryRoot,
            PATH: process.env.PATH,
            SCRIPTED_ACP_PUBLIC_OUTPUT_CHUNKS_JSON: JSON.stringify(chunks),
            SCRIPTED_ACP_READY_PATH: resolve(temporaryRoot, 'ready'),
            SCRIPTED_ACP_RELEASE_PATH: resolve(temporaryRoot, 'release'),
          },
        })
        const publishMessage: PublishConversationAgentMessage = (message) =>
          Ref.update(published, (current) =>
            EffectArray.append(current, message.text)
          )

        const result = yield* conversationAgent.handle(
          conversationRequest(makeAttemptStore(() => undefined)),
          publishMessage
        )

        assert.deepStrictEqual(result, [])
        assert.deepStrictEqual(yield* Ref.get(published), chunks)
      })
    )
  )

  it.live('keeps a differently cased no_reply token visible', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const temporaryRoot = yield* makeTempDirectoryScoped(
          'laborer-acp-silent-case-sensitive-'
        )
        const chunks = [' \t', 'no_reply', '\n']
        const published = yield* Ref.make<readonly string[]>([])
        const conversationAgent = yield* makeAcpConversationAgent({
          args: [scriptedPeerPath],
          command: process.execPath,
          cwd: projectRoot,
          environment: {
            HOME: temporaryRoot,
            PATH: process.env.PATH,
            SCRIPTED_ACP_PUBLIC_OUTPUT_CHUNKS_JSON: JSON.stringify(chunks),
            SCRIPTED_ACP_READY_PATH: resolve(temporaryRoot, 'ready'),
            SCRIPTED_ACP_RELEASE_PATH: resolve(temporaryRoot, 'release'),
          },
        })

        const result = yield* conversationAgent.handle(
          conversationRequest(makeAttemptStore(() => undefined)),
          (message) =>
            Ref.update(published, (current) =>
              EffectArray.append(current, message.text)
            )
        )

        assert.deepStrictEqual(result, [])
        assert.deepStrictEqual(yield* Ref.get(published), chunks)
      })
    )
  )

  it.live(
    'flushes a held non-silent candidate before preserving refusal failure semantics',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const temporaryRoot = yield* makeTempDirectoryScoped(
            'laborer-acp-silent-refusal-'
          )
          const chunks = [' \t', 'NO_']
          const published = yield* Ref.make<readonly string[]>([])
          const terminalOutcomes: ConversationPromptAttemptOutcome[] = []
          let publicOutputObservedCount = 0
          const conversationAgent = yield* makeAcpConversationAgent({
            args: [scriptedPeerPath],
            command: process.execPath,
            cwd: projectRoot,
            environment: {
              HOME: temporaryRoot,
              PATH: process.env.PATH,
              SCRIPTED_ACP_PUBLIC_OUTPUT_CHUNKS_JSON: JSON.stringify(chunks),
              SCRIPTED_ACP_PUBLIC_OUTPUT_STOP_REASON: 'refusal',
              SCRIPTED_ACP_READY_PATH: resolve(temporaryRoot, 'ready'),
              SCRIPTED_ACP_RELEASE_PATH: resolve(temporaryRoot, 'release'),
            },
          })

          const result = yield* Effect.result(
            conversationAgent.handle(
              conversationRequest(
                makeAttemptStore(
                  () => {
                    publicOutputObservedCount += 1
                  },
                  (outcome) => {
                    terminalOutcomes.push(outcome)
                  }
                )
              ),
              (message) =>
                Ref.update(published, (current) =>
                  EffectArray.append(current, message.text)
                )
            )
          )

          assert.strictEqual(result._tag, 'Failure')
          assert.deepStrictEqual(yield* Ref.get(published), chunks)
          assert.strictEqual(publicOutputObservedCount, chunks.length)
          assert.deepStrictEqual(terminalOutcomes, ['refusal'])
        })
      ),
    10_000
  )
})
