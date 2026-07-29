import { createHash } from "node:crypto";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import {
  ApplicationConversationMessageChunk,
  type ApplicationShape,
  ExternalInputEvent,
} from "../src/application.ts";
import {
  immediateConversationStreamDeliveryPolicy,
  makeConversationStreamDelivery,
} from "../src/prototype/conversation-stream-delivery.ts";
import { canonicalThreadId } from "../src/prototype/domain.ts";
import { DeliveryError, HandlerFailure } from "../src/prototype/errors.ts";
import {
  makePrototypeHarness,
  type SlackGatewayShape,
} from "../src/prototype/runtime.ts";
import {
  LABORER_SLACK_ID,
  normalizedEvent,
} from "../src/prototype/scenario.ts";
import {
  makeFileStoreLayer,
  PrototypeStore,
  type PrototypeStoreShape,
} from "../src/prototype/store.ts";
import {
  type ConversationAgentRequest,
  ImplementationAgent,
  makeFileApplicationRepository,
  makeReferenceCodingApplication,
  type PublishConversationAgentMessage,
  WorktreeManager,
} from "../src/reference-coding-application.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

const claimParticipantOwner = Effect.fnUntraced(function* (
  store: PrototypeStoreShape,
  threadId: ReturnType<typeof canonicalThreadId>
) {
  yield* store.completeContext(threadId, [], false);
  const turn = yield* store.claimNextTurn(threadId);
  assert.ok(turn !== null);
  return {
    ownerId: turn.id,
    ownerKind: "participant-turn" as const,
    threadId,
  };
});

const waitForTerminalStream = Effect.fnUntraced(function* (
  store: PrototypeStoreShape
) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const state = yield* store.snapshot;
    const tombstone = state.conversationStreamTombstones.at(-1);
    if (tombstone !== undefined) {
      return tombstone;
    }
    yield* Effect.promise(
      () => new Promise<void>((resolveWait) => setTimeout(resolveWait, 1))
    );
  }
  return yield* Effect.die(new Error("stream did not reach terminal evidence"));
});

