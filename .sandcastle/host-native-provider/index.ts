import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Stream } from "node:stream";
import type {
  InteractiveExecOptions,
  NoSandboxHandle,
} from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";

const DEFAULT_MAX_OUTPUT_TAIL_CHARS = 64 * 1024;
const KILL_GRACE_MS = 10_000;
const timeoutMarker = /^# sandcastle-timeout-seconds=(\d+(?:\.\d+)?)\n/;
const activeProcessGroups = new Set<number>();

process.on("exit", () => {
  for (const processGroup of activeProcessGroups) {
    signalProcessGroup(processGroup, "SIGKILL");
  }
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    // Sandcastle may call process.exit from its own signal listener. Kill now,
    // synchronously, so listener ordering cannot strand detached descendants.
    for (const processGroup of activeProcessGroups) {
      signalProcessGroup(processGroup, "SIGKILL");
    }
    setImmediate(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });
}

export interface HostNativeProviderOptions {
  readonly defaultTimeoutSeconds: number;
  readonly env?: Record<string, string>;
  readonly killGraceMilliseconds?: number;
  readonly maxOutputTailChars?: number;
}

interface SupervisedNoSandboxRuntime {
  readonly create: (options: {
    readonly env: Record<string, string>;
    readonly worktreePath: string;
  }) => Promise<NoSandboxHandle>;
  readonly env: Record<string, string>;
  readonly name: string;
  readonly tag: "none";
}

export const boundedHostCommand = (command: string, timeoutSeconds: number) =>
  `# sandcastle-timeout-seconds=${String(positiveTimeout(timeoutSeconds))}\n${command}`;

