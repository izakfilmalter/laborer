/**
 * THROWAWAY ISSUE #204 PROTOTYPE.
 * Fresh-process, versioned JSON stdin / protocol-only NDJSON stdout adapter.
 */
import {
  type ChildProcessWithoutNullStreams,
  execFile,
  spawn,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  Effect,
  Array as EffectArray,
  Layer,
  pipe,
  Record,
  Ref,
  Schema,
} from "effect";
import {
  type ClaimedTurn,
  HandlerInputEnvelope,
  type HandlerInputEnvelope as HandlerInputEnvelopeType,
  PublicReplyProtocolRecord,
  UnknownProtocolRecord,
} from "./domain.ts";
import { HandlerFailure, StoreError } from "./errors.ts";
import {
  ensureOwnerOnlyDirectoryTree,
  openRegularFileNoFollow,
  retainTrustedDirectory,
  verifyRetainedDirectory,
} from "./path-safety.ts";
import { WorkHandler, type WorkHandlerShape } from "./runtime.ts";

const MAX_PROTOCOL_RECORD_BYTES = 1024 * 1024;
export const MAX_HANDLER_INPUT_BYTES = 4 * 1024 * 1024;
export const MAX_HANDLER_STDOUT_BYTES = 8 * 1024 * 1024;
export const MAX_HANDLER_STDOUT_RECORDS = 4096;
export const MAX_HANDLER_STDERR_BYTES = 8 * 1024 * 1024;
const STDERR_RETAIN_BYTES = 64 * 1024;
const PROCESS_GROUP_GRACE_MILLIS = 10_000;
const PROCESS_GROUP_POLL_MILLIS = 25;
const SUPERVISOR_RESULT_MAX_BYTES = 4096;
const supervisorProxyPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "process-supervisor-proxy.ts"
);
const execFilePromise = promisify(execFile);
const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });
const PROCESS_COLUMNS_SEPARATOR = /\s+/;

export interface ProcessInvocationEvidence {
  readonly attemptNumber: number;
  readonly contextTexts: readonly string[];
  readonly envelope: HandlerInputEnvelopeType | null;
  readonly inputTexts: readonly string[];
  readonly invocationId: string;
  readonly pid: number | null;
  readonly status: "running" | "exited" | "interrupted";
  readonly threadId: string;
  readonly turnId: string;
}

export interface ProcessHandlerEvidence {
  readonly internalStderr: readonly string[];
  readonly invocations: readonly ProcessInvocationEvidence[];
  readonly maximumGlobalConcurrency: number;
  readonly maximumThreadConcurrency: Readonly<Record<string, number>>;
}

export interface ProcessHandlerFixture {
  readonly handler: WorkHandlerShape;
  readonly snapshot: Effect.Effect<ProcessHandlerEvidence>;
}

export interface ProcessHandlerOptions {
  readonly args: readonly string[];
  readonly command: string;
  readonly cwd: string;
  /** Internal adapter wiring only. Exact child environment after secret filtering. */
  readonly environment: NodeJS.ProcessEnv;
  readonly evidence:
    | { readonly mode: "production"; readonly maxInvocations?: number }
    | {
        readonly mode: "fixture";
        readonly maxAggregateBytes?: number;
        readonly maxInvocations?: number;
        readonly maxStderrBytes?: number;
      };
  readonly stateRoot: string;
  readonly stateRootAnchor?: string;
  readonly timeout?: import("effect").Duration.Input;
}

interface MutableEvidence extends ProcessHandlerEvidence {
  readonly activeGlobal: number;
  readonly activeThreads: Readonly<Record<string, number>>;
}

interface EvidenceLimits {
  readonly includePayload: boolean;
  readonly maxAggregateBytes: number;
  readonly maxInvocations: number;
  readonly maxStderrBytes: number;
}

