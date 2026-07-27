import type { ChildProcessWithoutNullStreams } from "node:child_process";

const DEFAULT_GRACE_MILLIS = 3000;

export interface SubprocessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface SubprocessSupervisor {
  readonly terminate: () => Promise<SubprocessExit>;
  readonly waitForExit: (
    timeoutMillis: number
  ) => Promise<SubprocessExit | null>;
}

const waitWithTimeout = async <Value>(
  promise: Promise<Value>,
  timeoutMillis: number
): Promise<Value | null> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(null), timeoutMillis);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
};

const closeStdin = (child: ChildProcessWithoutNullStreams): void => {
  if (!(child.stdin.destroyed || child.stdin.writableEnded)) {
    child.stdin.end();
  }
};

export const superviseSubprocess = (
  child: ChildProcessWithoutNullStreams,
  options: {
    readonly graceMillis?: number;
    readonly label: string;
  }
): SubprocessSupervisor => {
  child.on("error", () => undefined);
  child.stdin.on("error", () => undefined);
  let settled = false;
  const exit = new Promise<SubprocessExit>((resolveExit) => {
    child.once("close", (code, signal) => {
      settled = true;
      resolveExit({ code, signal });
    });
  });
  const graceMillis = options.graceMillis ?? DEFAULT_GRACE_MILLIS;
  let termination: Promise<SubprocessExit> | undefined;
  const waitForExit = (
    timeoutMillis: number
  ): Promise<SubprocessExit | null> =>
    settled ? exit : waitWithTimeout(exit, timeoutMillis);
  const terminate = (): Promise<SubprocessExit> => {
    if (termination !== undefined) {
      return termination;
    }
    termination = (async () => {
      closeStdin(child);
      const cleanExit = await waitForExit(graceMillis);
      if (cleanExit !== null) {
        return cleanExit;
      }
      child.kill("SIGTERM");
      const terminated = await waitForExit(graceMillis);
      if (terminated !== null) {
        return terminated;
      }
      child.kill("SIGKILL");
      const killed = await waitForExit(graceMillis);
      if (killed !== null) {
        return killed;
      }
      throw new Error(
        `${options.label} did not close after stdin EOF, SIGTERM, and SIGKILL`
      );
    })();
    return termination;
  };
  return { terminate, waitForExit };
};
