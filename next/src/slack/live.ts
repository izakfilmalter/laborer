import { Console, Effect } from "effect";
import { loadSlackDaemonConfig } from "./config.ts";
import {
  acquireLiveSlackClientGeneration,
  LIVE_SLACK_PROJECT_ROOT,
} from "./live-generation.ts";

const DEFAULT_LABORER_ROOT =
  process.env.LABORER_ROOT ?? LIVE_SLACK_PROJECT_ROOT;

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
  yield* acquireLiveSlackClientGeneration(config, DEFAULT_LABORER_ROOT);
  yield* Console.log("LIVE SLACK LABORER — durable ACP Conversations enabled.");
  yield* waitForShutdownSignal;
  yield* Console.log("Slack Laborer stopped cleanly.");
}).pipe(Effect.scoped);

await Effect.runPromise(program);
