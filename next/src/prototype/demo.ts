/** THROWAWAY ISSUE #204 PROTOTYPE one-command demo. */
import { Console, Effect } from "effect";
import { startEmulatedSlack } from "./emulated-slack.ts";
import {
  fixtureHandlerOptions,
  makeProcessHandler,
} from "./process-handler.ts";
import { makePrototypeHarness } from "./runtime.ts";
import { LABORER_SLACK_ID, runTracerScenario } from "./scenario.ts";

const printJson = (label: string, value: unknown): Effect.Effect<void> =>
  Console.log(`\n=== ${label} ===\n${JSON.stringify(value, null, 2)}`);

const program = Effect.gen(function* () {
  const fixture = yield* startEmulatedSlack();
  yield* Console.log(
    "THROWAWAY ISSUE #204 PROTOTYPE — injected ingress + Emulate HTTP + fresh child processes"
  );
  yield* Console.log(`Emulate inspector: ${fixture.emulator.url}`);
  const processHandler = yield* makeProcessHandler(
    fixtureHandlerOptions(process.cwd())
  );
  const harness = yield* makePrototypeHarness({
    laborerSlackId: LABORER_SLACK_ID,
    slack: fixture.gateway,
    handler: processHandler.handler,
  });
  const result = yield* runTracerScenario({
    fixture,
    harness,
    onCheckpoint: printJson,
  });
  yield* printJson("process evidence", yield* processHandler.snapshot);
  yield* printJson("Emulate-backed Slack thread", result.threadMessages);
  yield* Console.log(
    "\nVERDICT TARGET: durable-state claims, FIFO per thread, fresh processes, explicit NDJSON replies, distinct bot actor."
  );
}).pipe(Effect.scoped);

await Effect.runPromise(program);
