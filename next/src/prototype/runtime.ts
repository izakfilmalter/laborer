/**
 * THROWAWAY ISSUE #204 PROTOTYPE.
 * Store-driven per-thread FIFO worker and narrow Effect service contracts.
 */
import { isAbsolute } from "node:path";
import {
  Clock,
  Context,
  Effect,
  Array as EffectArray,
  Layer,
  Option,
  pipe,
  Ref,
  Schema,
  Semaphore,
} from "effect";
import {
  type AcknowledgementState,
  type ClaimedTurn,
  canonicalThreadId,
  type InboundDecision,
  NormalizedInboundEvent as NormalizedInboundEventSchema,
  type PublicReplyProtocolRecord,
  stableAcknowledgementId,
  type ThreadId,
} from "./domain.ts";
import {
  BoundaryDecodeError,
  type ContextReadError,
  type DeliveryError,
  HandlerFailure,
  type ReplyProtocolError,
  type RunnerError,
  StoreError,
} from "./errors.ts";
import {
  assertNoSymlinkPathComponents,
  canonicalDirectory,
} from "./path-safety.ts";
import {
  type ActivationContextRequest,
  makeInMemoryStoreLayer,
  PrototypeStore,
  type PrototypeStoreShape,
  type StorePersistenceHealth,
} from "./store.ts";

export interface SlackGatewayShape {
  readonly postThreadMessage: (request: {
    readonly channelId: string;
    readonly rootTs: string;
    readonly text: string;
  }) => Effect.Effect<{ readonly ts: string }, DeliveryError>;
  readonly readActivationContext: (
    request: ActivationContextRequest
  ) => Effect.Effect<
    readonly import("./domain.ts").NormalizedMessage[],
    ContextReadError
  >;
}

export class SlackGateway extends Context.Service<
  SlackGateway,
  SlackGatewayShape
>()("@laborer/issue-204/SlackGateway") {
  static layer = (gateway: SlackGatewayShape): Layer.Layer<SlackGateway> =>
    Layer.succeed(SlackGateway, gateway);
}

export interface ActivationAcknowledgerShape {
  readonly acknowledge: (request: {
    readonly channelId: string;
    readonly messageTs: string;
  }) => Effect.Effect<void, DeliveryError>;
  readonly complete: (request: {
    readonly channelId: string;
    readonly messageTs: string;
  }) => Effect.Effect<void, DeliveryError>;
}

export class ActivationAcknowledger extends Context.Service<
  ActivationAcknowledger,
  ActivationAcknowledgerShape
>()("@laborer/issue-207/ActivationAcknowledger") {
  static layer = (
    acknowledger: ActivationAcknowledgerShape
  ): Layer.Layer<ActivationAcknowledger> =>
    Layer.succeed(ActivationAcknowledger, acknowledger);
}

const noOpActivationAcknowledger: ActivationAcknowledgerShape = {
  acknowledge: () => Effect.void,
  complete: () => Effect.void,
};

export interface WorkHandlerShape {
  readonly invoke: (
    turn: ClaimedTurn,
    acceptReply: (
      record: PublicReplyProtocolRecord
    ) => Effect.Effect<void, HandlerFailure | StoreError>
  ) => Effect.Effect<void, HandlerFailure | StoreError>;
}

export class WorkHandler extends Context.Service<
  WorkHandler,
  WorkHandlerShape
>()("@laborer/issue-204/WorkHandler") {
  static layer = (handler: WorkHandlerShape): Layer.Layer<WorkHandler> =>
    Layer.succeed(WorkHandler, handler);
}

export interface ThreadInitializerShape {
  readonly initialize: (
    turn: ClaimedTurn,
    acceptReply: (
      record: PublicReplyProtocolRecord
    ) => Effect.Effect<void, HandlerFailure | StoreError>
  ) => Effect.Effect<string, HandlerFailure | StoreError>;
}

export class ThreadInitializer extends Context.Service<
  ThreadInitializer,
  ThreadInitializerShape
>()("@laborer/prototype/ThreadInitializer") {
  static layer = (
    initializer: ThreadInitializerShape
  ): Layer.Layer<ThreadInitializer> =>
    Layer.succeed(ThreadInitializer, initializer);
}

