import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Deferred, Effect, Redacted, Ref } from "effect";
import { EventId, ThreadId } from "../src/prototype/domain.ts";
import { makeSlackCompletionReactor } from "../src/prototype/emulated-slack.ts";
import type {
  Runner,
  SlackGatewayShape,
  WorkHandlerShape,
} from "../src/prototype/runtime.ts";
import { makePrototypeHarness } from "../src/prototype/runtime.ts";
import { makeFileStoreLayer } from "../src/prototype/store.ts";
import { loadSlackConfig, SlackRuntimeIdentity } from "../src/slack/config.ts";
import { loadLaborerConfig } from "../src/slack/laborer-config.ts";
import { normalizeSlackEvent } from "../src/slack/normalize.ts";
import { prepareSlackRuntimePaths } from "../src/slack/runtime-paths.ts";
import {
  makeSlackWorkspaceRouteDirectory,
  type SlackEventEnvelope,
  type SlackEventListener,
  type SocketModeClientBoundary,
  startSocketModeAdapter,
} from "../src/slack/socket-mode.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

const identity = SlackRuntimeIdentity.make({
  botId: "BLABORER",
  botUserId: "ULABORER",
  teamId: "TLABORER",
});

const secondIdentity = SlackRuntimeIdentity.make({
  botId: "BSECOND",
  botUserId: "USECOND",
  teamId: "TSECOND",
});

const IN_FLIGHT_WORKSPACE_CAPACITY = 1024;

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

