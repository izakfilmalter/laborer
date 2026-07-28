import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { AttachConversationClientRpcRequest } from "../src/durable-runtime/rpc.ts";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

const execFilePromise = promisify(execFile);
const peerPath = resolve(
  process.cwd(),
  "tests/fixtures/conversation-client-replacement-peer.ts"
);
const evidencePrefix = "CLIENT_REPLACEMENT_EVIDENCE:";

describe("Conversation client replacement", () => {
  it.effect(
    "keeps the root owner and Action processes alive across replacement",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeTempDirectoryScoped(
            "laborer-conversation-client-replacement-"
          );
          const { stdout } = yield* Effect.tryPromise(() =>
            execFilePromise(process.execPath, [peerPath, root], {
              cwd: process.cwd(),
              maxBuffer: 1024 * 1024,
              timeout: 30_000,
            })
          );
          const line = stdout
            .split("\n")
            .find((candidate) => candidate.startsWith(evidencePrefix));
          assert.ok(line);
          const evidence = JSON.parse(line.slice(evidencePrefix.length)) as {
            readonly actionPidsAfter: readonly string[];
            readonly actionPidsBefore: readonly string[];
            readonly detachedCompletion: {
              readonly actionRevision: string;
              readonly status: string;
            };
            readonly firstObserved: readonly {
              readonly eventId: string;
              readonly kind: string;
              readonly sequence: number;
            }[];
            readonly firstSessionId: string;
            readonly hostPidAfter: number;
            readonly hostPidBefore: number;
            readonly incompatibleCatalog: string;
            readonly incompatibleProtocol: string;
            readonly oldBWhileNewRuns: string;
            readonly pendingAfterReplacement: number;
            readonly pendingWithoutClient: readonly string[];
            readonly replacementExecution: {
              readonly actionRevision: string;
            };
            readonly replacementObserved: readonly {
              readonly eventId: string;
              readonly kind: string;
              readonly sequence: number;
            }[];
            readonly replacementSessionId: string;
            readonly signals: readonly string[];
          };

          assert.strictEqual(evidence.hostPidAfter, evidence.hostPidBefore);
          assert.deepStrictEqual(
            evidence.actionPidsAfter,
            evidence.actionPidsBefore
          );
          assert.deepStrictEqual(evidence.signals, ["", "", ""]);
          assert.strictEqual(evidence.detachedCompletion.status, "completed");
          assert.strictEqual(
            evidence.detachedCompletion.actionRevision,
            "process-v1"
          );
          assert.strictEqual(
            evidence.replacementExecution.actionRevision,
            "process-v2"
          );
          assert.strictEqual(evidence.oldBWhileNewRuns, "running");
          assert.strictEqual(
            evidence.firstSessionId,
            evidence.replacementSessionId
          );
          assert.strictEqual(
            evidence.incompatibleProtocol,
            "incompatible-client"
          );
          assert.strictEqual(
            evidence.incompatibleCatalog,
            "incompatible-client"
          );
          assert.doesNotThrow(() =>
            Schema.decodeUnknownSync(AttachConversationClientRpcRequest)({
              compatibility: {
                actionCatalogFingerprint: "x".repeat(43),
              },
              protocolVersion: 5,
              workspaceId: "T-REPLACEMENT",
            })
          );
          assert.ok(
            evidence.pendingWithoutClient.length >= 1,
            JSON.stringify(evidence)
          );
          assert.strictEqual(evidence.pendingAfterReplacement, 0);
          assert.deepStrictEqual(
            evidence.firstObserved.map(({ kind, sequence }) => ({
              kind,
              sequence,
            })),
            [
              { kind: "progress", sequence: 1 },
              { kind: "progress", sequence: 1 },
            ]
          );
          assert.deepStrictEqual(
            evidence.replacementObserved.map(({ kind }) => kind),
            ["completed", "progress", "completed", "completed"]
          );
          assert.strictEqual(
            new Set(
              [...evidence.firstObserved, ...evidence.replacementObserved].map(
                ({ eventId }) => eventId
              )
            ).size,
            evidence.firstObserved.length + evidence.replacementObserved.length
          );
        })
      ),
    35_000
  );
});
