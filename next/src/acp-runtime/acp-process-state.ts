import { randomUUID } from "node:crypto";
import { chmod, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Clock, Effect, Schema, Semaphore } from "effect";
import { withApplicationFileLock } from "../core/application-file-lock.ts";
import { HandlerFailure } from "../core/errors.ts";
import {
  assertSafeFilePath,
  openRegularFileNoFollow,
  retainTrustedDirectory,
  verifyRetainedDirectory,
} from "../core/path-safety.ts";

const PROCESS_STATE_SCHEMA_VERSION = 1;
const MAX_PROCESS_STATE_BYTES = 256 * 1024;
const MAX_TRANSITIONS = 64;
const MAX_FAILURES = 32;

export const AcpWorkspaceProcessHealth = Schema.Literals([
  "stopped",
  "starting",
  "ready",
  "restarting",
  "draining",
  "circuit_open",
  "quarantined",
]);
export type AcpWorkspaceProcessHealth = typeof AcpWorkspaceProcessHealth.Type;

export const AcpProcessStopPhase = Schema.Literals([
  "startup",
  "idle",
  "prompt",
  "drain",
]);
export type AcpProcessStopPhase = typeof AcpProcessStopPhase.Type;

export const AcpProcessStopCause = Schema.Literals([
  "deadline",
  "expected_shutdown",
  "initialization_failed",
  "process_exit",
  "protocol_incompatible",
  "readiness_failed",
  "spawn_failed",
  "state_unavailable",
  "transport_lost",
  "unknown",
]);
export type AcpProcessStopCause = typeof AcpProcessStopCause.Type;

export const AcpProcessCleanupOutcome = Schema.Literals([
  "already_exited",
  "completed",
  "failed",
  "kill",
  "not_attempted",
  "term",
]);
export type AcpProcessCleanupOutcome = typeof AcpProcessCleanupOutcome.Type;

export class AcpProcessStopRecord extends Schema.Class<AcpProcessStopRecord>(
  "AcpProcessStopRecord"
)({
  cause: AcpProcessStopCause,
  cleanupOutcome: AcpProcessCleanupOutcome,
  code: Schema.NullOr(Schema.Int),
  expected: Schema.Boolean,
  generation: Schema.Int.check(Schema.isGreaterThan(0)),
  phase: AcpProcessStopPhase,
  signal: Schema.NullOr(
    Schema.Literals([
      "SIGABRT",
      "SIGALRM",
      "SIGBUS",
      "SIGBREAK",
      "SIGCHLD",
      "SIGCONT",
      "SIGFPE",
      "SIGHUP",
      "SIGILL",
      "SIGINFO",
      "SIGINT",
      "SIGIO",
      "SIGIOT",
      "SIGKILL",
      "SIGLOST",
      "SIGPIPE",
      "SIGPOLL",
      "SIGPROF",
      "SIGPWR",
      "SIGQUIT",
      "SIGSEGV",
      "SIGSTKFLT",
      "SIGSTOP",
      "SIGSYS",
      "SIGTERM",
      "SIGTRAP",
      "SIGTSTP",
      "SIGTTIN",
      "SIGTTOU",
      "SIGURG",
      "SIGUNUSED",
      "SIGUSR1",
      "SIGUSR2",
      "SIGVTALRM",
      "SIGWINCH",
      "SIGXCPU",
      "SIGXFSZ",
    ])
  ),
  timestamp: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}) {}

export class AcpProcessTransition extends Schema.Class<AcpProcessTransition>(
  "AcpProcessTransition"
)({
  generation: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  health: AcpWorkspaceProcessHealth,
  timestamp: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}) {}

export class AcpProcessFailureRecord extends Schema.Class<AcpProcessFailureRecord>(
  "AcpProcessFailureRecord"
)({
  cause: AcpProcessStopCause,
  classification: Schema.Literals(["deterministic", "transient"]),
  generation: Schema.Int.check(Schema.isGreaterThan(0)),
  timestamp: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}) {}

export class AcpProcessState extends Schema.Class<AcpProcessState>(
  "AcpProcessState"
)({
  activeGeneration: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  circuitCooldownMillis: Schema.Int.check(Schema.isGreaterThan(0)),
  circuitOpenedAt: Schema.NullOr(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
  ),
  consecutiveFailures: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  failures: Schema.Array(AcpProcessFailureRecord).check(
    Schema.isMaxLength(MAX_FAILURES)
  ),
  halfOpen: Schema.Boolean,
  health: AcpWorkspaceProcessHealth,
  lastStop: Schema.NullOr(AcpProcessStopRecord),
  nextGeneration: Schema.Int.check(Schema.isGreaterThan(0)),
  readySince: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  restartEpisodeStartedAt: Schema.NullOr(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
  ),
  schemaVersion: Schema.Literal(PROCESS_STATE_SCHEMA_VERSION),
  transitions: Schema.Array(AcpProcessTransition).check(
    Schema.isMaxLength(MAX_TRANSITIONS)
  ),
}) {}

