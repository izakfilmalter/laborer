import { Effect } from "effect";
import {
  type AcceptApplicationEvent,
  type ApplicationPublicOutput,
  type ApplicationShape,
  ParticipantInputEvent,
} from "../application.ts";
import type {
  ChatPlaneTurn,
  ChatPlaneWorkHandler,
  ChatPlaneWorkResult,
} from "../chat-plane/conversation-handler.ts";
import {
  canonicalThreadId,
  NormalizedMessage,
  stableMessageId,
  TurnId,
} from "../core/domain.ts";
import { HandlerFailure } from "../core/errors.ts";

export interface AcpChatWorkspaceRuntime {
  /**
   * Accepts private Action/Execution events into their durable runtime. This
   * callback never publishes directly to Chat or Slack.
   */
  readonly acceptEvent: AcceptApplicationEvent;
  readonly application: ApplicationShape;
}

export interface AcpChatRuntimeDirectory {
  readonly forWorkspace: (
    workspaceId: string
  ) => Effect.Effect<AcpChatWorkspaceRuntime, HandlerFailure>;
}

interface OutputQueue {
  readonly end: () => void;
  readonly fail: (cause: unknown) => void;
  readonly iterable: AsyncIterable<string>;
  readonly offer: (output: ApplicationPublicOutput) => void;
}

const makeOutputQueue = (): OutputQueue => {
  const values: string[] = [];
  const waiters: Array<{
    readonly reject: (cause: unknown) => void;
    readonly resolve: (result: IteratorResult<string>) => void;
  }> = [];
  let ended = false;
  let failure: unknown;

  const settle = (): void => {
    while (waiters.length > 0 && values.length > 0) {
      waiters.shift()?.resolve({ done: false, value: values.shift() ?? "" });
    }
    if (failure !== undefined) {
      while (waiters.length > 0) {
        waiters.shift()?.reject(failure);
      }
    } else if (ended) {
      while (waiters.length > 0) {
        waiters.shift()?.resolve({ done: true, value: undefined });
      }
    }
  };

  return {
    end: () => {
      ended = true;
      settle();
    },
    fail: (cause) => {
      failure = cause;
      settle();
    },
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            if (values.length > 0) {
              return Promise.resolve({
                done: false as const,
                value: values.shift() ?? "",
              });
            }
            if (failure !== undefined) {
              return Promise.reject(failure);
            }
            if (ended) {
              return Promise.resolve({
                done: true as const,
                value: undefined,
              });
            }
            return new Promise<IteratorResult<string>>((resolve, reject) => {
              waiters.push({ reject, resolve });
            });
          },
        };
      },
    },
    offer: (output) => {
      // ACP has already enforced NO_REPLY, current-prompt authority, message
      // count and byte bounds before output reaches this public boundary.
      values.push(output.text);
      settle();
    },
  };
};

const normalizedMessage = (
  turn: ChatPlaneTurn,
  message: ChatPlaneTurn["messages"][number]
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
  });

/**
 * Adapts the production ACP Application to Chat SDK turns without introducing
 * another scheduler or durable Slack publication state. Iterating the returned
 * stream runs exactly one at-most-once participant turn and emits only output
 * admitted by the ACP public/private gate.
 */
export const makeAcpChatWorkHandler = (
  directory: AcpChatRuntimeDirectory
): ChatPlaneWorkHandler =>
  Effect.fn("AcpRuntime.chatWorkHandler")(function* (turn) {
    const runtime = yield* directory.forWorkspace(turn.workspaceId);
    const queue = makeOutputQueue();
    const messages = turn.messages.map((message) =>
      normalizedMessage(turn, message)
    );
    const context = messages.filter(
      (message) => message.classification === "context"
    );
    const input = messages.filter(
      (message) => message.classification === "input"
    );
    const latest = input.at(-1);
    if (latest === undefined) {
      return yield* HandlerFailure.make({
        category: "protocol",
        safeDetail: "Chat turn has no participant input",
      });
    }
    const conversationId = canonicalThreadId(
      turn.channelId,
      turn.rootTs,
      turn.workspaceId
    );
    const event = ParticipantInputEvent.make({
      attemptNumber: 1,
      channelId: turn.channelId,
      context,
      conversationId,
      initializationStatus: "not_applicable",
      messages: input,
      rootTs: turn.rootTs,
      source: "slack",
      turnId: TurnId.make(`chat:${latest.id}`),
      workingDirectory: null,
    });

    const publicReply = (async function* () {
      const run = Effect.runPromiseExit(
        runtime.application.handle(
          event,
          (output) => Effect.sync(() => queue.offer(output)),
          runtime.acceptEvent
        )
      ).then((exit) => {
        if (exit._tag === "Success") {
          queue.end();
        } else {
          queue.fail(exit.cause);
        }
      });
      try {
        yield* queue.iterable;
        await run;
      } finally {
        // Ensure a consumer cancellation cannot leave the Application promise
        // unobserved. Process cleanup remains owned by the scoped ACP runtime.
        await run;
      }
    })();

    return { publicReply } satisfies ChatPlaneWorkResult;
  });
