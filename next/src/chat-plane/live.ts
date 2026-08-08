/** Dedicated canary composition for the Chat SDK Slack plane. */
import { Config, Console, Effect, Redacted } from "effect";
import { ChatPlane, makeLiveChatPlaneLayer } from "./chat-sdk.ts";
import { placeholderMentionHandler } from "./placeholder-handler.ts";

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
  const appToken = yield* Config.redacted(
    "LABORER_CHAT_CANARY_SLACK_APP_TOKEN"
  );
  const botToken = yield* Config.redacted(
    "LABORER_CHAT_CANARY_SLACK_BOT_TOKEN"
  );
  const layer = makeLiveChatPlaneLayer(
    {
      appToken: Redacted.value(appToken),
      botToken: Redacted.value(botToken),
      userName: "laborer",
    },
    placeholderMentionHandler
  );

  yield* Effect.gen(function* () {
    yield* ChatPlane;
    yield* Console.log(
      "LIVE CHAT SDK CANARY — Socket Mode connected; Ctrl-C to stop."
    );
    yield* waitForShutdownSignal;
  }).pipe(Effect.provide(layer), Effect.scoped);

  yield* Console.log("Live Chat SDK canary stopped cleanly.");
});

await Effect.runPromise(program);
