import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Redacted, Ref } from "effect";
import { EventId, ThreadId } from "../src/prototype/domain.ts";
import type {
  Runner,
  SlackGatewayShape,
  WorkHandlerShape,
} from "../src/prototype/runtime.ts";
import { makePrototypeHarness } from "../src/prototype/runtime.ts";
import { makeFileStoreLayer } from "../src/prototype/store.ts";
import { loadSlackConfig, SlackRuntimeIdentity } from "../src/slack/config.ts";
import { normalizeSlackEvent } from "../src/slack/normalize.ts";
import { prepareSlackRuntimePaths } from "../src/slack/runtime-paths.ts";
import {
  type SlackEventEnvelope,
  type SlackEventListener,
  type SocketModeClientBoundary,
  startSocketModeAdapter,
} from "../src/slack/socket-mode.ts";

const identity = SlackRuntimeIdentity.make({
  botId: "BLABORER",
  botUserId: "ULABORER",
  teamId: "TLABORER",
});

const eventCallback = (options?: {
  readonly event?: Readonly<Record<string, unknown>>;
  readonly eventId?: string;
}) => ({
  event: {
    channel: "CWORK",
    channel_type: "channel",
    event_ts: "1.0",
    text: "<@ULABORER> run",
    ts: "1.0",
    type: "app_mention",
    user: "UHUMAN",
    ...options?.event,
  },
  event_id: options?.eventId ?? "EvActivation",
  team_id: identity.teamId,
  type: "event_callback",
});

class FakeSocketModeClient implements SocketModeClientBoundary {
  disconnected = false;
  listener: SlackEventListener | null = null;
  listenerRemoved = false;
  started = false;

  disconnect = (): Promise<void> => {
    this.disconnected = true;
    return Promise.resolve();
  };

  emit(envelope: SlackEventEnvelope): void {
    this.listener?.(envelope);
  }

  off(_event: "slack_event", listener: SlackEventListener): void {
    if (this.listener === listener) {
      this.listener = null;
      this.listenerRemoved = true;
    }
  }

  on(_event: "slack_event", listener: SlackEventListener): void {
    this.listener = listener;
  }

  start = (): Promise<void> => {
    this.started = true;
    return Promise.resolve();
  };
}

const waitUntil = Effect.fnUntraced(function* (
  predicate: () => boolean,
  attempts = 100
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) {
      return;
    }
    yield* Effect.sleep("5 millis");
  }
  assert.fail("condition was not reached");
});

const noContextGateway: SlackGatewayShape = {
  postThreadMessage: () => Effect.succeed({ ts: "unused" }),
  readActivationContext: () => Effect.succeed([]),
};

