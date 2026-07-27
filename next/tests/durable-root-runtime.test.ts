import { join } from "node:path";
import { layer as makeSqliteLayer } from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import {
  defineAction,
  defineApplication,
} from "../src/durable-runtime/action.ts";
import {
  makeRootDurableRuntimeLayer,
  RootDurableRuntime,
} from "../src/durable-runtime/root-runtime.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

const waitForTerminal = Effect.fn("waitForTerminal")(function* (
  executionId: string
) {
  const runtime = yield* RootDurableRuntime;
  let lastStatus = "missing";
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const snapshot = yield* runtime.getExecution(executionId);
    lastStatus = snapshot.status;
    if (
      snapshot.status === "completed" ||
      snapshot.status === "failed" ||
      snapshot.status === "needs-attention"
    ) {
      return snapshot;
    }
    yield* Effect.sleep("10 millis");
  }
  return yield* Effect.die(
    new Error(`Execution did not settle from ${lastStatus}`)
  );
});

describe("root durable runtime", () => {
  it.effect(
    "runs arbitrary registered Actions through Cluster and a SQLite outbox",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* makeTempDirectoryScoped(
            "laborer-durable-root-runtime-"
          );
          const action = defineAction({
            annotations: { idempotentHint: true },
            description: "Render a fixture greeting",
            input: Schema.Struct({ name: Schema.String }),
            name: "fixture/render-greeting",
            recoveryPolicy: "idempotent-retry",
            result: Schema.Struct({ greeting: Schema.String }),
            revision: "fixture-v1",
            run: (input, context) =>
              Effect.gen(function* () {
                yield* context.reportProgress({ phase: "rendering" });
                yield* Effect.yieldNow;
                return { greeting: `hello ${input.name}` };
              }),
          });
          const application = defineApplication({
            actions: [action],
          });
          const layer = makeRootDurableRuntimeLayer(
            makeSqliteLayer({ filename: join(directory, "runtime.sqlite") }),
            application.actions,
            "root-fixture"
          );
          const scene = Effect.gen(function* () {
            const runtime = yield* RootDurableRuntime;
            const request = {
              actionName: "fixture/render-greeting",
              conversationId: "workspace:T1:thread:C1:1.0",
              input: { name: "Ada" },
              invocationId: "invocation-1",
              rootIdentity: "root-fixture",
            } as const;
            const accepted = yield* runtime.startExecution(request);
            const duplicate = yield* runtime.startExecution(request);
            assert.strictEqual(duplicate.executionId, accepted.executionId);

            const conflict = yield* Effect.result(
              runtime.startExecution({
                ...request,
                input: { name: "Grace" },
              })
            );
            assert.strictEqual(conflict._tag, "Failure");
            if (conflict._tag === "Failure") {
              assert.strictEqual(
                conflict.failure.reason,
                "conflicting-invocation"
              );
            }

            const oversized = yield* Effect.flip(
              runtime.startExecution({
                ...request,
                input: { name: "x".repeat(64 * 1024) },
                invocationId: "invocation-oversized",
              })
            );
            assert.strictEqual(oversized.reason, "invalid-payload");

            const invalidLimit = yield* Effect.flip(
              runtime.pendingEvents(request.conversationId, Number.NaN)
            );
            assert.strictEqual(invalidLimit.reason, "invalid-payload");

            const terminal = yield* waitForTerminal(accepted.executionId);
            assert.strictEqual(terminal.status, "completed");
            assert.deepStrictEqual(terminal.result, { greeting: "hello Ada" });

            const events = yield* runtime.pendingEvents(request.conversationId);
            assert.deepStrictEqual(
              events.map(({ kind, sequence }) => ({ kind, sequence })),
              [
                { kind: "progress", sequence: 1 },
                { kind: "completed", sequence: 2 },
              ]
            );
            const firstEvent = events[0];
            assert.ok(firstEvent);
            yield* runtime.acknowledgeEvent(firstEvent.eventId);
            const remaining = yield* runtime.pendingEvents(
              request.conversationId
            );
            assert.deepStrictEqual(
              remaining.map(({ sequence }) => sequence),
              [2]
            );

            return {
              conversationId: request.conversationId,
              executionId: accepted.executionId,
            };
          });
          const evidence = yield* scene.pipe(Effect.provide(layer));
          const restartedLayer = makeRootDurableRuntimeLayer(
            makeSqliteLayer({ filename: join(directory, "runtime.sqlite") }),
            application.actions,
            "root-fixture"
          );
          yield* Effect.gen(function* () {
            const restarted = yield* RootDurableRuntime;
            const snapshot = yield* restarted.getExecution(
              evidence.executionId
            );
            assert.strictEqual(snapshot.status, "completed");
            const pending = yield* restarted.pendingEvents(
              evidence.conversationId
            );
            assert.deepStrictEqual(
              pending.map(({ kind, sequence }) => ({ kind, sequence })),
              [{ kind: "completed", sequence: 2 }]
            );
          }).pipe(Effect.provide(restartedLayer));
        })
      ),
    20_000
  );

  it("rejects conflicting registrations before publishing a catalog", () => {
    const action = defineAction({
      description: "One fixture Action",
      input: Schema.Struct({ value: Schema.String }),
      name: "fixture/action",
      result: Schema.Struct({ value: Schema.String }),
      revision: "v1",
      run: (input) => Effect.succeed(input),
    });
    assert.throws(() => defineApplication({ actions: [action, action] }));
    assert.throws(() =>
      defineAction({
        annotations: { idempotentHint: false },
        description: "Unsafe retry declaration",
        input: Schema.String,
        name: "fixture/unsafe-retry",
        recoveryPolicy: "idempotent-retry",
        result: Schema.String,
        revision: "v1",
        run: (input) => Effect.succeed(input),
      })
    );
    assert.throws(() =>
      defineAction({
        annotations: {
          readOnlyHint: "yes" as unknown as boolean,
        },
        description: "Malformed annotations",
        input: Schema.String,
        name: "fixture/malformed-annotations",
        result: Schema.String,
        revision: "v1",
        run: (input) => Effect.succeed(input),
      })
    );
    assert.throws(() =>
      defineAction({
        description: "Malformed recovery policy",
        input: Schema.String,
        name: "fixture/malformed-recovery",
        recoveryPolicy: "retry-eventually" as "fail-closed",
        result: Schema.String,
        revision: "v1",
        run: (input) => Effect.succeed(input),
      })
    );
    assert.throws(() =>
      defineAction({
        annotations: {
          unsupportedHint: true,
        } as unknown as { readOnlyHint: boolean },
        description: "Unknown annotation key",
        input: Schema.String,
        name: "fixture/unknown-annotation",
        result: Schema.String,
        revision: "v1",
        run: (input) => Effect.succeed(input),
      })
    );
    assert.throws(() =>
      defineAction({
        description: "Oversized generated schema metadata",
        input: Schema.String.annotate({
          description: "x".repeat(64 * 1024),
        }),
        name: "fixture/oversized-schema",
        result: Schema.String,
        revision: "v1",
        run: (input) => Effect.succeed(input),
      })
    );
  });

  it("keeps the compatibility fingerprint independent of prose", () => {
    const makeAction = (description: string) =>
      defineAction({
        annotations: { readOnlyHint: true },
        description,
        input: Schema.Struct({ value: Schema.String }),
        name: "fixture/fingerprint",
        result: Schema.Struct({ value: Schema.String }),
        revision: "v1",
        run: (input) => Effect.succeed(input),
      });
    const first = defineApplication({
      actions: [makeAction("First model-facing description")],
    });
    const second = defineApplication({
      actions: [makeAction("Updated model-facing description")],
    });
    assert.strictEqual(first.actions.fingerprint, second.actions.fingerprint);
  });

  it.effect("distinguishes malformed results from Action failures", () =>
    Effect.gen(function* () {
      const context = {
        conversationId: "conversation-fixture",
        executionId: "execution-fixture",
        reportProgress: () => Effect.void,
        rootIdentity: "root-fixture",
      };
      const malformed = defineAction({
        description: "Return a malformed fixture result",
        input: Schema.Null,
        name: "fixture/malformed-result",
        result: Schema.Struct({ value: Schema.String }),
        revision: "v1",
        run: () =>
          Effect.succeed({ value: 42 } as unknown as { value: string }),
      });
      const malformedFailure = yield* Effect.flip(
        malformed.execute(null, context)
      );
      assert.ok(
        typeof malformedFailure === "object" &&
          malformedFailure !== null &&
          "reason" in malformedFailure
      );
      if (
        typeof malformedFailure === "object" &&
        malformedFailure !== null &&
        "reason" in malformedFailure
      ) {
        assert.strictEqual(malformedFailure.reason, "invalid-result");
      }

      const expectedFailure = new Error("fixture Action failure");
      const failing = defineAction({
        description: "Fail in user-controlled Action code",
        input: Schema.Null,
        name: "fixture/failing",
        result: Schema.String,
        revision: "v1",
        run: () => Effect.fail(expectedFailure),
      });
      const actionFailure = yield* Effect.flip(failing.execute(null, context));
      assert.strictEqual(actionFailure, expectedFailure);
    })
  );
});
