import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { LaborerMcpServerKind } from "./mcp-server-launcher-config.ts";

const ACTION_SERVER_PATH = fileURLToPath(
  new URL("./action-mcp-server.ts", import.meta.url)
);
const MEMORY_SERVER_PATH = fileURLToPath(
  new URL("./memory-mcp-server.ts", import.meta.url)
);

const SYSTEM_ENVIRONMENT_NAMES = [
  "ComSpec",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "WINDIR",
  "__CF_USER_TEXT_ENCODING",
] as const;

const ACTION_ENVIRONMENT_NAMES = [
  "LABORER_ACTION_BOOTSTRAP_PATH",
  "LABORER_ACTION_CONTROL_URL",
  "LABORER_ACTION_SERVER_GENERATION",
  "LABORER_ACTION_SERVER_NAME",
] as const;

const MEMORY_ENVIRONMENT_NAMES = [
  "LABORER_MEMORY_AUTHORITY_GUARD",
  "LABORER_MEMORY_READY_PATH",
  "LABORER_MEMORY_REGISTRATION_NONCE",
  "LABORER_MEMORY_ROOT",
  "LABORER_MEMORY_SERVER_NAME",
  "LABORER_MEMORY_WORKSPACE_ID",
] as const;

const serverKind = process.argv[2];
if (
  process.argv.length !== 3 ||
  (serverKind !== "action" && serverKind !== "memory")
) {
  process.stderr.write("[laborer-mcp-launcher] invalid fixed server kind\n");
  process.exitCode = 1;
} else {
  const kind: LaborerMcpServerKind = serverKind;
  const serverPath =
    kind === "action" ? ACTION_SERVER_PATH : MEMORY_SERVER_PATH;
  const allowedNames = [
    ...SYSTEM_ENVIRONMENT_NAMES,
    ...(kind === "action"
      ? ACTION_ENVIRONMENT_NAMES
      : MEMORY_ENVIRONMENT_NAMES),
  ];
  const environment: NodeJS.ProcessEnv = {};
  for (const name of allowedNames) {
    const value = process.env[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }

  const child = spawn(process.execPath, [serverPath], {
    env: environment,
    stdio: "inherit",
  });
  const forwardSignal = (signal: NodeJS.Signals): void => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
    }
  };
  const forwardInterrupt = (): void => forwardSignal("SIGINT");
  const forwardTermination = (): void => forwardSignal("SIGTERM");
  process.once("SIGINT", forwardInterrupt);
  process.once("SIGTERM", forwardTermination);
  await new Promise<void>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (code, signal) => {
      process.off("SIGINT", forwardInterrupt);
      process.off("SIGTERM", forwardTermination);
      if (signal !== null) {
        process.exitCode = 1;
      } else {
        process.exitCode = code ?? 1;
      }
      resolveExit();
    });
  }).catch(() => {
    process.stderr.write("[laborer-mcp-launcher] server launch failed\n");
    process.exitCode = 1;
  });
}
