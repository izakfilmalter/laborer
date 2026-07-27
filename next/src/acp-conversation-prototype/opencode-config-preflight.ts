import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { Effect } from "effect";
import { HandlerFailure } from "../prototype/errors.ts";

const CONFIG_PROBE_ARGS = ["debug", "config"] as const;
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

const collectEffectiveConfig = (options: {
  readonly command: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly limits: ResolvedConfigProbeLimits;
}): Promise<string> =>
  new Promise<string>((resolveProbe, rejectProbe) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(options.command, [...CONFIG_PROBE_ARGS], {
        cwd: options.cwd,
        detached: process.platform !== "win32",
        env: options.environment,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      rejectProbe(new Error("probe spawn failed"));
      return;
    }

    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let runtimeTimer: ReturnType<typeof setTimeout> | undefined;
    const startupTimer = setTimeout(() => {
      failProbe();
    }, options.limits.startupTimeoutMillis);

    const cleanup = (): void => {
      clearTimeout(startupTimer);
      if (runtimeTimer !== undefined) {
        clearTimeout(runtimeTimer);
      }
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      child.removeAllListeners();
    };
    const failProbe = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      terminateProbe(child);
      cleanup();
      rejectProbe(new Error("probe failed"));
    };
    const completeProbe = (source: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolveProbe(source);
    };

    child.stdin.end();
    child.once("error", failProbe);
    child.once("spawn", () => {
      clearTimeout(startupTimer);
      runtimeTimer = setTimeout(failProbe, options.limits.runtimeTimeoutMillis);
    });
    child.stdout.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += bytes.byteLength;
      if (stdoutBytes > options.limits.maxStdoutBytes) {
        failProbe();
        return;
      }
      stdout.push(bytes);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > options.limits.maxStderrBytes) {
        failProbe();
      }
    });
    child.once("close", (code, signal) => {
      if (code !== 0 || signal !== null) {
        failProbe();
        return;
      }
      try {
        completeProbe(
          new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(stdout)
          )
        );
      } catch {
        failProbe();
      }
    });
  });

const exactEffectiveMcpNames = (source: string): ReadonlySet<string> => {
  const parsed = JSON.parse(source) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("effective config is not an object");
  }
  const effectiveConfig = parsed as Record<string, unknown>;
  const mcp = effectiveConfig.mcp;
  if (mcp === undefined) {
    return new Set();
  }
  if (typeof mcp !== "object" || mcp === null || Array.isArray(mcp)) {
    throw new Error("effective MCP config is not an object");
  }
  return new Set(Object.keys(mcp));
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
    try: async () => {
      const source = await collectEffectiveConfig({
        command: options.command,
        cwd: options.cwd,
        environment: options.environment,
        limits: resolveLimits(options.limits),
      });
      return exactEffectiveMcpNames(source);
    },
    catch: preflightFailure,
  });
  for (const name of effectiveMcpNames) {
    if (reservedNames.has(name)) {
      return yield* preflightFailure();
    }
  }
});
