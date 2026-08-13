import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { ParticipantInputEvent } from '../src/application.ts'
import {
  NormalizedMessage,
  stableMessageId,
  ThreadId,
  TurnId,
} from '../src/core/domain.ts'
import {
  type ConversationAgentRequest,
  makeReferenceCodingApplication,
} from '../src/reference-coding-application.ts'

const message = (options: {
  readonly authorKind: 'externalBot' | 'human'
  readonly authorSlackId: string
  readonly classification?: 'context' | 'input'
  readonly index: number
}): NormalizedMessage =>
  NormalizedMessage.make({
    authorKind: options.authorKind,
    authorSlackId: options.authorSlackId,
    classification: options.classification ?? 'input',
    id: stableMessageId('C245AUTHORITY', `245.${options.index}`),
    isActivation: options.index === 1,
    slackTs: `245.${options.index}`,
    text: `message ${options.index}`,
  })

describe('issue #245 turn authority', () => {
  it.effect(
    'captures the latest causal human once and excludes history and bot-only turns',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const requests: ConversationAgentRequest[] = []
          const application = yield* makeReferenceCodingApplication({
            conversationAgent: {
              handle: (request) =>
                Effect.sync(() => {
                  requests.push(request)
                  return []
                }),
            },
            implementationAgent: {
              start: () =>
                Effect.die(new Error('implementation is outside this test')),
            },
            worktreeManager: {
              create: () =>
                Effect.die(new Error('actions are outside this test')),
            },
          })
          const handle = (
            conversationId: string,
            turnId: string,
            messages: readonly NormalizedMessage[]
          ) =>
            application.handle(
              ParticipantInputEvent.make({
                attemptNumber: 1,
                channelId: 'C245AUTHORITY',
                context: [
                  message({
                    authorKind: 'human',
                    authorSlackId: 'U245HISTORY',
                    classification: 'context',
                    index: 0,
                  }),
                ],
                conversationId: ThreadId.make(conversationId),
                initializationStatus: 'not_applicable',
                messages,
                rootTs: '245.1',
                source: 'slack',
                turnId: TurnId.make(turnId),
                workingDirectory: null,
              }),
              () => Effect.void,
              (event) =>
                Effect.succeed({
                  decision: { _tag: 'Accepted', eventId: event.eventId },
                  scheduling: 'Scheduled',
                })
            )
          yield* handle('conversation:human', 'turn:human', [
            message({
              authorKind: 'human',
              authorSlackId: 'U245FIRST',
              index: 1,
            }),
            message({
              authorKind: 'externalBot',
              authorSlackId: 'B245EXTERNAL',
              index: 2,
            }),
            message({
              authorKind: 'human',
              authorSlackId: 'U245LATEST',
              index: 3,
            }),
          ])
          yield* handle('conversation:bot', 'turn:bot', [
            message({
              authorKind: 'externalBot',
              authorSlackId: 'B245ONLY',
              index: 4,
            }),
          ])
          assert.deepStrictEqual(requests[0]?.turnAuthority, {
            authorizedSlackUserId: 'U245LATEST',
            channelId: 'C245AUTHORITY',
            rootTs: '245.1',
          })
          assert.deepStrictEqual(requests[1]?.turnAuthority, {
            authorizedSlackUserId: null,
            channelId: 'C245AUTHORITY',
            rootTs: '245.1',
          })
        })
      )
  )
})
