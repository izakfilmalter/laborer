/**
 * THROWAWAY ISSUE #217 CANARY.
 * One Node root owns peer conversation and execution runtimes; only the
 * execution RPC boundary is exposed over the local Unix socket.
 */

import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteClient } from "@effect/sql-sqlite-node";
import {
  type Logger as SocketLogger,
  LogLevel as SocketLogLevel,
  SocketModeClient,
} from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { Console, Effect, Layer, Redacted } from "effect";
import { makeSlackGateway } from "../prototype/emulated-slack.ts";
import { loadSlackConfig } from "../slack/config.ts";
import { SlackStartupError } from "../slack/errors.ts";
import { environmentForConfiguredHandler } from "../slack/handler-environment.ts";
import { authenticateSlackBot } from "../slack/identity.ts";
import { loadLaborerConfig } from "../slack/laborer-config.ts";
import { acquireRunnerLock } from "../slack/runner-lock.ts";
import { prepareSlackRuntimePaths } from "../slack/runtime-paths.ts";
import { startSocketModeAdapter } from "../slack/socket-mode.ts";
import { makeConversationRuntime } from "./conversation-runtime.ts";
import { makeExecutionRuntimeLayer } from "./execution-runtime.ts";
import { makeCanarySocketPath } from "./runtime-paths.ts";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ACTION_CLI_PATH = fileURLToPath(
  new URL("./action-cli.ts", import.meta.url)
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
  const gateway = makeSlackGateway({
    botClient,
    botId: identity.botId,
    botUserId: identity.botUserId,
    pageSize: 100,
  });

  const databasePath = resolve(
    paths.root,
    "conversation-execution-canary.sqlite"
  );
  const socketPath = makeCanarySocketPath(paths.root);
  yield* Effect.tryPromise({
    try: () => rm(socketPath, { force: true }),
    catch: () =>
      SlackStartupError.make({
        operation: "prepare-canary-socket",
        reason: "stale-socket-unavailable",
      }),
  }).pipe(Effect.orDie);

  const baseEnvironment = environmentForConfiguredHandler(process.env);
  const sqliteLayer = SqliteClient.layer({ filename: databasePath });
  const executionLayer = makeExecutionRuntimeLayer({
    cwd: laborer.root,
    environment: baseEnvironment,
    socketPath,
  }).pipe(Layer.provideMerge(sqliteLayer));

  yield* Effect.gen(function* () {
    const conversation = yield* makeConversationRuntime({
      actionCliCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(ACTION_CLI_PATH)}`,
      baseEnvironment,
      botUserId: identity.botUserId,
      cwd: laborer.root,
      gateway,
      socketPath,
    });
    const socketClient = new SocketModeClient({
      appToken: Redacted.value(config.appToken),
      logger: silentSocketLogger,
    });
    yield* startSocketModeAdapter({
      client: socketClient,
      identity,
      runner: conversation,
    });
    yield* Console.log(
      "LIVE CONVERSATION/EXECUTION CANARY — connected; Ctrl-C to stop."
    );
    yield* waitForShutdownSignal;
    yield* Console.log("Live conversation/execution canary stopped cleanly.");
  }).pipe(Effect.provide(executionLayer));
}).pipe(Effect.scoped);

await Effect.runPromise(program);
