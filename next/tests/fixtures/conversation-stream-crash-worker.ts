import { WebClient } from "@slack/web-api";
import { Effect, Layer } from "effect";
import { ApplicationConversationMessageChunk } from "../../src/application.ts";
import {
  type ConversationStreamDeliveryTestHooks,
  immediateConversationStreamDeliveryPolicy,
  makeConversationStreamDelivery,
} from "../../src/prototype/conversation-stream-delivery.ts";
import { canonicalThreadId } from "../../src/prototype/domain.ts";
import { makeSlackGateway } from "../../src/prototype/emulated-slack.ts";
import type { SlackGatewayShape } from "../../src/prototype/runtime.ts";
import { normalizedEvent } from "../../src/prototype/scenario.ts";
import {
  makeFileStoreLayer,
  PrototypeStore,
} from "../../src/prototype/store.ts";
import { makeSlackNativeStreamCapability } from "../../src/slack/native-stream.ts";

const LABORER_SLACK_ID = "USTREAMLABORER";
const ROOT_TS = "250.100";
const THREAD_ID = canonicalThreadId("CSTREAM", ROOT_TS, "TSTREAM");
const OWNER = {
  ownerId: "turn:workspace:TSTREAM:CSTREAM:250.100",
  ownerKind: "participant-turn" as const,
  threadId: THREAD_ID,
};

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
};

const statePath = requiredEnvironment("STREAM_STATE_PATH");
const root = requiredEnvironment("STREAM_ROOT");
const slackApiUrl = requiredEnvironment("STREAM_SLACK_API_URL");
const action = requiredEnvironment("STREAM_ACTION");
const crashAt = process.env.STREAM_CRASH_AT;
const crashKind = process.env.STREAM_CRASH_KIND;
const crashOperationIndex = Number(
  process.env.STREAM_CRASH_OPERATION_INDEX ?? "0"
);
const transport = process.env.STREAM_TRANSPORT ?? "native";
const hookOccurrences = new Map<string, number>();

const signal = (value: string): Effect.Effect<void> =>
  Effect.sync(() => {
    process.stdout.write(`${value}\n`);
  });

const crashHook =
  (
    point: string
  ): NonNullable<
    ConversationStreamDeliveryTestHooks["afterOperationPrepared"]
  > =>
  (operation) =>
    Effect.suspend(() => {
      const key = `${point}:${operation.kind}`;
      const occurrence = hookOccurrences.get(key) ?? 0;
      hookOccurrences.set(key, occurrence + 1);
      return crashAt === point &&
        crashKind === operation.kind &&
        crashOperationIndex === occurrence
        ? signal(`CRASH:${point}:${operation.kind}:${occurrence}`).pipe(
            Effect.andThen(Effect.never)
          )
        : Effect.void;
    });

const testHooks: ConversationStreamDeliveryTestHooks = {
  afterOperationInFlight: crashHook("in-flight"),
  afterOperationPrepared: crashHook("prepared"),
  afterOperationSettled: crashHook("after-settled"),
  afterRequestBeforeOutcomePersisted: crashHook("after-request"),
};

