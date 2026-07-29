/**
 * THROWAWAY ISSUE #204 PROTOTYPE.
 * Store-driven per-thread FIFO worker and narrow Effect service contracts.
 */
import {
  Clock,
  Context,
  Deferred,
  Effect,
  Array as EffectArray,
  Exit,
  Layer,
  Option,
  pipe,
  Ref,
  Schema,
  Semaphore,
} from "effect";
import {
  type AcceptApplicationEvent,
  Application,
  type ApplicationEventAcceptance,
  type ApplicationPublicOutput,
  type ApplicationShape,
  applicationFromConfiguredProcessHandler,
  ConversationBlocked,
  type ConversationRecoveryDecisionRejected,
  type ConversationRecoveryDecisionRequest,
  type ConversationRecoveryDecisionResult,
  type ExternalInputEvent,
  ParticipantInputEvent,
  toPublicReplyProtocolRecord,
} from "../application.ts";
import type { ResolveSlackInboundImages } from "../slack/normalize.ts";
import {
  type ConversationStreamDeliveryPolicy,
  makeConversationStreamDelivery,
} from "./conversation-stream-delivery.ts";
import {
  type AcknowledgementState,
  type ClaimedTurn,
  type CompletionReactionState,
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
  type ActivationContextRequest,
  makeInMemoryStoreLayer,
  PrototypeStore,
  type PrototypeStoreShape,
  type StorePersistenceHealth,
} from "./store.ts";

export interface SlackNativeStreamCapability {
  readonly append: (request: {
    readonly channelId: string;
    readonly streamTs: string;
    readonly text: string;
  }) => Effect.Effect<void, DeliveryError>;
  readonly start: (request: {
    readonly channelId: string;
    readonly recipientUserId: string;
    readonly rootTs: string;
    readonly text: string;
  }) => Effect.Effect<{ readonly ts: string }, DeliveryError>;
  readonly stop: (request: {
    readonly channelId: string;
    readonly streamTs: string;
  }) => Effect.Effect<void, DeliveryError>;
}

