import type { ChildProcessByStdio } from "node:child_process";
import { execFile, spawn } from "node:child_process";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { promisify } from "node:util";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { makeTempDirectoryScoped } from "./support/temp-directory.ts";

const execFilePromise = promisify(execFile);
const fixturePath = resolve(
  process.cwd(),
  "tests/fixtures/cold-root-runtime-peer.ts"
);
const readyPrefix = "COLD_RECOVERY_READY:";
const evidencePrefix = "COLD_RECOVERY_EVIDENCE:";

const waitForOutputLine = (
  child: ChildProcessByStdio<null, Readable, Readable>,
  prefix: string
): Promise<string> =>
  new Promise((resolveLine, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out waiting for ${prefix}`));
    }, 15_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 64 * 1024) {
        child.kill("SIGKILL");
        clearTimeout(timeout);
        reject(new Error("cold recovery fixture output exceeded bound"));
        return;
      }
      const line = stdout.split("\n").find((item) => item.startsWith(prefix));
      if (line !== undefined) {
        clearTimeout(timeout);
        resolveLine(line.slice(prefix.length));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 64 * 1024) {
        child.kill("SIGKILL");
        clearTimeout(timeout);
        reject(new Error("cold recovery fixture diagnostics exceeded bound"));
      }
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `cold recovery fixture exited before readiness (${String(code)}/${String(signal)}): ${stderr}`
        )
      );
    });
  });

describe("cold root runtime recovery", () => {
  it.live(
    "restarts the root process without repeating completed or ambiguous external effects",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* makeTempDirectoryScoped(
            "laborer-cold-root-recovery-"
          );
          const databasePath = join(directory, "runtime.sqlite");
          const child = yield* Effect.acquireRelease(
            Effect.sync(() =>
              spawn(
                process.execPath,
                [fixturePath, databasePath, directory, "seed"],
                {
                  cwd: process.cwd(),
                  stdio: ["ignore", "pipe", "pipe"],
                }
              )
            ),
            (processHandle) =>
              Effect.sync(() => {
                if (processHandle.exitCode === null) {
                  processHandle.kill("SIGKILL");
                }
              })
          );
          const ready = JSON.parse(
            yield* Effect.tryPromise(() =>
              waitForOutputLine(child, readyPrefix)
            )
          ) as {
            readonly ambiguousExecutionId: string;
            readonly completedExecutionId: string;
            readonly idempotentExecutionId: string;
            readonly rootProcessId: number;
          };
          const closed = new Promise<void>((resolveClose) => {
            child.once("close", () => resolveClose());
          });
          child.kill("SIGKILL");
          yield* Effect.promise(() => closed);

          const incompatible = yield* Effect.tryPromise(() =>
            execFilePromise(
              process.execPath,
              [fixturePath, databasePath, directory, "missing-registration"],
              {
                cwd: process.cwd(),
                maxBuffer: 64 * 1024,
                timeout: 15_000,
              }
            )
          );
          assert.ok(
            incompatible.stdout.includes("COLD_RECOVERY_REGISTRATION:rejected")
          );
          assert.ok(
            !incompatible.stdout.includes("COLD_RECOVERY_PRIVATE_INPUT")
          );
          assert.ok(
            !incompatible.stderr.includes("COLD_RECOVERY_PRIVATE_INPUT")
          );
          assert.ok(!incompatible.stdout.includes(databasePath));
          assert.ok(!incompatible.stderr.includes(databasePath));

          const recovered = yield* Effect.tryPromise(() =>
            execFilePromise(
              process.execPath,
              [fixturePath, databasePath, directory, "recover"],
              {
                cwd: process.cwd(),
                maxBuffer: 256 * 1024,
                timeout: 20_000,
              }
            )
          );
          const evidenceLine = recovered.stdout
            .split("\n")
            .find((line) => line.startsWith(evidencePrefix));
          assert.ok(evidenceLine);
          const evidence = JSON.parse(
            evidenceLine.slice(evidencePrefix.length)
          ) as {
            readonly ambiguous: {
              readonly executionId: string;
              readonly failureCategory: string | null;
              readonly status: string;
            };
            readonly ambiguousRecord: {
              readonly attempts: number;
              readonly executionId: string;
            };
            readonly completed: {
              readonly executionId: string;
              readonly result: unknown;
              readonly status: string;
            };
            readonly completedRecord: {
              readonly attempts: number;
              readonly executionId: string;
            };
            readonly idempotent: {
              readonly executionId: string;
              readonly result: unknown;
              readonly status: string;
            };
            readonly idempotentRecord: {
              readonly attempts: number;
              readonly executionId: string;
            };
            readonly pending: readonly {
              readonly eventId: string;
              readonly executionId: string;
              readonly kind: string;
              readonly sequence: number;
            }[];
            readonly rootProcessId: number;
          };

          assert.notStrictEqual(evidence.rootProcessId, ready.rootProcessId);
          assert.strictEqual(
            evidence.completed.executionId,
            ready.completedExecutionId
          );
          assert.strictEqual(evidence.completed.status, "completed");
          assert.strictEqual(evidence.completedRecord.attempts, 1);
          assert.deepStrictEqual(evidence.completed.result, {
            stable: ready.completedExecutionId,
          });
          assert.strictEqual(
            evidence.idempotent.executionId,
            ready.idempotentExecutionId
          );
          assert.strictEqual(evidence.idempotent.status, "completed");
          assert.strictEqual(evidence.idempotentRecord.attempts, 2);
          assert.deepStrictEqual(evidence.idempotent.result, {
            stable: ready.idempotentExecutionId,
          });
          assert.strictEqual(
            evidence.ambiguous.executionId,
            ready.ambiguousExecutionId
          );
          assert.strictEqual(evidence.ambiguous.status, "needs-attention");
          assert.strictEqual(
            evidence.ambiguous.failureCategory,
            "needs-attention"
          );
          assert.strictEqual(evidence.ambiguousRecord.attempts, 1);
          assert.deepStrictEqual(
            evidence.pending
              .filter(
                ({ executionId }) => executionId === ready.idempotentExecutionId
              )
              .map(({ kind, sequence }) => ({ kind, sequence })),
            [
              { kind: "progress", sequence: 1 },
              { kind: "completed", sequence: 2 },
            ]
          );
          assert.deepStrictEqual(
            evidence.pending
              .filter(
                ({ executionId }) => executionId === ready.ambiguousExecutionId
              )
              .map(({ kind, sequence }) => ({ kind, sequence })),
            [
              { kind: "progress", sequence: 1 },
              { kind: "failed", sequence: 2 },
            ]
          );
          assert.strictEqual(
            new Set(evidence.pending.map(({ eventId }) => eventId)).size,
            evidence.pending.length
          );
        })
      ),
    45_000
  );
});