const program = Effect.scoped(
  Effect.gen(function* () {
    const context = yield* Layer.build(
      makeFileStoreLayer(LABORER_SLACK_ID, statePath, root)
    );
    const store = yield* PrototypeStore.pipe(Effect.provide(context));
    if ((yield* store.threadIds).length === 0) {
      yield* store.accept(
        normalizedEvent({
          authorSlackId: "USTREAMHUMAN",
          channelId: "CSTREAM",
          eventId: "event:stream-crash",
          messageTs: ROOT_TS,
          text: `<@${LABORER_SLACK_ID}> stream durably`,
          workspaceId: "TSTREAM",
        })
      );
      yield* store.completeContext(THREAD_ID, [], false);
      yield* store.claimNextTurn(THREAD_ID);
    }

    const client = new WebClient("stream-test-token", {
      rejectRateLimitedCalls: true,
      retryConfig: { retries: 0 },
      slackApiUrl,
      timeout: 100,
    });
    const fallbackGateway = makeSlackGateway({
      botClient: client,
      pageSize: 100,
      workspaceId: "TSTREAM",
    });
    const slack: SlackGatewayShape =
      transport === "fallback"
        ? fallbackGateway
        : {
            ...fallbackGateway,
            nativeStreaming: makeSlackNativeStreamCapability({
              client: client.chat,
              recipientTeamId: "TSTREAM",
            }),
          };
    const delivery = yield* makeConversationStreamDelivery({
      policy: {
        ...immediateConversationStreamDeliveryPolicy,
        coalesceCodePoints: 1,
        maxCoalesceMillis: 1,
      },
      slack,
      store,
      testHooks,
    });
    const publisher = delivery.publisherFor(OWNER);

    switch (action) {
      case "append":
        yield* publisher.publish(
          ApplicationConversationMessageChunk.make({
            messageId: "assistant-message",
            sequence: 0,
            text: "Hello",
          })
        );
        yield* publisher.publish(
          ApplicationConversationMessageChunk.make({
            messageId: "assistant-message",
            sequence: 1,
            text: " world",
          })
        );
        break;
      case "continue":
        yield* delivery.recover;
        yield* publisher.publish(
          ApplicationConversationMessageChunk.make({
            messageId: "assistant-message",
            sequence: 0,
            text: "Hello",
          })
        );
        yield* publisher.publish(
          ApplicationConversationMessageChunk.make({
            messageId: "assistant-message",
            sequence: 1,
            text: " world",
          })
        );
        yield* publisher.finalize("completed");
        break;
      case "multi-append":
        for (const [sequence, text] of ["A", "B", "C", "D"].entries()) {
          yield* publisher.publish(
            ApplicationConversationMessageChunk.make({
              messageId: "assistant-message",
              sequence,
              text,
            })
          );
        }
        yield* publisher.finalize("completed");
        break;
      case "empty-before-finalize":
        yield* publisher.publish(
          ApplicationConversationMessageChunk.make({
            messageId: "assistant-message",
            sequence: 0,
            text: "",
          })
        );
        yield* signal("CRASH:before-local-completion");
        return yield* Effect.never;
      case "empty-finalize":
        yield* publisher.publish(
          ApplicationConversationMessageChunk.make({
            messageId: "assistant-message",
            sequence: 0,
            text: "",
          })
        );
        yield* publisher.finalize("completed");
        yield* signal("CRASH:after-local-completion");
        return yield* Effect.never;
      case "finalize":
        yield* delivery.recover;
        yield* publisher.finalize("completed");
        break;
      case "publish":
        yield* publisher.publish(
          ApplicationConversationMessageChunk.make({
            messageId: "assistant-message",
            sequence: 0,
            text: "Hello",
          })
        );
        break;
      case "publish-result":
        yield* Effect.result(
          publisher.publish(
            ApplicationConversationMessageChunk.make({
              messageId: "assistant-message",
              sequence: 0,
              text: "Hello",
            })
          )
        );
        break;
      case "publish-before-finalize":
        yield* publisher.publish(
          ApplicationConversationMessageChunk.make({
            messageId: "assistant-message",
            sequence: 0,
            text: "Hello",
          })
        );
        yield* signal("CRASH:before-finalize");
        return yield* Effect.never;
      case "recover":
        yield* delivery.recover;
        yield* delivery.signalOwnerRecovery(OWNER, "unavailable");
        break;
      case "stop":
        yield* publisher.publish(
          ApplicationConversationMessageChunk.make({
            messageId: "assistant-message",
            sequence: 0,
            text: "Hello",
          })
        );
        yield* publisher.finalize("completed");
        break;
      default:
        throw new Error(`Unsupported stream action: ${action}`);
    }

    if (
      action === "continue" ||
      action === "finalize" ||
      action === "recover"
    ) {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if ((yield* store.snapshot).conversationStreams.length === 0) {
          break;
        }
        yield* Effect.sleep("5 millis");
      }
    }

    yield* signal(`RESULT:${JSON.stringify(yield* store.snapshot)}`);
  })
);

await Effect.runPromise(program);