const evidenceLimits = (options: ProcessHandlerOptions): EvidenceLimits =>
  options.evidence.mode === "production"
    ? {
        includePayload: false,
        maxAggregateBytes: 256 * 1024,
        maxInvocations: options.evidence.maxInvocations ?? 128,
        maxStderrBytes: 0,
      }
    : {
        includePayload: true,
        maxAggregateBytes:
          options.evidence.maxAggregateBytes ?? 8 * 1024 * 1024,
        maxInvocations: options.evidence.maxInvocations ?? 32,
        maxStderrBytes: options.evidence.maxStderrBytes ?? 256 * 1024,
      };

const evidenceByteLength = (evidence: MutableEvidence): number =>
  Buffer.byteLength(
    JSON.stringify({
      internalStderr: evidence.internalStderr,
      invocations: evidence.invocations,
      maximumGlobalConcurrency: evidence.maximumGlobalConcurrency,
      maximumThreadConcurrency: evidence.maximumThreadConcurrency,
    }),
    "utf8"
  );

export const boundEvidence = (
  evidence: MutableEvidence,
  limits: EvidenceLimits
): MutableEvidence => {
  let internalStderr = evidence.internalStderr;
  let invocations = evidence.invocations.slice(-limits.maxInvocations);
  const retainedMaximumThreadConcurrency = () => {
    const retainedThreadIds = new Set(
      EffectArray.appendAll(
        pipe(
          invocations,
          EffectArray.map((invocation) => invocation.threadId)
        ),
        Record.keys(evidence.activeThreads)
      )
    );
    return Record.filter(
      evidence.maximumThreadConcurrency,
      (_maximum, threadId) => retainedThreadIds.has(threadId)
    );
  };
  let bounded = {
    ...evidence,
    internalStderr,
    invocations,
    maximumThreadConcurrency: retainedMaximumThreadConcurrency(),
  };
  while (
    invocations.length > 0 &&
    evidenceByteLength(bounded) > limits.maxAggregateBytes
  ) {
    invocations = invocations.slice(1);
    bounded = {
      ...bounded,
      invocations,
      maximumThreadConcurrency: retainedMaximumThreadConcurrency(),
    };
  }
  while (
    internalStderr.length > 0 &&
    evidenceByteLength(bounded) > limits.maxAggregateBytes
  ) {
    internalStderr = internalStderr.slice(1);
    bounded = { ...bounded, internalStderr };
  }
  for (const threadId of Record.keys(bounded.maximumThreadConcurrency)) {
    if (evidenceByteLength(bounded) <= limits.maxAggregateBytes) {
      break;
    }
    bounded = {
      ...bounded,
      maximumThreadConcurrency: Record.remove(
        bounded.maximumThreadConcurrency,
        threadId
      ),
    };
  }
  return bounded;
};

const appendBoundedStderr = (
  values: readonly string[],
  value: string,
  maximumBytes: number
): readonly string[] => {
  if (maximumBytes === 0 || value.length === 0) {
    return values;
  }
  let next: readonly string[] = EffectArray.append(values, value);
  while (
    next.length > 0 &&
    Buffer.byteLength(next.join(""), "utf8") > maximumBytes
  ) {
    next = next.slice(1);
  }
  return next;
};

const spawnFailure = (): HandlerFailure =>
  HandlerFailure.make({ category: "spawn", safeDetail: null });

const signalProcessGroup = (
  processGroupId: number,
  signal: NodeJS.Signals
): boolean => {
  try {
    process.kill(-processGroupId, signal);
    return true;
  } catch {
    return false;
  }
};

const leaderIsAlive = (child: ChildProcessWithoutNullStreams): boolean =>
  child.exitCode === null && child.signalCode === null;

const processGroupMembers = async (
  processGroupId: number
): Promise<readonly number[]> => {
  const { stdout } = await execFilePromise("/bin/ps", ["-axo", "pid=,pgid="], {
    maxBuffer: 1024 * 1024,
  });
  return stdout
    .trim()
    .split("\n")
    .flatMap((line) => {
      const [pidSource, groupSource] = line
        .trim()
        .split(PROCESS_COLUMNS_SEPARATOR, 2);
      const pid = Number(pidSource);
      const group = Number(groupSource);
      return group === processGroupId && Number.isSafeInteger(pid) ? [pid] : [];
    });
};

