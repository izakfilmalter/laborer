import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Redacted } from 'effect'
import {
  ChatPlane,
  ChatPlaneOperationError,
  ChatPlaneStartupError,
  type ChatSdkLike,
  type ChatSdkMentionHandler,
  type ChatSdkMessageLike,
  type ChatSdkThreadLike,
  makeChatPlaneLayer,
  makeLocalSlackInstallationProvider,
  workspaceIdFromRawSlackMessage,
} from '../src/chat-plane/chat-sdk.ts'
import {
  type ChatPlaneTurn,
  makeConversationHandler,
  TURN_FAILED_OPERATIONAL_NOTICE,
} from '../src/chat-plane/conversation-handler.ts'
import { placeholderMentionHandler } from '../src/chat-plane/placeholder-handler.ts'
import {
  ACP_CANARY_SLACK_APP_TOKEN_VARIABLE,
  ACP_CANARY_SLACK_BOT_TOKEN_VARIABLE,
  CHAT_CANARY_SLACK_APP_TOKEN_VARIABLE,
  CHAT_CANARY_SLACK_BOT_TOKEN_VARIABLE,
  CHAT_CANARY_SLACK_WORKSPACES_VARIABLE,
  loadChatCanarySlackConfig,
} from '../src/slack/config.ts'

