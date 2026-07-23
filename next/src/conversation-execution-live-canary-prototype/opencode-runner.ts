/** THROWAWAY ISSUE #217 CANARY — bounded real OpenCode process adapter. */

import { spawn } from "node:child_process";
import { Effect, Array as EffectArray, Option, pipe, Schema } from "effect";

const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_JSONL_LINE_BYTES = 128 * 1024;
const MAX_RESPONSE_CHARACTERS = 8000;

const OpenCodeEvent = Schema.Struct({
  part: Schema.optional(Schema.Unknown),
  sessionID: Schema.String,
  type: Schema.String,
});

const TextPart = Schema.Struct({ text: Schema.String });

export class OpenCodeRunError extends Schema.TaggedErrorClass<OpenCodeRunError>()(
  "OpenCodeRunError",
  {
    reason: Schema.Literals([
      "spawn-failed",
      "timeout",
      "output-limit",
      "nonzero-exit",
      "invalid-jsonl",
      "inconsistent-session",
      "missing-session",
      "missing-text",
    ]),
  }
) {}

export interface OpenCodeRunResult {
  readonly sessionId: string;
  readonly text: string;
}

interface ProcessResult {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

const runProcess = (options: {
  readonly args: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly prompt: string;
  readonly timeoutMillis: number;
}): Effect.Effect<ProcessResult, OpenCodeRunError> =>
  Effect.tryPromise({
    try: () => {
      const child = spawn("opencode", options.args, {
        env: options.environment,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return new Promise<ProcessResult>((resolve, reject) => {
        let settled = false;
        let stderr = "";
        let stdout = "";
        let stderrBytes = 0;
        let stdoutBytes = 0;
        const finish = (
          outcome:
            | { readonly _tag: "resolve"; readonly value: ProcessResult }
            | { readonly _tag: "reject"; readonly value: OpenCodeRunError }
        ) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          if (outcome._tag === "resolve") {
            resolve(outcome.value);
            return;
          }
          child.kill("SIGKILL");
          reject(outcome.value);
        };
        const timer = setTimeout(
          () =>
            finish({
              _tag: "reject",
              value: OpenCodeRunError.make({ reason: "timeout" }),
            }),
          options.timeoutMillis
        );

        child.once("error", () =>
          finish({
            _tag: "reject",
            value: OpenCodeRunError.make({ reason: "spawn-failed" }),
          })
        );
        child.stdout.on("data", (chunk: Buffer) => {
          stdoutBytes += chunk.byteLength;
          if (stdoutBytes > MAX_STDOUT_BYTES) {
            finish({
              _tag: "reject",
              value: OpenCodeRunError.make({ reason: "output-limit" }),
            });
            return;
          }
          stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderrBytes += chunk.byteLength;
          if (stderrBytes > MAX_STDERR_BYTES) {
            finish({
              _tag: "reject",
              value: OpenCodeRunError.make({ reason: "output-limit" }),
            });
            return;
          }
          stderr += chunk.toString("utf8");
        });
        child.once("close", (exitCode) =>
          finish({
            _tag: "resolve",
            value: { exitCode, stderr, stdout },
          })
        );
        child.stdin.end(options.prompt, "utf8");
      });
    },
    catch: (error) =>
      error instanceof OpenCodeRunError
        ? error
        : OpenCodeRunError.make({ reason: "spawn-failed" }),
  });

const textFromPart = (part: unknown): Effect.Effect<string | null> =>
  Schema.decodeUnknownEffect(TextPart)(part).pipe(
    Effect.map((value) => value.text.trim()),
    Effect.map((value) => (value.length === 0 ? null : value)),
    Effect.catch(() => Effect.succeed(null))
  );

export const parseOpenCodeJsonl = Effect.fn("parseOpenCodeJsonl")(function* (
  stdout: string
) {
  const lines = pipe(
    stdout.split("\n"),
    EffectArray.map((line) => line.trim()),
    EffectArray.filter((line) => line.length > 0)
  );
  let sessionId: string | null = null;
  const texts: string[] = [];
  for (const line of lines) {
    if (Buffer.byteLength(line, "utf8") > MAX_JSONL_LINE_BYTES) {
      return yield* OpenCodeRunError.make({ reason: "output-limit" });
    }
    const event = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(OpenCodeEvent)
    )(line).pipe(
      Effect.mapError(() => OpenCodeRunError.make({ reason: "invalid-jsonl" }))
    );
    if (sessionId !== null && sessionId !== event.sessionID) {
      return yield* OpenCodeRunError.make({
        reason: "inconsistent-session",
      });
    }
    sessionId = event.sessionID;
    if (event.type === "text") {
      const text = yield* textFromPart(event.part);
      if (text !== null) {
        texts.push(text);
      }
    }
  }
  if (sessionId === null) {
    return yield* OpenCodeRunError.make({ reason: "missing-session" });
  }
  const text = pipe(texts, EffectArray.last, Option.getOrNull);
  if (text === null) {
    return yield* OpenCodeRunError.make({ reason: "missing-text" });
  }
  return {
    sessionId,
    text: text.slice(0, MAX_RESPONSE_CHARACTERS),
  } satisfies OpenCodeRunResult;
});

export const runOpenCode = Effect.fn("runOpenCode")(function* (options: {
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly prompt: string;
  readonly sessionId?: string;
  readonly timeoutMillis: number;
}) {
  const args = ["run", "--format", "json", "--dir", options.cwd];
  if (options.sessionId !== undefined) {
    args.push("--session", options.sessionId);
  }
  const result = yield* runProcess({
    args,
    environment: options.environment,
    prompt: options.prompt,
    timeoutMillis: options.timeoutMillis,
  });
  if (result.exitCode !== 0) {
    return yield* OpenCodeRunError.make({ reason: "nonzero-exit" });
  }
  return yield* parseOpenCodeJsonl(result.stdout);
});