describe("live Slack normalization", () => {
  it.effect(
    "normalizes public mentions and private threaded bot messages",
    () =>
      Effect.gen(function* () {
        const mention = yield* normalizeSlackEvent(eventCallback(), identity);
        assert.ok(mention);
        assert.deepStrictEqual(
          { ...mention },
          {
            authorKind: "human",
            authorSlackId: "UHUMAN",
            channelId: "CWORK",
            channelKind: "public",
            eventId: EventId.make("EvActivation"),
            messageTs: "1.0",
            recordKind: "message",
            text: "<@ULABORER> run",
            threadTs: null,
          }
        );

        const botReply = yield* normalizeSlackEvent(
          eventCallback({
            event: {
              bot_id: "BEXTERNAL",
              channel: "GPRIVATE",
              channel_type: "group",
              subtype: "bot_message",
              text: "external bot follow-up",
              thread_ts: "2.0",
              ts: "3.0",
              type: "message",
              user: "UBOT",
            },
            eventId: "EvBotReply",
          }),
          identity
        );
        assert.strictEqual(botReply?.authorKind, "externalBot");
        assert.strictEqual(botReply?.authorSlackId, "UBOT");
        assert.strictEqual(botReply?.channelKind, "private");
        assert.strictEqual(botReply?.threadTs, "2.0");
        assert.strictEqual(botReply?.messageTs, "3.0");
      })
  );

  it.effect(
    "classifies self, edit, delete, system, blank, DM, and MPIM payloads defensively",
    () =>
      Effect.gen(function* () {
        const cases = [
          {
            expectedKind: "message",
            expectedText: " ",
            event: { text: " ", type: "message" },
          },
          {
            expectedKind: "message_changed",
            expectedText: null,
            event: {
              message: {
                text: "edited",
                thread_ts: "1.0",
                ts: "2.0",
                type: "message",
                user: "UHUMAN",
              },
              subtype: "message_changed",
              ts: "2.1",
              type: "message",
            },
          },
          {
            expectedKind: "message_deleted",
            expectedText: null,
            event: {
              deleted_ts: "2.0",
              previous_message: {
                text: "deleted",
                thread_ts: "1.0",
                ts: "2.0",
                type: "message",
                user: "UHUMAN",
              },
              subtype: "message_deleted",
              type: "message",
            },
          },
          {
            expectedKind: "system",
            expectedText: null,
            event: { subtype: "channel_join", type: "message" },
          },
        ] as const;
        for (const [index, testCase] of cases.entries()) {
          const normalized = yield* normalizeSlackEvent(
            eventCallback({
              event: testCase.event,
              eventId: `EvCase${index}`,
            }),
            identity
          );
          assert.strictEqual(normalized?.recordKind, testCase.expectedKind);
          assert.strictEqual(normalized?.text, testCase.expectedText);
        }

        const self = yield* normalizeSlackEvent(
          eventCallback({
            event: {
              bot_id: identity.botId,
              type: "message",
              user: identity.botUserId,
            },
          }),
          identity
        );
        assert.strictEqual(self?.authorKind, "laborer");

        for (const [channelType, channel] of [
          ["im", "DPRIVATE"],
          ["mpim", "GPRIVATE"],
        ] as const) {
          const direct = yield* normalizeSlackEvent(
            eventCallback({
              event: { channel, channel_type: channelType, type: "message" },
            }),
            identity
          );
          assert.strictEqual(direct?.channelKind, "direct");
        }

        const invalid = yield* Effect.result(
          normalizeSlackEvent({ type: "event_callback" }, identity)
        );
        assert.strictEqual(invalid._tag, "Failure");
      })
  );

  it.effect(
    "normalizes thread broadcasts as authored conversational replies",
    () =>
      Effect.gen(function* () {
        const human = yield* normalizeSlackEvent(
          eventCallback({
            event: {
              subtype: "thread_broadcast",
              text: "human broadcast",
              thread_ts: "1.0",
              ts: "2.0",
              type: "message",
              user: "UHUMAN",
            },
            eventId: "EvHumanBroadcast",
          }),
          identity
        );
        const externalBot = yield* normalizeSlackEvent(
          eventCallback({
            event: {
              bot_id: "BEXTERNAL",
              subtype: "thread_broadcast",
              text: "bot broadcast",
              thread_ts: "1.0",
              ts: "3.0",
              type: "message",
              user: "UBOT",
            },
            eventId: "EvBotBroadcast",
          }),
          identity
        );
        const laborer = yield* normalizeSlackEvent(
          eventCallback({
            event: {
              bot_id: identity.botId,
              subtype: "thread_broadcast",
              text: "self broadcast",
              thread_ts: "1.0",
              ts: "4.0",
              type: "message",
              user: identity.botUserId,
            },
            eventId: "EvSelfBroadcast",
          }),
          identity
        );
        assert.deepStrictEqual(
          [human, externalBot, laborer].map((event) => ({
            authorKind: event?.authorKind,
            authorSlackId: event?.authorSlackId,
            recordKind: event?.recordKind,
            text: event?.text,
            threadTs: event?.threadTs,
          })),
          [
            {
              authorKind: "human",
              authorSlackId: "UHUMAN",
              recordKind: "message",
              text: "human broadcast",
              threadTs: "1.0",
            },
            {
              authorKind: "externalBot",
              authorSlackId: "UBOT",
              recordKind: "message",
              text: "bot broadcast",
              threadTs: "1.0",
            },
            {
              authorKind: "laborer",
              authorSlackId: identity.botUserId,
              recordKind: "message",
              text: "self broadcast",
              threadTs: "1.0",
            },
          ]
        );
      })
  );
});

