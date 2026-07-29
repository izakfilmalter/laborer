import { type ChildProcess, execFile, fork } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { Effect, Exit, Fiber } from "effect";
import {
  DAEMON_GENERATION_PROTOCOL_VERSION,
  type DaemonGenerationCommand,
  type DaemonGenerationReport,
  decodeDaemonGenerationReport,
  encodeDaemonGenerationIpc,
} from "./generation-protocol.ts";
import {
  DaemonGenerationError,
  type DaemonGenerationFactory,
  type PreparedDaemonGeneration,
} from "./supervisor.ts";

const execFilePromise = promisify(execFile);
const PREPARATION_TIMEOUT_MILLIS = 30_000;
const CHILD_PATH = resolve(
  process.cwd(),
  "src/development-daemon/generation-child.ts"
);

const failure = (reason: string): DaemonGenerationError =>
  DaemonGenerationError.make({ reason: reason.slice(0, 64) });

const awaitReport = (
  child: ChildProcess,
  generationId: string
): Effect.Effect<DaemonGenerationReport, DaemonGenerationError> =>
  Effect.callback((resume) => {
    const cleanup = (): void => {
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("message", onMessage);
    };
    const onError = (): void => {
      cleanup();
      resume(Effect.fail(failure("candidate-exited")));
    };
    const onExit = (): void => {
      cleanup();
      resume(Effect.fail(failure("candidate-exited")));
    };
    const onMessage = (message: unknown): void => {
      try {
        const report = decodeDaemonGenerationReport(message);
        if (report.generationId !== generationId) {
          throw new Error("generation identity mismatch");
        }
        cleanup();
        resume(Effect.succeed(report));
      } catch {
        cleanup();
        resume(Effect.fail(failure("ipc-incompatible")));
      }
    };
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("message", onMessage);
    return Effect.sync(cleanup);
  });

const sendCommand = (
  child: ChildProcess,
  command: DaemonGenerationCommand
): Effect.Effect<DaemonGenerationReport, DaemonGenerationError> =>
  Effect.gen(function* () {
    encodeDaemonGenerationIpc(command);
    const response = yield* awaitReport(child, command.generationId).pipe(
      Effect.forkScoped({ startImmediately: true })
    );
    yield* Effect.try({
      try: () => child.send(command),
      catch: () => failure("candidate-exited"),
    });
    return yield* Fiber.join(response);
  }).pipe(Effect.scoped);

const stopChild = (
  child: ChildProcess,
  generationId: string
): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (child.exitCode !== null || !child.connected) {
      return;
    }
    const exited = Effect.callback<void>((resume) => {
      const onExit = (): void => resume(Effect.void);
      child.once("exit", onExit);
      return Effect.sync(() => child.off("exit", onExit));
    });
    yield* Effect.sync(() =>
      child.send({
        command: "stop",
        generationId,
        protocolVersion: DAEMON_GENERATION_PROTOCOL_VERSION,
      } satisfies DaemonGenerationCommand)
    );
    yield* Effect.raceFirst(exited, Effect.sleep("10 seconds"));
  });

const operation = (
  child: ChildProcess,
  generationId: string,
  command: "activate" | "drain",
  expected: "active" | "released"
): Effect.Effect<void, DaemonGenerationError> =>
  sendCommand(child, {
    command,
    generationId,
    protocolVersion: DAEMON_GENERATION_PROTOCOL_VERSION,
  }).pipe(
    Effect.flatMap((report) =>
      report.phase === expected
        ? Effect.void
        : Effect.fail(failure(report.reason ?? `${command}-failed`))
    )
  );

export const makeProcessDaemonGenerationFactory = (options: {
  readonly getSourceVersion: () => number;
}): DaemonGenerationFactory => ({
  prepare: (generationId) =>
    Effect.gen(function* () {
      const sourceVersion = options.getSourceVersion();
      const checked = yield* Effect.result(
        Effect.tryPromise(() =>
          execFilePromise("bun", ["run", "typecheck"], {
            cwd: process.cwd(),
            maxBuffer: 1024 * 1024,
            timeout: PREPARATION_TIMEOUT_MILLIS,
          })
        )
      );
      if (checked._tag === "Failure") {
        return yield* failure("typecheck-failed");
      }
      const child = fork(CHILD_PATH, [], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          LABORER_DAEMON_GENERATION_ID: generationId,
        },
        execArgv: process.execArgv,
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
      const prepared = yield* Effect.raceFirst(
        awaitReport(child, generationId),
        Effect.sleep(`${PREPARATION_TIMEOUT_MILLIS} millis`).pipe(
          Effect.andThen(Effect.fail(failure("readiness-timeout")))
        )
      ).pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit) ? stopChild(child, generationId) : Effect.void
        )
      );
      if (prepared.phase !== "prepared") {
        yield* stopChild(child, generationId);
        return yield* failure(prepared.reason ?? "preparation-failed");
      }
      let readyBindings = prepared.readyBindings;
      const activate = sendCommand(child, {
        command: "activate",
        generationId,
        protocolVersion: DAEMON_GENERATION_PROTOCOL_VERSION,
      }).pipe(
        Effect.flatMap((report) => {
          if (report.phase !== "active") {
            return Effect.fail(failure(report.reason ?? "activation-failed"));
          }
          return Effect.sync(() => {
            readyBindings = report.readyBindings;
          });
        })
      );
      return {
        activate,
        drain: operation(child, generationId, "drain", "released"),
        fresh: Effect.sync(() => options.getSourceVersion() === sourceVersion),
        id: generationId,
        get readyBindings() {
          return readyBindings;
        },
        stop: stopChild(child, generationId),
      } satisfies PreparedDaemonGeneration;
    }),
});
