import { Effect } from "effect";
import { acquireRunnerLock } from "../../src/slack/runner-lock.ts";

const [runtimeRoot, lockPath] = process.argv.slice(2);
if (runtimeRoot === undefined || lockPath === undefined) {
  throw new Error("runner lock fixture requires runtime root and lock path");
}

const program = Effect.gen(function* () {
  yield* acquireRunnerLock(runtimeRoot, lockPath);
  process.send?.("ready");
  return yield* Effect.never;
}).pipe(Effect.scoped);

await Effect.runPromise(program);