const waitForLeaderExit = async (
  child: ChildProcessWithoutNullStreams
): Promise<void> => {
  if (!leaderIsAlive(child)) {
    return;
  }
  await new Promise<void>((resolveExit) => {
    const onExit = () => resolveExit();
    child.once("exit", onExit);
    if (!leaderIsAlive(child)) {
      child.off("exit", onExit);
      resolveExit();
    }
  });
};

const terminateProcess = (
  child: ChildProcessWithoutNullStreams
): Effect.Effect<void> =>
  Effect.promise(async () => {
    const processGroupId = child.pid;
    if (processGroupId === undefined) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
      return;
    }

    // The proxy is a stable leader/sentinel. Every group-directed signal occurs
    // only while that owned leader is alive, so a reused numeric PGID can never
    // be targeted after the handler and its descendants have exited.
    if (!leaderIsAlive(child)) {
      return;
    }
    signalProcessGroup(processGroupId, "SIGTERM");
    const deadline = Date.now() + PROCESS_GROUP_GRACE_MILLIS;
    while (leaderIsAlive(child) && Date.now() < deadline) {
      try {
        const members = await processGroupMembers(processGroupId);
        if (members.every((pid) => pid === processGroupId)) {
          child.kill("SIGKILL");
          await waitForLeaderExit(child);
          return;
        }
      } catch {
        // Keep the sentinel alive and fail over to a bounded group KILL below.
      }
      await new Promise<void>((resolveDelay) => {
        setTimeout(resolveDelay, PROCESS_GROUP_POLL_MILLIS);
      });
    }
    if (leaderIsAlive(child)) {
      signalProcessGroup(processGroupId, "SIGKILL");
      await waitForLeaderExit(child);
    }
  });

const stateDirectoryFor = (stateRoot: string, threadId: string): string =>
  resolve(stateRoot, encodeURIComponent(threadId));

const parseProtocolLine = async (
  lineBuffer: Buffer,
  lineNumber: number,
  terminatorBytes: number,
  acceptReply: (
    record: PublicReplyProtocolRecord
  ) => Effect.Effect<void, HandlerFailure | StoreError>,
  runPromise: (
    effect: Effect.Effect<void, HandlerFailure | StoreError>
  ) => Promise<void>
): Promise<void> => {
  // Protocol v1 limits the exact NDJSON record, including its trailing LF.
  if (lineBuffer.length + terminatorBytes > MAX_PROTOCOL_RECORD_BYTES) {
    throw HandlerFailure.make({
      category: "protocol",
      safeDetail: `record line ${lineNumber} exceeds 1 MiB`,
    });
  }
  let decodedLine: string;
  try {
    decodedLine = fatalUtf8Decoder.decode(lineBuffer);
  } catch {
    throw HandlerFailure.make({
      category: "protocol",
      safeDetail: `invalid UTF-8 at line ${lineNumber}`,
    });
  }
  const line = decodedLine.endsWith("\r")
    ? decodedLine.slice(0, -1)
    : decodedLine;
  if (line.trim().length === 0) {
    return;
  }
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    throw HandlerFailure.make({
      category: "protocol",
      safeDetail: `malformed record at line ${lineNumber}`,
    });
  }
  let base: typeof UnknownProtocolRecord.Type;
  try {
    base = await Schema.decodeUnknownPromise(UnknownProtocolRecord)(value);
  } catch {
    throw HandlerFailure.make({
      category: "protocol",
      safeDetail: `invalid record at line ${lineNumber}`,
    });
  }
  if (base.type !== "public_reply") {
    await runPromise(
      Effect.logDebug(`Ignored handler protocol record type: ${base.type}`)
    );
    return;
  }
  let reply: PublicReplyProtocolRecord;
  try {
    reply = await Schema.decodeUnknownPromise(PublicReplyProtocolRecord, {
      onExcessProperty: "error",
    })(value);
  } catch {
    throw HandlerFailure.make({
      category: "protocol",
      safeDetail: `invalid public reply at line ${lineNumber}`,
    });
  }
  await runPromise(acceptReply(reply));
};

