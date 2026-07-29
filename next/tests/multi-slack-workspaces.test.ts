import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { layer as makeSqliteLayer } from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Layer, Redacted, Schema } from "effect";
import {
  defineAction,
  defineApplication,
} from "../src/durable-runtime/action.ts";
import {
  makeRootDurableRuntimeLayer,
  RootDurableRuntime,
  type RootDurableRuntimeShape,
} from "../src/durable-runtime/root-runtime.ts";
import {
  EventId,
  PublicReplyProtocolRecord,
  ReplyId,
  ThreadId,
} from "../src/prototype/domain.ts";
import { HandlerFailure } from "../src/prototype/errors.ts";
import type {
  Runner,
  SlackGatewayShape,
  WorkHandlerShape,
} from "../src/prototype/runtime.ts";
import { makePrototypeHarness } from "../src/prototype/runtime.ts";
import type { PrototypeStoreShape } from "../src/prototype/store.ts";
import { makeFileStoreLayer } from "../src/prototype/store.ts";
import {
  loadSlackDaemonConfig,
  SlackRuntimeIdentity,
} from "../src/slack/config.ts";
import { SlackStartupError } from "../src/slack/errors.ts";
import { environmentForConfiguredHandler } from "../src/slack/handler-environment.ts";
import { acquireRunnerLock } from "../src/slack/runner-lock.ts";
import { prepareSlackRuntimePaths } from "../src/slack/runtime-paths.ts";
import {
  SETUP_INCOMPLETE_REPLY,
  type SlackEventEnvelope,
  type SlackEventListener,
  type SocketModeClientBoundary,
  startSocketModeAdapter,
} from "../src/slack/socket-mode.ts";
import type { SlackWorkspaceStartupAdapter } from "../src/slack/workspace-startup.ts";
import {
  prepareSlackWorkspaceRoot,
  startSlackWorkspaceDirectory,
} from "../src/slack/workspace-startup.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

const firstIdentity = SlackRuntimeIdentity.make({
  botId: "BFIRST",
  botUserId: "UFIRST",
  teamId: "TFIRST",
});

const secondIdentity = SlackRuntimeIdentity.make({
  botId: "BSECOND",
  botUserId: "USECOND",
  teamId: "TSECOND",
});

const unboundIdentity = SlackRuntimeIdentity.make({
  botId: "BUNBOUND",
  botUserId: "UUNBOUND",
  teamId: "TUNBOUND",
});

