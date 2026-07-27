import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Clock, Deferred, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import {
  ApplicationConversationMessageChunk,
  ApplicationPublicReply,
} from "../src/application.ts";
import {
  type ConversationStreamDeliveryPolicy,
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
  makeInMemoryStoreLayer,
  PrototypeStore,
  type PrototypeStoreShape,
} from "../src/prototype/store.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

const policy = (spacing: Partial<Record<string, number>> = {}) =>
  ({
    coalesceCodePoints: 1,
    maxCoalesceMillis: 1000,
    spacingMillis: {
      "fallback-post": spacing["fallback-post"] ?? 0,
      "fallback-update": spacing["fallback-update"] ?? 0,
      "native-append": spacing["native-append"] ?? 0,
      "native-start": spacing["native-start"] ?? 0,
      "native-stop": spacing["native-stop"] ?? 0,
    },
  }) satisfies ConversationStreamDeliveryPolicy;

const createOwner = Effect.fnUntraced(function* (options: {
  readonly channelId: string;
  readonly eventId: string;
  readonly rootTs: string;
  readonly store: PrototypeStoreShape;
  readonly workspaceId: string;
}) {
  const threadId = canonicalThreadId(
    options.channelId,
    options.rootTs,
    options.workspaceId
  );
  yield* options.store.accept(
    normalizedEvent({
      authorSlackId: `U${options.channelId}`,
      channelId: options.channelId,
      eventId: options.eventId,
      messageTs: options.rootTs,
      text: `<@${LABORER_SLACK_ID}> stream`,
      workspaceId: options.workspaceId,
    })
  );
  yield* options.store.completeContext(threadId, [], false);
  const turn = yield* options.store.claimNextTurn(threadId);
  assert.ok(turn !== null);
  return {
    ownerId: turn.id,
    ownerKind: "participant-turn" as const,
    threadId,
  };
});