const parseStdout = async (
  child: ChildProcessWithoutNullStreams,
  acceptReply: (
    record: PublicReplyProtocolRecord
  ) => Effect.Effect<void, HandlerFailure | StoreError>,
  runPromise: (
    effect: Effect.Effect<void, HandlerFailure | StoreError>
  ) => Promise<void>
): Promise<void> => {
  let pending = Buffer.alloc(0);
  let lineNumber = 0;
  let totalBytes = 0;
  for await (const chunk of child.stdout) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_HANDLER_STDOUT_BYTES) {
      throw HandlerFailure.make({
        category: "protocol",
        safeDetail: "handler stdout exceeds 8 MiB",
      });
    }
    pending = Buffer.concat([pending, buffer]);
    let newlineIndex = pending.indexOf(0x0a);
    while (newlineIndex >= 0) {
      lineNumber += 1;
      if (lineNumber > MAX_HANDLER_STDOUT_RECORDS) {
        throw HandlerFailure.make({
          category: "protocol",
          safeDetail: "handler stdout exceeds 4096 records",
        });
      }
      await parseProtocolLine(
        pending.subarray(0, newlineIndex),
        lineNumber,
        1,
        acceptReply,
        runPromise
      );
      pending = pending.subarray(newlineIndex + 1);
      newlineIndex = pending.indexOf(0x0a);
    }
    if (pending.length > MAX_PROTOCOL_RECORD_BYTES) {
      throw HandlerFailure.make({
        category: "protocol",
        safeDetail: `record line ${lineNumber + 1} exceeds 1 MiB`,
      });
    }
  }
  if (pending.length > 0) {
    if (lineNumber + 1 > MAX_HANDLER_STDOUT_RECORDS) {
      throw HandlerFailure.make({
        category: "protocol",
        safeDetail: "handler stdout exceeds 4096 records",
      });
    }
    await parseProtocolLine(
      pending,
      lineNumber + 1,
      0,
      acceptReply,
      runPromise
    );
  }
};

const drainStderr = async (
  child: ChildProcessWithoutNullStreams,
  runPromise: (effect: Effect.Effect<void>) => Promise<void>,
  logChunks: boolean
): Promise<string> => {
  let retainedTail = Buffer.alloc(0);
  let totalBytes = 0;
  for await (const chunk of child.stderr) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_HANDLER_STDERR_BYTES) {
      throw HandlerFailure.make({
        category: "protocol",
        safeDetail: "handler stderr exceeds 8 MiB",
      });
    }
    if (buffer.length >= STDERR_RETAIN_BYTES) {
      retainedTail = buffer.subarray(-STDERR_RETAIN_BYTES);
    } else if (retainedTail.length + buffer.length > STDERR_RETAIN_BYTES) {
      const retainedOffset =
        retainedTail.length + buffer.length - STDERR_RETAIN_BYTES;
      retainedTail = Buffer.concat(
        [retainedTail.subarray(retainedOffset), buffer],
        STDERR_RETAIN_BYTES
      );
    } else {
      retainedTail = Buffer.concat([retainedTail, buffer]);
    }
    if (logChunks) {
      await runPromise(Effect.logDebug(buffer.toString("utf8")));
    }
  }
  return retainedTail.toString("utf8");
};

interface SupervisorResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly spawnFailed: boolean;
}