export interface SlackGatewayShape {
  readonly conversationStreamDeliveryPolicy?: ConversationStreamDeliveryPolicy;
  readonly nativeStreaming?: SlackNativeStreamCapability;
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
  readonly resolveInboundImages?: ResolveSlackInboundImages;
  readonly updateThreadMessage?: (request: {
    readonly channelId: string;
    readonly messageTs: string;
    readonly text: string;
  }) => Effect.Effect<void, DeliveryError>;
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

export interface CompletionReactorShape {
  readonly react: (request: {
    readonly channelId: string;
    readonly rootTs: string;
  }) => Effect.Effect<void, DeliveryError>;
}

export class CompletionReactor extends Context.Service<
  CompletionReactor,
  CompletionReactorShape
>()("@laborer/prototype/CompletionReactor") {
  static layer = (
    reactor: CompletionReactorShape
  ): Layer.Layer<CompletionReactor> =>
    Layer.succeed(CompletionReactor, reactor);
}

const noOpCompletionReactor: CompletionReactorShape = {
  react: () => Effect.void,
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

export interface Runner {
  readonly abandonBlocked: (
    threadId: ThreadId
  ) => Effect.Effect<void, RunnerError>;
  readonly accept: (
    event: unknown
  ) => Effect.Effect<DurableAcceptance, RunnerError | BoundaryDecodeError>;
  readonly acceptApplicationEvent: (
    event: ExternalInputEvent
  ) => Effect.Effect<ApplicationEventAcceptance, RunnerError>;
  readonly decideConversationRecovery?: (
    request: ConversationRecoveryDecisionRequest
  ) => Effect.Effect<
    ConversationRecoveryDecisionResult,
    ConversationRecoveryDecisionRejected | RunnerError
  >;
  readonly drain: (threadId: ThreadId) => Effect.Effect<void, RunnerError>;
  readonly inject: (
    event: unknown
  ) => Effect.Effect<InboundDecision, RunnerError | BoundaryDecodeError>;
  readonly listConversationBlocks?: Effect.Effect<
    readonly ConversationBlocked[],
    RunnerError
  >;
  readonly lockCounts: Effect.Effect<{
    readonly acknowledgements: number;
    readonly drivers: number;
    readonly threads: number;
  }>;
  readonly persistenceHealth: Effect.Effect<StorePersistenceHealth>;
  /**
   * Atomically closes generation-bound scheduling admission and waits for all
   * drivers admitted before closure. Durable acceptance remains available.
   */
  readonly quiesce: Effect.Effect<void, RunnerError>;
  readonly retryBlocked: (
    threadId: ThreadId
  ) => Effect.Effect<void, RunnerError>;
  readonly retryInterrupted: (
    threadId: ThreadId
  ) => Effect.Effect<void, RunnerError>;
}

export interface DurableAcceptance {
  readonly decision: InboundDecision;
  readonly scheduling: "AlreadyDurable" | "Deferred" | "Scheduled";
}

export class PrototypeRunner extends Context.Service<PrototypeRunner, Runner>()(
  "@laborer/issue-204/PrototypeRunner"
) {}

interface ThreadSemaphore {
  readonly semaphore: Semaphore.Semaphore;
  readonly threadId: ThreadId;
  readonly users: number;
}

interface ActiveThreadDriver {
  readonly acknowledgementIds: readonly string[];
  readonly driverId: number;
  readonly signals: number;
  readonly threadId: ThreadId;
}

interface ThreadDriverRegistry {
  readonly active: readonly ActiveThreadDriver[];
  readonly admissionOpen: boolean;
  readonly directDrivers: number;
  readonly nextDriverId: number;
}

type ThreadDriverCompletion =
  | { readonly _tag: "Continue" }
  | { readonly _tag: "Stop"; readonly acknowledgementIds: readonly string[] };

type ThreadDriverRegistration =
  | { readonly _tag: "Deferred" }
  | { readonly _tag: "Signaled" }
  | { readonly _tag: "Started"; readonly driverId: number };

interface AcceptedInbound {
  readonly acknowledgementId: string;
  readonly decision: InboundDecision;
  readonly isAcceptedActivation: boolean;
  readonly threadId: ThreadId | null;
}

interface AcknowledgementSemaphore {
  readonly acknowledgementId: string;
  readonly semaphore: Semaphore.Semaphore;
  readonly users: number;
}

const CONTEXT_RETRY_MILLIS = 10;

const reactionRetryAt = (
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
    const application = yield* Application;
    const activationAcknowledger = yield* ActivationAcknowledger;
    const completionReactor = yield* CompletionReactor;
    const postThreadMessage = Effect.fnUntraced(function* (
      request: {
        readonly channelId: string;
        readonly rootTs: string;
        readonly text: string;
      },
      workspaceId: string
    ) {
      const spacingMillis =
        slack.conversationStreamDeliveryPolicy?.spacingMillis[
          "fallback-post"
        ] ?? 0;
      const now = yield* Clock.currentTimeMillis;
      const slot = yield* store.reserveSlackRateSlot({
        channelId: request.channelId,
        channelSpacingMillis: spacingMillis,
        method: "chat.postMessage",
        methodSpacingMillis: spacingMillis,
        nowMillis: now,
        workspaceId,
      });
      const beforeRequest = yield* Clock.currentTimeMillis;
      if (slot > beforeRequest) {
        yield* Effect.sleep(`${slot - beforeRequest} millis`);
      }
      const result = yield* Effect.result(slack.postThreadMessage(request));
      if (result._tag === "Success") {
        return result.success;
      }
      const error = result.failure;
      if (error.disposition === "transient" && error.retryAfterMillis > 0) {
        const failedAt = yield* Clock.currentTimeMillis;
        yield* store.deferSlackRateBudget({
          method: "chat.postMessage",
          retryAtMillis: failedAt + error.retryAfterMillis,
          workspaceId,
        });
      }
      return yield* error;
    });
    const threadSemaphores = yield* Ref.make<readonly ThreadSemaphore[]>([]);
    const threadDrivers = yield* Ref.make<ThreadDriverRegistry>({
      active: [],
      admissionOpen: true,
      directDrivers: 0,
      nextDriverId: 0,
    });
    const quiesced = yield* Deferred.make<void>();
    const startupRecoveryBarrierOpen = yield* Ref.make(false);
    const acknowledgementSemaphores = yield* Ref.make<
      readonly AcknowledgementSemaphore[]
    >([]);
    const reactionDriverScope = yield* Effect.scope;
    const conversationStreamDelivery = yield* makeConversationStreamDelivery({
      ...(slack.conversationStreamDeliveryPolicy === undefined
        ? {}
        : { policy: slack.conversationStreamDeliveryPolicy }),
      slack,
      store,
    });
    yield* conversationStreamDelivery.recover;

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
        reactionRetryAt(error, failedAt)
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
        Effect.forkIn(reactionDriverScope, { startImmediately: true }),
        Effect.asVoid
      );

    const requestAcknowledgementCleanup = Effect.fnUntraced(function* (
      id: string
    ) {
      yield* store.requestAcknowledgementCleanup(id);
      yield* startAcknowledgementDriver(id);
    });

    const performCompletionReaction = Effect.fnUntraced(function* (
      reaction: CompletionReactionState
    ) {
      const now = yield* Clock.currentTimeMillis;
      const delayMillis = Math.max(0, (reaction.retryAtMillis ?? now) - now);
      if (delayMillis > 0) {
        yield* Effect.sleep(`${delayMillis} millis`);
      }
      return yield* Effect.result(
        completionReactor.react({
          channelId: reaction.channelId,
          rootTs: reaction.rootTs,
        })
      );
    });

    const driveCompletionReaction = Effect.fnUntraced(function* (id: string) {
      while (true) {
        const reaction = pipe(
          yield* store.completionReactions,
          EffectArray.findFirst((candidate) => candidate.id === id),
          Option.getOrNull
        );
        if (reaction === null || reaction.status === "permanent_failure") {
          return;
        }
        const result = yield* performCompletionReaction(reaction);
        if (result._tag === "Success") {
          yield* store.completeCompletionReaction(id);
          return;
        }
        const error = result.failure;
        const failedAt = yield* Clock.currentTimeMillis;
        yield* store.markCompletionReactionFailure(
          id,
          error.category,
          error.disposition,
          reactionRetryAt(error, failedAt)
        );
        if (error.disposition === "transient") {
          continue;
        }
        yield* Effect.logError("Slack completion reaction failed permanently", {
          category: error.category,
        });
        return;
      }
    });

    const superviseCompletionReaction = Effect.fnUntraced(function* (
      id: string
    ) {
      while (true) {
        const result = yield* Effect.result(driveCompletionReaction(id));
        if (result._tag === "Success") {
          return;
        }
        yield* Effect.logError(
          "Completion reaction driver retrying after local failure",
          result.failure
        );
        yield* Effect.sleep("1 second");
      }
    });

    const startCompletionReactionDriver = (id: string) =>
      superviseCompletionReaction(id).pipe(
        Effect.forkIn(reactionDriverScope, {
          startImmediately: true,
        }),
        Effect.asVoid
      );

    const startCompletionReactionForTurn = Effect.fnUntraced(function* (
      turnId: import("./domain.ts").TurnId
    ) {
      const reactions = pipe(
        yield* store.completionReactions,
        EffectArray.filter(
          (reaction) =>
            reaction.turnId === turnId &&
            reaction.status !== "permanent_failure"
        )
      );
      yield* Effect.forEach(
        reactions,
        (reaction) => startCompletionReactionDriver(reaction.id),
        { discard: true }
      );
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
          postThreadMessage(
            {
              channelId: claim.channelId,
              rootTs: claim.rootTs,
              text: claim.text,
            },
            claim.workspaceId
          )
        );
        if (result._tag === "Success") {
          yield* store.markDelivered(threadId, claim.itemId, result.success.ts);
          yield* startCompletionReactionForTurn(claim.turnId);
          deliveredAny = true;
          continue;
        }
        const error = result.failure;
        if (error instanceof StoreError) {
          return yield* error;
        }
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

    const publisherForTurn = (turn: ClaimedTurn) => {
      const persistReply = persistReplyFor(turn);
      const streamPublisher = conversationStreamDelivery.publisherFor({
        ownerId: turn.id,
        ownerKind: "participant-turn",
        threadId: turn.threadId,
      });
      const publish = Effect.fnUntraced(function* (
        output: ApplicationPublicOutput
      ) {
        if (output._tag === "PublicReply") {
          return yield* persistReply(toPublicReplyProtocolRecord(output));
        }
        return yield* streamPublisher.publish(output);
      });
      return { finalize: streamPublisher.finalize, publish };
    };

    const ownerHasConversationStreams = Effect.fnUntraced(function* (owner: {
      readonly ownerId: string;
      readonly ownerKind: "application-event" | "participant-turn";
      readonly threadId: ThreadId;
    }) {
      const belongsToOwner = (stream: {
        readonly ownerId: string;
        readonly ownerKind: "application-event" | "participant-turn";
        readonly threadId: ThreadId;
      }): boolean =>
        stream.threadId === owner.threadId &&
        stream.ownerKind === owner.ownerKind &&
        stream.ownerId === owner.ownerId;
      return (
        (yield* store.conversationStreams).some(belongsToOwner) ||
        (yield* store.conversationStreamTombstones).some(belongsToOwner)
      );
    });

    const applicationDefectFailure = (): HandlerFailure =>
      HandlerFailure.make({
        category: "protocol",
        noticeStyle: "generic",
        safeDetail: "Application failed unexpectedly",
      });

    const executeClaimedTurn = Effect.fnUntraced(function* (turn: ClaimedTurn) {
      const recoveryOwner = {
        ownerId: turn.id,
        ownerKind: "participant-turn" as const,
        threadId: turn.threadId,
      };
      const publisher = publisherForTurn(turn);
      yield* conversationStreamDelivery.signalOwnerRecovery(
        recoveryOwner,
        "resumed"
      );
      const result = yield* Effect.result(
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const applicationExit = yield* Effect.exit(
              restore(
                application
                  .handle(
                    ParticipantInputEvent.make({
                      attemptNumber: turn.attemptNumber,
                      channelId: turn.channelId,
                      context: turn.context,
                      conversationId: turn.threadId,
                      initializationStatus: turn.initializationStatus,
                      messages: turn.messages,
                      rootTs: turn.rootTs,
                      source: "slack",
                      turnId: turn.id,
                      workingDirectory: turn.workingDirectory,
                    }),
                    publisher.publish,
                    acceptApplicationEvent
                  )
                  .pipe(Effect.catchDefect(applicationDefectFailure))
              )
            );
            const finalizationExit = yield* Effect.exit(
              publisher.finalize(
                Exit.isSuccess(applicationExit) ? "completed" : "failed"
              )
            );
            if (Exit.isFailure(applicationExit)) {
              return yield* Effect.failCause(applicationExit.cause);
            }
            if (Exit.isFailure(finalizationExit)) {
              return yield* Effect.failCause(finalizationExit.cause);
            }
          })
        )
      );
      if (result._tag === "Success") {
        yield* store.completeHandler(turn.threadId, turn.id, {
          _tag: "Success",
        });
        yield* conversationStreamDelivery.signalOwnerRecovery(
          recoveryOwner,
          "completed"
        );
        yield* startCompletionReactionForTurn(turn.id);
        return "Completed" as const;
      }
      if (result.failure instanceof ConversationBlocked) {
        yield* store.blockConversationOwner(result.failure);
        yield* conversationStreamDelivery.signalOwnerRecovery(
          recoveryOwner,
          "non-replayable"
        );
        return "Blocked" as const;
      }
      if (result.failure instanceof StoreError) {
        yield* conversationStreamDelivery.signalOwnerRecovery(
          recoveryOwner,
          "failed"
        );
        return yield* result.failure;
      }
      if (
        result.failure.category === "signal" ||
        result.failure.category === "timeout"
      ) {
        const hasPartialStream = yield* ownerHasConversationStreams({
          ownerId: turn.id,
          ownerKind: "participant-turn",
          threadId: turn.threadId,
        });
        if (hasPartialStream) {
          yield* store.completeHandler(turn.threadId, turn.id, {
            _tag: "Failure",
            category: result.failure.category,
            noticeStyle: result.failure.noticeStyle ?? "generic",
            safeDetail: result.failure.safeDetail,
          });
          yield* conversationStreamDelivery.signalOwnerRecovery(
            recoveryOwner,
            "non-replayable"
          );
          return "Completed" as const;
        }
        // The durable running attempt is intentionally left open. A later
        // Runner retry marks it interrupted and re-enters the same handler turn.
        return "Replayable" as const;
      }
      yield* store.completeHandler(turn.threadId, turn.id, {
        _tag: "Failure",
        category: result.failure.category,
        noticeStyle: result.failure.noticeStyle ?? "diagnostic",
        safeDetail: result.failure.safeDetail,
      });
      yield* conversationStreamDelivery.signalOwnerRecovery(
        recoveryOwner,
        "failed"
      );
      return "Completed" as const;
    });

    const executeClaimedApplicationEvent = Effect.fnUntraced(function* (
      threadId: ThreadId,
      event: import("./domain.ts").ApplicationEventState
    ) {
      const recoveryOwner = {
        ownerId: event.eventId,
        ownerKind: "application-event" as const,
        threadId,
      };
      const streamPublisher =
        conversationStreamDelivery.publisherFor(recoveryOwner);
      yield* conversationStreamDelivery.signalOwnerRecovery(
        recoveryOwner,
        "resumed"
      );
      const publish = (output: ApplicationPublicOutput) => {
        if (output._tag === "ConversationMessageChunk") {
          return streamPublisher.publish(output);
        }
        return store
          .acceptApplicationReply(
            threadId,
            event.eventId,
            toPublicReplyProtocolRecord(output).replyId,
            output.text
          )
          .pipe(
            Effect.catchTag("ReplyProtocolError", () =>
              HandlerFailure.make({
                category: "protocol",
                safeDetail: "conflicting or invalid public reply",
              })
            )
          );
      };
      const result = yield* Effect.result(
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const applicationExit = yield* Effect.exit(
              restore(
                application
                  .handle(
                    {
                      _tag: "ExternalInput",
                      conversationId: threadId,
                      eventId: event.eventId,
                      payload: event.payload,
                      source: event.source,
                    },
                    publish,
                    acceptApplicationEvent
                  )
                  .pipe(Effect.catchDefect(applicationDefectFailure))
              )
            );
            const finalizationExit = yield* Effect.exit(
              streamPublisher.finalize(
                Exit.isSuccess(applicationExit) ? "completed" : "failed"
              )
            );
            if (Exit.isFailure(applicationExit)) {
              return yield* Effect.failCause(applicationExit.cause);
            }
            if (Exit.isFailure(finalizationExit)) {
              return yield* Effect.failCause(finalizationExit.cause);
            }
          })
        )
      );
      if (result._tag === "Success") {
        yield* store.completeApplicationEvent(threadId, event.eventId, {
          _tag: "Success",
        });
        yield* conversationStreamDelivery.signalOwnerRecovery(
          recoveryOwner,
          "completed"
        );
        return "Completed" as const;
      }
      if (result.failure instanceof ConversationBlocked) {
        yield* store.blockConversationOwner(result.failure);
        yield* conversationStreamDelivery.signalOwnerRecovery(
          recoveryOwner,
          "non-replayable"
        );
        return "Blocked" as const;
      }
      if (result.failure instanceof StoreError) {
        yield* conversationStreamDelivery.signalOwnerRecovery(
          recoveryOwner,
          "failed"
        );
        return yield* result.failure;
      }
      if (
        result.failure.category === "signal" ||
        result.failure.category === "timeout"
      ) {
        const hasPartialStream = yield* ownerHasConversationStreams({
          ownerId: event.eventId,
          ownerKind: "application-event",
          threadId,
        });
        if (hasPartialStream) {
          yield* store.completeApplicationEvent(threadId, event.eventId, {
            _tag: "Failure",
            category: result.failure.category,
          });
          yield* conversationStreamDelivery.signalOwnerRecovery(
            recoveryOwner,
            "non-replayable"
          );
          return "Completed" as const;
        }
        return "Replayable" as const;
      }
      yield* store.completeApplicationEvent(threadId, event.eventId, {
        _tag: "Failure",
        category: result.failure.category,
      });
      yield* conversationStreamDelivery.signalOwnerRecovery(
        recoveryOwner,
        "failed"
      );
      return "Completed" as const;
    });

    const executeNextThreadInput = Effect.fnUntraced(function* (
      threadId: ThreadId
    ) {
      const applicationEvent = yield* store.claimNextApplicationEvent(threadId);
      if (applicationEvent !== null) {
        return yield* executeClaimedApplicationEvent(
          threadId,
          applicationEvent
        );
      }
      const turn = yield* store.claimNextTurn(threadId);
      return turn === null
        ? ("None" as const)
        : yield* executeClaimedTurn(turn);
    });

    const driveThread = Effect.fnUntraced(function* (threadId: ThreadId) {
      let contextRequest = yield* store.contextRequest(threadId);
      while (contextRequest !== null) {
        yield* acquireContext(contextRequest);
        contextRequest = yield* store.contextRequest(threadId);
      }

      while (true) {
        const inputCompletion = yield* executeNextThreadInput(threadId);
        if (inputCompletion === "Replayable") {
          return;
        }
        if (inputCompletion === "Blocked") {
          yield* deliverHead(threadId);
          return;
        }
        if (inputCompletion === "Completed") {
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

    const requestAcknowledgementCleanups = (
      acknowledgementIds: readonly string[]
    ): Effect.Effect<void> =>
      Effect.forEach(
        acknowledgementIds,
        (acknowledgementId) =>
          Effect.result(requestAcknowledgementCleanup(acknowledgementId)).pipe(
            Effect.flatMap((result) =>
              result._tag === "Failure"
                ? Effect.logError(
                    "Could not schedule activation acknowledgement cleanup",
                    result.failure
                  )
                : Effect.void
            )
          ),
        { discard: true }
      );

    const completeThreadDriverCycle = (
      threadId: ThreadId,
      driverId: number,
      observedSignals: number
    ) =>
      Ref.modify(
        threadDrivers,
        (registry): readonly [ThreadDriverCompletion, ThreadDriverRegistry] => {
          const active = pipe(
            registry.active,
            EffectArray.findFirst(
              (entry) =>
                entry.threadId === threadId && entry.driverId === driverId
            ),
            Option.getOrNull
          );
          if (active === null) {
            return [
              { _tag: "Stop", acknowledgementIds: [] } as const,
              registry,
            ];
          }
          if (active.signals !== observedSignals) {
            return [{ _tag: "Continue" } as const, registry];
          }
          return [
            {
              _tag: "Stop" as const,
              acknowledgementIds: active.acknowledgementIds,
            },
            {
              ...registry,
              active: pipe(
                registry.active,
                EffectArray.filter(
                  (entry) =>
                    entry.threadId !== threadId || entry.driverId !== driverId
                )
              ),
            },
          ] as const;
        }
      );

    const driveActiveThread = Effect.fnUntraced(function* (
      threadId: ThreadId,
      driverId: number
    ) {
      while (true) {
        const observedSignals = pipe(
          (yield* Ref.get(threadDrivers)).active,
          EffectArray.findFirst(
            (entry) =>
              entry.threadId === threadId && entry.driverId === driverId
          ),
          Option.map((entry) => entry.signals),
          Option.getOrNull
        );
        if (observedSignals === null) {
          return;
        }
        const driveExit = yield* Effect.exit(serializedDrive(threadId));
        const ownerRecoveryExit = yield* Effect.exit(
          conversationStreamDelivery.declareOwnerRecoveryUnavailableForThread(
            threadId
          )
        );
        if (driveExit._tag === "Failure") {
          yield* Effect.logError(
            "Background Runner drive stopped",
            driveExit.cause
          );
        }
        if (ownerRecoveryExit._tag === "Failure") {
          yield* Effect.logError(
            "Conversation stream owner recovery coordination stopped",
            ownerRecoveryExit.cause
          );
        }
        const completion = yield* completeThreadDriverCycle(
          threadId,
          driverId,
          observedSignals
        );
        if (completion._tag === "Continue") {
          continue;
        }
        yield* requestAcknowledgementCleanups(completion.acknowledgementIds);
        const registry = yield* Ref.get(threadDrivers);
        if (
          !registry.admissionOpen &&
          registry.active.length === 0 &&
          registry.directDrivers === 0
        ) {
          yield* Deferred.succeed(quiesced, undefined);
        }
        return;
      }
    });

    const signalThreadDriver: (
      threadId: ThreadId,
      acknowledgementId: string | null
    ) => Effect.Effect<"AlreadyDurable" | "Deferred" | "Scheduled"> =
      Effect.fnUntraced(function* (
        threadId: ThreadId,
        acknowledgementId: string | null
      ) {
        const registration = yield* Ref.modify(
          threadDrivers,
          (
            registry
          ): readonly [ThreadDriverRegistration, ThreadDriverRegistry] => {
            if (!registry.admissionOpen) {
              return [{ _tag: "Deferred" } as const, registry];
            }
            const existing = pipe(
              registry.active,
              EffectArray.findFirst((entry) => entry.threadId === threadId),
              Option.getOrNull
            );
            if (existing !== null) {
              const acknowledgementIds =
                acknowledgementId === null ||
                EffectArray.contains(
                  existing.acknowledgementIds,
                  acknowledgementId
                )
                  ? existing.acknowledgementIds
                  : EffectArray.append(
                      existing.acknowledgementIds,
                      acknowledgementId
                    );
              return [
                { _tag: "Signaled" } as const,
                {
                  ...registry,
                  active: pipe(
                    registry.active,
                    EffectArray.map((entry) =>
                      entry.driverId === existing.driverId
                        ? {
                            ...entry,
                            acknowledgementIds,
                            signals: entry.signals + 1,
                          }
                        : entry
                    )
                  ),
                },
              ] as const;
            }
            const driverId = registry.nextDriverId;
            return [
              { _tag: "Started" as const, driverId },
              {
                ...registry,
                active: EffectArray.append(registry.active, {
                  acknowledgementIds:
                    acknowledgementId === null ? [] : [acknowledgementId],
                  driverId,
                  signals: 1,
                  threadId,
                }),
                nextDriverId: driverId + 1,
              },
            ] as const;
          }
        );
        if (registration._tag === "Deferred") {
          return "Deferred" as const;
        }
        if (acknowledgementId !== null) {
          yield* startAcknowledgementDriver(acknowledgementId);
        }
        if (registration._tag === "Signaled") {
          return "AlreadyDurable" as const;
        }
        yield* Effect.yieldNow.pipe(
          Effect.andThen(driveActiveThread(threadId, registration.driverId)),
          Effect.forkIn(reactionDriverScope)
        );
        return "Scheduled" as const;
      });

    const quiesce = Effect.gen(function* () {
      const idle = yield* Ref.modify(
        threadDrivers,
        (registry): readonly [boolean, ThreadDriverRegistry] => [
          registry.active.length === 0 && registry.directDrivers === 0,
          registry.admissionOpen
            ? { ...registry, admissionOpen: false }
            : registry,
        ]
      );
      if (idle) {
        yield* Deferred.succeed(quiesced, undefined);
      }
      yield* Deferred.await(quiesced);
    });

    const runIfAdmitted = <A, E, R>(
      effect: Effect.Effect<A, E, R>,
      deferred: A
    ): Effect.Effect<A, E, R> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const admitted = yield* Ref.modify(
            threadDrivers,
            (registry): readonly [boolean, ThreadDriverRegistry] =>
              registry.admissionOpen
                ? [
                    true,
                    {
                      ...registry,
                      directDrivers: registry.directDrivers + 1,
                    },
                  ]
                : [false, registry]
          );
          if (!admitted) {
            return deferred;
          }
          return yield* restore(effect).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                const idle = yield* Ref.modify(
                  threadDrivers,
                  (registry): readonly [boolean, ThreadDriverRegistry] => {
                    const updated = {
                      ...registry,
                      directDrivers: registry.directDrivers - 1,
                    };
                    return [
                      !updated.admissionOpen &&
                        updated.active.length === 0 &&
                        updated.directDrivers === 0,
                      updated,
                    ];
                  }
                );
                if (idle) {
                  yield* Deferred.succeed(quiesced, undefined);
                }
              })
            )
          );
        })
      );

    const acceptApplicationEvent: AcceptApplicationEvent = Effect.fn(
      "PrototypeRunner.acceptApplicationEvent"
    )(function* (event: ExternalInputEvent) {
      const payload = yield* Schema.decodeUnknownEffect(Schema.Json)(
        event.payload
      ).pipe(
        Effect.mapError(() =>
          HandlerFailure.make({
            category: "protocol",
            safeDetail: "external input payload must be JSON-serializable",
          })
        )
      );
      const decision = yield* store.acceptApplicationEvent({
        conversationId: event.conversationId,
        eventId: event.eventId,
        payload,
        source: event.source,
      });
      if (!(yield* Ref.get(startupRecoveryBarrierOpen))) {
        return { decision, scheduling: "AlreadyDurable" as const };
      }
      const scheduling = yield* signalThreadDriver(event.conversationId, null);
      return { decision, scheduling };
    });

    if (application.recover !== undefined) {
      const recovery = yield* Effect.result(
        application.recover(acceptApplicationEvent)
      );
      if (recovery._tag === "Failure") {
        return yield* StoreError.make({
          operation: "startupApplicationRecovery",
          reason: "application-recovery-barrier-unresolved",
        });
      }
    }

    if (
      application.unresolvedConversations !== undefined ||
      application.unresolvedConversationForOwner !== undefined
    ) {
      const unresolvedResult = yield* Effect.result(
        application.unresolvedConversations ?? Effect.succeed([])
      );
      if (unresolvedResult._tag === "Failure") {
        yield* Effect.logError(
          "Application unresolved conversation recovery stopped",
          unresolvedResult.failure
        );
      }
      const snapshot = yield* store.snapshot;
      const runningOwners = snapshot.threads.flatMap((thread) => [
        ...thread.turns.flatMap((turn) =>
          turn.status === "running"
            ? [
                {
                  conversationId: thread.id,
                  ownerId: turn.id,
                  ownerKind: "participant-turn" as const,
                  workspaceId: thread.workspaceId ?? "legacy",
                },
              ]
            : []
        ),
        ...thread.applicationEvents.flatMap((event) =>
          event.status === "running"
            ? [
                {
                  conversationId: thread.id,
                  ownerId: event.eventId,
                  ownerKind: "application-event" as const,
                  workspaceId: thread.workspaceId ?? "legacy",
                },
              ]
            : []
        ),
      ]);
      const inferred =
        application.unresolvedConversationForOwner === undefined
          ? []
          : yield* Effect.forEach(
              runningOwners,
              (owner) =>
                application
                  .unresolvedConversationForOwner?.(owner)
                  .pipe(Effect.catch(() => Effect.succeed(null))) ??
                Effect.succeed(null),
              { concurrency: 1 }
            );
      const unresolvedByAttempt = new Map<string, ConversationBlocked>();
      const explicit =
        unresolvedResult._tag === "Success" ? unresolvedResult.success : [];
      for (const blocked of [...explicit, ...inferred]) {
        if (blocked !== null) {
          unresolvedByAttempt.set(blocked.attemptId, blocked);
        }
      }
      yield* Effect.forEach(
        [...unresolvedByAttempt.values()],
        (blocked) => {
          if (blocked.decisionKind !== null && blocked.decisionId !== null) {
            return store
              .resolveConversationBlocked({
                attemptId: blocked.attemptId,
                conversationId: blocked.conversationId,
                decisionId: blocked.decisionId,
                kind: blocked.decisionKind,
                ownerId: blocked.ownerId,
                ownerKind: blocked.ownerKind,
                replacementAttemptId: blocked.replacementAttemptId,
                workspaceId: blocked.workspaceId,
              })
              .pipe(Effect.asVoid);
          }
          return store.blockConversationOwner(blocked);
        },
        { discard: true }
      );
    }

    yield* Ref.set(startupRecoveryBarrierOpen, true);
    yield* Effect.forEach(
      yield* store.threadIds,
      (threadId) => signalThreadDriver(threadId, null),
      { concurrency: 1, discard: true }
    );

    const staleAcknowledgements = yield* store.acknowledgements;
    yield* Effect.forEach(
      staleAcknowledgements,
      (acknowledgement) =>
        acknowledgement.status === "permanent_failure"
          ? Effect.void
          : requestAcknowledgementCleanup(acknowledgement.id),
      { discard: true }
    );
    const staleCompletionReactions = yield* store.completionReactions;
    yield* Effect.forEach(
      staleCompletionReactions,
      (reaction) =>
        reaction.status === "permanent_failure"
          ? Effect.void
          : startCompletionReactionDriver(reaction.id),
      { discard: true }
    );

    const acceptInbound = Effect.fnUntraced(function* (input: unknown) {
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
        event.messageTs,
        event.workspaceId
      );
      const candidateThreadId = canonicalThreadId(
        event.channelId,
        event.threadTs ?? event.messageTs,
        event.workspaceId
      );
      const threadIds = yield* store.threadIds;
      return {
        acknowledgementId,
        decision,
        isAcceptedActivation,
        threadId: EffectArray.contains(threadIds, candidateThreadId)
          ? candidateThreadId
          : null,
      };
    });

    const continueAcceptedInbound = Effect.fnUntraced(function* (
      accepted: AcceptedInbound
    ) {
      const drive =
        accepted.threadId === null
          ? Effect.void
          : serializedDrive(accepted.threadId);
      yield* accepted.isAcceptedActivation
        ? startAcknowledgementDriver(accepted.acknowledgementId).pipe(
            Effect.andThen(drive),
            Effect.ensuring(
              Effect.result(
                requestAcknowledgementCleanup(accepted.acknowledgementId)
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
    });

    const accept = Effect.fn("PrototypeRunner.accept")(function* (
      input: unknown
    ) {
      const accepted = yield* acceptInbound(input);
      if (accepted.threadId === null) {
        return {
          decision: accepted.decision,
          scheduling: "AlreadyDurable" as const,
        };
      }
      const scheduling = yield* signalThreadDriver(
        accepted.threadId,
        accepted.isAcceptedActivation ? accepted.acknowledgementId : null
      );
      return {
        decision: accepted.decision,
        scheduling,
      };
    });

    const inject = Effect.fn("PrototypeRunner.inject")(function* (
      input: unknown
    ) {
      const accepted = yield* acceptInbound(input);
      yield* runIfAdmitted(continueAcceptedInbound(accepted), undefined);
      return accepted.decision;
    });

    const runner = PrototypeRunner.of({
      accept,
      acceptApplicationEvent,
      decideConversationRecovery: (request) => {
        if (application.decideConversationRecovery === undefined) {
          return StoreError.make({
            operation: "decideConversationRecovery",
            reason: "application-recovery-unavailable",
          });
        }
        return application.decideConversationRecovery(request).pipe(
          Effect.flatMap((decision) =>
            store
              .resolveConversationBlocked({
                attemptId: decision.attemptId,
                conversationId: decision.conversationId,
                decisionId: decision.decisionId,
                kind: decision.kind,
                ownerId: decision.ownerId,
                ownerKind: decision.ownerKind,
                replacementAttemptId: decision.replacementAttemptId,
                workspaceId: decision.workspaceId,
              })
              .pipe(
                Effect.andThen(
                  runIfAdmitted(
                    serializedDrive(decision.conversationId),
                    undefined
                  )
                ),
                Effect.as(decision)
              )
          )
        );
      },
      inject,
      lockCounts: Effect.all({
        acknowledgements: Ref.get(acknowledgementSemaphores).pipe(
          Effect.map((entries) => entries.length)
        ),
        drivers: Ref.get(threadDrivers).pipe(
          Effect.map((registry) => registry.active.length)
        ),
        threads: Ref.get(threadSemaphores).pipe(
          Effect.map((entries) => entries.length)
        ),
      }),
      listConversationBlocks: Effect.all({
        application:
          application.unresolvedConversations === undefined
            ? Effect.succeed<readonly ConversationBlocked[]>([])
            : application.unresolvedConversations.pipe(
                Effect.catch(() =>
                  Effect.succeed<readonly ConversationBlocked[]>([])
                )
              ),
        runner: store.snapshot,
      }).pipe(
        Effect.map(({ application: applicationEvidence, runner: state }) => {
          const runnerEvidence = state.threads.flatMap((thread) => [
            ...thread.turns.flatMap((turn) =>
              turn.status === "blocked" && turn.blocked != null
                ? [ConversationBlocked.make(turn.blocked)]
                : []
            ),
            ...thread.applicationEvents.flatMap((event) =>
              event.status === "blocked" && event.blocked != null
                ? [ConversationBlocked.make(event.blocked)]
                : []
            ),
          ]);
          const byAttempt = new Map<string, ConversationBlocked>();
          for (const blocked of [...applicationEvidence, ...runnerEvidence]) {
            byAttempt.set(blocked.attemptId, blocked);
          }
          return [...byAttempt.values()];
        })
      ),
      persistenceHealth: store.persistenceHealth,
      quiesce,
      drain: (threadId) => runIfAdmitted(serializedDrive(threadId), undefined),
      retryBlocked: (threadId) =>
        store
          .retryBlocked(threadId)
          .pipe(
            Effect.andThen(runIfAdmitted(serializedDrive(threadId), undefined))
          ),
      retryInterrupted: (threadId) =>
        runIfAdmitted(serializedDrive(threadId), undefined),
      abandonBlocked: (threadId) =>
        store
          .abandonBlocked(threadId)
          .pipe(
            Effect.andThen(runIfAdmitted(serializedDrive(threadId), undefined))
          ),
    });
    return runner;
  })
);

