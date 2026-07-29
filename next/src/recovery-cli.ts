import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Effect } from "effect";
import {
  inspectAcpRecoveryHealthOffline,
  inspectAcpRecoveryOffline,
  resolveAcpRecoveryOffline,
} from "./slack/acp-recovery.ts";
import { loadLaborerConfig } from "./slack/laborer-config.ts";
import { acquireRunnerLock } from "./slack/runner-lock.ts";
import { prepareSlackRuntimePaths } from "./slack/runtime-paths.ts";

const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_REJECTED = 3;
const EXIT_UNAVAILABLE = 4;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

const USAGE = `Laborer recovery CLI — inspect and resolve uncertain agent turns.

Usage
  bun run --cwd next recovery <command> [options]

Commands
  health   Report runtime readiness and bounded reason codes per workspace.
  list     List attempts that are blocked awaiting an operator decision.
  inspect  Show bounded, opaque correlated evidence for one blocked attempt.
  abandon  Drop the uncertain attempt and continue in a replacement agent session.
  retry    Rerun the uncertain attempt in a replacement agent session. This is
           the only command that can duplicate external side effects.

Options
  --workspace <slack-team-id>  Required by inspect, abandon, and retry. Omit it
                               to run health or list across every workspace.
  --attempt <attempt-id>       Required by inspect, abandon, and retry.
  --decision-id <id>           Required by abandon and retry. Replaying the same
                               ID is idempotent; a different decision for the
                               same attempt fails closed.
  --acknowledge-duplicate-side-effects
                               Required by retry, spelled in full, to confirm
                               that external side effects may be duplicated.
  --root <path>                Laborer root. Defaults to the working directory.
  --help, -h                   Show this help.

Output
  Every command prints exactly one JSON line on stdout:
    {"ok":true,"result":...}     the command was accepted
    {"ok":false,"error":"..."}   the command was rejected or unavailable
  Usage errors additionally print an explanation and this help on stderr.
  Exit codes: 0 accepted, 2 usage, 3 rejected, 4 runtime unavailable.

Resolving a paused work thread
  1. Find the blocked attempts:
       bun run --cwd next recovery list
  2. Review the bounded evidence for one of them:
       bun run --cwd next recovery inspect --workspace <team> --attempt <attempt>
  3. Record one decision under a new unique --decision-id:
       bun run --cwd next recovery abandon --workspace <team> --attempt <attempt> \\
         --decision-id <unique-id>
     Choose retry instead only when duplicated external side effects are
     acceptable:
       bun run --cwd next recovery retry --workspace <team> --attempt <attempt> \\
         --decision-id <unique-id> --acknowledge-duplicate-side-effects

Slack shows only the sanitized paused notice and the sanitized outcome; the
work thread resumes on its own once one decision is recorded.
`;

interface CliOptions {
  readonly acknowledgeDuplicateSideEffects: boolean;
  readonly attemptId: string | null;
  readonly command: "abandon" | "health" | "inspect" | "list" | "retry";
  readonly decisionId: string | null;
  readonly root: string;
  readonly workspaceId: string | null;
}

class UsageError extends Error {
  readonly exitCode = EXIT_USAGE;
}

const failUsage = (message: string): never => {
  throw new UsageError(message);
};

const valueAfter = (args: readonly string[], index: number): string => {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    return failUsage(`missing value for ${args[index] ?? "option"}`);
  }
  return value;
};

