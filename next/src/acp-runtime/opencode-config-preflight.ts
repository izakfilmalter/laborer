import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Effect } from "effect";
import { HandlerFailure } from "../prototype/errors.ts";

const CONFIG_PROBE_ARGS = ["serve", "--stdio", "--port", "0"] as const;
const CONFIG_PROBE_STARTUP_TIMEOUT_MILLIS = 5000;
const CONFIG_PROBE_RUNTIME_TIMEOUT_MILLIS = 15_000;
const CONFIG_PROBE_MAX_STDOUT_BYTES = 1024 * 1024;
const CONFIG_PROBE_MAX_STDERR_BYTES = 64 * 1024;

interface ConfigProbeLimits {
  readonly maxStderrBytes?: number;
  readonly maxStdoutBytes?: number;
  readonly runtimeTimeoutMillis?: number;
  readonly startupTimeoutMillis?: number;
}

interface EffectiveConfigProbeOptions {
  readonly command: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly limits?: ConfigProbeLimits;
  readonly reservedNames: readonly string[];
}

interface ResolvedConfigProbeLimits {
  readonly maxStderrBytes: number;
  readonly maxStdoutBytes: number;
  readonly runtimeTimeoutMillis: number;
  readonly startupTimeoutMillis: number;
}

const preflightFailure = (): HandlerFailure =>
  HandlerFailure.make({
    category: "protocol",
    safeDetail: "OpenCode effective configuration is incompatible",
  });

const positiveLimit = (value: number | undefined, fallback: number): number =>
  value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;

const resolveLimits = (
  limits: ConfigProbeLimits | undefined
): ResolvedConfigProbeLimits => ({
  maxStderrBytes: positiveLimit(
    limits?.maxStderrBytes,
    CONFIG_PROBE_MAX_STDERR_BYTES
  ),
  maxStdoutBytes: positiveLimit(
    limits?.maxStdoutBytes,
    CONFIG_PROBE_MAX_STDOUT_BYTES
  ),
  runtimeTimeoutMillis: positiveLimit(
    limits?.runtimeTimeoutMillis,
    CONFIG_PROBE_RUNTIME_TIMEOUT_MILLIS
  ),
  startupTimeoutMillis: positiveLimit(
    limits?.startupTimeoutMillis,
    CONFIG_PROBE_STARTUP_TIMEOUT_MILLIS
  ),
});

const terminateProbe = (child: ChildProcessWithoutNullStreams): void => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.stdin.end();
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // Fall through to the direct child handle.
    }
  }
  child.kill("SIGKILL");
};

const startupUrl = (
  child: ChildProcessWithoutNullStreams,
  limits: ResolvedConfigProbeLimits
): Promise<string> =>
  new Promise<string>((resolveUrl, rejectUrl) => {
    let settled = false;
    let stdout = Buffer.alloc(0);
    let stderrBytes = 0;
    const timer = setTimeout(() => fail(), limits.startupTimeoutMillis);
    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout.removeListener("data", onStdout);
      child.stderr.removeListener("data", onStderr);
      child.removeListener("error", fail);
      child.removeListener("exit", fail);
    };
    const fail = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      rejectUrl(new Error("OpenCode probe startup failed"));
    };
    const onStderr = (chunk: Buffer | string): void => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > limits.maxStderrBytes) {
        fail();
      }
    };
    const onStdout = (chunk: Buffer | string): void => {
      stdout = Buffer.concat([
        stdout,
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      ]);
      if (stdout.byteLength > limits.maxStdoutBytes) {
        fail();
        return;
      }
      const newline = stdout.indexOf(0x0a);
      if (newline < 0) {
        return;
      }
      try {
        const parsed: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            stdout.subarray(0, newline)
          )
        );
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed) ||
          !("url" in parsed) ||
          typeof parsed.url !== "string"
        ) {
          fail();
          return;
        }
        settled = true;
        cleanup();
        resolveUrl(parsed.url);
      } catch {
        fail();
      }
    };
    child.once("error", fail);
    child.once("exit", fail);
    child.stderr.on("data", onStderr);
    child.stdout.on("data", onStdout);
  });

const exactEffectiveMcpNames = (source: string): ReadonlySet<string> => {
  const parsed = JSON.parse(source) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !("data" in parsed) ||
    !Array.isArray(parsed.data)
  ) {
    throw new Error("effective MCP response is invalid");
  }
  const names = parsed.data.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry) ||
      !("name" in entry) ||
      typeof entry.name !== "string"
    ) {
      throw new Error("effective MCP entry is invalid");
    }
    return entry.name;
  });
  return new Set(names);
};

const readBoundedResponse = async (
  response: Response,
  maximumBytes: number
): Promise<Buffer> => {
  if (response.body === null) {
    return Buffer.alloc(0);
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        return Buffer.concat(chunks, totalBytes);
      }
      totalBytes += next.value.byteLength;
      if (totalBytes > maximumBytes) {
        throw new Error("OpenCode MCP probe response exceeded the limit");
      }
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
};

const collectEffectiveMcpNames = async (options: {
  readonly command: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly limits: ResolvedConfigProbeLimits;
}): Promise<ReadonlySet<string>> => {
  const password = randomBytes(32).toString("base64url");
  const child = spawn(options.command, [...CONFIG_PROBE_ARGS], {
    cwd: options.cwd,
    detached: process.platform !== "win32",
    env: {
      ...options.environment,
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_PASSWORD: password,
    },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  try {
    const url = await startupUrl(child, options.limits);
    child.stdout.resume();
    child.stderr.resume();
    const endpoint = new URL("/api/mcp", url);
    endpoint.searchParams.set("location[directory]", options.cwd);
    const response = await fetch(endpoint, {
      headers: {
        authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
      },
      signal: AbortSignal.timeout(options.limits.runtimeTimeoutMillis),
    });
    if (!response.ok) {
      throw new Error("OpenCode MCP probe request failed");
    }
    const bytes = await readBoundedResponse(
      response,
      options.limits.maxStdoutBytes
    );
    return exactEffectiveMcpNames(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    );
  } finally {
    terminateProbe(child);
  }
};

export const preflightEffectiveOpenCodeMcpNames = Effect.fn(
  "preflightEffectiveOpenCodeMcpNames"
)(function* (
  options: EffectiveConfigProbeOptions
): Effect.fn.Return<void, HandlerFailure> {
  const reservedNames = new Set(options.reservedNames);
  if (
    options.command.length === 0 ||
    reservedNames.size !== options.reservedNames.length ||
    [...reservedNames].some((name) => name.length === 0)
  ) {
    return yield* preflightFailure();
  }
  const effectiveMcpNames = yield* Effect.tryPromise({
    try: () =>
      collectEffectiveMcpNames({
        command: options.command,
        cwd: options.cwd,
        environment: options.environment,
        limits: resolveLimits(options.limits),
      }),
    catch: preflightFailure,
  });
  for (const name of effectiveMcpNames) {
    if (reservedNames.has(name)) {
      return yield* preflightFailure();
    }
  }
});
