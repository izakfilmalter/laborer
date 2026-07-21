/** Adversarial behavioral proof for the THROWAWAY issue #204 prototype. */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import {
  Effect,
  Array as EffectArray,
  Fiber,
  Layer,
  pipe,
  Ref,
  Result,
} from "effect";
import {
  NormalizedMessage,
  stableMessageId,
  ThreadId,
  type WorkThreadState,
} from "../src/prototype/domain.ts";
import {
  type EmulatedSlackFixture,
  normalizeSlackHistoryMessage,
  startEmulatedSlack,
} from "../src/prototype/emulated-slack.ts";
import { ContextReadError, DeliveryError } from "../src/prototype/errors.ts";
import {
  fixtureHandlerOptions,
  makeProcessHandler,
} from "../src/prototype/process-handler.ts";
import {
  makePrototypeHarness,
  type PrototypeHarness,
  type SlackGatewayShape,
  type WorkHandlerShape,
} from "../src/prototype/runtime.ts";
import {
  LABORER_SLACK_ID,
  normalizedEvent,
  postHumanMessage,
  runTracerScenario,
  timestampOf,
} from "../src/prototype/scenario.ts";
import { makeFileStoreLayer } from "../src/prototype/store.ts";

const projectRoot = process.cwd();

const onlyThread = (threads: readonly WorkThreadState[]): WorkThreadState => {
  assert.strictEqual(threads.length, 1);
  const thread = threads[0];
  assert.ok(thread);
  return thread;
};

const messageTexts = (
  messages: readonly Record<string, unknown>[]
): readonly string[] =>
  pipe(
    messages,
    EffectArray.filterMap((message) =>
      typeof message.text === "string"
        ? Result.succeed(message.text)
        : Result.failVoid
    )
  );

const makeSystem = Effect.fnUntraced(function* () {
  const fixture = yield* startEmulatedSlack({ pageSize: 2 });
  const processHandler = yield* makeProcessHandler(
    fixtureHandlerOptions(projectRoot)
  );
  const harness = yield* makePrototypeHarness({
    handler: processHandler.handler,
    laborerSlackId: LABORER_SLACK_ID,
    slack: fixture.gateway,
  });
  return { fixture, harness, processHandler };
});

const activate = Effect.fnUntraced(function* (
  fixture: EmulatedSlackFixture,
  harness: PrototypeHarness,
  suffix: string,
  text: string,
  channelId = fixture.channelId,
  channelKind: "public" | "private" = "public"
) {
  const posted = yield* postHumanMessage(fixture, text, { channelId });
  const ts = timestampOf(posted);
  yield* harness.runner.inject(
    normalizedEvent({
      authorSlackId: fixture.humanUserId,
      channelId,
      channelKind,
      eventId: `event:${suffix}`,
      messageTs: ts,
      text,
    })
  );
  return ts;
});