const unusedThreadInitializer: ThreadInitializerShape = {
  initialize: () =>
    HandlerFailure.make({
      category: "protocol",
      safeDetail: "thread initializer unavailable",
    }),
};

const validateInitializedWorkingDirectory = (
  candidate: string
): Effect.Effect<string, HandlerFailure> =>
  Effect.tryPromise({
    try: async () => {
      if (!isAbsolute(candidate)) {
        throw new Error("working directory is not absolute");
      }
      await assertNoSymlinkPathComponents(
        candidate,
        "validate-initialized-working-directory"
      );
      const canonical = await canonicalDirectory(
        candidate,
        "validate-initialized-working-directory"
      );
      if (canonical !== candidate) {
        throw new Error("working directory is not canonical");
      }
      return canonical;
    },
    catch: () =>
      HandlerFailure.make({
        category: "protocol",
        safeDetail: "initializer returned an invalid working directory",
      }),
  });

export interface Runner {
  readonly abandonBlocked: (
    threadId: ThreadId
  ) => Effect.Effect<void, RunnerError>;
  readonly drain: (threadId: ThreadId) => Effect.Effect<void, RunnerError>;
  readonly inject: (
    event: unknown
  ) => Effect.Effect<InboundDecision, RunnerError | BoundaryDecodeError>;
  readonly lockCounts: Effect.Effect<{
    readonly acknowledgements: number;
    readonly threads: number;
  }>;
  readonly persistenceHealth: Effect.Effect<StorePersistenceHealth>;
  readonly retryBlocked: (
    threadId: ThreadId
  ) => Effect.Effect<void, RunnerError>;
  readonly retryInterrupted: (
    threadId: ThreadId
  ) => Effect.Effect<void, RunnerError>;
}

export class PrototypeRunner extends Context.Service<PrototypeRunner, Runner>()(
  "@laborer/issue-204/PrototypeRunner"
) {}

interface ThreadSemaphore {
  readonly semaphore: Semaphore.Semaphore;
  readonly threadId: ThreadId;
  readonly users: number;
}

interface AcknowledgementSemaphore {
  readonly acknowledgementId: string;
  readonly semaphore: Semaphore.Semaphore;
  readonly users: number;
}

const CONTEXT_RETRY_MILLIS = 10;

const acknowledgementRetryAt = (
  error: DeliveryError,
  failedAt: number
): number | null =>
  error.disposition === "transient"
    ? failedAt + Math.max(1, error.retryAfterMillis)
    : null;

const deliveryCompletionState = (deliveredAny: boolean): "Drained" | "None" =>
  deliveredAny ? "Drained" : "None";