const readSupervisorResult = async (
  child: ChildProcessWithoutNullStreams
): Promise<SupervisorResult> => {
  const control = child.stdio[3];
  if (control === undefined || control === null || !("readable" in control)) {
    throw new Error("supervisor control pipe unavailable");
  }
  let pending = Buffer.alloc(0);
  for await (const chunk of control) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    pending = Buffer.concat([pending, buffer]);
    if (pending.length > SUPERVISOR_RESULT_MAX_BYTES) {
      throw new Error("supervisor result exceeded limit");
    }
    const newlineIndex = pending.indexOf(0x0a);
    if (newlineIndex >= 0) {
      const source = fatalUtf8Decoder.decode(pending.subarray(0, newlineIndex));
      const value = JSON.parse(source) as Partial<SupervisorResult>;
      if (
        typeof value.spawnFailed !== "boolean" ||
        !(value.code === null || Number.isInteger(value.code)) ||
        !(value.signal === null || typeof value.signal === "string")
      ) {
        throw new Error("invalid supervisor result");
      }
      return value as SupervisorResult;
    }
  }
  throw new Error("supervisor exited without a result");
};

const writeHandlerInput = (
  child: ChildProcessWithoutNullStreams,
  input: Buffer
): Promise<void> => {
  const completion = finished(child.stdin, { cleanup: true });
  child.stdin.end(input);
  return completion;
};

const validateCommandBeforeSpawn = async (command: string): Promise<void> => {
  if (!command.includes("/")) {
    return;
  }
  const directory = await retainTrustedDirectory(
    dirname(command),
    "spawn-work-handler"
  );
  try {
    const file = await openRegularFileNoFollow(command, "spawn-work-handler");
    try {
      await access(command, constants.X_OK);
      await verifyRetainedDirectory(directory, "spawn-work-handler");
    } finally {
      await file.close();
    }
  } finally {
    await directory.handle.close();
  }
};