export interface PrototypeHarness {
  readonly runner: Runner;
  readonly store: PrototypeStoreShape;
}

interface PrototypeHarnessCommonOptions {
  readonly activationAcknowledger?: ActivationAcknowledgerShape;
  readonly completionReactor?: CompletionReactorShape;
  readonly laborerSlackId: string;
  readonly slack: SlackGatewayShape;
  readonly storeLayer?: Layer.Layer<PrototypeStore, StoreError>;
}

type PrototypeHarnessApplicationOptions = PrototypeHarnessCommonOptions &
  (
    | {
        readonly application: ApplicationShape;
        readonly handler?: never;
        readonly initializer?: never;
      }
    | {
        readonly application?: never;
        readonly handler: WorkHandlerShape;
        readonly initializer?: ThreadInitializerShape;
      }
  );

export const makePrototypeHarness = (
  options: PrototypeHarnessApplicationOptions
): Effect.Effect<
  PrototypeHarness,
  StoreError,
  import("effect").Scope.Scope
> => {
  const storeLayer =
    options.storeLayer ??
    makeInMemoryStoreLayer(options.laborerSlackId, {
      initializeNewThreads: options.initializer !== undefined,
    });
  const configuredApplicationLayer =
    options.application === undefined
      ? Layer.effect(
          Application,
          Effect.gen(function* () {
            const store = yield* PrototypeStore;
            return applicationFromConfiguredProcessHandler({
              completeInitialization: store.completeInitialization,
              handler: options.handler,
              ...(options.initializer === undefined
                ? {}
                : { initializer: options.initializer }),
            });
          })
        )
      : Application.layer(options.application);
  const dependencies = Layer.mergeAll(
    configuredApplicationLayer.pipe(Layer.provideMerge(storeLayer)),
    ActivationAcknowledger.layer(
      options.activationAcknowledger ?? noOpActivationAcknowledger
    ),
    CompletionReactor.layer(options.completionReactor ?? noOpCompletionReactor),
    SlackGateway.layer(options.slack)
  );
  const runtimeLayer: Layer.Layer<
    PrototypeRunner | PrototypeStore,
    StoreError
  > = runnerLayer.pipe(Layer.provideMerge(dependencies));
  return Effect.gen(function* () {
    const context = yield* Layer.build(runtimeLayer);
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