describe("Conversation stream Slack quota coordination", () => {
  it.effect("does not hold an unrelated stream behind a slow request", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(
          makeInMemoryStoreLayer(LABORER_SLACK_ID)
        );
        const store = yield* PrototypeStore.pipe(Effect.provide(context));
        const ownerA = yield* createOwner({
          channelId: "CSLOW",
          eventId: "event:slow",
          rootTs: "251.100",
          store,
          workspaceId: "TQUOTA",
        });
        const ownerB = yield* createOwner({
          channelId: "CFAST",
          eventId: "event:fast",
          rootTs: "251.200",
          store,
          workspaceId: "TQUOTA",
        });
        const appendStarted = yield* Deferred.make<void>();
        const releaseAppend = yield* Deferred.make<void>();
        const calls: string[] = [];
        const slack: SlackGatewayShape = {
          nativeStreaming: {
            append: ({ streamTs }) =>
              streamTs === "stream-slow"
                ? Deferred.succeed(appendStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseAppend))
                  )
                : Effect.void,
            start: ({ channelId }) =>
              Effect.sync(() => {
                calls.push(`start:${channelId}`);
                return {
                  ts: channelId === "CSLOW" ? "stream-slow" : "stream-fast",
                };
              }),
            stop: () => Effect.void,
          },
          postThreadMessage: () => Effect.succeed({ ts: "unused" }),
          readActivationContext: () => Effect.succeed([]),
        };
        const delivery = yield* makeConversationStreamDelivery({
          policy: policy(),
          slack,
          store,
        });
        const slowPublisher = delivery.publisherFor(ownerA);
        yield* slowPublisher.publish(
          ApplicationConversationMessageChunk.make({
            messageId: "slow-message",
            sequence: 0,
            text: "slow",
          })
        );
        const blockedAppend = yield* slowPublisher
          .publish(
            ApplicationConversationMessageChunk.make({
              messageId: "slow-message",
              sequence: 1,
              text: " append",
            })
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(appendStarted);

        yield* delivery.publisherFor(ownerB).publish(
          ApplicationConversationMessageChunk.make({
            messageId: "fast-message",
            sequence: 0,
            text: "fast",
          })
        );
        assert.deepStrictEqual(calls, ["start:CSLOW", "start:CFAST"]);
        yield* Deferred.succeed(releaseAppend, undefined);
        yield* Fiber.join(blockedAppend);
      })
    )
  );

  it.effect(
    "schedules an eligible restart stream while another stream waits on durable Retry-After",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            makeInMemoryStoreLayer(LABORER_SLACK_ID)
          );
          const store = yield* PrototypeStore.pipe(Effect.provide(context));
          const slowOwner = yield* createOwner({
            channelId: "CRESTARTSLOW",
            eventId: "event:restart:slow",
            rootTs: "251.250",
            store,
            workspaceId: "TQUOTA",
          });
          const fastOwner = yield* createOwner({
            channelId: "CRESTARTFAST",
            eventId: "event:restart:fast",
            rootTs: "251.260",
            store,
            workspaceId: "TQUOTA",
          });
          const slowStart = yield* store.acceptConversationStreamChunk({
            messageId: "slow-message",
            nowMillis: 0,
            ownerId: slowOwner.ownerId,
            ownerKind: slowOwner.ownerKind,
            sequence: null,
            text: "A",
            threadId: slowOwner.threadId,
          });
          assert.strictEqual(slowStart._tag, "Accepted");
          yield* store.configureConversationStream({
            flushDeadlineMillis: null,
            mode: "native",
            streamId: slowStart.streamId,
          });
          const startOperation =
            yield* store.prepareConversationStreamOperation({
              kind: "native-start",
              nowMillis: 0,
              payloadEndOffset: 1,
              payloadStartOffset: 0,
              payloadText: "A",
              streamId: slowStart.streamId,
            });
          assert.strictEqual(startOperation._tag, "Prepared");
          if (startOperation._tag !== "Prepared") {
            return;
          }
          yield* store.markConversationStreamOperationInFlight(
            startOperation.operation.id,
            0
          );
          yield* store.settleConversationStreamOperation({
            category: null,
            certainty: null,
            nowMillis: 0,
            operationId: startOperation.operation.id,
            outcome: "acknowledged",
            retryAtMillis: null,
            slackTs: "slow-stream",
          });
          yield* store.acceptConversationStreamChunk({
            messageId: "slow-message",
            nowMillis: 0,
            ownerId: slowOwner.ownerId,
            ownerKind: slowOwner.ownerKind,
            sequence: null,
            text: "B",
            threadId: slowOwner.threadId,
          });
          const appendOperation =
            yield* store.prepareConversationStreamOperation({
              kind: "native-append",
              nowMillis: 0,
              payloadEndOffset: 2,
              payloadStartOffset: 1,
              payloadText: "B",
              streamId: slowStart.streamId,
            });
          assert.strictEqual(appendOperation._tag, "Prepared");
          if (appendOperation._tag !== "Prepared") {
            return;
          }
          yield* store.markConversationStreamOperationInFlight(
            appendOperation.operation.id,
            0
          );
          yield* store.settleConversationStreamOperation({
            category: "ratelimited",
            certainty: "definitely-rejected",
            nowMillis: 0,
            operationId: appendOperation.operation.id,
            outcome: "retry",
            retryAtMillis: 5000,
            slackTs: null,
          });

          const fastStart = yield* store.acceptConversationStreamChunk({
            messageId: "fast-message",
            nowMillis: 0,
            ownerId: fastOwner.ownerId,
            ownerKind: fastOwner.ownerKind,
            sequence: null,
            text: "fast",
            threadId: fastOwner.threadId,
          });
          assert.strictEqual(fastStart._tag, "Accepted");
          yield* store.configureConversationStream({
            flushDeadlineMillis: null,
            mode: "native",
            streamId: fastStart.streamId,
          });

          const calls: string[] = [];
          const slack: SlackGatewayShape = {
            nativeStreaming: {
              append: ({ streamTs }) =>
                Effect.sync(() => {
                  calls.push(`append:${streamTs}`);
                }),
              start: ({ channelId }) =>
                Effect.sync(() => {
                  calls.push(`start:${channelId}`);
                  return { ts: "fast-stream" };
                }),
              stop: ({ streamTs }) =>
                Effect.sync(() => {
                  calls.push(`stop:${streamTs}`);
                }),
            },
            postThreadMessage: () => Effect.succeed({ ts: "unused" }),
            readActivationContext: () => Effect.succeed([]),
          };
          const delivery = yield* makeConversationStreamDelivery({
            policy: { ...policy(), maxCoalesceMillis: 0 },
            slack,
            store,
          });
          yield* delivery.recover;
          const slowUnavailable = yield* delivery
            .signalOwnerRecovery(slowOwner, "unavailable")
            .pipe(Effect.forkChild);
          const fastPublisher = delivery.publisherFor(fastOwner);
          yield* fastPublisher.publish(
            ApplicationConversationMessageChunk.make({
              messageId: "fast-message",
              text: "fast",
            })
          );
          yield* fastPublisher.finalize("completed");
          assert.deepStrictEqual(calls, [
            "start:CRESTARTFAST",
            "stop:fast-stream",
          ]);

          yield* TestClock.adjust("4999 millis");
          assert.strictEqual(calls.includes("append:slow-stream"), false);
          yield* TestClock.adjust("1 millis");
          yield* Fiber.join(slowUnavailable);
          for (
            let attempt = 0;
            attempt < 20 && calls.length < 4;
            attempt += 1
          ) {
            yield* Effect.yieldNow;
          }
          assert.deepStrictEqual(calls.slice(2), [
            "append:slow-stream",
            "stop:slow-stream",
          ]);
        })
      )
  );

  it.effect(
    "shares native method Retry-After across channels and restart",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-stream-shared-retry-after-"
          );
          const statePath = join(root, "runner.json");
          const makeStore = Effect.gen(function* () {
            const context = yield* Layer.build(
              makeFileStoreLayer(LABORER_SLACK_ID, statePath, root)
            );
            return yield* PrototypeStore.pipe(Effect.provide(context));
          });
          const firstStore = yield* makeStore;
          const ownerA = yield* createOwner({
            channelId: "CRATEA",
            eventId: "event:rate:a",
            rootTs: "251.300",
            store: firstStore,
            workspaceId: "TQUOTA",
          });
          const ownerB = yield* createOwner({
            channelId: "CRATEB",
            eventId: "event:rate:b",
            rootTs: "251.400",
            store: firstStore,
            workspaceId: "TQUOTA",
          });
          const firstRejected = yield* Deferred.make<void>();
          const retrySettled = yield* Deferred.make<void>();
          const starts: Array<{
            readonly channelId: string;
            readonly time: number;
          }> = [];
          let rejectFirst = true;
          const slack: SlackGatewayShape = {
            nativeStreaming: {
              append: () => Effect.void,
              start: ({ channelId }) =>
                Effect.gen(function* () {
                  starts.push({
                    channelId,
                    time: yield* Clock.currentTimeMillis,
                  });
                  if (rejectFirst) {
                    rejectFirst = false;
                    yield* Deferred.succeed(firstRejected, undefined);
                    return yield* DeliveryError.make({
                      category: "ratelimited",
                      disposition: "transient",
                      outcomeCertainty: "definitely-rejected",
                      retryAfterMillis: 5000,
                    });
                  }
                  return { ts: `stream-${channelId}` };
                }),
              stop: () => Effect.void,
            },
            postThreadMessage: () => Effect.succeed({ ts: "unused" }),
            readActivationContext: () => Effect.succeed([]),
          };
          const firstDelivery = yield* makeConversationStreamDelivery({
            policy: policy({ "native-start": 1000 }),
            slack,
            store: firstStore,
            testHooks: {
              afterOperationSettled: (operation) =>
                operation.kind === "native-start"
                  ? Deferred.succeed(retrySettled, undefined).pipe(
                      Effect.asVoid
                    )
                  : Effect.void,
            },
          });
          const firstPublish = yield* firstDelivery
            .publisherFor(ownerA)
            .publish(
              ApplicationConversationMessageChunk.make({
                messageId: "rate-a",
                sequence: 0,
                text: "A",
              })
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(firstRejected);
          yield* Deferred.await(retrySettled);
          const retryPersisted =
            (yield* firstStore.snapshot).conversationStreams.some((stream) =>
              stream.operations.some(
                (operation) => operation.status === "retry"
              )
            );
          assert.ok(retryPersisted);
          yield* Fiber.interrupt(firstPublish);

          const restartedStore = yield* makeStore;
          const restartedDelivery = yield* makeConversationStreamDelivery({
            policy: policy({ "native-start": 1000 }),
            slack,
            store: restartedStore,
          });
          const secondPublish = yield* restartedDelivery
            .publisherFor(ownerB)
            .publish(
              ApplicationConversationMessageChunk.make({
                messageId: "rate-b",
                sequence: 0,
                text: "B",
              })
            )
            .pipe(Effect.forkChild);
          yield* TestClock.adjust("4999 millis");
          assert.strictEqual(starts.length, 1);
          yield* TestClock.adjust("1 millis");
          yield* Fiber.join(secondPublish);
          assert.deepStrictEqual(starts, [
            { channelId: "CRATEA", time: 0 },
            { channelId: "CRATEB", time: 5000 },
          ]);
          const methodBudget =
            (yield* restartedStore.snapshot).conversationStreamRateBudgets.find(
              (budget) =>
                budget.method === "chat.startStream" &&
                budget.scope === "method"
            );
          assert.strictEqual(methodBudget?.channelId, null);
          assert.strictEqual(methodBudget?.nextAvailableAtMillis, 6000);
        })
      )
  );

  it.effect(
    "keeps fallback post method and channel quotas bounded beyond 22 channels",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            makeInMemoryStoreLayer(LABORER_SLACK_ID)
          );
          const store = yield* PrototypeStore.pipe(Effect.provide(context));
          const owners: Array<{
            readonly ownerId: string;
            readonly ownerKind: "participant-turn";
            readonly threadId: ReturnType<typeof canonicalThreadId>;
          }> = [];
          for (let index = 0; index < 30; index += 1) {
            owners.push(
              yield* createOwner({
                channelId: `CPOST${index}`,
                eventId: `event:post:${index}`,
                rootTs: `252.${index}`,
                store,
                workspaceId: "TPOST",
              })
            );
          }
          let posts = 0;
          const slack: SlackGatewayShape = {
            postThreadMessage: () =>
              Effect.sync(() => {
                posts += 1;
                return { ts: `post-${posts}` };
              }),
            readActivationContext: () => Effect.succeed([]),
            updateThreadMessage: () => Effect.void,
          };
          const delivery = yield* makeConversationStreamDelivery({
            policy: policy({ "fallback-post": 1000 }),
            slack,
            store,
          });
          for (const [index, owner] of owners.entries()) {
            if (index > 0) {
              yield* TestClock.adjust("1000 millis");
            }
            yield* delivery.publisherFor(owner).publish(
              ApplicationConversationMessageChunk.make({
                messageId: `post-message-${index}`,
                sequence: 0,
                text: `${index}`,
              })
            );
          }
          assert.strictEqual(posts, 30);
          const budgets = (yield* store.snapshot).conversationStreamRateBudgets;
          assert.deepStrictEqual(
            budgets.map(({ channelId, scope }) => ({ channelId, scope })),
            [
              { channelId: null, scope: "method" },
              { channelId: "CPOST29", scope: "channel" },
            ]
          );
        })
      ),
    10_000
  );

  it.effect(
    "shares postMessage quota between fallback streams, failure notices, and public replies in both directions",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const failureCalls: Array<{
            readonly text: string;
            readonly time: number;
          }> = [];
          const firstFailureCall = yield* Deferred.make<void>();
          const failureSlack: SlackGatewayShape = {
            conversationStreamDeliveryPolicy: policy({ "fallback-post": 1000 }),
            postThreadMessage: ({ text }) =>
              Effect.gen(function* () {
                failureCalls.push({
                  text,
                  time: yield* Clock.currentTimeMillis,
                });
                if (failureCalls.length === 1) {
                  yield* Deferred.succeed(firstFailureCall, undefined);
                }
                return { ts: `failure-${failureCalls.length}` };
              }),
            readActivationContext: () => Effect.succeed([]),
            updateThreadMessage: () => Effect.void,
          };
          const failureHarness = yield* makePrototypeHarness({
            application: {
              handle: (event, publish) =>
                event._tag === "ParticipantInput"
                  ? publish(
                      ApplicationConversationMessageChunk.make({
                        messageId: "partial-before-failure",
                        sequence: 0,
                        text: "Partial response.",
                      })
                    ).pipe(
                      Effect.andThen(
                        HandlerFailure.make({
                          category: "signal",
                          safeDetail: null,
                        })
                      )
                    )
                  : Effect.void,
            },
            laborerSlackId: LABORER_SLACK_ID,
            slack: failureSlack,
          });
          const failureFiber = yield* failureHarness.runner
            .inject(
              normalizedEvent({
                authorSlackId: "UQUOTA",
                channelId: "CSHAREDPOST",
                eventId: "event:quota:stream-before-failure",
                messageTs: "252.100",
                text: `<@${LABORER_SLACK_ID}> fail after partial`,
                workspaceId: "TQUOTA",
              })
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(firstFailureCall);
          assert.deepStrictEqual(failureCalls, [
            { text: "Partial response.", time: 0 },
          ]);
          yield* TestClock.adjust("999 millis");
          assert.strictEqual(failureCalls.length, 1);
          yield* TestClock.adjust("1 millis");
          yield* Fiber.join(failureFiber);
          assert.deepStrictEqual(failureCalls, [
            { text: "Partial response.", time: 0 },
            {
              text: "This conversation turn could not be completed. Please try again.",
              time: 1000,
            },
          ]);

          const replyCalls: Array<{
            readonly text: string;
            readonly time: number;
          }> = [];
          const replySlack: SlackGatewayShape = {
            conversationStreamDeliveryPolicy: policy({ "fallback-post": 1000 }),
            postThreadMessage: ({ text }) =>
              Effect.gen(function* () {
                replyCalls.push({
                  text,
                  time: yield* Clock.currentTimeMillis,
                });
                return { ts: `reply-${replyCalls.length}` };
              }),
            readActivationContext: () => Effect.succeed([]),
            updateThreadMessage: () => Effect.void,
          };
          const replyHarness = yield* makePrototypeHarness({
            application: {
              handle: (event, publish) => {
                if (event._tag !== "ParticipantInput") {
                  return Effect.void;
                }
                const text = event.messages.at(-1)?.text ?? "";
                return text.includes("public first")
                  ? publish(
                      ApplicationPublicReply.make({
                        replyId: "public-first",
                        text: "Public first.",
                      })
                    )
                  : publish(
                      ApplicationConversationMessageChunk.make({
                        messageId: "stream-second",
                        sequence: 0,
                        text: "Stream second.",
                      })
                    );
              },
            },
            laborerSlackId: LABORER_SLACK_ID,
            slack: replySlack,
          });
          yield* replyHarness.runner.inject(
            normalizedEvent({
              authorSlackId: "UQUOTA",
              channelId: "CSHAREDPOST",
              eventId: "event:quota:public-first",
              messageTs: "252.200",
              text: `<@${LABORER_SLACK_ID}> public first`,
              workspaceId: "TQUOTA",
            })
          );
          assert.deepStrictEqual(replyCalls, [
            { text: "Public first.", time: 1000 },
          ]);
          const streamFiber = yield* replyHarness.runner
            .inject(
              normalizedEvent({
                authorSlackId: "UQUOTA",
                channelId: "CSHAREDPOST",
                eventId: "event:quota:stream-second",
                messageTs: "252.300",
                text: `<@${LABORER_SLACK_ID}> stream second`,
                workspaceId: "TQUOTA",
              })
            )
            .pipe(Effect.forkChild);
          yield* TestClock.adjust("999 millis");
          assert.strictEqual(replyCalls.length, 1);
          yield* TestClock.adjust("1 millis");
          yield* Fiber.join(streamFiber);
          assert.deepStrictEqual(replyCalls, [
            { text: "Public first.", time: 1000 },
            { text: "Stream second.", time: 2000 },
          ]);
        })
      )
  );
});
