import { BunRuntime } from "@effect/platform-bun";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Console, Effect, Layer, Ref, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
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
    requestedAt: Schema.DateFromString,
    widget: Schema.NonEmptyString.check(Schema.isMaxLength(32)),
  }),
  name: "forge-fixture-widget",
  result: Schema.Struct({
    artifact: Schema.NonEmptyString.check(Schema.isMaxLength(65_520)),
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
      if (input.widget === "oversized-result") {
        return { artifact: "x".repeat(65_400) };
      }
      return {
        artifact: `${input.widget}:${input.quantity}:${input.requestedAt.getUTCFullYear()}`,
      };
    }),
});
const interruptedNonIdempotentAction = defineRegisteredAction({
  annotations: {
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
    readOnlyHint: false,
  },
  description: "Interrupt one non-idempotent fixture invocation.",
  input: Schema.Struct({ reason: Schema.NonEmptyString }),
  name: "interrupt-one-shot-fixture",
  result: Schema.Struct({ completed: Schema.Boolean }),
  revision: "interrupt-one-shot-fixture/v1",
  run: () => Effect.interrupt,
});
const catalog = makeRegisteredActionCatalog([
  action,
  interruptedNonIdempotentAction,
]);
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
    const sql = yield* SqlClient;
    const invalid = yield* Effect.result(
      runtime.start({
        actionName: action.name,
        conversationId: "workspace:T270:channel:C270:thread:270.1",
        input: {
          quantity: 0,
          requestedAt: "2026-07-27T00:00:00.000Z",
          widget: "anvil",
        },
        invocationId: "invocation-invalid",
      })
    );
    const request = {
      actionName: action.name,
      conversationId: "workspace:T270:channel:C270:thread:270.1",
      input: {
        quantity: 3,
        requestedAt: "2026-07-27T00:00:00.000Z",
        widget: "anvil",
      },
      invocationId: "invocation-270",
    } as const;
    const starts = yield* Effect.all(
      [runtime.start(request), runtime.start(request)],
      { concurrency: "unbounded" }
    );
    const accepted = starts.find(({ deduplicated }) => !deduplicated);
    const replay = starts.find(({ deduplicated }) => deduplicated);
    if (accepted === undefined || replay === undefined) {
      return yield* Effect.die(
        "concurrent exact replay did not produce one durable acceptance"
      );
    }
    const conflict = yield* Effect.result(
      runtime.start({
        ...request,
        input: {
          quantity: 4,
          requestedAt: "2026-07-27T00:00:00.000Z",
          widget: "anvil",
        },
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
      input: {
        quantity: 1,
        requestedAt: "2026-07-27T00:00:00.000Z",
        widget: "invalid-result",
      },
      invocationId: "invocation-invalid-result",
    });
    const malformed = yield* eventually(
      runtime.get(malformedAccepted.executionId),
      ({ status }) => status === "failed"
    );
    const oversizedAccepted = yield* runtime.start({
      ...request,
      input: {
        quantity: 1,
        requestedAt: "2026-07-27T00:00:00.000Z",
        widget: "oversized-result",
      },
      invocationId: "invocation-oversized-result",
    });
    const oversized = yield* eventually(
      runtime.get(oversizedAccepted.executionId),
      ({ status }) => status === "failed"
    );
    const interruptedAccepted = yield* runtime.start({
      actionName: interruptedNonIdempotentAction.name,
      conversationId: request.conversationId,
      input: { reason: "fixture interruption" },
      invocationId: "invocation-interrupted-one-shot",
    });
    const interrupted = yield* eventually(
      runtime.get(interruptedAccepted.executionId),
      ({ status }) => status === "failed"
    );
    const allDelivered = yield* eventually(
      Ref.get(terminalEvents),
      (events) => events.length === 4
    );
    yield* sql`
      UPDATE laborer_action_executions
      SET catalog_fingerprint = 'tampered-catalog-fingerprint'
      WHERE execution_id = ${malformedAccepted.executionId}
    `;
    const changedCatalogReplay = yield* Effect.result(
      runtime.start({
        ...request,
        input: {
          quantity: 1,
          requestedAt: "2026-07-27T00:00:00.000Z",
          widget: "invalid-result",
        },
        invocationId: "invocation-invalid-result",
      })
    );
    yield* sql`
      UPDATE laborer_action_executions
      SET input_json = '{"tampered":true}'
      WHERE execution_id = ${accepted.executionId}
    `;
    const corruptedReplay = yield* Effect.result(runtime.start(request));
    yield* Console.log(
      `REGISTERED_ACTION_EVIDENCE:${JSON.stringify({
        accepted,
        allDelivered,
        changedCatalogReplay: changedCatalogReplay._tag,
        completed,
        conflict: conflict._tag,
        corruptedReplay: corruptedReplay._tag,
        delivered,
        invalid: invalid._tag,
        interrupted,
        malformed,
        oversized,
        privateTools: runtime.privateTools,
        replay,
      })}`
    );
  }).pipe(Effect.provide(runtimeLayer));
});

program.pipe(Effect.scoped, BunRuntime.runMain);
