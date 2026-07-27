/** Dedicated live canary using the production ACP workspace runtime. */
import { fileURLToPath } from "node:url";
import {
  type Logger as SocketLogger,
  LogLevel as SocketLogLevel,
  SocketModeClient,
} from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { Console, Effect, Redacted } from "effect";
import { slackConversationStreamDeliveryPolicy } from "../prototype/conversation-stream-delivery.ts";
import { makeSlackGateway } from "../prototype/emulated-slack.ts";
import { makeAcpSlackWorkspaceRunner } from "../slack/acp-workspace-runner.ts";
import { loadAcpCanarySlackConfig } from "../slack/config.ts";
import { authenticateSlackBot } from "../slack/identity.ts";
import { loadLaborerConfig } from "../slack/laborer-config.ts";
import { makeSlackNativeStreamCapability } from "../slack/native-stream.ts";
import { prepareSlackRuntimePaths } from "../slack/runtime-paths.ts";
import { startSocketModeAdapter } from "../slack/socket-mode.ts";
import { slackWebApiRequestPolicy } from "../slack/web-api-request-policy.ts";

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
    ...slackWebApiRequestPolicy,
  });
  const identity = yield* authenticateSlackBot(botClient);
  const gateway = makeSlackGateway({
    botClient,
    botId: identity.botId,
    botUserId: identity.botUserId,
    conversationStreamDeliveryPolicy: slackConversationStreamDeliveryPolicy,
    nativeStreaming: makeSlackNativeStreamCapability({
      client: botClient.chat,
      recipientTeamId: identity.teamId,
    }),
    pageSize: 100,
    workspaceId: identity.teamId,
  });
  const paths = yield* prepareSlackRuntimePaths(
    laborer.root,
    `acp-canary:${identity.teamId}`
  );
  const runner = yield* makeAcpSlackWorkspaceRunner({
    client: botClient,
    gateway,
    identity,
    laborer,
    paths,
  });
  const socketClient = new SocketModeClient({
    appToken: Redacted.value(config.appToken),
    logger: silentSocketLogger,
  });
  yield* startSocketModeAdapter({
    client: socketClient,
    identity,
    runner,
  });
  yield* Console.log(
    `LIVE ACP CANARY — production ACP runtime in isolated state for ${laborer.root}; Ctrl-C to stop.`
  );
  yield* waitForShutdownSignal;
  yield* Console.log("Live ACP canary stopped cleanly.");
}).pipe(Effect.scoped);

await Effect.runPromise(program);
