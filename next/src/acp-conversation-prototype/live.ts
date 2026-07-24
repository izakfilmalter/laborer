/** Explicitly opt-in live Slack/OpenCode ACP canary for issue #235. */
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
  makeSlackCompletionReactor,
  makeSlackGateway,
} from "../prototype/emulated-slack.ts";
import { loadAcpCanarySlackConfig } from "../slack/config.ts";
import { environmentForConfiguredHandler } from "../slack/handler-environment.ts";
import { authenticateSlackBot } from "../slack/identity.ts";
import { loadLaborerConfig } from "../slack/laborer-config.ts";
import { makeSlackNativeStreamCapability } from "../slack/native-stream.ts";
import { startSocketModeAdapter } from "../slack/socket-mode.ts";
import {
  makeAcpConversationCanary,
  openCodeAcpProcessOptions,
} from "./canary-composition.ts";

const DEFAULT_LABORER_ROOT = fileURLToPath(new URL("../..", import.meta.url));

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
  const laborer = yield* loadLaborerConfig({
    defaultRoot: DEFAULT_LABORER_ROOT,
  });
  const config = yield* loadAcpCanarySlackConfig();

  const botClient = new WebClient(Redacted.value(config.botToken), {
    logger: silentSocketLogger,
    rejectRateLimitedCalls: true,
  });
  const identity = yield* authenticateSlackBot(botClient);
  const gateway = makeSlackGateway({
    botClient,
    botId: identity.botId,
    botUserId: identity.botUserId,
    nativeStreaming: makeSlackNativeStreamCapability({
      client: botClient.chat,
      recipientTeamId: identity.teamId,
    }),
    pageSize: 100,
  });
  const optedInEnvironment = laborer.config.application?.environment ?? [];
  const harness = yield* makeAcpConversationCanary({
    activationAcknowledger: makeSlackActivationAcknowledger(botClient),
    completionReactor: makeSlackCompletionReactor(botClient),
    laborerSlackId: identity.botUserId,
    process: openCodeAcpProcessOptions({
      cwd: laborer.root,
      environment: environmentForConfiguredHandler(
        process.env,
        optedInEnvironment
      ),
    }),
    slack: gateway,
    workspaceId: identity.teamId,
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
  yield* Console.log(
    `LIVE ACP CANARY — OpenCode ACP in ${laborer.root}; Ctrl-C to stop.`
  );
  yield* waitForShutdownSignal;
  yield* Console.log("Live ACP canary stopped cleanly.");
}).pipe(Effect.scoped);

await Effect.runPromise(program);
