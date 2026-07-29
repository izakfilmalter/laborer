import { fileURLToPath } from "node:url";
import {
  type Logger as SocketLogger,
  LogLevel as SocketLogLevel,
  SocketModeClient,
} from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { Console, Effect, Redacted } from "effect";
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
import { loadSlackDaemonConfig } from "./config.ts";
import { authenticateSlackBot } from "./identity.ts";
import { makeSlackNativeStreamCapability } from "./native-stream.ts";
import { prepareSlackRuntimePaths } from "./runtime-paths.ts";
import { startSocketModeAdapter } from "./socket-mode.ts";
import { slackWebApiRequestPolicy } from "./web-api-request-policy.ts";
import { startSlackWorkspaceDirectory } from "./workspace-startup.ts";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DEFAULT_LABORER_ROOT = process.env.LABORER_ROOT ?? PROJECT_ROOT;

const silentSocketLogger: SocketLogger = {
  debug: () => undefined,
  error: () => undefined,
  getLevel: () => SocketLogLevel.ERROR,
  info: () => undefined,
  setLevel: () => undefined,
  setName: () => undefined,
  warn: () => undefined,
};

const waitForShutdownSignal: Effect.Effect<void> = Effect.callback((resume) => {
  const stop = () => resume(Effect.void);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return Effect.sync(() => {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  });
});

const program = Effect.gen(function* () {
  const config = yield* loadSlackDaemonConfig({
    defaultRoot: DEFAULT_LABORER_ROOT,
  });
  const daemonRuntime = yield* prepareSlackRuntimePaths(DEFAULT_LABORER_ROOT);
  yield* Effect.acquireRelease(
    Effect.tryPromise(() =>
      startOperatorStatusServer({
        paths: operatorStatusPaths(daemonRuntime.root),
        version: LABORER_VERSION,
      })
    ),
    (server) => Effect.promise(() => server.close()).pipe(Effect.orDie)
  );
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
  });
  const socketClient = new SocketModeClient({
    appToken: Redacted.value(config.appToken),
    logger: silentSocketLogger,
  });
  yield* startSocketModeAdapter({
    client: socketClient,
    routeDirectory,
  });
  yield* Console.log("LIVE SLACK LABORER — durable ACP Conversations enabled.");
  yield* waitForShutdownSignal;
  yield* Console.log("Slack Laborer stopped cleanly.");
}).pipe(Effect.scoped);

await Effect.runPromise(program);