const parseOptions = (args: readonly string[]): CliOptions => {
  const command = args[0];
  if (
    command !== "list" &&
    command !== "health" &&
    command !== "inspect" &&
    command !== "abandon" &&
    command !== "retry"
  ) {
    return failUsage(
      `expected one command: health, list, inspect, abandon, or retry${
        command === undefined ? "" : ` (received "${command}")`
      }`
    );
  }
  let acknowledgeDuplicateSideEffects = false;
  let attemptId: string | null = null;
  let decisionId: string | null = null;
  let root = process.cwd();
  let workspaceId: string | null = null;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case "--acknowledge-duplicate-side-effects":
        acknowledgeDuplicateSideEffects = true;
        break;
      case "--attempt":
        attemptId = valueAfter(args, index);
        index += 1;
        break;
      case "--decision-id":
        decisionId = valueAfter(args, index);
        index += 1;
        break;
      case "--root":
        root = resolve(valueAfter(args, index));
        index += 1;
        break;
      case "--workspace":
        workspaceId = valueAfter(args, index);
        index += 1;
        break;
      default:
        return failUsage(`unknown option: ${argument ?? ""}`);
    }
  }
  if (
    command !== "list" &&
    command !== "health" &&
    (workspaceId === null || attemptId === null)
  ) {
    return failUsage(
      `${command} needs the exact attempt it resolves: pass --workspace <slack-team-id> and --attempt <attempt-id> (run "recovery list" to find them)`
    );
  }
  if ((command === "abandon" || command === "retry") && decisionId === null) {
    return failUsage(
      `${command} needs --decision-id <id> so the same decision can be replayed idempotently`
    );
  }
  if (command === "retry" && !acknowledgeDuplicateSideEffects) {
    return failUsage(
      "retry may duplicate external side effects, so it requires --acknowledge-duplicate-side-effects spelled in full (abbreviations are not accepted); use abandon instead to continue in a replacement agent session"
    );
  }
  return {
    acknowledgeDuplicateSideEffects,
    attemptId,
    command,
    decisionId,
    root,
    workspaceId,
  };
};

const socketPath = (root: string, workspaceId: string): string =>
  recoverySocketPath(
    resolve(
      root,
      ".laborer-runtime",
      "slack-workspaces",
      encodeURIComponent(workspaceId)
    )
  );

const recoverySocketPath = (workspaceRoot: string): string => {
  const preferred = resolve(workspaceRoot, "recovery.sock");
  if (Buffer.byteLength(preferred, "utf8") <= 96) {
    return preferred;
  }
  const digest = createHash("sha256")
    .update(workspaceRoot, "utf8")
    .digest("hex")
    .slice(0, 32);
  return resolve(tmpdir(), `laborer-recovery-${digest}.sock`);
};

const assertOwnerOnlySocket = async (path: string): Promise<void> => {
  const metadata = await lstat(path);
  const currentUid = process.getuid?.();
  if (
    !metadata.isSocket() ||
    metadata.mode % 64 !== 0 ||
    (currentUid !== undefined && metadata.uid !== currentUid)
  ) {
    throw new Error("recovery socket is not owner-only");
  }
};

const requestSocket = async (
  path: string,
  request: Readonly<Record<string, unknown>>
): Promise<unknown> => {
  await assertOwnerOnlySocket(path);
  return await new Promise((resolveResponse, rejectResponse) => {
    const socket = createConnection(path);
    let source = "";
    socket.setEncoding("utf8");
    socket.once("error", rejectResponse);
    socket.on("data", (chunk: string) => {
      source += chunk;
      if (Buffer.byteLength(source, "utf8") > MAX_RESPONSE_BYTES) {
        socket.destroy();
        rejectResponse(new Error("recovery response exceeded its bound"));
      }
    });
    socket.once("end", () => {
      try {
        resolveResponse(JSON.parse(source.trim()) as unknown);
      } catch (cause) {
        rejectResponse(cause);
      }
    });
    socket.once("connect", () => {
      socket.end(`${JSON.stringify(request)}\n`);
    });
  });
};

const requestFor = (options: CliOptions): Readonly<Record<string, unknown>> => {
  if (options.command === "list" || options.command === "health") {
    return { command: options.command };
  }
  if (options.command === "inspect") {
    return { attemptId: options.attemptId, command: "inspect" };
  }
  if (options.command === "abandon") {
    return {
      attemptId: options.attemptId,
      command: "abandon",
      decisionId: options.decisionId,
    };
  }
  return {
    acknowledgeDuplicateSideEffects: options.acknowledgeDuplicateSideEffects,
    attemptId: options.attemptId,
    command: "retry",
    decisionId: options.decisionId,
  };
};

const offlineHealthResponse = async (
  root: string,
  workspaceId: string
): Promise<unknown> => {
  const paths = await Effect.runPromise(
    prepareSlackRuntimePaths(root, workspaceId)
  );
  const health = await inspectAcpRecoveryHealthOffline({ paths, workspaceId });
  const config = await Effect.runPromise(
    Effect.result(
      loadLaborerConfig({
        defaultRoot: root,
        environment: { ...process.env, LABORER_ROOT: root },
      })
    )
  );
  if (
    config._tag === "Failure" &&
    config.failure._tag === "LaborerConfigError"
  ) {
    return {
      ok: true,
      result: {
        ...health,
        readiness: "config-incompatible",
        reasonCodes: [
          "laborer-config-incompatible",
          ...health.reasonCodes,
        ].slice(0, 16),
      },
    };
  }
  return { ok: true, result: health };
};

