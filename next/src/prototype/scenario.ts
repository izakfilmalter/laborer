/** THROWAWAY ISSUE #204 PROTOTYPE fixed one-command demonstration. */
import type { ChatPostMessageResponse } from "@slack/web-api";
import { Effect, Fiber } from "effect";
import {
  EventId,
  NormalizedInboundEvent,
  type PrototypeState,
} from "./domain.ts";
import type { EmulatedSlackFixture } from "./emulated-slack.ts";
import { ScenarioError } from "./errors.ts";
import type { PrototypeHarness } from "./runtime.ts";

export const LABORER_SLACK_ID = "U204LABORER";

export const postHumanMessage = (
  fixture: EmulatedSlackFixture,
  text: string,
  options?: { readonly channelId?: string; readonly threadTs?: string }
): Effect.Effect<ChatPostMessageResponse, ScenarioError> =>
  Effect.tryPromise({
    try: () =>
      fixture.humanClient.chat.postMessage({
        channel: options?.channelId ?? fixture.channelId,
        text,
        ...(options?.threadTs === undefined
          ? {}
          : { thread_ts: options.threadTs }),
      }),
    catch: () => ScenarioError.make({ operation: "seed-message" }),
  });

export const timestampOf = (response: ChatPostMessageResponse): string => {
  if (response.ts === undefined) {
    throw new Error("Emulated Slack returned no timestamp for fixture message");
  }
  return response.ts;
};

export const normalizedEvent = (options: {
  readonly authorKind?: "human" | "externalBot" | "laborer";
  readonly authorSlackId: string;
  readonly channelId: string;
  readonly channelKind?: "public" | "private" | "direct";
  readonly eventId: string;
  readonly messageTs: string;
  readonly recordKind?:
    | "message"
    | "message_changed"
    | "message_deleted"
    | "reaction"
    | "system";
  readonly text?: string | null;
  readonly threadTs?: string;
}): NormalizedInboundEvent =>
  NormalizedInboundEvent.make({
    eventId: EventId.make(options.eventId),
    channelId: options.channelId,
    channelKind: options.channelKind ?? "public",
    messageTs: options.messageTs,
    threadTs: options.threadTs ?? null,
    authorKind: options.authorKind ?? "human",
    authorSlackId: options.authorSlackId,
    recordKind: options.recordKind ?? "message",
    text: options.text ?? null,
  });

export interface ScenarioResult {
  readonly activationRootTs: string;
  readonly state: PrototypeState;
  readonly threadMessages: readonly Record<string, unknown>[];
}

export const runTracerScenario = (options: {
  readonly fixture: EmulatedSlackFixture;
  readonly harness: PrototypeHarness;
  readonly onCheckpoint?: (
    label: string,
    state: PrototypeState
  ) => Effect.Effect<void>;
}): Effect.Effect<
  ScenarioResult,
  | ScenarioError
  | import("./errors.ts").RunnerError
  | import("./errors.ts").BoundaryDecodeError
> =>
  Effect.gen(function* () {
    const { fixture, harness } = options;
    yield* postHumanMessage(
      fixture,
      "Context: the essay should be about local tools."
    );
    const unrelated = yield* postHumanMessage(
      fixture,
      "Ordinary channel conversation"
    );
    yield* harness.runner.inject(
      normalizedEvent({
        authorSlackId: fixture.humanUserId,
        channelId: fixture.channelId,
        eventId: "event:unrelated",
        messageTs: timestampOf(unrelated),
        text: "Ordinary channel conversation",
      })
    );

    const activationText = `<@${LABORER_SLACK_ID}> write a tiny essay`;
    const activation = yield* postHumanMessage(fixture, activationText);
    const activationRootTs = timestampOf(activation);
    const activationEvent = normalizedEvent({
      authorSlackId: fixture.humanUserId,
      channelId: fixture.channelId,
      eventId: "event:activation",
      messageTs: activationRootTs,
      text: activationText,
    });
    yield* harness.runner.inject(activationEvent);
    if (options.onCheckpoint !== undefined) {
      yield* options.onCheckpoint(
        "thread activated",
        yield* harness.store.snapshot
      );
    }

    const firstText = "Make it shorter [fixture:delay=50]";
    const secondText = "Add a title";
    const first = yield* postHumanMessage(fixture, firstText, {
      threadTs: activationRootTs,
    });
    const second = yield* postHumanMessage(fixture, secondText, {
      threadTs: activationRootTs,
    });
    const firstFiber = yield* Effect.forkChild(
      harness.runner.inject(
        normalizedEvent({
          authorSlackId: fixture.humanUserId,
          channelId: fixture.channelId,
          eventId: "event:follow-up-1",
          messageTs: timestampOf(first),
          text: firstText,
          threadTs: activationRootTs,
        })
      )
    );
    yield* Effect.sleep("5 millis");
    yield* harness.runner.inject(
      normalizedEvent({
        authorSlackId: fixture.humanUserId,
        channelId: fixture.channelId,
        eventId: "event:follow-up-2",
        messageTs: timestampOf(second),
        text: secondText,
        threadTs: activationRootTs,
      })
    );
    yield* Fiber.join(firstFiber);
    yield* harness.runner.inject(activationEvent);

    const response = yield* Effect.tryPromise({
      try: () =>
        fixture.humanClient.conversations.replies({
          channel: fixture.channelId,
          ts: activationRootTs,
          limit: 100,
        }),
      catch: () => ScenarioError.make({ operation: "inspect-thread" }),
    });
    const state = yield* harness.store.snapshot;
    if (options.onCheckpoint !== undefined) {
      yield* options.onCheckpoint("FIFO turns settled", state);
    }
    return {
      activationRootTs,
      state,
      threadMessages: (response.messages ?? []) as Record<string, unknown>[],
    };
  });