const permissionEnvelope = (
  teamId: string,
  ack: SlackEventEnvelope["ack"]
): SlackEventEnvelope => ({
  ack,
  body: {
    actions: [
      {
        action_id: "laborer_permission_allow_once",
        value: "opaque-capability",
      },
    ],
    channel: { id: "CWORK" },
    container: {
      channel_id: "CWORK",
      message_ts: "2.0",
      thread_ts: "1.0",
    },
    message: { thread_ts: "1.0", ts: "2.0" },
    team: { id: teamId },
    type: "block_actions",
    user: { id: "UHUMAN" },
  },
  envelope_id: `EiPermission${teamId}`,
  type: "interactive",
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

describe("Slack reaction adapters", () => {
  it.effect("treats an already-present completion reaction as successful", () =>
    Effect.gen(function* () {
      const requests: {
        readonly channel: string;
        readonly name: string;
        readonly timestamp: string;
      }[] = [];
      const completionReactor = makeSlackCompletionReactor({
        reactions: {
          add: (request) => {
            requests.push(request);
            return Promise.reject({ data: { error: "already_reacted" } });
          },
          remove: () => Promise.resolve(),
        },
      });

      yield* completionReactor.react({
        channelId: "CCOMPLETION",
        rootTs: "123.456",
      });

      assert.deepStrictEqual(requests, [
        {
          channel: "CCOMPLETION",
          name: "white_check_mark",
          timestamp: "123.456",
        },
      ]);
    })
  );
});

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
            images: [],
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
  it.effect(
    "ACKs after the durable permission claim without waiting for downstream settlement",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const client = new FakeSocketModeClient();
          const durableClaim = yield* Deferred.make<void>();
          let attempts = 0;
          let acknowledgements = 0;
          const runner = {
            accept: () => Effect.void,
            handleInteraction: () =>
              Effect.gen(function* () {
                attempts += 1;
                yield* Deferred.await(durableClaim);
                return "claimed" as const;
              }),
            inject: () => Effect.void,
          };
          yield* startSocketModeAdapter({ client, identity, runner });
          client.emit(
            permissionEnvelope(identity.teamId, () => {
              acknowledgements += 1;
              return Promise.resolve();
            })
          );
          yield* Effect.promise(
            () => new Promise<void>((resolve) => setImmediate(resolve))
          );
          assert.strictEqual(attempts, 1);
          assert.strictEqual(acknowledgements, 0);
          yield* Deferred.succeed(durableClaim, undefined);
          yield* waitUntil(() => acknowledgements === 1);
          assert.strictEqual(attempts, 1);
        })
      )
  );

  it.effect(
    "leaves an uncertain durable publish unacknowledged and ACKs its reconciled retry",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const client = new FakeSocketModeClient();
          let claims = 0;
          let acknowledgements = 0;
          yield* startSocketModeAdapter({
            client,
            identity,
            runner: {
              accept: () => Effect.void,
              handleInteraction: () =>
                Effect.sync(() => {
                  claims += 1;
                  return claims === 1 ? "retry" : "claimed";
                }),
              inject: () => Effect.void,
            },
          });
          const envelope = () =>
            permissionEnvelope(identity.teamId, () => {
              acknowledgements += 1;
              return Promise.resolve();
            });
          client.emit(envelope());
          yield* Effect.promise(
            () => new Promise<void>((resolve) => setImmediate(resolve))
          );
          assert.strictEqual(acknowledgements, 0);
          client.emit(envelope());
          yield* waitUntil(() => acknowledgements === 1);
          assert.strictEqual(claims, 2);
        })
      )
  );

  it.effect(
    "promptly ACKs malformed, unknown, pending, and unavailable permission routes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const routes = yield* makeSlackWorkspaceRouteDirectory;
          yield* routes.registerPending(0, identity.teamId);
          yield* routes.registerPending(1, secondIdentity.teamId);
          let unavailableClaims = 0;
          yield* routes.settleUnavailable(1, secondIdentity.teamId, {
            identity: secondIdentity,
            namespaceWorkspace: true,
            runner: {
              accept: () => Effect.void,
              handleInteraction: () =>
                Effect.sync(() => {
                  unavailableClaims += 1;
                  return "claimed" as const;
                }),
              inject: () => Effect.void,
            },
          });
          const client = new FakeSocketModeClient();
          yield* startSocketModeAdapter({ client, routeDirectory: routes });
          let acknowledgements = 0;
          const ack = (): Promise<void> => {
            acknowledgements += 1;
            return Promise.resolve();
          };
          client.emit(permissionEnvelope(identity.teamId, ack));
          client.emit(permissionEnvelope(secondIdentity.teamId, ack));
          client.emit(permissionEnvelope("TUNKNOWN", ack));
          client.emit({ ack, body: { malformed: true }, type: "interactive" });
          yield* Effect.promise(
            () => new Promise<void>((resolve) => setImmediate(resolve))
          );
          assert.strictEqual(acknowledgements, 4);
          assert.strictEqual(unavailableClaims, 0);
        })
      )
  );

  it.live(
    "leaves a blocked durable interaction claim unacknowledged for Slack retry",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const client = new FakeSocketModeClient();
          let attempts = 0;
          yield* startSocketModeAdapter({
            client,
            identity,
            runner: {
              accept: () => Effect.void,
              handleInteraction: () => {
                attempts += 1;
                return attempts === 1
                  ? Effect.never
                  : Effect.succeed("claimed" as const);
              },
              inject: () => Effect.void,
            },
          });
          const startedAt = Date.now();
          let acknowledgements = 0;
          client.emit(
            permissionEnvelope(identity.teamId, () => {
              acknowledgements += 1;
              return Promise.resolve();
            })
          );
          yield* Effect.sleep("900 millis");
          assert.ok(Date.now() - startedAt < 1100);
          assert.strictEqual(acknowledgements, 0);
          client.emit(
            permissionEnvelope(identity.teamId, () => {
              acknowledgements += 1;
              return Promise.resolve();
            })
          );
          yield* waitUntil(() => acknowledgements === 1);
          assert.strictEqual(attempts, 2);
        })
      ),
    3000
  );

  it.effect(
    "releases coalescer ownership after processing failures, defects, and interruptions",
    () =>
      Effect.gen(function* () {
        const cases = [
          { fail: Effect.fail("fixture typed failure"), label: "failure" },
          {
            fail: Effect.die(new Error("fixture processing defect")),
            label: "defect",
          },
          { fail: Effect.interrupt, label: "interruption" },
        ] as const;
        for (const testCase of cases) {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const client = new FakeSocketModeClient();
              let acceptances = 0;
              let retryAcknowledged = false;
              const runner = {
                accept: () => {
                  acceptances += 1;
                  return acceptances === 1 ? testCase.fail : Effect.void;
                },
                inject: () => Effect.void,
              };
              yield* startSocketModeAdapter({ client, identity, runner });
              const body = eventCallback({
                eventId: `EvTerminalCause${testCase.label}`,
              });
              client.emit({ ack: () => Promise.resolve(), body });
              yield* Effect.promise(
                () => new Promise<void>((resolve) => setImmediate(resolve))
              );
              client.emit({
                ack: () => {
                  retryAcknowledged = true;
                  return Promise.resolve();
                },
                body,
              });
              yield* Effect.promise(
                () => new Promise<void>((resolve) => setImmediate(resolve))
              );
              assert.strictEqual(acceptances, 2, testCase.label);
              assert.strictEqual(retryAcknowledged, true, testCase.label);
            })
          );
        }
      })
  );

  it.effect(
    "retains terminal coalescing ownership while a late ACK remains unresolved",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const client = new FakeSocketModeClient();
          let acceptances = 0;
          const runner = {
            accept: () =>
              Effect.sync(() => {
                acceptances += 1;
              }),
            inject: () => Effect.void,
          };
          yield* startSocketModeAdapter({ client, identity, runner });

          let observeFirstAck: (() => void) | undefined;
          const firstAckStarted = new Promise<void>((resolve) => {
            observeFirstAck = resolve;
          });
          let releaseFirstAck: (() => void) | undefined;
          client.emit({
            ack: () =>
              new Promise<void>((resolve) => {
                releaseFirstAck = resolve;
                observeFirstAck?.();
              }),
            body: eventCallback({ eventId: "EvLateAckOwner" }),
          });
          yield* Effect.promise(() => firstAckStarted);

          let observeLateAck: (() => void) | undefined;
          const lateAckStarted = new Promise<void>((resolve) => {
            observeLateAck = resolve;
          });
          let releaseLateAck: (() => void) | undefined;
          client.emit({
            ack: () =>
              new Promise<void>((resolve) => {
                releaseLateAck = resolve;
                observeLateAck?.();
              }),
            body: eventCallback({ eventId: "EvLateAckOwner" }),
          });
          yield* Effect.promise(() => lateAckStarted);
          releaseFirstAck?.();
          yield* Effect.promise(
            () => new Promise<void>((resolve) => setImmediate(resolve))
          );

          let acknowledgeFurtherRetry: (() => void) | undefined;
          const furtherRetryAcknowledged = new Promise<void>((resolve) => {
            acknowledgeFurtherRetry = resolve;
          });
          client.emit({
            ack: () => {
              acknowledgeFurtherRetry?.();
              return Promise.resolve();
            },
            body: eventCallback({ eventId: "EvLateAckOwner" }),
          });
          yield* Effect.promise(() => furtherRetryAcknowledged);
          assert.strictEqual(acceptances, 1);

          releaseLateAck?.();
          yield* Effect.promise(
            () => new Promise<void>((resolve) => setImmediate(resolve))
          );
          let acknowledgeNextOwner: (() => void) | undefined;
          const nextOwnerAcknowledged = new Promise<void>((resolve) => {
            acknowledgeNextOwner = resolve;
          });
          client.emit({
            ack: () => {
              acknowledgeNextOwner?.();
              return Promise.resolve();
            },
            body: eventCallback({ eventId: "EvLateAckOwner" }),
          });
          yield* Effect.promise(() => nextOwnerAcknowledged);
          assert.strictEqual(acceptances, 2);
        })
      )
  );

  it.effect(
    "bounds unknown ingress without consuming configured workspace capacity",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const routeDirectory = yield* makeSlackWorkspaceRouteDirectory;
          yield* routeDirectory.registerPending(0, secondIdentity.teamId);
          let healthyAcceptances = 0;
          let setupIncompleteReplies = 0;
          yield* routeDirectory.settleReady(0, {
            identity: secondIdentity,
            namespaceWorkspace: true,
            postSetupIncomplete: () =>
              Effect.sync(() => {
                setupIncompleteReplies += 1;
              }),
            runner: {
              accept: () =>
                Effect.sync(() => {
                  healthyAcceptances += 1;
                }),
              inject: () => Effect.void,
            },
          });
          const client = new FakeSocketModeClient();
          yield* startSocketModeAdapter({ client, routeDirectory });

          let hangingUnknownAcknowledgements = 0;
          for (
            let index = 0;
            index < IN_FLIGHT_WORKSPACE_CAPACITY;
            index += 1
          ) {
            client.emit({
              ack: () => {
                hangingUnknownAcknowledgements += 1;
                return new Promise<void>(() => undefined);
              },
              body: {
                ...eventCallback({ eventId: `EvUnknownCapacity${index}` }),
                team_id: "TUNCONFIGURED",
              },
            });
          }
          yield* waitUntil(
            () =>
              hangingUnknownAcknowledgements === IN_FLIGHT_WORKSPACE_CAPACITY
          );

          let quarantinedAcknowledgements = 0;
          const quarantinedBodies: readonly unknown[] = [
            null,
            { event: {}, type: "event_callback" },
            {
              ...eventCallback({ eventId: "EvMalformedConfigured" }),
              event: null,
              team_id: secondIdentity.teamId,
            },
            {
              ...eventCallback({ eventId: "EvInstalledUnconfigured" }),
              team_id: "TINSTALLEDUNCONFIGURED",
            },
            {
              ...eventCallback({ eventId: "EvAmbiguousAuthorization" }),
              authorizations: [
                {
                  is_enterprise_install: false,
                  team_id: "TOTHER",
                },
              ],
              team_id: secondIdentity.teamId,
            },
          ];
          for (const body of quarantinedBodies) {
            client.emit({
              ack: () => {
                quarantinedAcknowledgements += 1;
                return Promise.resolve();
              },
              body,
            });
          }

          let acknowledgeHealthy: (() => void) | undefined;
          const healthyAcknowledged = new Promise<void>((resolve) => {
            acknowledgeHealthy = resolve;
          });
          client.emit({
            ack: () => {
              acknowledgeHealthy?.();
              return Promise.resolve();
            },
            body: {
              ...eventCallback({
                event: { text: `<@${secondIdentity.botUserId}> run` },
                eventId: "EvHealthyAfterUnknownCapacity",
              }),
              team_id: secondIdentity.teamId,
            },
          });

          yield* Effect.promise(() => healthyAcknowledged);
          assert.strictEqual(quarantinedAcknowledgements, 0);
          assert.strictEqual(healthyAcceptances, 1);
          assert.strictEqual(setupIncompleteReplies, 0);
        })
      )
  );

  it.effect(
    "reserves in-flight capacity independently for each configured workspace",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const routeDirectory = yield* makeSlackWorkspaceRouteDirectory;
          yield* routeDirectory.registerPending(0, identity.teamId);
          let healthyAcceptances = 0;
          yield* routeDirectory.settleReady(1, {
            identity: secondIdentity,
            namespaceWorkspace: true,
            runner: {
              accept: () =>
                Effect.sync(() => {
                  healthyAcceptances += 1;
                  return {
                    decision: {
                      _tag: "Accepted" as const,
                      eventId: EventId.make("EvHealthyCapacity"),
                      isActivation: true,
                      threadId: ThreadId.make("workspace:TSECOND:CWORK:1.0"),
                    },
                    scheduling: "Scheduled" as const,
                  };
                }),
              inject: () => Effect.void,
            },
          });
          const client = new FakeSocketModeClient();
          yield* startSocketModeAdapter({ client, routeDirectory });
          for (
            let index = 0;
            index < IN_FLIGHT_WORKSPACE_CAPACITY;
            index += 1
          ) {
            client.emit({
              ack: () => new Promise<void>(() => undefined),
              body: eventCallback({ eventId: `EvPendingCapacity${index}` }),
            });
          }
          let acknowledgeHealthy: (() => void) | undefined;
          const healthyAcknowledged = new Promise<void>((resolve) => {
            acknowledgeHealthy = resolve;
          });
          client.emit({
            ack: () => {
              acknowledgeHealthy?.();
              return Promise.resolve();
            },
            body: {
              ...eventCallback({
                event: { text: `<@${secondIdentity.botUserId}> run` },
                eventId: "EvHealthyCapacity",
              }),
              team_id: secondIdentity.teamId,
            },
          });

          yield* Effect.promise(() => healthyAcknowledged);
          assert.strictEqual(healthyAcceptances, 1);
        })
      )
  );

  it.live(
    "acknowledges durable acceptance without awaiting the blocking inject path",
    () =>
      Effect.gen(function* () {
        const client = new FakeSocketModeClient();
        const order: string[] = [];
        const runner: Runner = {
          accept: () =>
            Effect.sync(() => order.push("accepted")).pipe(
              Effect.as({
                decision: {
                  _tag: "Accepted" as const,
                  eventId: EventId.make("EvActivation"),
                  isActivation: true,
                  threadId: ThreadId.make("CWORK:1.0"),
                },
                scheduling: "Scheduled" as const,
              })
            ),
          acceptApplicationEvent: (event) =>
            Effect.succeed({
              decision: { _tag: "Accepted", eventId: event.eventId },
              scheduling: "Scheduled",
            }),
          abandonBlocked: () => Effect.void,
          drain: () => Effect.void,
          inject: () => Effect.die(new Error("Socket Mode called inject")),
          retryBlocked: () => Effect.void,
          retryInterrupted: () => Effect.void,
          lockCounts: Effect.succeed({
            acknowledgements: 0,
            drivers: 0,
            threads: 0,
          }),
          persistenceHealth: Effect.succeed({ _tag: "Healthy" }),
          quiesce: Effect.void,
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
            yield* waitUntil(() => order.includes("ack"));
            assert.deepStrictEqual(order, ["accepted", "ack"]);
          })
        );
        assert.strictEqual(client.disconnected, true);
        assert.strictEqual(client.listenerRemoved, true);
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

  it.effect("starts the live Socket Mode adapter with Node", () =>
    Effect.gen(function* () {
      const packageJson = JSON.parse(
        yield* Effect.promise(() =>
          readFile(join(process.cwd(), "package.json"), "utf8")
        )
      ) as { readonly scripts?: Readonly<Record<string, string>> };
      assert.strictEqual(
        packageJson.scripts?.["start:slack"],
        "node --env-file-if-exists=.env.local src/slack/live.ts"
      );
    })
  );

  it.effect(
    "loads a root-owned executable work handler while preserving unrelated configuration",
    () =>
      Effect.gen(function* () {
        const directory = yield* makeTempDirectoryScoped(
          "laborer-handler-config-"
        );
        yield* Effect.promise(() =>
          writeFile(
            join(directory, "laborer.json"),
            JSON.stringify({
              unrelated: { retained: true },
              workHandler: {
                command: "./handler.sh",
                environment: ["PROVIDER_API_KEY"],
                initialize: {
                  args: ["--prototype"],
                  command: "./initialize.sh",
                  environment: ["WORKTREE_BASE"],
                },
              },
            })
          )
        );
        yield* Effect.promise(() =>
          writeFile(join(directory, "handler.sh"), "#!/bin/sh\nexit 0\n", {
            mode: 0o700,
          })
        );
        yield* Effect.promise(() =>
          writeFile(join(directory, "initialize.sh"), "#!/bin/sh\nexit 0\n", {
            mode: 0o700,
          })
        );

        const loaded = yield* loadLaborerConfig({
          defaultRoot: "/unused",
          environment: {
            LABORER_ROOT: directory,
            PATH: process.env.PATH,
          },
        });
        const canonicalDirectory = yield* Effect.promise(() =>
          realpath(directory)
        );
        const workHandler = loaded.config.workHandler;
        assert.ok(workHandler);
        assert.strictEqual(loaded.root, canonicalDirectory);
        assert.strictEqual(
          workHandler.command,
          join(canonicalDirectory, "handler.sh")
        );
        assert.deepStrictEqual(workHandler.args, []);
        assert.deepStrictEqual(workHandler.environment, ["PROVIDER_API_KEY"]);
        assert.deepStrictEqual(workHandler.initialize, {
          args: ["--prototype"],
          command: join(canonicalDirectory, "initialize.sh"),
          environment: ["WORKTREE_BASE"],
        });
        assert.deepStrictEqual(loaded.config.unrelated, { retained: true });
      })
  );

  it.effect(
    "rejects invalid work handler configuration without path details",
    () =>
      Effect.gen(function* () {
        const directory = yield* makeTempDirectoryScoped(
          "laborer-invalid-handler-config-"
        );
        const sensitivePath = "./must-not-appear-in-errors";
        yield* Effect.promise(() =>
          writeFile(
            join(directory, "laborer.json"),
            JSON.stringify({ workHandler: { command: sensitivePath } })
          )
        );
        const result = yield* Effect.result(
          loadLaborerConfig({
            defaultRoot: directory,
            environment: { PATH: process.env.PATH },
          })
        );
        assert.strictEqual(result._tag, "Failure");
        assert.ok(!JSON.stringify(result).includes(sensitivePath));

        yield* Effect.promise(() =>
          writeFile(
            join(directory, "laborer.json"),
            JSON.stringify({
              workHandler: {
                args: [sensitivePath, 42],
                command: "./handler.sh",
              },
            })
          )
        );
        const decodeResult = yield* Effect.result(
          loadLaborerConfig({
            defaultRoot: directory,
            environment: { PATH: process.env.PATH },
          })
        );
        assert.strictEqual(decodeResult._tag, "Failure");
        assert.ok(!JSON.stringify(decodeResult).includes(sensitivePath));

        yield* Effect.promise(() =>
          writeFile(
            join(directory, "laborer.json"),
            JSON.stringify({
              workHandler: {
                command: "./handler.sh",
                environment: { PROVIDER_API_KEY: "must-not-be-persisted" },
              },
            })
          )
        );
        const valueResult = yield* Effect.result(
          loadLaborerConfig({
            defaultRoot: directory,
            environment: { PATH: process.env.PATH },
          })
        );
        assert.strictEqual(valueResult._tag, "Failure");
        assert.ok(
          !JSON.stringify(valueResult).includes("must-not-be-persisted")
        );

        yield* Effect.promise(() =>
          writeFile(
            join(directory, "laborer.json"),
            JSON.stringify({
              workHandler: {
                command: "./handler.sh",
                environment: ["SLACK_BOT_TOKEN"],
              },
            })
          )
        );
        const slackNameResult = yield* Effect.result(
          loadLaborerConfig({
            defaultRoot: directory,
            environment: { PATH: process.env.PATH },
          })
        );
        assert.strictEqual(slackNameResult._tag, "Failure");

        for (const names of [
          ["NOT-PORTABLE"],
          ["PROVIDER_API_KEY", "PROVIDER_API_KEY"],
        ]) {
          yield* Effect.promise(() =>
            writeFile(
              join(directory, "laborer.json"),
              JSON.stringify({
                workHandler: {
                  command: "./handler.sh",
                  environment: names,
                },
              })
            )
          );
          const namesResult = yield* Effect.result(
            loadLaborerConfig({
              defaultRoot: directory,
              environment: { PATH: process.env.PATH },
            })
          );
          assert.strictEqual(namesResult._tag, "Failure");
        }
      })
  );

  it.effect("rejects a symlinked laborer.json without reading its target", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const anchor = yield* makeTempDirectoryScoped(
          "laborer-config-symlink-"
        );
        const root = join(anchor, "root");
        const realParent = join(anchor, "real-parent");
        const linkedParent = join(anchor, "linked-parent");
        const outside = join(anchor, "outside.json");
        yield* Effect.promise(() => mkdir(root));
        yield* Effect.promise(() =>
          writeFile(
            outside,
            JSON.stringify({ workHandler: { command: "/bin/sh" } })
          )
        );
        yield* Effect.promise(() =>
          symlink(outside, join(root, "laborer.json"))
        );
        const result = yield* Effect.result(
          loadLaborerConfig({
            defaultRoot: root,
            environment: { PATH: process.env.PATH },
          })
        );
        assert.strictEqual(result._tag, "Failure");
        yield* Effect.promise(() => mkdir(realParent));
        yield* Effect.promise(() => mkdir(join(realParent, "nested")));
        yield* Effect.promise(() =>
          writeFile(
            join(realParent, "nested", "laborer.json"),
            JSON.stringify({ workHandler: { command: "sh" } })
          )
        );
        yield* Effect.promise(() => symlink(realParent, linkedParent));
        const parentResult = yield* Effect.result(
          loadLaborerConfig({
            defaultRoot: join(linkedParent, "nested"),
            environment: { PATH: process.env.PATH },
          })
        );
        assert.strictEqual(parentResult._tag, "Failure");
      })
    )
  );

  it.effect(
    "rejects absolute, escaping, and outside-root symlink handler commands",
    () =>
      Effect.gen(function* () {
        const anchor = yield* makeTempDirectoryScoped(
          "laborer-handler-path-safety-"
        );
        const root = join(anchor, "root");
        const outsideHandler = join(anchor, "outside-handler.sh");
        yield* Effect.promise(() => mkdir(root));
        yield* Effect.promise(() =>
          writeFile(outsideHandler, "#!/bin/sh\nexit 0\n", { mode: 0o700 })
        );

        const loadCommand = Effect.fnUntraced(function* (command: string) {
          yield* Effect.promise(() =>
            writeFile(
              join(root, "laborer.json"),
              JSON.stringify({ workHandler: { command } })
            )
          );
          return yield* Effect.result(
            loadLaborerConfig({
              defaultRoot: root,
              environment: { PATH: process.env.PATH },
            })
          );
        });

        const absolute = yield* loadCommand(outsideHandler);
        const escaping = yield* loadCommand("../outside-handler.sh");
        const linkedHandler = join(root, "linked-handler.sh");
        yield* Effect.promise(() =>
          symlink(outsideHandler, linkedHandler, "file")
        );
        const symlinked = yield* loadCommand("./linked-handler.sh");

        assert.strictEqual(absolute._tag, "Failure");
        assert.strictEqual(escaping._tag, "Failure");
        assert.strictEqual(symlinked._tag, "Failure");
      })
  );
});
