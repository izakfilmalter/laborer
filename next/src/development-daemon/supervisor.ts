import { Effect, Ref, Schema, type Scope, Semaphore } from "effect";
import type { DaemonGenerationFailureReason } from "./generation-protocol.ts";

const MAX_TRANSITIONS = 32;

export class DaemonGenerationError extends Schema.TaggedErrorClass<DaemonGenerationError>()(
  "DaemonGenerationError",
  { reason: Schema.String }
) {}

export interface PreparedDaemonGeneration {
  readonly activate: Effect.Effect<void, DaemonGenerationError>;
  readonly drain: Effect.Effect<void, DaemonGenerationError>;
  readonly fresh?: Effect.Effect<boolean>;
  readonly id: string;
  readonly readyBindings: number;
  readonly stop: Effect.Effect<void>;
}

export interface DaemonGenerationFactory {
  readonly prepare: (
    generationId: string
  ) => Effect.Effect<PreparedDaemonGeneration, DaemonGenerationError>;
}

export type ReloadOutcome =
  | { readonly _tag: "Activated"; readonly generationId: string }
  | {
      readonly _tag: "PreparationRejected";
      readonly generationId: string;
      readonly reason: DaemonGenerationFailureReason;
    }
  | {
      readonly _tag: "RolledBack";
      readonly generationId: string;
      readonly reason: DaemonGenerationFailureReason;
    }
  | {
      readonly _tag: "Unavailable";
      readonly generationId: string;
      readonly reason: DaemonGenerationFailureReason;
    };

export class ReloadError extends Schema.TaggedErrorClass<ReloadError>()(
  "ReloadError",
  { reason: Schema.String }
) {}

export interface DaemonGenerationStatus {
  readonly generationId: string;
  readonly phase: "Active" | "Draining" | "Prepared" | "Released";
  readonly readyBindings: number;
}

export interface DaemonSupervisorTransition {
  readonly generationId: string;
  readonly phase:
    | "Active"
    | "Draining"
    | "Prepared"
    | "Released"
    | "Unavailable";
  readonly reason: DaemonGenerationFailureReason | null;
}

export interface DaemonSupervisorSnapshot {
  readonly active: DaemonGenerationStatus | null;
  readonly candidate: DaemonGenerationStatus | null;
  readonly nextGeneration: number;
  readonly transitions: readonly DaemonSupervisorTransition[];
  readonly unavailable: boolean;
}

export interface DevelopmentDaemonSupervisor {
  readonly reload: Effect.Effect<ReloadOutcome, ReloadError>;
  readonly status: Effect.Effect<DaemonSupervisorSnapshot>;
}

interface SupervisorState extends DaemonSupervisorSnapshot {
  readonly activeHandle: PreparedDaemonGeneration | null;
  readonly candidateHandle: PreparedDaemonGeneration | null;
}

const visibleSnapshot = (state: SupervisorState): DaemonSupervisorSnapshot => ({
  active: state.active,
  candidate: state.candidate,
  nextGeneration: state.nextGeneration,
  transitions: state.transitions,
  unavailable: state.unavailable,
});

const appendTransition = (
  state: SupervisorState,
  transition: DaemonSupervisorTransition
): SupervisorState => ({
  ...state,
  transitions: [...state.transitions, transition].slice(-MAX_TRANSITIONS),
});

const boundedReason = (
  error: DaemonGenerationError,
  fallback: DaemonGenerationFailureReason
): DaemonGenerationFailureReason => {
  const known: readonly DaemonGenerationFailureReason[] = [
    "activation-failed",
    "candidate-exited",
    "configuration-incompatible",
    "ipc-incompatible",
    "preparation-failed",
    "readiness-timeout",
    "runtime-incompatible",
    "stale-candidate",
    "stop-failed",
    "typecheck-failed",
    "workspace-regression",
  ];
  return known.includes(error.reason as DaemonGenerationFailureReason)
    ? (error.reason as DaemonGenerationFailureReason)
    : fallback;
};

