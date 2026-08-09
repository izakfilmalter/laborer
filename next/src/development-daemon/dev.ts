import { watch } from "node:fs";
import { resolve } from "node:path";
import { Console, Effect, FiberSet } from "effect";
import { makeProcessDaemonGenerationFactory } from "./process-generation-factory.ts";
import { makeDevelopmentDaemonSupervisor } from "./supervisor.ts";

const WATCH_DIRECTORIES = [
  "src/adapters",
  "src/slack",
  "src/acp-runtime",
  "src/prototype",
] as const;
const DEBOUNCE_MILLIS = 150;

const waitForShutdownSignal: Effect.Effect<void> = Effect.callback((resume) => {
  const stop = (): void => resume(Effect.void);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return Effect.sync(() => {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  });
});

const program = Effect.scoped(
  Effect.gen(function* () {
    let sourceVersion = 0;
    let requestedVersion = 0;
    let handledVersion = 0;
    let reloadRunning = false;
    let debounce: NodeJS.Timeout | null = null;
    const supervisor = yield* makeDevelopmentDaemonSupervisor(
      makeProcessDaemonGenerationFactory({
        getSourceVersion: () => sourceVersion,
      })
    );
    const initial = yield* supervisor.status;
    yield* Console.log(
      `[dev:slack] ${initial.active?.generationId ?? "unknown"} Active`
    );
    const reloadFibers = yield* FiberSet.make<void, never>();
    const runReload = yield* FiberSet.runtime(reloadFibers)<never>();
    const runReloads = (): void => {
      if (reloadRunning) {
        return;
      }
      reloadRunning = true;
      runReload(
        Effect.gen(function* () {
          while (handledVersion < requestedVersion) {
            handledVersion = requestedVersion;
            const reloadStartedAt = performance.now();
            const outcome = yield* supervisor.reload;
            const durationMillis = Math.max(
              0,
              Math.round(performance.now() - reloadStartedAt)
            );
            const reason =
              "reason" in outcome ? ` reason=${outcome.reason}` : "";
            yield* Console.log(
              `[dev:slack] ${outcome._tag} generation=${outcome.generationId} durationMillis=${durationMillis}${reason}`
            );
          }
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              reloadRunning = false;
              if (handledVersion < requestedVersion) {
                runReloads();
              }
            })
          ),
          Effect.catchCause((cause) =>
            Console.error("Development reload stopped", {
              reason: String(cause).slice(0, 128),
            }).pipe(Effect.andThen(Effect.sync(() => (process.exitCode = 1))))
          )
        )
      );
    };
    const changed = (): void => {
      sourceVersion += 1;
      requestedVersion = sourceVersion;
      if (debounce !== null) {
        clearTimeout(debounce);
      }
      debounce = setTimeout(runReloads, DEBOUNCE_MILLIS);
    };
    const watchers = WATCH_DIRECTORIES.map((directory) =>
      watch(resolve(process.cwd(), directory), { recursive: true }, changed)
    );
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (debounce !== null) {
          clearTimeout(debounce);
        }
        for (const watcher of watchers) {
          watcher.close();
        }
      })
    );
    yield* waitForShutdownSignal;
    yield* Console.log("Development Slack Laborer stopped cleanly.");
  })
);

await Effect.runPromise(program);
