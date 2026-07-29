import { fileURLToPath } from "node:url";
import {
  type Logger as SocketLogger,
  LogLevel as SocketLogLevel,
  SocketModeClient,
} from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { Effect, Redacted, type Scope } from "effect";
import { makeNodeRootDurableRuntime } from "../durable-runtime/node-root.ts";
import { makeReferenceCodingRootApplication } from "../durable-runtime/reference-coding-application.ts";
import {
  operatorStatusPaths,
  startOperatorStatusServer,
} from "../operator-status/server.ts";
import { slackConversationStreamDeliveryPolicy } from "../prototype/conversation-stream-delivery.ts";
import { makeSlackGateway } from "../prototype/emulated-slack.ts";
import { LABORER_VERSION } from "../version.ts";
import { makeAcpSlackWorkspaceRunner } from "./acp-workspace-runner.ts";
import type { SlackDaemonConfig } from "./config.ts";
import { authenticateSlackBot } from "./identity.ts";
import { makeSlackNativeStreamCapability } from "./native-stream.ts";
import { prepareSlackRuntimePaths } from "./runtime-paths.ts";
import { startSocketModeAdapter } from "./socket-mode.ts";
import { slackWebApiRequestPolicy } from "./web-api-request-policy.ts";
import { makeWorkspaceBindingProjection } from "./workspace-binding-projection.ts";
import { startSlackWorkspaceDirectory } from "./workspace-startup.ts";

export const LIVE_SLACK_PROJECT_ROOT = fileURLToPath(
  new URL("../..", import.meta.url)
);

const silentSocketLogger: SocketLogger = {
  debug: () => undefined,
  error: () => undefined,
  getLevel: () => SocketLogLevel.ERROR,
  info: () => undefined,
  setLevel: () => undefined,
  setName: () => undefined,
  warn: () => undefined,
};

export interface LiveSlackClientGeneration {
  readonly quiesce: Effect.Effect<void, unknown>;
  readonly readyBindings: Effect.Effect<number>;
}

export const acquireLiveSlackClientGeneration = Effect.fn(
  "acquireLiveSlackClientGeneration"
)(function* (
  config: SlackDaemonConfig,
  projectRoot = LIVE_SLACK_PROJECT_ROOT,
  options: { readonly awaitWorkspacePreflight?: boolean } = {}
): Effect.fn.Return<LiveSlackClientGeneration, unknown, Scope.Scope> {
  const daemonRuntime = yield* prepareSlackRuntimePaths(projectRoot);
  const operatorProjection = makeWorkspaceBindingProjection(config);
  yield* Effect.acquireRelease(
    Effect.tryPromise(() =>
      startOperatorStatusServer({
        paths: operatorStatusPaths(daemonRuntime.root),
        projection: operatorProjection.snapshot,
        version: LABORER_VERSION,
      })
    ),
    (server) => Effect.promise(() => server.close()).pipe(Effect.orDie)
  );
  const settledBindings = new Set<number>();
  let settlePreflight: (() => void) | undefined;
  const preflightSettled = new Promise<void>((resolve) => {
    settlePreflight = resolve;
  });
  if (
    config.startupMode === "legacy" ||
    config.installations.length === 0 ||
    options.awaitWorkspacePreflight !== true
  ) {
    settlePreflight?.();
  }
  const routeDirectory = yield* startSlackWorkspaceDirectory({
    adapter: {
      authenticate: authenticateSlackBot,
      makeClient: (botToken) =>
        new WebClient(botToken, {
          logger: silentSocketLogger,
          ...slackWebApiRequestPolicy,
        }),
      makeGateway: ({ client, identity, namespaceWorkspace }) =>
        makeSlackGateway({
          botClient: client,
          botId: identity.botId,
          botUserId: identity.botUserId,
          conversationStreamDeliveryPolicy:
            slackConversationStreamDeliveryPolicy,
          nativeStreaming: makeSlackNativeStreamCapability({
            client: client.chat,
            recipientTeamId: identity.teamId,
          }),
          pageSize: 100,
          ...(namespaceWorkspace ? { workspaceId: identity.teamId } : {}),
        }),
      makeRootRuntime: ({ laborer, legacyWorkspaceId, paths }) =>
        Effect.gen(function* () {
          const applicationConfig = laborer.config.application;
          if (applicationConfig === undefined) {
            return yield* Effect.die(
              new Error(
                "Cluster runtime requires a registered user application"
              )
            );
          }
          const application = yield* makeReferenceCodingRootApplication({
            config: applicationConfig,
            environment: process.env,
            paths,
            root: laborer.root,
          });
          return yield* makeNodeRootDurableRuntime({
            application,
            databasePath: paths.runtimeDatabase,
            ...(legacyWorkspaceId === undefined ? {} : { legacyWorkspaceId }),
            rootIdentity: laborer.root,
          });
        }),
      makeRunner: makeAcpSlackWorkspaceRunner,
      makeSetupIncompleteResponder: (gateway) => (request) =>
        gateway.postThreadMessage(request).pipe(Effect.asVoid),
    },
    config,
    environment: process.env,
    observePreflight: (report) => {
      operatorProjection.observe(report);
      if (
        options.awaitWorkspacePreflight === true &&
        config.startupMode !== "legacy"
      ) {
        settledBindings.add(report.bindingIndex);
        if (settledBindings.size === config.installations.length) {
          settlePreflight?.();
        }
      }
    },
  });
  yield* Effect.promise(() => preflightSettled);
  const socketClient = new SocketModeClient({
    appToken: Redacted.value(config.appToken),
    logger: silentSocketLogger,
  });
  yield* startSocketModeAdapter({ client: socketClient, routeDirectory });
  operatorProjection.markReceiverConnected();
  return {
    quiesce: routeDirectory.snapshot.pipe(
      Effect.flatMap((installations) =>
        Effect.forEach(
          installations,
          (installation) => installation.runner?.quiesce ?? Effect.void,
          { concurrency: "unbounded", discard: true }
        )
      )
    ),
    readyBindings: routeDirectory.snapshot.pipe(
      Effect.map(
        (installations) =>
          installations.filter(
            (installation) => installation.runner !== undefined
          ).length
      )
    ),
  };
});
