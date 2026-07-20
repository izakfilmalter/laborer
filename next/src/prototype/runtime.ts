/**
 * THROWAWAY ISSUE #204 PROTOTYPE.
 * Store-driven per-thread FIFO worker and narrow Effect service contracts.
 */
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
  type ClaimedTurn,
  canonicalThreadId,
  type InboundDecision,
  NormalizedInboundEvent as NormalizedInboundEventSchema,
  type PublicReplyProtocolRecord,
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
  type ActivationContextRequest,
  makeInMemoryStoreLayer,
  PrototypeStore,
  type PrototypeStoreShape,
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

export interface Runner {
  readonly abandonBlocked: (
    threadId: ThreadId
  ) => Effect.Effect<void, RunnerError>;
  readonly drain: (threadId: ThreadId) => Effect.Effect<void, RunnerError>;
  readonly inject: (
    event: unknown
  ) => Effect.Effect<InboundDecision, RunnerError | BoundaryDecodeError>;
  readonly retryBlocked: (
    threadId: ThreadId
  ) => Effect.Effect<void, RunnerError>;
}

export class PrototypeRunner extends Context.Service<PrototypeRunner, Runner>()(
  "@laborer/issue-204/PrototypeRunner"
) {}

interface ThreadSemaphore {
  readonly semaphore: Semaphore.Semaphore;
  readonly threadId: ThreadId;
}

const CONTEXT_RETRY_MILLIS = 10;

const deliveryCompletionState = (deliveredAny: boolean): "Drained" | "None" =>
  deliveredAny ? "Drained" : "None";

const runnerLayer = Layer.effect(
  PrototypeRunner,
  Effect.gen(function* () {
    const store = yield* PrototypeStore;
    const slack = yield* SlackGateway;
    const handler = yield* WorkHandler;
    const threadSemaphores = yield* Ref.make<readonly ThreadSemaphore[]>([]);

    const getThreadSemaphore = (threadId: ThreadId) =>
      Ref.modify(threadSemaphores, (entries) =>
        pipe(
          entries,
          EffectArray.findFirst((entry) => entry.threadId === threadId),
          Option.match({
            onNone: () => {
              const semaphore = Semaphore.makeUnsafe(1);
              return [
                semaphore,
                EffectArray.append(entries, { threadId, semaphore }),
              ] as const;
            },
            onSome: (entry) => [entry.semaphore, entries] as const,
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
        return;
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

    const executeClaimedTurn = Effect.fnUntraced(function* (turn: ClaimedTurn) {
      const persistReply = (record: PublicReplyProtocolRecord) =>
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
      const result = yield* Effect.result(handler.invoke(turn, persistReply));
      if (result._tag === "Success") {
        yield* store.completeHandler(turn.threadId, turn.id, {
          _tag: "Success",
        });
        return;
      }
      if (result.failure instanceof StoreError) {
        return yield* result.failure;
      }
      yield* store.completeHandler(turn.threadId, turn.id, {
        _tag: "Failure",
        category: result.failure.category,
        safeDetail: result.failure.safeDetail,
      });
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
          yield* executeClaimedTurn(turn);
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
      const semaphore = yield* getThreadSemaphore(threadId);
      yield* semaphore.withPermit(driveThread(threadId));
    });

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
      const candidateThreadId = canonicalThreadId(
        event.channelId,
        event.threadTs ?? event.messageTs
      );
      const threadIds = yield* store.threadIds;
      if (EffectArray.contains(threadIds, candidateThreadId)) {
        yield* serializedDrive(candidateThreadId);
      }
      return decision;
    });

    const runner = PrototypeRunner.of({
      inject,
      drain: serializedDrive,
      retryBlocked: (threadId) =>
        store
          .retryBlocked(threadId)
          .pipe(Effect.andThen(serializedDrive(threadId))),
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
  readonly handler: WorkHandlerShape;
  readonly laborerSlackId: string;
  readonly slack: SlackGatewayShape;
  readonly storeLayer?: Layer.Layer<PrototypeStore, StoreError>;
}): Effect.Effect<
  PrototypeHarness,
  StoreError,
  import("effect").Scope.Scope
> => {
  const storeLayer =
    options.storeLayer ?? makeInMemoryStoreLayer(options.laborerSlackId);
  const dependencies = Layer.mergeAll(
    storeLayer,
    SlackGateway.layer(options.slack),
    WorkHandler.layer(options.handler)
  );
  const applicationLayer = runnerLayer.pipe(Layer.provideMerge(dependencies));
  return Effect.gen(function* () {
    const services = yield* Effect.all({
      runner: PrototypeRunner,
      store: PrototypeStore,
    }).pipe(Effect.provide(applicationLayer));
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