export const makeDevelopmentDaemonSupervisor = Effect.fn(
  "makeDevelopmentDaemonSupervisor"
)(function* (
  factory: DaemonGenerationFactory
): Effect.fn.Return<
  DevelopmentDaemonSupervisor,
  DaemonGenerationError,
  Scope.Scope
> {
  const initial = yield* factory.prepare("daemon-1");
  yield* initial.activate;
  const state = yield* Ref.make<SupervisorState>({
    active: {
      generationId: initial.id,
      phase: "Active",
      readyBindings: initial.readyBindings,
    },
    activeHandle: initial,
    candidate: null,
    candidateHandle: null,
    nextGeneration: 2,
    transitions: [
      {
        generationId: initial.id,
        phase: "Active",
        reason: null,
      },
    ],
    unavailable: false,
  });
  const serial = yield* Semaphore.make(1);

  yield* Effect.addFinalizer(() =>
    Ref.get(state).pipe(
      Effect.flatMap((current) =>
        Effect.all(
          [current.candidateHandle?.stop, current.activeHandle?.stop].filter(
            (stop): stop is Effect.Effect<void> => stop !== undefined
          ),
          { concurrency: 1, discard: true }
        )
      )
    )
  );

  const reload = serial.withPermit(
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the serialized handoff keeps ownership, rollback, and cleanup transitions in one monotonic state machine
    Effect.gen(function* () {
      const before = yield* Ref.get(state);
      if (before.unavailable || before.activeHandle === null) {
        return yield* ReloadError.make({ reason: "daemon-unavailable" });
      }
      const generationId = `daemon-${before.nextGeneration}`;
      yield* Ref.update(state, (current) => ({
        ...current,
        nextGeneration: current.nextGeneration + 1,
      }));
      const preparation = yield* Effect.result(factory.prepare(generationId));
      if (preparation._tag === "Failure") {
        return {
          _tag: "PreparationRejected" as const,
          generationId,
          reason: boundedReason(preparation.failure, "preparation-failed"),
        };
      }
      const candidate = preparation.success;
      if (candidate.fresh !== undefined && !(yield* candidate.fresh)) {
        yield* candidate.stop;
        return {
          _tag: "PreparationRejected" as const,
          generationId,
          reason: "stale-candidate" as const,
        };
      }
      yield* Ref.update(state, (current) =>
        appendTransition(
          {
            ...current,
            candidate: {
              generationId: candidate.id,
              phase: "Prepared",
              readyBindings: candidate.readyBindings,
            },
            candidateHandle: candidate,
          },
          { generationId: candidate.id, phase: "Prepared", reason: null }
        )
      );
      const blue = before.activeHandle;
      yield* Ref.update(state, (current) =>
        appendTransition(
          {
            ...current,
            active:
              current.active === null
                ? null
                : { ...current.active, phase: "Draining" },
          },
          { generationId: blue.id, phase: "Draining", reason: null }
        )
      );
      const drained = yield* Effect.result(blue.drain);
      if (drained._tag === "Failure") {
        yield* candidate.stop;
        const reason = boundedReason(drained.failure, "activation-failed");
        const rollback = yield* Effect.result(blue.activate);
        if (rollback._tag === "Success") {
          yield* Ref.update(state, (current) => ({
            ...current,
            active:
              current.active === null
                ? null
                : { ...current.active, phase: "Active" as const },
            candidate: null,
            candidateHandle: null,
          }));
          return {
            _tag: "RolledBack" as const,
            generationId: blue.id,
            reason,
          };
        }
        yield* blue.stop;
        yield* Ref.update(state, (current) =>
          appendTransition(
            {
              ...current,
              active: null,
              activeHandle: null,
              candidate: null,
              candidateHandle: null,
              unavailable: true,
            },
            {
              generationId: blue.id,
              phase: "Unavailable",
              reason: boundedReason(rollback.failure, "activation-failed"),
            }
          )
        );
        return {
          _tag: "Unavailable" as const,
          generationId: blue.id,
          reason,
        };
      }
      yield* Ref.update(state, (current) =>
        appendTransition(
          {
            ...current,
            active:
              current.active === null
                ? null
                : { ...current.active, phase: "Released" },
          },
          { generationId: blue.id, phase: "Released", reason: null }
        )
      );
      const activated = yield* Effect.result(candidate.activate);
      const workspaceRegression =
        activated._tag === "Success" &&
        candidate.readyBindings < blue.readyBindings;
      if (activated._tag === "Success" && !workspaceRegression) {
        yield* Ref.update(state, (current) =>
          appendTransition(
            {
              ...current,
              active: {
                generationId: candidate.id,
                phase: "Active",
                readyBindings: candidate.readyBindings,
              },
              activeHandle: candidate,
              candidate: null,
              candidateHandle: null,
            },
            { generationId: candidate.id, phase: "Active", reason: null }
          )
        );
        yield* blue.stop;
        return { _tag: "Activated" as const, generationId: candidate.id };
      }

      const activationReason =
        activated._tag === "Failure"
          ? boundedReason(activated.failure, "activation-failed")
          : ("workspace-regression" as const);
      yield* candidate.stop;
      const rollback = yield* Effect.result(blue.activate);
      if (rollback._tag === "Success") {
        yield* Ref.update(state, (current) =>
          appendTransition(
            {
              ...current,
              active: {
                generationId: blue.id,
                phase: "Active",
                readyBindings: blue.readyBindings,
              },
              activeHandle: blue,
              candidate: null,
              candidateHandle: null,
            },
            {
              generationId: blue.id,
              phase: "Active",
              reason: activationReason,
            }
          )
        );
        return {
          _tag: "RolledBack" as const,
          generationId: blue.id,
          reason: activationReason,
        };
      }
      yield* blue.stop;
      yield* Ref.update(state, (current) =>
        appendTransition(
          {
            ...current,
            active: null,
            activeHandle: null,
            candidate: null,
            candidateHandle: null,
            unavailable: true,
          },
          {
            generationId: blue.id,
            phase: "Unavailable",
            reason: boundedReason(rollback.failure, "activation-failed"),
          }
        )
      );
      return {
        _tag: "Unavailable" as const,
        generationId: blue.id,
        reason: activationReason,
      };
    })
  );

  return {
    reload,
    status: Ref.get(state).pipe(Effect.map(visibleSnapshot)),
  };
});