export const supervisedNoSandbox = (
  options: HostNativeProviderOptions
): ReturnType<typeof noSandbox> & SupervisedNoSandboxRuntime => {
  const provider = {
    tag: "none" as const,
    name: "supervised-no-sandbox",
    env: options.env ?? {},
    async create(createOptions: {
      readonly env: Record<string, string>;
      readonly worktreePath: string;
    }): Promise<NoSandboxHandle> {
      const worktreePath = createOptions.worktreePath;
      const gitConfigDirectory = mkdtempSync(
        join(tmpdir(), "laborer-sandcastle-git-")
      );
      const gitConfigPath = join(gitConfigDirectory, "config");
      const inheritedGitConfig =
        process.env.GIT_CONFIG_GLOBAL ?? join(homedir(), ".gitconfig");
      writeFileSync(
        gitConfigPath,
        existsSync(inheritedGitConfig)
          ? `[include]\n\tpath = ${JSON.stringify(inheritedGitConfig)}\n`
          : "",
        { mode: 0o600 }
      );
      const environment = {
        ...process.env,
        ...options.env,
        ...createOptions.env,
        // Sandcastle's lifecycle writes safe.directory and identity through
        // `git config --global`. Give every concurrent host handle its own
        // overlay so those writes cannot race on the user's ~/.gitconfig.
        GIT_CONFIG_GLOBAL: gitConfigPath,
      };
      const activeChildren = new Map<number, ChildProcess>();
      const activeExecutions = new Set<Promise<unknown>>();
      const maxOutputTailChars =
        options.maxOutputTailChars ?? DEFAULT_MAX_OUTPUT_TAIL_CHARS;
      const killGraceMilliseconds =
        options.killGraceMilliseconds ?? KILL_GRACE_MS;

    const runProcess = (
      executable: string,
      args: readonly string[],
      runOptions: {
        readonly commandTimeoutSeconds: number;
        readonly cwd: string;
        readonly onLine?: (line: string) => void;
        readonly stderr: Stream | "pipe";
        readonly stdin?: string | Stream;
        readonly stdout: Stream | "pipe";
      }
    ) => {
      const execution = new Promise<{
        readonly exitCode: number;
        readonly stderr: string;
        readonly stdout: string;
      }>((resolve, reject) => {
        const child = spawn(executable, args, {
          cwd: runOptions.cwd,
          detached: true,
          env: environment,
          stdio: [
            typeof runOptions.stdin === "string" ? "pipe" : runOptions.stdin ?? "ignore",
            runOptions.stdout,
            runOptions.stderr,
          ],
        });
        if (child.pid === undefined) {
          child.once("error", reject);
          return;
        }
        const processGroup = child.pid;
        activeChildren.set(processGroup, child);
        activeProcessGroups.add(processGroup);
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let settled = false;
        let exitCode: number | null = null;
        let descendantCleanup: Promise<void> = Promise.resolve();
        let pendingLine = "";
        const appendTail = (tail: string, chunk: string) =>
          `${tail}${chunk}`.slice(-maxOutputTailChars);
        const timeout = setTimeout(() => {
          timedOut = true;
          void terminateProcessGroup(processGroup, killGraceMilliseconds);
        }, runOptions.commandTimeoutSeconds * 1000);

        if (typeof runOptions.stdin === "string") {
          child.stdin?.end(runOptions.stdin);
        }
        if (child.stdout !== null) {
          if (runOptions.onLine === undefined) {
            child.stdout.on("data", (chunk: Buffer) => {
              stdout = appendTail(stdout, chunk.toString());
            });
          } else {
            child.stdout.on("data", (chunk: Buffer) => {
              pendingLine += chunk.toString();
              let newline = pendingLine.indexOf("\n");
              while (newline >= 0) {
                const line = pendingLine.slice(0, newline).replace(/\r$/, "");
                stdout = appendTail(stdout, `${line}\n`);
                runOptions.onLine?.(line);
                pendingLine = pendingLine.slice(newline + 1);
                newline = pendingLine.indexOf("\n");
              }
              pendingLine = pendingLine.slice(-maxOutputTailChars);
            });
          }
        }
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr = appendTail(stderr, chunk.toString());
        });
        child.on("error", (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          activeChildren.delete(processGroup);
          activeProcessGroups.delete(processGroup);
          reject(error);
        });
        child.on("exit", (code) => {
          if (settled) return;
          exitCode = code;
          clearTimeout(timeout);
          descendantCleanup = terminateProcessGroup(
            processGroup,
            killGraceMilliseconds
          );
        });
        child.on("close", () => {
          if (settled) return;
          void descendantCleanup.then(() => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (runOptions.onLine !== undefined && pendingLine.length > 0) {
              stdout = appendTail(stdout, pendingLine);
              runOptions.onLine(pendingLine);
            }
            activeChildren.delete(processGroup);
            activeProcessGroups.delete(processGroup);
            resolve({
              exitCode: timedOut ? 124 : (exitCode ?? 1),
              stderr,
              stdout,
            });
          });
        });
      });
      activeExecutions.add(execution);
      void execution.then(
        () => activeExecutions.delete(execution),
        () => activeExecutions.delete(execution)
      );
      return execution;
    };

    return {
      worktreePath,
      exec(command: string, execOptions?: Parameters<NoSandboxHandle["exec"]>[1]) {
        const marker = timeoutMarker.exec(command);
        const timeoutSeconds =
          marker === null
            ? options.defaultTimeoutSeconds
            : Number(marker[1]);
        const strippedCommand =
          marker === null ? command : command.slice(marker[0].length);
        return runProcess("sh", ["-c", strippedCommand], {
          commandTimeoutSeconds: timeoutSeconds,
          cwd: execOptions?.cwd ?? worktreePath,
          ...(execOptions?.onLine === undefined
            ? undefined
            : { onLine: execOptions.onLine }),
          stderr: "pipe",
          ...(execOptions?.stdin === undefined
            ? undefined
            : { stdin: execOptions.stdin }),
          stdout: "pipe",
        });
      },
      async interactiveExec(args: string[], execOptions: InteractiveExecOptions) {
        const [executable, ...rest] = args;
        if (executable === undefined) {
          throw new Error("Interactive command cannot be empty.");
        }
        const result = await runProcess(executable, rest, {
          commandTimeoutSeconds: options.defaultTimeoutSeconds,
          cwd: execOptions.cwd ?? worktreePath,
          stderr: execOptions.stderr as unknown as Stream,
          stdin: execOptions.stdin as unknown as Stream,
          stdout: execOptions.stdout as unknown as Stream,
        });
        return { exitCode: result.exitCode };
      },
      async close() {
        await Promise.all(
          [...activeChildren.keys()].map((processGroup) =>
            terminateProcessGroup(processGroup, killGraceMilliseconds)
          )
        );
        await Promise.allSettled(activeExecutions);
        rmSync(gitConfigDirectory, { force: true, recursive: true });
      },
    };
    },
  };
  // Sandcastle's public NoSandboxProvider type intentionally hides the runtime
  // tag/create members used by provider implementations.
  return provider as unknown as ReturnType<typeof noSandbox> &
    SupervisedNoSandboxRuntime;
};

const signalProcessGroup = (
  processGroup: number,
  signal: NodeJS.Signals
) => {
  try {
    process.kill(-processGroup, signal);
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ESRCH"
    ) {
      throw error;
    }
  }
};

const processGroupExists = (processGroup: number) => {
  try {
    process.kill(-processGroup, 0);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    ) {
      return false;
    }
    throw error;
  }
};

const terminateProcessGroup = async (
  processGroup: number,
  graceMilliseconds: number
) => {
  if (!processGroupExists(processGroup)) return;
  signalProcessGroup(processGroup, "SIGTERM");
  const deadline = Date.now() + graceMilliseconds;
  while (processGroupExists(processGroup) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (processGroupExists(processGroup)) {
    signalProcessGroup(processGroup, "SIGKILL");
    const reapDeadline = Date.now() + 1000;
    while (processGroupExists(processGroup) && Date.now() < reapDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
};

const positiveTimeout = (seconds: number) => {
  if (!(Number.isFinite(seconds) && seconds > 0)) {
    throw new Error("Host command timeout must be positive.");
  }
  return seconds;
};