const requestAll = async (options: CliOptions): Promise<unknown> => {
  if (options.workspaceId !== null) {
    return await requestSocket(
      socketPath(options.root, options.workspaceId),
      requestFor(options)
    );
  }
  const directory = resolve(
    options.root,
    ".laborer-runtime",
    "slack-workspaces"
  );
  const entries = await readdir(directory, { withFileTypes: true });
  const results: unknown[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    try {
      const response = await requestSocket(
        recoverySocketPath(resolve(directory, entry.name)),
        requestFor(options)
      );
      results.push(response);
    } catch {
      if (options.command === "health") {
        results.push(
          await offlineHealthResponse(
            options.root,
            decodeURIComponent(entry.name)
          )
        );
      } else {
        results.push({
          error: "runtime-unavailable",
          ok: false,
          workspaceDigest: createHash("sha256")
            .update("laborer-recovery-health-cli-v1\0", "utf8")
            .update(entry.name, "utf8")
            .digest("base64url"),
        });
      }
    }
  }
  return { ok: true, result: results };
};

const offlineResponse = async (options: CliOptions): Promise<unknown> => {
  const workspaceId = options.workspaceId;
  const attemptId = options.attemptId;
  if (workspaceId === null) {
    throw new Error("offline recovery requires an exact workspace ID");
  }
  const paths = await Effect.runPromise(
    prepareSlackRuntimePaths(options.root, workspaceId)
  );
  if (options.command === "health") {
    return await offlineHealthResponse(options.root, workspaceId);
  }
  if (attemptId === null) {
    throw new Error("offline recovery requires an exact attempt ID");
  }
  if (options.command === "inspect") {
    return {
      ok: true,
      result: await inspectAcpRecoveryOffline({
        attemptId,
        paths,
        workspaceId,
      }),
    };
  }
  if (options.command !== "abandon" && options.command !== "retry") {
    throw new Error("offline list requires a running recovery daemon");
  }
  const decisionId = options.decisionId;
  if (decisionId === null) {
    throw new Error("offline mutation requires an exact decision ID");
  }
  const result = await Effect.runPromise(
    Effect.scoped(
      acquireRunnerLock(paths.root, paths.lock).pipe(
        Effect.andThen(
          resolveAcpRecoveryOffline({
            acknowledgeDuplicateSideEffects:
              options.acknowledgeDuplicateSideEffects,
            attemptId,
            decisionId,
            kind: options.command,
            paths,
            workspaceId,
          })
        )
      )
    )
  );
  return { ok: true, result };
};

const helpRequested = (args: readonly string[]): boolean =>
  args[0] === "help" ||
  args.some((argument) => argument === "--help" || argument === "-h");

const main = async (): Promise<number> => {
  const args = process.argv.slice(2);
  if (helpRequested(args)) {
    process.stdout.write(USAGE);
    return EXIT_OK;
  }
  const options = parseOptions(args);
  let response: unknown;
  try {
    response =
      options.command === "list" ||
      (options.command === "health" && options.workspaceId === null)
        ? await requestAll(options)
        : await requestSocket(
            socketPath(options.root, options.workspaceId ?? ""),
            requestFor(options)
          );
  } catch {
    response = await offlineResponse(options);
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
  const record =
    typeof response === "object" && response !== null
      ? (response as Record<string, unknown>)
      : {};
  return record.ok === false ? EXIT_REJECTED : EXIT_OK;
};

try {
  process.exitCode = await main();
} catch (cause) {
  const error =
    typeof cause === "object" && cause !== null
      ? (cause as Record<string, unknown>)
      : {};
  const exitCode =
    typeof error.exitCode === "number" ? error.exitCode : EXIT_UNAVAILABLE;
  if (exitCode === EXIT_USAGE) {
    process.stderr.write(
      `${typeof error.message === "string" ? error.message : "invalid recovery request"}\n\n${USAGE}`
    );
  }
  process.stdout.write(
    `${JSON.stringify({
      error:
        typeof error.message === "string"
          ? error.message
          : "recovery runtime unavailable",
      ok: false,
    })}\n`
  );
  process.exitCode = exitCode;
}
