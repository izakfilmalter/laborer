/** THROWAWAY PROTOTYPE: Effect CLI over the proposed Action catalog. */
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, Schema, Stdio, Stream } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import {
  advanceExecution,
  describeAction,
  getExecution,
  listActions,
  resetDemo,
  runDemo,
  showAgentInstructions,
  startAction,
} from "./prototype-runtime.ts";

const printJson = (value: unknown) =>
  Console.log(JSON.stringify(value, null, 2));

const readJsonFromStdin = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  const input = yield* stdio.stdin.pipe(
    Stream.decodeText,
    Stream.runFold(
      () => "",
      (accumulator, chunk) => accumulator + chunk
    )
  );
  return yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Unknown)
  )(input);
});

const root = Command.make("laborer-actions").pipe(
  Command.withDescription("Explore the throwaway user-authored Action API")
);

const demo = Command.make(
  "demo",
  {},
  Effect.fn(function* () {
    yield* runDemo;
  })
).pipe(Command.withDescription("Run the complete proposed interaction"));

const actionName = Argument.string("action");
const executionId = Argument.string("execution-id");

const list = Command.make(
  "list",
  {},
  Effect.fn(function* () {
    yield* printJson(yield* listActions);
  })
).pipe(Command.withDescription("List registered Actions"));

const describe = Command.make(
  "describe",
  { actionName },
  Effect.fn(function* ({ actionName: name }) {
    yield* printJson(yield* describeAction(name));
  })
).pipe(Command.withDescription("Describe one registered Action"));

const instructions = Command.make(
  "instructions",
  {},
  Effect.fn(function* () {
    yield* printJson(yield* showAgentInstructions);
  })
).pipe(Command.withDescription("Show optional model-facing instructions"));

const start = Command.make(
  "start",
  { actionName },
  Effect.fn(function* ({ actionName: name }) {
    const input = yield* readJsonFromStdin;
    yield* printJson(yield* startAction(name, input));
  })
).pipe(Command.withDescription("Durably accept one Action invocation"));

const get = Command.make(
  "get",
  { executionId },
  Effect.fn(function* ({ executionId: id }) {
    yield* printJson(yield* getExecution(id));
  })
).pipe(Command.withDescription("Read one bounded Execution snapshot"));

const advance = Command.make(
  "advance",
  { executionId },
  Effect.fn(function* ({ executionId: id }) {
    yield* printJson(yield* advanceExecution(id));
  })
).pipe(
  Command.withDescription(
    "PROTOTYPE ONLY: stand in for the separately owned execution runtime"
  )
);

const reset = Command.make(
  "reset",
  {},
  Effect.fn(function* () {
    yield* resetDemo;
    yield* printJson({ reset: true });
  })
).pipe(Command.withDescription("Delete the prototype scratch state"));

root.pipe(
  Command.withSubcommands([
    list,
    describe,
    instructions,
    start,
    get,
    advance,
    reset,
    demo,
  ]),
  Command.run({ version: "0.0.0-prototype" }),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain
);