describe("Socket Mode resource and delivery boundary", () => {
  it.live(
    "acknowledges before work and disconnects while interrupting work",
    () =>
      Effect.gen(function* () {
        const client = new FakeSocketModeClient();
        const order: string[] = [];
        let interrupted = false;
        const runner: Runner = {
          abandonBlocked: () => Effect.void,
          drain: () => Effect.void,
          inject: () =>
            Effect.sync(() => order.push("work")).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  interrupted = true;
                })
              ),
              Effect.as({
                _tag: "Accepted" as const,
                eventId: EventId.make("EvActivation"),
                isActivation: true,
                threadId: ThreadId.make("CWORK:1.0"),
              })
            ),
          retryBlocked: () => Effect.void,
        };
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* startSocketModeAdapter({ client, identity, runner });
            assert.strictEqual(client.started, true);
            client.emit({
              ack: () => {
                order.push("ack");
                return Promise.resolve();
              },
              body: eventCallback(),
            });
            yield* waitUntil(() => order.includes("work"));
            assert.deepStrictEqual(order, ["ack", "work"]);
          })
        );
        assert.strictEqual(client.disconnected, true);
        assert.strictEqual(client.listenerRemoved, true);
        assert.strictEqual(interrupted, true);
      })
  );

  it.live(
    "durably deduplicates mention and message deliveries for one Slack message",
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(() =>
          mkdtemp(join(tmpdir(), "laborer-live-dedupe-"))
        );
        const snapshotPath = join(directory, "state.json");
        const invocations = yield* Ref.make(0);
        const handler: WorkHandlerShape = {
          invoke: () => Ref.update(invocations, (count) => count + 1),
        };
        const deliver = (body: unknown, expectedEventId: string) =>
          Effect.scoped(
            Effect.gen(function* () {
              const harness = yield* makePrototypeHarness({
                handler,
                laborerSlackId: identity.botUserId,
                slack: noContextGateway,
                storeLayer: makeFileStoreLayer(
                  identity.botUserId,
                  snapshotPath
                ),
              });
              const client = new FakeSocketModeClient();
              let acknowledged = false;
              yield* startSocketModeAdapter({
                client,
                identity,
                runner: harness.runner,
              });
              client.emit({
                ack: () => {
                  acknowledged = true;
                  return Promise.resolve();
                },
                body,
              });
              yield* waitUntil(() => acknowledged);
              for (let attempt = 0; attempt < 100; attempt += 1) {
                const state = yield* harness.store.snapshot;
                if (
                  state.seenEventIds.includes(EventId.make(expectedEventId)) &&
                  state.threads[0]?.turns[0]?.status === "completed"
                ) {
                  return state;
                }
                yield* Effect.sleep("5 millis");
              }
              return yield* harness.store.snapshot;
            })
          );

        const first = yield* deliver(eventCallback(), "EvActivation");
        assert.strictEqual(first.threads.length, 1);
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if ((yield* Ref.get(invocations)) === 1) {
            break;
          }
          yield* Effect.sleep("5 millis");
        }
        assert.strictEqual(yield* Ref.get(invocations), 1);
        const second = yield* deliver(
          eventCallback({
            event: { type: "message" },
            eventId: "EvMessageSubscription",
          }),
          "EvMessageSubscription"
        );
        assert.strictEqual(yield* Ref.get(invocations), 1);
        assert.strictEqual(second.threads[0]?.turns.length, 1);
        assert.deepStrictEqual(second.seenEventIds, [
          EventId.make("EvActivation"),
          EventId.make("EvMessageSubscription"),
        ]);
        assert.strictEqual(
          second.ignoredInbound.at(-1)?.reason,
          "duplicate-message"
        );
      })
  );

  it.live(
    "delivers external thread broadcasts and excludes Laborer broadcasts",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const received = yield* Ref.make<
            readonly { readonly authorKind: string; readonly text: string }[]
          >([]);
          const harness = yield* makePrototypeHarness({
            handler: {
              invoke: (turn) =>
                Ref.update(received, (messages) => [
                  ...messages,
                  ...turn.messages.map((message) => ({
                    authorKind: message.authorKind,
                    text: message.text,
                  })),
                ]),
            },
            laborerSlackId: identity.botUserId,
            slack: noContextGateway,
          });
          const client = new FakeSocketModeClient();
          yield* startSocketModeAdapter({
            client,
            identity,
            runner: harness.runner,
          });
          client.emit({
            ack: () => Promise.resolve(),
            body: eventCallback(),
          });
          for (let attempt = 0; attempt < 100; attempt += 1) {
            if (
              (yield* harness.store.snapshot).threads[0]?.turns[0]?.status ===
              "completed"
            ) {
              break;
            }
            yield* Effect.sleep("5 millis");
          }
          client.emit({
            ack: () => Promise.resolve(),
            body: eventCallback({
              event: {
                bot_id: "BEXTERNAL",
                subtype: "thread_broadcast",
                text: "external broadcast input",
                thread_ts: "1.0",
                ts: "2.0",
                type: "message",
                user: "UBOT",
              },
              eventId: "EvExternalBroadcast",
            }),
          });
          for (let attempt = 0; attempt < 100; attempt += 1) {
            if (
              (yield* harness.store.snapshot).threads[0]?.turns[1]?.status ===
              "completed"
            ) {
              break;
            }
            yield* Effect.sleep("5 millis");
          }
          client.emit({
            ack: () => Promise.resolve(),
            body: eventCallback({
              event: {
                bot_id: identity.botId,
                subtype: "thread_broadcast",
                text: "must not trigger",
                thread_ts: "1.0",
                ts: "3.0",
                type: "message",
                user: identity.botUserId,
              },
              eventId: "EvLaborerBroadcast",
            }),
          });
          for (let attempt = 0; attempt < 100; attempt += 1) {
            if (
              (yield* harness.store.snapshot).seenEventIds.includes(
                EventId.make("EvLaborerBroadcast")
              )
            ) {
              break;
            }
            yield* Effect.sleep("5 millis");
          }
          const state = yield* harness.store.snapshot;
          assert.strictEqual(state.threads[0]?.turns.length, 2);
          assert.strictEqual(
            state.ignoredInbound.at(-1)?.reason,
            "laborer-authored"
          );
          assert.deepStrictEqual(yield* Ref.get(received), [
            { authorKind: "human", text: "<@ULABORER> run" },
            { authorKind: "externalBot", text: "external broadcast input" },
          ]);
        })
      )
  );
});

