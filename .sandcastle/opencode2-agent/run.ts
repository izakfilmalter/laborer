import { spawn } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  classifyRecoveredAssistant,
  type RecoveredSession,
} from "./recovery.ts";

interface Options {
  readonly diagnosticsPath?: string;
  readonly initialStaggerSeconds: number;
  readonly maxAttempts: number;
  readonly recoveryPollSeconds: number;
  readonly recoveryTimeoutSeconds: number;
  readonly retryDelaySeconds: number;
  readonly retryJitterSeconds: number;
  readonly runArgs: readonly string[];
}

interface CommandResult {
  readonly errors: readonly string[];
  readonly exitCode: number;
  readonly sessionId?: string;
  readonly stderrTail: string;
}

const MAX_DIAGNOSTIC_TEXT = 4096;
const MAX_STDERR_TAIL = 8192;
const MAX_API_OUTPUT = 16 * 1024 * 1024;
const MAX_DIAGNOSTIC_LOG = 8 * 1024 * 1024;
const activeChildren = new Set<ReturnType<typeof spawn>>();

const terminate = (exitCode: number): void => {
  for (const child of activeChildren) {
    child.kill("SIGTERM");
  }
  process.exit(exitCode);
};
process.once("SIGINT", () => terminate(130));
process.once("SIGTERM", () => terminate(143));

const options = parseOptions(process.argv.slice(2));
const prompt = await Bun.stdin.text();

if (options.initialStaggerSeconds > 0) {
  await sleep(randomMilliseconds(options.initialStaggerSeconds));
}

let lastError: string | undefined;
let currentArgs = options.runArgs;
let currentPrompt = prompt;
for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
  const startedAt = new Date().toISOString();
  const result = await runStreaming(currentArgs, currentPrompt);
  let recovered: RecoveredSession | undefined;

  if (result.sessionId !== undefined) {
    recovered = await recoverSession(result.sessionId);
    if (recovered?.status === "failed") {
      lastError = recovered.error;
    }
  }

  recordDiagnostic({
    attempt,
    cwd: process.cwd(),
    endedAt: new Date().toISOString(),
    errors: result.errors.map(boundedText),
    exitCode: result.exitCode,
    recoveredError:
      recovered?.status === "failed"
        ? boundedText(recovered.error)
        : undefined,
    recoveredStatus: recovered?.status,
    recoveredText:
      recovered?.status === "succeeded" ? recovered.text.length : 0,
    sessionId: result.sessionId,
    startedAt,
    stderrTail: boundedText(result.stderrTail),
  });

  if (recovered?.status === "succeeded") {
    if (result.exitCode !== 0) {
      for (const text of recovered.text) {
        process.stdout.write(
          `${JSON.stringify({
            part: { text, type: "text" },
            sessionID: result.sessionId,
            type: "text",
          })}\n`
        );
      }
    }
    process.exit(0);
  }
  if (result.exitCode === 0 && recovered?.status !== "incomplete") {
    process.exit(0);
  }
  const retryableProviderFailure =
    recovered?.status === "failed" &&
    recovered.errorType?.startsWith("provider.") === true;
  const incompleteTurn = recovered?.status === "incomplete";
  if (
    attempt >= options.maxAttempts ||
    !(retryableProviderFailure || incompleteTurn)
  ) {
    if (incompleteTurn) {
      lastError = `OpenCode session ${result.sessionId ?? "unknown"} stopped before a terminal assistant response after ${String(attempt)} attempt(s).`;
    }
    if (recovered?.status === "ambiguous") {
      lastError = `OpenCode transport failed and session ${result.sessionId ?? "unknown"} could not be recovered safely; refusing to replay the prompt. Inspect it with: opencode2 api get /api/session/${result.sessionId ?? "SESSION_ID"}`;
    }
    if (lastError !== undefined) {
      process.stdout.write(
        `${JSON.stringify({
          error: { message: lastError },
          type: "error",
        })}\n`
      );
    }
    process.exit(result.exitCode === 0 ? 1 : result.exitCode);
  }
  currentArgs = withSession(options.runArgs, result.sessionId);
  currentPrompt = incompleteTurn
    ? "Continue the existing task from this preserved session and worktree. The previous turn ended before a terminal response. Do not repeat completed side effects."
    : "The previous provider call failed transiently. Continue the existing task from this preserved session and worktree. Do not repeat completed side effects.";

  const baseDelay = attempt * options.retryDelaySeconds * 1000;
  const jitter = randomMilliseconds(options.retryJitterSeconds);
  process.stdout.write(
    `opencode2 attempt ${String(attempt)} ${incompleteTurn ? "ended before a terminal response" : "failed"}; retrying preserved session and worktree in ${String(
      Math.ceil((baseDelay + jitter) / 1000)
    )}s.\n`
  );
  await sleep(baseDelay + jitter);
}

