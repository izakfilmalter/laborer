import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import {
  executionCancelOperationId,
  executionControlDefinition,
  productionExecutionControlCatalog,
} from "../src/execution-control-catalog.ts";
import { productionGeneratedMutationCatalog } from "../src/generated-mutation-catalog.ts";

describe("generated Execution control catalog", () => {
  it.effect("publishes strict, bounded, closed-world Execution controls", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        productionExecutionControlCatalog.controls.map(
          ({ handlerKey, name }) => ({ handlerKey, name })
        ),
        [
          { handlerKey: "cancel-execution", name: "cancel-execution" },
          { handlerKey: "inspect-executions", name: "inspect-executions" },
          { handlerKey: "prompt-execution", name: "prompt-execution" },
        ]
      );
      const inspect = productionExecutionControlCatalog.tools.find(
        ({ name }) => name === "inspect-executions"
      );
      const cancel = productionExecutionControlCatalog.tools.find(
        ({ name }) => name === "cancel-execution"
      );
      assert.ok(inspect);
      assert.ok(cancel);
      assert.deepStrictEqual(inspect.annotations, {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      });
      assert.deepStrictEqual(cancel.annotations, {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      });
      assert.ok(
        productionExecutionControlCatalog.tools.every(
          (tool) =>
            tool.inputSchema.additionalProperties === false &&
            tool.outputSchema.additionalProperties === false
        )
      );
      assert.deepStrictEqual(
        productionGeneratedMutationCatalog.tools.map(({ name }) => name),
        [
          "cancel-execution",
          "create-feature",
          "deal-with-bug",
          "inspect-executions",
          "prompt-execution",
        ]
      );

      const definition = executionControlDefinition("prompt-execution");
      assert.ok(definition);
      assert.deepStrictEqual(
        yield* definition.decodeInput({
          executionId: "opaque-execution",
          prompt: "Continue with the participant feedback.",
        }),
        {
          executionId: "opaque-execution",
          prompt: "Continue with the participant feedback.",
        }
      );
      assert.ok(
        Exit.isFailure(
          yield* Effect.exit(
            definition.decodeInput({
              executionId: "opaque-execution",
              path: "/private/worktree",
              prompt: "Continue.",
            })
          )
        )
      );
      assert.ok(
        Exit.isFailure(
          yield* Effect.exit(
            definition.decodeInput({
              executionId: "opaque-execution",
              prompt: " ",
            })
          )
        )
      );
    })
  );

  it.effect("enforces inspect bounds and exact cancel input", () =>
    Effect.gen(function* () {
      const inspect = executionControlDefinition("inspect-executions");
      const cancel = executionControlDefinition("cancel-execution");
      assert.ok(inspect);
      assert.ok(cancel);
      assert.deepStrictEqual(yield* inspect.decodeInput({}), {});
      assert.deepStrictEqual(
        yield* inspect.decodeInput({ executionId: "execution-1", limit: 20 }),
        { executionId: "execution-1", limit: 20 }
      );
      for (const input of [
        { limit: 0 },
        { limit: 21 },
        { limit: 1, privatePath: "/tmp/private" },
      ]) {
        assert.ok(
          Exit.isFailure(yield* Effect.exit(inspect.decodeInput(input)))
        );
      }
      assert.deepStrictEqual(
        yield* cancel.decodeInput({ executionId: "execution-1" }),
        { executionId: "execution-1" }
      );
      assert.ok(
        Exit.isFailure(
          yield* Effect.exit(
            cancel.decodeInput({
              executionId: "execution-1",
              implementationSessionId: "private",
            })
          )
        )
      );
    })
  );

  it("derives cancel identity only from trusted ownership scope", () => {
    const scope = {
      conversationId: "conversation-1",
      executionId: "execution-1",
      workspaceId: "workspace-1",
    };
    assert.strictEqual(
      executionCancelOperationId(scope),
      executionCancelOperationId(scope)
    );
    assert.notStrictEqual(
      executionCancelOperationId(scope),
      executionCancelOperationId({ ...scope, executionId: "execution-2" })
    );
    assert.notStrictEqual(
      executionCancelOperationId(scope),
      executionCancelOperationId({ ...scope, workspaceId: "workspace-2" })
    );
  });

  it.effect("rejects private fields in generated results", () =>
    Effect.gen(function* () {
      const definition = executionControlDefinition("prompt-execution");
      assert.ok(definition);
      assert.deepStrictEqual(
        yield* definition.encodeResult({
          deduplicated: true,
          executionId: "opaque-execution",
          status: "running",
        }),
        {
          deduplicated: true,
          executionId: "opaque-execution",
          status: "running",
        }
      );
      assert.ok(
        Exit.isFailure(
          yield* Effect.exit(
            definition.encodeResult({
              deduplicated: false,
              executionId: "opaque-execution",
              prompt: "private",
              status: "running",
              workingDirectory: "/private/worktree",
            })
          )
        )
      );
    })
  );

  it.effect("encodes only safe bounded inspect and cancel snapshots", () =>
    Effect.gen(function* () {
      const inspect = executionControlDefinition("inspect-executions");
      const cancel = executionControlDefinition("cancel-execution");
      assert.ok(inspect);
      assert.ok(cancel);
      const snapshot = {
        actionName: "create-feature",
        canCancel: true,
        canPrompt: true,
        executionId: "execution-1",
        status: "running",
        worktreeName: "safe-worktree",
      };
      assert.deepStrictEqual(
        yield* inspect.encodeResult({
          executions: [snapshot],
          schemaVersion: 1,
          truncated: false,
        }),
        {
          executions: [snapshot],
          schemaVersion: 1,
          truncated: false,
        }
      );
      assert.ok(
        Exit.isFailure(
          yield* Effect.exit(
            inspect.encodeResult({
              executions: [{ ...snapshot, workingDirectory: "/private" }],
              schemaVersion: 1,
              truncated: false,
            })
          )
        )
      );
      assert.deepStrictEqual(
        yield* cancel.encodeResult({
          deduplicated: false,
          execution: {
            ...snapshot,
            canCancel: false,
            canPrompt: false,
            status: "cancelled",
          },
          schemaVersion: 1,
        }),
        {
          deduplicated: false,
          execution: {
            ...snapshot,
            canCancel: false,
            canPrompt: false,
            status: "cancelled",
          },
          schemaVersion: 1,
        }
      );
      for (const worktreeName of [
        "/private/worktree",
        "../private-worktree",
        "..\\private-worktree",
        "C:\\private-worktree",
        "~/private-worktree",
        ".private-worktree",
      ]) {
        assert.ok(
          Exit.isFailure(
            yield* Effect.exit(
              inspect.encodeResult({
                executions: [{ ...snapshot, worktreeName }],
                schemaVersion: 1,
                truncated: false,
              })
            )
          )
        );
      }
      const bounded = yield* inspect.encodeResult({
        executions: Array.from({ length: 20 }, (_, index) => ({
          ...snapshot,
          executionId: `execution-${index}-${"x".repeat(120)}`,
          worktreeName: `safe-worktree-${index}`,
        })),
        schemaVersion: 1,
        truncated: true,
      });
      assert.ok(
        Buffer.byteLength(JSON.stringify(bounded), "utf8") <= 64 * 1024
      );
    })
  );
});