describe("safe local Slack configuration", () => {
  const appPrefix = ["x", "app", "-"].join("");
  const botPrefix = ["x", "oxb", "-"].join("");

  const withConfig = (environment: Record<string, string>) =>
    loadSlackConfig.pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: environment,
            preserveEmptyStrings: true,
          })
        )
      )
    );

  it.effect("loads valid tokens as redacted Effect configuration", () =>
    Effect.gen(function* () {
      const config = yield* withConfig({
        SLACK_APP_TOKEN: `${appPrefix}fixture-value`,
        SLACK_BOT_TOKEN: `${botPrefix}fixture-value`,
      });
      assert.strictEqual(String(config.appToken), "<redacted>");
      assert.strictEqual(String(config.botToken), "<redacted>");
      assert.ok(Redacted.value(config.appToken).startsWith(appPrefix));
    })
  );

  it.effect("rejects blank and wrong token kinds without exposing values", () =>
    Effect.gen(function* () {
      const sensitiveProbe = "must-not-appear-in-errors";
      const blank = yield* Effect.result(
        withConfig({
          SLACK_APP_TOKEN: "",
          SLACK_BOT_TOKEN: `${botPrefix}fixture-value`,
        })
      );
      const wrong = yield* Effect.result(
        withConfig({
          SLACK_APP_TOKEN: `wrong-${sensitiveProbe}`,
          SLACK_BOT_TOKEN: `${botPrefix}fixture-value`,
        })
      );
      assert.strictEqual(blank._tag, "Failure");
      assert.strictEqual(wrong._tag, "Failure");
      assert.ok(!JSON.stringify(wrong).includes(sensitiveProbe));
    })
  );

  it.effect("creates owner-only runtime and work-thread directories", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        mkdtemp(join(tmpdir(), "laborer-live-runtime-"))
      );
      const paths = yield* prepareSlackRuntimePaths(directory);
      assert.strictEqual(
        (yield* Effect.promise(() => stat(paths.root))).mode % 512,
        0o700
      );
      assert.strictEqual(
        (yield* Effect.promise(() => stat(paths.workThreads))).mode % 512,
        0o700
      );
    })
  );
});