const runnerLayer = Layer.effect(
  PrototypeRunner,
  Effect.gen(function* () {
    const store = yield* PrototypeStore;
    const slack = yield* SlackGateway;
    const handler = yield* WorkHandler;
    const initializer = yield* ThreadInitializer;
    const activationAcknowledger = yield* ActivationAcknowledger;
    const threadSemaphores = yield* Ref.make<readonly ThreadSemaphore[]>([]);
    const acknowledgementSemaphores = yield* Ref.make<
      readonly AcknowledgementSemaphore[]
    >([]);
    const acknowledgementDriverScope = yield* Effect.scope;

    const retainAcknowledgementSemaphore = (acknowledgementId: string) =>
      Ref.modify(acknowledgementSemaphores, (entries) =>
        pipe(
          entries,
          EffectArray.findFirst(
            (entry) => entry.acknowledgementId === acknowledgementId
          ),
          Option.match({
            onNone: () => {
              const semaphore = Semaphore.makeUnsafe(1);
              return [
                semaphore,
                EffectArray.append(entries, {
                  acknowledgementId,
                  semaphore,
                  users: 1,
                }),
              ] as const;
            },
            onSome: (entry) =>
              [
                entry.semaphore,
                pipe(
                  entries,
                  EffectArray.map((candidate) =>
                    candidate.acknowledgementId === acknowledgementId
                      ? { ...candidate, users: candidate.users + 1 }
                      : candidate
                  )
                ),
              ] as const,
          })
        )
      );

    const releaseAcknowledgementSemaphore = (acknowledgementId: string) =>
      Ref.update(acknowledgementSemaphores, (entries) =>
        pipe(
          entries,
          EffectArray.flatMap((entry) => {
            if (entry.acknowledgementId !== acknowledgementId) {
              return [entry];
            }
            return entry.users === 1
              ? []
              : [{ ...entry, users: entry.users - 1 }];
          })
        )
      );

    const withAcknowledgementPermit = <A, E, R>(
      id: string,
      effect: Effect.Effect<A, E, R>
    ): Effect.Effect<A, E, R> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const semaphore = yield* retainAcknowledgementSemaphore(id);
          return yield* restore(semaphore.withPermit(effect)).pipe(
            Effect.ensuring(releaseAcknowledgementSemaphore(id))
          );
        })
      );

    const performAcknowledgementRequest = Effect.fnUntraced(function* (
      acknowledgement: AcknowledgementState,
      operation: "add" | "remove"
    ) {
      const now = yield* Clock.currentTimeMillis;
      const delayMillis = Math.max(
        0,
        (acknowledgement.retryAtMillis ?? now) - now
      );
      if (delayMillis > 0) {
        yield* Effect.sleep(`${delayMillis} millis`);
      }
      const request = {
        channelId: acknowledgement.channelId,
        messageTs: acknowledgement.messageTs,
      };
      return yield* Effect.result(
        operation === "add"
          ? activationAcknowledger.acknowledge(request)
          : activationAcknowledger.complete(request)
      );
    });

    const completeAcknowledgementRequest = Effect.fnUntraced(function* (
      acknowledgement: AcknowledgementState,
      operation: "add" | "remove"
    ) {
      if (operation === "remove") {
        yield* store.completeAcknowledgement(acknowledgement.id);
        return "Done" as const;
      }
      yield* store.markAcknowledgementActive(acknowledgement.id);
      return acknowledgement.cleanupRequested
        ? ("Continue" as const)
        : ("Active" as const);
    });

    const driveAcknowledgementStep = Effect.fnUntraced(function* (id: string) {
      const acknowledgement = pipe(
        yield* store.acknowledgements,
        EffectArray.findFirst((candidate) => candidate.id === id),
        Option.getOrNull
      );
      if (
        acknowledgement === null ||
        acknowledgement.status === "permanent_failure" ||
        (acknowledgement.status === "active" &&
          !acknowledgement.cleanupRequested)
      ) {
        return acknowledgement?.status === "active"
          ? ("Active" as const)
          : ("Done" as const);
      }
      if (acknowledgement.status === "active") {
        yield* store.markAcknowledgementCleanupPending(id);
        return "Continue" as const;
      }

      const operation =
        acknowledgement.status === "add_pending" ? "add" : "remove";
      const result = yield* performAcknowledgementRequest(
        acknowledgement,
        operation
      );
      if (result._tag === "Success") {
        return yield* completeAcknowledgementRequest(
          acknowledgement,
          operation
        );
      }

      const error = result.failure;
      const failedAt = yield* Clock.currentTimeMillis;
      yield* store.markAcknowledgementFailure(
        id,
        error.category,
        error.disposition,
        acknowledgementRetryAt(error, failedAt)
      );
      if (error.disposition === "transient") {
        return "Retry" as const;
      }
      yield* Effect.logError("Slack activation reaction failed permanently", {
        category: error.category,
        operation,
      });
      return "Done" as const;
    });

    const driveAcknowledgement = Effect.fnUntraced(function* (id: string) {
      yield* withAcknowledgementPermit(
        id,
        Effect.gen(function* () {
          let next: "Active" | "Continue" | "Done" | "Retry" = "Continue";
          while (next === "Continue" || next === "Retry") {
            next = yield* driveAcknowledgementStep(id);
          }
        })
      );
    });

    const superviseAcknowledgementDriver = Effect.fnUntraced(function* (
      id: string
    ) {
      while (true) {
        const result = yield* Effect.result(driveAcknowledgement(id));
        if (result._tag === "Success") {
          return;
        }
        yield* Effect.logError(
          "Activation acknowledgement driver retrying after local failure",
          result.failure
        );
        yield* Effect.sleep("1 second");
      }
    });

    const startAcknowledgementDriver = (id: string) =>
      superviseAcknowledgementDriver(id).pipe(
        Effect.forkIn(acknowledgementDriverScope, { startImmediately: true }),
        Effect.asVoid
      );

    const requestAcknowledgementCleanup = Effect.fnUntraced(function* (
      id: string
    ) {
      yield* store.requestAcknowledgementCleanup(id);
      yield* startAcknowledgementDriver(id);
    });

    const retainThreadSemaphore = (threadId: ThreadId) =>
      Ref.modify(threadSemaphores, (entries) =>
        pipe(
          entries,
          EffectArray.findFirst((entry) => entry.threadId === threadId),
          Option.match({
            onNone: () => {
              const semaphore = Semaphore.makeUnsafe(1);
              return [
                semaphore,
                EffectArray.append(entries, { semaphore, threadId, users: 1 }),
              ] as const;
            },
            onSome: (entry) =>
              [
                entry.semaphore,
                pipe(
                  entries,
                  EffectArray.map((candidate) =>
                    candidate.threadId === threadId
                      ? { ...candidate, users: candidate.users + 1 }
                      : candidate
                  )
                ),
              ] as const,
          })
        )
      );

    const releaseThreadSemaphore = (threadId: ThreadId) =>
      Ref.update(threadSemaphores, (entries) =>
        pipe(
          entries,
          EffectArray.flatMap((entry) => {
            if (entry.threadId !== threadId) {
              return [entry];
            }
            return entry.users === 1
              ? []
              : [{ ...entry, users: entry.users - 1 }];
          })
        )
      );

    const acquireContext = Effect.fnUntraced(function* (
      request: ActivationContextRequest
    ) {
      const beforeRead = yield* Clock.currentTimeMillis;
      if (
        request.retryAtMillis !== null &&
        request.retryAtMillis > beforeRead
      ) {
        yield* Effect.sleep(`${request.retryAtMillis - beforeRead} millis`);
      }
      const result = yield* Effect.result(slack.readActivationContext(request));
      if (result._tag === "Success") {
        yield* store.completeContext(request.threadId, result.success, false);
        return "Completed" as const;
      }
      const error = result.failure;
      if (!error.isTransient) {
        yield* store.completeContext(request.threadId, error.partial, true);
        return;
      }
      const now = yield* Clock.currentTimeMillis;
      yield* store.markContextAttemptFailed(
        request.threadId,
        now + CONTEXT_RETRY_MILLIS
      );
    });

    const recordDeliveryFailure = Effect.fnUntraced(function* (
      threadId: ThreadId,
      itemId: string,
      error: DeliveryError
    ) {
      const failedAt = yield* Clock.currentTimeMillis;
      yield* store.markDeliveryFailed(
        threadId,
        itemId,
        error.category,
        error.disposition,
        error.disposition === "transient"
          ? failedAt + Math.max(1, error.retryAfterMillis)
          : null
      );
      return error.disposition === "destination-permanent"
        ? ("Blocked" as const)
        : ("Continue" as const);
    });

    const deliverHead = Effect.fnUntraced(function* (threadId: ThreadId) {
      let deliveredAny = false;
      while (true) {
        const now = yield* Clock.currentTimeMillis;
        const claim = yield* store.claimOutboundHead(threadId, now);
        if (claim._tag === "None") {
          return deliveryCompletionState(deliveredAny);
        }
        if (claim._tag === "Blocked") {
          return claim._tag;
        }
        if (claim._tag === "Waiting") {
          yield* Effect.sleep(
            `${Math.max(1, claim.wakeAtMillis - now)} millis`
          );
          continue;
        }
        const result = yield* Effect.result(
          slack.postThreadMessage({
            channelId: claim.channelId,
            rootTs: claim.rootTs,
            text: claim.text,
          })
        );
        if (result._tag === "Success") {
          yield* store.markDelivered(threadId, claim.itemId, result.success.ts);
          deliveredAny = true;
          continue;
        }
        const error = result.failure;
        const next = yield* recordDeliveryFailure(
          threadId,
          claim.itemId,
          error
        );
        if (next === "Blocked") {
          return "Blocked" as const;
        }
      }
    });

    const persistReplyFor =
      (turn: ClaimedTurn) => (record: PublicReplyProtocolRecord) =>
        store
          .acceptPublicReply(
            turn.threadId,
            turn.id,
            record.replyId,
            record.text
          )
          .pipe(
            Effect.catchTag(
              "ReplyProtocolError",
              (_error: ReplyProtocolError) =>
                HandlerFailure.make({
                  category: "protocol",
                  safeDetail: "conflicting or invalid public reply",
                })
            )
          );

    const initializeClaimedTurn = Effect.fnUntraced(function* (
      turn: ClaimedTurn,
      persistReply: ReturnType<typeof persistReplyFor>
    ) {
      if (turn.initializationStatus !== "pending") {
        return {
          _tag: "Ready" as const,
          workingDirectory: turn.workingDirectory,
        };
      }
      const initialization = yield* Effect.result(
        initializer
          .initialize(turn, persistReply)
          .pipe(Effect.flatMap(validateInitializedWorkingDirectory))
      );
      if (initialization._tag === "Success") {
        yield* store.completeInitialization(
          turn.threadId,
          initialization.success
        );
        return {
          _tag: "Ready" as const,
          workingDirectory: initialization.success,
        };
      }
      if (initialization.failure instanceof StoreError) {
        return yield* initialization.failure;
      }
      if (
        initialization.failure.category === "signal" ||
        initialization.failure.category === "timeout"
      ) {
        return { _tag: "Replayable" as const };
      }
      yield* store.completeHandler(turn.threadId, turn.id, {
        _tag: "Failure",
        category: initialization.failure.category,
        safeDetail: initialization.failure.safeDetail,
      });
      return { _tag: "Completed" as const };
    });

    const executeClaimedTurn = Effect.fnUntraced(function* (turn: ClaimedTurn) {
      const persistReply = persistReplyFor(turn);
      const initialization = yield* initializeClaimedTurn(turn, persistReply);
      if (initialization._tag !== "Ready") {
        return initialization._tag;
      }
      const result = yield* Effect.result(
        handler.invoke(
          { ...turn, workingDirectory: initialization.workingDirectory },
          persistReply
        )
      );
      if (result._tag === "Success") {
        yield* store.completeHandler(turn.threadId, turn.id, {
          _tag: "Success",
        });
        return;
      }
      if (result.failure instanceof StoreError) {
        return yield* result.failure;
      }
      if (
        result.failure.category === "signal" ||
        result.failure.category === "timeout"
      ) {
        // The durable running attempt is intentionally left open. A later
        // Runner retry marks it interrupted and re-enters the same handler turn.
        return "Replayable" as const;
      }
      yield* store.completeHandler(turn.threadId, turn.id, {
        _tag: "Failure",
        category: result.failure.category,
        safeDetail: result.failure.safeDetail,
      });
      return "Completed" as const;
    });

    const driveThread = Effect.fnUntraced(function* (threadId: ThreadId) {
      let contextRequest = yield* store.contextRequest(threadId);
      while (contextRequest !== null) {
        yield* acquireContext(contextRequest);
        contextRequest = yield* store.contextRequest(threadId);
      }

      while (true) {
        const turn = yield* store.claimNextTurn(threadId);
        if (turn !== null) {
          const completion = yield* executeClaimedTurn(turn);
          if (completion === "Replayable") {
            return;
          }
          continue;
        }
        const deliveryState = yield* deliverHead(threadId);
        if (deliveryState === "Blocked") {
          return;
        }
        if (deliveryState === "None") {
          return;
        }
      }
    });

    const serializedDrive = Effect.fnUntraced(function* (threadId: ThreadId) {
      yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const semaphore = yield* retainThreadSemaphore(threadId);
          return yield* restore(
            semaphore.withPermit(driveThread(threadId))
          ).pipe(Effect.ensuring(releaseThreadSemaphore(threadId)));
        })
      );
    });

    const staleAcknowledgements = yield* store.acknowledgements;
    yield* Effect.forEach(
      staleAcknowledgements,
      (acknowledgement) =>
        acknowledgement.status === "permanent_failure"
          ? Effect.void
          : requestAcknowledgementCleanup(acknowledgement.id),
      { discard: true }
    );

    const inject = Effect.fn("PrototypeRunner.inject")(function* (
      input: unknown
    ) {
      const event = yield* Schema.decodeUnknownEffect(
        NormalizedInboundEventSchema
      )(input).pipe(
        Effect.mapError(() =>
          BoundaryDecodeError.make({
            boundary: "normalized-inbound-event",
            message: "invalid normalized event",
          })
        )
      );
      const decision = yield* store.accept(event);
      const isAcceptedActivation =
        decision._tag === "Accepted" && decision.isActivation;
      const acknowledgementId = stableAcknowledgementId(
        event.channelId,
        event.messageTs
      );
      const candidateThreadId = canonicalThreadId(
        event.channelId,
        event.threadTs ?? event.messageTs
      );
      const threadIds = yield* store.threadIds;
      const drive = EffectArray.contains(threadIds, candidateThreadId)
        ? serializedDrive(candidateThreadId)
        : Effect.void;
      yield* isAcceptedActivation
        ? startAcknowledgementDriver(acknowledgementId).pipe(
            Effect.andThen(drive),
            Effect.ensuring(
              Effect.result(
                requestAcknowledgementCleanup(acknowledgementId)
              ).pipe(
                Effect.flatMap((result) =>
                  result._tag === "Failure"
                    ? Effect.logError(
                        "Could not schedule activation acknowledgement cleanup",
                        result.failure
                      )
                    : Effect.void
                )
              )
            )
          )
        : drive;
      return decision;
    });

    const runner = PrototypeRunner.of({
      inject,
      lockCounts: Effect.all({
        acknowledgements: Ref.get(acknowledgementSemaphores).pipe(
          Effect.map((entries) => entries.length)
        ),
        threads: Ref.get(threadSemaphores).pipe(
          Effect.map((entries) => entries.length)
        ),
      }),
      persistenceHealth: store.persistenceHealth,
      drain: serializedDrive,
      retryBlocked: (threadId) =>
        store
          .retryBlocked(threadId)
          .pipe(Effect.andThen(serializedDrive(threadId))),
      retryInterrupted: serializedDrive,
      abandonBlocked: (threadId) =>
        store
          .abandonBlocked(threadId)
          .pipe(Effect.andThen(serializedDrive(threadId))),
    });
    return runner;
  })
);

