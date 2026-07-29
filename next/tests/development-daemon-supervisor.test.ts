import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Ref } from "effect";
import {
  DaemonGenerationError,
  type DaemonGenerationFactory,
  makeDevelopmentDaemonSupervisor,
  type PreparedDaemonGeneration,
} from "../src/development-daemon/supervisor.ts";

const generation = (options: {
  readonly activate?: Effect.Effect<void, DaemonGenerationError>;
  readonly drain?: Effect.Effect<void, DaemonGenerationError>;
  readonly id: string;
  readonly observe?: (event: string) => void;
}): PreparedDaemonGeneration => ({
  activate: Effect.sync(() => options.observe?.(`${options.id}:activate`)).pipe(
    Effect.andThen(options.activate ?? Effect.void)
  ),
  drain: Effect.sync(() => options.observe?.(`${options.id}:drain`)).pipe(
    Effect.andThen(options.drain ?? Effect.void)
  ),
  id: options.id,
  readyBindings: 2,
  stop: Effect.sync(() => options.observe?.(`${options.id}:stop`)),
});

const factoryFor = (
  generations: readonly PreparedDaemonGeneration[]
): Effect.Effect<DaemonGenerationFactory> =>
  Ref.make(0).pipe(
    Effect.map((index) => ({
      prepare: () =>
        Ref.getAndUpdate(index, (current) => current + 1).pipe(
          Effect.flatMap((current) => {
            const prepared = generations[current];
            return prepared === undefined
              ? DaemonGenerationError.make({ reason: "preparation-failed" })
              : Effect.succeed(prepared);
          })
        ),
    }))
  );

describe("development Daemon supervisor", () => {
  it.effect("publishes the monotonic global drain-and-swap lifecycle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const releaseDrain = yield* Deferred.make<void>();
        const factory = yield* factoryFor([
          generation({ id: "daemon-1", drain: Deferred.await(releaseDrain) }),
          generation({ id: "daemon-2" }),
        ]);
        const supervisor = yield* makeDevelopmentDaemonSupervisor(factory);
        const reload = yield* supervisor.reload.pipe(
          Effect.forkScoped({ startImmediately: true })
        );

        yield* Effect.yieldNow;
        const draining = yield* supervisor.status;
        assert.strictEqual(draining.active?.phase, "Draining");
        assert.strictEqual(draining.candidate?.phase, "Prepared");
        assert.deepStrictEqual(
          draining.transitions.map(({ generationId, phase }) => ({
            generationId,
            phase,
          })),
          [
            { generationId: "daemon-1", phase: "Active" },
            { generationId: "daemon-2", phase: "Prepared" },
            { generationId: "daemon-1", phase: "Draining" },
          ]
        );

        yield* Deferred.succeed(releaseDrain, undefined);
        assert.deepStrictEqual(yield* Fiber.join(reload), {
          _tag: "Activated",
          generationId: "daemon-2",
        });
        const active = yield* supervisor.status;
        assert.strictEqual(active.active?.generationId, "daemon-2");
        assert.strictEqual(active.active?.phase, "Active");
        assert.strictEqual(active.candidate, null);
      })
    )
  );

  it.effect("releases a failed green before explicitly reactivating blue", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events: string[] = [];
        const factory = yield* factoryFor([
          generation({
            id: "daemon-1",
            observe: (event) => events.push(event),
          }),
          generation({
            activate: DaemonGenerationError.make({
              reason: "workspace-regression",
            }),
            id: "daemon-2",
            observe: (event) => events.push(event),
          }),
        ]);
        const supervisor = yield* makeDevelopmentDaemonSupervisor(factory);

        assert.deepStrictEqual(yield* supervisor.reload, {
          _tag: "RolledBack",
          generationId: "daemon-1",
          reason: "workspace-regression",
        });
        assert.deepStrictEqual(events, [
          "daemon-1:activate",
          "daemon-1:drain",
          "daemon-2:activate",
          "daemon-2:stop",
          "daemon-1:activate",
        ]);
        assert.strictEqual(
          (yield* supervisor.status).active?.generationId,
          "daemon-1"
        );
      })
    )
  );

  it.effect("rejects a failed preparation without draining blue", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events: string[] = [];
        const factory = yield* factoryFor([
          generation({
            id: "daemon-1",
            observe: (event) => events.push(event),
          }),
        ]);
        const supervisor = yield* makeDevelopmentDaemonSupervisor(factory);

        assert.deepStrictEqual(yield* supervisor.reload, {
          _tag: "PreparationRejected",
          generationId: "daemon-2",
          reason: "preparation-failed",
        });
        assert.deepStrictEqual(events, ["daemon-1:activate"]);
        assert.strictEqual((yield* supervisor.status).active?.phase, "Active");
      })
    )
  );

  it.effect("discards a stale prepared candidate before drain", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events: string[] = [];
        const stale = {
          ...generation({
            id: "daemon-2",
            observe: (event) => events.push(event),
          }),
          fresh: Effect.succeed(false),
        } satisfies PreparedDaemonGeneration;
        const factory = yield* factoryFor([
          generation({
            id: "daemon-1",
            observe: (event) => events.push(event),
          }),
          stale,
        ]);
        const supervisor = yield* makeDevelopmentDaemonSupervisor(factory);

        assert.strictEqual(
          (yield* supervisor.reload)._tag,
          "PreparationRejected"
        );
        assert.deepStrictEqual(events, ["daemon-1:activate", "daemon-2:stop"]);
        assert.strictEqual((yield* supervisor.status).active?.phase, "Active");
      })
    )
  );

  it.effect(
    "ends visibly unavailable after the one rollback attempt fails",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let blueActivations = 0;
          const blue = generation({
            activate: Effect.suspend(() => {
              blueActivations += 1;
              return blueActivations === 1
                ? Effect.void
                : DaemonGenerationError.make({ reason: "activation-failed" });
            }),
            id: "daemon-1",
          });
          const green = generation({
            activate: DaemonGenerationError.make({
              reason: "workspace-regression",
            }),
            id: "daemon-2",
          });
          const supervisor = yield* makeDevelopmentDaemonSupervisor(
            yield* factoryFor([blue, green])
          );

          assert.deepStrictEqual(yield* supervisor.reload, {
            _tag: "Unavailable",
            generationId: "daemon-1",
            reason: "workspace-regression",
          });
          const status = yield* supervisor.status;
          assert.strictEqual(status.unavailable, true);
          assert.strictEqual(status.active, null);
          assert.strictEqual(status.transitions.at(-1)?.phase, "Unavailable");
        })
      )
  );
});
