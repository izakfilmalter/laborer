import { Effect } from 'effect'
import {
  type AcceptApplicationEvent,
  type ApplicationPublicOutput,
  type ApplicationShape,
  ParticipantInputEvent,
} from '../application.ts'
import { makeAsyncOutputQueue } from '../async-output-queue.ts'
import type {
  ChatPlaneTurn,
  ChatPlaneWorkHandler,
  ChatPlaneWorkResult,
} from '../chat-plane/conversation-handler.ts'
import {
  canonicalThreadId,
  NormalizedMessage,
  stableMessageId,
  TurnId,
} from '../core/domain.ts'
import { HandlerFailure } from '../core/errors.ts'

export interface AcpChatWorkspaceRuntime {
  /**
   * Accepts private Action/Execution events into their durable runtime. This
   * callback never publishes directly to Chat or Slack.
   */
  readonly acceptEvent: AcceptApplicationEvent
  readonly application: ApplicationShape
}

export interface AcpChatRuntimeDirectory {
  readonly forWorkspace: (
    workspaceId: string
  ) => Effect.Effect<AcpChatWorkspaceRuntime, HandlerFailure>
}

const normalizedMessage = (
  turn: ChatPlaneTurn,
  message: ChatPlaneTurn['messages'][number]
): NormalizedMessage =>
  NormalizedMessage.make({
    authorKind: message.authorKind,
    authorSlackId: message.authorSlackId,
    classification: message.classification,
    id: stableMessageId(turn.channelId, message.slackTs, turn.workspaceId),
    images: message.images ?? [],
    isActivation: message.isActivation,
    slackTs: message.slackTs,
    text: message.text,
  })

/**
 * Adapts the production ACP Application to Chat SDK turns without introducing
 * another scheduler or durable Slack publication state. Iterating the returned
 * stream runs exactly one at-most-once participant turn and emits only output
 * admitted by the ACP public/private gate.
 */
export const makeAcpChatWorkHandler = (
  directory: AcpChatRuntimeDirectory
): ChatPlaneWorkHandler =>
  Effect.fn('AcpRuntime.chatWorkHandler')(function* (turn) {
    const runtime = yield* directory.forWorkspace(turn.workspaceId)
    const queue = makeAsyncOutputQueue()
    const messages = turn.messages.map((message) =>
      normalizedMessage(turn, message)
    )
    const context = messages.filter(
      (message) => message.classification === 'context'
    )
    const input = messages.filter(
      (message) => message.classification === 'input'
    )
    const latest = input.at(-1)
    if (latest === undefined) {
      return yield* HandlerFailure.make({
        category: 'protocol',
        safeDetail: 'Chat turn has no participant input',
      })
    }
    const conversationId = canonicalThreadId(
      turn.channelId,
      turn.rootTs,
      turn.workspaceId
    )
    const event = ParticipantInputEvent.make({
      attemptNumber: 1,
      channelId: turn.channelId,
      context,
      conversationId,
      initializationStatus: 'not_applicable',
      messages: input,
      rootTs: turn.rootTs,
      source: 'slack',
      turnId: TurnId.make(`chat:${latest.id}`),
      workingDirectory: null,
    })

    const publicReply = (async function* () {
      const run = Effect.runPromiseExit(
        runtime.application.handle(
          event,
          (output: ApplicationPublicOutput) =>
            Effect.sync(() => {
              // ACP has already enforced NO_REPLY, current-prompt authority,
              // message count and byte bounds at this public boundary.
              queue.offer(output.text)
            }),
          runtime.acceptEvent
        )
      ).then((exit) => {
        if (exit._tag === 'Success') {
          queue.end()
        } else {
          queue.fail(exit.cause)
        }
      })
      try {
        yield* queue.iterable
        await run
      } finally {
        // Ensure a consumer cancellation cannot leave the Application promise
        // unobserved. Process cleanup remains owned by the scoped ACP runtime.
        await run
      }
    })()

    return { publicReply } satisfies ChatPlaneWorkResult
  })