const initialAcpProcessState = (): AcpProcessState =>
  AcpProcessState.make({
    activeGeneration: null,
    circuitCooldownMillis: 5 * 60 * 1000,
    circuitOpenedAt: null,
    consecutiveFailures: 0,
    failures: [],
    halfOpen: false,
    health: "stopped",
    lastStop: null,
    nextGeneration: 1,
    readySince: null,
    restartEpisodeStartedAt: null,
    schemaVersion: PROCESS_STATE_SCHEMA_VERSION,
    transitions: [],
  });

const processStateFailure = (): HandlerFailure =>
  HandlerFailure.make({
    category: "protocol",
    safeDetail: "ACP process state is unavailable",
  });

const isMissingFile = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  cause.code === "ENOENT";

const readState = async (
  path: string,
  trustedRoot: string,
  decode: (value: unknown) => Promise<AcpProcessState>
): Promise<AcpProcessState> => {
  const directory = await retainTrustedDirectory(
    dirname(path),
    "read-acp-process-state"
  );
  try {
    await assertSafeFilePath({
      anchor: trustedRoot,
      operation: "read-acp-process-state",
      path,
    });
    const file = await openRegularFileNoFollow(path, "read-acp-process-state");
    try {
      const metadata = await file.stat();
      const currentUserId = process.getuid?.();
      if (
        metadata.size > MAX_PROCESS_STATE_BYTES ||
        (currentUserId !== undefined && metadata.uid !== currentUserId)
      ) {
        throw new Error("ACP process state identity is unsafe");
      }
      const source = await file.readFile("utf8");
      await verifyRetainedDirectory(directory, "read-acp-process-state");
      return await decode(JSON.parse(source) as unknown);
    } finally {
      await file.close();
    }
  } catch (cause) {
    if (isMissingFile(cause)) {
      return initialAcpProcessState();
    }
    throw cause;
  } finally {
    await directory.handle.close();
  }
};

const writeState = async (options: {
  readonly assertOwned: () => Promise<void>;
  readonly path: string;
  readonly state: AcpProcessState;
  readonly trustedRoot: string;
}): Promise<void> => {
  const directory = await retainTrustedDirectory(
    dirname(options.path),
    "write-acp-process-state"
  );
  const temporaryPath = `${options.path}.${randomUUID()}.tmp`;
  try {
    await options.assertOwned();
    await assertSafeFilePath({
      anchor: options.trustedRoot,
      operation: "write-acp-process-state",
      path: options.path,
    });
    const serialized = JSON.stringify(options.state);
    if (Buffer.byteLength(serialized, "utf8") > MAX_PROCESS_STATE_BYTES) {
      throw new Error("ACP process state exceeded its byte limit");
    }
    const file = await open(temporaryPath, "wx", 0o600);
    try {
      await file.writeFile(serialized, "utf8");
      await file.sync();
      await file.chmod(0o600);
    } finally {
      await file.close();
    }
    await options.assertOwned();
    await verifyRetainedDirectory(directory, "write-acp-process-state");
    await rename(temporaryPath, options.path);
    await chmod(options.path, 0o600);
    await directory.handle.sync();
  } finally {
    await rm(temporaryPath, { force: true });
    await directory.handle.close();
  }
};

const retainTransition = (
  transitions: readonly AcpProcessTransition[],
  transition: AcpProcessTransition
): readonly AcpProcessTransition[] =>
  [...transitions, transition].slice(-MAX_TRANSITIONS);

export interface AcpProcessStateRepository {
  readonly load: Effect.Effect<AcpProcessState, HandlerFailure>;
  readonly recordFailure: (options: {
    readonly cause: AcpProcessStopCause;
    readonly classification: "deterministic" | "transient";
    readonly generation: number;
    readonly timestamp?: number;
  }) => Effect.Effect<AcpProcessState, HandlerFailure>;
  readonly recordStop: (
    stop: AcpProcessStopRecord
  ) => Effect.Effect<AcpProcessState, HandlerFailure>;
  /** Atomically advances and durably publishes nextGeneration before returning. */
  readonly reserveGeneration: (
    timestamp?: number
  ) => Effect.Effect<number, HandlerFailure>;
  readonly transition: (options: {
    readonly activeGeneration?: number | null;
    readonly circuitCooldownMillis?: number;
    readonly circuitOpenedAt?: number | null;
    readonly consecutiveFailures?: number;
    readonly halfOpen?: boolean;
    readonly health: AcpWorkspaceProcessHealth;
    readonly readySince?: number | null;
    readonly restartEpisodeStartedAt?: number | null;
    readonly timestamp?: number;
  }) => Effect.Effect<AcpProcessState, HandlerFailure>;
}

