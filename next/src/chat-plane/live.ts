/** Dedicated canary composition for the Chat SDK Slack plane. */

import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { Console, Effect, Redacted } from "effect";
import { loadChatCanarySlackConfig } from "../slack/config.ts";
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
  const config = yield* loadChatCanarySlackConfig();
  const xdgStateHome = process.env.XDG_STATE_HOME?.trim();
  const layer = makeLiveChatPlaneLayer(
    {
      appToken: Redacted.value(config.appToken),
      botToken: Redacted.value(config.botToken),
      statePath: resolve(
        xdgStateHome !== undefined && isAbsolute(xdgStateHome)
          ? xdgStateHome
          : resolve(homedir(), ".local", "state"),
        "laborer",
        "chat-plane.sqlite"
      ),
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
