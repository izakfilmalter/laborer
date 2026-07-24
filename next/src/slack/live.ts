import { fileURLToPath } from "node:url";
import {
  type Logger as SocketLogger,
  LogLevel as SocketLogLevel,
  SocketModeClient,
} from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { Console, Effect, Redacted } from "effect";
import { makeSlackGateway } from "../prototype/emulated-slack.ts";
import { loadSlackDaemonConfig } from "./config.ts";
import { authenticateSlackBot } from "./identity.ts";
import { startSocketModeAdapter } from "./socket-mode.ts";
import { makeSlackWorkspaceRunner } from "./workspace-runner.ts";
import { startSlackWorkspaceDirectory } from "./workspace-startup.ts";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));

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
  const config = yield* loadSlackDaemonConfig({ defaultRoot: PROJECT_ROOT });
  const routeDirectory = yield* startSlackWorkspaceDirectory({
    adapter: {
      authenticate: authenticateSlackBot,
      makeClient: (botToken) =>
        new WebClient(botToken, {
          logger: silentSocketLogger,
          rejectRateLimitedCalls: true,
        }),
      makeGateway: ({ client, identity, namespaceWorkspace }) =>
        makeSlackGateway({
          botClient: client,
          botId: identity.botId,
          botUserId: identity.botUserId,
          pageSize: 100,
          ...(namespaceWorkspace ? { workspaceId: identity.teamId } : {}),
        }),
      makeRunner: makeSlackWorkspaceRunner,
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
  yield* Console.log("LIVE SLACK LABORER — receiver connected.");
  yield* waitForShutdownSignal;
  yield* Console.log("Slack Laborer stopped cleanly.");
}).pipe(Effect.scoped);

await Effect.runPromise(program);