export const makeAcpProcessStateRepository = Effect.fn(
  "makeAcpProcessStateRepository"
)(function* (options: {
  readonly path: string;
  readonly testHooks?: {
    readonly afterGenerationPublished?: (generation: number) => Promise<void>;
    readonly beforeGenerationPublished?: (generation: number) => Promise<void>;
  };
  readonly trustedRoot: string;
}): Effect.fn.Return<AcpProcessStateRepository, HandlerFailure> {
  const gate = yield* Semaphore.make(1);
  const decode = Effect.runPromiseWith(yield* Effect.context<never>());
  const decodeState = (value: unknown): Promise<AcpProcessState> =>
    decode(Schema.decodeUnknownEffect(AcpProcessState)(value));

  const transact = <A>(
    update: (state: AcpProcessState) => readonly [A, AcpProcessState],
    beforeWrite?: (value: A) => Promise<void>
  ): Effect.Effect<A, HandlerFailure> =>
    gate.withPermit(
      Effect.tryPromise({
        try: (signal) =>
          withApplicationFileLock(
            {
              signal,
              targetPath: options.path,
              trustedRoot: options.trustedRoot,
            },
            async (assertOwned) => {
              const current = await readState(
                options.path,
                options.trustedRoot,
                decodeState
              );
              await assertOwned();
              const [value, next] = update(current);
              if (next !== current) {
                await beforeWrite?.(value);
                await assertOwned();
                await writeState({
                  assertOwned,
                  path: options.path,
                  state: next,
                  trustedRoot: options.trustedRoot,
                });
              }
              return value;
            }
          ),
        catch: processStateFailure,
      })
    );

  const transition: AcpProcessStateRepository["transition"] = (change) =>
    Effect.gen(function* () {
      const timestamp = change.timestamp ?? (yield* Clock.currentTimeMillis);
      return yield* transact((state) => {
        const activeGeneration =
          change.activeGeneration === undefined
            ? state.activeGeneration
            : change.activeGeneration;
        const next = AcpProcessState.make({
          ...state,
          activeGeneration,
          circuitCooldownMillis:
            change.circuitCooldownMillis ?? state.circuitCooldownMillis,
          circuitOpenedAt:
            change.circuitOpenedAt === undefined
              ? state.circuitOpenedAt
              : change.circuitOpenedAt,
          consecutiveFailures:
            change.consecutiveFailures ?? state.consecutiveFailures,
          halfOpen: change.halfOpen ?? state.halfOpen,
          health: change.health,
          readySince:
            change.readySince === undefined
              ? state.readySince
              : change.readySince,
          restartEpisodeStartedAt:
            change.restartEpisodeStartedAt === undefined
              ? state.restartEpisodeStartedAt
              : change.restartEpisodeStartedAt,
          transitions: retainTransition(
            state.transitions,
            AcpProcessTransition.make({
              generation: activeGeneration,
              health: change.health,
              timestamp,
            })
          ),
        });
        return [next, next] as const;
      });
    });

  const repository: AcpProcessStateRepository = {
    load: Effect.tryPromise({
      try: () => readState(options.path, options.trustedRoot, decodeState),
      catch: processStateFailure,
    }),
    recordFailure: (failure) =>
      Effect.gen(function* () {
        const timestamp = failure.timestamp ?? (yield* Clock.currentTimeMillis);
        return yield* transact((state) => {
          const next = AcpProcessState.make({
            ...state,
            consecutiveFailures: state.consecutiveFailures + 1,
            failures: [
              ...state.failures,
              AcpProcessFailureRecord.make({ ...failure, timestamp }),
            ].slice(-MAX_FAILURES),
          });
          return [next, next] as const;
        });
      }),
    recordStop: (stop) =>
      transact((state) => {
        const next = AcpProcessState.make({ ...state, lastStop: stop });
        return [next, next] as const;
      }),
    reserveGeneration: (suppliedTimestamp) =>
      Effect.gen(function* () {
        const timestamp = suppliedTimestamp ?? (yield* Clock.currentTimeMillis);
        const generation = yield* transact((state) => {
          const reserved = state.nextGeneration;
          return [
            reserved,
            AcpProcessState.make({
              ...state,
              activeGeneration: reserved,
              health: "starting",
              nextGeneration: reserved + 1,
              readySince: null,
              transitions: retainTransition(
                state.transitions,
                AcpProcessTransition.make({
                  generation: reserved,
                  health: "starting",
                  timestamp,
                })
              ),
            }),
          ] as const;
        }, options.testHooks?.beforeGenerationPublished);
        yield* Effect.tryPromise({
          try: async () => {
            await options.testHooks?.afterGenerationPublished?.(generation);
          },
          catch: processStateFailure,
        });
        return generation;
      }),
    transition,
  };

  // Decode immediately so a corrupt or unsafe state quarantines this workspace
  // before any process can be spawned or a generation can be reused.
  yield* repository.load;
  return repository;
});