describe("issue #204 store-driven tracer", () => {
  it.live(
    "serializes FIFO turns through fresh processes and posts only as the bound bot",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { fixture, harness, processHandler } = yield* makeSystem();
          const scenario = yield* runTracerScenario({ fixture, harness });
          const state = scenario.state;
          const thread = onlyThread(state.threads);
          const evidence = yield* processHandler.snapshot;

          assert.strictEqual(thread.rootTs, scenario.activationRootTs);
          assert.deepStrictEqual(
            pipe(
              thread.turns,
              EffectArray.map((turn) => ({
                id: turn.id,
                inputs: pipe(
                  turn.messages,
                  EffectArray.map((message) => message.text)
                ),
                attempts: turn.attempts.length,
                status: turn.status,
              }))
            ),
            [
              {
                id: `turn:${fixture.channelId}:${scenario.activationRootTs}`,
                inputs: [`<@${LABORER_SLACK_ID}> write a tiny essay`],
                attempts: 1,
                status: "completed",
              },
              {
                id: thread.turns[1]?.id,
                inputs: ["Make it shorter [fixture:delay=50]"],
                attempts: 1,
                status: "completed",
              },
              {
                id: thread.turns[2]?.id,
                inputs: ["Add a title"],
                attempts: 1,
                status: "completed",
              },
            ]
          );
          assert.deepStrictEqual(
            evidence.invocations.map((invocation) => invocation.inputTexts),
            [
              [`<@${LABORER_SLACK_ID}> write a tiny essay`],
              ["Make it shorter [fixture:delay=50]"],
              ["Add a title"],
            ]
          );
          assert.strictEqual(evidence.maximumThreadConcurrency[thread.id], 1);
          assert.deepStrictEqual(evidence.invocations[0]?.contextTexts, [
            "Context: the essay should be about local tools.",
            "Ordinary channel conversation",
          ]);
          assert.deepStrictEqual(evidence.invocations[1]?.contextTexts, []);
          assert.ok(
            evidence.internalStderr.every((text) =>
              text.includes("SECRET internal diagnostics")
            )
          );

          const publicMessages = scenario.threadMessages.filter((message) =>
            typeof message.text === "string"
              ? message.text.startsWith("[PUBLIC ")
              : false
          );
          assert.strictEqual(publicMessages.length, 3);
          for (const message of publicMessages) {
            assert.strictEqual(message.user, fixture.botUserId);
            // Emulate authenticates the configured bot user but omits bot_id
            // from chat.postMessage history records.
            assert.strictEqual(message.bot_id, undefined);
            assert.strictEqual(message.thread_ts, scenario.activationRootTs);
            assert.strictEqual(message.reply_broadcast, undefined);
          }
          assert.ok(
            messageTexts(scenario.threadMessages).every(
              (text) => !text.includes("SECRET internal")
            )
          );

          const botReply = publicMessages[0];
          assert.ok(typeof botReply?.ts === "string");
          const decision = yield* harness.runner.inject(
            normalizedEvent({
              authorKind: "laborer",
              authorSlackId: fixture.botUserId,
              channelId: fixture.channelId,
              eventId: "event:self-message",
              messageTs: botReply.ts,
              text: String(botReply.text),
              threadTs: scenario.activationRootTs,
            })
          );
          assert.strictEqual(decision._tag, "Ignored");
          assert.strictEqual(
            decision._tag === "Ignored" ? decision.reason : "",
            "laborer-authored"
          );
        })
      )
  );

  it.live(
    "persists incremental replies across malformed output and known exits, with duplicate-ID semantics",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { fixture, harness } = yield* makeSystem();
          const cases = [
            ["malformed", `[fixture:malformed] <@${LABORER_SLACK_ID}>`],
            ["exit", `[fixture:exit-1] <@${LABORER_SLACK_ID}>`],
            ["duplicate", `[fixture:duplicate] <@${LABORER_SLACK_ID}>`],
            ["conflict", `[fixture:conflict] <@${LABORER_SLACK_ID}>`],
            ["two", `[fixture:two] <@${LABORER_SLACK_ID}>`],
            ["unknown", `[fixture:unknown] <@${LABORER_SLACK_ID}>`],
          ] as const;
          for (const [name, text] of cases) {
            yield* activate(fixture, harness, name, text);
          }
          const state = yield* harness.store.snapshot;
          assert.strictEqual(state.threads.length, cases.length);
          const byInput = (marker: string) => {
            const found = state.threads.find((thread) =>
              thread.turns[0]?.messages[0]?.text.includes(marker)
            );
            assert.ok(found);
            return found;
          };
          for (const marker of ["malformed", "exit", "conflict"]) {
            const thread = byInput(marker);
            assert.strictEqual(thread.turns[0]?.status, "failed");
            assert.deepStrictEqual(
              thread.outbox.map((item) => item.kind),
              ["public_reply", "operational_notice"]
            );
            assert.ok(
              thread.outbox.every((item) => item.status === "delivered")
            );
          }
          const duplicate = byInput("duplicate");
          assert.strictEqual(duplicate.turns[0]?.status, "completed");
          assert.deepStrictEqual(
            duplicate.outbox.map((item) => item.kind),
            ["public_reply"]
          );
          const two = byInput("two");
          assert.deepStrictEqual(
            two.outbox.map((item) => item.text),
            [
              `[PUBLIC ${two.turns[0]?.id}:1] [fixture:two] <@${LABORER_SLACK_ID}>`,
              `[PUBLIC ${two.turns[0]?.id}:2] second`,
            ]
          );
          assert.strictEqual(byInput("unknown").turns[0]?.status, "completed");
        })
      ),
    20_000
  );

  it.live(
    "delivers an accepted reply from a failed invocation without reacting",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* startEmulatedSlack();
          const processHandler = yield* makeProcessHandler(
            fixtureHandlerOptions(projectRoot)
          );
          const completionReactions = yield* Ref.make<
            readonly { channelId: string; rootTs: string }[]
          >([]);
          const harness = yield* makePrototypeHarness({
            completionReactor: {
              react: (request) =>
                Ref.update(completionReactions, (reactions) =>
                  EffectArray.append(reactions, request)
                ),
            },
            handler: processHandler.handler,
            laborerSlackId: LABORER_SLACK_ID,
            slack: fixture.gateway,
          });
          const rootTs = yield* activate(
            fixture,
            harness,
            "failed-with-reply",
            `[fixture:exit-1] <@${LABORER_SLACK_ID}>`
          );
          const thread = yield* Effect.promise(() =>
            fixture.humanClient.conversations.replies({
              channel: fixture.channelId,
              ts: rootTs,
            })
          );
          const publicReplies = thread.messages?.filter((message) =>
            message.text?.startsWith("[PUBLIC ")
          );
          const publicReply = publicReplies?.[0];
          const failureNotice = thread.messages?.find((message) =>
            message.text?.includes("failed (exit: exit code 7)")
          );

          assert.strictEqual(publicReplies?.length, 1);
          assert.ok(publicReply);
          assert.strictEqual(publicReply.user, fixture.botUserId);
          assert.strictEqual(publicReply.thread_ts, rootTs);
          assert.ok(failureNotice);
          assert.strictEqual(failureNotice.user, fixture.botUserId);
          assert.strictEqual(failureNotice.thread_ts, rootTs);
          yield* Effect.sleep("25 millis");
          assert.deepStrictEqual(yield* Ref.get(completionReactions), []);
        })
      )
  );

  it.live(
    "does not react when a successful reply is blocked or later abandoned",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const processHandler = yield* makeProcessHandler(
            fixtureHandlerOptions(projectRoot)
          );
          const completionReactions = yield* Ref.make<
            readonly { channelId: string; rootTs: string }[]
          >([]);
          const harness = yield* makePrototypeHarness({
            completionReactor: {
              react: (request) =>
                Ref.update(completionReactions, (reactions) =>
                  EffectArray.append(reactions, request)
                ),
            },
            handler: processHandler.handler,
            laborerSlackId: LABORER_SLACK_ID,
            slack: {
              postThreadMessage: () =>
                DeliveryError.make({
                  category: "restricted_action",
                  disposition: "destination-permanent",
                  retryAfterMillis: 0,
                }),
              readActivationContext: () => Effect.succeed([]),
            },
          });
          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: "UHUMAN",
              channelId: "CBLOCKEDCOMPLETION",
              eventId: "event:blocked-completion",
              messageTs: "1.0",
              text: `<@${LABORER_SLACK_ID}> blocked completion`,
            })
          );

          let thread = onlyThread((yield* harness.store.snapshot).threads);
          assert.strictEqual(thread.turns[0]?.outcome?.kind, "success");
          assert.strictEqual(thread.turns[0]?.status, "awaiting_delivery");
          assert.deepStrictEqual(
            thread.outbox.map((item) => [item.kind, item.status]),
            [["public_reply", "blocked"]]
          );
          assert.deepStrictEqual(yield* Ref.get(completionReactions), []);

          yield* harness.runner.abandonBlocked(thread.id);
          thread = onlyThread((yield* harness.store.snapshot).threads);
          assert.strictEqual(thread.turns[0]?.status, "completed");
          assert.strictEqual(thread.outbox[0]?.status, "abandoned");
          yield* Effect.sleep("25 millis");
          assert.deepStrictEqual(yield* Ref.get(completionReactions), []);
        })
      )
  );

  it.live(
    "retries transient delivery and honestly blocks destination-wide failures without an undeliverable notice",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* startEmulatedSlack();
          const processHandler = yield* makeProcessHandler(
            fixtureHandlerOptions(projectRoot)
          );
          const mode = yield* Ref.make<"transient" | "blocked" | "open">(
            "transient"
          );
          const transientCount = yield* Ref.make(0);
          const gateway: SlackGatewayShape = {
            readActivationContext: fixture.gateway.readActivationContext,
            postThreadMessage: (request) =>
              Effect.gen(function* () {
                const currentMode = yield* Ref.get(mode);
                if (currentMode === "transient") {
                  const count = yield* Ref.getAndUpdate(
                    transientCount,
                    (value) => value + 1
                  );
                  if (count < 2) {
                    return yield* DeliveryError.make({
                      category: "ratelimited",
                      disposition: "transient",
                      retryAfterMillis: 1,
                    });
                  }
                  yield* Ref.set(mode, "blocked");
                } else if (currentMode === "blocked") {
                  return yield* DeliveryError.make({
                    category: "restricted_action",
                    disposition: "destination-permanent",
                    retryAfterMillis: 0,
                  });
                }
                return yield* fixture.gateway.postThreadMessage(request);
              }),
          };
          const harness = yield* makePrototypeHarness({
            handler: processHandler.handler,
            laborerSlackId: LABORER_SLACK_ID,
            slack: gateway,
          });
          const rootTs = yield* activate(
            fixture,
            harness,
            "delivery-root",
            `[fixture:two] <@${LABORER_SLACK_ID}>`
          );
          let state = yield* harness.store.snapshot;
          let thread = onlyThread(state.threads);
          assert.strictEqual(thread.outbox[0]?.status, "delivered");
          assert.strictEqual(thread.outbox[0]?.deliveryAttempts, 3);
          assert.strictEqual(thread.outbox[1]?.status, "blocked");

          const followText = "must wait behind delivery";
          const follow = yield* postHumanMessage(fixture, followText, {
            threadTs: rootTs,
          });
          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: fixture.humanUserId,
              channelId: fixture.channelId,
              eventId: "event:delivery-follow",
              messageTs: timestampOf(follow),
              text: followText,
              threadTs: rootTs,
            })
          );
          state = yield* harness.store.snapshot;
          thread = onlyThread(state.threads);
          assert.strictEqual(thread.turns.length, 1);
          assert.strictEqual(thread.unassigned.length, 1);
          assert.strictEqual(thread.outbox.length, 2);

          yield* Ref.set(mode, "open");
          yield* harness.runner.retryBlocked(thread.id);
          state = yield* harness.store.snapshot;
          thread = onlyThread(state.threads);
          assert.strictEqual(thread.turns.length, 2);
          assert.deepStrictEqual(
            thread.turns.map((turn) => turn.status),
            ["completed", "completed"]
          );
          assert.ok(thread.outbox.every((item) => item.status === "delivered"));
          assert.deepStrictEqual(
            (yield* processHandler.snapshot).invocations.map(
              (invocation) => invocation.inputTexts
            ),
            [[`[fixture:two] <@${LABORER_SLACK_ID}>`], [followText]]
          );
        })
      )
  );

  it.live(
    "best-effort delivers an item-failure notice without overtaking later handler output or advancing the turn",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const processHandler = yield* makeProcessHandler(
            fixtureHandlerOptions(projectRoot)
          );
          const attemptedTexts = yield* Ref.make<string[]>([]);
          const gateway: SlackGatewayShape = {
            readActivationContext: () => Effect.succeed([]),
            postThreadMessage: (request) =>
              Ref.update(attemptedTexts, (texts) =>
                EffectArray.append(texts, request.text)
              ).pipe(
                Effect.andThen(
                  request.text.includes(":1]")
                    ? DeliveryError.make({
                        category: "msg_too_long",
                        disposition: "item-permanent",
                        retryAfterMillis: 0,
                      })
                    : Effect.succeed({ ts: "notice-delivered" })
                )
              ),
          };
          const harness = yield* makePrototypeHarness({
            handler: processHandler.handler,
            laborerSlackId: LABORER_SLACK_ID,
            slack: gateway,
          });
          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: "UHUMAN",
              channelId: "CITEM",
              eventId: "event:item-failure",
              messageTs: "1.0",
              text: `[fixture:two] <@${LABORER_SLACK_ID}>`,
            })
          );
          let thread = onlyThread((yield* harness.store.snapshot).threads);
          assert.deepStrictEqual(
            thread.outbox.map((item) => [item.kind, item.status]),
            [
              ["public_reply", "blocked"],
              ["public_reply", "pending"],
              ["operational_notice", "delivered"],
            ]
          );
          assert.strictEqual(thread.turns[0]?.status, "awaiting_delivery");
          const attempts = yield* Ref.get(attemptedTexts);
          assert.strictEqual(attempts.length, 2);
          assert.ok(attempts[0]?.includes(":1]"));
          assert.ok(attempts[1]?.startsWith("Delivery for turn"));
          assert.ok(attempts.every((text) => !text.includes(":2]")));

          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: "UHUMAN",
              channelId: "CITEM",
              eventId: "event:item-failure-follow-up",
              messageTs: "2.0",
              text: "must remain queued",
              threadTs: "1.0",
            })
          );
          thread = onlyThread((yield* harness.store.snapshot).threads);
          assert.strictEqual(thread.turns.length, 1);
          assert.strictEqual(thread.unassigned.length, 1);
          assert.strictEqual((yield* Ref.get(attemptedTexts)).length, 2);
        })
      )
  );

  it.live(
    "never creates a recursive notice when the best-effort notice also fails permanently",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const processHandler = yield* makeProcessHandler(
            fixtureHandlerOptions(projectRoot)
          );
          const attempts = yield* Ref.make(0);
          const harness = yield* makePrototypeHarness({
            handler: processHandler.handler,
            laborerSlackId: LABORER_SLACK_ID,
            slack: {
              readActivationContext: () => Effect.succeed([]),
              postThreadMessage: () =>
                Ref.update(attempts, (count) => count + 1).pipe(
                  Effect.andThen(
                    DeliveryError.make({
                      category: "invalid_arguments",
                      disposition: "item-permanent",
                      retryAfterMillis: 0,
                    })
                  )
                ),
            },
          });
          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: "UHUMAN",
              channelId: "CNOTICE",
              eventId: "event:notice-failure",
              messageTs: "1.0",
              text: `<@${LABORER_SLACK_ID}> notice failure`,
            })
          );
          const thread = onlyThread((yield* harness.store.snapshot).threads);
          assert.deepStrictEqual(
            thread.outbox.map((item) => [item.kind, item.status]),
            [
              ["public_reply", "blocked"],
              ["operational_notice", "blocked"],
            ]
          );
          assert.strictEqual(yield* Ref.get(attempts), 2);
        })
      )
  );

  it.live(
    "runs different threads concurrently while replaying an interrupted attempt with the same turn identity",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { fixture, harness, processHandler } = yield* makeSystem();
          const first = yield* postHumanMessage(
            fixture,
            `<@${LABORER_SLACK_ID}> A [fixture:delay=120]`
          );
          const second = yield* postHumanMessage(
            fixture,
            `<@${LABORER_SLACK_ID}> B [fixture:delay=120]`
          );
          const firstEvent = normalizedEvent({
            authorSlackId: fixture.humanUserId,
            channelId: fixture.channelId,
            eventId: "event:parallel-a",
            messageTs: timestampOf(first),
            text: `<@${LABORER_SLACK_ID}> A [fixture:delay=120]`,
          });
          const secondEvent = normalizedEvent({
            authorSlackId: fixture.humanUserId,
            channelId: fixture.channelId,
            eventId: "event:parallel-b",
            messageTs: timestampOf(second),
            text: `<@${LABORER_SLACK_ID}> B [fixture:delay=120]`,
          });
          yield* Effect.all(
            [
              harness.runner.inject(firstEvent),
              harness.runner.inject(secondEvent),
            ],
            { concurrency: "unbounded", discard: true }
          );
          let evidence = yield* processHandler.snapshot;
          assert.ok(evidence.maximumGlobalConcurrency >= 2);
          assert.ok(
            Object.values(evidence.maximumThreadConcurrency).every(
              (maximum) => maximum === 1
            )
          );

          const interrupted = yield* postHumanMessage(
            fixture,
            `<@${LABORER_SLACK_ID}> replay [fixture:delay=250]`
          );
          const event = normalizedEvent({
            authorSlackId: fixture.humanUserId,
            channelId: fixture.channelId,
            eventId: "event:interrupted",
            messageTs: timestampOf(interrupted),
            text: `<@${LABORER_SLACK_ID}> replay [fixture:delay=250]`,
          });
          const fiber = yield* Effect.forkChild(harness.runner.inject(event));
          yield* Effect.sleep("40 millis");
          yield* Fiber.interrupt(fiber);
          const threadId = ThreadId.make(
            `${fixture.channelId}:${timestampOf(interrupted)}`
          );
          yield* harness.runner.drain(threadId);
          const state = yield* harness.store.snapshot;
          const replayThread = state.threads.find(
            (thread) => thread.id === threadId
          );
          assert.ok(replayThread);
          const replayTurn = replayThread.turns[0];
          assert.ok(replayTurn);
          assert.strictEqual(replayTurn.attempts.length, 2);
          assert.strictEqual(replayTurn.status, "completed");
          evidence = yield* processHandler.snapshot;
          const replayInvocations = evidence.invocations.filter(
            (invocation) => invocation.threadId === threadId
          );
          assert.deepStrictEqual(
            replayInvocations.map((invocation) => ({
              attempt: invocation.attemptNumber,
              status: invocation.status,
              turnId: invocation.turnId,
            })),
            [
              {
                attempt: 1,
                status: "interrupted",
                turnId: replayTurn.id,
              },
              {
                attempt: 2,
                status: "exited",
                turnId: replayTurn.id,
              },
            ]
          );
        })
      )
  );

  it.effect("fails closed on a corrupt filesystem snapshot", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        mkdtemp(join(tmpdir(), "laborer-204-corrupt-"))
      );
      const snapshotPath = join(directory, "state.json");
      yield* Effect.promise(() => writeFile(snapshotPath, "not json", "utf8"));
      const exit = yield* Effect.exit(
        Effect.scoped(
          Layer.build(makeFileStoreLayer(LABORER_SLACK_ID, snapshotPath))
        )
      );
      assert.strictEqual(exit._tag, "Failure");
    })
  );

  it.live(
    "atomically persists accepted and settled state across store layers",
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(() =>
          mkdtemp(join(tmpdir(), "laborer-204-durable-"))
        );
        const snapshotPath = join(directory, "state.json");
        const handler: WorkHandlerShape = {
          invoke: () => Effect.void,
        };
        const gateway: SlackGatewayShape = {
          readActivationContext: () => Effect.succeed([]),
          postThreadMessage: () => Effect.succeed({ ts: "unused" }),
        };
        const makeDurableHarness = () =>
          makePrototypeHarness({
            handler,
            laborerSlackId: LABORER_SLACK_ID,
            slack: gateway,
            storeLayer: makeFileStoreLayer(LABORER_SLACK_ID, snapshotPath),
          });
        const first = yield* Effect.scoped(
          Effect.gen(function* () {
            const harness = yield* makeDurableHarness();
            yield* harness.runner.inject(
              normalizedEvent({
                authorSlackId: "UHUMAN",
                channelId: "CDURABLE",
                eventId: "event:durable",
                messageTs: "1.0",
                text: `<@${LABORER_SLACK_ID}> persist`,
              })
            );
            for (let attempt = 0; attempt < 100; attempt += 1) {
              if (
                (yield* harness.store.snapshot).acknowledgements.length === 0
              ) {
                break;
              }
              yield* Effect.sleep("5 millis");
            }
            return yield* harness.store.snapshot;
          })
        );
        const second = yield* Effect.scoped(
          Effect.gen(function* () {
            const harness = yield* makeDurableHarness();
            return yield* harness.store.snapshot;
          })
        );
        assert.deepStrictEqual(second, first);
        assert.strictEqual(second.threads[0]?.turns[0]?.status, "completed");
      })
  );
});

