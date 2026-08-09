import { randomInt } from "node:crypto";
import {
  Clock,
  Deferred,
  Effect,
  Exit,
  type Fiber,
  FiberSet,
  Scope,
  Semaphore,
} from "effect";
import { HandlerFailure } from "../prototype/errors.ts";
import type {
  ConversationAgentRequest,
  ConversationAgentShape,
  PublishConversationAgentMessage,
} from "../reference-coding-application.ts";
import type { AcpConversationProcessHealth } from "./acp-conversation-agent.ts";
import {
  type AcpProcessCleanupOutcome,
  type AcpProcessStateRepository,
  type AcpProcessStopCause,
  AcpProcessStopRecord,
  type AcpWorkspaceProcessHealth,
} from "./acp-process-state.ts";

const DEFAULT_MAX_EPISODE_ATTEMPTS = 5;
const DEFAULT_EPISODE_MILLIS = 90_000;
const DEFAULT_FAILURE_WINDOW_MILLIS = 5 * 60 * 1000;
const DEFAULT_CIRCUIT_FAILURES = 5;
const DEFAULT_CIRCUIT_COOLDOWN_MILLIS = 5 * 60 * 1000;
const MAX_CIRCUIT_COOLDOWN_MILLIS = 60 * 60 * 1000;
const READY_RESET_MILLIS = 60_000;
const BASE_BACKOFF_MILLIS = 250;
const MAX_BACKOFF_MILLIS = 4000;
const MAX_BACKOFF_WITH_JITTER_MILLIS = 5000;
const MAX_TRACKED_CONVERSATIONS = 1024;
const MAX_QUEUED_PROMPTS = 1024;
const GENERATION_FAILURE_SETTLEMENT_MILLIS = 50;
const SUPERVISOR_DEFECT_SETTLEMENT_MILLIS = 10_000;

export type AcpGenerationFailureClassification = "deterministic" | "transient";

export interface AcpGenerationExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface AcpGenerationContext {
  readonly generation: number;
  readonly observeCleanup: (outcome: AcpProcessCleanupOutcome) => void;
  readonly observeExit: (exit: AcpGenerationExit) => void;
  readonly observeFailureClassification: (
    classification: AcpGenerationFailureClassification,
    cause: AcpProcessStopCause
  ) => void;
  readonly observeHealth: (health: AcpConversationProcessHealth) => void;
}

export interface AcpWorkspaceSupervisorHealthSnapshot {
  readonly activePrompts: number;
  readonly activeSessions: number;
  readonly circuitCooldownMillis: number;
  readonly circuitOpenedAt: number | null;
  readonly generation: number | null;
  readonly health: AcpWorkspaceProcessHealth;
  readonly lastStop: AcpProcessStopRecord | null;
  readonly queuedConversations: number;
  readonly readySince: number | null;
  readonly restartEpisodeStartedAt: number | null;
  readonly workspaceId: string;
}

export interface AcpConversationProcessSupervisor {
  readonly agent: ConversationAgentShape;
  readonly health: Effect.Effect<AcpWorkspaceSupervisorHealthSnapshot>;
}

export interface AcpProcessSupervisorTestHooks {
  readonly afterGenerationReservedBeforeSpawn?: (
    generation: number
  ) => Effect.Effect<void>;
  readonly circuitCooldownMillis?: number;
  readonly circuitFailureCount?: number;
  readonly episodeMillis?: number;
  readonly failureWindowMillis?: number;
  readonly maxEpisodeAttempts?: number;
  readonly supervisorDefectSettlementMillis?: number;
}

const unavailable = (health: AcpWorkspaceProcessHealth): HandlerFailure =>
  HandlerFailure.make({
    category: "protocol",
    noticeStyle: "generic",
    safeDetail:
      health === "circuit_open"
        ? "ACP workspace is temporarily unavailable"
        : "ACP workspace is unavailable",
  });

