#!/usr/bin/env node
import { spawn } from "node:child_process";

const MAX_EXPORT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

const fail = (message: string): never => {
  process.stderr.write(`OpenCode recovery failed: ${message}\n`);
  process.exit(1);
};

const command = process.argv[2] ?? fail("missing command");
const sessionId = process.argv[3] ?? fail("missing session");
const baselineInput = process.argv[4];
const baseline = Number(baselineInput);
if (!Number.isSafeInteger(baseline) || baseline < 0) {
  fail("invalid invocation");
}

const child = spawn(command, ["export", sessionId, "--pure"], {
  env: process.env,
  shell: false,
  stdio: ["pipe", "pipe", "pipe"] as const,
});
child.stdin.end();

let stdout = Buffer.alloc(0);
let stderr = Buffer.alloc(0);
child.stdout.on("data", (chunk: Buffer) => {
  if (stdout.length + chunk.length > MAX_EXPORT_BYTES) {
    child.kill("SIGKILL");
    fail("export exceeds limit");
  }
  stdout = Buffer.concat([stdout, chunk], stdout.length + chunk.length);
});
child.stderr.on("data", (chunk: Buffer) => {
  const combined = Buffer.concat([stderr, chunk]);
  stderr = combined.subarray(-MAX_STDERR_BYTES);
});

const exit = await new Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}>((resolveExit) => {
  child.once("error", () => resolveExit({ code: null, signal: null }));
  child.once("exit", (code: number | null, signal: NodeJS.Signals | null) =>
    resolveExit({ code, signal })
  );
});
if (stderr.length > 0) {
  process.stderr.write(stderr);
}
if (exit.code !== 0 || exit.signal !== null) {
  fail("export command failed");
}

let exported: unknown;
try {
  exported = JSON.parse(fatalUtf8Decoder.decode(stdout)) as unknown;
} catch {
  fail("export is not valid UTF-8 JSON");
}
if (
  typeof exported !== "object" ||
  exported === null ||
  !("info" in exported) ||
  !("messages" in exported) ||
  typeof exported.info !== "object" ||
  exported.info === null ||
  !("id" in exported.info) ||
  exported.info.id !== sessionId ||
  !Array.isArray(exported.messages)
) {
  fail("export shape is invalid");
}

const exportRecord = exported as {
  readonly messages: unknown[];
};
const messages = exportRecord.messages;
const isFiniteNonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const postBaseline = messages.slice(baseline);
const postBaselineAssistants = postBaseline.filter(
  (message: unknown) =>
    typeof message === "object" &&
    message !== null &&
    "info" in message &&
    typeof message.info === "object" &&
    message.info !== null &&
    "role" in message.info &&
    message.info.role === "assistant"
);
const assistant = postBaselineAssistants.at(-1);
const isCompleteAssistant = (message: unknown): boolean => {
  if (
    typeof message !== "object" ||
    message === null ||
    !("info" in message) ||
    typeof message.info !== "object" ||
    message.info === null
  ) {
    return false;
  }
  const info = message.info as Record<string, unknown>;
  const time = info.time;
  const path = info.path;
  const tokens = info.tokens;
  const cache =
    typeof tokens === "object" && tokens !== null && "cache" in tokens
      ? tokens.cache
      : null;
  const finish = info.finish;
  return (
    info.role === "assistant" &&
    (!("error" in info) || info.error == null) &&
    typeof info.id === "string" &&
    info.id.trim().length > 0 &&
    info.sessionID === sessionId &&
    typeof info.parentID === "string" &&
    info.parentID.trim().length > 0 &&
    typeof info.modelID === "string" &&
    info.modelID.trim().length > 0 &&
    typeof info.providerID === "string" &&
    info.providerID.trim().length > 0 &&
    typeof info.mode === "string" &&
    info.mode.trim().length > 0 &&
    typeof info.agent === "string" &&
    info.agent.trim().length > 0 &&
    typeof finish === "string" &&
    finish.trim().length > 0 &&
    finish !== "tool-calls" &&
    finish !== "unknown" &&
    typeof time === "object" &&
    time !== null &&
    "created" in time &&
    isFiniteNonnegative(time.created) &&
    "completed" in time &&
    isFiniteNonnegative(time.completed) &&
    typeof path === "object" &&
    path !== null &&
    "cwd" in path &&
    typeof path.cwd === "string" &&
    "root" in path &&
    typeof path.root === "string" &&
    isFiniteNonnegative(info.cost) &&
    typeof tokens === "object" &&
    tokens !== null &&
    "input" in tokens &&
    isFiniteNonnegative(tokens.input) &&
    "output" in tokens &&
    isFiniteNonnegative(tokens.output) &&
    "reasoning" in tokens &&
    isFiniteNonnegative(tokens.reasoning) &&
    typeof cache === "object" &&
    cache !== null &&
    "read" in cache &&
    isFiniteNonnegative(cache.read) &&
    "write" in cache &&
    isFiniteNonnegative(cache.write)
  );
};
if (assistant !== undefined && !isCompleteAssistant(assistant)) {
  fail("post-baseline assistant is incomplete or aborted");
}
let text: string | undefined;
if (
  typeof assistant === "object" &&
  assistant !== null &&
  "parts" in assistant &&
  Array.isArray(assistant.parts)
) {
  const textParts = assistant.parts.flatMap((part: unknown) =>
    typeof part === "object" &&
    part !== null &&
    "type" in part &&
    part.type === "text" &&
    "text" in part &&
    typeof part.text === "string"
      ? [part.text]
      : []
  );
  const joined = textParts.join("\n");
  if (joined.length > 0) {
    text = joined;
  }
}

process.stdout.write(
  `${JSON.stringify({
    messageCount: messages.length,
    ...(text === undefined ? {} : { text }),
  })}\n`
);
