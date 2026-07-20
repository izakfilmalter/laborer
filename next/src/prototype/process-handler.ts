/**
 * THROWAWAY ISSUE #204 PROTOTYPE.
 * Fresh-process, versioned JSON stdin / protocol-only NDJSON stdout adapter.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { Effect, Array as EffectArray, Layer, pipe, Ref, Schema } from "effect";
import {
  type ClaimedTurn,
  HandlerInputEnvelope,
  type HandlerInputEnvelope as HandlerInputEnvelopeType,
  PublicReplyProtocolRecord,
  UnknownProtocolRecord,
} from "./domain.ts";
import { HandlerFailure, StoreError } from "./errors.ts";
import { WorkHandler, type WorkHandlerShape } from "./runtime.ts";

const MAX_PROTOCOL_RECORD_BYTES = 1024 * 1024;
const STDERR_RETAIN_BYTES = 64 * 1024;

export interface ProcessInvocationEvidence {
  readonly attemptNumber: number;
  readonly contextTexts: readonly string[];
  readonly envelope: HandlerInputEnvelopeType;
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
  readonly stateRoot: string;
  readonly timeout?: import("effect").Duration.Input;
}

interface MutableEvidence extends ProcessHandlerEvidence {
  readonly activeGlobal: number;
  readonly activeThreads: Readonly<Record<string, number>>;
}

const spawnFailure = (): HandlerFailure =>
  HandlerFailure.make({ category: "spawn", safeDetail: null });

const terminateProcess = (
  child: ChildProcessWithoutNullStreams
): Effect.Effect<void> =>
  Effect.promise(async () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    const pid = child.pid;
    if (pid === undefined) {
      child.kill("SIGTERM");
      return;
    }
    const exited = new Promise<void>((resolveExit) => {
      const onExit = () => resolveExit();
      child.once("exit", onExit);
      child.once("error", onExit);
      if (child.exitCode !== null || child.signalCode !== null) {
        child.off("exit", onExit);
        child.off("error", onExit);
        resolveExit();
      }
    });
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    let killTimer: NodeJS.Timeout | undefined;
    const exitedAfterTerm = await Promise.race([
      exited.then(() => true),
      new Promise<false>((resolveDelay) => {
        killTimer = setTimeout(() => resolveDelay(false), 10_000);
      }),
    ]);
    if (killTimer !== undefined) {
      clearTimeout(killTimer);
    }
    if (exitedAfterTerm) {
      return;
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
    await exited;
  });

const stateDirectoryFor = (stateRoot: string, threadId: string): string =>
  resolve(stateRoot, encodeURIComponent(threadId));

const parseProtocolLine = async (
  lineBuffer: Buffer,
  lineNumber: number,
  acceptReply: (
    record: PublicReplyProtocolRecord
  ) => Effect.Effect<void, HandlerFailure | StoreError>,
  runPromise: (
    effect: Effect.Effect<void, HandlerFailure | StoreError>
  ) => Promise<void>
): Promise<void> => {
  if (lineBuffer.length > MAX_PROTOCOL_RECORD_BYTES) {
    throw HandlerFailure.make({
      category: "protocol",
      safeDetail: `record line ${lineNumber} exceeds 1 MiB`,
    });
  }
  const decodedLine = lineBuffer.toString("utf8");
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
    reply = await Schema.decodeUnknownPromise(PublicReplyProtocolRecord)(value);
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
  for await (const chunk of child.stdout) {
    pending = Buffer.concat([
      pending,
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
    ]);
    let newlineIndex = pending.indexOf(0x0a);
    while (newlineIndex >= 0) {
      lineNumber += 1;
      await parseProtocolLine(
        pending.subarray(0, newlineIndex),
        lineNumber,
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
    await parseProtocolLine(pending, lineNumber + 1, acceptReply, runPromise);
  }
};

const drainStderr = async (
  child: ChildProcessWithoutNullStreams,
  runPromise: (effect: Effect.Effect<void>) => Promise<void>
): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of child.stderr) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(buffer);
    await runPromise(Effect.logDebug(buffer.toString("utf8")));
  }
  return Buffer.concat(chunks).subarray(-STDERR_RETAIN_BYTES).toString("utf8");
};

const awaitExit = (
  child: ChildProcessWithoutNullStreams
): Promise<readonly [number | null, NodeJS.Signals | null]> =>
  new Promise((resolveExit, rejectExit) => {
    const onError = (error: Error) => rejectExit(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      resolveExit([code, signal]);
    child.once("error", onError);
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) {
      child.off("error", onError);
      child.off("exit", onExit);
      resolveExit([child.exitCode, child.signalCode]);
    }
  });

const invokeProcess = Effect.fnUntraced(function* (
  options: ProcessHandlerOptions,
  evidence: Ref.Ref<MutableEvidence>,
  turn: ClaimedTurn,
  acceptReply: (
    record: PublicReplyProtocolRecord
  ) => Effect.Effect<void, HandlerFailure | StoreError>
) {
  const invocationId = `${turn.id}:attempt:${turn.attemptNumber}`;
  const stateDirectory = stateDirectoryFor(options.stateRoot, turn.threadId);
  const envelope = HandlerInputEnvelope.make({
    messages: EffectArray.appendAll(turn.context, turn.messages),
    protocolVersion: 1,
    stateDirectory,
    turnId: turn.id,
    workThreadId: turn.threadId,
  });
  yield* Effect.acquireRelease(
    Ref.update(evidence, (current) => {
      const threadActive = (current.activeThreads[turn.threadId] ?? 0) + 1;
      const activeGlobal = current.activeGlobal + 1;
      return {
        ...current,
        activeGlobal,
        activeThreads: {
          ...current.activeThreads,
          [turn.threadId]: threadActive,
        },
        invocations: EffectArray.append(current.invocations, {
          attemptNumber: turn.attemptNumber,
          contextTexts: pipe(
            turn.context,
            EffectArray.map((message) => message.text)
          ),
          inputTexts: pipe(
            turn.messages,
            EffectArray.map((message) => message.text)
          ),
          envelope,
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
      };
    }).pipe(Effect.as("acquired" as const)),
    () =>
      Ref.update(evidence, (current) => ({
        ...current,
        activeGlobal: current.activeGlobal - 1,
        activeThreads: {
          ...current.activeThreads,
          [turn.threadId]: (current.activeThreads[turn.threadId] ?? 1) - 1,
        },
        invocations: pipe(
          current.invocations,
          EffectArray.map((invocation) =>
            invocation.invocationId === invocationId &&
            invocation.status === "running"
              ? { ...invocation, status: "interrupted" as const }
              : invocation
          )
        ),
      }))
  );
  yield* Effect.tryPromise({
    try: async () => {
      await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
      await chmod(stateDirectory, 0o700);
    },
    catch: spawnFailure,
  });
  if (!isAbsolute(envelope.stateDirectory)) {
    return yield* spawnFailure();
  }

  const child = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        spawn(options.command, options.args, {
          cwd: options.cwd,
          detached: true,
          env: process.env,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        }),
      catch: spawnFailure,
    }),
    terminateProcess
  );
  yield* Ref.update(evidence, (current) => ({
    ...current,
    invocations: pipe(
      current.invocations,
      EffectArray.map((invocation) =>
        invocation.invocationId === invocationId
          ? { ...invocation, pid: child.pid ?? null }
          : invocation
      )
    ),
  }));
  const context = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(context);
  const markInvocationExited = Ref.update(evidence, (current) => ({
    ...current,
    invocations: pipe(
      current.invocations,
      EffectArray.map((invocation) =>
        invocation.invocationId === invocationId
          ? { ...invocation, status: "exited" as const }
          : invocation
      )
    ),
  }));
  const execute = Effect.tryPromise({
    try: async () => {
      const exit = awaitExit(child);
      const stderr = drainStderr(child, runPromise);
      const stdout = parseStdout(child, acceptReply, runPromise);
      child.stdin.end(`${JSON.stringify(envelope)}\n`, "utf8");
      const protocolFailure = stdout.then(
        () => new Promise<never>(() => undefined),
        (error: unknown) => Promise.reject(error)
      );
      const [code, signal] = await Promise.race([exit, protocolFailure]);
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
        Ref.update(evidence, (current) => ({
          ...current,
          internalStderr:
            internalStderr.length === 0
              ? current.internalStderr
              : EffectArray.append(current.internalStderr, internalStderr),
        }))
      );
      if (signal !== null) {
        throw HandlerFailure.make({
          category: "signal",
          safeDetail: `signal ${signal}`,
        });
      }
      if (code !== 0) {
        throw HandlerFailure.make({
          category: "exit",
          safeDetail: `exit code ${code ?? "unknown"}`,
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
  stateRoot: resolve("/tmp", "laborer-issue-204-prototype-state", randomUUID()),
});
