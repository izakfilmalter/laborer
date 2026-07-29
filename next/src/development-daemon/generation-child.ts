import { Console, Effect, Exit, Schema, Scope } from "effect";
import { loadSlackDaemonConfig } from "../slack/config.ts";
import {
  acquireLiveSlackClientGeneration,
  LIVE_SLACK_PROJECT_ROOT,
  type LiveSlackClientGeneration,
} from "../slack/live-generation.ts";
import {
  DAEMON_GENERATION_PROTOCOL_VERSION,
  type DaemonGenerationReport,
  decodeDaemonGenerationCommand,
  encodeDaemonGenerationIpc,
} from "./generation-protocol.ts";

const generationId = process.env.LABORER_DAEMON_GENERATION_ID ?? "invalid";
const startedAt = Date.now();
const config = await Effect.runPromise(
  loadSlackDaemonConfig({ defaultRoot: LIVE_SLACK_PROJECT_ROOT })
);

let active: {
  readonly runtime: LiveSlackClientGeneration;
  readonly scope: Scope.Closeable;
} | null = null;
let commands = Promise.resolve();

class GenerationControlError extends Schema.TaggedErrorClass<GenerationControlError>()(
  "GenerationControlError",
  { reason: Schema.String }
) {}

const send = (
  report: Omit<
    DaemonGenerationReport,
    "durationMillis" | "generationId" | "protocolVersion"
  >
): void => {
  const record: DaemonGenerationReport = {
    ...report,
    durationMillis: Math.min(86_400_000, Date.now() - startedAt),
    generationId,
    protocolVersion: DAEMON_GENERATION_PROTOCOL_VERSION,
  };
  encodeDaemonGenerationIpc(record);
  process.send?.(record);
};

const release = Effect.fn("releaseDaemonGeneration")(function* () {
  if (active === null) {
    return;
  }
  const owned = active;
  active = null;
  yield* owned.runtime.quiesce;
  yield* Scope.close(owned.scope, Exit.void);
});

const activate = Effect.fn("activateDaemonGeneration")(function* () {
  if (active !== null) {
    return active.runtime;
  }
  const scope = yield* Scope.make();
  const acquired = yield* Effect.exit(
    acquireLiveSlackClientGeneration(config, LIVE_SLACK_PROJECT_ROOT, {
      awaitWorkspacePreflight: true,
    }).pipe(Effect.provideService(Scope.Scope, scope))
  );
  if (acquired._tag === "Failure") {
    yield* Scope.close(scope, acquired);
    return yield* Effect.failCause(acquired.cause);
  }
  active = { runtime: acquired.value, scope };
  return acquired.value;
});

const handle = (untrusted: unknown): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const command = yield* Effect.try({
        try: () => decodeDaemonGenerationCommand(untrusted),
        catch: () =>
          GenerationControlError.make({ reason: "incompatible-ipc-command" }),
      });
      if (command.generationId !== generationId) {
        return yield* GenerationControlError.make({
          reason: "generation-identity-mismatch",
        });
      }
      switch (command.command) {
        case "activate": {
          const activated = yield* Effect.result(activate());
          send(
            activated._tag === "Success"
              ? {
                  phase: "active",
                  readyBindings: yield* activated.success.readyBindings,
                }
              : {
                  phase: "failed",
                  readyBindings: 0,
                  reason: "activation-failed",
                }
          );
          return;
        }
        case "drain":
          yield* release();
          send({ phase: "released", readyBindings: 0 });
          return;
        case "stop":
          yield* release();
          process.disconnect?.();
          return;
        default:
          return;
      }
    }).pipe(
      Effect.catch(() =>
        Console.error("Daemon generation rejected a control command").pipe(
          Effect.andThen(
            Effect.sync(() =>
              send({
                phase: "failed",
                readyBindings: 0,
                reason: "ipc-incompatible",
              })
            )
          )
        )
      )
    )
  );

process.on("message", (message) => {
  commands = commands.then(() => handle(message));
});
process.on("disconnect", () => {
  Effect.runPromise(release()).finally(() => process.exit(0));
});

send({ phase: "prepared", readyBindings: 0 });
