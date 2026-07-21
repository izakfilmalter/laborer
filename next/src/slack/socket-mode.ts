import { Effect, FiberSet, type Scope } from "effect";
import type { Runner } from "../prototype/runtime.ts";
import type { SlackRuntimeIdentity } from "./config.ts";
import { SocketModeAdapterError } from "./errors.ts";
import { normalizeSlackEvent } from "./normalize.ts";

export interface SlackEventEnvelope {
  readonly ack: (response?: Readonly<Record<string, unknown>>) => Promise<void>;
  readonly body: unknown;
}

export type SlackEventListener = (envelope: SlackEventEnvelope) => void;

export interface SocketModeClientBoundary {
  readonly disconnect: () => Promise<void>;
  readonly off: (event: "slack_event", listener: SlackEventListener) => unknown;
  readonly on: (event: "slack_event", listener: SlackEventListener) => unknown;
  readonly start: () => Promise<unknown>;
}

const adapterFailure = (operation: string): SocketModeAdapterError =>
  SocketModeAdapterError.make({ operation, reason: "socket-mode-failed" });

const processEnvelope = (
  envelope: SlackEventEnvelope,
  identity: SlackRuntimeIdentity,
  runner: Runner
): Effect.Effect<void> =>
  Effect.tryPromise({
    try: () => envelope.ack(),
    catch: () => adapterFailure("ack"),
  }).pipe(
    Effect.andThen(normalizeSlackEvent(envelope.body, identity)),
    Effect.flatMap((event) =>
      event === null ? Effect.void : runner.inject(event).pipe(Effect.asVoid)
    ),
    Effect.catch((error) =>
      Effect.logError("Slack event processing stopped safely", {
        errorTag: error._tag,
      })
    )
  );

export const startSocketModeAdapter = (options: {
  readonly client: SocketModeClientBoundary;
  readonly identity: SlackRuntimeIdentity;
  readonly runner: Runner;
}): Effect.Effect<void, SocketModeAdapterError, Scope.Scope> =>
  Effect.gen(function* () {
    const fibers = yield* FiberSet.make<void, never>();
    const runEnvelope = yield* FiberSet.runtime(fibers)();
    const listener: SlackEventListener = (envelope) => {
      runEnvelope(processEnvelope(envelope, options.identity, options.runner));
    };
    yield* Effect.acquireRelease(
      Effect.sync(() => options.client.on("slack_event", listener)),
      () =>
        Effect.sync(() => options.client.off("slack_event", listener)).pipe(
          Effect.asVoid
        )
    );
    yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => options.client.start(),
        catch: () => adapterFailure("start"),
      }),
      () =>
        Effect.tryPromise({
          try: () => options.client.disconnect(),
          catch: () => adapterFailure("disconnect"),
        }).pipe(Effect.orDie)
    );
  });