export interface PrototypeHarness {
  readonly runner: Runner;
  readonly store: PrototypeStoreShape;
}

export const makePrototypeHarness = (options: {
  readonly activationAcknowledger?: ActivationAcknowledgerShape;
  readonly handler: WorkHandlerShape;
  readonly initializer?: ThreadInitializerShape;
  readonly laborerSlackId: string;
  readonly slack: SlackGatewayShape;
  readonly storeLayer?: Layer.Layer<PrototypeStore, StoreError>;
}): Effect.Effect<
  PrototypeHarness,
  StoreError,
  import("effect").Scope.Scope
> => {
  const storeLayer =
    options.storeLayer ??
    makeInMemoryStoreLayer(options.laborerSlackId, {
      initializeNewThreads: options.initializer !== undefined,
    });
  const dependencies = Layer.mergeAll(
    storeLayer,
    ActivationAcknowledger.layer(
      options.activationAcknowledger ?? noOpActivationAcknowledger
    ),
    SlackGateway.layer(options.slack),
    ThreadInitializer.layer(options.initializer ?? unusedThreadInitializer),
    WorkHandler.layer(options.handler)
  );
  const applicationLayer: Layer.Layer<
    PrototypeRunner | PrototypeStore,
    StoreError
  > = runnerLayer.pipe(Layer.provideMerge(dependencies));
  return Effect.gen(function* () {
    const context = yield* Layer.build(applicationLayer);
    const services = yield* Effect.all({
      runner: PrototypeRunner,
      store: PrototypeStore,
    }).pipe(Effect.provide(context));
    const persistedThreadIds = yield* services.store.threadIds;
    yield* Effect.forEach(
      persistedThreadIds,
      (threadId) =>
        Effect.result(services.runner.drain(threadId)).pipe(
          Effect.flatMap((result) =>
            result._tag === "Failure"
              ? Effect.logError(
                  "Automatic thread recovery stopped",
                  result.failure
                )
              : Effect.void
          ),
          Effect.forkScoped({ startImmediately: true })
        ),
      { discard: true }
    );
    return services;
  });
};