describe("issue #208 context and normalization", () => {
  it.live(
    "paginates timestamp-bounded root and reply activation context, including private channels",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { fixture, harness, processHandler } = yield* makeSystem();
          for (let index = 0; index < 12; index += 1) {
            yield* postHumanMessage(fixture, `root-context-${index}`);
          }
          yield* fixture.gateway.postThreadMessage({
            channelId: fixture.channelId,
            rootTs: timestampOf(
              yield* postHumanMessage(fixture, "self-context-root")
            ),
            text: "Laborer self history must be excluded",
          });
          const activation = yield* postHumanMessage(
            fixture,
            `<@${LABORER_SLACK_ID}> bounded root`
          );
          const rootTs = timestampOf(activation);
          yield* postHumanMessage(fixture, "future top-level after activation");
          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: fixture.humanUserId,
              channelId: fixture.channelId,
              eventId: "event:bounded-root",
              messageTs: rootTs,
              text: `<@${LABORER_SLACK_ID}> bounded root`,
            })
          );
          const rootInvocation = (yield* processHandler.snapshot)
            .invocations[0];
          assert.deepStrictEqual(rootInvocation?.contextTexts, [
            "root-context-3",
            "root-context-4",
            "root-context-5",
            "root-context-6",
            "root-context-7",
            "root-context-8",
            "root-context-9",
            "root-context-10",
            "root-context-11",
            "self-context-root",
          ]);
          assert.ok(
            !rootInvocation?.contextTexts.includes(
              "Laborer self history must be excluded"
            )
          );
          assert.ok(
            !rootInvocation?.contextTexts.includes(
              "future top-level after activation"
            )
          );

          const replyRoot = yield* postHumanMessage(
            fixture,
            "private canonical root",
            { channelId: fixture.privateChannelId }
          );
          const replyRootTs = timestampOf(replyRoot);
          for (let index = 1; index <= 4; index += 1) {
            yield* postHumanMessage(fixture, `private-reply-${index}`, {
              channelId: fixture.privateChannelId,
              threadTs: replyRootTs,
            });
          }
          const replyActivationText = `<@${LABORER_SLACK_ID}> activate private reply`;
          const replyActivation = yield* postHumanMessage(
            fixture,
            replyActivationText,
            {
              channelId: fixture.privateChannelId,
              threadTs: replyRootTs,
            }
          );
          yield* postHumanMessage(fixture, "later reply race", {
            channelId: fixture.privateChannelId,
            threadTs: replyRootTs,
          });
          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: fixture.humanUserId,
              channelId: fixture.privateChannelId,
              channelKind: "private",
              eventId: "event:private-reply-activation",
              messageTs: timestampOf(replyActivation),
              text: replyActivationText,
              threadTs: replyRootTs,
            })
          );
          const privateInvocation =
            (yield* processHandler.snapshot).invocations.find((invocation) =>
              invocation.inputTexts.includes(replyActivationText)
            );
          assert.deepStrictEqual(privateInvocation?.contextTexts, [
            "private canonical root",
            "private-reply-1",
            "private-reply-2",
            "private-reply-3",
            "private-reply-4",
          ]);
          assert.deepStrictEqual(privateInvocation?.inputTexts, [
            replyActivationText,
          ]);
          const privateThread = yield* Effect.promise(() =>
            fixture.humanClient.conversations.replies({
              channel: fixture.privateChannelId,
              ts: replyRootTs,
            })
          );
          const privateOutbound = privateThread.messages?.find(
            (message) => message.user === fixture.botUserId
          );
          assert.ok(privateOutbound);
          assert.strictEqual(privateOutbound.thread_ts, replyRootTs);
          assert.strictEqual(
            "reply_broadcast" in privateOutbound
              ? privateOutbound.reply_broadcast
              : undefined,
            undefined
          );
        })
      )
  );

  it.live(
    "keeps an activation unassigned after transient context exhaustion and batches it on a later retry",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const contextAvailable = yield* Ref.make(false);
          const invocations = yield* Ref.make<readonly string[][]>([]);
          const handler: WorkHandlerShape = {
            invoke: (turn) =>
              Ref.update(invocations, (current) =>
                EffectArray.append(
                  current,
                  turn.messages.map((message) => message.text)
                )
              ),
          };
          const gateway: SlackGatewayShape = {
            readActivationContext: () =>
              Effect.gen(function* () {
                if (yield* Ref.get(contextAvailable)) {
                  return [];
                }
                return yield* ContextReadError.make({
                  category: "temporarily_unavailable",
                  isTransient: true,
                  partial: [],
                });
              }),
            postThreadMessage: () => Effect.succeed({ ts: "unused" }),
          };
          const harness = yield* makePrototypeHarness({
            handler,
            laborerSlackId: LABORER_SLACK_ID,
            slack: gateway,
          });
          const activationText = `<@${LABORER_SLACK_ID}> retain me`;
          const activationFiber = yield* Effect.forkChild(
            harness.runner.inject(
              normalizedEvent({
                authorSlackId: "UHUMAN",
                channelId: "CRETRY",
                eventId: "event:retain-activation",
                messageTs: "10.0",
                text: activationText,
              })
            ),
            { startImmediately: true }
          );
          for (let attempt = 0; attempt < 100; attempt += 1) {
            const state = yield* harness.store.snapshot;
            if ((state.threads[0]?.contextAttempts ?? 0) >= 3) {
              break;
            }
            yield* Effect.sleep("5 millis");
          }
          let thread = onlyThread((yield* harness.store.snapshot).threads);
          assert.strictEqual(thread.contextStatus, "pending");
          assert.strictEqual(thread.turns.length, 0);
          assert.deepStrictEqual(
            thread.unassigned.map((message) => message.text),
            [activationText]
          );

          const laterFiber = yield* Effect.forkChild(
            harness.runner.inject(
              normalizedEvent({
                authorSlackId: "UHUMAN",
                channelId: "CRETRY",
                eventId: "event:retain-later",
                messageTs: "12.0",
                text: "later arrival",
                threadTs: "10.0",
              })
            ),
            { startImmediately: true }
          );
          const earlierFiber = yield* Effect.forkChild(
            harness.runner.inject(
              normalizedEvent({
                authorSlackId: "UHUMAN",
                channelId: "CRETRY",
                eventId: "event:retain-earlier",
                messageTs: "11.0",
                text: "earlier timestamp",
                threadTs: "10.0",
              })
            ),
            { startImmediately: true }
          );
          yield* Effect.sleep("10 millis");
          yield* Ref.set(contextAvailable, true);
          yield* Fiber.join(activationFiber);
          yield* Fiber.join(laterFiber);
          yield* Fiber.join(earlierFiber);
          thread = onlyThread((yield* harness.store.snapshot).threads);
          assert.strictEqual(thread.turns.length, 1);
          assert.strictEqual(thread.turns[0]?.status, "completed");
          assert.deepStrictEqual(yield* Ref.get(invocations), [
            [activationText, "earlier timestamp", "later arrival"],
          ]);
        })
      )
  );

  it.live(
    "retries transient context reads and uses partial context after a definite permanent failure",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const processHandler = yield* makeProcessHandler(
            fixtureHandlerOptions(projectRoot)
          );
          const reads = yield* Ref.make(0);
          const delivered = yield* Ref.make<string[]>([]);
          const partial = NormalizedMessage.make({
            authorKind: "externalBot",
            authorSlackId: "BEXTERNAL",
            classification: "context",
            id: stableMessageId("CCTX", "1.0"),
            isActivation: false,
            slackTs: "1.0",
            text: "partial external-bot context",
          });
          const gateway: SlackGatewayShape = {
            readActivationContext: () =>
              Effect.gen(function* () {
                const attempt = yield* Ref.getAndUpdate(
                  reads,
                  (value) => value + 1
                );
                if (attempt < 2) {
                  return yield* ContextReadError.make({
                    category: "temporarily_unavailable",
                    isTransient: true,
                    partial: [],
                  });
                }
                return [partial];
              }),
            postThreadMessage: ({ text }) =>
              Ref.update(delivered, (texts) =>
                EffectArray.append(texts, text)
              ).pipe(Effect.as({ ts: `${Date.now()}` })),
          };
          const harness = yield* makePrototypeHarness({
            handler: processHandler.handler,
            laborerSlackId: LABORER_SLACK_ID,
            slack: gateway,
          });
          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: "UHUMAN",
              channelId: "CCTX",
              eventId: "event:context-retry",
              messageTs: "2.0",
              text: `<@${LABORER_SLACK_ID}> context retry`,
            })
          );
          let thread = onlyThread((yield* harness.store.snapshot).threads);
          assert.strictEqual(thread.contextAttempts, 3);
          assert.strictEqual(thread.contextIsPartial, false);
          assert.deepStrictEqual(
            (yield* processHandler.snapshot).invocations[0]?.contextTexts,
            ["partial external-bot context"]
          );

          const permanentGateway: SlackGatewayShape = {
            ...gateway,
            readActivationContext: () =>
              ContextReadError.make({
                category: "channel_not_found",
                isTransient: false,
                partial: [
                  NormalizedMessage.make({
                    ...partial,
                    id: stableMessageId("CPERM", partial.slackTs),
                  }),
                ],
              }),
          };
          const permanentHandler = yield* makeProcessHandler(
            fixtureHandlerOptions(projectRoot)
          );
          const permanentHarness = yield* makePrototypeHarness({
            handler: permanentHandler.handler,
            laborerSlackId: LABORER_SLACK_ID,
            slack: permanentGateway,
          });
          yield* permanentHarness.runner.inject(
            normalizedEvent({
              authorSlackId: "UHUMAN",
              channelId: "CPERM",
              eventId: "event:context-permanent",
              messageTs: "3.0",
              text: `<@${LABORER_SLACK_ID}> permanent context`,
            })
          );
          thread = onlyThread((yield* permanentHarness.store.snapshot).threads);
          assert.strictEqual(thread.contextIsPartial, true);
          assert.strictEqual(thread.turns[0]?.status, "completed");
          assert.deepStrictEqual(
            (yield* permanentHandler.snapshot).invocations[0]?.contextTexts,
            ["partial external-bot context"]
          );
        })
      )
  );

  it("normalizes real author identity and excludes self, blank, system, edited, and deleted history", () => {
    const base = { botId: "BLAB", botUserId: "ULAB", channelId: "C1" };
    const human = normalizeSlackHistoryMessage({
      ...base,
      message: { ts: "1", text: "hello", user: "UHUMAN" },
    });
    const bot = normalizeSlackHistoryMessage({
      ...base,
      message: {
        bot_id: "BOTHER",
        subtype: "bot_message",
        text: "bot text",
        ts: "2",
        user: "UBOT",
      },
    });
    assert.strictEqual(human?.authorKind, "human");
    assert.strictEqual(human?.authorSlackId, "UHUMAN");
    assert.strictEqual(human?.id, "C1:1");
    assert.strictEqual(bot?.authorKind, "externalBot");
    assert.strictEqual(bot?.authorSlackId, "UBOT");
    for (const message of [
      { ts: "3", text: "self", user: "ULAB", bot_id: "BLAB" },
      { ts: "4", text: "  ", user: "U1" },
      { ts: "5", text: "edited", user: "U1", subtype: "message_changed" },
      { ts: "6", text: "deleted", user: "U1", subtype: "message_deleted" },
      { ts: "7", text: "joined", user: "U1", subtype: "channel_join" },
      { ts: "8", user: "U1" },
    ]) {
      assert.strictEqual(
        normalizeSlackHistoryMessage({ ...base, message }),
        null
      );
    }
  });

  it.effect(
    "filters unsupported live records while accepting external bots",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const invoked = yield* Ref.make<string[]>([]);
          const handler: WorkHandlerShape = {
            invoke: (turn) =>
              Ref.update(invoked, (values) =>
                EffectArray.appendAll(
                  values,
                  turn.messages.map((message) => message.text)
                )
              ),
          };
          const gateway: SlackGatewayShape = {
            readActivationContext: () => Effect.succeed([]),
            postThreadMessage: () => Effect.succeed({ ts: "posted" }),
          };
          const harness = yield* makePrototypeHarness({
            handler,
            laborerSlackId: LABORER_SLACK_ID,
            slack: gateway,
          });
          const ignoredKinds = [
            "message_changed",
            "message_deleted",
            "reaction",
            "system",
          ] as const;
          for (const [index, recordKind] of ignoredKinds.entries()) {
            yield* harness.runner.inject(
              normalizedEvent({
                authorSlackId: "U1",
                channelId: "CFILTER",
                eventId: `event:ignored:${index}`,
                messageTs: `${index}.0`,
                recordKind,
                text: `<@${LABORER_SLACK_ID}> ignored`,
              })
            );
          }
          yield* harness.runner.inject(
            normalizedEvent({
              authorSlackId: "U1",
              channelId: "CFILTER",
              eventId: "event:blank",
              messageTs: "10.0",
              text: " ",
            })
          );
          yield* harness.runner.inject(
            normalizedEvent({
              authorKind: "externalBot",
              authorSlackId: "BEXTERNAL",
              channelId: "CFILTER",
              eventId: "event:external-bot",
              messageTs: "11.0",
              text: `<@${LABORER_SLACK_ID}> accepted bot`,
            })
          );
          assert.deepStrictEqual(yield* Ref.get(invoked), [
            `<@${LABORER_SLACK_ID}> accepted bot`,
          ]);
          assert.deepStrictEqual(
            (yield* harness.store.snapshot).ignoredInbound.map(
              (ignored) => ignored.reason
            ),
            [
              "unsupported-record",
              "unsupported-record",
              "unsupported-record",
              "unsupported-record",
              "blank",
            ]
          );
        })
      )
  );
});