describe("durable Conversation stream delivery", () => {
  it.effect(
    "persists monotonic semantic chunks and rejects gaps or conflicts after restart",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped("laborer-stream-store-");
          const statePath = join(root, "runner.json");
          const threadId = canonicalThreadId(
            "CWORK",
            "1700000000.000001",
            "TWORK"
          );
          const makeStore = Effect.gen(function* () {
            const context = yield* Layer.build(
              makeFileStoreLayer(LABORER_SLACK_ID, statePath, root)
            );
            return yield* PrototypeStore.pipe(Effect.provide(context));
          });
          const first = yield* makeStore;
          yield* first.accept(
            normalizedEvent({
              authorSlackId: "UASKER",
              channelId: "CWORK",
              eventId: "event:stream-store",
              messageTs: "1700000000.000001",
              text: `<@${LABORER_SLACK_ID}> stream`,
              workspaceId: "TWORK",
            })
          );
          yield* first.completeContext(threadId, [], false);
          const turn = yield* first.claimNextTurn(threadId);
          assert.ok(turn !== null);

          const accepted = yield* first.acceptConversationStreamChunk({
            messageId: "assistant-message",
            nowMillis: 0,
            ownerId: turn.id,
            ownerKind: "participant-turn",
            sequence: 0,
            text: "hello",
            threadId,
          });
          assert.strictEqual(accepted._tag, "Accepted");

          const restarted = yield* makeStore;
          const duplicate = yield* restarted.acceptConversationStreamChunk({
            messageId: "assistant-message",
            nowMillis: 1,
            ownerId: turn.id,
            ownerKind: "participant-turn",
            sequence: 0,
            text: "hello",
            threadId,
          });
          assert.strictEqual(duplicate._tag, "Duplicate");

          const conflict = yield* Effect.result(
            restarted.acceptConversationStreamChunk({
              messageId: "assistant-message",
              nowMillis: 1,
              ownerId: turn.id,
              ownerKind: "participant-turn",
              sequence: 0,
              text: "different",
              threadId,
            })
          );
          const gap = yield* Effect.result(
            restarted.acceptConversationStreamChunk({
              messageId: "assistant-message",
              nowMillis: 1,
              ownerId: turn.id,
              ownerKind: "participant-turn",
              sequence: 2,
              text: "gap",
              threadId,
            })
          );
          assert.strictEqual(conflict._tag, "Failure");
          assert.strictEqual(gap._tag, "Failure");

          const state = yield* restarted.snapshot;
          assert.strictEqual(state.conversationStreams.length, 1);
          assert.deepStrictEqual(
            {
              acceptedSequence: state.conversationStreams[0]?.acceptedSequence,
              cumulativeText: state.conversationStreams[0]?.cumulativeText,
              messageId: state.conversationStreams[0]?.messageId,
              ownerId: state.conversationStreams[0]?.ownerId,
              ownerKind: state.conversationStreams[0]?.ownerKind,
              threadId: state.conversationStreams[0]?.threadId,
              workspaceId: state.conversationStreams[0]?.workspaceId,
            },
            {
              acceptedSequence: 0,
              cumulativeText: "hello",
              messageId: "assistant-message",
              ownerId: turn.id,
              ownerKind: "participant-turn",
              threadId,
              workspaceId: "TWORK",
            }
          );
        })
      )
  );

  it.effect(
    "preserves explicit producer sequence through the public publisher",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-stream-public-sequence-"
          );
          const statePath = join(root, "runner.json");
          const rootTs = "1700000000.000002";
          const threadId = canonicalThreadId("CWORK", rootTs, "TWORK");
          const context = yield* Layer.build(
            makeFileStoreLayer(LABORER_SLACK_ID, statePath, root)
          );
          const store = yield* PrototypeStore.pipe(Effect.provide(context));
          yield* store.accept(
            normalizedEvent({
              authorSlackId: "UASKER",
              channelId: "CWORK",
              eventId: "event:stream-public-sequence",
              messageTs: rootTs,
              text: `<@${LABORER_SLACK_ID}> stream`,
              workspaceId: "TWORK",
            })
          );
          const owner = yield* claimParticipantOwner(store, threadId);
          let posts = 0;
          const delivery = yield* makeConversationStreamDelivery({
            policy: {
              ...immediateConversationStreamDeliveryPolicy,
              coalesceCodePoints: 1,
            },
            slack: {
              postThreadMessage: () =>
                Effect.sync(() => {
                  posts += 1;
                  return { ts: "public-sequence-message" };
                }),
              readActivationContext: () => Effect.succeed([]),
              updateThreadMessage: () => Effect.void,
            },
            store,
          });
          const publisher = delivery.publisherFor(owner);
          yield* publisher.publish(
            ApplicationConversationMessageChunk.make({
              messageId: "assistant-message",
              sequence: 0,
              text: "hello",
            })
          );
          yield* publisher.publish(
            ApplicationConversationMessageChunk.make({
              messageId: "assistant-message",
              sequence: 0,
              text: "hello",
            })
          );
          const conflict = yield* Effect.result(
            publisher.publish(
              ApplicationConversationMessageChunk.make({
                messageId: "assistant-message",
                sequence: 0,
                text: "different",
              })
            )
          );
          const gap = yield* Effect.result(
            publisher.publish(
              ApplicationConversationMessageChunk.make({
                messageId: "assistant-message",
                sequence: 2,
                text: "gap",
              })
            )
          );

          assert.strictEqual(posts, 1);
          assert.strictEqual(conflict._tag, "Failure");
          assert.strictEqual(gap._tag, "Failure");
          const stream = (yield* store.snapshot).conversationStreams[0];
          assert.strictEqual(stream?.acceptedSequence, 0);
          assert.strictEqual(stream?.cumulativeText, "hello");
        })
      )
  );

  it.effect(
    "preserves the unsequenced public publisher replay cursor across restart",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-stream-public-replay-"
          );
          const statePath = join(root, "runner.json");
          const rootTs = "1700000000.000003";
          const threadId = canonicalThreadId("CWORK", rootTs, "TWORK");
          const calls: string[] = [];
          const slack: SlackGatewayShape = {
            postThreadMessage: ({ text }) =>
              Effect.sync(() => {
                calls.push(`post:${text}`);
                return { ts: "public-replay-message" };
              }),
            readActivationContext: () => Effect.succeed([]),
            updateThreadMessage: ({ text }) =>
              Effect.sync(() => {
                calls.push(`update:${text}`);
              }),
          };
          const makeStore = Effect.gen(function* () {
            const context = yield* Layer.build(
              makeFileStoreLayer(LABORER_SLACK_ID, statePath, root)
            );
            return yield* PrototypeStore.pipe(Effect.provide(context));
          });
          const makeDelivery = (store: PrototypeStoreShape) =>
            makeConversationStreamDelivery({
              policy: {
                ...immediateConversationStreamDeliveryPolicy,
                coalesceCodePoints: 1,
              },
              slack,
              store,
            });
          const firstStore = yield* makeStore;
          yield* firstStore.accept(
            normalizedEvent({
              authorSlackId: "UASKER",
              channelId: "CWORK",
              eventId: "event:stream-public-replay",
              messageTs: rootTs,
              text: `<@${LABORER_SLACK_ID}> stream`,
              workspaceId: "TWORK",
            })
          );
          const owner = yield* claimParticipantOwner(firstStore, threadId);
          const firstPublisher = (yield* makeDelivery(firstStore)).publisherFor(
            owner
          );
          for (const text of ["Hello", " world"]) {
            yield* firstPublisher.publish(
              ApplicationConversationMessageChunk.make({
                messageId: "assistant-message",
                text,
              })
            );
          }

          const secondStore = yield* makeStore;
          const secondDelivery = yield* makeDelivery(secondStore);
          yield* secondDelivery.recover;
          yield* secondDelivery.publisherFor(owner).publish(
            ApplicationConversationMessageChunk.make({
              messageId: "assistant-message",
              text: "Hello",
            })
          );
          assert.strictEqual(
            (yield* secondStore.snapshot).conversationStreams[0]
              ?.replayCursorOffset,
            5
          );

          const thirdStore = yield* makeStore;
          const thirdDelivery = yield* makeDelivery(thirdStore);
          yield* thirdDelivery.recover;
          const thirdPublisher = thirdDelivery.publisherFor(owner);
          yield* thirdPublisher.publish(
            ApplicationConversationMessageChunk.make({
              messageId: "assistant-message",
              text: " world!",
            })
          );
          yield* thirdPublisher.finalize("completed");

          assert.deepStrictEqual(calls, [
            "post:Hello",
            "update:Hello world",
            "update:Hello world!",
          ]);
          const tombstone = (yield* thirdStore.snapshot)
            .conversationStreamTombstones[0];
          assert.strictEqual(tombstone?.acceptedSequence, 2);
          assert.strictEqual(tombstone?.lifecycle, "stopped");
        })
      )
  );

  it.effect(
    "persists replay cursors across restart and reconciles exact, resegmented, continuation, and conflicting replay",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-stream-replay-cursor-"
          );
          const cases = [
            {
              afterRestart: [" world", "!"],
              beforeRestart: ["Hello"],
              expectedDecisions: ["Duplicate", "Accepted"],
              initial: ["Hello", " world"],
              name: "exact",
            },
            {
              afterRestart: ["world!"],
              beforeRestart: ["Hello "],
              expectedDecisions: ["Accepted"],
              initial: ["Hel", "lo world"],
              name: "resegmented",
            },
          ] as const;

          for (const [caseIndex, replayCase] of cases.entries()) {
            const statePath = join(root, `${replayCase.name}.json`);
            const rootTs = `1700000000.10000${caseIndex}`;
            const threadId = canonicalThreadId("CWORK", rootTs, "TWORK");
            const makeStore = Effect.gen(function* () {
              const context = yield* Layer.build(
                makeFileStoreLayer(LABORER_SLACK_ID, statePath, root)
              );
              return yield* PrototypeStore.pipe(Effect.provide(context));
            });
            const firstStore = yield* makeStore;
            yield* firstStore.accept(
              normalizedEvent({
                authorSlackId: "UASKER",
                channelId: "CWORK",
                eventId: `event:stream-replay:${replayCase.name}`,
                messageTs: rootTs,
                text: `<@${LABORER_SLACK_ID}> stream`,
                workspaceId: "TWORK",
              })
            );
            const owner = yield* claimParticipantOwner(firstStore, threadId);
            for (const text of replayCase.initial) {
              yield* firstStore.acceptConversationStreamChunk({
                messageId: "assistant-message",
                nowMillis: 0,
                ownerId: owner.ownerId,
                ownerKind: owner.ownerKind,
                sequence: null,
                text,
                threadId,
              });
            }
            yield* firstStore.reconcileConversationStreamsOnRestart(1);
            for (const text of replayCase.beforeRestart) {
              const decision = yield* firstStore.acceptConversationStreamChunk({
                messageId: "assistant-message",
                nowMillis: 1,
                ownerId: owner.ownerId,
                ownerKind: owner.ownerKind,
                sequence: null,
                text,
                threadId,
              });
              assert.strictEqual(decision._tag, "Duplicate");
            }

            const persistedCursor = (yield* firstStore.snapshot)
              .conversationStreams[0]?.replayCursorOffset;
            assert.ok(
              persistedCursor !== null && persistedCursor !== undefined
            );
            assert.ok(persistedCursor > 0);

            const restartedStore = yield* makeStore;
            yield* restartedStore.reconcileConversationStreamsOnRestart(2);
            const decisions: string[] = [];
            for (const text of replayCase.afterRestart) {
              const decision =
                yield* restartedStore.acceptConversationStreamChunk({
                  messageId: "assistant-message",
                  nowMillis: 2,
                  ownerId: owner.ownerId,
                  ownerKind: owner.ownerKind,
                  sequence: null,
                  text,
                  threadId,
                });
              decisions.push(decision._tag);
            }
            assert.deepStrictEqual(
              decisions,
              Array.from(replayCase.expectedDecisions)
            );
            const stream = (yield* restartedStore.snapshot)
              .conversationStreams[0];
            assert.strictEqual(stream?.cumulativeText, "Hello world!");
            assert.strictEqual(stream?.replayBoundaryOffset, null);
            assert.strictEqual(stream?.replayCursorOffset, null);
            assert.strictEqual(stream?.chunks.at(-1)?.text, "!");
          }

          const conflictPath = join(root, "conflict.json");
          const conflictRootTs = "1700000000.100009";
          const conflictThreadId = canonicalThreadId(
            "CWORK",
            conflictRootTs,
            "TWORK"
          );
          const conflictContext = yield* Layer.build(
            makeFileStoreLayer(LABORER_SLACK_ID, conflictPath, root)
          );
          const conflictStore = yield* PrototypeStore.pipe(
            Effect.provide(conflictContext)
          );
          yield* conflictStore.accept(
            normalizedEvent({
              authorSlackId: "UASKER",
              channelId: "CWORK",
              eventId: "event:stream-replay:conflict",
              messageTs: conflictRootTs,
              text: `<@${LABORER_SLACK_ID}> stream`,
              workspaceId: "TWORK",
            })
          );
          const conflictOwner = yield* claimParticipantOwner(
            conflictStore,
            conflictThreadId
          );
          for (const text of ["Hello", " world"]) {
            yield* conflictStore.acceptConversationStreamChunk({
              messageId: "assistant-message",
              nowMillis: 0,
              ownerId: conflictOwner.ownerId,
              ownerKind: conflictOwner.ownerKind,
              sequence: null,
              text,
              threadId: conflictThreadId,
            });
          }
          yield* conflictStore.reconcileConversationStreamsOnRestart(1);
          yield* conflictStore.acceptConversationStreamChunk({
            messageId: "assistant-message",
            nowMillis: 1,
            ownerId: conflictOwner.ownerId,
            ownerKind: conflictOwner.ownerKind,
            sequence: null,
            text: "Hello",
            threadId: conflictThreadId,
          });
          const conflict = yield* Effect.result(
            conflictStore.acceptConversationStreamChunk({
              messageId: "assistant-message",
              nowMillis: 1,
              ownerId: conflictOwner.ownerId,
              ownerKind: conflictOwner.ownerKind,
              sequence: null,
              text: "WRONG",
              threadId: conflictThreadId,
            })
          );
          assert.strictEqual(conflict._tag, "Failure");
          assert.strictEqual(
            (yield* conflictStore.snapshot).conversationStreams[0]
              ?.replayCursorOffset,
            5
          );
        })
      )
  );

  it.live(
    "honors durable Retry-After and method budget state across restart without hidden retries",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped("laborer-stream-rate-");
          const statePath = join(root, "runner.json");
          const rootTs = "1700000006.000001";
          const threadId = canonicalThreadId("CWORK", rootTs, "TWORK");
          const firstRequest = yield* Deferred.make<void>();
          let starts = 0;
          const slack: SlackGatewayShape = {
            conversationStreamDeliveryPolicy: {
              coalesceCodePoints: 256,
              maxCoalesceMillis: 1000,
              spacingMillis: {
                "fallback-post": 1000,
                "fallback-update": 1200,
                "native-append": 1000,
                "native-start": 3000,
                "native-stop": 3000,
              },
            },
            nativeStreaming: {
              append: () => Effect.void,
              start: () =>
                Effect.suspend(() => {
                  starts += 1;
                  if (starts === 1) {
                    return Deferred.succeed(firstRequest, undefined).pipe(
                      Effect.andThen(
                        DeliveryError.make({
                          category: "ratelimited",
                          disposition: "transient",
                          outcomeCertainty: "definitely-rejected",
                          retryAfterMillis: 200,
                        })
                      )
                    );
                  }
                  return Effect.succeed({ ts: "native-rate-stream" });
                }),
              stop: () => Effect.void,
            },
            postThreadMessage: () => Effect.succeed({ ts: "unused" }),
            readActivationContext: () => Effect.succeed([]),
          };
          const makeStore = Effect.gen(function* () {
            const context = yield* Layer.build(
              makeFileStoreLayer(LABORER_SLACK_ID, statePath, root)
            );
            return yield* PrototypeStore.pipe(Effect.provide(context));
          });
          const firstStore = yield* makeStore;
          yield* firstStore.accept(
            normalizedEvent({
              authorSlackId: "UASKER",
              channelId: "CWORK",
              eventId: "event:stream-rate",
              messageTs: rootTs,
              text: `<@${LABORER_SLACK_ID}> stream`,
              workspaceId: "TWORK",
            })
          );
          const owner = yield* claimParticipantOwner(firstStore, threadId);
          const firstDelivery = yield* makeConversationStreamDelivery({
            policy: immediateConversationStreamDeliveryPolicy,
            slack,
            store: firstStore,
          });
          const firstPublish = yield* firstDelivery
            .publisherFor(owner)
            .publish(
              ApplicationConversationMessageChunk.make({
                messageId: "assistant-message",
                sequence: 0,
                text: "rate limited",
              })
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(firstRequest);
          let operationStatus = "";
          for (
            let index = 0;
            index < 100 && operationStatus !== "retry";
            index += 1
          ) {
            yield* Effect.promise(
              () => new Promise((resolveWait) => setTimeout(resolveWait, 1))
            );
            operationStatus =
              (yield* firstStore.snapshot).conversationStreams[0]?.operations[0]
                ?.status ?? "";
          }
          assert.strictEqual(operationStatus, "retry");
          yield* Fiber.interrupt(firstPublish);

          const restartedStore = yield* makeStore;
          const restartedDelivery = yield* makeConversationStreamDelivery({
            policy: immediateConversationStreamDeliveryPolicy,
            slack,
            store: restartedStore,
          });
          const recoveryStartedAt = Date.now();
          yield* restartedDelivery.recover;
          assert.ok(Date.now() - recoveryStartedAt < 25);
          yield* Effect.sleep("50 millis");
          assert.strictEqual(starts, 1);
          for (let attempt = 0; attempt < 200 && starts < 2; attempt += 1) {
            yield* Effect.sleep("2 millis");
          }

          assert.strictEqual(starts, 2);
          yield* restartedDelivery.signalOwnerRecovery(owner, "unavailable");
          const tombstone = yield* waitForTerminalStream(restartedStore);
          assert.strictEqual(tombstone.lifecycle, "stopped");
        })
      )
  );

  it.live(
    "retries an unknown fallback update to idempotent cumulative convergence",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-fallback-convergence-"
          );
          const statePath = join(root, "runner.json");
          const rootTs = "1700000005.000001";
          const threadId = canonicalThreadId("CWORK", rootTs, "TWORK");
          let updateAttempts = 0;
          const slack: SlackGatewayShape = {
            postThreadMessage: () => Effect.succeed({ ts: "message-1" }),
            readActivationContext: () => Effect.succeed([]),
            updateThreadMessage: ({ text }) =>
              Effect.suspend(() => {
                updateAttempts += 1;
                return updateAttempts === 1
                  ? DeliveryError.make({
                      category: "request_error",
                      disposition: "transient",
                      outcomeCertainty: "unknown",
                      retryAfterMillis: 0,
                    })
                  : Effect.sync(() => {
                      assert.strictEqual(text, "Hello world");
                    });
              }),
          };
          const makeStore = Effect.gen(function* () {
            const context = yield* Layer.build(
              makeFileStoreLayer(LABORER_SLACK_ID, statePath, root)
            );
            return yield* PrototypeStore.pipe(Effect.provide(context));
          });
          const firstStore = yield* makeStore;
          yield* firstStore.accept(
            normalizedEvent({
              authorSlackId: "UASKER",
              channelId: "CWORK",
              eventId: "event:fallback-convergence",
              messageTs: rootTs,
              text: `<@${LABORER_SLACK_ID}> stream`,
              workspaceId: "TWORK",
            })
          );
          const owner = yield* claimParticipantOwner(firstStore, threadId);
          const firstDelivery = yield* makeConversationStreamDelivery({
            slack,
            store: firstStore,
          });
          yield* firstDelivery.publisherFor(owner).publish(
            ApplicationConversationMessageChunk.make({
              messageId: "assistant-message",
              sequence: 0,
              text: "Hello",
            })
          );

          const restartedStore = yield* makeStore;
          const restartedDelivery = yield* makeConversationStreamDelivery({
            policy: {
              ...immediateConversationStreamDeliveryPolicy,
              maxCoalesceMillis: 0,
            },
            slack,
            store: restartedStore,
          });
          const publisher = restartedDelivery.publisherFor(owner);
          yield* publisher.publish(
            ApplicationConversationMessageChunk.make({
              messageId: "assistant-message",
              sequence: 1,
              text: " world",
            })
          );
          yield* publisher.finalize("completed");

          assert.strictEqual(updateAttempts, 2);
          const state = yield* restartedStore.snapshot;
          assert.deepStrictEqual(
            state.conversationStreamTombstones[0]?.operations.map(
              (operation) => ({
                attempt: operation.attempt,
                kind: operation.kind,
                status: operation.status,
              })
            ),
            [
              {
                attempt: 2,
                kind: "fallback-update",
                status: "acknowledged",
              },
            ]
          );
          assert.strictEqual(
            state.conversationStreamTombstones[0]?.lifecycle,
            "stopped"
          );
        })
      )
  );

  it.effect(
    "routes owner-neutral Application-event chunks through the same durable projection",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const calls: string[] = [];
          const slack: SlackGatewayShape = {
            postThreadMessage: ({ text }) =>
              Effect.sync(() => {
                calls.push(text);
                return { ts: `message-${calls.length}` };
              }),
            readActivationContext: () => Effect.succeed([]),
            updateThreadMessage: () => Effect.void,
          };
          const application: ApplicationShape = {
            handle: (event, publish) =>
              event._tag === "ExternalInput"
                ? publish(
                    ApplicationConversationMessageChunk.make({
                      messageId: "application-event-message",
                      sequence: 0,
                      text: "Execution completed safely.",
                    })
                  )
                : Effect.void,
          };
          const harness = yield* makePrototypeHarness({
            application,
            laborerSlackId: LABORER_SLACK_ID,
            slack,
          });
          const rootTs = "1700000004.000001";
          const threadId = canonicalThreadId("CWORK", rootTs);
          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: "UASKER",
              channelId: "CWORK",
              eventId: "event:application-owner-root",
              messageTs: rootTs,
              text: `<@${LABORER_SLACK_ID}> begin`,
            })
          );

          yield* harness.runner.acceptApplicationEvent(
            ExternalInputEvent.make({
              conversationId: threadId,
              eventId: "execution:event:1",
              payload: { executionId: "execution-1" },
              source: "implementation-agent",
            })
          );
          yield* harness.runner.drain(threadId);

          assert.deepStrictEqual(calls, ["Execution completed safely."]);
          const state = yield* harness.store.snapshot;
          assert.strictEqual(
            state.conversationStreamTombstones[0]?.ownerKind,
            "application-event"
          );
          assert.strictEqual(
            state.conversationStreamTombstones[0]?.ownerId,
            "execution:event:1"
          );
          assert.strictEqual(
            state.conversationStreamTombstones[0]?.lifecycle,
            "stopped"
          );
        })
      )
  );

  it.effect(
    "accepts 4,001 through exactly 12,000 code points in native append and fallback update",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-stream-slack-message-bound-"
          );
          for (const mode of ["fallback", "native"] as const) {
            for (const targetLength of [4001, 12_000] as const) {
              const suffix = `${mode}-${targetLength}`;
              const rootTs = `1700000004.${targetLength}`;
              const threadId = canonicalThreadId("CWORK", rootTs, "TWORK");
              const context = yield* Layer.build(
                makeFileStoreLayer(
                  LABORER_SLACK_ID,
                  join(root, `${suffix}.json`),
                  root
                )
              );
              const store = yield* PrototypeStore.pipe(Effect.provide(context));
              yield* store.accept(
                normalizedEvent({
                  authorSlackId: "UASKER",
                  channelId: "CWORK",
                  eventId: `event:${suffix}`,
                  messageTs: rootTs,
                  text: `<@${LABORER_SLACK_ID}> stream`,
                  workspaceId: "TWORK",
                })
              );
              const owner = yield* claimParticipantOwner(store, threadId);
              const calls: Array<{
                readonly kind: string;
                readonly text: string;
              }> = [];
              const slack: SlackGatewayShape = {
                ...(mode === "native"
                  ? {
                      nativeStreaming: {
                        append: ({ text }: { readonly text: string }) =>
                          Effect.sync(() => {
                            calls.push({ kind: "append", text });
                          }),
                        start: ({ text }: { readonly text: string }) =>
                          Effect.sync(() => {
                            calls.push({ kind: "start", text });
                            return { ts: `message-${suffix}` };
                          }),
                        stop: () => Effect.void,
                      },
                    }
                  : {}),
                postThreadMessage: ({ text }) =>
                  Effect.sync(() => {
                    calls.push({ kind: "post", text });
                    return { ts: `message-${suffix}` };
                  }),
                readActivationContext: () => Effect.succeed([]),
                updateThreadMessage: ({ text }) =>
                  Effect.sync(() => {
                    calls.push({ kind: "update", text });
                  }),
              };
              const delivery = yield* makeConversationStreamDelivery({
                policy: {
                  ...immediateConversationStreamDeliveryPolicy,
                  coalesceCodePoints: 1,
                },
                slack,
                store,
              });
              const publisher = delivery.publisherFor(owner);
              yield* publisher.publish(
                ApplicationConversationMessageChunk.make({
                  messageId: `message:${suffix}`,
                  sequence: 0,
                  text: "**A**",
                })
              );
              yield* publisher.publish(
                ApplicationConversationMessageChunk.make({
                  messageId: `message:${suffix}`,
                  sequence: 1,
                  text: "😀".repeat(targetLength - 5),
                })
              );
              yield* publisher.finalize("completed");

              assert.deepStrictEqual(
                calls.map(({ kind, text }) => ({
                  kind,
                  length: [...text].length,
                })),
                mode === "native"
                  ? [
                      { kind: "start", length: 5 },
                      { kind: "append", length: targetLength - 5 },
                    ]
                  : [
                      { kind: "post", length: 5 },
                      { kind: "update", length: targetLength },
                    ]
              );
              assert.strictEqual(
                (yield* store.snapshot).conversationStreamTombstones[0]
                  ?.confirmedOffset,
                targetLength
              );
            }
          }
        })
      )
  );

  it.live(
    "finalizes an exact-boundary partial message and notices 12,001 overflow without replay",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-stream-slack-overflow-"
          );
          const markdownPrefix = "**Confirmed partial**\n";
          const confirmedText = `${markdownPrefix}${"😀".repeat(
            12_000 - [...markdownPrefix].length
          )}`;
          const confirmedHash = createHash("sha256")
            .update(confirmedText)
            .digest("hex");
          for (const mode of ["fallback", "native"] as const) {
            const rootTs =
              mode === "native" ? "1700000004.12001" : "1700000004.12002";
            const threadId = canonicalThreadId("CWORK", rootTs, "TWORK");
            const statePath = join(root, `${mode}-overflow.json`);
            const calls: string[] = [];
            const makeSlack = (): SlackGatewayShape => ({
              ...(mode === "native"
                ? {
                    nativeStreaming: {
                      append: ({ text }: { readonly text: string }) =>
                        Effect.sync(() => {
                          calls.push(`append:${[...text].length}`);
                        }),
                      start: ({ text }: { readonly text: string }) =>
                        Effect.sync(() => {
                          calls.push(`start:${[...text].length}`);
                          return { ts: `${mode}-partial` };
                        }),
                      stop: () =>
                        Effect.sync(() => {
                          calls.push("stop");
                        }),
                    },
                  }
                : {}),
              postThreadMessage: ({ text }) =>
                Effect.sync(() => {
                  calls.push(
                    text === confirmedText ? "post:12000" : `notice:${text}`
                  );
                  return { ts: `${mode}-${calls.length}` };
                }),
              readActivationContext: () => Effect.succeed([]),
              updateThreadMessage: ({ text }) =>
                Effect.sync(() => {
                  calls.push(`update:${[...text].length}`);
                }),
            });
            const application: ApplicationShape = {
              handle: (event, publish) =>
                event._tag === "ExternalInput"
                  ? Effect.gen(function* () {
                      yield* publish(
                        ApplicationConversationMessageChunk.make({
                          messageId: `overflow:${mode}`,
                          sequence: 0,
                          text: confirmedText,
                        })
                      );
                      yield* publish(
                        ApplicationConversationMessageChunk.make({
                          messageId: `overflow:${mode}`,
                          sequence: 1,
                          text: "x",
                        })
                      );
                    })
                  : Effect.void,
            };
            const storeLayer = makeFileStoreLayer(
              LABORER_SLACK_ID,
              statePath,
              root
            );

            yield* Effect.scoped(
              Effect.gen(function* () {
                const harness = yield* makePrototypeHarness({
                  application,
                  laborerSlackId: LABORER_SLACK_ID,
                  slack: makeSlack(),
                  storeLayer,
                });
                yield* harness.runner.inject(
                  normalizedEvent({
                    authorSlackId: "UASKER",
                    channelId: "CWORK",
                    eventId: `event:overflow-root:${mode}`,
                    messageTs: rootTs,
                    text: `<@${LABORER_SLACK_ID}> begin`,
                    workspaceId: "TWORK",
                  })
                );
                yield* harness.runner.acceptApplicationEvent(
                  ExternalInputEvent.make({
                    conversationId: threadId,
                    eventId: `execution:overflow:${mode}`,
                    payload: { mode },
                    source: "implementation-agent",
                  })
                );
                yield* harness.runner.drain(threadId);
                const state = yield* harness.store.snapshot;
                const tombstone = state.conversationStreamTombstones[0];
                assert.strictEqual(
                  state.threads[0]?.applicationEvents[0]?.status,
                  "failed"
                );
                assert.strictEqual(tombstone?.confirmedOffset, 12_000);
                assert.strictEqual(tombstone?.confirmedHash, confirmedHash);
                assert.strictEqual(tombstone?.lifecycle, "stopped");
              })
            );

            assert.deepStrictEqual(
              calls,
              mode === "native"
                ? [
                    "start:12000",
                    "stop",
                    "notice:Application event failed. See Runner logs.",
                  ]
                : [
                    "post:12000",
                    "notice:Application event failed. See Runner logs.",
                  ]
            );
            const callsBeforeRestart = calls.length;
            yield* Effect.scoped(
              Effect.gen(function* () {
                const restarted = yield* makePrototypeHarness({
                  application,
                  laborerSlackId: LABORER_SLACK_ID,
                  slack: makeSlack(),
                  storeLayer,
                });
                yield* restarted.runner.drain(threadId);
                assert.strictEqual(
                  (yield* restarted.store.snapshot).threads[0]
                    ?.applicationEvents[0]?.status,
                  "failed"
                );
              })
            );
            assert.strictEqual(calls.length, callsBeforeRestart);
          }
        })
      ),
    30_000
  );

  it.live(
    "streams a real reference Application implementation event through the same projection",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const calls: string[] = [];
          const observedSources: string[] = [];
          const slack: SlackGatewayShape = {
            postThreadMessage: ({ text }) =>
              Effect.sync(() => {
                calls.push(text);
                return { ts: `message-${calls.length}` };
              }),
            readActivationContext: () => Effect.succeed([]),
            updateThreadMessage: () => Effect.void,
          };
          const conversationAgent = {
            handle: (
              request: ConversationAgentRequest,
              publishMessage: PublishConversationAgentMessage = () =>
                Effect.void
            ) =>
              Effect.gen(function* () {
                observedSources.push(request.source);
                if (request.source === "implementation-agent") {
                  yield* publishMessage({
                    messageId: `execution:${request.turnId}`,
                    text: "Implementation completed safely.",
                  });
                  return [];
                }
                if (request.source !== "slack") {
                  return [];
                }
                const action = request.actions.find(
                  ({ name }) => name === "create-feature"
                );
                assert.ok(action !== undefined);
                yield* action.invoke({
                  prompt: "Implement the requested feature.",
                  worktreeName: "reference-event-stream",
                });
                return [];
              }),
          };
          const application = yield* makeReferenceCodingApplication({
            conversationAgent,
            implementationAgent: ImplementationAgent.of({
              start: (request, acceptResponse) =>
                Effect.succeed({
                  completion: acceptResponse({
                    responseId: "response:reference-event-stream",
                    text: "Implementation agent response.",
                  }),
                  resume: () => Effect.void,
                  sessionId: request.implementationSessionId,
                }),
            }),
            worktreeManager: WorktreeManager.of({
              create: () =>
                Effect.succeed({
                  workingDirectory: "/tmp/reference-event-stream",
                }),
            }),
          });
          const harness = yield* makePrototypeHarness({
            application,
            laborerSlackId: LABORER_SLACK_ID,
            slack,
          });
          const rootTs = "1700000004.000002";
          const threadId = canonicalThreadId("CWORK", rootTs);

          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: "UASKER",
              channelId: "CWORK",
              eventId: "event:reference-application-root",
              messageTs: rootTs,
              text: `<@${LABORER_SLACK_ID}> implement`,
            })
          );
          for (
            let attempt = 0;
            attempt < 100 && calls.length === 0;
            attempt += 1
          ) {
            yield* harness.runner.drain(threadId);
            yield* Effect.sleep("10 millis");
          }

          assert.deepStrictEqual(calls, ["Implementation completed safely."]);
          assert.deepStrictEqual(observedSources, [
            "slack",
            "implementation-agent",
            "action-terminal",
          ]);
          const stream = (yield* harness.store.snapshot)
            .conversationStreamTombstones[0];
          assert.strictEqual(stream?.ownerKind, "application-event");
          assert.ok(stream?.ownerId.includes(":response:"));
          assert.strictEqual(stream?.lifecycle, "stopped");
        })
      ),
    10_000
  );

  it.live(
    "does not replay a real reference Application event after partial stream signal failure and restart",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-reference-event-partial-failure-"
          );
          const runnerPath = join(root, "runner.json");
          const applicationPath = join(root, "application.json");
          const rootTs = "1700000004.000003";
          const threadId = canonicalThreadId("CWORK", rootTs, "TWORK");
          let implementationEventRuns = 0;
          const implementationEventIds: string[] = [];
          const calls: string[] = [];
          const slack: SlackGatewayShape = {
            postThreadMessage: ({ text }) =>
              Effect.sync(() => {
                calls.push(text);
                return { ts: `message-${calls.length}` };
              }),
            readActivationContext: () => Effect.succeed([]),
            updateThreadMessage: () => Effect.void,
          };
          const makeApplication = Effect.gen(function* () {
            const repository = yield* makeFileApplicationRepository(
              applicationPath,
              root
            );
            return yield* makeReferenceCodingApplication({
              conversationAgent: {
                handle: (
                  request: ConversationAgentRequest,
                  publishMessage: PublishConversationAgentMessage = () =>
                    Effect.void
                ) =>
                  Effect.gen(function* () {
                    if (request.source === "implementation-agent") {
                      implementationEventRuns += 1;
                      implementationEventIds.push(request.turnId);
                      yield* publishMessage({
                        messageId: `execution:${request.turnId}`,
                        text: "Visible before signal failure.",
                      });
                      return yield* HandlerFailure.make({
                        category: "signal",
                        safeDetail: null,
                      });
                    }
                    if (request.source !== "slack") {
                      return [];
                    }
                    const action = request.actions.find(
                      ({ name }) => name === "create-feature"
                    );
                    assert.ok(action !== undefined);
                    yield* action.invoke({
                      prompt: "Implement the requested feature.",
                      worktreeName: "reference-event-partial-failure",
                    });
                    return [];
                  }),
              },
              implementationAgent: ImplementationAgent.of({
                recover: (request) =>
                  Effect.succeed({
                    completion: Effect.void,
                    resume: () => Effect.void,
                    sessionId: request.implementationSessionId,
                  }),
                start: (request, acceptResponse) =>
                  Effect.succeed({
                    completion: acceptResponse({
                      responseId: "response:reference-event-partial-failure",
                      text: "Implementation agent response.",
                    }),
                    resume: () => Effect.void,
                    sessionId: request.implementationSessionId,
                  }),
              }),
              repository,
              worktreeManager: WorktreeManager.of({
                create: () =>
                  Effect.succeed({
                    workingDirectory: root,
                  }),
              }),
            });
          });
          const storeLayer = makeFileStoreLayer(
            LABORER_SLACK_ID,
            runnerPath,
            root
          );

          yield* Effect.scoped(
            Effect.gen(function* () {
              const application = yield* makeApplication;
              const harness = yield* makePrototypeHarness({
                application,
                laborerSlackId: LABORER_SLACK_ID,
                slack,
                storeLayer,
              });
              yield* harness.runner.inject(
                normalizedEvent({
                  authorSlackId: "UASKER",
                  channelId: "CWORK",
                  eventId: "event:reference-partial-failure-root",
                  messageTs: rootTs,
                  text: `<@${LABORER_SLACK_ID}> implement`,
                  workspaceId: "TWORK",
                })
              );
              for (let attempt = 0; attempt < 200; attempt += 1) {
                yield* harness.runner.drain(threadId);
                const event = (yield* harness.store.snapshot).threads[0]
                  ?.applicationEvents[0];
                if (event?.status === "failed") {
                  break;
                }
                yield* Effect.sleep("5 millis");
              }
              const state = yield* harness.store.snapshot;
              assert.strictEqual(
                state.threads[0]?.applicationEvents[0]?.status,
                "failed"
              );
              assert.strictEqual(
                state.conversationStreamTombstones[0]?.terminalReason,
                "failed"
              );
            })
          );

          assert.strictEqual(
            implementationEventRuns,
            1,
            JSON.stringify(implementationEventIds)
          );
          assert.deepStrictEqual(calls, [
            "Visible before signal failure.",
            "Application event failed. See Runner logs.",
          ]);

          yield* Effect.scoped(
            Effect.gen(function* () {
              const application = yield* makeApplication;
              const restarted = yield* makePrototypeHarness({
                application,
                laborerSlackId: LABORER_SLACK_ID,
                slack,
                storeLayer,
              });
              yield* restarted.runner.drain(threadId);
              yield* Effect.sleep("20 millis");
              yield* restarted.runner.drain(threadId);
              assert.strictEqual(
                (yield* restarted.store.snapshot).threads[0]
                  ?.applicationEvents[0]?.status,
                "failed"
              );
            })
          );

          assert.strictEqual(
            implementationEventRuns,
            1,
            JSON.stringify(implementationEventIds)
          );
          assert.deepStrictEqual(calls, [
            "Visible before signal failure.",
            "Application event failed. See Runner logs.",
          ]);
        })
      ),
    10_000
  );

  it.effect(
    "coalesces tiny fallback deltas until the persisted deadline and flushes at the size threshold",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped("laborer-coalesce-");
          const statePath = join(root, "runner.json");
          const threadId = canonicalThreadId(
            "CWORK",
            "1700000003.000001",
            "TWORK"
          );
          const calls: string[] = [];
          const slack: SlackGatewayShape = {
            postThreadMessage: ({ text }) =>
              Effect.sync(() => {
                calls.push(`post:${text}`);
                return { ts: `message-${calls.length}` };
              }),
            readActivationContext: () => Effect.succeed([]),
            updateThreadMessage: ({ text }) =>
              Effect.sync(() => {
                calls.push(`update:${text}`);
              }),
          };
          const context = yield* Layer.build(
            makeFileStoreLayer(LABORER_SLACK_ID, statePath, root)
          );
          const store = yield* PrototypeStore.pipe(Effect.provide(context));
          yield* store.accept(
            normalizedEvent({
              authorSlackId: "UASKER",
              channelId: "CWORK",
              eventId: "event:coalesce",
              messageTs: "1700000003.000001",
              text: `<@${LABORER_SLACK_ID}> stream`,
              workspaceId: "TWORK",
            })
          );
          const owner = yield* claimParticipantOwner(store, threadId);
          const delivery = yield* makeConversationStreamDelivery({
            policy: {
              coalesceCodePoints: 4,
              maxCoalesceMillis: 1000,
              spacingMillis: {
                "fallback-post": 0,
                "fallback-update": 0,
                "native-append": 0,
                "native-start": 0,
                "native-stop": 0,
              },
            },
            slack,
            store,
          });
          const deadlinePublisher = delivery.publisherFor(owner);
          yield* deadlinePublisher.publish(
            ApplicationConversationMessageChunk.make({
              messageId: "deadline-message",
              sequence: 0,
              text: "A",
            })
          );
          yield* Effect.forEach(
            Array.from({ length: 10 }),
            () => Effect.yieldNow,
            { discard: true }
          );
          yield* deadlinePublisher.publish(
            ApplicationConversationMessageChunk.make({
              messageId: "deadline-message",
              sequence: 1,
              text: "b",
            })
          );
          yield* Effect.forEach(
            Array.from({ length: 10 }),
            () => Effect.yieldNow,
            { discard: true }
          );
          assert.deepStrictEqual(calls, ["post:A"]);
          const beforeDeadline = yield* store.snapshot;
          assert.strictEqual(
            beforeDeadline.conversationStreams[0]?.flushDeadlineMillis,
            1000
          );

          yield* TestClock.adjust("999 millis");
          assert.deepStrictEqual(calls, ["post:A"]);
          yield* TestClock.adjust("1 millis");
          yield* delivery.recover;
          yield* Effect.yieldNow;
          const afterDeadline = yield* store.snapshot;
          assert.strictEqual(
            afterDeadline.conversationStreams[0]?.operations.length,
            1
          );
          assert.strictEqual(
            afterDeadline.conversationStreams[0]?.compactedOperationCount,
            1
          );
          assert.deepStrictEqual(calls, ["post:A", "update:Ab"]);

          const thresholdPublisher = delivery.publisherFor(owner);
          yield* thresholdPublisher.publish(
            ApplicationConversationMessageChunk.make({
              messageId: "threshold-message",
              sequence: 0,
              text: "X",
            })
          );
          yield* thresholdPublisher.publish(
            ApplicationConversationMessageChunk.make({
              messageId: "threshold-message",
              sequence: 1,
              text: "1234",
            })
          );
          assert.deepStrictEqual(calls, [
            "post:A",
            "update:Ab",
            "post:X",
            "update:X1234",
          ]);
        })
      )
  );

  it.effect(
    "does not strand a tiny delta published while a scheduled flush releases ownership",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-coalesce-release-race-"
          );
          const statePath = join(root, "runner.json");
          const rootTs = "1700000003.000002";
          const threadId = canonicalThreadId("CWORK", rootTs, "TWORK");
          const calls: string[] = [];
          const scheduledDriveFinished = yield* Deferred.make<void>();
          const scheduledDriveRedriven = yield* Deferred.make<void>();
          const releaseScheduledOwnership = yield* Deferred.make<void>();
          const context = yield* Layer.build(
            makeFileStoreLayer(LABORER_SLACK_ID, statePath, root)
          );
          const store = yield* PrototypeStore.pipe(Effect.provide(context));
          yield* store.accept(
            normalizedEvent({
              authorSlackId: "UASKER",
              channelId: "CWORK",
              eventId: "event:coalesce-release-race",
              messageTs: rootTs,
              text: `<@${LABORER_SLACK_ID}> stream`,
              workspaceId: "TWORK",
            })
          );
          const owner = yield* claimParticipantOwner(store, threadId);
          let scheduledDrives = 0;
          const delivery = yield* makeConversationStreamDelivery({
            policy: {
              ...immediateConversationStreamDeliveryPolicy,
              coalesceCodePoints: 4,
              maxCoalesceMillis: 1000,
            },
            slack: {
              postThreadMessage: ({ text }) =>
                Effect.sync(() => {
                  calls.push(`post:${text}`);
                  return { ts: "coalesce-release-message" };
                }),
              readActivationContext: () => Effect.succeed([]),
              updateThreadMessage: ({ text }) =>
                Effect.sync(() => {
                  calls.push(`update:${text}`);
                }),
            },
            store,
            testHooks: {
              afterScheduledDrive: () =>
                Effect.gen(function* () {
                  scheduledDrives += 1;
                  if (scheduledDrives === 1) {
                    yield* Deferred.succeed(scheduledDriveFinished, undefined);
                    yield* Deferred.await(releaseScheduledOwnership);
                  } else if (scheduledDrives === 2) {
                    yield* Deferred.succeed(scheduledDriveRedriven, undefined);
                  }
                }),
            },
          });
          const publisher = delivery.publisherFor(owner);
          yield* publisher.publish(
            ApplicationConversationMessageChunk.make({
              messageId: "assistant-message",
              sequence: 0,
              text: "A",
            })
          );
          yield* publisher.publish(
            ApplicationConversationMessageChunk.make({
              messageId: "assistant-message",
              sequence: 1,
              text: "b",
            })
          );

          yield* TestClock.adjust("1 second");
          yield* Deferred.await(scheduledDriveFinished);
          assert.deepStrictEqual(calls, ["post:A", "update:Ab"]);
          yield* publisher.publish(
            ApplicationConversationMessageChunk.make({
              messageId: "assistant-message",
              sequence: 2,
              text: "c",
            })
          );
          yield* Deferred.succeed(releaseScheduledOwnership, undefined);
          yield* Effect.yieldNow;
          yield* TestClock.adjust("1 second");
          yield* Deferred.await(scheduledDriveRedriven);

          assert.deepStrictEqual(calls, ["post:A", "update:Ab", "update:Abc"]);
        })
      )
  );

  it.effect(
    "marks a response-lost native start unresolved after restart and never starts duplicate public text",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-native-unresolved-"
          );
          const statePath = join(root, "runner.json");
          const threadId = canonicalThreadId(
            "CWORK",
            "1700000002.000001",
            "TWORK"
          );
          let starts = 0;
          let stops = 0;
          const slack: SlackGatewayShape = {
            nativeStreaming: {
              append: () => Effect.void,
              start: () =>
                Effect.sync(() => {
                  starts += 1;
                  return { ts: "native-1" };
                }),
              stop: () =>
                Effect.sync(() => {
                  stops += 1;
                }),
            },
            postThreadMessage: () => Effect.succeed({ ts: "unused" }),
            readActivationContext: () => Effect.succeed([]),
          };
          const makeStore = Effect.gen(function* () {
            const context = yield* Layer.build(
              makeFileStoreLayer(LABORER_SLACK_ID, statePath, root)
            );
            return yield* PrototypeStore.pipe(Effect.provide(context));
          });
          const firstStore = yield* makeStore;
          yield* firstStore.accept(
            normalizedEvent({
              authorSlackId: "UASKER",
              channelId: "CWORK",
              eventId: "event:native-unresolved",
              messageTs: "1700000002.000001",
              text: `<@${LABORER_SLACK_ID}> stream`,
              workspaceId: "TWORK",
            })
          );
          const owner = yield* claimParticipantOwner(firstStore, threadId);
          const firstDelivery = yield* makeConversationStreamDelivery({
            slack,
            store: firstStore,
            testHooks: {
              afterRequestBeforeOutcomePersisted: () =>
                Effect.die(new Error("simulated process loss")),
            },
          });
          const firstExit = yield* Effect.exit(
            firstDelivery.publisherFor(owner).publish(
              ApplicationConversationMessageChunk.make({
                messageId: "assistant-message",
                sequence: 0,
                text: "No duplicate",
              })
            )
          );
          assert.strictEqual(firstExit._tag, "Failure");
          assert.strictEqual(starts, 1);
          assert.strictEqual(
            (yield* firstStore.snapshot).conversationStreams[0]?.operations[0]
              ?.status,
            "in_flight"
          );

          const restartedStore = yield* makeStore;
          const restartedDelivery = yield* makeConversationStreamDelivery({
            policy: {
              ...immediateConversationStreamDeliveryPolicy,
              maxCoalesceMillis: 0,
            },
            slack,
            store: restartedStore,
          });
          yield* restartedDelivery.recover;
          yield* restartedDelivery.declareOwnerRecoveryUnavailableForThread(
            threadId
          );
          const terminal = yield* waitForTerminalStream(restartedStore);
          assert.strictEqual(starts, 1);
          assert.strictEqual(stops, 0);
          assert.strictEqual(terminal.lifecycle, "unresolved");
          assert.strictEqual(terminal.operations[0]?.status, "unresolved");
        })
      )
  );

  it.effect("never duplicates a fallback post whose response was lost", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDirectoryScoped(
          "laborer-fallback-unresolved-"
        );
        const statePath = join(root, "runner.json");
        const rootTs = "1700000007.000001";
        const threadId = canonicalThreadId("CWORK", rootTs, "TWORK");
        let posts = 0;
        const slack: SlackGatewayShape = {
          postThreadMessage: () =>
            Effect.sync(() => {
              posts += 1;
              return { ts: "fallback-unknown" };
            }),
          readActivationContext: () => Effect.succeed([]),
          updateThreadMessage: () => Effect.void,
        };
        const makeStore = Effect.gen(function* () {
          const context = yield* Layer.build(
            makeFileStoreLayer(LABORER_SLACK_ID, statePath, root)
          );
          return yield* PrototypeStore.pipe(Effect.provide(context));
        });
        const firstStore = yield* makeStore;
        yield* firstStore.accept(
          normalizedEvent({
            authorSlackId: "UASKER",
            channelId: "CWORK",
            eventId: "event:fallback-unresolved",
            messageTs: rootTs,
            text: `<@${LABORER_SLACK_ID}> stream`,
            workspaceId: "TWORK",
          })
        );
        const owner = yield* claimParticipantOwner(firstStore, threadId);
        const firstDelivery = yield* makeConversationStreamDelivery({
          slack,
          store: firstStore,
          testHooks: {
            afterRequestBeforeOutcomePersisted: () =>
              Effect.die(new Error("simulated response loss")),
          },
        });
        yield* Effect.exit(
          firstDelivery.publisherFor(owner).publish(
            ApplicationConversationMessageChunk.make({
              messageId: "assistant-message",
              sequence: 0,
              text: "Exactly once when knowable",
            })
          )
        );
        assert.strictEqual(posts, 1);

        const restartedStore = yield* makeStore;
        const restartedDelivery = yield* makeConversationStreamDelivery({
          slack,
          store: restartedStore,
        });
        yield* restartedDelivery.recover;
        const terminal = yield* waitForTerminalStream(restartedStore);

        assert.strictEqual(posts, 1);
        assert.strictEqual(terminal.lifecycle, "unresolved");
        assert.strictEqual(terminal.operations[0]?.status, "unresolved");
      })
    )
  );

  it.effect(
    "finalizes a stale acknowledged fallback message on restart without replay",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-fallback-stream-"
          );
          const statePath = join(root, "runner.json");
          const threadId = canonicalThreadId(
            "CWORK",
            "1700000001.000001",
            "TWORK"
          );
          const calls: Array<{
            readonly method: "post" | "update";
            readonly text: string;
          }> = [];
          const slack: SlackGatewayShape = {
            postThreadMessage: ({ text }) =>
              Effect.sync(() => {
                calls.push({ method: "post", text });
                return { ts: "message-1" };
              }),
            readActivationContext: () => Effect.succeed([]),
            updateThreadMessage: ({ text }) =>
              Effect.sync(() => {
                calls.push({ method: "update", text });
              }),
          };
          const makeStore = Effect.gen(function* () {
            const context = yield* Layer.build(
              makeFileStoreLayer(LABORER_SLACK_ID, statePath, root)
            );
            return yield* PrototypeStore.pipe(Effect.provide(context));
          });
          const firstStore = yield* makeStore;
          yield* firstStore.accept(
            normalizedEvent({
              authorSlackId: "UASKER",
              channelId: "CWORK",
              eventId: "event:fallback-stream",
              messageTs: "1700000001.000001",
              text: `<@${LABORER_SLACK_ID}> stream`,
              workspaceId: "TWORK",
            })
          );
          const owner = yield* claimParticipantOwner(firstStore, threadId);
          const firstDelivery = yield* makeConversationStreamDelivery({
            slack,
            store: firstStore,
          });
          yield* firstDelivery.publisherFor(owner).publish(
            ApplicationConversationMessageChunk.make({
              messageId: "assistant-message",
              sequence: 0,
              text: "Hello",
            })
          );

          const restartedStore = yield* makeStore;
          const restartedDelivery = yield* makeConversationStreamDelivery({
            policy: {
              ...immediateConversationStreamDeliveryPolicy,
              maxCoalesceMillis: 0,
            },
            slack,
            store: restartedStore,
          });
          yield* restartedDelivery.recover;
          yield* restartedDelivery.declareOwnerRecoveryUnavailableForThread(
            threadId
          );
          const terminal = yield* waitForTerminalStream(restartedStore);

          assert.deepStrictEqual(calls, [{ method: "post", text: "Hello" }]);
          assert.strictEqual(terminal.slackTs, "message-1");
          assert.strictEqual(terminal.lifecycle, "stopped");
          assert.strictEqual(terminal.confirmedOffset, 5);
          assert.strictEqual(terminal.terminalReason, "restart");
        })
      )
  );

  it.effect(
    "isolates durable stream identities and request budgets for workspaces sharing a store",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-stream-workspaces-"
          );
          const statePath = join(root, "runner.json");
          const context = yield* Layer.build(
            makeFileStoreLayer(LABORER_SLACK_ID, statePath, root)
          );
          const store = yield* PrototypeStore.pipe(Effect.provide(context));
          const rootTs = "1700000008.000001";
          const workspaceIds = ["TWORKONE", "TWORKTWO"] as const;
          const owners = new Map<
            string,
            {
              readonly ownerId: string;
              readonly ownerKind: "participant-turn";
              readonly threadId: ReturnType<typeof canonicalThreadId>;
            }
          >();
          for (const workspaceId of workspaceIds) {
            const threadId = canonicalThreadId("CSHARED", rootTs, workspaceId);
            yield* store.accept(
              normalizedEvent({
                authorSlackId: `U${workspaceId}`,
                channelId: "CSHARED",
                eventId: `event:stream:${workspaceId}`,
                messageTs: rootTs,
                text: `<@${LABORER_SLACK_ID}> stream in ${workspaceId}`,
                workspaceId,
              })
            );
            owners.set(
              workspaceId,
              yield* claimParticipantOwner(store, threadId)
            );
          }
          const calls: string[] = [];
          const slack: SlackGatewayShape = {
            nativeStreaming: {
              append: () => Effect.void,
              start: ({ recipientUserId, text }) =>
                Effect.sync(() => {
                  calls.push(`${recipientUserId}:${text}`);
                  return { ts: `stream-${calls.length}` };
                }),
              stop: () => Effect.void,
            },
            postThreadMessage: () => Effect.succeed({ ts: "unused" }),
            readActivationContext: () => Effect.succeed([]),
          };
          const delivery = yield* makeConversationStreamDelivery({
            slack,
            store,
          });
          for (const [sequence, workspaceId] of workspaceIds.entries()) {
            const owner = owners.get(workspaceId);
            assert.ok(owner !== undefined);
            const publisher = delivery.publisherFor(owner);
            yield* publisher.publish(
              ApplicationConversationMessageChunk.make({
                messageId: "assistant-message",
                sequence: 0,
                text: `workspace-${sequence + 1}`,
              })
            );
            yield* publisher.finalize("completed");
          }

          assert.deepStrictEqual(calls, [
            "UTWORKONE:workspace-1",
            "UTWORKTWO:workspace-2",
          ]);
          const state = yield* store.snapshot;
          assert.strictEqual(state.conversationStreamTombstones.length, 2);
          assert.strictEqual(
            new Set(state.conversationStreamTombstones.map(({ id }) => id))
              .size,
            2
          );
          assert.deepStrictEqual(
            state.conversationStreamTombstones.map(
              ({ lifecycle, workspaceId }) => `${workspaceId}:${lifecycle}`
            ),
            ["TWORKONE:stopped", "TWORKTWO:stopped"]
          );
          assert.deepStrictEqual(
            state.conversationStreamRateBudgets.map(
              ({ method, workspaceId }) => `${workspaceId}:${method}`
            ),
            ["TWORKTWO:chat.stopStream"]
          );
        })
      )
  );

  it.live(
    "retries definitely rejected transient appends and stops through their durable operations",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-stream-append-stop-retry-"
          );
          const statePath = join(root, "runner.json");
          const rootTs = "1700000009.000001";
          const threadId = canonicalThreadId("CWORK", rootTs, "TWORK");
          const context = yield* Layer.build(
            makeFileStoreLayer(LABORER_SLACK_ID, statePath, root)
          );
          const store = yield* PrototypeStore.pipe(Effect.provide(context));
          yield* store.accept(
            normalizedEvent({
              authorSlackId: "UASKER",
              channelId: "CWORK",
              eventId: "event:append-stop-retry",
              messageTs: rootTs,
              text: `<@${LABORER_SLACK_ID}> retry stream operations`,
              workspaceId: "TWORK",
            })
          );
          const owner = yield* claimParticipantOwner(store, threadId);
          let appendAttempts = 0;
          let stopAttempts = 0;
          const rejectedTransient = (): DeliveryError =>
            DeliveryError.make({
              category: "ratelimited",
              disposition: "transient",
              outcomeCertainty: "definitely-rejected",
              retryAfterMillis: 0,
            });
          const slack: SlackGatewayShape = {
            nativeStreaming: {
              append: () =>
                Effect.suspend(() => {
                  appendAttempts += 1;
                  return appendAttempts === 1
                    ? rejectedTransient()
                    : Effect.void;
                }),
              start: () => Effect.succeed({ ts: "retry-stream" }),
              stop: () =>
                Effect.suspend(() => {
                  stopAttempts += 1;
                  return stopAttempts === 1 ? rejectedTransient() : Effect.void;
                }),
            },
            postThreadMessage: () => Effect.succeed({ ts: "unused" }),
            readActivationContext: () => Effect.succeed([]),
          };
          const delivery = yield* makeConversationStreamDelivery({
            slack,
            store,
          });
          const publisher = delivery.publisherFor(owner);
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

          assert.strictEqual(appendAttempts, 2);
          assert.strictEqual(stopAttempts, 2);
          const stream = (yield* store.snapshot)
            .conversationStreamTombstones[0];
          assert.strictEqual(stream?.lifecycle, "stopped");
          assert.deepStrictEqual(
            stream?.operations.map(({ attempt, kind, status }) => ({
              attempt,
              kind,
              status,
            })),
            [{ attempt: 2, kind: "native-stop", status: "acknowledged" }]
          );
          assert.ok(
            stream?.operations.every(
              ({ payloadHash }) => payloadHash.length > 0
            )
          );
        })
      )
  );

  it.effect(
    "retains redacted evidence for a definitely rejected terminal operation",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-stream-rejected-evidence-"
          );
          const statePath = join(root, "runner.json");
          const rootTs = "1700000010.000001";
          const threadId = canonicalThreadId("CWORK", rootTs, "TWORK");
          const context = yield* Layer.build(
            makeFileStoreLayer(LABORER_SLACK_ID, statePath, root)
          );
          const store = yield* PrototypeStore.pipe(Effect.provide(context));
          yield* store.accept(
            normalizedEvent({
              authorSlackId: "UASKER",
              channelId: "CWORK",
              eventId: "event:rejected-stream-evidence",
              messageTs: rootTs,
              text: `<@${LABORER_SLACK_ID}> reject stream`,
              workspaceId: "TWORK",
            })
          );
          const owner = yield* claimParticipantOwner(store, threadId);
          const slack: SlackGatewayShape = {
            nativeStreaming: {
              append: () => Effect.void,
              start: () =>
                DeliveryError.make({
                  category: "invalid_auth",
                  disposition: "destination-permanent",
                  outcomeCertainty: "definitely-rejected",
                  retryAfterMillis: 0,
                }),
              stop: () => Effect.void,
            },
            postThreadMessage: () => Effect.succeed({ ts: "unused" }),
            readActivationContext: () => Effect.succeed([]),
          };
          const delivery = yield* makeConversationStreamDelivery({
            policy: immediateConversationStreamDeliveryPolicy,
            slack,
            store,
          });
          const result = yield* Effect.result(
            delivery.publisherFor(owner).publish(
              ApplicationConversationMessageChunk.make({
                messageId: "assistant-message",
                sequence: 0,
                text: "Sensitive partial text",
              })
            )
          );
          assert.strictEqual(result._tag, "Failure");
          const state = yield* store.snapshot;
          assert.strictEqual(state.conversationStreams.length, 0);
          const tombstone = state.conversationStreamTombstones[0];
          assert.strictEqual(tombstone?.lifecycle, "unresolved");
          assert.deepStrictEqual(
            tombstone?.operations.map(
              ({ errorCategory, errorCertainty, kind, status }) => ({
                errorCategory,
                errorCertainty,
                kind,
                status,
              })
            ),
            [
              {
                errorCategory: "invalid_auth",
                errorCertainty: "definitely-rejected",
                kind: "native-start",
                status: "rejected",
              },
            ]
          );
          assert.strictEqual(
            JSON.stringify(tombstone).includes("Sensitive partial text"),
            false
          );
        })
      )
  );

  for (const stoppedOperation of ["native-append", "native-stop"] as const) {
    it.live(
      `persists ${stoppedOperation} stopped_by_user and makes restart a no-op`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const root = yield* makeTempDirectoryScoped(
              `laborer-stream-${stoppedOperation}-stopped-by-user-`
            );
            const statePath = join(root, "runner.json");
            const rootTs =
              stoppedOperation === "native-append"
                ? "1700000011.000001"
                : "1700000011.000002";
            const threadId = canonicalThreadId("CWORK", rootTs, "TWORK");
            let starts = 0;
            let appends = 0;
            let stops = 0;
            let updates = 0;
            let completionReactions = 0;
            let visibleText = "";
            const notices: string[] = [];
            const stoppedByUser = (): DeliveryError =>
              DeliveryError.make({
                category: "stopped_by_user",
                disposition: "item-permanent",
                outcomeCertainty: "definitely-rejected",
                retryAfterMillis: 0,
              });
            const slack: SlackGatewayShape = {
              nativeStreaming: {
                append: () => {
                  appends += 1;
                  return stoppedOperation === "native-append"
                    ? stoppedByUser()
                    : Effect.void;
                },
                start: ({ text }) =>
                  Effect.sync(() => {
                    starts += 1;
                    visibleText = text;
                    return { ts: `${stoppedOperation}-stream` };
                  }),
                stop: () => {
                  stops += 1;
                  return stoppedOperation === "native-stop"
                    ? stoppedByUser()
                    : Effect.void;
                },
              },
              postThreadMessage: ({ text }) =>
                Effect.sync(() => {
                  notices.push(text);
                  return { ts: `notice-${notices.length}` };
                }),
              readActivationContext: () => Effect.succeed([]),
              updateThreadMessage: () =>
                Effect.sync(() => {
                  updates += 1;
                }),
            };
            const storeLayer = makeFileStoreLayer(
              LABORER_SLACK_ID,
              statePath,
              root
            );
            const application: ApplicationShape = {
              handle: (event, publish) =>
                event._tag === "ParticipantInput"
                  ? Effect.gen(function* () {
                      yield* publish(
                        ApplicationConversationMessageChunk.make({
                          messageId: "assistant-message",
                          sequence: 0,
                          text: "Hello",
                        })
                      );
                      if (stoppedOperation === "native-append") {
                        yield* publish(
                          ApplicationConversationMessageChunk.make({
                            messageId: "assistant-message",
                            sequence: 1,
                            text: " world",
                          })
                        );
                      }
                    })
                  : Effect.void,
            };
            const harness = yield* makePrototypeHarness({
              application,
              completionReactor: {
                react: () =>
                  Effect.sync(() => {
                    completionReactions += 1;
                  }),
              },
              laborerSlackId: LABORER_SLACK_ID,
              slack,
              storeLayer,
            });
            yield* harness.runner.inject(
              normalizedEvent({
                authorSlackId: "UASKER",
                channelId: "CWORK",
                eventId: `event:${stoppedOperation}:stopped-by-user`,
                messageTs: rootTs,
                text: `<@${LABORER_SLACK_ID}> stream`,
                workspaceId: "TWORK",
              })
            );
            let state = yield* harness.store.snapshot;
            for (let attempt = 0; attempt < 500; attempt += 1) {
              const turn = state.threads[0]?.turns[0];
              const expectedTurnStatus =
                stoppedOperation === "native-stop" ? "completed" : "failed";
              const reactionSettled =
                stoppedOperation === "native-stop"
                  ? completionReactions === 1
                  : completionReactions === 0;
              if (
                turn?.status === expectedTurnStatus &&
                state.conversationStreamTombstones.length === 1 &&
                reactionSettled
              ) {
                break;
              }
              yield* Effect.sleep("5 millis");
              state = yield* harness.store.snapshot;
            }

            const turn = state.threads[0]?.turns[0];
            const tombstone = state.conversationStreamTombstones[0];
            assert.strictEqual(state.conversationStreams.length, 0);
            assert.strictEqual(tombstone?.lifecycle, "stopped");
            assert.strictEqual(tombstone?.terminalReason, "stopped_by_user");
            assert.deepStrictEqual(
              tombstone?.operations.map(
                ({ attempt, errorCategory, kind, status }) => ({
                  attempt,
                  errorCategory,
                  kind,
                  status,
                })
              ),
              [
                {
                  attempt: 1,
                  errorCategory: "stopped_by_user",
                  kind: stoppedOperation,
                  status: "stopped_by_user",
                },
              ]
            );
            assert.strictEqual(tombstone?.confirmedOffset, 5);
            assert.strictEqual(
              tombstone?.confirmedHash,
              createHash("sha256").update("Hello").digest("hex")
            );
            assert.strictEqual(
              tombstone?.cumulativeHash,
              createHash("sha256")
                .update(
                  stoppedOperation === "native-append" ? "Hello world" : "Hello"
                )
                .digest("hex")
            );
            assert.strictEqual(updates, 0);
            assert.strictEqual(visibleText, "Hello");
            assert.strictEqual(starts, 1);
            assert.strictEqual(
              appends,
              stoppedOperation === "native-append" ? 1 : 0
            );
            assert.strictEqual(
              stops,
              stoppedOperation === "native-stop" ? 1 : 0
            );
            assert.strictEqual(
              turn?.status,
              stoppedOperation === "native-stop" ? "completed" : "failed"
            );
            assert.strictEqual(
              turn?.outcome?.kind,
              stoppedOperation === "native-stop" ? "success" : "failure"
            );
            assert.strictEqual(
              completionReactions,
              stoppedOperation === "native-stop" ? 1 : 0
            );
            assert.deepStrictEqual(
              notices,
              stoppedOperation === "native-append"
                ? [
                    "This conversation turn could not be completed. Please try again.",
                  ]
                : []
            );

            const callsBeforeRestart = {
              appends,
              completionReactions,
              notices: notices.length,
              starts,
              stops,
              updates,
            };
            yield* Effect.scoped(
              Effect.gen(function* () {
                const restarted = yield* makePrototypeHarness({
                  application: {
                    handle: () =>
                      Effect.die(
                        new Error("terminal user-stopped owner replayed")
                      ),
                  },
                  completionReactor: {
                    react: () =>
                      Effect.sync(() => {
                        completionReactions += 1;
                      }),
                  },
                  laborerSlackId: LABORER_SLACK_ID,
                  slack,
                  storeLayer,
                });
                yield* restarted.runner.drain(threadId);
                yield* Effect.sleep("20 millis");
              })
            );
            assert.deepStrictEqual(
              {
                appends,
                completionReactions,
                notices: notices.length,
                starts,
                stops,
                updates,
              },
              callsBeforeRestart
            );
          })
        ),
      10_000
    );
  }
});
