import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { ApplicationConversationMessageChunk } from "../src/application.ts";
import { makeConversationStreamDelivery } from "../src/prototype/conversation-stream-delivery.ts";
import {
  ConversationStreamOperation,
  ConversationStreamState,
  ConversationStreamTombstone,
  canonicalThreadId,
  HandlerAttempt,
  NormalizedMessage,
  PrototypeState,
  stableMessageId,
  TurnId,
  TurnState,
  WorkThreadState,
} from "../src/prototype/domain.ts";
import type { SlackGatewayShape } from "../src/prototype/runtime.ts";
import {
  LABORER_SLACK_ID,
  normalizedEvent,
} from "../src/prototype/scenario.ts";
import {
  makeControlledStoreLayer,
  makeFileStoreLayer,
  makeInMemoryStoreLayer,
  PrototypeStore,
  stableConversationStreamId,
} from "../src/prototype/store.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

const immediatePerDeltaPolicy = {
  coalesceCodePoints: 1,
  maxCoalesceMillis: 0,
  spacingMillis: {
    "fallback-post": 0,
    "fallback-update": 0,
    "native-append": 0,
    "native-start": 0,
    "native-stop": 0,
  },
} as const;

describe("Conversation stream durable capacity", () => {
  it.effect(
    "compacts more than 64 acknowledged flushes and restores the implicit sequence cursor",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-stream-operation-compaction-"
          );
          const statePath = join(root, "runner.json");
          const rootTs = "250.200";
          const threadId = canonicalThreadId("CSTREAM", rootTs, "TSTREAM");
          const firstContext = yield* Layer.build(
            makeInMemoryStoreLayer(LABORER_SLACK_ID)
          );
          const firstStore = yield* PrototypeStore.pipe(
            Effect.provide(firstContext)
          );
          yield* firstStore.accept(
            normalizedEvent({
              authorSlackId: "USTREAMHUMAN",
              channelId: "CSTREAM",
              eventId: "event:stream-operation-compaction",
              messageTs: rootTs,
              text: `<@${LABORER_SLACK_ID}> stream many deltas`,
              workspaceId: "TSTREAM",
            })
          );
          yield* firstStore.completeContext(threadId, [], false);
          const turn = yield* firstStore.claimNextTurn(threadId);
          assert.ok(turn !== null);
          let starts = 0;
          let appends = 0;
          let stops = 0;
          const slack: SlackGatewayShape = {
            nativeStreaming: {
              append: () =>
                Effect.sync(() => {
                  appends += 1;
                }),
              start: () =>
                Effect.sync(() => {
                  starts += 1;
                  return { ts: "long-stream" };
                }),
              stop: () =>
                Effect.sync(() => {
                  stops += 1;
                }),
            },
            postThreadMessage: () => Effect.succeed({ ts: "unused" }),
            readActivationContext: () => Effect.succeed([]),
          };
          const owner = {
            ownerId: turn.id,
            ownerKind: "participant-turn" as const,
            threadId,
          };
          const firstDelivery = yield* makeConversationStreamDelivery({
            policy: immediatePerDeltaPolicy,
            slack,
            store: firstStore,
          });
          const firstPublisher = firstDelivery.publisherFor(owner);
          for (let index = 0; index < 70; index += 1) {
            yield* firstPublisher.publish(
              ApplicationConversationMessageChunk.make({
                messageId: "long-message",
                text: "x",
              })
            );
          }

          const beforeRestart = yield* firstStore.snapshot;
          yield* Effect.promise(() =>
            writeFile(statePath, JSON.stringify(beforeRestart), {
              encoding: "utf8",
              mode: 0o600,
            })
          );

          const restartedContext = yield* Layer.build(
            makeFileStoreLayer(LABORER_SLACK_ID, statePath, root)
          );
          const restartedStore = yield* PrototypeStore.pipe(
            Effect.provide(restartedContext)
          );
          const restartedDelivery = yield* makeConversationStreamDelivery({
            policy: immediatePerDeltaPolicy,
            slack,
            store: restartedStore,
          });
          yield* restartedDelivery.recover;
          yield* restartedDelivery.signalOwnerRecovery(owner, "unavailable");
          for (let attempt = 0; attempt < 100; attempt += 1) {
            const current = yield* restartedStore.snapshot;
            if (current.conversationStreamTombstones.length > 0) {
              break;
            }
            yield* Effect.promise(
              () =>
                new Promise<void>((resolveWait) => setTimeout(resolveWait, 1))
            );
          }

          const state = yield* restartedStore.snapshot;
          assert.strictEqual(stops, 1);
          const stream = state.conversationStreamTombstones[0];
          assert.ok(stream !== undefined);
          assert.strictEqual(stream.acceptedSequence, 69);
          assert.strictEqual(stream.operations.length, 1);
          assert.strictEqual(stream.operations[0]?.kind, "native-stop");
          assert.strictEqual(stream.lifecycle, "stopped");
          assert.strictEqual("cumulativeText" in stream, false);
          assert.strictEqual(
            stream.operations.some((operation) => "payloadText" in operation),
            false
          );
          assert.strictEqual(
            JSON.stringify(state).includes("xxxxxxxxxx"),
            false
          );
          assert.deepStrictEqual(
            { appends, starts, stops },
            { appends: 69, starts: 1, stops: 1 }
          );

          const duplicate = yield* restartedStore.acceptConversationStreamChunk(
            {
              messageId: "long-message",
              nowMillis: 1,
              ownerId: owner.ownerId,
              ownerKind: owner.ownerKind,
              sequence: 0,
              text: "x",
              threadId,
            }
          );
          assert.strictEqual(duplicate._tag, "Duplicate");
          const conflict = yield* Effect.result(
            restartedStore.acceptConversationStreamChunk({
              messageId: "long-message",
              nowMillis: 1,
              ownerId: owner.ownerId,
              ownerKind: owner.ownerKind,
              sequence: 0,
              text: "y",
              threadId,
            })
          );
          const gap = yield* Effect.result(
            restartedStore.acceptConversationStreamChunk({
              messageId: "long-message",
              nowMillis: 1,
              ownerId: owner.ownerId,
              ownerKind: owner.ownerKind,
              sequence: 72,
              text: "x",
              threadId,
            })
          );
          assert.strictEqual(conflict._tag, "Failure");
          assert.strictEqual(gap._tag, "Failure");
          assert.ok(
            new TextEncoder().encode(
              yield* Effect.promise(() => readFile(statePath, "utf8"))
            ).byteLength <
              4 * 1024 * 1024
          );
        })
      )
  );

  it.effect(
    "serves more than 256 lifetime messages with bounded restart-safe tombstones",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-stream-tombstones-"
          );
          const statePath = join(root, "runner.json");
          const published: Array<{
            readonly messageId: string;
            readonly ownerId: string;
            readonly text: string;
          }> = [];
          const templateContext = yield* Layer.build(
            makeInMemoryStoreLayer(LABORER_SLACK_ID)
          );
          const templateStore = yield* PrototypeStore.pipe(
            Effect.provide(templateContext)
          );
          const rootTs = "250.300";
          const threadId = canonicalThreadId("CLIFETIME", rootTs, "TLIFETIME");
          yield* templateStore.accept(
            normalizedEvent({
              authorSlackId: "ULIFETIME",
              channelId: "CLIFETIME",
              eventId: "event:lifetime:template",
              messageTs: rootTs,
              text: `<@${LABORER_SLACK_ID}> begin lifetime stream test`,
              workspaceId: "TLIFETIME",
            })
          );
          yield* templateStore.completeContext(threadId, [], false);
          const templateTurn = yield* templateStore.claimNextTurn(threadId);
          assert.ok(templateTurn !== null);
          const templateMessageId = `message:${templateTurn.id}`;
          const templateAccepted =
            yield* templateStore.acceptConversationStreamChunk({
              messageId: templateMessageId,
              nowMillis: 0,
              ownerId: templateTurn.id,
              ownerKind: "participant-turn",
              sequence: null,
              text: "",
              threadId,
            });
          assert.strictEqual(templateAccepted._tag, "Accepted");
          yield* templateStore.configureConversationStream({
            flushDeadlineMillis: null,
            mode: "fallback",
            streamId: templateAccepted.streamId,
          });
          const liveStreamTemplate = (yield* templateStore.snapshot)
            .conversationStreams[0];
          assert.ok(liveStreamTemplate !== undefined);
          yield* templateStore.completeConversationStreamLocally(
            templateAccepted.streamId,
            "completed",
            0
          );
          yield* templateStore.completeHandler(threadId, templateTurn.id, {
            _tag: "Success",
          });
          const templateReaction =
            (yield* templateStore.completionReactions)[0];
          if (templateReaction !== undefined) {
            yield* templateStore.completeCompletionReaction(
              templateReaction.id
            );
          }
          const templateState = yield* templateStore.snapshot;
          const templateThread = templateState.threads[0];
          const completedTurnTemplate = templateThread?.turns[0];
          const streamTemplate = liveStreamTemplate;
          const messageTemplate = completedTurnTemplate?.messages[0];
          assert.ok(templateThread !== undefined);
          assert.ok(completedTurnTemplate !== undefined);
          assert.ok(streamTemplate !== undefined);
          assert.ok(messageTemplate !== undefined);

          const completedTurns: TurnState[] = [];
          const completedStreams: ConversationStreamState[] = [];
          for (let index = 0; index < 299; index += 1) {
            const slackTs = index === 0 ? rootTs : `250.${300 + index}`;
            const message =
              index === 0
                ? messageTemplate
                : NormalizedMessage.make({
                    ...messageTemplate,
                    id: stableMessageId("CLIFETIME", slackTs, "TLIFETIME"),
                    isActivation: false,
                    slackTs,
                    text: `lifetime input ${index}`,
                  });
            const turn =
              index === 0
                ? completedTurnTemplate
                : TurnState.make({
                    ...completedTurnTemplate,
                    id: TurnId.make(`turn:${message.id}`),
                    messages: [message],
                  });
            const messageId = `message:${turn.id}`;
            const stream = ConversationStreamState.make({
              ...streamTemplate,
              createdAtMillis: index,
              id: stableConversationStreamId({
                messageId,
                ownerId: turn.id,
                ownerKind: "participant-turn",
                threadId,
                workspaceId: "TLIFETIME",
              }),
              messageId,
              lifecycle: "stopped",
              ownerId: turn.id,
              stoppedAtMillis: index,
              terminalReason: "completed",
            });
            completedTurns.push(turn);
            completedStreams.push(stream);
            published.push({ messageId, ownerId: turn.id, text: "" });
          }
          const runningSlackTs = "250.999";
          const runningMessage = NormalizedMessage.make({
            ...messageTemplate,
            id: stableMessageId("CLIFETIME", runningSlackTs, "TLIFETIME"),
            isActivation: false,
            slackTs: runningSlackTs,
            text: "lifetime input 299",
          });
          const runningTurn = TurnState.make({
            ...completedTurnTemplate,
            attempts: [HandlerAttempt.make({ number: 1, status: "running" })],
            id: TurnId.make(`turn:${runningMessage.id}`),
            messages: [runningMessage],
            outcome: null,
            status: "running",
          });
          const unresolvedTemplate = completedStreams[298];
          assert.ok(unresolvedTemplate !== undefined);
          const unresolvedOperation = ConversationStreamOperation.make({
            attempt: 1,
            errorCategory: "request_error",
            errorCertainty: "unknown",
            id: `${unresolvedTemplate.id}:operation:native-start:0:0`,
            inFlightAtMillis: 298,
            kind: "native-start",
            payloadEndOffset: 0,
            payloadHash: unresolvedTemplate.cumulativeHash,
            payloadStartOffset: 0,
            payloadText: "",
            preparedAtMillis: 298,
            retryAtMillis: null,
            settledAtMillis: 298,
            status: "unresolved",
          });
          const unresolvedStream = ConversationStreamState.make({
            ...unresolvedTemplate,
            lifecycle: "unresolved",
            mode: "native",
            operations: [unresolvedOperation],
            stoppedAtMillis: 298,
            terminalReason: "response-outcome-unknown-after-restart",
          });
          const stoppedStreams = [
            ...completedStreams.slice(44, 298),
            unresolvedStream,
          ];
          const tombstones = completedStreams.slice(0, 44).map((stream) =>
            ConversationStreamTombstone.make({
              acceptedSequence: stream.acceptedSequence,
              channelId: stream.channelId,
              chunkHashes: stream.chunks.map(({ sequence, textHash }) => ({
                sequence,
                textHash,
              })),
              cumulativeHash: stream.cumulativeHash,
              confirmedHash: stream.confirmedHash,
              confirmedOffset: stream.confirmedOffset,
              id: stream.id,
              lifecycle: "stopped",
              messageId: stream.messageId,
              mode: stream.mode,
              operations: [],
              ownerId: stream.ownerId,
              ownerKind: stream.ownerKind,
              recipientUserId: stream.recipientUserId,
              rootTs: stream.rootTs,
              slackTs: stream.slackTs,
              stoppedAtMillis: stream.stoppedAtMillis ?? 0,
              terminalReason: stream.terminalReason ?? "completed",
              threadId: stream.threadId,
              workspaceId: stream.workspaceId,
            })
          );
          const seededState = PrototypeState.make({
            ...templateState,
            conversationStreams: stoppedStreams,
            conversationStreamTombstones: tombstones,
            threads: [
              WorkThreadState.make({
                ...templateThread,
                turns: [...completedTurns, runningTurn],
              }),
            ],
          });
          const storeContext = yield* Layer.build(
            makeControlledStoreLayer({
              laborerSlackId: LABORER_SLACK_ID,
              persist: () => Effect.void,
              state: seededState,
            })
          );
          const store = yield* PrototypeStore.pipe(
            Effect.provide(storeContext)
          );
          const finalMessageId = `message:${runningTurn.id}`;
          const finalAccepted = yield* store.acceptConversationStreamChunk({
            messageId: finalMessageId,
            nowMillis: 300,
            ownerId: runningTurn.id,
            ownerKind: "participant-turn",
            sequence: null,
            text: "",
            threadId,
          });
          assert.strictEqual(finalAccepted._tag, "Accepted");
          yield* store.configureConversationStream({
            flushDeadlineMillis: null,
            mode: "fallback",
            streamId: finalAccepted.streamId,
          });
          yield* store.completeConversationStreamLocally(
            finalAccepted.streamId,
            "completed",
            300
          );
          yield* store.completeHandler(threadId, runningTurn.id, {
            _tag: "Success",
          });
          yield* store.reconcileConversationStreamsOnRestart(300);
          const state = yield* store.snapshot;
          const retainedUnresolved = state.conversationStreamTombstones.find(
            (stream) => stream.id === unresolvedStream.id
          );
          assert.strictEqual(retainedUnresolved?.lifecycle, "unresolved");
          assert.strictEqual(
            retainedUnresolved?.operations[0]?.status,
            "unresolved"
          );
          assert.ok(state.conversationStreams.length === 0);
          assert.ok(state.conversationStreamTombstones.length <= 256);
          assert.strictEqual(
            state.conversationStreams.some(
              (stream) =>
                stream.lifecycle === "open" || stream.lifecycle === "finalizing"
            ),
            false
          );
          const encoded = JSON.stringify(state);
          assert.ok(
            new TextEncoder().encode(encoded).byteLength < 4 * 1024 * 1024
          );
          yield* Effect.promise(() =>
            writeFile(statePath, encoded, { encoding: "utf8", mode: 0o600 })
          );

          const context = yield* Layer.build(
            makeFileStoreLayer(LABORER_SLACK_ID, statePath, root)
          );
          const restarted = yield* PrototypeStore.pipe(Effect.provide(context));
          const retained = published[100];
          const evicted = published[0];
          assert.ok(retained !== undefined);
          assert.ok(evicted !== undefined);
          const duplicate = yield* restarted.acceptConversationStreamChunk({
            messageId: retained.messageId,
            nowMillis: 1,
            ownerId: retained.ownerId,
            ownerKind: "participant-turn",
            sequence: 0,
            text: retained.text,
            threadId,
          });
          assert.strictEqual(duplicate._tag, "Duplicate");
          const conflict = yield* Effect.result(
            restarted.acceptConversationStreamChunk({
              messageId: retained.messageId,
              nowMillis: 1,
              ownerId: retained.ownerId,
              ownerKind: "participant-turn",
              sequence: 0,
              text: "conflict",
              threadId,
            })
          );
          const evictedReplay = yield* Effect.result(
            restarted.acceptConversationStreamChunk({
              messageId: evicted.messageId,
              nowMillis: 1,
              ownerId: evicted.ownerId,
              ownerKind: "participant-turn",
              sequence: 0,
              text: evicted.text,
              threadId,
            })
          );
          assert.strictEqual(conflict._tag, "Failure");
          assert.strictEqual(evictedReplay._tag, "Failure");
          assert.strictEqual(
            (yield* restarted.snapshot).conversationStreams.length,
            state.conversationStreams.length
          );
        })
      ),
    30_000
  );
});