const invokeProcess = Effect.fnUntraced(function* (
  options: ProcessHandlerOptions,
  evidence: Ref.Ref<MutableEvidence>,
  turn: ClaimedTurn,
  acceptReply: (
    record: PublicReplyProtocolRecord
  ) => Effect.Effect<void, HandlerFailure | StoreError>
) {
  const limits = evidenceLimits(options);
  const invocationId = `${turn.id}:attempt:${turn.attemptNumber}`;
  const stateDirectory = stateDirectoryFor(options.stateRoot, turn.threadId);
  const envelope = HandlerInputEnvelope.make({
    messages: EffectArray.appendAll(turn.context, turn.messages),
    protocolVersion: 1,
    stateDirectory,
    turnId: turn.id,
    workThreadId: turn.threadId,
  });
  const serializedEnvelope = Buffer.from(
    `${JSON.stringify(envelope)}\n`,
    "utf8"
  );
  if (serializedEnvelope.length > MAX_HANDLER_INPUT_BYTES) {
    return yield* HandlerFailure.make({
      category: "protocol",
      safeDetail: "handler input envelope exceeds 4 MiB",
    });
  }
  yield* Effect.acquireRelease(
    Ref.update(evidence, (current) => {
      const threadActive = (current.activeThreads[turn.threadId] ?? 0) + 1;
      const activeGlobal = current.activeGlobal + 1;
      return boundEvidence(
        {
          ...current,
          activeGlobal,
          activeThreads: {
            ...current.activeThreads,
            [turn.threadId]: threadActive,
          },
          invocations: EffectArray.append(current.invocations, {
            attemptNumber: turn.attemptNumber,
            contextTexts: limits.includePayload
              ? pipe(
                  turn.context,
                  EffectArray.map((message) => message.text)
                )
              : [],
            inputTexts: limits.includePayload
              ? pipe(
                  turn.messages,
                  EffectArray.map((message) => message.text)
                )
              : [],
            envelope: limits.includePayload ? envelope : null,
            invocationId,
            pid: null,
            status: "running" as const,
            threadId: turn.threadId,
            turnId: turn.id,
          }),
          maximumGlobalConcurrency: Math.max(
            current.maximumGlobalConcurrency,
            activeGlobal
          ),
          maximumThreadConcurrency: {
            ...current.maximumThreadConcurrency,
            [turn.threadId]: Math.max(
              current.maximumThreadConcurrency[turn.threadId] ?? 0,
              threadActive
            ),
          },
        },
        limits
      );
    }).pipe(Effect.as("acquired" as const)),
    () =>
      Ref.update(evidence, (current) => {
        const currentThreadActive = current.activeThreads[turn.threadId] ?? 1;
        const activeThreads =
          currentThreadActive <= 1
            ? Record.remove(current.activeThreads, turn.threadId)
            : Record.set(
                current.activeThreads,
                turn.threadId,
                currentThreadActive - 1
              );
        return boundEvidence(
          {
            ...current,
            activeGlobal: current.activeGlobal - 1,
            activeThreads,
            invocations: pipe(
              current.invocations,
              EffectArray.map((invocation) =>
                invocation.invocationId === invocationId &&
                invocation.status === "running"
                  ? { ...invocation, status: "interrupted" as const }
                  : invocation
              )
            ),
          },
          limits
        );
      })
  );
  yield* Effect.tryPromise({
    try: async () => {
      const anchor = options.stateRootAnchor ?? dirname(options.stateRoot);
      await ensureOwnerOnlyDirectoryTree({
        anchor,
        operation: "prepare-handler-state-root",
        target: options.stateRoot,
      });
      await ensureOwnerOnlyDirectoryTree({
        anchor: options.stateRoot,
        operation: "prepare-handler-state-directory",
        target: stateDirectory,
      });
    },
    catch: spawnFailure,
  });
  if (!isAbsolute(envelope.stateDirectory)) {
    return yield* spawnFailure();
  }
  const command = options.command.includes("/")
    ? resolve(options.cwd, options.command)
    : options.command;
  yield* Effect.tryPromise({
    try: () => validateCommandBeforeSpawn(command),
    catch: spawnFailure,
  });

  const child = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        spawn(
          process.execPath,
          [supervisorProxyPath, command, ...options.args],
          {
            cwd: options.cwd,
            detached: true,
            env: options.environment,
            shell: false,
            stdio: ["pipe", "pipe", "pipe", "pipe"],
          }
        ) as ChildProcessWithoutNullStreams,
      catch: spawnFailure,
    }),
    terminateProcess
  );
  yield* Ref.update(evidence, (current) =>
    boundEvidence(
      {
        ...current,
        invocations: pipe(
          current.invocations,
          EffectArray.map((invocation) =>
            invocation.invocationId === invocationId
              ? { ...invocation, pid: child.pid ?? null }
              : invocation
          )
        ),
      },
      limits
    )
  );
  const context = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(context);
  const markInvocationExited = Ref.update(evidence, (current) =>
    boundEvidence(
      {
        ...current,
        invocations: pipe(
          current.invocations,
          EffectArray.map((invocation) =>
            invocation.invocationId === invocationId
              ? { ...invocation, status: "exited" as const }
              : invocation
          )
        ),
      },
      limits
    )
  );
  const execute = Effect.tryPromise({
    try: async () => {
      const handlerResult = readSupervisorResult(child);
      const stderr = drainStderr(child, runPromise, limits.includePayload);
      const stdout = parseStdout(child, acceptReply, runPromise);
      const failureOnly = <A>(promise: Promise<A>): Promise<never> =>
        promise.then(
          () => new Promise<never>(() => undefined),
          (error: unknown) => Promise.reject(error)
        );
      const streamFailure = Promise.race([
        failureOnly(stdout),
        failureOnly(stderr),
      ]);
      try {
        await Promise.race([
          writeHandlerInput(child, serializedEnvelope),
          streamFailure,
        ]);
      } catch (error) {
        if (error instanceof HandlerFailure || error instanceof StoreError) {
          throw error;
        }
        throw HandlerFailure.make({
          category: "protocol",
          safeDetail: "handler closed input before envelope completed",
        });
      }
      const result = await Promise.race([handlerResult, streamFailure]);
      let drainTimer: NodeJS.Timeout | undefined;
      const drainResult = await Promise.race([
        Promise.all([stdout, stderr]).then(([, internalStderr]) => ({
          _tag: "Drained" as const,
          internalStderr,
        })),
        new Promise<{ readonly _tag: "TimedOut" }>((resolveDelay) => {
          drainTimer = setTimeout(
            () => resolveDelay({ _tag: "TimedOut" }),
            1000
          );
        }),
      ]);
      if (drainTimer !== undefined) {
        clearTimeout(drainTimer);
      }
      if (drainResult._tag === "TimedOut") {
        child.stdout.destroy();
        child.stderr.destroy();
      }
      const internalStderr =
        drainResult._tag === "Drained" ? drainResult.internalStderr : "";
      await runPromise(
        Ref.update(evidence, (current) =>
          boundEvidence(
            {
              ...current,
              internalStderr: appendBoundedStderr(
                current.internalStderr,
                internalStderr,
                limits.maxStderrBytes
              ),
            },
            limits
          )
        )
      );
      if (result.spawnFailed) {
        throw spawnFailure();
      }
      if (result.signal !== null) {
        throw HandlerFailure.make({
          category: "signal",
          safeDetail: `signal ${result.signal}`,
        });
      }
      if (result.code !== 0) {
        throw HandlerFailure.make({
          category: "exit",
          safeDetail: `exit code ${result.code ?? "unknown"}`,
        });
      }
    },
    catch: (cause) => {
      if (cause instanceof HandlerFailure || cause instanceof StoreError) {
        return cause;
      }
      return spawnFailure();
    },
  }).pipe(
    Effect.timeout(options.timeout ?? "2 hours"),
    Effect.mapError((error) =>
      error._tag === "TimeoutError"
        ? HandlerFailure.make({ category: "timeout", safeDetail: null })
        : error
    )
  );
  yield* execute.pipe(Effect.tapError(() => markInvocationExited));
  yield* markInvocationExited;
});