function parseOptions(args: readonly string[]): Options {
  const separator = args.indexOf("--");
  if (separator < 0 || args[separator + 1] !== "opencode2") {
    throw new Error("Expected an opencode2 command after --.");
  }
  const values = new Map<string, string>();
  for (let index = 0; index < separator; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (key === undefined || value === undefined || !key.startsWith("--")) {
      throw new Error("Malformed runner option.");
    }
    values.set(key, value);
  }
  const diagnosticsPath = values.get("--diagnostics-path");
  return {
    ...(diagnosticsPath === undefined ? {} : { diagnosticsPath }),
    initialStaggerSeconds: numberOption(
      values,
      "--initial-stagger-seconds"
    ),
    maxAttempts: numberOption(values, "--max-attempts", 1),
    recoveryPollSeconds: numberOption(values, "--recovery-poll-seconds"),
    recoveryTimeoutSeconds: numberOption(values, "--recovery-timeout-seconds"),
    retryDelaySeconds: numberOption(values, "--retry-delay-seconds"),
    retryJitterSeconds: numberOption(values, "--retry-jitter-seconds"),
    runArgs: args.slice(separator + 2),
  };
}

function numberOption(
  values: ReadonlyMap<string, string>,
  key: string,
  minimum = 0
): number {
  const value = Number(values.get(key));
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${key} must be an integer greater than or equal to ${String(minimum)}.`);
  }
  return value;
}

async function runStreaming(
  args: readonly string[],
  stdin: string
): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn("opencode2", args, {
      env: { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    activeChildren.add(child);
    let stdoutBuffer = "";
    let stderrTail = "";
    let sessionId: string | undefined;
    const errors: string[] = [];

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      process.stdout.write(chunk);
      stdoutBuffer = `${stdoutBuffer}${chunk}`.slice(-MAX_API_OUTPUT);
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const event = parseRecord(line);
        const eventSessionId = sessionIdFrom(event);
        if (eventSessionId !== undefined) {
          sessionId = eventSessionId;
        }
        const message = errorMessage(event);
        if (message !== undefined) {
          errors.push(message);
          if (errors.length > 8) {
            errors.shift();
          }
        }
      }
    });
    child.stderr.on("data", (chunk: string) => {
      process.stderr.write(chunk);
      stderrTail = `${stderrTail}${chunk}`.slice(-MAX_STDERR_TAIL);
    });
    child.on("error", (error) => {
      activeChildren.delete(child);
      reject(error);
    });
    child.on("close", (code, signal) => {
      activeChildren.delete(child);
      resolve({
        errors,
        exitCode: code ?? (signal === null ? 1 : 128),
        ...(sessionId === undefined ? {} : { sessionId }),
        stderrTail,
      });
    });
    child.stdin.end(stdin);
  });
}

function withSession(
  args: readonly string[],
  sessionId: string | undefined
): readonly string[] {
  if (sessionId === undefined) {
    return args;
  }
  return [...args, "--session", sessionId];
}

async function recoverSession(
  sessionId: string
): Promise<RecoveredSession | undefined> {
  const deadline = Date.now() + options.recoveryTimeoutSeconds * 1000;
  let consecutiveApiFailures = 0;
  let lastProgressAt = 0;
  while (true) {
    const active = await runCaptured(["api", "get", "/api/session/active"]);
    const payload = parseRecord(active.stdout);
    if (
      active.exitCode !== 0 ||
      payload === undefined ||
      !isRecord(payload.data)
    ) {
      consecutiveApiFailures += 1;
      if (consecutiveApiFailures >= 3 || Date.now() >= deadline) {
        return { status: "ambiguous" };
      }
    } else {
      consecutiveApiFailures = 0;
      if (!(sessionId in payload.data)) {
        break;
      }
      if (Date.now() >= deadline) {
        return { status: "ambiguous" };
      }
      if (Date.now() - lastProgressAt >= 30_000) {
        process.stdout.write(
          `OpenCode event transport disconnected; session ${sessionId} is still running server-side. Waiting for its durable outcome.\n`
        );
        lastProgressAt = Date.now();
      }
    }
    await sleep(options.recoveryPollSeconds * 1000);
  }
  const messages = await runCaptured([
    "api",
    "get",
    `/api/session/${encodeURIComponent(sessionId)}/message?limit=1&order=desc`,
  ]);
  if (messages.exitCode !== 0) {
    return { status: "ambiguous" };
  }
  const payload = parseRecord(messages.stdout);
  if (payload === undefined || !Array.isArray(payload.data)) {
    return { status: "ambiguous" };
  }
  const assistant = payload.data.find(
    (message): message is Record<string, unknown> =>
      isRecord(message) && message.type === "assistant"
  );
  if (assistant === undefined) {
    return { status: "ambiguous" };
  }
  return classifyRecoveredAssistant(assistant);
}

async function runCaptured(
  args: readonly string[]
): Promise<{ readonly exitCode: number; readonly stdout: string }> {
  return await new Promise((resolve) => {
    const child = spawn("opencode2", args, {
      env: { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: "1" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    activeChildren.add(child);
    let stdout = "";
    let overflow = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const remaining = MAX_API_OUTPUT - stdout.length;
      if (remaining > 0) {
        stdout += chunk.slice(0, remaining);
      }
      if (chunk.length > remaining) {
        overflow = true;
        child.kill("SIGTERM");
      }
    });
    child.on("error", () => {
      activeChildren.delete(child);
      resolve({ exitCode: 1, stdout: "" });
    });
    child.on("close", (code) => {
      activeChildren.delete(child);
      resolve({ exitCode: overflow ? 1 : (code ?? 1), stdout });
    });
  });
}

function parseRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sessionIdFrom(
  event: Record<string, unknown> | undefined
): string | undefined {
  if (event === undefined) {
    return undefined;
  }
  if (typeof event.sessionID === "string") {
    return event.sessionID;
  }
  return isRecord(event.part) && typeof event.part.sessionID === "string"
    ? event.part.sessionID
    : undefined;
}

function errorMessage(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value.message === "string") {
    return value.message;
  }
  return errorMessage(value.error);
}

function recordDiagnostic(value: Record<string, unknown>): void {
  if (options.diagnosticsPath === undefined) {
    return;
  }
  mkdirSync(dirname(options.diagnosticsPath), { recursive: true });
  try {
    if (statSync(options.diagnosticsPath).size >= MAX_DIAGNOSTIC_LOG) {
      return;
    }
  } catch {
    // The first append creates the file.
  }
  appendFileSync(
    options.diagnosticsPath,
    `${JSON.stringify(redactDiagnostic(value))}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
    }
  );
  chmodSync(options.diagnosticsPath, 0o600);
}

function boundedText(value: string): string {
  return value.length <= MAX_DIAGNOSTIC_TEXT
    ? value
    : value.slice(-MAX_DIAGNOSTIC_TEXT);
}

function redactDiagnostic(
  value: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      typeof entry === "string"
        ? redactText(entry)
        : Array.isArray(entry)
          ? entry.map((item) =>
              typeof item === "string" ? redactText(item) : item
            )
          : entry,
    ])
  );
}

function redactText(value: string): string {
  return value
    .replace(/\b(?:Bearer\s+)?sk-[A-Za-z0-9_-]{12,}\b/giu, "[REDACTED]")
    .replace(/\bxox[a-z]-[A-Za-z0-9-]{10,}\b/giu, "[REDACTED]");
}

function randomMilliseconds(maximumSeconds: number): number {
  return maximumSeconds === 0
    ? 0
    : Math.floor(Math.random() * (maximumSeconds * 1000 + 1));
}

async function sleep(milliseconds: number): Promise<void> {
  if (milliseconds > 0) {
    await Bun.sleep(milliseconds);
  }
}
