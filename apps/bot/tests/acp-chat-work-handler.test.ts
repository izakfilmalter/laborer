import { assert, describe, it } from '@effect/vitest'
import { Cause, Effect } from 'effect'
import { makeAcpChatWorkHandler } from '../src/acp-runtime/chat-work-handler.ts'
import {
  ApplicationConversationMessageChunk,
  ApplicationPublicReply,
  type ApplicationShape,
  type ParticipantInputEvent,
} from '../src/application.ts'
import {
  ChatPlaneNormalizedMessage,
  ChatPlaneTurnUnavailable,
} from '../src/chat-plane/conversation-handler.ts'
import { HandlerFailure } from '../src/core/errors.ts'

const failingReply = (failure: HandlerFailure) =>
  Effect.gen(function* () {
    const handler = makeAcpChatWorkHandler({
      forWorkspace: () =>
        Effect.succeed({
          acceptEvent: (event) =>
            Effect.succeed({
              decision: { _tag: 'Accepted', eventId: event.eventId },
              scheduling: 'AlreadyDurable',
            }),
          application: { handle: () => Effect.fail(failure) },
        }),
    })
    const result = yield* handler({
      channelId: 'C312',
      messages: [
        ChatPlaneNormalizedMessage.make({
          authorKind: 'human',
          authorSlackId: 'U312',
          classification: 'input',
          id: 'input-312',
          isActivation: true,
          slackTs: '312.0',
          text: '<@U312BOT> work',
        }),
      ],
      rootTs: '312.0',
      threadId: 'slack:C312:312.0',
      workspaceId: 'T312',
    })
    return yield* Effect.promise(async () => {
      try {
        for await (const _ of result.publicReply ?? []) {
          // drain
        }
        return undefined
      } catch (error) {
        return error
      }
    })
  })

describe('promoted ACP Chat runtime', () => {
  it.effect(
    'maps a workspace-scoped Chat turn and streams only Application public output',
    () =>
      Effect.gen(function* () {
        const handled: ParticipantInputEvent[] = []
        const application: ApplicationShape = {
          handle: (event, publish) => {
            assert.strictEqual(event._tag, 'ParticipantInput')
            if (event._tag !== 'ParticipantInput') {
              return Effect.die('unexpected external event')
            }
            handled.push(event)
            return publish(
              ApplicationConversationMessageChunk.make({
                messageId: 'agent-message-1',
                sequence: 0,
                text: 'streamed ',
              })
            ).pipe(
              Effect.andThen(
                publish(
                  ApplicationPublicReply.make({
                    replyId: 'agent-message-2',
                    text: 'deliberately',
                  })
                )
              )
            )
          },
        }
        const handler = makeAcpChatWorkHandler({
          forWorkspace: (workspaceId) => {
            assert.strictEqual(workspaceId, 'T311')
            return Effect.succeed({
              acceptEvent: (event) =>
                Effect.succeed({
                  decision: { _tag: 'Accepted', eventId: event.eventId },
                  scheduling: 'AlreadyDurable',
                }),
              application,
            })
          },
        })
        const result = yield* handler({
          channelId: 'C311',
          messages: [
            ChatPlaneNormalizedMessage.make({
              authorKind: 'human',
              authorSlackId: 'U311',
              classification: 'context',
              id: 'context-311',
              isActivation: false,
              slackTs: '310.0',
              text: 'Earlier context',
            }),
            ChatPlaneNormalizedMessage.make({
              authorKind: 'human',
              authorSlackId: 'U311',
              classification: 'input',
              id: 'input-311',
              isActivation: true,
              slackTs: '311.0',
              text: '<@U311BOT> work',
            }),
          ],
          rootTs: '311.0',
          threadId: 'slack:C311:311.0',
          workspaceId: 'T311',
        })

        assert.isDefined(result.publicReply)
        const output = yield* Effect.promise(async () => {
          let captured = ''
          for await (const chunk of result.publicReply ?? []) {
            captured += chunk
          }
          return captured
        })

        assert.strictEqual(output, 'streamed deliberately')
        assert.strictEqual(handled.length, 1)
        const [event] = handled
        assert.strictEqual(event?.conversationId, 'workspace:T311:C311:311.0')
        assert.strictEqual(event?.turnId, 'chat:workspace:T311:C311:311.0')
        assert.deepStrictEqual(
          event?.context.map((message) => message.text),
          ['Earlier context']
        )
        assert.deepStrictEqual(
          event?.messages.map((message) => message.text),
          ['<@U311BOT> work']
        )
      })
  )

  it.effect(
    'surfaces a temporary ACP outage to Chat as a retryable failure',
    () =>
      Effect.gen(function* () {
        const rejected = yield* failingReply(
          HandlerFailure.make({
            category: 'protocol',
            noticeStyle: 'generic',
            retryAfterMillis: 90_000,
            safeDetail: 'ACP workspace is temporarily unavailable',
          })
        )
        assert.isTrue(Cause.isCause(rejected))
        const found = Cause.findError(rejected as Cause.Cause<unknown>)
        assert.strictEqual(found._tag, 'Success')
        assert.deepStrictEqual(
          found._tag === 'Success' ? found.success : undefined,
          ChatPlaneTurnUnavailable.make({ retryAfterMillis: 90_000 })
        )
      })
  )

  it.effect('keeps other ACP failures opaque to Chat', () =>
    Effect.gen(function* () {
      const failure = HandlerFailure.make({
        category: 'protocol',
        safeDetail: 'ACP workspace is unavailable',
      })
      const rejected = yield* failingReply(failure)
      const found = Cause.findError(rejected as Cause.Cause<unknown>)
      assert.strictEqual(found._tag === 'Success' && found.success, failure)
    })
  )
})