const CHAT_SDK_PACKAGE_IMPORT =
  /from ["'](?:chat|@chat-adapter\/slack|@chat-adapter\/state-memory)["']/
const PRIVATE_FAILURE_DETAIL = /secret|private|TOKEN|value/

const asMessages = (
  messages: readonly ChatSdkMessageLike[]
): AsyncIterable<ChatSdkMessageLike> => ({
  async *[Symbol.asyncIterator]() {
    yield* messages
  },
})

const failingMessages = (): AsyncIterable<ChatSdkMessageLike> => ({
  [Symbol.asyncIterator]() {
    return {
      next: () => Promise.reject(new Error('private history failure')),
    }
  },
})

const message = (
  id: string,
  text: string,
  options: {
    readonly edited?: boolean
    readonly isBot?: boolean
    readonly isMe?: boolean
    readonly isMention?: boolean
    readonly isSystem?: boolean
    readonly workspaceId?: string
  } = {}
): ChatSdkMessageLike => ({
  author: {
    isBot: options.isBot ?? false,
    isMe: options.isMe ?? false,
    isSystem: options.isSystem ?? false,
    userId: options.isMe ? 'U-LABORER' : `U-${id}`,
  },
  edited: options.edited ?? false,
  id,
  isMention: options.isMention ?? false,
  sentAt: new Date(Number(id.split('.')[0] ?? '0') * 1000),
  text,
  workspaceId: options.workspaceId ?? 'TFIRST',
})

describe('Chat plane walking skeleton', () => {
  it.effect('requires valid credentials dedicated to the Chat SDK canary', () =>
    Effect.gen(function* () {
      const appToken = ['x', 'app', '-chat-canary-fixture'].join('')
      const botToken = ['x', 'oxb', '-chat-canary-fixture'].join('')

      const missingDedicatedTokens = yield* Effect.result(
        loadChatCanarySlackConfig({
          SLACK_APP_TOKEN: ['x', 'app', '-production-fixture'].join(''),
          SLACK_BOT_TOKEN: ['x', 'oxb', '-production-fixture'].join(''),
        })
      )
      assert.strictEqual(missingDedicatedTokens._tag, 'Failure')

      const reusedProductionTokens = yield* Effect.result(
        loadChatCanarySlackConfig({
          [CHAT_CANARY_SLACK_APP_TOKEN_VARIABLE]: appToken,
          [CHAT_CANARY_SLACK_BOT_TOKEN_VARIABLE]: botToken,
          SLACK_APP_TOKEN: appToken,
          SLACK_BOT_TOKEN: botToken,
        })
      )
      assert.strictEqual(reusedProductionTokens._tag, 'Failure')
      if (reusedProductionTokens._tag === 'Failure') {
        assert.strictEqual(
          reusedProductionTokens.failure.reason,
          'matches-production-token'
        )
      }

      const reusedAcpCanaryTokens = yield* Effect.result(
        loadChatCanarySlackConfig({
          [ACP_CANARY_SLACK_APP_TOKEN_VARIABLE]: appToken,
          [ACP_CANARY_SLACK_BOT_TOKEN_VARIABLE]: botToken,
          [CHAT_CANARY_SLACK_APP_TOKEN_VARIABLE]: appToken,
          [CHAT_CANARY_SLACK_BOT_TOKEN_VARIABLE]: botToken,
        })
      )
      assert.strictEqual(reusedAcpCanaryTokens._tag, 'Failure')
      if (reusedAcpCanaryTokens._tag === 'Failure') {
        assert.strictEqual(
          reusedAcpCanaryTokens.failure.reason,
          'matches-other-canary-token'
        )
      }

      const reusedAcpCanaryBotToken = yield* Effect.result(
        loadChatCanarySlackConfig({
          [ACP_CANARY_SLACK_APP_TOKEN_VARIABLE]: [
            'x',
            'app',
            '-acp-canary-fixture',
          ].join(''),
          [ACP_CANARY_SLACK_BOT_TOKEN_VARIABLE]: botToken,
          [CHAT_CANARY_SLACK_APP_TOKEN_VARIABLE]: appToken,
          [CHAT_CANARY_SLACK_BOT_TOKEN_VARIABLE]: botToken,
        })
      )
      assert.strictEqual(reusedAcpCanaryBotToken._tag, 'Failure')
      if (reusedAcpCanaryBotToken._tag === 'Failure') {
        assert.strictEqual(
          reusedAcpCanaryBotToken.failure.variable,
          CHAT_CANARY_SLACK_BOT_TOKEN_VARIABLE
        )
      }

      const dedicatedConfig = yield* loadChatCanarySlackConfig({
        [CHAT_CANARY_SLACK_APP_TOKEN_VARIABLE]: appToken,
        [CHAT_CANARY_SLACK_BOT_TOKEN_VARIABLE]: botToken,
      })
      assert.strictEqual(dedicatedConfig.mode, 'single-workspace')
      assert.strictEqual(dedicatedConfig.appToken.toString(), '<redacted>')
      if (dedicatedConfig.mode === 'single-workspace') {
        assert.strictEqual(dedicatedConfig.botToken.toString(), '<redacted>')
      }
    })
  )

  it.effect('bridges a mention Effect into a streamed SDK thread reply', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const lifecycle: string[] = []
        const streamedChunks: string[] = []
        let mentionHandler: ChatSdkMentionHandler | undefined
        const activation = message('123.456', '@laborer hello', {
          isMention: true,
        })

        const thread: ChatSdkThreadLike = {
          allMessages: asMessages([activation]),
          channelId: 'C1',
          channelMessages: asMessages([activation]),
          id: 'slack:C123:123.456',
          isDM: false,
          post: async (reply) => {
            for await (const chunk of reply) {
              streamedChunks.push(chunk)
            }
          },
          rootMessageId: '123.456',
          subscribe: () => {
            lifecycle.push('subscribe')
            return Promise.resolve()
          },
          workspaceId: 'TFIRST',
        }
        const sdk: ChatSdkLike = {
          initialize: () => {
            lifecycle.push('initialize')
            return Promise.resolve()
          },
          onNewMention: (handler) => {
            mentionHandler = handler
          },
          onSubscribedMessage: () => undefined,
          shutdown: () => {
            lifecycle.push('shutdown')
            return Promise.resolve()
          },
        }

        yield* Effect.provide(
          Effect.promise(() => {
            assert.ok(mentionHandler)
            return mentionHandler(thread, activation)
          }),
          makeChatPlaneLayer({
            handler: placeholderMentionHandler,
            makeSdk: () => sdk,
          })
        )

        assert.deepStrictEqual(lifecycle, [
          'initialize',
          'subscribe',
          'shutdown',
        ])
        assert.deepStrictEqual(streamedChunks, [
          'Hello from ',
          'the Laborer Chat SDK canary.',
        ])
      })
    )
  )

  it.effect('maps SDK thread failures to schema-tagged operation errors', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread: ChatSdkThreadLike = {
          allMessages: asMessages([]),
          channelId: 'C1',
          channelMessages: failingMessages(),
          id: 'slack:C123:failure',
          isDM: false,
          post: () => Promise.reject(new Error('private SDK failure')),
          rootMessageId: 'failure',
          subscribe: () => Promise.reject(new Error('private SDK failure')),
          workspaceId: 'TFIRST',
        }
        const sdk: ChatSdkLike = {
          initialize: () => Promise.resolve(),
          onNewMention: () => undefined,
          onSubscribedMessage: () => undefined,
          shutdown: () => Promise.resolve(),
        }

        const failures = yield* Effect.provide(
          Effect.gen(function* () {
            const service = yield* ChatPlane
            const subscribe = yield* Effect.flip(service.subscribe(thread))
            const history = yield* Effect.flip(
              service.readActivationHistory(
                thread,
                message('failure', '@laborer failure', { isMention: true })
              )
            )
            const postNotice = yield* Effect.flip(
              service.postNotice(thread, 'safe notice')
            )
            const streamReply = yield* Effect.flip(
              service.streamReply(
                thread,
                (async function* () {
                  await Promise.resolve()
                  yield 'public'
                })()
              )
            )
            return { history, postNotice, streamReply, subscribe }
          }),
          makeChatPlaneLayer({
            handler: placeholderMentionHandler,
            makeSdk: () => sdk,
          })
        )

        assert.instanceOf(failures.subscribe, ChatPlaneOperationError)
        assert.equal(failures.subscribe.operation, 'thread.subscribe')
        assert.equal(failures.subscribe.reason, 'Chat SDK operation failed')
        assert.instanceOf(failures.history, ChatPlaneOperationError)
        assert.equal(
          failures.history.operation,
          'thread.read-activation-history'
        )
        assert.instanceOf(failures.postNotice, ChatPlaneOperationError)
        assert.equal(failures.postNotice.operation, 'thread.post-notice')
        assert.instanceOf(failures.streamReply, ChatPlaneOperationError)
        assert.equal(failures.streamReply.operation, 'thread.post')
        assert.equal(failures.streamReply.reason, 'Chat SDK operation failed')
      })
    )
  )

  it.effect('keeps workspace identity on background thread publication', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const publications: string[][] = []
        const sdk: ChatSdkLike = {
          initialize: () => Promise.resolve(),
          onNewMention: () => undefined,
          onSubscribedMessage: () => undefined,
          postToThread: (workspaceId, channelId, rootTs, output) => {
            publications.push([workspaceId, channelId, rootTs, output])
            return Promise.resolve()
          },
          shutdown: () => Promise.resolve(),
        }

        yield* Effect.provide(
          Effect.gen(function* () {
            const service = yield* ChatPlane
            yield* service.postToThread(
              'TSECOND',
              'CSHARED',
              '123.456',
              'execution complete'
            )
          }),
          makeChatPlaneLayer({
            handler: placeholderMentionHandler,
            makeSdk: () => sdk,
          })
        )

        assert.deepStrictEqual(publications, [
          ['TSECOND', 'CSHARED', '123.456', 'execution complete'],
        ])
      })
    )
  )

  it.effect(
    'resolves local tokens and partitions inbound work by workspace identity',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const firstToken = ['x', 'oxb', '-first-chat-fixture'].join('')
          const secondToken = ['x', 'oxb', '-second-chat-fixture'].join('')
          const environment = {
            [CHAT_CANARY_SLACK_APP_TOKEN_VARIABLE]: [
              'x',
              'app',
              '-chat-canary-fixture',
            ].join(''),
            [CHAT_CANARY_SLACK_WORKSPACES_VARIABLE]: JSON.stringify([
              {
                botTokenEnvironment:
                  'LABORER_CHAT_CANARY_SLACK_BOT_TOKEN_FIRST',
                teamId: 'TFIRST',
              },
              {
                botTokenEnvironment:
                  'LABORER_CHAT_CANARY_SLACK_BOT_TOKEN_SECOND',
                teamId: 'TSECOND',
              },
            ]),
            LABORER_CHAT_CANARY_SLACK_BOT_TOKEN_FIRST: firstToken,
            LABORER_CHAT_CANARY_SLACK_BOT_TOKEN_SECOND: secondToken,
          }
          const config = yield* loadChatCanarySlackConfig(environment)
          assert.strictEqual(config.mode, 'multi-workspace')
          if (config.mode !== 'multi-workspace') {
            return
          }

          const provider = makeLocalSlackInstallationProvider(
            config.installations.map((installation) => ({
              botToken: Redacted.value(installation.botToken),
              teamId: installation.teamId,
            }))
          )
          const [first, second, unknown, enterprise] = yield* Effect.promise(
            () =>
              Promise.all([
                provider.getInstallation('TFIRST', false),
                provider.getInstallation('TSECOND', false),
                provider.getInstallation('TUNKNOWN', false),
                provider.getInstallation('TFIRST', true),
              ])
          )
          assert.strictEqual(first?.botToken, firstToken)
          assert.strictEqual(second?.botToken, secondToken)
          assert.strictEqual(unknown, null)
          assert.strictEqual(enterprise, null)
          provider.recordBotUserId('TFIRST', 'UFIRSTBOT')
          const identifiedFirst = yield* Effect.promise(() =>
            provider.getInstallation('TFIRST', false)
          )
          assert.strictEqual(identifiedFirst?.botUserId, 'UFIRSTBOT')

          const partitions = new Map<string, string[]>()
          let mentionHandler: ChatSdkMentionHandler | undefined
          const sdk: ChatSdkLike = {
            initialize: () => Promise.resolve(),
            onNewMention: (handler) => {
              mentionHandler = handler
            },
            onSubscribedMessage: () => undefined,
            shutdown: () => Promise.resolve(),
          }
          const handler = (
            thread: ChatSdkThreadLike,
            message: { readonly text: string; readonly workspaceId: string }
          ) =>
            Effect.sync(() => {
              assert.strictEqual(thread.workspaceId, message.workspaceId)
              const messages = partitions.get(message.workspaceId) ?? []
              partitions.set(message.workspaceId, [...messages, message.text])
            })

          yield* Effect.provide(
            Effect.promise(async () => {
              assert.ok(mentionHandler)
              for (const workspaceId of ['TFIRST', 'TSECOND']) {
                const activation = message('123.456', `from ${workspaceId}`, {
                  isMention: true,
                  workspaceId,
                })
                await mentionHandler(
                  {
                    allMessages: asMessages([activation]),
                    channelId: 'CSHARED',
                    channelMessages: asMessages([activation]),
                    id: 'slack:CSHARED:123.456',
                    isDM: false,
                    post: () => Promise.resolve(),
                    rootMessageId: activation.id,
                    subscribe: () => Promise.resolve(),
                    workspaceId,
                  },
                  activation
                )
              }
            }),
            makeChatPlaneLayer({ handler, makeSdk: () => sdk })
          )

          assert.deepStrictEqual(partitions.get('TFIRST'), ['from TFIRST'])
          assert.deepStrictEqual(partitions.get('TSECOND'), ['from TSECOND'])
        })
      )
  )

  it('fails closed on malformed, conflicting, or unconfigured workspace identity', () => {
    const configuredWorkspaceIds = new Set(['TFIRST', 'TSECOND'])

    assert.equal(
      workspaceIdFromRawSlackMessage(
        { team_id: 'TFIRST' },
        configuredWorkspaceIds
      ),
      'TFIRST'
    )
    assert.equal(
      workspaceIdFromRawSlackMessage(
        { team: 'TSECOND' },
        configuredWorkspaceIds
      ),
      'TSECOND'
    )

    const rejectedPayloads: readonly unknown[] = [
      { text: 'private TOKEN=value' },
      { team: 'TFIRST', team_id: 'TSECOND' },
      { team_id: 'TUNKNOWN' },
      { team_id: 42, text: 'private TOKEN=value' },
    ]
    for (const payload of rejectedPayloads) {
      let failure: unknown
      try {
        workspaceIdFromRawSlackMessage(payload, configuredWorkspaceIds)
      } catch (error) {
        failure = error
      }
      assert.instanceOf(failure, Error)
      assert.equal(failure.message, 'Slack workspace identity unavailable')
      assert.notMatch(failure.message, PRIVATE_FAILURE_DETAIL)
    }
  })

  it.effect('shuts down an SDK whose initialization fails', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const lifecycle: string[] = []
        const sdk: ChatSdkLike = {
          initialize: () => {
            lifecycle.push('initialize')
            return Promise.reject(new Error('private initialization failure'))
          },
          onNewMention: () => {
            lifecycle.push('register')
          },
          onSubscribedMessage: () => {
            lifecycle.push('register-subscribed')
          },
          shutdown: () => {
            lifecycle.push('shutdown')
            return Promise.resolve()
          },
        }

        const failure = yield* Effect.flip(
          Effect.provide(
            Effect.asVoid(ChatPlane),
            makeChatPlaneLayer({
              handler: placeholderMentionHandler,
              makeSdk: () => sdk,
            })
          )
        )

        assert.instanceOf(failure, ChatPlaneStartupError)
        assert.equal(failure.operation, 'initialize')
        assert.equal(failure.reason, 'Chat SDK startup failed')
        assert.deepStrictEqual(lifecycle, [
          'register',
          'register-subscribed',
          'initialize',
          'shutdown',
        ])
      })
    )
  )

  it.effect(
    'activates only authored non-DM mentions and subscribes the thread',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let mentionHandler: ChatSdkMentionHandler | undefined
          let handled = 0
          let subscriptions = 0
          const activation = message('10.000', '@laborer start', {
            isBot: true,
            isMention: true,
          })
          const baseThread: ChatSdkThreadLike = {
            allMessages: asMessages([activation]),
            channelId: 'C1',
            channelMessages: asMessages([activation]),
            id: 'slack:C1:10.000',
            isDM: false,
            post: () => Promise.resolve(),
            rootMessageId: activation.id,
            subscribe: () => {
              subscriptions += 1
              return Promise.resolve()
            },
            workspaceId: 'TFIRST',
          }
          const sdk: ChatSdkLike = {
            initialize: () => Promise.resolve(),
            onNewMention: (handler) => {
              mentionHandler = handler
            },
            onSubscribedMessage: () => undefined,
            shutdown: () => Promise.resolve(),
          }
          const handler = makeConversationHandler(() => {
            handled += 1
            return Effect.succeed({})
          })

          yield* Effect.provide(
            Effect.promise(async () => {
              assert.ok(mentionHandler)
              await mentionHandler({ ...baseThread, isDM: true }, activation)
              await mentionHandler(
                baseThread,
                message('10.001', '@laborer self', {
                  isMe: true,
                  isMention: true,
                })
              )
              await mentionHandler(
                baseThread,
                message('10.002', '   ', { isMention: true })
              )
              await mentionHandler(
                baseThread,
                message('10.003', 'no explicit mention')
              )
              await mentionHandler(baseThread, activation)
            }),
            makeChatPlaneLayer({ handler, makeSdk: () => sdk })
          )

          assert.equal(handled, 1)
          assert.equal(subscriptions, 1)
        })
      )
  )

  it.effect(
    'classifies root history once, then accepts subscribed replies',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let mentionHandler: ChatSdkMentionHandler | undefined
          let subscribedHandler: ChatSdkMentionHandler | undefined
          const activation = message('20.000', '@laborer investigate', {
            isMention: true,
          })
          const contextOne = message('18.000', 'first context')
          const contextTwo = message('19.000', 'second context', {
            isBot: true,
          })
          const turns: ChatPlaneTurn[] = []
          const thread: ChatSdkThreadLike = {
            allMessages: asMessages([activation]),
            channelId: 'C1',
            channelMessages: asMessages([
              activation,
              contextTwo,
              message('18.500', 'private', { isMe: true }),
              contextOne,
            ]),
            id: 'slack:C1:20.000',
            isDM: false,
            post: () => Promise.resolve(),
            rootMessageId: activation.id,
            subscribe: () => Promise.resolve(),
            workspaceId: 'TFIRST',
          }
          const sdk: ChatSdkLike = {
            initialize: () => Promise.resolve(),
            onNewMention: (handler) => {
              mentionHandler = handler
            },
            onSubscribedMessage: (handler) => {
              subscribedHandler = handler
            },
            shutdown: () => Promise.resolve(),
          }
          const handler = makeConversationHandler((turn) => {
            turns.push(turn)
            return Effect.succeed({})
          })

          yield* Effect.provide(
            Effect.promise(async () => {
              assert.ok(mentionHandler)
              assert.ok(subscribedHandler)
              await mentionHandler(thread, activation)
              await subscribedHandler(thread, message('21.000', 'follow-up'))
            }),
            makeChatPlaneLayer({ handler, makeSdk: () => sdk })
          )

          assert.deepStrictEqual(
            turns.map((turn) =>
              turn.messages.map((item) => ({
                authorKind: item.authorKind,
                classification: item.classification,
                isActivation: item.isActivation,
                text: item.text,
              }))
            ),
            [
              [
                {
                  authorKind: 'human',
                  classification: 'context',
                  isActivation: false,
                  text: 'first context',
                },
                {
                  authorKind: 'externalBot',
                  classification: 'context',
                  isActivation: false,
                  text: 'second context',
                },
                {
                  authorKind: 'human',
                  classification: 'input',
                  isActivation: true,
                  text: '@laborer investigate',
                },
              ],
              [
                {
                  authorKind: 'human',
                  classification: 'input',
                  isActivation: false,
                  text: 'follow-up',
                },
              ],
            ]
          )
        })
      )
  )

  it.effect('includes the root and earlier replies for reply activation', () =>
    Effect.scoped(
      Effect.gen(function* () {
        let mentionHandler: ChatSdkMentionHandler | undefined
        const root = message('30.000', 'root')
        const earlier = message('31.000', 'earlier reply')
        const activation = message('32.000', '@laborer join', {
          isMention: true,
        })
        const turns: ChatPlaneTurn[] = []
        const thread: ChatSdkThreadLike = {
          allMessages: asMessages([
            root,
            earlier,
            activation,
            message('33.000', 'too late'),
          ]),
          channelId: 'C1',
          channelMessages: asMessages([]),
          id: 'slack:C1:30.000',
          isDM: false,
          post: () => Promise.resolve(),
          rootMessageId: root.id,
          subscribe: () => Promise.resolve(),
          workspaceId: 'TFIRST',
        }
        const sdk: ChatSdkLike = {
          initialize: () => Promise.resolve(),
          onNewMention: (handler) => {
            mentionHandler = handler
          },
          onSubscribedMessage: () => undefined,
          shutdown: () => Promise.resolve(),
        }

        yield* Effect.provide(
          Effect.promise(async () => {
            assert.ok(mentionHandler)
            await mentionHandler(thread, activation)
          }),
          makeChatPlaneLayer({
            handler: makeConversationHandler((turn) => {
              turns.push(turn)
              return Effect.succeed({})
            }),
            makeSdk: () => sdk,
          })
        )

        assert.deepStrictEqual(
          turns[0]?.messages.map(({ classification, text }) => ({
            classification,
            text,
          })),
          [
            { classification: 'context', text: 'root' },
            { classification: 'context', text: 'earlier reply' },
            { classification: 'input', text: '@laborer join' },
          ]
        )
      })
    )
  )

  it.effect('never opens a Slack stream for a silent reply', () =>
    Effect.scoped(
      Effect.gen(function* () {
        let mentionHandler: ChatSdkMentionHandler | undefined
        const posts: string[][] = []
        const activation = message('50.000', '@laborer hi', {
          isMention: true,
        })
        const thread: ChatSdkThreadLike = {
          allMessages: asMessages([activation]),
          channelId: 'C1',
          channelMessages: asMessages([]),
          id: 'slack:C1:50.000',
          isDM: false,
          post: async (reply) => {
            const chunks: string[] = []
            for await (const chunk of reply) {
              chunks.push(chunk)
            }
            posts.push(chunks)
          },
          rootMessageId: activation.id,
          subscribe: () => Promise.resolve(),
          workspaceId: 'TFIRST',
        }
        const sdk: ChatSdkLike = {
          initialize: () => Promise.resolve(),
          onNewMention: (handler) => {
            mentionHandler = handler
          },
          onSubscribedMessage: () => undefined,
          shutdown: () => Promise.resolve(),
        }
        let drained = false
        const silentReply = (async function* () {
          await Promise.resolve()
          yield ''
          drained = true
        })()
        const spokenReply = (async function* () {
          await Promise.resolve()
          yield ''
          yield 'hello'
          yield ' there'
        })()
        const replies: AsyncIterable<string>[] = [silentReply, spokenReply]

        yield* Effect.provide(
          Effect.promise(async () => {
            assert.ok(mentionHandler)
            await mentionHandler(thread, activation)
            await mentionHandler(thread, activation)
          }),
          makeChatPlaneLayer({
            handler: makeConversationHandler(() => {
              const publicReply = replies.shift()
              assert.ok(publicReply)
              return Effect.succeed({ publicReply })
            }),
            makeSdk: () => sdk,
          })
        )

        assert.ok(drained)
        assert.deepStrictEqual(posts, [['hello', ' there']])
      })
    )
  )

  it.effect('keeps edited history as context for reply activation', () =>
    Effect.scoped(
      Effect.gen(function* () {
        let mentionHandler: ChatSdkMentionHandler | undefined
        const root = message('40.000', 'edited root', { edited: true })
        const earlier = message('41.000', 'edited reply', { edited: true })
        const activation = message('42.000', '@laborer do the thing', {
          isMention: true,
        })
        const turns: ChatPlaneTurn[] = []
        const thread: ChatSdkThreadLike = {
          allMessages: asMessages([root, earlier, activation]),
          channelId: 'C1',
          channelMessages: asMessages([]),
          id: 'slack:C1:40.000',
          isDM: false,
          post: () => Promise.resolve(),
          rootMessageId: root.id,
          subscribe: () => Promise.resolve(),
          workspaceId: 'TFIRST',
        }
        const sdk: ChatSdkLike = {
          initialize: () => Promise.resolve(),
          onNewMention: (handler) => {
            mentionHandler = handler
          },
          onSubscribedMessage: () => undefined,
          shutdown: () => Promise.resolve(),
        }

        yield* Effect.provide(
          Effect.promise(async () => {
            assert.ok(mentionHandler)
            await mentionHandler(thread, activation)
          }),
          makeChatPlaneLayer({
            handler: makeConversationHandler((turn) => {
              turns.push(turn)
              return Effect.succeed({})
            }),
            makeSdk: () => sdk,
          })
        )

        assert.deepStrictEqual(
          turns[0]?.messages.map(({ classification, text }) => ({
            classification,
            text,
          })),
          [
            { classification: 'context', text: 'edited root' },
            { classification: 'context', text: 'edited reply' },
            { classification: 'input', text: '@laborer do the thing' },
          ]
        )
      })
    )
  )

  it.effect('surfaces a coalesced backlog in one follow-up turn', () =>
    Effect.scoped(
      Effect.gen(function* () {
        let subscribedHandler: ChatSdkMentionHandler | undefined
        const turns: ChatPlaneTurn[] = []
        const thread: ChatSdkThreadLike = {
          allMessages: asMessages([]),
          channelId: 'C1',
          channelMessages: asMessages([]),
          id: 'slack:C1:40.000',
          isDM: false,
          post: () => Promise.resolve(),
          rootMessageId: '40.000',
          subscribe: () => Promise.resolve(),
          workspaceId: 'TFIRST',
        }
        const sdk: ChatSdkLike = {
          initialize: () => Promise.resolve(),
          onNewMention: () => undefined,
          onSubscribedMessage: (handler) => {
            subscribedHandler = handler
          },
          shutdown: () => Promise.resolve(),
        }

        yield* Effect.provide(
          Effect.promise(async () => {
            assert.ok(subscribedHandler)
            await subscribedHandler(thread, message('43.000', 'latest'), {
              skipped: [
                message('41.000', 'first while busy'),
                message('42.000', 'second while busy'),
              ],
            })
          }),
          makeChatPlaneLayer({
            handler: makeConversationHandler((turn) => {
              turns.push(turn)
              return Effect.succeed({})
            }),
            makeSdk: () => sdk,
          })
        )

        assert.equal(turns.length, 1)
        assert.deepStrictEqual(
          turns[0]?.messages.map((item) => item.text),
          ['first while busy', 'second while busy', 'latest']
        )
      })
    )
  )

  it.effect(
    'posts one sanitized failure notice and accepts a later mention',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let mentionHandler: ChatSdkMentionHandler | undefined
          let subscribedHandler: ChatSdkMentionHandler | undefined
          const activation = message('50.000', '@laborer fail safely', {
            isMention: true,
          })
          const posts: string[] = []
          let shouldFail = true
          const thread: ChatSdkThreadLike = {
            allMessages: asMessages([activation]),
            channelId: 'C1',
            channelMessages: asMessages([activation]),
            id: 'slack:C1:50.000',
            isDM: false,
            post: async (reply) => {
              if (typeof reply === 'string') {
                posts.push(reply)
                return
              }
              let text = ''
              for await (const chunk of reply) {
                text += chunk
              }
              posts.push(text)
            },
            rootMessageId: activation.id,
            subscribe: () => Promise.resolve(),
            workspaceId: 'TFIRST',
          }
          const sdk: ChatSdkLike = {
            initialize: () => Promise.resolve(),
            onNewMention: (handler) => {
              mentionHandler = handler
            },
            onSubscribedMessage: (handler) => {
              subscribedHandler = handler
            },
            shutdown: () => Promise.resolve(),
          }
          const handler = makeConversationHandler(() => {
            if (shouldFail) {
              return Effect.die(new Error('secret /private/path TOKEN=value'))
            }
            return Effect.succeed({
              publicReply: (async function* () {
                await Promise.resolve()
                yield 'recovered'
              })(),
            })
          })

          yield* Effect.provide(
            Effect.promise(async () => {
              assert.ok(mentionHandler)
              assert.ok(subscribedHandler)
              await mentionHandler(thread, activation)
              shouldFail = false
              await subscribedHandler(
                thread,
                message('51.000', '@laborer retry', { isMention: true })
              )
            }),
            makeChatPlaneLayer({ handler, makeSdk: () => sdk })
          )

          assert.deepStrictEqual(posts, [
            TURN_FAILED_OPERATIONAL_NOTICE,
            'recovered',
          ])
          assert.notMatch(posts[0] ?? '', PRIVATE_FAILURE_DETAIL)
        })
      )
  )

  it.effect(
    'marks activation turns with working and completion reactions',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let mentionHandler: ChatSdkMentionHandler | undefined
          let subscribedHandler: ChatSdkMentionHandler | undefined
          const activation = message('60.000', '@laborer work', {
            isMention: true,
          })
          const reactions: string[][] = []
          const thread: ChatSdkThreadLike = {
            allMessages: asMessages([activation]),
            channelId: 'C1',
            channelMessages: asMessages([activation]),
            id: 'slack:C1:60.000',
            isDM: false,
            post: () => Promise.resolve(),
            rootMessageId: activation.id,
            subscribe: () => Promise.resolve(),
            workspaceId: 'TFIRST',
          }
          const sdk: ChatSdkLike = {
            addReaction: (workspaceId, channelId, rootTs, messageTs, emoji) => {
              reactions.push([
                'add',
                workspaceId,
                channelId,
                rootTs,
                messageTs,
                emoji,
              ])
              return Promise.resolve()
            },
            initialize: () => Promise.resolve(),
            onNewMention: (handler) => {
              mentionHandler = handler
            },
            onSubscribedMessage: (handler) => {
              subscribedHandler = handler
            },
            removeReaction: (
              workspaceId,
              channelId,
              rootTs,
              messageTs,
              emoji
            ) => {
              reactions.push([
                'remove',
                workspaceId,
                channelId,
                rootTs,
                messageTs,
                emoji,
              ])
              return Promise.resolve()
            },
            shutdown: () => Promise.resolve(),
          }
          const handler = makeConversationHandler(() => Effect.succeed({}))

          yield* Effect.provide(
            Effect.promise(async () => {
              assert.ok(mentionHandler)
              assert.ok(subscribedHandler)
              await mentionHandler(thread, activation)
              await subscribedHandler(thread, message('61.000', 'follow-up'))
            }),
            makeChatPlaneLayer({ handler, makeSdk: () => sdk })
          )

          assert.deepStrictEqual(reactions, [
            [
              'add',
              'TFIRST',
              'C1',
              '60.000',
              '60.000',
              'hourglass_flowing_sand',
            ],
            ['add', 'TFIRST', 'C1', '60.000', '60.000', 'white_check_mark'],
            [
              'remove',
              'TFIRST',
              'C1',
              '60.000',
              '60.000',
              'hourglass_flowing_sand',
            ],
            ['add', 'TFIRST', 'C1', '60.000', '60.000', 'white_check_mark'],
          ])
        })
      )
  )

  it.effect(
    'keeps turns alive when reactions fail and skips completion on failure',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let mentionHandler: ChatSdkMentionHandler | undefined
          const activation = message('70.000', '@laborer work', {
            isMention: true,
          })
          const posts: string[] = []
          const attemptedReactions: string[] = []
          let shouldFail = false
          const thread: ChatSdkThreadLike = {
            allMessages: asMessages([activation]),
            channelId: 'C1',
            channelMessages: asMessages([activation]),
            id: 'slack:C1:70.000',
            isDM: false,
            post: async (reply) => {
              if (typeof reply === 'string') {
                posts.push(reply)
                return
              }
              let text = ''
              for await (const chunk of reply) {
                text += chunk
              }
              posts.push(text)
            },
            rootMessageId: activation.id,
            subscribe: () => Promise.resolve(),
            workspaceId: 'TFIRST',
          }
          const sdk: ChatSdkLike = {
            addReaction: (_workspaceId, _channelId, _rootTs, _ts, emoji) => {
              attemptedReactions.push(`add:${emoji}`)
              return Promise.reject(new Error('private reaction failure'))
            },
            initialize: () => Promise.resolve(),
            onNewMention: (handler) => {
              mentionHandler = handler
            },
            onSubscribedMessage: () => undefined,
            removeReaction: (_workspaceId, _channelId, _rootTs, _ts, emoji) => {
              attemptedReactions.push(`remove:${emoji}`)
              return Promise.reject(new Error('private reaction failure'))
            },
            shutdown: () => Promise.resolve(),
          }
          const handler = makeConversationHandler(() => {
            if (shouldFail) {
              return Effect.die(new Error('work failed'))
            }
            return Effect.succeed({
              publicReply: (async function* () {
                await Promise.resolve()
                yield 'delivered despite reactions'
              })(),
            })
          })

          yield* Effect.provide(
            Effect.promise(async () => {
              assert.ok(mentionHandler)
              await mentionHandler(thread, activation)
              shouldFail = true
              await mentionHandler(
                thread,
                message('71.000', '@laborer again', { isMention: true })
              )
            }),
            makeChatPlaneLayer({ handler, makeSdk: () => sdk })
          )

          assert.deepStrictEqual(posts, [
            'delivered despite reactions',
            TURN_FAILED_OPERATIONAL_NOTICE,
          ])
          assert.deepStrictEqual(attemptedReactions, [
            'add:hourglass_flowing_sand',
            'add:white_check_mark',
            'remove:hourglass_flowing_sand',
            'add:hourglass_flowing_sand',
            'remove:hourglass_flowing_sand',
          ])
        })
      )
  )

  it.effect('completes turns on SDKs without reaction support', () =>
    Effect.scoped(
      Effect.gen(function* () {
        let mentionHandler: ChatSdkMentionHandler | undefined
        const activation = message('80.000', '@laborer work', {
          isMention: true,
        })
        const posts: string[] = []
        const thread: ChatSdkThreadLike = {
          allMessages: asMessages([activation]),
          channelId: 'C1',
          channelMessages: asMessages([activation]),
          id: 'slack:C1:80.000',
          isDM: false,
          post: async (reply) => {
            if (typeof reply === 'string') {
              posts.push(reply)
              return
            }
            let text = ''
            for await (const chunk of reply) {
              text += chunk
            }
            posts.push(text)
          },
          rootMessageId: activation.id,
          subscribe: () => Promise.resolve(),
          workspaceId: 'TFIRST',
        }
        const sdk: ChatSdkLike = {
          initialize: () => Promise.resolve(),
          onNewMention: (handler) => {
            mentionHandler = handler
          },
          onSubscribedMessage: () => undefined,
          shutdown: () => Promise.resolve(),
        }
        const handler = makeConversationHandler(() =>
          Effect.succeed({
            publicReply: (async function* () {
              await Promise.resolve()
              yield 'reaction-free reply'
            })(),
          })
        )

        yield* Effect.provide(
          Effect.promise(async () => {
            assert.ok(mentionHandler)
            await mentionHandler(thread, activation)
          }),
          makeChatPlaneLayer({ handler, makeSdk: () => sdk })
        )

        assert.deepStrictEqual(posts, ['reaction-free reply'])
      })
    )
  )

  it('keeps Chat SDK package imports inside the Effect service module', () => {
    const packageRoot = resolve(process.cwd())
    const files = [
      'src/chat-plane/placeholder-handler.ts',
      'src/chat-plane/conversation-handler.ts',
      'src/chat-plane/live.ts',
      'tests/chat-plane.test.ts',
    ]
    for (const file of files) {
      const source = readFileSync(resolve(packageRoot, file), 'utf8')
      assert.notMatch(source, CHAT_SDK_PACKAGE_IMPORT)
    }
  })
})
