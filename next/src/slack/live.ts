import { fileURLToPath } from "node:url";
import {
  type Logger as SocketLogger,
  LogLevel as SocketLogLevel,
  SocketModeClient,
} from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { Console, Effect, Redacted } from "effect";
import {
  makeSlackActivationAcknowledger,
  makeSlackGateway,
} from "../prototype/emulated-slack.ts";
import { makeProcessHandler } from "../prototype/process-handler.ts";
import { makePrototypeHarness } from "../prototype/runtime.ts";
import { makeFileStoreLayer } from "../prototype/store.ts";
import { loadSlackConfig } from "./config.ts";
import { environmentForConfiguredHandler } from "./handler-environment.ts";
import { authenticateSlackBot } from "./identity.ts";
import { loadLaborerConfig } from "./laborer-config.ts";
import { acquireRunnerLock } from "./runner-lock.ts";
import { prepareSlackRuntimePaths } from "./runtime-paths.ts";
import { startSocketModeAdapter } from "./socket-mode.ts";

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
  const laborer = yield* loadLaborerConfig({ defaultRoot: PROJECT_ROOT });
  const config = yield* loadSlackConfig;
  const paths = yield* prepareSlackRuntimePaths(laborer.root);
  yield* acquireRunnerLock(paths.root, paths.lock);
  const botToken = Redacted.value(config.botToken);
  const botClient = new WebClient(botToken, {
    logger: silentSocketLogger,
    rejectRateLimitedCalls: true,
  });
  const identity = yield* authenticateSlackBot(botClient);
  const processHandler = yield* makeProcessHandler({
    args: laborer.config.workHandler.args,
    command: laborer.config.workHandler.command,
    cwd: laborer.root,
    environment: environmentForConfiguredHandler(
      process.env,
      laborer.config.workHandler.environment
    ),
    evidence: { mode: "production" },
    stateRoot: paths.workThreads,
    stateRootAnchor: paths.root,
  });
  const harness = yield* makePrototypeHarness({
    activationAcknowledger: makeSlackActivationAcknowledger(botClient),
    handler: processHandler.handler,
    laborerSlackId: identity.botUserId,
    slack: makeSlackGateway({
      botClient,
      botId: identity.botId,
      botUserId: identity.botUserId,
      pageSize: 100,
    }),
    storeLayer: makeFileStoreLayer(
      identity.botUserId,
      paths.snapshot,
      paths.root
    ),
  });
  const socketClient = new SocketModeClient({
    appToken: Redacted.value(config.appToken),
    logger: silentSocketLogger,
  });
  yield* startSocketModeAdapter({
    client: socketClient,
    identity,
    runner: harness.runner,
  });
  yield* Console.log("LIVE SLACK CONFIGURED HANDLER MODE — connected.");
  yield* waitForShutdownSignal;
  yield* Console.log("Slack configured handler mode stopped cleanly.");
}).pipe(Effect.scoped);

await Effect.runPromise(program);