const boundedBackoff = (consecutiveFailures: number): number =>
  Math.min(
    MAX_BACKOFF_MILLIS,
    BASE_BACKOFF_MILLIS * 2 ** Math.max(0, consecutiveFailures - 1)
  );

const defaultJitter = (upperExclusive: number): number =>
  randomInt(0, Math.max(1, upperExclusive));

const cleanupOutcomeFor = (
  cleanupFailed: boolean,
  observed: AcpProcessCleanupOutcome
): AcpProcessCleanupOutcome => {
  if (cleanupFailed) {
    return "failed";
  }
  return observed === "not_attempted" ? "completed" : observed;
};

const stopPhaseFor = (
  becameReady: boolean,
  activePrompts: number
): "idle" | "prompt" | "startup" => {
  if (!becameReady) {
    return "startup";
  }
  return activePrompts > 0 ? "prompt" : "idle";
};

const awaitFiberBounded = <A, E>(
  fiber: Fiber.Fiber<A, E>,
  timeoutMillis: number
): Effect.Effect<Exit.Exit<A, E> | null> =>
  Effect.callback((resume) => {
    let settled = false;
    let removeObserver = (): void => undefined;
    const settle = (exit: Exit.Exit<A, E> | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      removeObserver();
      resume(Effect.succeed(exit));
    };
    const timeout = setTimeout(() => settle(null), timeoutMillis);
    removeObserver = fiber.addObserver(settle);
    return Effect.sync(() => {
      settled = true;
      clearTimeout(timeout);
      removeObserver();
    });
  });

