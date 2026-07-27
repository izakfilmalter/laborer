import { BunRuntime } from "@effect/platform-bun";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Console, Effect, Layer, Ref, Schema } from "effect";
import {
  defineRegisteredAction,
  makeRegisteredActionCatalog,
} from "../../src/cluster-runtime/registered-action.ts";
import {
  type ConversationTerminalEvent,
  makeRegisteredActionRuntimeLayer,
  RegisteredActionRuntime,
} from "../../src/cluster-runtime/registered-action-runtime.ts";

const databasePath = process.argv[2];
if (databasePath === undefined) {
  throw new Error("missing SQLite path");
}

const eventually = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  predicate: (value: A) => boolean
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const value = yield* effect;
      if (predicate(value)) {
        return value;
      }
      yield* Effect.sleep("10 millis");
    }
    return yield* Effect.die("timed out waiting for registered Action");
  });

const action = defineRegisteredAction({
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: false,
  },
  description: "Forge an arbitrary bounded widget.",
  input: Schema.Struct({
    quantity: Schema.Int.check(
      Schema.isGreaterThan(0),
      Schema.isLessThanOrEqualTo(10)
    ),
    widget: Schema.NonEmptyString.check(Schema.isMaxLength(32)),
  }),
  name: "forge-fixture-widget",
  result: Schema.Struct({
    artifact: Schema.NonEmptyString.check(Schema.isMaxLength(64)),
  }),
  revision: "forge-fixture-widget/2026-07-27",
  run: (input, context) =>
    Effect.gen(function* () {
      yield* context.reportProgress({
        details: { quantity: input.quantity },
        message: "Fixture forge claimed the work.",
      });
      if (input.widget === "invalid-result") {
        return { artifact: 42 } as unknown as { readonly artifact: string };
      }
      return { artifact: `${input.widget}:${input.quantity}` };
    }),
});
const catalog = makeRegisteredActionCatalog([action]);
const sqliteLayer = SqliteClient.layer({ filename: databasePath });

const program = Effect.gen(function* () {
  const terminalEvents = yield* Ref.make<ConversationTerminalEvent[]>([]);
  const runtimeLayer = makeRegisteredActionRuntimeLayer({
    catalog,
    deliverTerminal: (event) =>
      Ref.update(terminalEvents, (events) =>
        events.some(({ eventId }) => eventId === event.eventId)
          ? events
          : [...events, event]
      ),
  }).pipe(Layer.provideMerge(sqliteLayer));

  yield* Effect.gen(function* () {
    const runtime = yield* RegisteredActionRuntime;
    const invalid = yield* Effect.result(
      runtime.start({
        actionName: action.name,
        conversationId: "workspace:T270:channel:C270:thread:270.1",
        input: { quantity: 0, widget: "anvil" },
        invocationId: "invocation-invalid",
      })
    );
    const request = {
      actionName: action.name,
      conversationId: "workspace:T270:channel:C270:thread:270.1",
      input: { quantity: 3, widget: "anvil" },
      invocationId: "invocation-270",
    } as const;
    const accepted = yield* runtime.start(request);
    const replay = yield* runtime.start(request);
    const conflict = yield* Effect.result(
      runtime.start({
        ...request,
        input: { quantity: 4, widget: "anvil" },
      })
    );
    const completed = yield* eventually(
      runtime.get(accepted.executionId),
      ({ status }) => status === "succeeded"
    );
    const delivered = yield* eventually(
      Ref.get(terminalEvents),
      (events) => events.length === 1
    );
    const malformedAccepted = yield* runtime.start({
      ...request,
      input: { quantity: 1, widget: "invalid-result" },
      invocationId: "invocation-invalid-result",
    });
    const malformed = yield* eventually(
      runtime.get(malformedAccepted.executionId),
      ({ status }) => status === "failed"
    );
    const allDelivered = yield* eventually(
      Ref.get(terminalEvents),
      (events) => events.length === 2
    );
    yield* Console.log(
      `REGISTERED_ACTION_EVIDENCE:${JSON.stringify({
        accepted,
        allDelivered,
        completed,
        conflict: conflict._tag,
        delivered,
        invalid: invalid._tag,
        malformed,
        privateTools: runtime.privateTools,
        replay,
      })}`
    );
  }).pipe(Effect.provide(runtimeLayer));
});

program.pipe(Effect.scoped, BunRuntime.runMain);
