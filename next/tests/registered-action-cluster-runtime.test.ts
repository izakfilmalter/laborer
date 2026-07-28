import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { makeReferenceCodingActionCatalog } from "../src/cluster-runtime/reference-coding-actions.ts";
import {
  defineRegisteredAction,
  makeRegisteredActionCatalog,
} from "../src/cluster-runtime/registered-action.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

const execFilePromise = promisify(execFile);
const peerPath = resolve(
  process.cwd(),
  "tests/fixtures/registered-action-cluster-peer.ts"
);
const evidencePrefix = "REGISTERED_ACTION_EVIDENCE:";
const catalogFingerprintPattern = /^[\w-]{43}$/;

describe("registered Action Cluster runtime", () => {
  it.effect(
    "rejects malformed catalogs before exposing a private surface",
    () =>
      Effect.sync(() => {
        const actionOptions = {
          annotations: {
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
            readOnlyHint: true,
          },
          description: "Look up a bounded fixture value.",
          input: Schema.Struct({ key: Schema.NonEmptyString }),
          name: "fixture-lookup",
          result: Schema.Struct({ value: Schema.String }),
          revision: "fixture-lookup/v1",
          run: ({ key }: { readonly key: string }) =>
            Effect.succeed({ value: key }),
        } as const;
        const action = defineRegisteredAction(actionOptions);
        const changedDescription = defineRegisteredAction({
          ...actionOptions,
          description: "Look up a different bounded fixture value.",
        });

        assert.throws(() => makeRegisteredActionCatalog([action, action]));
        assert.notStrictEqual(
          makeRegisteredActionCatalog([action]).fingerprint,
          makeRegisteredActionCatalog([changedDescription]).fingerprint
        );
        assert.throws(() =>
          defineRegisteredAction({
            ...actionOptions,
            description: "x".repeat(4097),
          })
        );
        assert.throws(() =>
          defineRegisteredAction({
            ...actionOptions,
            input: Schema.Unknown,
            run: (input: unknown) => Effect.succeed({ value: String(input) }),
          })
        );
        const codingCatalog = makeReferenceCodingActionCatalog({
          createFeature: (_input) =>
            Effect.succeed({
              actionName: "create-feature" as const,
              deduplicated: false,
              executionId: "execution:fixture-feature",
              status: "running" as const,
            }),
          dealWithBug: (_input) =>
            Effect.succeed({
              actionName: "deal-with-bug" as const,
              deduplicated: false,
              executionId: "execution:fixture-bug",
              status: "running" as const,
            }),
        });
        assert.deepStrictEqual(
          codingCatalog.privateTools.map(({ name }) => name),
          ["create-feature", "deal-with-bug"]
        );
        assert.deepStrictEqual(
          codingCatalog.modelTools,
          codingCatalog.privateTools
        );
      })
  );

  it.effect(
    "runs one arbitrary registration durably through Cluster",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-registered-action-cluster-"
          );
          const databasePath = join(root, "runtime.sqlite");
          const { stdout } = yield* Effect.tryPromise(() =>
            execFilePromise("bun", ["run", peerPath, databasePath], {
              cwd: process.cwd(),
              maxBuffer: 1024 * 1024,
              timeout: 15_000,
            })
          );
          const evidenceLine = stdout
            .split("\n")
            .find((line) => line.startsWith(evidencePrefix));
          assert.ok(evidenceLine);
          const evidence = JSON.parse(
            evidenceLine.slice(evidencePrefix.length)
          ) as {
            readonly accepted: {
              readonly deduplicated: boolean;
              readonly executionId: string;
              readonly status: string;
            };
            readonly allDelivered: readonly {
              readonly executionId: string;
              readonly result: unknown;
              readonly status: string;
            }[];
            readonly changedCatalogReplay: string;
            readonly completed: {
              readonly actionName: string;
              readonly actionRevision: string;
              readonly catalogFingerprint: string;
              readonly conversationId: string;
              readonly progress: unknown;
              readonly result: unknown;
              readonly status: string;
            };
            readonly conflict: string;
            readonly corruptedReplay: string;
            readonly delivered: readonly {
              readonly conversationId: string;
              readonly executionId: string;
              readonly result: unknown;
            }[];
            readonly invalid: string;
            readonly interrupted: {
              readonly failureCode: string | null;
              readonly result: unknown;
              readonly status: string;
            };
            readonly malformed: {
              readonly failureCode: string | null;
              readonly result: unknown;
              readonly status: string;
            };
            readonly oversized: {
              readonly failureCode: string | null;
              readonly result: unknown;
              readonly status: string;
            };
            readonly privateTools: readonly {
              readonly inputSchema: { readonly additionalProperties?: boolean };
              readonly name: string;
            }[];
            readonly replay: {
              readonly deduplicated: boolean;
              readonly executionId: string;
            };
          };

          assert.strictEqual(evidence.invalid, "Failure");
          assert.strictEqual(evidence.conflict, "Failure");
          assert.strictEqual(evidence.changedCatalogReplay, "Failure");
          assert.strictEqual(evidence.corruptedReplay, "Failure");
          assert.strictEqual(evidence.accepted.status, "queued");
          assert.strictEqual(evidence.accepted.deduplicated, false);
          assert.strictEqual(evidence.replay.deduplicated, true);
          assert.strictEqual(
            evidence.replay.executionId,
            evidence.accepted.executionId
          );
          assert.strictEqual(evidence.completed.status, "succeeded");
          assert.strictEqual(
            evidence.completed.actionName,
            "forge-fixture-widget"
          );
          assert.strictEqual(
            evidence.completed.actionRevision,
            "forge-fixture-widget/2026-07-27"
          );
          assert.match(
            evidence.completed.catalogFingerprint,
            catalogFingerprintPattern
          );
          assert.deepStrictEqual(evidence.completed.result, {
            artifact: "anvil:3:2026",
          });
          assert.deepStrictEqual(evidence.completed.progress, {
            details: { quantity: 3 },
            message: "Fixture forge claimed the work.",
          });
          assert.deepStrictEqual(
            evidence.privateTools.map(({ name }) => name),
            ["forge-fixture-widget", "interrupt-one-shot-fixture"]
          );
          assert.strictEqual(
            evidence.privateTools[0]?.inputSchema.additionalProperties,
            false
          );
          assert.strictEqual(evidence.delivered.length, 1);
          assert.strictEqual(
            evidence.delivered[0]?.conversationId,
            evidence.completed.conversationId
          );
          assert.strictEqual(
            evidence.delivered[0]?.executionId,
            evidence.accepted.executionId
          );
          assert.deepStrictEqual(evidence.delivered[0]?.result, {
            artifact: "anvil:3:2026",
          });
          assert.strictEqual(evidence.malformed.status, "failed");
          assert.strictEqual(
            evidence.malformed.failureCode,
            "action-failed-or-invalid-output"
          );
          assert.strictEqual(evidence.malformed.result, null);
          assert.strictEqual(evidence.oversized.status, "failed");
          assert.strictEqual(
            evidence.oversized.failureCode,
            "action-failed-or-invalid-output"
          );
          assert.strictEqual(evidence.oversized.result, null);
          assert.strictEqual(evidence.interrupted.status, "failed");
          assert.strictEqual(
            evidence.interrupted.failureCode,
            "action-recovery-required"
          );
          assert.strictEqual(evidence.interrupted.result, null);
          assert.strictEqual(evidence.allDelivered.length, 4);
          assert.strictEqual(evidence.allDelivered[1]?.status, "failed");
          assert.strictEqual(evidence.allDelivered[1]?.result, null);
        })
      ),
    20_000
  );
});
