import { readFileSync } from "node:fs";

const linuxProcessState = (pid: number): string | null => {
  if (process.platform !== "linux") {
    return null;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    return commandEnd < 0 ? null : (stat[commandEnd + 2] ?? null);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return "missing";
    }
    return null;
  }
};

/** Treat an unreaped Linux zombie as exited: it can no longer execute code. */
export const isProcessRunning = (pid: number): boolean => {
  const state = linuxProcessState(pid);
  if (state === "missing" || state === "Z") {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