export const makeAcpConversationProcessSupervisor = Effect.fn(
  "makeAcpConversationProcessSupervisor"
)(function* (options: {
  readonly jitter?: (upperExclusive: number) => number;
  readonly makeGeneration: (
    context: AcpGenerationContext
  ) => Effect.Effect<ConversationAgentShape, HandlerFailure, Scope.Scope>;
  readonly repository: AcpProcessStateRepository;
  readonly testHooks?: AcpProcessSupervisorTestHooks;
  readonly workspaceId: string;
}): Effect.fn.Return<AcpConversationProcessSupervisor, never, Scope.Scope> {
  const parentScope = yield* Scope.Scope;
  const stateGate = yield* Semaphore.make(1);
  const promptAdmission = yield* Semaphore.make(1);
  const watchers = yield* FiberSet.make<void, never>();
  const runWatcher = yield* FiberSet.runtime(watchers)<never>();
  const privateContext = yield* Effect.context<never>();
  const runPrivate = Effect.runForkWith(privateContext);
  const jitter = options.jitter ?? defaultJitter;
  const maxEpisodeAttempts =
    options.testHooks?.maxEpisodeAttempts ?? DEFAULT_MAX_EPISODE_ATTEMPTS;
  const episodeMillis =
    options.testHooks?.episodeMillis ?? DEFAULT_EPISODE_MILLIS;
  const failureWindowMillis =
    options.testHooks?.failureWindowMillis ?? DEFAULT_FAILURE_WINDOW_MILLIS;
  const circuitFailureCount =
    options.testHooks?.circuitFailureCount ?? DEFAULT_CIRCUIT_FAILURES;
  const initialCircuitCooldown =
    options.testHooks?.circuitCooldownMillis ?? DEFAULT_CIRCUIT_COOLDOWN_MILLIS;
  const supervisorDefectSettlementMillis =
    options.testHooks?.supervisorDefectSettlementMillis ??
    SUPERVISOR_DEFECT_SETTLEMENT_MILLIS;

  interface ActiveGeneration {
    readonly agent: ConversationAgentShape;
    readonly available: { current: boolean };
    readonly generation: number;
    readonly lost: Deferred.Deferred<void>;
    readonly retired: Deferred.Deferred<void>;
  }
  let current: ActiveGeneration | undefined;
  let readyGate = yield* Deferred.make<ActiveGeneration, HandlerFailure>();
  const initialOutcome = yield* Deferred.make<"ready" | "unavailable">();
  let durableState = yield* options.repository.load.pipe(
    Effect.orElseSucceed(() => ({
      activeGeneration: null,
      circuitCooldownMillis: initialCircuitCooldown,
      circuitOpenedAt: null,
      consecutiveFailures: 0,
      failures: [],
      halfOpen: false,
      health: "quarantined" as const,
      lastStop: null,
      nextGeneration: 1,
      readySince: null,
      restartEpisodeStartedAt: null,
      schemaVersion: 1 as const,
      transitions: [],
    }))
  );
  let activePrompts = 0;
  let queuedPrompts = 0;
  const queuedConversationCounts = new Map<string, number>();
  const observedConversations = new Set<string>();
  let expectedShutdown = false;
  let activeGenerationScope: Scope.Closeable | undefined;
  let activeCleanupOutcome: AcpProcessCleanupOutcome = "not_attempted";

  const publishHealth = (
    change: Parameters<AcpProcessStateRepository["transition"]>[0]
  ) =>
    options.repository.transition(change).pipe(
      Effect.tap((state) =>
        Effect.sync(() => {
          durableState = state;
        })
      ),
      Effect.asVoid,
      Effect.orDie
    );

  const rotateReadyGate = Effect.fnUntraced(function* () {
    readyGate = yield* Deferred.make<ActiveGeneration, HandlerFailure>();
  });

  const closeReadyGate = (health: AcpWorkspaceProcessHealth) =>
    Deferred.fail(readyGate, unavailable(health)).pipe(Effect.asVoid);

  const awaitReady = Effect.fn("AcpProcessSupervisor.awaitReady")(
    function* (): Effect.fn.Return<ActiveGeneration, HandlerFailure> {
      const selected = yield* stateGate.withPermit(
        Effect.sync(() => ({
          current,
          gate: readyGate,
          health: durableState.health,
        }))
      );
      if (selected.current !== undefined) {
        if (selected.current.available.current) {
          return selected.current;
        }
        yield* Deferred.await(selected.current.retired);
        return yield* awaitReady();
      }
      if (
        selected.health === "circuit_open" ||
        selected.health === "quarantined" ||
        selected.health === "stopped"
      ) {
        return yield* unavailable(selected.health);
      }
      return yield* Deferred.await(selected.gate);
    }
  );

  const registerQueuedConversation = (
    conversationId: string
  ): Effect.Effect<{ readonly release: Effect.Effect<void> }, HandlerFailure> =>
    stateGate.withPermit(
      Effect.gen(function* () {
        if (queuedPrompts >= MAX_QUEUED_PROMPTS) {
          return yield* HandlerFailure.make({
            category: "protocol",
            noticeStyle: "generic",
            safeDetail: "ACP workspace prompt queue is at capacity",
          });
        }
        const count = queuedConversationCounts.get(conversationId) ?? 0;
        queuedConversationCounts.set(conversationId, count + 1);
        queuedPrompts += 1;
        let released = false;
        return {
          release: stateGate.withPermit(
            Effect.sync(() => {
              if (released) {
                return;
              }
              released = true;
              queuedPrompts = Math.max(0, queuedPrompts - 1);
              const currentCount =
                queuedConversationCounts.get(conversationId) ?? 0;
              if (currentCount <= 1) {
                queuedConversationCounts.delete(conversationId);
              } else {
                queuedConversationCounts.set(conversationId, currentCount - 1);
              }
            })
          ),
        };
      })
    );

  const runAgent = (
    method: "handle" | "recover",
    request: ConversationAgentRequest,
    publish?: PublishConversationAgentMessage
  ) =>
    Effect.acquireUseRelease(
      registerQueuedConversation(request.conversationId),
      ({ release }) =>
        promptAdmission.withPermit(
          Effect.gen(function* () {
            // Resolve only after admission. A caller queued behind generation N
            // therefore observes N+1 if N is lost while the caller waits.
            const generation = yield* awaitReady();
            yield* release;
            yield* stateGate.withPermit(
              Effect.sync(() => {
                activePrompts += 1;
                if (observedConversations.size < MAX_TRACKED_CONVERSATIONS) {
                  observedConversations.add(request.conversationId);
                }
              })
            );
            const operation =
              method === "recover" && generation.agent.recover !== undefined
                ? generation.agent.recover(request, publish)
                : generation.agent.handle(request, publish);
            return yield* operation.pipe(
              Effect.tapError(() =>
                Effect.raceFirst(
                  Deferred.await(generation.lost),
                  Effect.sleep(`${GENERATION_FAILURE_SETTLEMENT_MILLIS} millis`)
                ).pipe(Effect.asVoid)
              ),
              Effect.ensuring(
                stateGate.withPermit(
                  Effect.sync(() => {
                    activePrompts = Math.max(0, activePrompts - 1);
                  })
                )
              )
            );
          })
        ),
      ({ release }) => release
    );

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Restart episodes, durable generation boundaries, circuit state, and ordered generation teardown are one supervisor state machine.
  const supervise = Effect.gen(function* () {
    if (durableState.health === "quarantined") {
      yield* closeReadyGate("quarantined");
      yield* Deferred.succeed(initialOutcome, "unavailable");
      return;
    }
    if (durableState.health === "circuit_open") {
      yield* closeReadyGate("circuit_open");
      yield* Deferred.succeed(initialOutcome, "unavailable");
      const now = yield* Clock.currentTimeMillis;
      const elapsed =
        durableState.circuitOpenedAt === null
          ? 0
          : Math.max(0, now - durableState.circuitOpenedAt);
      const remainingCooldown = Math.max(
        0,
        durableState.circuitCooldownMillis - elapsed
      );
      yield* Effect.sleep(`${remainingCooldown} millis`);
      if (expectedShutdown) {
        return;
      }
      yield* stateGate.withPermit(rotateReadyGate());
      const halfOpenAt = yield* Clock.currentTimeMillis;
      yield* publishHealth({
        activeGeneration: null,
        consecutiveFailures: 0,
        halfOpen: true,
        health: "restarting",
        restartEpisodeStartedAt: halfOpenAt,
        timestamp: halfOpenAt,
      });
    }
    if (
      durableState.health === "starting" ||
      durableState.health === "ready" ||
      durableState.health === "restarting" ||
      durableState.health === "draining"
    ) {
      const now = yield* Clock.currentTimeMillis;
      if (durableState.activeGeneration !== null) {
        yield* options.repository
          .recordStop(
            AcpProcessStopRecord.make({
              cause: "process_exit",
              cleanupOutcome: "already_exited",
              code: null,
              expected: false,
              generation: durableState.activeGeneration,
              phase: "startup",
              signal: null,
              timestamp: now,
            })
          )
          .pipe(Effect.orDie);
      }
      yield* publishHealth({
        activeGeneration: null,
        health: "restarting",
        readySince: null,
        timestamp: now,
      });
    }

    while (!expectedShutdown) {
      const now = yield* Clock.currentTimeMillis;
      const episodeStarted = durableState.restartEpisodeStartedAt;
      const episodeExpired =
        episodeStarted !== null && now - episodeStarted > episodeMillis;
      if (episodeExpired) {
        yield* publishHealth({
          consecutiveFailures: 0,
          health: "restarting",
          restartEpisodeStartedAt: now,
          timestamp: now,
        });
      }

      const generation = yield* options.repository
        .reserveGeneration(now)
        .pipe(Effect.orDie);
      durableState = yield* options.repository.load.pipe(Effect.orDie);
      if (options.testHooks?.afterGenerationReservedBeforeSpawn !== undefined) {
        yield* options.testHooks.afterGenerationReservedBeforeSpawn(generation);
      }

      const generationScope = yield* Scope.fork(parentScope, "sequential");
      activeGenerationScope = generationScope;
      activeCleanupOutcome = "not_attempted";
      const lost = yield* Deferred.make<void>();
      const retired = yield* Deferred.make<void>();
      const available = { current: true };
      let exit: AcpGenerationExit = { code: null, signal: null };
      let cleanupOutcome: AcpProcessCleanupOutcome = "not_attempted";
      const failureClassification: {
        current: AcpGenerationFailureClassification;
      } = { current: "transient" };
      let stopCause: AcpProcessStopCause = "initialization_failed";
      let becameReady = false;
      let readyAt: number | null = null;
      let observedStopPhase: "idle" | "prompt" | "startup" | null = null;
      const observeHealth = (health: AcpConversationProcessHealth): void => {
        if (health.generation !== generation) {
          return;
        }
        if (health.status === "ready") {
          becameReady = true;
          return;
        }
        if (health.status === "closed" || health.status === "quarantined") {
          observedStopPhase ??= stopPhaseFor(becameReady, activePrompts);
          available.current = false;
          stopCause = becameReady ? "transport_lost" : stopCause;
          runPrivate(Deferred.succeed(lost, undefined).pipe(Effect.asVoid));
        }
      };
      const acquired = yield* Effect.result(
        options
          .makeGeneration({
            generation,
            observeCleanup: (outcome) => {
              cleanupOutcome = outcome;
              activeCleanupOutcome = outcome;
            },
            observeExit: (observed) => {
              exit = observed;
            },
            observeFailureClassification: (observed, cause) => {
              failureClassification.current = observed;
              stopCause = cause;
            },
            observeHealth,
          })
          .pipe(Effect.provideService(Scope.Scope, generationScope))
      );

      if (acquired._tag === "Success" && becameReady) {
        readyAt = yield* Clock.currentTimeMillis;
        yield* publishHealth({
          activeGeneration: generation,
          health: "ready",
          readySince: readyAt,
          restartEpisodeStartedAt:
            durableState.restartEpisodeStartedAt ?? readyAt,
          timestamp: readyAt,
        });
        yield* stateGate.withPermit(
          Effect.gen(function* () {
            current = {
              agent: acquired.success,
              available,
              generation,
              lost,
              retired,
            };
            yield* Deferred.succeed(readyGate, current);
          })
        );
        yield* Deferred.succeed(initialOutcome, "ready");
        yield* Deferred.await(lost);
      }

      const stoppedAt = yield* Clock.currentTimeMillis;
      yield* stateGate.withPermit(
        Effect.gen(function* () {
          available.current = false;
          if (current?.generation === generation) {
            current = undefined;
          }
          observedConversations.clear();
          yield* rotateReadyGate();
        })
      );
      yield* Deferred.succeed(retired, undefined);
      yield* publishHealth({
        activeGeneration: generation,
        health: "draining",
        readySince: null,
        timestamp: stoppedAt,
      });
      const cleanup = yield* Effect.result(
        Scope.close(generationScope, Exit.void)
      );
      if (activeGenerationScope === generationScope) {
        activeGenerationScope = undefined;
      }
      yield* options.repository
        .recordStop(
          AcpProcessStopRecord.make({
            cause: expectedShutdown ? "expected_shutdown" : stopCause,
            cleanupOutcome: cleanupOutcomeFor(
              cleanup._tag === "Failure",
              cleanupOutcome
            ),
            code: exit.code,
            expected: expectedShutdown,
            generation,
            phase:
              observedStopPhase ?? stopPhaseFor(becameReady, activePrompts),
            signal: exit.signal,
            timestamp: stoppedAt,
          })
        )
        .pipe(Effect.orDie);
      if (expectedShutdown) {
        break;
      }

      const stableReady =
        readyAt !== null && stoppedAt - readyAt >= READY_RESET_MILLIS;
      if (stableReady) {
        yield* publishHealth({
          activeGeneration: null,
          circuitCooldownMillis: initialCircuitCooldown,
          circuitOpenedAt: null,
          consecutiveFailures: 0,
          halfOpen: false,
          health: "restarting",
          restartEpisodeStartedAt: stoppedAt,
          timestamp: stoppedAt,
        });
      }
      durableState = yield* options.repository
        .recordFailure({
          cause: stopCause,
          classification: failureClassification.current,
          generation,
          timestamp: stoppedAt,
        })
        .pipe(Effect.orDie);

      if (failureClassification.current === "deterministic") {
        yield* publishHealth({
          activeGeneration: null,
          health: "quarantined",
          readySince: null,
          timestamp: stoppedAt,
        });
        yield* closeReadyGate("quarantined");
        yield* Deferred.succeed(initialOutcome, "unavailable");
        return;
      }

      const recentFailures = durableState.failures.filter(
        (failure) => stoppedAt - failure.timestamp <= failureWindowMillis
      ).length;
      const episodeFailures = durableState.consecutiveFailures;
      if (
        durableState.halfOpen ||
        recentFailures >= circuitFailureCount ||
        episodeFailures >= maxEpisodeAttempts
      ) {
        const configuredCooldown =
          options.testHooks?.circuitCooldownMillis ??
          durableState.circuitCooldownMillis;
        const cooldown = Math.min(
          MAX_CIRCUIT_COOLDOWN_MILLIS,
          durableState.halfOpen ? configuredCooldown * 2 : configuredCooldown
        );
        yield* publishHealth({
          activeGeneration: null,
          circuitCooldownMillis: cooldown,
          circuitOpenedAt: stoppedAt,
          halfOpen: false,
          health: "circuit_open",
          readySince: null,
          timestamp: stoppedAt,
        });
        yield* closeReadyGate("circuit_open");
        yield* Deferred.succeed(initialOutcome, "unavailable");
        yield* Effect.sleep(`${cooldown} millis`);
        if (expectedShutdown) {
          break;
        }
        yield* stateGate.withPermit(rotateReadyGate());
        const halfOpenAt = yield* Clock.currentTimeMillis;
        yield* publishHealth({
          activeGeneration: null,
          consecutiveFailures: 0,
          halfOpen: true,
          health: "restarting",
          restartEpisodeStartedAt: halfOpenAt,
          timestamp: halfOpenAt,
        });
        continue;
      }

      yield* publishHealth({
        activeGeneration: null,
        health: "restarting",
        restartEpisodeStartedAt:
          durableState.restartEpisodeStartedAt ?? stoppedAt,
        timestamp: stoppedAt,
      });
      const upper = Math.min(
        MAX_BACKOFF_WITH_JITTER_MILLIS,
        boundedBackoff(durableState.consecutiveFailures) + 1
      );
      const delay = Math.max(0, Math.min(upper - 1, jitter(upper)));
      yield* Effect.sleep(`${delay} millis`);
    }
  }).pipe(
    Effect.catchCause(() =>
      Effect.gen(function* () {
        if (expectedShutdown) {
          return;
        }
        const claim = yield* stateGate.withPermit(
          Effect.sync(() => {
            const retiring = current;
            if (retiring !== undefined) {
              retiring.available.current = false;
            }
            const generationScope = activeGenerationScope;
            const generation =
              retiring?.generation ?? durableState.activeGeneration;
            current = undefined;
            activeGenerationScope = undefined;
            observedConversations.clear();
            durableState = {
              ...durableState,
              activeGeneration: null,
              health: "quarantined",
              readySince: null,
            };
            return {
              generation,
              generationScope,
              readyGate,
              retiring,
            };
          })
        );
        const hasGenerationScope = claim.generationScope !== undefined;
        const cleanupResult =
          claim.generationScope === undefined
            ? null
            : yield* awaitFiberBounded(
                runPrivate(Scope.close(claim.generationScope, Exit.void)),
                supervisorDefectSettlementMillis
              );
        const cleanupFailed =
          hasGenerationScope &&
          (cleanupResult === null || Exit.isFailure(cleanupResult));
        const timestamp = yield* Clock.currentTimeMillis;
        if (claim.generation !== null) {
          const stop = AcpProcessStopRecord.make({
            cause: "unknown",
            cleanupOutcome: cleanupOutcomeFor(
              cleanupFailed,
              activeCleanupOutcome
            ),
            code: null,
            expected: false,
            generation: claim.generation,
            phase: activePrompts > 0 ? "prompt" : "startup",
            signal: null,
            timestamp,
          });
          const stopFiber = runPrivate(options.repository.recordStop(stop));
          yield* awaitFiberBounded(stopFiber, supervisorDefectSettlementMillis);
        }
        const quarantineFiber = runPrivate(
          options.repository.transition({
            activeGeneration: null,
            health: "quarantined",
            readySince: null,
            timestamp,
          })
        );
        yield* awaitFiberBounded(
          quarantineFiber,
          supervisorDefectSettlementMillis
        );
        if (claim.retiring !== undefined) {
          yield* Deferred.succeed(claim.retiring.retired, undefined);
        }
        yield* Deferred.fail(claim.readyGate, unavailable("quarantined")).pipe(
          Effect.asVoid
        );
        yield* Deferred.succeed(initialOutcome, "unavailable");
        yield* Effect.logError("ACP process supervisor stopped", {
          cause: "supervisor-defect",
        });
      })
    )
  );

  runWatcher(supervise);
  yield* Deferred.await(initialOutcome);
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      expectedShutdown = true;
      const generation = current?.generation ?? durableState.activeGeneration;
      const preserveUnavailableState =
        generation === null &&
        (durableState.health === "circuit_open" ||
          durableState.health === "quarantined");
      const timestamp = yield* Clock.currentTimeMillis;
      if (generation !== null) {
        yield* options.repository
          .transition({
            activeGeneration: generation,
            health: "draining",
            readySince: null,
            timestamp,
          })
          .pipe(Effect.ignore);
      }
      yield* FiberSet.clear(watchers);
      const generationScope = activeGenerationScope;
      const cleanup =
        generationScope === undefined
          ? Exit.succeed(undefined)
          : yield* Effect.result(Scope.close(generationScope, Exit.void));
      activeGenerationScope = undefined;
      if (generation !== null) {
        yield* options.repository
          .recordStop(
            AcpProcessStopRecord.make({
              cause: "expected_shutdown",
              cleanupOutcome: cleanupOutcomeFor(
                cleanup._tag === "Failure",
                activeCleanupOutcome
              ),
              code: null,
              expected: true,
              generation,
              phase: activePrompts > 0 ? "prompt" : "drain",
              signal: null,
              timestamp,
            })
          )
          .pipe(Effect.ignore);
      }
      current = undefined;
      if (preserveUnavailableState) {
        yield* closeReadyGate(durableState.health);
      } else {
        yield* options.repository
          .transition({
            activeGeneration: null,
            health: "stopped",
            readySince: null,
            timestamp,
          })
          .pipe(Effect.ignore);
        yield* closeReadyGate("stopped");
      }
    })
  );

  const agent: ConversationAgentShape = {
    handle: (request, publish) => runAgent("handle", request, publish),
    recover: (request, publish) => runAgent("recover", request, publish),
  };
  return {
    agent,
    health: stateGate.withPermit(
      Effect.sync(() => ({
        activePrompts,
        activeSessions: observedConversations.size,
        circuitCooldownMillis: durableState.circuitCooldownMillis,
        circuitOpenedAt: durableState.circuitOpenedAt,
        generation: durableState.activeGeneration,
        health: durableState.health,
        lastStop: durableState.lastStop,
        queuedConversations: queuedConversationCounts.size,
        readySince: durableState.readySince,
        restartEpisodeStartedAt: durableState.restartEpisodeStartedAt,
        workspaceId: options.workspaceId,
      }))
    ),
  };
});