const FAILED_EXIT_NOTICE_PATTERN = /failed \(exit:/;
const ACK_RETRY_STORM_SIZE = 100;
const ATTACHED_ACK_CAPACITY_AFTER_OWNER = 63;
const PENDING_RETRY_STORM_SIZE = 50;

class FakeSocketModeClient implements SocketModeClientBoundary {
  listener: SlackEventListener | null = null;
  starts = 0;

  disconnect = (): Promise<void> => Promise.resolve();

  emit(envelope: SlackEventEnvelope): void {
    this.listener?.(envelope);
  }

  off(_event: "slack_event", listener: SlackEventListener): void {
    if (this.listener === listener) {
      this.listener = null;
    }
  }

  on(_event: "slack_event", listener: SlackEventListener): void {
    this.listener = listener;
  }

  start = (): Promise<void> => {
    this.starts += 1;
    return Promise.resolve();
  };
}

const makeSlackEventCallback = (options: {
  readonly botId?: string;
  readonly botUserId: string;
  readonly channelId?: string;
  readonly eventId?: string;
  readonly messageTs?: string;
  readonly teamId: string;
  readonly text?: string;
  readonly threadTs?: string;
}) => ({
  authorizations: [
    {
      enterprise_id: null,
      is_bot: true,
      is_enterprise_install: false,
      team_id: options.teamId,
      user_id: options.botUserId,
    },
  ],
  event: {
    ...(options.botId === undefined
      ? {}
      : { bot_id: options.botId, subtype: "bot_message" }),
    channel: options.channelId ?? "CSHARED",
    channel_type: "channel",
    event_ts: options.messageTs ?? "1.0",
    text: options.text ?? `<@${options.botUserId}> run`,
    ts: options.messageTs ?? "1.0",
    type: options.threadTs === undefined ? "app_mention" : "message",
    user: options.botId === undefined ? "UHUMAN" : "UEXTERNALBOT",
    ...(options.threadTs === undefined ? {} : { thread_ts: options.threadTs }),
  },
  event_id: options.eventId ?? "EvShared",
  team_id: options.teamId,
  type: "event_callback",
});

const noContextGateway: SlackGatewayShape = {
  postThreadMessage: () => Effect.succeed({ ts: "posted" }),
  readActivationContext: () => Effect.succeed([]),
};

const emptyRootApplication = defineApplication({ actions: [] });

const fakeRootRuntime = (): RootDurableRuntimeShape => ({
  acknowledgeEvent: () => Effect.void,
  actions: emptyRootApplication.actions,
  attachConversationClient: () =>
    Effect.acquireRelease(Effect.void, () => Effect.void),
  cancelExecution: () => Effect.die("unused fixture Execution cancellation"),
  checkConversationClientCompatibility: () => Effect.void,
  followUpExecution: () => Effect.die("unused fixture Execution follow-up"),
  getExecution: () => Effect.die("unused fixture Execution lookup"),
  inspectExecution: () => Effect.die("unused fixture Execution inspection"),
  pendingEvents: () => Effect.succeed([]),
  runConversation: () => Effect.die("unused fixture Conversation"),
  startExecution: () => Effect.die("unused fixture Execution start"),
});

const createLaborerRoot = Effect.fnUntraced(function* (root: string) {
  yield* Effect.promise(() => mkdir(root));
  yield* Effect.promise(() =>
    writeFile(
      join(root, "laborer.json"),
      JSON.stringify({ workHandler: { command: "./handler.sh" } })
    )
  );
  yield* Effect.promise(() =>
    writeFile(join(root, "handler.sh"), "#!/bin/sh\nexit 0\n", {
      mode: 0o700,
    })
  );
});

interface TestWorkspaceGateway extends SlackGatewayShape {
  readonly teamId: string;
}

const makeTestStartupAdapter = (options: {
  readonly acceptanceCounts?: Map<string, number>;
  readonly gatewayTeams: string[];
  readonly handlerFor: (teamId: string) => WorkHandlerShape;
  readonly handlerStatePaths?: Map<string, string>;
  readonly identitiesByToken: ReadonlyMap<string, SlackRuntimeIdentity>;
  readonly postedReplies?: {
    readonly channelId: string;
    readonly rootTs: string;
    readonly teamId: string;
    readonly text: string;
  }[];
  readonly runnerGates?: ReadonlyMap<string, Deferred.Deferred<void>>;
  readonly runners: Map<string, Runner>;
  readonly rootRuntimeCreations?: Map<string, number>;
  readonly makeRootRuntime?: SlackWorkspaceStartupAdapter<
    string,
    TestWorkspaceGateway
  >["makeRootRuntime"];
  readonly rootRuntimeObservations?: Map<string, RootDurableRuntimeShape>;
  readonly schedulingCounts?: Map<string, number>;
  readonly setupReplies: { readonly teamId: string; readonly text: string }[];
  readonly setupReplyObserved?: Deferred.Deferred<void>;
  readonly statePaths: Map<string, string>;
  readonly stores: Map<string, PrototypeStoreShape>;
}): SlackWorkspaceStartupAdapter<string, TestWorkspaceGateway> => ({
  authenticate: (token) => {
    const identity = options.identitiesByToken.get(token);
    return identity === undefined
      ? SlackStartupError.make({
          operation: "fixture-authentication",
          reason: "unknown-token",
        })
      : Effect.succeed(identity);
  },
  makeClient: (token) => token,
  makeGateway: ({ identity }) => {
    options.gatewayTeams.push(identity.teamId);
    return {
      ...noContextGateway,
      postThreadMessage: (request) =>
        Effect.sync(() => {
          options.postedReplies?.push({
            ...request,
            teamId: identity.teamId,
          });
          return { ts: `posted-${options.postedReplies?.length ?? 0}` };
        }),
      teamId: identity.teamId,
    };
  },
  ...(options.rootRuntimeCreations === undefined &&
  options.rootRuntimeObservations === undefined &&
  options.makeRootRuntime === undefined
    ? {}
    : {
        makeRootRuntime: (root) =>
          Effect.gen(function* () {
            const creations = options.rootRuntimeCreations;
            if (creations !== undefined) {
              creations.set(
                root.paths.root,
                (creations.get(root.paths.root) ?? 0) + 1
              );
            }
            if (options.makeRootRuntime === undefined) {
              return fakeRootRuntime();
            }
            return yield* options.makeRootRuntime(root);
          }),
      }),
  makeRunner: (runtime) =>
    Effect.gen(function* () {
      if (runtime.rootRuntime !== undefined) {
        options.rootRuntimeObservations?.set(
          runtime.identity.teamId,
          runtime.rootRuntime
        );
      }
      const runnerGate = options.runnerGates?.get(runtime.identity.teamId);
      if (runnerGate !== undefined) {
        yield* Effect.uninterruptible(Deferred.await(runnerGate));
      }
      const harness = yield* makePrototypeHarness({
        handler: options.handlerFor(runtime.identity.teamId),
        laborerSlackId: runtime.identity.botUserId,
        slack: runtime.gateway,
        storeLayer: makeFileStoreLayer(
          runtime.identity.botUserId,
          runtime.paths.runnerState,
          runtime.paths.root
        ),
      });
      options.statePaths.set(
        runtime.identity.teamId,
        runtime.paths.runnerState
      );
      options.handlerStatePaths?.set(
        runtime.identity.teamId,
        runtime.paths.workThreads
      );
      options.stores.set(runtime.identity.teamId, harness.store);
      const runner: Runner = {
        ...harness.runner,
        accept: (event) =>
          Effect.sync(() => {
            const count =
              options.acceptanceCounts?.get(runtime.identity.teamId) ?? 0;
            options.acceptanceCounts?.set(runtime.identity.teamId, count + 1);
          }).pipe(
            Effect.andThen(harness.runner.accept(event)),
            Effect.tap((acceptance) =>
              acceptance.scheduling === "Scheduled"
                ? Effect.sync(() => {
                    const count =
                      options.schedulingCounts?.get(runtime.identity.teamId) ??
                      0;
                    options.schedulingCounts?.set(
                      runtime.identity.teamId,
                      count + 1
                    );
                  })
                : Effect.void
            )
          ),
      };
      options.runners.set(runtime.identity.teamId, runner);
      return runner;
    }),
  makeSetupIncompleteResponder: (gateway) => (request) =>
    Effect.sync(() => {
      options.setupReplies.push({ teamId: gateway.teamId, text: request.text });
    }).pipe(
      Effect.andThen(
        options.setupReplyObserved === undefined
          ? Effect.void
          : Deferred.succeed(options.setupReplyObserved, undefined)
      ),
      Effect.asVoid
    ),
});

const fixtureToken = (name: string): string =>
  ["x", "oxb", `-${name}`].join("");

const snapshotFor = (
  stores: ReadonlyMap<string, PrototypeStoreShape>,
  teamId: string
) =>
  Effect.gen(function* () {
    const store = stores.get(teamId);
    assert.ok(store);
    return yield* store.snapshot;
  });

// Most scenes here restart daemons and route real work across workspace
// bindings; the heaviest take over two seconds nominally and have exceeded
// the 5s default under a fully loaded parallel gate. The suite timeout
// replaces that default; explicit per-test timeouts still take precedence.
describe("multi-workspace Slack daemon", () => {
  it.effect("retains the one-workspace environment and identity behavior", () =>
    Effect.gen(function* () {
      const config = yield* loadSlackDaemonConfig({
        defaultRoot: "/default",
        environment: {
          LABORER_ROOT: "/legacy",
          SLACK_APP_TOKEN: ["x", "app", "-fixture"].join(""),
          SLACK_BOT_TOKEN: ["x", "oxb", "-fixture"].join(""),
        },
      });
      assert.strictEqual(config.installations.length, 1);
      assert.strictEqual(config.installations[0]?.namespaceWorkspace, false);
      assert.strictEqual(config.installations[0]?.root, "/legacy");
    })
  );

  it.effect(
    "loads two token references without exposing either secret to handlers",
    () =>
      Effect.gen(function* () {
        const appToken = ["x", "app", "-fixture"].join("");
        const firstToken = ["x", "oxb", "-first-fixture"].join("");
        const secondToken = ["x", "oxb", "-second-fixture"].join("");
        const config = yield* loadSlackDaemonConfig({
          defaultRoot: "/unused",
          environment: {
            LABORER_SLACK_WORKSPACES: JSON.stringify([
              {
                botTokenEnvironment: "SLACK_BOT_TOKEN_FIRST",
                root: "/first",
                teamId: firstIdentity.teamId,
              },
              {
                botTokenEnvironment: "SLACK_BOT_TOKEN_SECOND",
                root: "/second",
                teamId: secondIdentity.teamId,
              },
            ]),
            SLACK_APP_TOKEN: appToken,
            SLACK_BOT_TOKEN_FIRST: firstToken,
            SLACK_BOT_TOKEN_SECOND: secondToken,
          },
        });

        assert.strictEqual(config.installations.length, 2);
        assert.strictEqual(String(config.appToken), "<redacted>");
        const secondInstallation = config.installations[1];
        assert.ok(secondInstallation);
        assert.strictEqual(
          Redacted.value(secondInstallation.botToken),
          secondToken
        );
        assert.deepStrictEqual(
          environmentForConfiguredHandler(
            {
              PATH: "/bin",
              SLACK_BOT_TOKEN_FIRST: firstToken,
              SLACK_BOT_TOKEN_SECOND: secondToken,
            },
            ["SLACK_BOT_TOKEN_FIRST", "SLACK_BOT_TOKEN_SECOND"]
          ),
          { PATH: "/bin" }
        );
      })
  );

  it.effect("keeps a healthy installation when another token is invalid", () =>
    Effect.gen(function* () {
      const config = yield* loadSlackDaemonConfig({
        defaultRoot: "/unused",
        environment: {
          LABORER_SLACK_WORKSPACES: JSON.stringify([
            {
              botTokenEnvironment: "SLACK_BOT_TOKEN_FIRST",
              root: "/first",
              teamId: firstIdentity.teamId,
            },
            {
              botTokenEnvironment: "SLACK_BOT_TOKEN_SECOND",
              root: "/second",
              teamId: secondIdentity.teamId,
            },
          ]),
          SLACK_APP_TOKEN: ["x", "app", "-fixture"].join(""),
          SLACK_BOT_TOKEN_FIRST: ["x", "oxb", "-first-fixture"].join(""),
          SLACK_BOT_TOKEN_SECOND: "revoked-or-missing",
        },
      });
      assert.strictEqual(config.installations[0]?.tokenIsValid, true);
      assert.strictEqual(config.installations[1]?.tokenIsValid, false);
    })
  );

  it.effect(
    "isolates a malformed registry binding from a healthy binding",
    () =>
      Effect.gen(function* () {
        const config = yield* loadSlackDaemonConfig({
          defaultRoot: "/unused",
          environment: {
            LABORER_SLACK_WORKSPACES: JSON.stringify([
              {
                botTokenEnvironment: "SLACK_BOT_TOKEN_BROKEN",
                root: 42,
                teamId: "TBROKEN",
              },
              {
                botTokenEnvironment: "SLACK_BOT_TOKEN_FIRST",
                root: "/first",
                teamId: firstIdentity.teamId,
              },
            ]),
            SLACK_APP_TOKEN: ["x", "app", "-fixture"].join(""),
            SLACK_BOT_TOKEN_BROKEN: ["x", "oxb", "-broken-fixture"].join(""),
            SLACK_BOT_TOKEN_FIRST: ["x", "oxb", "-first-fixture"].join(""),
          },
        });
        assert.strictEqual(config.installations.length, 2);
        assert.strictEqual(config.installations[0]?.validation._tag, "Invalid");
        assert.strictEqual(config.installations[1]?.validation._tag, "Valid");
      })
  );

  it.effect("rejects malformed daemon-wide registry documents", () =>
    Effect.gen(function* () {
      for (const registry of ["{", JSON.stringify({ workspaces: [] })]) {
        const result = yield* Effect.result(
          loadSlackDaemonConfig({
            defaultRoot: "/unused",
            environment: {
              LABORER_SLACK_WORKSPACES: registry,
              SLACK_APP_TOKEN: ["x", "app", "-fixture"].join(""),
            },
          })
        );
        assert.strictEqual(result._tag, "Failure");
      }
    })
  );

  it.effect(
    "prepares legacy local configuration before Slack network startup",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped("laborer-legacy-order-");
          yield* Effect.promise(() =>
            writeFile(
              join(root, "laborer.json"),
              JSON.stringify({ workHandler: { command: "./handler.sh" } })
            )
          );
          yield* Effect.promise(() =>
            writeFile(join(root, "handler.sh"), "#!/bin/sh\nexit 0\n", {
              mode: 0o700,
            })
          );
          const token = fixtureToken("legacy-order");
          const environment = {
            LABORER_ROOT: root,
            SLACK_APP_TOKEN: ["x", "app", "-fixture"].join(""),
            SLACK_BOT_TOKEN: token,
          };
          const config = yield* loadSlackDaemonConfig({
            defaultRoot: "/unused",
            environment,
          });
          const order: string[] = [];
          const authenticationObserved = yield* Deferred.make<void>();
          const baseAdapter = makeTestStartupAdapter({
            gatewayTeams: [],
            handlerFor: () => ({ invoke: () => Effect.void }),
            identitiesByToken: new Map([[token, firstIdentity]]),
            runners: new Map(),
            setupReplies: [],
            statePaths: new Map(),
            stores: new Map(),
          });
          const routeDirectory = yield* startSlackWorkspaceDirectory({
            acquireRootLock: () =>
              Effect.sync(() => {
                order.push("lock");
                return true;
              }),
            adapter: {
              ...baseAdapter,
              authenticate: (client) =>
                Effect.sync(() => order.push("authenticate")).pipe(
                  Effect.andThen(
                    Deferred.succeed(authenticationObserved, undefined)
                  ),
                  Effect.andThen(baseAdapter.authenticate(client))
                ),
            },
            config,
            environment,
            prepareRoot: (binding, currentEnvironment) =>
              Effect.sync(() => order.push("prepare")).pipe(
                Effect.andThen(
                  prepareSlackWorkspaceRoot(binding, currentEnvironment)
                )
              ),
          });
          const client = new FakeSocketModeClient();
          client.start = () => {
            order.push("socket");
            return Promise.resolve();
          };
          yield* startSocketModeAdapter({ client, routeDirectory });
          yield* Deferred.await(authenticationObserved);
          yield* routeDirectory.awaitReady(firstIdentity.teamId);
          assert.deepStrictEqual(order, [
            "prepare",
            "lock",
            "authenticate",
            "socket",
          ]);
        })
      )
  );

  for (const failedPhase of ["config", "lock"] as const) {
    it.effect(
      `starts no legacy Slack network activity when ${failedPhase} fails`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const root = yield* makeTempDirectoryScoped(
              `laborer-legacy-${failedPhase}-`
            );
            yield* Effect.promise(() =>
              writeFile(
                join(root, "laborer.json"),
                failedPhase === "config"
                  ? JSON.stringify({ workHandler: { command: "" } })
                  : JSON.stringify({
                      workHandler: { command: "./handler.sh" },
                    })
              )
            );
            if (failedPhase === "lock") {
              yield* Effect.promise(() =>
                writeFile(join(root, "handler.sh"), "#!/bin/sh\nexit 0\n", {
                  mode: 0o700,
                })
              );
            }
            const token = fixtureToken(`legacy-${failedPhase}`);
            const environment = {
              LABORER_ROOT: root,
              SLACK_APP_TOKEN: ["x", "app", "-fixture"].join(""),
              SLACK_BOT_TOKEN: token,
            };
            const config = yield* loadSlackDaemonConfig({
              defaultRoot: "/unused",
              environment,
            });
            let authentications = 0;
            let lockAttempts = 0;
            const baseAdapter = makeTestStartupAdapter({
              gatewayTeams: [],
              handlerFor: () => ({ invoke: () => Effect.void }),
              identitiesByToken: new Map([[token, firstIdentity]]),
              runners: new Map(),
              setupReplies: [],
              statePaths: new Map(),
              stores: new Map(),
            });
            const client = new FakeSocketModeClient();
            const startup = yield* Effect.result(
              Effect.gen(function* () {
                const routeDirectory = yield* startSlackWorkspaceDirectory({
                  acquireRootLock: () =>
                    Effect.sync(() => {
                      lockAttempts += 1;
                      return false;
                    }),
                  adapter: {
                    ...baseAdapter,
                    authenticate: (slackClient) => {
                      authentications += 1;
                      return baseAdapter.authenticate(slackClient);
                    },
                  },
                  config,
                  environment,
                });
                yield* startSocketModeAdapter({ client, routeDirectory });
              })
            );
            assert.strictEqual(startup._tag, "Failure");
            assert.strictEqual(authentications, 0);
            assert.strictEqual(lockAttempts, failedPhase === "config" ? 0 : 1);
            assert.strictEqual(client.starts, 0);
          })
        )
    );
  }

  for (const stalledPhase of ["preparation", "lock", "runner"] as const) {
    it.effect(
      `routes healthy work while another binding stalls in ${stalledPhase}`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const anchor = yield* makeTempDirectoryScoped(
              `laborer-stalled-${stalledPhase}-`
            );
            const stalledRoot = join(anchor, "stalled-root");
            const healthyRoot = join(anchor, "healthy-root");
            yield* createLaborerRoot(stalledRoot);
            yield* createLaborerRoot(healthyRoot);
            const stalledToken = fixtureToken(`stalled-${stalledPhase}`);
            const healthyToken = fixtureToken(`healthy-${stalledPhase}`);
            const environment = {
              LABORER_SLACK_WORKSPACES: JSON.stringify([
                {
                  botTokenEnvironment: "SLACK_BOT_TOKEN_STALLED",
                  root: stalledRoot,
                  teamId: firstIdentity.teamId,
                },
                {
                  botTokenEnvironment: "SLACK_BOT_TOKEN_HEALTHY",
                  root: healthyRoot,
                  teamId: secondIdentity.teamId,
                },
              ]),
              SLACK_APP_TOKEN: ["x", "app", "-fixture"].join(""),
              SLACK_BOT_TOKEN_HEALTHY: healthyToken,
              SLACK_BOT_TOKEN_STALLED: stalledToken,
            };
            const config = yield* loadSlackDaemonConfig({
              defaultRoot: "/unused",
              environment,
            });
            const gate = yield* Deferred.make<void>();
            const handlerGate = yield* Deferred.make<void>();
            const healthyHandled = yield* Deferred.make<void>();
            const stalledHandled = yield* Deferred.make<void>();
            const stalledOrder: string[] = [];
            let stalledInvocations = 0;
            let stalledAcknowledgements = 0;
            let resolveAcknowledgements: (() => void) | undefined;
            const acknowledgementsCompleted = new Promise<void>((resolve) => {
              resolveAcknowledgements = resolve;
            });
            const acceptanceCounts = new Map<string, number>();
            const stores = new Map<string, PrototypeStoreShape>();
            const runners = new Map<string, Runner>();
            const routeDirectory = yield* startSlackWorkspaceDirectory({
              acquireRootLock: (paths) =>
                stalledPhase === "lock" && paths.root.startsWith(stalledRoot)
                  ? Effect.uninterruptible(Deferred.await(gate)).pipe(
                      Effect.as(true)
                    )
                  : Effect.succeed(true),
              adapter: makeTestStartupAdapter({
                acceptanceCounts,
                gatewayTeams: [],
                handlerFor: (teamId) => ({
                  invoke: () =>
                    teamId === secondIdentity.teamId
                      ? Deferred.succeed(healthyHandled, undefined).pipe(
                          Effect.asVoid
                        )
                      : Effect.sync(() => {
                          stalledOrder.push("handler");
                          stalledInvocations += 1;
                        }).pipe(
                          Effect.andThen(
                            Deferred.succeed(stalledHandled, undefined)
                          ),
                          Effect.andThen(Deferred.await(handlerGate))
                        ),
                }),
                identitiesByToken: new Map([
                  [stalledToken, firstIdentity],
                  [healthyToken, secondIdentity],
                ]),
                runnerGates:
                  stalledPhase === "runner"
                    ? new Map([[firstIdentity.teamId, gate]])
                    : new Map(),
                runners,
                setupReplies: [],
                statePaths: new Map(),
                stores,
              }),
              config,
              environment,
              prepareRoot: (binding, currentEnvironment) =>
                stalledPhase === "preparation" &&
                binding.expectedTeamId === firstIdentity.teamId
                  ? Effect.uninterruptible(Deferred.await(gate)).pipe(
                      Effect.andThen(
                        prepareSlackWorkspaceRoot(binding, currentEnvironment)
                      )
                    )
                  : prepareSlackWorkspaceRoot(binding, currentEnvironment),
            });
            const client = new FakeSocketModeClient();
            yield* startSocketModeAdapter({ client, routeDirectory });
            assert.strictEqual(client.starts, 1);
            const stalledRoute = yield* routeDirectory.resolve(
              firstIdentity.teamId
            );
            const healthyRoute = yield* routeDirectory.awaitReady(
              secondIdentity.teamId
            );
            assert.strictEqual(stalledRoute._tag, "Pending");
            assert.ok(healthyRoute.runner);

            client.emit({
              ack: () => Promise.resolve(),
              body: makeSlackEventCallback({
                botUserId: secondIdentity.botUserId,
                teamId: secondIdentity.teamId,
              }),
            });
            const stalledBody = makeSlackEventCallback({
              botUserId: firstIdentity.botUserId,
              eventId: `EvStalled${stalledPhase}`,
              teamId: firstIdentity.teamId,
            });
            for (let retry = 0; retry < PENDING_RETRY_STORM_SIZE; retry += 1) {
              client.emit({
                ack: () => {
                  stalledOrder.push("ack");
                  stalledAcknowledgements += 1;
                  if (stalledAcknowledgements === PENDING_RETRY_STORM_SIZE) {
                    resolveAcknowledgements?.();
                  }
                  return Promise.resolve();
                },
                body: stalledBody,
              });
            }
            yield* Deferred.await(healthyHandled);
            yield* Effect.promise(
              () => new Promise<void>((resolve) => setImmediate(resolve))
            );
            assert.strictEqual(stalledAcknowledgements, 0);
            assert.strictEqual(stalledInvocations, 0);
            const healthyRunner = runners.get(secondIdentity.teamId);
            assert.ok(healthyRunner);
            yield* healthyRunner.drain(
              ThreadId.make("workspace:TSECOND:CSHARED:1.0")
            );

            yield* Deferred.succeed(gate, undefined);
            const lateRoute = yield* routeDirectory.awaitReady(
              firstIdentity.teamId
            );
            assert.ok(lateRoute.runner);
            yield* Effect.promise(() => acknowledgementsCompleted);
            yield* Deferred.await(stalledHandled);
            assert.strictEqual(stalledOrder[0], "ack");
            assert.strictEqual(stalledInvocations, 1);
            yield* Deferred.succeed(handlerGate, undefined);
            const stalledRunner = runners.get(firstIdentity.teamId);
            assert.ok(stalledRunner);
            yield* stalledRunner.drain(
              ThreadId.make("workspace:TFIRST:CSHARED:1.0")
            );
            assert.strictEqual(acceptanceCounts.get(firstIdentity.teamId), 1);
          })
        )
    );
  }

  it.effect(
    "bounds attached retries while a hanging owner ACK rejects without starting a duplicate driver",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const anchor = yield* makeTempDirectoryScoped(
            "laborer-rejected-ack-"
          );
          const root = join(anchor, "root");
          yield* createLaborerRoot(root);
          const token = fixtureToken("rejected-ack");
          const environment = {
            LABORER_SLACK_WORKSPACES: JSON.stringify([
              {
                botTokenEnvironment: "SLACK_BOT_TOKEN_REJECTED_ACK",
                root,
                teamId: firstIdentity.teamId,
              },
            ]),
            SLACK_APP_TOKEN: ["x", "app", "-fixture"].join(""),
            SLACK_BOT_TOKEN_REJECTED_ACK: token,
          };
          const config = yield* loadSlackDaemonConfig({
            defaultRoot: "/unused",
            environment,
          });
          const handlerGate = yield* Deferred.make<void>();
          const handlerStarted = yield* Deferred.make<void>();
          const acceptanceCounts = new Map<string, number>();
          const schedulingCounts = new Map<string, number>();
          let handlerInvocations = 0;
          const runners = new Map<string, Runner>();
          const routeDirectory = yield* startSlackWorkspaceDirectory({
            acquireRootLock: () => Effect.succeed(true),
            adapter: makeTestStartupAdapter({
              acceptanceCounts,
              gatewayTeams: [],
              handlerFor: () => ({
                invoke: () =>
                  Effect.sync(() => {
                    handlerInvocations += 1;
                  }).pipe(
                    Effect.andThen(Deferred.succeed(handlerStarted, undefined)),
                    Effect.andThen(Deferred.await(handlerGate))
                  ),
              }),
              identitiesByToken: new Map([[token, firstIdentity]]),
              runners,
              schedulingCounts,
              setupReplies: [],
              statePaths: new Map(),
              stores: new Map(),
            }),
            config,
            environment,
          });
          yield* routeDirectory.awaitReady(firstIdentity.teamId);
          const client = new FakeSocketModeClient();
          yield* startSocketModeAdapter({ client, routeDirectory });
          const body = makeSlackEventCallback({
            botUserId: firstIdentity.botUserId,
            eventId: "EvRejectedAck",
            teamId: firstIdentity.teamId,
          });
          let rejectFirstAck: ((error: Error) => void) | undefined;
          let observeFirstAck: (() => void) | undefined;
          const firstAckStarted = new Promise<void>((resolve) => {
            observeFirstAck = resolve;
          });
          client.emit({
            ack: () =>
              new Promise<void>((_resolve, reject) => {
                rejectFirstAck = reject;
                observeFirstAck?.();
              }),
            body,
          });
          yield* Effect.promise(() => firstAckStarted);
          yield* Deferred.await(handlerStarted);

          let attachedAcknowledgements = 0;
          let observeAttachedCapacity: (() => void) | undefined;
          const attachedCapacityReached = new Promise<void>((resolve) => {
            observeAttachedCapacity = resolve;
          });
          for (let retry = 0; retry < ACK_RETRY_STORM_SIZE; retry += 1) {
            client.emit({
              ack: () => {
                attachedAcknowledgements += 1;
                if (
                  attachedAcknowledgements === ATTACHED_ACK_CAPACITY_AFTER_OWNER
                ) {
                  observeAttachedCapacity?.();
                }
                return Promise.resolve();
              },
              body,
            });
          }
          yield* Effect.promise(() => attachedCapacityReached);
          assert.strictEqual(
            attachedAcknowledgements,
            ATTACHED_ACK_CAPACITY_AFTER_OWNER
          );
          assert.strictEqual(acceptanceCounts.get(firstIdentity.teamId), 1);
          assert.strictEqual(schedulingCounts.get(firstIdentity.teamId), 1);
          assert.strictEqual(handlerInvocations, 1);

          rejectFirstAck?.(new Error("fixture ACK rejection"));
          yield* Effect.promise(
            () => new Promise<void>((resolve) => setImmediate(resolve))
          );
          let acknowledgeLateRetry: (() => void) | undefined;
          const lateRetryAcknowledged = new Promise<void>((resolve) => {
            acknowledgeLateRetry = resolve;
          });
          client.emit({
            ack: () => {
              acknowledgeLateRetry?.();
              return Promise.resolve();
            },
            body,
          });
          yield* Effect.promise(() => lateRetryAcknowledged);
          assert.strictEqual(acceptanceCounts.get(firstIdentity.teamId), 2);
          assert.strictEqual(schedulingCounts.get(firstIdentity.teamId), 1);
          assert.strictEqual(handlerInvocations, 1);

          yield* Deferred.succeed(handlerGate, undefined);
          const runner = runners.get(firstIdentity.teamId);
          assert.ok(runner);
          yield* runner.drain(ThreadId.make("workspace:TFIRST:CSHARED:1.0"));
        })
      )
  );

  it.live(
    "routes isolated public replies and gang follow-ups despite another workspace failure",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const anchor = yield* makeTempDirectoryScoped(
            "laborer-reply-isolation-"
          );
          const firstRoot = join(anchor, "first-root");
          const secondRoot = join(anchor, "second-root");
          yield* createLaborerRoot(firstRoot);
          yield* createLaborerRoot(secondRoot);
          const firstToken = fixtureToken("failure-workspace");
          const secondToken = fixtureToken("reply-workspace");
          const environment = {
            LABORER_SLACK_WORKSPACES: JSON.stringify([
              {
                botTokenEnvironment: "SLACK_BOT_TOKEN_FAILURE",
                root: firstRoot,
                teamId: firstIdentity.teamId,
              },
              {
                botTokenEnvironment: "SLACK_BOT_TOKEN_REPLY",
                root: secondRoot,
                teamId: secondIdentity.teamId,
              },
            ]),
            SLACK_APP_TOKEN: ["x", "app", "-fixture"].join(""),
            SLACK_BOT_TOKEN_FAILURE: firstToken,
            SLACK_BOT_TOKEN_REPLY: secondToken,
          };
          const config = yield* loadSlackDaemonConfig({
            defaultRoot: "/unused",
            environment,
          });
          const failureObserved = yield* Deferred.make<void>();
          const firstReplyFinished = yield* Deferred.make<void>();
          const secondTurnSignals = yield* Effect.forEach([0, 1, 2], () =>
            Deferred.make<void>()
          );
          const [firstTurnSignal, secondTurnSignal, thirdTurnSignal] =
            secondTurnSignals;
          assert.ok(firstTurnSignal);
          assert.ok(secondTurnSignal);
          assert.ok(thirdTurnSignal);
          const received: {
            readonly authorKind: string;
            readonly text: string;
          }[] = [];
          const postedReplies: {
            readonly channelId: string;
            readonly rootTs: string;
            readonly teamId: string;
            readonly text: string;
          }[] = [];
          let secondInvocation = 0;
          const stores = new Map<string, PrototypeStoreShape>();
          const runners = new Map<string, Runner>();
          const routeDirectory = yield* startSlackWorkspaceDirectory({
            adapter: makeTestStartupAdapter({
              gatewayTeams: [],
              handlerFor: (teamId) => ({
                invoke: (turn, acceptReply) => {
                  if (teamId === firstIdentity.teamId) {
                    return turn.channelId === "CFAIL"
                      ? Deferred.succeed(failureObserved, undefined).pipe(
                          Effect.andThen(
                            HandlerFailure.make({
                              category: "exit",
                              safeDetail: "fixture terminal failure",
                            })
                          )
                        )
                      : acceptReply(
                          PublicReplyProtocolRecord.make({
                            protocolVersion: 1,
                            replyId: ReplyId.make(`reply-${turn.id}`),
                            text: "first-workspace-response",
                            type: "public_reply",
                          })
                        ).pipe(
                          Effect.andThen(
                            Deferred.succeed(firstReplyFinished, undefined)
                          ),
                          Effect.asVoid
                        );
                  }
                  const invocation = secondInvocation;
                  secondInvocation += 1;
                  const signal = secondTurnSignals[invocation];
                  assert.ok(signal);
                  received.push(
                    ...turn.messages.map((message) => ({
                      authorKind: message.authorKind,
                      text: message.text,
                    }))
                  );
                  return acceptReply(
                    PublicReplyProtocolRecord.make({
                      protocolVersion: 1,
                      replyId: ReplyId.make(`reply-${turn.id}`),
                      text: `response-${invocation + 1}`,
                      type: "public_reply",
                    })
                  ).pipe(
                    Effect.andThen(Deferred.succeed(signal, undefined)),
                    Effect.asVoid
                  );
                },
              }),
              identitiesByToken: new Map([
                [firstToken, firstIdentity],
                [secondToken, secondIdentity],
              ]),
              postedReplies,
              runners,
              setupReplies: [],
              statePaths: new Map(),
              stores,
            }),
            config,
            environment,
          });
          yield* Effect.all([
            routeDirectory.awaitReady(firstIdentity.teamId),
            routeDirectory.awaitReady(secondIdentity.teamId),
          ]);
          const client = new FakeSocketModeClient();
          yield* startSocketModeAdapter({ client, routeDirectory });
          client.emit({
            ack: () => Promise.resolve(),
            body: makeSlackEventCallback({
              botUserId: firstIdentity.botUserId,
              channelId: "CFAIL",
              eventId: "EvFailure",
              teamId: firstIdentity.teamId,
              text: `<@${firstIdentity.botUserId}> terminal failure`,
            }),
          });
          client.emit({
            ack: () => Promise.resolve(),
            body: makeSlackEventCallback({
              botUserId: secondIdentity.botUserId,
              teamId: secondIdentity.teamId,
            }),
          });
          yield* Deferred.await(failureObserved);
          yield* Deferred.await(firstTurnSignal);
          const firstRunner = runners.get(firstIdentity.teamId);
          const secondRunner = runners.get(secondIdentity.teamId);
          assert.ok(firstRunner);
          assert.ok(secondRunner);
          yield* firstRunner.drain(ThreadId.make("workspace:TFIRST:CFAIL:1.0"));
          yield* secondRunner.drain(
            ThreadId.make("workspace:TSECOND:CSHARED:1.0")
          );
          assert.strictEqual(
            (yield* snapshotFor(stores, firstIdentity.teamId)).threads[0]
              ?.turns[0]?.status,
            "failed"
          );

          client.emit({
            ack: () => Promise.resolve(),
            body: makeSlackEventCallback({
              botUserId: firstIdentity.botUserId,
              channelId: "COK",
              eventId: "EvFirstReply",
              messageTs: "4.0",
              teamId: firstIdentity.teamId,
              text: `<@${firstIdentity.botUserId}> reply successfully`,
            }),
          });
          yield* Deferred.await(firstReplyFinished);
          yield* firstRunner.drain(ThreadId.make("workspace:TFIRST:COK:4.0"));

          client.emit({
            ack: () => Promise.resolve(),
            body: makeSlackEventCallback({
              botUserId: secondIdentity.botUserId,
              eventId: "EvHumanFollowUp",
              messageTs: "2.0",
              teamId: secondIdentity.teamId,
              text: "human follow-up",
              threadTs: "1.0",
            }),
          });
          yield* Deferred.await(secondTurnSignal);
          yield* secondRunner.drain(
            ThreadId.make("workspace:TSECOND:CSHARED:1.0")
          );
          client.emit({
            ack: () => Promise.resolve(),
            body: makeSlackEventCallback({
              botId: "BEXTERNAL",
              botUserId: secondIdentity.botUserId,
              eventId: "EvBotFollowUp",
              messageTs: "3.0",
              teamId: secondIdentity.teamId,
              text: "external bot follow-up",
              threadTs: "1.0",
            }),
          });
          yield* Deferred.await(thirdTurnSignal);
          yield* secondRunner.drain(
            ThreadId.make("workspace:TSECOND:CSHARED:1.0")
          );

          const secondState = yield* snapshotFor(stores, secondIdentity.teamId);
          const firstState = yield* snapshotFor(stores, firstIdentity.teamId);
          assert.deepStrictEqual(
            firstState.threads.map((thread) => thread.turns[0]?.status),
            ["failed", "completed"]
          );
          assert.deepStrictEqual(
            secondState.threads[0]?.turns.map((turn) => turn.status),
            ["completed", "completed", "completed"]
          );
          assert.deepStrictEqual(received, [
            { authorKind: "human", text: `<@${secondIdentity.botUserId}> run` },
            { authorKind: "human", text: "human follow-up" },
            { authorKind: "externalBot", text: "external bot follow-up" },
          ]);
          const firstWorkspacePosts = postedReplies.filter(
            (reply) => reply.teamId === firstIdentity.teamId
          );
          const secondWorkspacePosts = postedReplies.filter(
            (reply) => reply.teamId === secondIdentity.teamId
          );
          assert.strictEqual(firstWorkspacePosts[0]?.channelId, "CFAIL");
          assert.match(
            firstWorkspacePosts[0]?.text ?? "",
            FAILED_EXIT_NOTICE_PATTERN
          );
          assert.deepStrictEqual(firstWorkspacePosts[1], {
            channelId: "COK",
            rootTs: "4.0",
            teamId: firstIdentity.teamId,
            text: "first-workspace-response",
          });
          assert.deepStrictEqual(
            secondWorkspacePosts,
            [1, 2, 3].map((number) => ({
              channelId: "CSHARED",
              rootTs: "1.0",
              teamId: secondIdentity.teamId,
              text: `response-${number}`,
            }))
          );
        })
      )
  );

  it.live(
    "shares one root lock while namespacing workspace snapshots and handler state",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const anchor = yield* makeTempDirectoryScoped("laborer-shared-root-");
          const sharedRoot = join(anchor, "shared-root");
          yield* createLaborerRoot(sharedRoot);
          const firstToken = fixtureToken("shared-first");
          const secondToken = fixtureToken("shared-second");
          const environment = {
            LABORER_SLACK_WORKSPACES: JSON.stringify([
              {
                botTokenEnvironment: "SLACK_BOT_TOKEN_SHARED_FIRST",
                root: sharedRoot,
                teamId: firstIdentity.teamId,
              },
              {
                botTokenEnvironment: "SLACK_BOT_TOKEN_SHARED_SECOND",
                root: sharedRoot,
                teamId: secondIdentity.teamId,
              },
            ]),
            SLACK_APP_TOKEN: ["x", "app", "-fixture"].join(""),
            SLACK_BOT_TOKEN_SHARED_FIRST: firstToken,
            SLACK_BOT_TOKEN_SHARED_SECOND: secondToken,
          };
          const config = yield* loadSlackDaemonConfig({
            defaultRoot: "/unused",
            environment,
          });
          const lockPaths = yield* prepareSlackRuntimePaths(
            sharedRoot,
            firstIdentity.teamId
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const stores = new Map<string, PrototypeStoreShape>();
              const runners = new Map<string, Runner>();
              const statePaths = new Map<string, string>();
              const handlerStatePaths = new Map<string, string>();
              const rootRuntimeCreations = new Map<string, number>();
              const rootRuntimeObservations = new Map<
                string,
                RootDurableRuntimeShape
              >();
              const routeDirectory = yield* startSlackWorkspaceDirectory({
                adapter: makeTestStartupAdapter({
                  gatewayTeams: [],
                  handlerFor: () => ({ invoke: () => Effect.void }),
                  handlerStatePaths,
                  identitiesByToken: new Map([
                    [firstToken, firstIdentity],
                    [secondToken, secondIdentity],
                  ]),
                  runners,
                  rootRuntimeCreations,
                  rootRuntimeObservations,
                  setupReplies: [],
                  statePaths,
                  stores,
                }),
                config,
                environment,
              });
              yield* Effect.all([
                routeDirectory.awaitReady(firstIdentity.teamId),
                routeDirectory.awaitReady(secondIdentity.teamId),
              ]);
              const routes = yield* routeDirectory.snapshot;
              assert.strictEqual(routes.length, 2);
              assert.strictEqual(runners.size, 2);
              assert.strictEqual(rootRuntimeCreations.get(lockPaths.root), 1);
              assert.strictEqual(
                rootRuntimeObservations.get(firstIdentity.teamId),
                rootRuntimeObservations.get(secondIdentity.teamId)
              );
              assert.notStrictEqual(
                statePaths.get(firstIdentity.teamId),
                statePaths.get(secondIdentity.teamId)
              );
              assert.notStrictEqual(
                handlerStatePaths.get(firstIdentity.teamId),
                handlerStatePaths.get(secondIdentity.teamId)
              );
              for (const path of [
                statePaths.get(firstIdentity.teamId),
                statePaths.get(secondIdentity.teamId),
                handlerStatePaths.get(firstIdentity.teamId),
                handlerStatePaths.get(secondIdentity.teamId),
              ]) {
                assert.ok(path?.startsWith(sharedRoot));
              }
              const competingLock = yield* Effect.result(
                acquireRunnerLock(lockPaths.root, lockPaths.lock)
              );
              assert.strictEqual(competingLock._tag, "Failure");
            })
          );
          const releasedLock = yield* Effect.scoped(
            Effect.result(acquireRunnerLock(lockPaths.root, lockPaths.lock))
          );
          assert.strictEqual(releasedLock._tag, "Success");
        })
      )
  );

  it.live(
    "partitions real Cluster runtimes across canonical roots and workspace owners",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const anchor = yield* makeTempDirectoryScoped(
            "laborer-cluster-root-partitions-"
          );
          const sharedRoot = join(anchor, "shared-root");
          const distinctRoot = join(anchor, "distinct-root");
          yield* createLaborerRoot(sharedRoot);
          yield* createLaborerRoot(distinctRoot);
          const thirdIdentity = SlackRuntimeIdentity.make({
            botId: "BTHIRD",
            botUserId: "UTHIRD",
            teamId: "TTHIRD",
          });
          const firstToken = fixtureToken("cluster-first");
          const secondToken = fixtureToken("cluster-second");
          const thirdToken = fixtureToken("cluster-third");
          const environment = {
            LABORER_SLACK_WORKSPACES: JSON.stringify([
              {
                botTokenEnvironment: "SLACK_BOT_TOKEN_CLUSTER_FIRST",
                root: sharedRoot,
                teamId: firstIdentity.teamId,
              },
              {
                botTokenEnvironment: "SLACK_BOT_TOKEN_CLUSTER_SECOND",
                root: join(sharedRoot, "."),
                teamId: secondIdentity.teamId,
              },
              {
                botTokenEnvironment: "SLACK_BOT_TOKEN_CLUSTER_THIRD",
                root: distinctRoot,
                teamId: thirdIdentity.teamId,
              },
            ]),
            SLACK_APP_TOKEN: ["x", "app", "-fixture"].join(""),
            SLACK_BOT_TOKEN_CLUSTER_FIRST: firstToken,
            SLACK_BOT_TOKEN_CLUSTER_SECOND: secondToken,
            SLACK_BOT_TOKEN_CLUSTER_THIRD: thirdToken,
          };
          const config = yield* loadSlackDaemonConfig({
            defaultRoot: "/unused",
            environment,
          });
          const releaseShared = yield* Deferred.make<void>();
          const releaseDistinct = yield* Deferred.make<void>();
          const observedControls: string[] = [];
          const sharedAction = defineAction({
            annotations: { idempotentHint: true },
            controls: {
              cancel: (context) =>
                Effect.sync(() => {
                  observedControls.push(`cancel:${context.workspaceId}`);
                }),
              followUp: (content, context) =>
                Effect.sync(() => {
                  observedControls.push(
                    `follow-up:${context.workspaceId}:${content}`
                  );
                }),
            },
            description: "Exercise a shared-root workspace partition",
            input: Schema.Struct({ label: Schema.String }),
            name: "fixture/shared-partition",
            recoveryPolicy: "idempotent-retry",
            result: Schema.Struct({ label: Schema.String }),
            revision: "v1",
            run: (input, context) =>
              context
                .reportProgress("started", { label: input.label })
                .pipe(
                  Effect.andThen(Deferred.await(releaseShared)),
                  Effect.as(input)
                ),
          });
          const distinctAction = defineAction({
            annotations: { idempotentHint: true },
            description: "Exercise an independent root partition",
            input: Schema.Struct({ value: Schema.Number }),
            name: "fixture/distinct-partition",
            recoveryPolicy: "idempotent-retry",
            result: Schema.Struct({ value: Schema.Number }),
            revision: "v1",
            run: (input) =>
              Deferred.await(releaseDistinct).pipe(Effect.as(input)),
          });
          const distinctFailure = defineAction({
            description: "Fail without mutating another root",
            input: Schema.Struct({ fail: Schema.Boolean }),
            name: "fixture/distinct-failure",
            result: Schema.Struct({ unreachable: Schema.Boolean }),
            revision: "v1",
            run: () => Effect.fail("private distinct-root failure"),
          });
          const sharedApplication = defineApplication({
            actions: [sharedAction],
          });
          const distinctApplication = defineApplication({
            actions: [distinctAction, distinctFailure],
          });
          const rootRuntimeCreations = new Map<string, number>();
          const rootRuntimeFinalizations = new Map<string, number>();
          const rootRuntimeObservations = new Map<
            string,
            RootDurableRuntimeShape
          >();
          const lockAcquisitions = new Map<string, number>();
          const lockFinalizations = new Map<string, number>();
          const databasePaths = new Map<string, string>();
          const legacyWorkspaceIds = new Map<string, string | undefined>();

          yield* Effect.scoped(
            Effect.gen(function* () {
              const routeDirectory = yield* startSlackWorkspaceDirectory({
                acquireRootLock: (paths) =>
                  Effect.acquireRelease(
                    Effect.sync(() => {
                      lockAcquisitions.set(
                        paths.root,
                        (lockAcquisitions.get(paths.root) ?? 0) + 1
                      );
                      return true;
                    }),
                    () =>
                      Effect.sync(() => {
                        lockFinalizations.set(
                          paths.root,
                          (lockFinalizations.get(paths.root) ?? 0) + 1
                        );
                      })
                  ),
                adapter: makeTestStartupAdapter({
                  gatewayTeams: [],
                  handlerFor: () => ({ invoke: () => Effect.void }),
                  identitiesByToken: new Map([
                    [firstToken, firstIdentity],
                    [secondToken, secondIdentity],
                    [thirdToken, thirdIdentity],
                  ]),
                  makeRootRuntime: (root) => {
                    const application =
                      root.laborer.root === sharedRoot
                        ? sharedApplication
                        : distinctApplication;
                    databasePaths.set(
                      root.paths.root,
                      root.paths.runtimeDatabase
                    );
                    legacyWorkspaceIds.set(
                      root.paths.root,
                      root.legacyWorkspaceId
                    );
                    return Effect.acquireRelease(
                      Effect.gen(function* () {
                        const context = yield* Layer.build(
                          makeRootDurableRuntimeLayer(
                            makeSqliteLayer({
                              filename: root.paths.runtimeDatabase,
                            }),
                            application.actions,
                            root.laborer.root
                          )
                        );
                        return yield* RootDurableRuntime.pipe(
                          Effect.provide(context)
                        );
                      }),
                      () =>
                        Effect.sync(() => {
                          rootRuntimeFinalizations.set(
                            root.paths.root,
                            (rootRuntimeFinalizations.get(root.paths.root) ??
                              0) + 1
                          );
                        })
                    );
                  },
                  rootRuntimeCreations,
                  rootRuntimeObservations,
                  runners: new Map(),
                  setupReplies: [],
                  statePaths: new Map(),
                  stores: new Map(),
                }),
                config,
                environment,
              });
              yield* Effect.all([
                routeDirectory.awaitReady(firstIdentity.teamId),
                routeDirectory.awaitReady(secondIdentity.teamId),
                routeDirectory.awaitReady(thirdIdentity.teamId),
              ]);
              const firstRuntime = rootRuntimeObservations.get(
                firstIdentity.teamId
              );
              const secondRuntime = rootRuntimeObservations.get(
                secondIdentity.teamId
              );
              const thirdRuntime = rootRuntimeObservations.get(
                thirdIdentity.teamId
              );
              assert.ok(firstRuntime);
              assert.ok(secondRuntime);
              assert.ok(thirdRuntime);
              assert.strictEqual(firstRuntime, secondRuntime);
              assert.notStrictEqual(firstRuntime, thirdRuntime);

              const sharedConversation = "conversation:same-local-id";
              const sharedRequest = {
                actionName: sharedAction.name,
                conversationId: sharedConversation,
                input: { label: "first" },
                invocationId: "invocation:same-local-id",
                rootIdentity: sharedRoot,
                workspaceId: firstIdentity.teamId,
              } as const;
              const firstExecution =
                yield* firstRuntime.startExecution(sharedRequest);
              const secondExecution = yield* secondRuntime.startExecution({
                ...sharedRequest,
                input: { label: "second" },
                workspaceId: secondIdentity.teamId,
              });
              const thirdExecution = yield* thirdRuntime.startExecution({
                actionName: distinctAction.name,
                conversationId: sharedConversation,
                input: { value: 3 },
                invocationId: "invocation:same-local-id",
                rootIdentity: distinctRoot,
                workspaceId: thirdIdentity.teamId,
              });
              const failedExecution = yield* thirdRuntime.startExecution({
                actionName: distinctFailure.name,
                conversationId: "conversation:distinct-failure",
                input: { fail: true },
                invocationId: "invocation:distinct-failure",
                rootIdentity: distinctRoot,
                workspaceId: thirdIdentity.teamId,
              });
              assert.notStrictEqual(
                firstExecution.executionId,
                secondExecution.executionId
              );
              const replayedFirst =
                yield* firstRuntime.startExecution(sharedRequest);
              assert.strictEqual(
                replayedFirst.executionId,
                firstExecution.executionId
              );
              for (const [runtime, execution, workspaceId] of [
                [firstRuntime, firstExecution, firstIdentity.teamId],
                [secondRuntime, secondExecution, secondIdentity.teamId],
              ] as const) {
                for (let attempt = 0; attempt < 500; attempt += 1) {
                  const current = yield* runtime.getExecution(
                    execution.executionId,
                    sharedConversation,
                    workspaceId
                  );
                  if (current.status === "running") {
                    break;
                  }
                  yield* Effect.sleep("10 millis");
                }
              }
              const foreignInspection = yield* Effect.flip(
                secondRuntime.inspectExecution({
                  controlId: "inspect:foreign",
                  conversationId: sharedConversation,
                  executionId: firstExecution.executionId,
                  workspaceId: secondIdentity.teamId,
                })
              );
              assert.strictEqual(
                foreignInspection.reason,
                "execution-not-found"
              );
              const firstInspection = yield* firstRuntime.inspectExecution({
                controlId: "inspect:same-local-id",
                conversationId: sharedConversation,
                executionId: firstExecution.executionId,
                workspaceId: firstIdentity.teamId,
              });
              const secondInspection = yield* secondRuntime.inspectExecution({
                controlId: "inspect:same-local-id",
                conversationId: sharedConversation,
                executionId: secondExecution.executionId,
                workspaceId: secondIdentity.teamId,
              });
              assert.strictEqual(firstInspection.deduplicated, false);
              assert.strictEqual(secondInspection.deduplicated, false);
              yield* firstRuntime.followUpExecution({
                content: "keep the first workspace moving",
                controlId: "follow-up:same-local-id",
                conversationId: sharedConversation,
                executionId: firstExecution.executionId,
                workspaceId: firstIdentity.teamId,
              });
              yield* secondRuntime.cancelExecution({
                controlId: "cancel:same-local-id",
                conversationId: sharedConversation,
                executionId: secondExecution.executionId,
                workspaceId: secondIdentity.teamId,
              });
              const unavailableAcrossRoots = yield* Effect.flip(
                thirdRuntime.startExecution({
                  ...sharedRequest,
                  rootIdentity: distinctRoot,
                  workspaceId: thirdIdentity.teamId,
                })
              );
              assert.strictEqual(
                unavailableAcrossRoots.reason,
                "unavailable-action"
              );
              yield* Deferred.succeed(releaseShared, undefined);
              yield* Deferred.succeed(releaseDistinct, undefined);
              for (const [
                runtime,
                execution,
                conversationId,
                workspaceId,
                terminalStatus,
              ] of [
                [
                  firstRuntime,
                  firstExecution,
                  sharedConversation,
                  firstIdentity.teamId,
                  "completed",
                ],
                [
                  secondRuntime,
                  secondExecution,
                  sharedConversation,
                  secondIdentity.teamId,
                  "cancelled",
                ],
                [
                  thirdRuntime,
                  thirdExecution,
                  sharedConversation,
                  thirdIdentity.teamId,
                  "completed",
                ],
                [
                  thirdRuntime,
                  failedExecution,
                  "conversation:distinct-failure",
                  thirdIdentity.teamId,
                  "failed",
                ],
              ] as const) {
                let status = "queued";
                for (let attempt = 0; attempt < 500; attempt += 1) {
                  status = (yield* runtime.getExecution(
                    execution.executionId,
                    conversationId,
                    workspaceId
                  )).status;
                  if (status === terminalStatus) {
                    break;
                  }
                  yield* Effect.sleep("10 millis");
                }
                assert.strictEqual(status, terminalStatus);
              }
              assert.deepStrictEqual(observedControls, [
                `follow-up:${firstIdentity.teamId}:keep the first workspace moving`,
                `cancel:${secondIdentity.teamId}`,
              ]);
              const firstEvents = yield* firstRuntime.pendingEvents(
                sharedConversation,
                firstIdentity.teamId
              );
              const secondEvents = yield* secondRuntime.pendingEvents(
                sharedConversation,
                secondIdentity.teamId
              );
              assert.ok(
                firstEvents.every(
                  (event) => event.executionId === firstExecution.executionId
                )
              );
              assert.ok(
                secondEvents.every(
                  (event) => event.executionId === secondExecution.executionId
                )
              );
            })
          );

          const sharedPaths = yield* prepareSlackRuntimePaths(sharedRoot);
          const distinctPaths = yield* prepareSlackRuntimePaths(distinctRoot);
          assert.strictEqual(rootRuntimeCreations.get(sharedPaths.root), 1);
          assert.strictEqual(rootRuntimeCreations.get(distinctPaths.root), 1);
          assert.strictEqual(lockAcquisitions.get(sharedPaths.root), 1);
          assert.strictEqual(lockAcquisitions.get(distinctPaths.root), 1);
          assert.strictEqual(lockFinalizations.get(sharedPaths.root), 1);
          assert.strictEqual(lockFinalizations.get(distinctPaths.root), 1);
          assert.strictEqual(rootRuntimeFinalizations.get(sharedPaths.root), 1);
          assert.strictEqual(
            rootRuntimeFinalizations.get(distinctPaths.root),
            1
          );
          assert.strictEqual(
            legacyWorkspaceIds.get(sharedPaths.root),
            undefined
          );
          assert.strictEqual(
            legacyWorkspaceIds.get(distinctPaths.root),
            undefined
          );
          assert.notStrictEqual(
            databasePaths.get(sharedPaths.root),
            databasePaths.get(distinctPaths.root)
          );
        })
      ),
    30_000
  );

  it.live(
    "starts isolated roots, quarantines bad bindings and token swaps, and recovers after restart",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const anchor = yield* makeTempDirectoryScoped(
            "laborer-multi-startup-"
          );
          const firstRoot = join(anchor, "first-root");
          const secondRoot = join(anchor, "second-root");
          const missingRoot = join(anchor, "missing-root");
          yield* createLaborerRoot(firstRoot);
          yield* createLaborerRoot(secondRoot);

          const firstToken = fixtureToken("first");
          const secondToken = fixtureToken("second");
          const swappedToken = fixtureToken("swapped");
          const unboundToken = fixtureToken("unbound");
          const environment = {
            LABORER_SLACK_WORKSPACES: JSON.stringify([
              {
                botTokenEnvironment: "SLACK_BOT_TOKEN_MALFORMED",
                root: 42,
                teamId: "TMALFORMED",
              },
              {
                botTokenEnvironment: "SLACK_BOT_TOKEN_FIRST",
                root: firstRoot,
                teamId: firstIdentity.teamId,
              },
              {
                botTokenEnvironment: "SLACK_BOT_TOKEN_SECOND",
                root: secondRoot,
                teamId: secondIdentity.teamId,
              },
              {
                botTokenEnvironment: "SLACK_BOT_TOKEN_SWAPPED",
                root: secondRoot,
                teamId: "TSWAPPED",
              },
              {
                botTokenEnvironment: "SLACK_BOT_TOKEN_UNBOUND",
                root: missingRoot,
                teamId: unboundIdentity.teamId,
              },
            ]),
            PATH: process.env.PATH,
            SLACK_APP_TOKEN: ["x", "app", "-fixture"].join(""),
            SLACK_BOT_TOKEN_FIRST: firstToken,
            SLACK_BOT_TOKEN_MALFORMED: fixtureToken("malformed"),
            SLACK_BOT_TOKEN_SECOND: secondToken,
            SLACK_BOT_TOKEN_SWAPPED: swappedToken,
            SLACK_BOT_TOKEN_UNBOUND: unboundToken,
          };
          const config = yield* loadSlackDaemonConfig({
            defaultRoot: "/unused",
            environment,
          });
          assert.strictEqual(
            config.installations[0]?.validation._tag,
            "Invalid"
          );

          const identitiesByToken = new Map([
            [firstToken, firstIdentity],
            [secondToken, secondIdentity],
            [swappedToken, firstIdentity],
            [unboundToken, unboundIdentity],
          ]);
          const firstAttempts: string[] = [];
          const secondAttempts: string[] = [];
          const firstStarted = yield* Deferred.make<void>();
          const secondFinished = yield* Deferred.make<void>();
          const setupReplyObserved = yield* Deferred.make<void>();

          yield* Effect.scoped(
            Effect.gen(function* () {
              const stores = new Map<string, PrototypeStoreShape>();
              const runners = new Map<string, Runner>();
              const statePaths = new Map<string, string>();
              const gatewayTeams: string[] = [];
              const setupReplies: {
                readonly teamId: string;
                readonly text: string;
              }[] = [];
              const handlerFor = (teamId: string): WorkHandlerShape => ({
                invoke: (turn) => {
                  if (teamId === firstIdentity.teamId) {
                    return Effect.sync(() =>
                      firstAttempts.push(turn.threadId)
                    ).pipe(
                      Effect.andThen(Deferred.succeed(firstStarted, undefined)),
                      Effect.andThen(Effect.never)
                    );
                  }
                  return Effect.sync(() =>
                    secondAttempts.push(turn.threadId)
                  ).pipe(
                    Effect.andThen(Deferred.succeed(secondFinished, undefined)),
                    Effect.asVoid
                  );
                },
              });
              const routeDirectory = yield* startSlackWorkspaceDirectory({
                adapter: makeTestStartupAdapter({
                  gatewayTeams,
                  handlerFor,
                  identitiesByToken,
                  runners,
                  setupReplies,
                  setupReplyObserved,
                  statePaths,
                  stores,
                }),
                config,
                environment,
              });
              yield* Effect.all([
                routeDirectory.awaitReady(firstIdentity.teamId),
                routeDirectory.awaitReady(secondIdentity.teamId),
                routeDirectory.awaitAvailable(unboundIdentity.teamId),
              ]);
              assert.strictEqual(
                (yield* routeDirectory.resolve(unboundIdentity.teamId))._tag,
                "Unavailable"
              );
              assert.strictEqual(
                (yield* routeDirectory.resolve("TUNKNOWN"))._tag,
                "Unknown"
              );
              const routes = yield* routeDirectory.snapshot;
              assert.deepStrictEqual(
                routes.map((route) => route.identity.teamId).sort(),
                [
                  firstIdentity.teamId,
                  secondIdentity.teamId,
                  unboundIdentity.teamId,
                ].sort()
              );
              assert.deepStrictEqual(gatewayTeams.sort(), [
                firstIdentity.teamId,
                secondIdentity.teamId,
                unboundIdentity.teamId,
              ]);
              assert.strictEqual(
                routes.find(
                  (route) => route.identity.teamId === firstIdentity.teamId
                )?.runner === undefined,
                false
              );

              const client = new FakeSocketModeClient();
              yield* startSocketModeAdapter({ client, routeDirectory });
              for (const identity of [
                firstIdentity,
                secondIdentity,
                unboundIdentity,
              ]) {
                client.emit({
                  ack: () => Promise.resolve(),
                  body: makeSlackEventCallback({
                    botUserId: identity.botUserId,
                    teamId: identity.teamId,
                  }),
                });
              }
              yield* Deferred.await(firstStarted);
              yield* Deferred.await(secondFinished);
              yield* Deferred.await(setupReplyObserved);

              const secondRunner = runners.get(secondIdentity.teamId);
              assert.ok(secondRunner);
              yield* secondRunner.drain(
                ThreadId.make("workspace:TSECOND:CSHARED:1.0")
              );
              const firstState = yield* snapshotFor(
                stores,
                firstIdentity.teamId
              );
              const secondState = yield* snapshotFor(
                stores,
                secondIdentity.teamId
              );
              assert.strictEqual(
                firstState.threads[0]?.turns[0]?.status,
                "running"
              );
              assert.strictEqual(
                secondState.threads[0]?.turns[0]?.status,
                "completed"
              );
              assert.notStrictEqual(
                statePaths.get(firstIdentity.teamId),
                statePaths.get(secondIdentity.teamId)
              );
              assert.ok(
                statePaths.get(firstIdentity.teamId)?.startsWith(firstRoot)
              );
              assert.ok(
                statePaths.get(secondIdentity.teamId)?.startsWith(secondRoot)
              );
              assert.strictEqual(stores.has(unboundIdentity.teamId), false);
              assert.deepStrictEqual(setupReplies, [
                {
                  teamId: unboundIdentity.teamId,
                  text: SETUP_INCOMPLETE_REPLY,
                },
              ]);
              assert.strictEqual(client.starts, 1);
            })
          );

          const recovered = yield* Deferred.make<void>();
          yield* Effect.scoped(
            Effect.gen(function* () {
              const stores = new Map<string, PrototypeStoreShape>();
              const runners = new Map<string, Runner>();
              const routeDirectory = yield* startSlackWorkspaceDirectory({
                adapter: makeTestStartupAdapter({
                  gatewayTeams: [],
                  handlerFor: (teamId) => ({
                    invoke: (turn) =>
                      Effect.sync(() => {
                        if (teamId === firstIdentity.teamId) {
                          firstAttempts.push(turn.threadId);
                        }
                      }).pipe(
                        Effect.andThen(
                          teamId === firstIdentity.teamId
                            ? Deferred.succeed(recovered, undefined)
                            : Effect.void
                        ),
                        Effect.asVoid
                      ),
                  }),
                  identitiesByToken,
                  runners,
                  setupReplies: [],
                  statePaths: new Map(),
                  stores,
                }),
                config,
                environment,
              });
              yield* Deferred.await(recovered);
              yield* routeDirectory.awaitReady(secondIdentity.teamId);
              const firstRunner = runners.get(firstIdentity.teamId);
              assert.ok(firstRunner);
              yield* firstRunner.drain(
                ThreadId.make("workspace:TFIRST:CSHARED:1.0")
              );
              const firstState = yield* snapshotFor(
                stores,
                firstIdentity.teamId
              );
              const secondState = yield* snapshotFor(
                stores,
                secondIdentity.teamId
              );
              assert.strictEqual(
                firstState.threads[0]?.turns[0]?.status,
                "completed"
              );
              assert.strictEqual(
                secondState.threads[0]?.turns[0]?.status,
                "completed"
              );
              assert.deepStrictEqual(firstState.seenEventIds, [
                EventId.make("workspace:TFIRST:event:EvShared"),
              ]);
            })
          );
          assert.deepStrictEqual(firstAttempts, [
            "workspace:TFIRST:CSHARED:1.0",
            "workspace:TFIRST:CSHARED:1.0",
          ]);
          assert.deepStrictEqual(secondAttempts, [
            "workspace:TSECOND:CSHARED:1.0",
          ]);
        })
      )
  );

  it.effect(
    "replies setup-incomplete for an authenticated workspace without activating it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const client = new FakeSocketModeClient();
          const reply = yield* Deferred.make<string>();
          yield* startSocketModeAdapter({
            client,
            installations: [
              {
                identity: firstIdentity,
                namespaceWorkspace: true,
                postSetupIncomplete: ({ text }) =>
                  Deferred.succeed(reply, text).pipe(Effect.asVoid),
              },
            ],
          });
          client.emit({
            ack: () => Promise.resolve(),
            body: makeSlackEventCallback({
              botUserId: firstIdentity.botUserId,
              teamId: firstIdentity.teamId,
            }),
          });
          assert.strictEqual(
            yield* Deferred.await(reply),
            SETUP_INCOMPLETE_REPLY
          );
        })
      )
  );
}, 30_000);
