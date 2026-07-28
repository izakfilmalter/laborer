import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  ACTION_PROMPT_MAX_LENGTH,
  actionInputHash,
  canonicalActionInput,
  createFeatureAction,
  dealWithBugAction,
  makeProductionActionCatalog,
  productionActionCatalog,
} from "../src/action-catalog.ts";

const CATALOG_FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{43}$/;

describe("production Action catalog", () => {
  it.effect("generates strict MCP documentation and runtime codecs once", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        productionActionCatalog.actions.map(({ handlerKey, name }) => ({
          handlerKey,
          name,
        })),
        [
          { handlerKey: "create-feature", name: "create-feature" },
          { handlerKey: "deal-with-bug", name: "deal-with-bug" },
        ]
      );
      assert.deepStrictEqual(
        productionActionCatalog.tools.map(({ name }) => name),
        ["create-feature", "deal-with-bug"]
      );
      for (const tool of productionActionCatalog.tools) {
        assert.strictEqual(tool.inputSchema.additionalProperties, false);
        assert.deepStrictEqual(tool.inputSchema.required, [
          "prompt",
          "worktreeName",
        ]);
        assert.strictEqual(tool.outputSchema.additionalProperties, false);
        assert.deepStrictEqual(tool.outputSchema.required, [
          "actionName",
          "deduplicated",
          "executionId",
          "status",
        ]);
        assert.deepStrictEqual(tool.annotations, {
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
          readOnlyHint: false,
        });
      }
      assert.match(
        productionActionCatalog.fingerprint,
        CATALOG_FINGERPRINT_PATTERN
      );

      const valid = {
        prompt: "  Build a feature.  ",
        worktreeName: "feature-246",
      };
      assert.deepStrictEqual(
        yield* createFeatureAction.decodeInput(valid),
        valid
      );
      for (const invalid of [
        { ...valid, extra: true },
        { ...valid, prompt: " \n\t " },
        { ...valid, prompt: "x".repeat(ACTION_PROMPT_MAX_LENGTH + 1) },
        { ...valid, worktreeName: "../escape" },
        { ...valid, worktreeName: "branch.lock" },
      ]) {
        assert.strictEqual(
          (yield* Effect.result(createFeatureAction.decodeInput(invalid)))._tag,
          "Failure"
        );
      }

      const encoded = yield* createFeatureAction.encodeResult({
        actionName: "create-feature",
        deduplicated: false,
        executionId: "execution:opaque",
        status: "running",
      });
      assert.deepStrictEqual(encoded, {
        actionName: "create-feature",
        deduplicated: false,
        executionId: "execution:opaque",
        status: "running",
      });
      assert.strictEqual(
        (yield* Effect.result(
          createFeatureAction.encodeResult({
            actionName: "create-feature",
            deduplicated: false,
            executionId: "execution:opaque",
            leakedPath: "/private/repository",
            status: "running",
          })
        ))._tag,
        "Failure"
      );

      assert.deepStrictEqual(
        yield* dealWithBugAction.decodeInput(valid),
        valid
      );
      assert.deepStrictEqual(
        yield* dealWithBugAction.encodeResult({
          actionName: "deal-with-bug",
          deduplicated: true,
          executionId: "execution:bug:opaque",
          status: "completed",
        }),
        {
          actionName: "deal-with-bug",
          deduplicated: true,
          executionId: "execution:bug:opaque",
          status: "completed",
        }
      );
      assert.strictEqual(
        (yield* Effect.result(
          dealWithBugAction.encodeResult({
            actionName: "create-feature",
            deduplicated: false,
            executionId: "execution:mismatched-tag",
            status: "running",
          })
        ))._tag,
        "Failure"
      );
    })
  );

  it.effect("canonicalizes input without changing prompt whitespace", () =>
    Effect.gen(function* () {
      const first = yield* actionInputHash(
        "create-feature",
        productionActionCatalog.fingerprint,
        { prompt: "  e\u0301  ", worktreeName: "nfc" }
      );
      const normalized = yield* actionInputHash(
        "create-feature",
        productionActionCatalog.fingerprint,
        { worktreeName: "nfc", prompt: "  é  " }
      );
      const trimmed = yield* actionInputHash(
        "create-feature",
        productionActionCatalog.fingerprint,
        { prompt: "é", worktreeName: "nfc" }
      );
      assert.strictEqual(first, normalized);
      assert.notStrictEqual(first, trimmed);
    })
  );

  it.effect("rejects ambiguous or collectively oversized canonical input", () =>
    Effect.gen(function* () {
      const normalizedKeyCollision = {
        "e\u0301": 1,
        é: 2,
      };
      assert.strictEqual(
        (yield* Effect.result(canonicalActionInput(normalizedKeyCollision)))
          ._tag,
        "Failure"
      );
      assert.strictEqual(
        (yield* Effect.result(
          canonicalActionInput({
            left: Array.from({ length: 128 }, (_, index) => index),
            right: Array.from({ length: 128 }, (_, index) => index),
          })
        ))._tag,
        "Failure"
      );
    })
  );

  it("fingerprints deterministic routing and contract identity without changing tools", () => {
    const reversed = makeProductionActionCatalog([
      dealWithBugAction,
      createFeatureAction,
    ]);
    assert.strictEqual(
      reversed.fingerprint,
      productionActionCatalog.fingerprint
    );
    assert.deepStrictEqual(reversed.tools, productionActionCatalog.tools);

    const remapped = makeProductionActionCatalog([
      { ...createFeatureAction, handlerKey: "deal-with-bug" },
      { ...dealWithBugAction, handlerKey: "create-feature" },
    ]);
    assert.deepStrictEqual(remapped.tools, productionActionCatalog.tools);
    assert.notStrictEqual(
      remapped.fingerprint,
      productionActionCatalog.fingerprint
    );

    const nextContract = makeProductionActionCatalog(
      [createFeatureAction, dealWithBugAction],
      productionActionCatalog.contractVersion + 1
    );
    assert.deepStrictEqual(nextContract.tools, productionActionCatalog.tools);
    assert.notStrictEqual(
      nextContract.fingerprint,
      productionActionCatalog.fingerprint
    );
  });

  it("fails catalog name and handler collisions", () => {
    assert.throws(() =>
      makeProductionActionCatalog([
        createFeatureAction,
        { ...createFeatureAction },
      ])
    );
    assert.throws(() =>
      makeProductionActionCatalog([
        createFeatureAction,
        { ...createFeatureAction, name: "other-action" },
      ])
    );
    assert.throws(() =>
      makeProductionActionCatalog([
        createFeatureAction,
        { ...dealWithBugAction, name: "create-feature" },
      ])
    );
    assert.throws(() =>
      makeProductionActionCatalog([
        createFeatureAction,
        { ...dealWithBugAction, handlerKey: "create-feature" },
      ])
    );
  });
});