export const makeProcessHandler = (
  options: ProcessHandlerOptions
): Effect.Effect<ProcessHandlerFixture> =>
  Effect.gen(function* () {
    const limits = evidenceLimits(options);
    const evidence = yield* Ref.make<MutableEvidence>({
      activeGlobal: 0,
      activeThreads: {},
      internalStderr: [],
      invocations: [],
      maximumGlobalConcurrency: 0,
      maximumThreadConcurrency: {},
    });
    return {
      handler: WorkHandler.of({
        invoke: (turn, acceptReply) =>
          invokeProcess(options, evidence, turn, acceptReply).pipe(
            Effect.scoped
          ),
      }),
      snapshot: Ref.get(evidence).pipe(
        Effect.map((current) => boundEvidence(current, limits)),
        Effect.map(
          ({
            activeGlobal: _activeGlobal,
            activeThreads: _activeThreads,
            ...state
          }) => state
        )
      ),
    };
  });

export const makeProcessHandlerLayer = (
  options: ProcessHandlerOptions
): Layer.Layer<WorkHandler> =>
  Layer.effect(
    WorkHandler,
    makeProcessHandler(options).pipe(Effect.map(({ handler }) => handler))
  );

export const fixtureHandlerOptions = (cwd: string): ProcessHandlerOptions => ({
  command: process.execPath,
  args: [resolve(cwd, "src/prototype/fixture-handler.ts")],
  cwd,
  environment: { PATH: process.env.PATH },
  evidence: { mode: "fixture" },
  stateRoot: resolve(
    realpathSync(tmpdir()),
    "laborer-issue-204-prototype-state",
    randomUUID()
  ),
  stateRootAnchor: realpathSync(tmpdir()),
});
