/**
 * THROWAWAY ISSUE #204 PROTOTYPE.
 * All queue, claim, outcome, and outbox invariants live behind this service.
 */
import { randomUUID } from "node:crypto";
import { type FileHandle, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
  Context,
  Effect,
  Array as EffectArray,
  Layer,
  Option,
  Order,
  pipe,
  Ref,
  Schema,
  Semaphore,
} from "effect";
import {
  AcknowledgementState,
  type ClaimedTurn,
  canonicalThreadId,
  HandlerAttempt,
  type HandlerFailureCategory,
  HandlerOutcomeState,
  type IgnoredReason,
  type InboundDecision,
  initialPrototypeState,
  type NormalizedInboundEvent,
  NormalizedMessage,
  OutboundItem,
  type PrototypeState,
  PrototypeState as PrototypeStateSchema,
  type ReplyId,
  stableAcknowledgementId,
  stableMessageId,
  type ThreadId,
  TurnId,
  TurnState,
  WorkThreadState,
} from "./domain.ts";
import {
  type DeliveryFailureDisposition,
  ReplyProtocolError,
  StoreError,
} from "./errors.ts";
import {
  assertSafeFilePath,
  openRegularFileNoFollow,
  retainTrustedDirectory,
  verifyRetainedDirectory,
} from "./path-safety.ts";

export interface ActivationContextRequest {
  readonly activationTs: string;
  readonly channelId: string;
  readonly isReplyActivation: boolean;
  readonly retryAtMillis: number | null;
  readonly rootTs: string;
  readonly threadId: ThreadId;
}

export type OutboxClaim =
  | { readonly _tag: "None" }
  | { readonly _tag: "Blocked"; readonly itemId: string }
  | { readonly _tag: "Waiting"; readonly wakeAtMillis: number }
  | {
      readonly _tag: "Deliver";
      readonly channelId: string;
      readonly itemId: string;
      readonly rootTs: string;
      readonly text: string;
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
    };

export interface PrototypeStoreShape {
  readonly abandonBlocked: (
    threadId: ThreadId
  ) => Effect.Effect<void, StoreError>;
  readonly accept: (
    event: NormalizedInboundEvent
  ) => Effect.Effect<InboundDecision, StoreError>;
  readonly acceptPublicReply: (
    threadId: ThreadId,
    turnId: TurnId,
    replyId: ReplyId,
    text: string
  ) => Effect.Effect<void, StoreError | ReplyProtocolError>;
  readonly acknowledgements: Effect.Effect<
    readonly AcknowledgementState[],
    StoreError
  >;
  readonly claimNextTurn: (
    threadId: ThreadId
  ) => Effect.Effect<ClaimedTurn | null, StoreError>;
  readonly claimOutboundHead: (
    threadId: ThreadId,
    nowMillis: number
  ) => Effect.Effect<OutboxClaim, StoreError>;
  readonly completeAcknowledgement: (
    id: string
  ) => Effect.Effect<void, StoreError>;
  readonly completeContext: (
    threadId: ThreadId,
    context: readonly NormalizedMessage[],
    isPartial: boolean
  ) => Effect.Effect<void, StoreError>;
  readonly completeHandler: (
    threadId: ThreadId,
    turnId: TurnId,
    outcome:
      | { readonly _tag: "Success" }
      | {
          readonly _tag: "Failure";
          readonly category: HandlerFailureCategory;
          readonly safeDetail: string | null;
        }
  ) => Effect.Effect<void, StoreError>;
  readonly contextRequest: (
    threadId: ThreadId
  ) => Effect.Effect<ActivationContextRequest | null, StoreError>;
  readonly markAcknowledgementActive: (
    id: string
  ) => Effect.Effect<void, StoreError>;
  readonly markAcknowledgementCleanupPending: (
    id: string
  ) => Effect.Effect<void, StoreError>;
  readonly markAcknowledgementFailure: (
    id: string,
    category: string,
    disposition: DeliveryFailureDisposition,
    retryAtMillis: number | null
  ) => Effect.Effect<void, StoreError>;
  readonly markContextAttemptFailed: (
    threadId: ThreadId,
    retryAtMillis: number
  ) => Effect.Effect<void, StoreError>;
  readonly markDelivered: (
    threadId: ThreadId,
    itemId: string,
    slackTs: string
  ) => Effect.Effect<void, StoreError>;
  readonly markDeliveryFailed: (
    threadId: ThreadId,
    itemId: string,
    category: string,
    disposition: DeliveryFailureDisposition,
    retryAtMillis: number | null
  ) => Effect.Effect<void, StoreError>;
  readonly persistenceHealth: Effect.Effect<StorePersistenceHealth>;
  readonly requestAcknowledgementCleanup: (
    id: string
  ) => Effect.Effect<void, StoreError>;
  readonly retryBlocked: (
    threadId: ThreadId
  ) => Effect.Effect<void, StoreError>;
  readonly snapshot: Effect.Effect<PrototypeState, StoreError>;
  readonly threadIds: Effect.Effect<readonly ThreadId[], StoreError>;
}

export type StorePersistenceHealth =
  | { readonly _tag: "Healthy" }
  | {
      readonly _tag: "Degraded";
      readonly error: StoreError;
      readonly operation: string;
    };

export class PrototypeStore extends Context.Service<
  PrototypeStore,
  PrototypeStoreShape
>()("@laborer/issue-204/PrototypeStore") {}

type Transition<A, E extends StoreError | ReplyProtocolError = StoreError> = (
  state: PrototypeState
) => readonly [A, PrototypeState] | E;

type PersistenceResult =
  | { readonly _tag: "Published" }
  | { readonly _tag: "PublishedWithError"; readonly error: StoreError };

const published: PersistenceResult = { _tag: "Published" };
const healthyPersistence: StorePersistenceHealth = { _tag: "Healthy" };

const storeFailure = (operation: string, reason: string): StoreError =>
  StoreError.make({ operation, reason });

const failTransition = <E>(error: E): Effect.Effect<never, E> =>
  Effect.fail(error);

const findThreadIndex = (state: PrototypeState, threadId: ThreadId): number =>
  pipe(
    EffectArray.findFirstIndex(
      state.threads,
      (thread) => thread.id === threadId
    ),
    Option.getOrElse(() => -1)
  );

const replaceAt = <A>(values: readonly A[], index: number, value: A): A[] =>
  pipe(
    values,
    EffectArray.replace(index, value),
    Option.getOrElse(() => EffectArray.fromIterable(values))
  );

const settleEligibleTurns = (thread: WorkThreadState): WorkThreadState => {
  const turns = pipe(
    thread.turns,
    EffectArray.map((turn) => {
      if (turn.outcome === null || turn.status !== "awaiting_delivery") {
        return turn;
      }
      const hasUnsettledOutbound = pipe(
        thread.outbox,
        EffectArray.filter((item) => item.turnId === turn.id),
        EffectArray.some(
          (item) => item.status !== "delivered" && item.status !== "abandoned"
        )
      );
      if (hasUnsettledOutbound) {
        return turn;
      }
      return TurnState.make({
        ...turn,
        status: turn.outcome.kind === "success" ? "completed" : "failed",
      });
    })
  );
  return WorkThreadState.make({ ...thread, turns });
};

const modifyThread = <A>(
  state: PrototypeState,
  threadId: ThreadId,
  operation: string,
  update: (
    thread: WorkThreadState
  ) => readonly [A, WorkThreadState] | StoreError
): readonly [A, PrototypeState] | StoreError => {
  const index = findThreadIndex(state, threadId);
  if (index < 0) {
    return storeFailure(operation, "thread-not-found");
  }
  const thread = state.threads[index];
  if (thread === undefined) {
    return storeFailure(operation, "thread-index-invariant");
  }
  const result = update(thread);
  if (result instanceof StoreError) {
    return result;
  }
  const [value, nextThread] = result;
  return [
    value,
    PrototypeStateSchema.make({
      ...state,
      threads: replaceAt(state.threads, index, nextThread),
    }),
  ];
};

const modifyAcknowledgement = (
  state: PrototypeState,
  id: string,
  operation: string,
  update: (current: AcknowledgementState) => AcknowledgementState
): readonly [undefined, PrototypeState] | StoreError => {
  const index = pipe(
    state.acknowledgements,
    EffectArray.findFirstIndex((acknowledgement) => acknowledgement.id === id),
    Option.getOrElse(() => -1)
  );
  const current = state.acknowledgements[index];
  if (current === undefined) {
    return storeFailure(operation, "acknowledgement-not-found");
  }
  return [
    undefined,
    PrototypeStateSchema.make({
      ...state,
      acknowledgements: replaceAt(
        state.acknowledgements,
        index,
        update(current)
      ),
    }),
  ];
};

const ignored = (
  state: PrototypeState,
  event: NormalizedInboundEvent,
  reason: IgnoredReason,
  recordSeen = true
): readonly [InboundDecision, PrototypeState] => [
  { _tag: "Ignored", eventId: event.eventId, reason },
  PrototypeStateSchema.make({
    ...state,
    seenEventIds: recordSeen
      ? EffectArray.append(state.seenEventIds, event.eventId)
      : state.seenEventIds,
    ignoredInbound: EffectArray.append(state.ignoredInbound, {
      eventId: event.eventId,
      reason,
    }),
  }),
];

const allInputMessages = (
  thread: WorkThreadState
): readonly NormalizedMessage[] =>
  EffectArray.appendAll(
    thread.unassigned,
    pipe(
      thread.turns,
      EffectArray.flatMap((turn) => turn.messages)
    )
  );

const findInputMessage = (
  state: PrototypeState,
  messageId: string
): {
  readonly message: NormalizedMessage;
  readonly thread: WorkThreadState;
} | null =>
  pipe(
    state.threads,
    EffectArray.findFirst((thread) =>
      EffectArray.some(
        allInputMessages(thread),
        (message) => message.id === messageId
      )
    ),
    Option.flatMap((thread) =>
      pipe(
        allInputMessages(thread),
        EffectArray.findFirst((message) => message.id === messageId),
        Option.map((message) => ({ message, thread }))
      )
    ),
    Option.getOrNull
  );

const inputMessageOrder = pipe(
  Order.Number,
  Order.mapInput((message: NormalizedMessage) => Number(message.slackTs))
);

const acceptTransition = (
  state: PrototypeState,
  event: NormalizedInboundEvent,
  laborerSlackId: string
): readonly [InboundDecision, PrototypeState] | StoreError => {
  if (EffectArray.contains(state.seenEventIds, event.eventId)) {
    return ignored(state, event, "duplicate", false);
  }
  if (
    event.authorKind === "laborer" ||
    event.authorSlackId === laborerSlackId
  ) {
    return ignored(state, event, "laborer-authored");
  }
  if (event.channelKind === "direct") {
    return ignored(state, event, "unsupported-channel");
  }
  if (event.recordKind !== "message") {
    return ignored(state, event, "unsupported-record");
  }
  if (event.text === null || event.text.trim().length === 0) {
    return ignored(state, event, "blank");
  }

  const rootTs = event.threadTs ?? event.messageTs;
  const threadId = canonicalThreadId(event.channelId, rootTs);
  const messageId = stableMessageId(event.channelId, event.messageTs);
  const existing = findInputMessage(state, messageId);
  if (existing !== null) {
    const isIdentical =
      existing.thread.id === threadId &&
      existing.message.authorKind === event.authorKind &&
      existing.message.authorSlackId === event.authorSlackId &&
      existing.message.slackTs === event.messageTs &&
      existing.message.text === event.text;
    return isIdentical
      ? ignored(state, event, "duplicate-message")
      : storeFailure("accept", "conflicting-message-identity");
  }
  const threadIndex = findThreadIndex(state, threadId);
  const isActiveReply = event.threadTs !== null && threadIndex >= 0;
  const isActivation =
    !isActiveReply && event.text.includes(`<@${laborerSlackId}>`);
  if (!(isActiveReply || isActivation)) {
    return ignored(state, event, "outside-active-thread");
  }

  const message = NormalizedMessage.make({
    id: messageId,
    classification: "input",
    isActivation,
    authorKind: event.authorKind,
    authorSlackId: event.authorSlackId,
    slackTs: event.messageTs,
    text: event.text,
  });
  const threads =
    threadIndex < 0
      ? EffectArray.append(
          state.threads,
          WorkThreadState.make({
            activationEventId: event.eventId,
            activationTs: event.messageTs,
            channelId: event.channelId,
            context: [],
            contextAttempts: 0,
            contextIsPartial: false,
            contextRetryAtMillis: null,
            contextStatus: "pending",
            id: threadId,
            outbox: [],
            rootTs,
            turns: [],
            unassigned: [message],
          })
        )
      : pipe(
          state.threads,
          EffectArray.map((thread) =>
            thread.id === threadId
              ? WorkThreadState.make({
                  ...thread,
                  unassigned: pipe(
                    EffectArray.append(thread.unassigned, message),
                    EffectArray.sort(inputMessageOrder)
                  ),
                })
              : thread
          )
        );
  return [
    { _tag: "Accepted", eventId: event.eventId, isActivation, threadId },
    PrototypeStateSchema.make({
      ...state,
      acknowledgements: isActivation
        ? EffectArray.append(
            state.acknowledgements,
            AcknowledgementState.make({
              attempts: 0,
              channelId: event.channelId,
              cleanupRequested: false,
              eventId: event.eventId,
              id: stableAcknowledgementId(event.channelId, event.messageTs),
              lastErrorCategory: null,
              messageTs: event.messageTs,
              retryAtMillis: null,
              status: "add_pending",
            })
          )
        : state.acknowledgements,
      seenEventIds: EffectArray.append(state.seenEventIds, event.eventId),
      threads,
    }),
  ];
};

const findTurnIndex = (thread: WorkThreadState, turnId: TurnId): number =>
  pipe(
    EffectArray.findFirstIndex(thread.turns, (turn) => turn.id === turnId),
    Option.getOrElse(() => -1)
  );

const deliveryFailureNoticeId = (item: OutboundItem): string =>
  `notice:${item.turnId}:delivery:${item.id}`;

const nextClaimableOutboundIndex = (
  thread: WorkThreadState,
  headIndex: number
): number => {
  const head = thread.outbox[headIndex];
  if (head?.status !== "blocked") {
    return headIndex;
  }
  return pipe(
    EffectArray.findFirstIndex(
      thread.outbox,
      (item) =>
        item.id === deliveryFailureNoticeId(head) &&
        item.status !== "delivered" &&
        item.status !== "abandoned"
    ),
    Option.getOrElse(() => headIndex)
  );
};

const claimTurnInThread = (
  thread: WorkThreadState,
  threadId: ThreadId
): readonly [ClaimedTurn | null, WorkThreadState] | StoreError => {
  const activeTurn = pipe(
    thread.turns,
    EffectArray.findFirst(
      (turn) => turn.status === "running" || turn.status === "awaiting_delivery"
    ),
    Option.getOrNull
  );
  if (activeTurn?.status === "awaiting_delivery") {
    return [null, thread];
  }
  if (activeTurn?.status === "running") {
    const attemptNumber = activeTurn.attempts.length + 1;
    const replayed = TurnState.make({
      ...activeTurn,
      attempts: EffectArray.append(
        pipe(
          activeTurn.attempts,
          EffectArray.map((attempt, index) =>
            index === activeTurn.attempts.length - 1 &&
            attempt.status === "running"
              ? HandlerAttempt.make({ ...attempt, status: "interrupted" })
              : attempt
          )
        ),
        HandlerAttempt.make({ number: attemptNumber, status: "running" })
      ),
    });
    return [
      {
        attemptNumber,
        channelId: thread.channelId,
        context: activeTurn.context,
        id: activeTurn.id,
        messages: activeTurn.messages,
        rootTs: thread.rootTs,
        threadId,
      },
      WorkThreadState.make({
        ...thread,
        turns: replaceAt(
          thread.turns,
          findTurnIndex(thread, activeTurn.id),
          replayed
        ),
      }),
    ];
  }
  if (thread.contextStatus !== "ready" || thread.unassigned.length === 0) {
    return [null, thread];
  }
  const first = thread.unassigned[0];
  if (first === undefined) {
    return storeFailure("claimNextTurn", "empty-unassigned-invariant");
  }
  const turnId = TurnId.make(`turn:${first.id}`);
  const context = thread.turns.length === 0 ? thread.context : [];
  const turn = TurnState.make({
    attempts: [HandlerAttempt.make({ number: 1, status: "running" })],
    context,
    id: turnId,
    messages: thread.unassigned,
    outcome: null,
    status: "running",
  });
  return [
    {
      attemptNumber: 1,
      channelId: thread.channelId,
      context,
      id: turnId,
      messages: thread.unassigned,
      rootTs: thread.rootTs,
      threadId,
    },
    WorkThreadState.make({
      ...thread,
      turns: EffectArray.append(thread.turns, turn),
      unassigned: [],
    }),
  ];
};

const makeStore = Effect.fnUntraced(function* (
  laborerSlackId: string,
  initial: PrototypeState,
  persist: (
    state: PrototypeState
  ) => Effect.Effect<PersistenceResult, StoreError>
) {
  yield* validateState(initial);
  const ref = yield* Ref.make(initial);
  const persistenceHealth =
    yield* Ref.make<StorePersistenceHealth>(healthyPersistence);
  const semaphore = yield* Semaphore.make(1);

  const transition = <
    A,
    E extends StoreError | ReplyProtocolError = StoreError,
  >(
    operation: string,
    apply: Transition<A, E>
  ): Effect.Effect<A, E> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        // Only waiting for the serialized transition permit is interruptible.
        // Once acquired, validation, durable persistence, and the in-memory
        // commit are one uninterruptible critical section.
        const acquired = yield* restore(semaphore.take(1));
        return yield* Effect.gen(function* () {
          const state = yield* Ref.get(ref);
          const result = apply(state);
          if (
            result instanceof StoreError ||
            result instanceof ReplyProtocolError
          ) {
            return yield* failTransition(result as E);
          }
          const [value, next] = result as readonly [A, PrototypeState];
          yield* validateState(next).pipe(
            Effect.mapError((error) => error as E)
          );
          const persistence = yield* persist(next).pipe(
            Effect.mapError((error) => error as E)
          );
          yield* Ref.set(ref, next);
          if (persistence._tag === "PublishedWithError") {
            yield* Ref.set(persistenceHealth, {
              _tag: "Degraded",
              error: persistence.error,
              operation,
            });
            yield* Effect.logError(
              "Snapshot was published with an ancillary durability failure",
              {
                operation,
                reason: persistence.error.reason,
              }
            );
            return value;
          }
          yield* Ref.set(persistenceHealth, healthyPersistence);
          return value;
        }).pipe(Effect.ensuring(semaphore.release(acquired)));
      })
    );

  const service: PrototypeStoreShape = {
    acknowledgements: Ref.get(ref).pipe(
      Effect.map((state) => state.acknowledgements),
      Effect.mapError(() => storeFailure("acknowledgements", "read-failed"))
    ),
    accept: (event) =>
      transition("accept", (state) =>
        acceptTransition(state, event, laborerSlackId)
      ),
    markAcknowledgementActive: (id) =>
      transition("markAcknowledgementActive", (state) =>
        modifyAcknowledgement(
          state,
          id,
          "markAcknowledgementActive",
          (current) =>
            AcknowledgementState.make({
              ...current,
              lastErrorCategory: null,
              retryAtMillis: null,
              status: "active",
            })
        )
      ),
    requestAcknowledgementCleanup: (id) =>
      transition("requestAcknowledgementCleanup", (state) =>
        modifyAcknowledgement(
          state,
          id,
          "requestAcknowledgementCleanup",
          (current) =>
            AcknowledgementState.make({
              ...current,
              cleanupRequested: true,
            })
        )
      ),
    markAcknowledgementCleanupPending: (id) =>
      transition("markAcknowledgementCleanupPending", (state) =>
        modifyAcknowledgement(
          state,
          id,
          "markAcknowledgementCleanupPending",
          (current) =>
            AcknowledgementState.make({
              ...current,
              cleanupRequested: true,
              lastErrorCategory: null,
              retryAtMillis: null,
              status: "cleanup_pending",
            })
        )
      ),
    markAcknowledgementFailure: (id, category, disposition, retryAtMillis) =>
      transition("markAcknowledgementFailure", (state) =>
        modifyAcknowledgement(
          state,
          id,
          "markAcknowledgementFailure",
          (current) =>
            AcknowledgementState.make({
              ...current,
              attempts: current.attempts + 1,
              lastErrorCategory: category,
              retryAtMillis: disposition === "transient" ? retryAtMillis : null,
              status:
                disposition === "transient"
                  ? current.status
                  : "permanent_failure",
            })
        )
      ),
    completeAcknowledgement: (id) =>
      transition("completeAcknowledgement", (state) => {
        const index = pipe(
          state.acknowledgements,
          EffectArray.findFirstIndex(
            (acknowledgement) => acknowledgement.id === id
          ),
          Option.getOrElse(() => -1)
        );
        if (index < 0) {
          return storeFailure(
            "completeAcknowledgement",
            "acknowledgement-not-found"
          );
        }
        return [
          undefined,
          PrototypeStateSchema.make({
            ...state,
            acknowledgements: EffectArray.remove(state.acknowledgements, index),
          }),
        ];
      }),
    contextRequest: (threadId) =>
      Ref.get(ref).pipe(
        Effect.map((state) => {
          const thread = pipe(
            state.threads,
            EffectArray.findFirst((candidate) => candidate.id === threadId),
            Option.getOrNull
          );
          if (thread === null || thread.contextStatus === "ready") {
            return null;
          }
          return {
            activationTs: thread.activationTs,
            channelId: thread.channelId,
            isReplyActivation: thread.rootTs !== thread.activationTs,
            retryAtMillis: thread.contextRetryAtMillis,
            rootTs: thread.rootTs,
            threadId,
          } satisfies ActivationContextRequest;
        })
      ),
    markContextAttemptFailed: (threadId, retryAtMillis) =>
      transition("markContextAttemptFailed", (state) =>
        modifyThread(state, threadId, "markContextAttemptFailed", (thread) => [
          undefined,
          WorkThreadState.make({
            ...thread,
            contextAttempts: thread.contextAttempts + 1,
            contextRetryAtMillis: retryAtMillis,
          }),
        ])
      ),
    completeContext: (threadId, context, isPartial) =>
      transition("completeContext", (state) =>
        modifyThread(state, threadId, "completeContext", (thread) => [
          undefined,
          WorkThreadState.make({
            ...thread,
            context,
            contextAttempts: thread.contextAttempts + 1,
            contextIsPartial: isPartial,
            contextRetryAtMillis: null,
            contextStatus: "ready",
          }),
        ])
      ),
    claimNextTurn: (threadId) =>
      transition("claimNextTurn", (state) =>
        modifyThread(state, threadId, "claimNextTurn", (thread) =>
          claimTurnInThread(thread, threadId)
        )
      ),
    acceptPublicReply: (threadId, turnId, replyId, text) =>
      transition<undefined, StoreError | ReplyProtocolError>(
        "acceptPublicReply",
        (state) => {
          const threadIndex = findThreadIndex(state, threadId);
          const thread = state.threads[threadIndex];
          if (thread === undefined) {
            return storeFailure("acceptPublicReply", "thread-not-found");
          }
          const duplicate = pipe(
            thread.outbox,
            EffectArray.findFirst((item) => item.replyId === replyId),
            Option.getOrNull
          );
          if (duplicate !== null) {
            return duplicate.text === text
              ? ([undefined, state] as const)
              : ReplyProtocolError.make({ reason: "conflicting-reply-id" });
          }
          if (text.trim().length === 0 || findTurnIndex(thread, turnId) < 0) {
            return ReplyProtocolError.make({ reason: "invalid-public-reply" });
          }
          const nextThread = WorkThreadState.make({
            ...thread,
            outbox: EffectArray.append(
              thread.outbox,
              OutboundItem.make({
                deliveryAttempts: 0,
                id: `reply:${replyId}`,
                kind: "public_reply",
                lastErrorCategory: null,
                replyId,
                retryAtMillis: null,
                slackTs: null,
                status: "pending",
                text,
                turnId,
              })
            ),
          });
          const next = PrototypeStateSchema.make({
            ...state,
            threads: replaceAt(state.threads, threadIndex, nextThread),
          });
          return [undefined, next] as const;
        }
      ),
    completeHandler: (threadId, turnId, outcome) =>
      transition("completeHandler", (state) =>
        modifyThread(state, threadId, "completeHandler", (thread) => {
          const turnIndex = findTurnIndex(thread, turnId);
          const turn = thread.turns[turnIndex];
          if (turn === undefined) {
            return storeFailure("completeHandler", "turn-not-found");
          }
          const attempts = pipe(
            turn.attempts,
            EffectArray.map((attempt, index) =>
              index === turn.attempts.length - 1
                ? HandlerAttempt.make({
                    ...attempt,
                    status: outcome._tag === "Success" ? "succeeded" : "failed",
                  })
                : attempt
            )
          );
          const outcomeState = HandlerOutcomeState.make(
            outcome._tag === "Success"
              ? { category: null, kind: "success", safeDetail: null }
              : {
                  category: outcome.category,
                  kind: "failure",
                  safeDetail: outcome.safeDetail,
                }
          );
          const completedTurn = TurnState.make({
            ...turn,
            attempts,
            outcome: outcomeState,
            status: "awaiting_delivery",
          });
          let outbox = thread.outbox;
          if (outcome._tag === "Failure") {
            const detail =
              outcome.safeDetail === null ? "" : `: ${outcome.safeDetail}`;
            outbox = EffectArray.append(
              outbox,
              OutboundItem.make({
                deliveryAttempts: 0,
                id: `notice:${turnId}:${outcome.category}`,
                kind: "operational_notice",
                lastErrorCategory: null,
                replyId: null,
                retryAtMillis: null,
                slackTs: null,
                status: "pending",
                text: `Turn ${turnId} failed (${outcome.category}${detail}). See Runner logs.`,
                turnId,
              })
            );
          }
          return [
            undefined,
            settleEligibleTurns(
              WorkThreadState.make({
                ...thread,
                outbox,
                turns: replaceAt(thread.turns, turnIndex, completedTurn),
              })
            ),
          ];
        })
      ),
    claimOutboundHead: (threadId, nowMillis) =>
      transition("claimOutboundHead", (state) =>
        modifyThread<OutboxClaim>(
          state,
          threadId,
          "claimOutboundHead",
          (thread) => {
            const index = pipe(
              EffectArray.findFirstIndex(
                thread.outbox,
                (item) =>
                  item.status !== "delivered" && item.status !== "abandoned"
              ),
              Option.getOrElse(() => -1)
            );
            if (index < 0) {
              return [{ _tag: "None" } as const, settleEligibleTurns(thread)];
            }
            const claimIndex = nextClaimableOutboundIndex(thread, index);
            const item = thread.outbox[claimIndex];
            if (item === undefined) {
              return storeFailure(
                "claimOutboundHead",
                "outbox-index-invariant"
              );
            }
            if (item.status === "blocked") {
              return [{ _tag: "Blocked", itemId: item.id } as const, thread];
            }
            if (item.retryAtMillis !== null && item.retryAtMillis > nowMillis) {
              return [
                {
                  _tag: "Waiting",
                  wakeAtMillis: item.retryAtMillis,
                } as const,
                thread,
              ];
            }
            const delivering = OutboundItem.make({
              ...item,
              deliveryAttempts: item.deliveryAttempts + 1,
              retryAtMillis: null,
              status: "delivering",
            });
            return [
              {
                _tag: "Deliver",
                channelId: thread.channelId,
                itemId: item.id,
                rootTs: thread.rootTs,
                text: item.text,
                threadId,
                turnId: item.turnId,
              } as const,
              WorkThreadState.make({
                ...thread,
                outbox: replaceAt(thread.outbox, claimIndex, delivering),
              }),
            ];
          }
        )
      ),
    markDelivered: (threadId, itemId, slackTs) =>
      transition("markDelivered", (state) =>
        modifyThread(state, threadId, "markDelivered", (thread) => {
          const index = pipe(
            EffectArray.findFirstIndex(
              thread.outbox,
              (item) => item.id === itemId
            ),
            Option.getOrElse(() => -1)
          );
          const item = thread.outbox[index];
          if (item === undefined || item.status !== "delivering") {
            return storeFailure("markDelivered", "item-not-delivering");
          }
          return [
            undefined,
            settleEligibleTurns(
              WorkThreadState.make({
                ...thread,
                outbox: replaceAt(
                  thread.outbox,
                  index,
                  OutboundItem.make({
                    ...item,
                    lastErrorCategory: null,
                    retryAtMillis: null,
                    slackTs,
                    status: "delivered",
                  })
                ),
              })
            ),
          ];
        })
      ),
    markDeliveryFailed: (
      threadId,
      itemId,
      category,
      disposition,
      retryAtMillis
    ) =>
      transition("markDeliveryFailed", (state) =>
        modifyThread(state, threadId, "markDeliveryFailed", (thread) => {
          const index = pipe(
            EffectArray.findFirstIndex(
              thread.outbox,
              (item) => item.id === itemId
            ),
            Option.getOrElse(() => -1)
          );
          const item = thread.outbox[index];
          if (item === undefined || item.status !== "delivering") {
            return storeFailure("markDeliveryFailed", "item-not-delivering");
          }
          let outbox = replaceAt(
            thread.outbox,
            index,
            OutboundItem.make({
              ...item,
              lastErrorCategory: category,
              retryAtMillis: disposition === "transient" ? retryAtMillis : null,
              status: disposition === "transient" ? "pending" : "blocked",
            })
          );
          const noticeId = deliveryFailureNoticeId(item);
          if (
            disposition === "item-permanent" &&
            item.kind !== "operational_notice" &&
            !EffectArray.some(outbox, (candidate) => candidate.id === noticeId)
          ) {
            outbox = EffectArray.append(
              outbox,
              OutboundItem.make({
                deliveryAttempts: 0,
                id: noticeId,
                kind: "operational_notice",
                lastErrorCategory: null,
                replyId: null,
                retryAtMillis: null,
                slackTs: null,
                status: "pending",
                text: `Delivery for turn ${item.turnId} is blocked (${category}). See Runner logs.`,
                turnId: item.turnId,
              })
            );
          }
          return [undefined, WorkThreadState.make({ ...thread, outbox })];
        })
      ),
    persistenceHealth: Ref.get(persistenceHealth),
    retryBlocked: (threadId) =>
      transition("retryBlocked", (state) =>
        modifyThread(state, threadId, "retryBlocked", (thread) => {
          const index = pipe(
            EffectArray.findFirstIndex(
              thread.outbox,
              (item) => item.status === "blocked"
            ),
            Option.getOrElse(() => -1)
          );
          const item = thread.outbox[index];
          if (item === undefined) {
            return storeFailure("retryBlocked", "blocked-item-not-found");
          }
          return [
            undefined,
            WorkThreadState.make({
              ...thread,
              outbox: replaceAt(
                thread.outbox,
                index,
                OutboundItem.make({
                  ...item,
                  retryAtMillis: null,
                  status: "pending",
                })
              ),
            }),
          ];
        })
      ),
    abandonBlocked: (threadId) =>
      transition("abandonBlocked", (state) =>
        modifyThread(state, threadId, "abandonBlocked", (thread) => {
          const index = pipe(
            EffectArray.findFirstIndex(
              thread.outbox,
              (item) => item.status === "blocked"
            ),
            Option.getOrElse(() => -1)
          );
          const item = thread.outbox[index];
          if (item === undefined) {
            return storeFailure("abandonBlocked", "blocked-item-not-found");
          }
          return [
            undefined,
            settleEligibleTurns(
              WorkThreadState.make({
                ...thread,
                outbox: replaceAt(
                  thread.outbox,
                  index,
                  OutboundItem.make({ ...item, status: "abandoned" })
                ),
              })
            ),
          ];
        })
      ),
    snapshot: Ref.get(ref).pipe(
      Effect.mapError(() => storeFailure("snapshot", "read-failed"))
    ),
    threadIds: Ref.get(ref).pipe(
      Effect.map((state) =>
        pipe(
          state.threads,
          EffectArray.map((thread) => thread.id)
        )
      ),
      Effect.mapError(() => storeFailure("threadIds", "read-failed"))
    ),
  };
  return PrototypeStore.of(service);
});

const duplicateValue = (values: readonly string[]): string | null => {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      return value;
    }
    seen.add(value);
  }
  return null;
};

const expectedAttemptStatus = (
  turn: TurnState,
  index: number
): HandlerAttempt["status"] => {
  if (index < turn.attempts.length - 1) {
    return "interrupted";
  }
  if (turn.status === "running") {
    return "running";
  }
  return turn.outcome?.kind === "success" ? "succeeded" : "failed";
};

const validateAttempts = (turn: TurnState): StoreError | null => {
  if (turn.attempts.length === 0) {
    return storeFailure("validate", "missing-handler-attempt");
  }
  for (const [index, attempt] of turn.attempts.entries()) {
    if (
      !(Number.isFinite(attempt.number) && Number.isInteger(attempt.number)) ||
      attempt.number !== index + 1
    ) {
      return storeFailure("validate", "nonsequential-attempt-number");
    }
    if (attempt.status !== expectedAttemptStatus(turn, index)) {
      return storeFailure("validate", "invalid-handler-attempt-status");
    }
  }
  return null;
};

const validateOutcome = (turn: TurnState): StoreError | null => {
  if (turn.outcome === null) {
    return null;
  }
  if (
    turn.outcome.kind === "success" &&
    (turn.outcome.category !== null || turn.outcome.safeDetail !== null)
  ) {
    return storeFailure("validate", "invalid-success-outcome");
  }
  if (turn.outcome.kind === "failure" && turn.outcome.category === null) {
    return storeFailure("validate", "invalid-failure-outcome");
  }
  return null;
};

const validateMessage = (
  message: NormalizedMessage,
  channelId: string,
  classification: "context" | "input"
): StoreError | null => {
  if (message.id !== stableMessageId(channelId, message.slackTs)) {
    return storeFailure("validate", "noncanonical-message-id");
  }
  if (message.classification !== classification) {
    return storeFailure("validate", "message-classification-mismatch");
  }
  if (classification === "context" && message.isActivation) {
    return storeFailure("validate", "context-message-is-activation");
  }
  return null;
};

const validateTurn = (turn: TurnState): StoreError | null => {
  const first = turn.messages[0];
  if (first === undefined || turn.id !== `turn:${first.id}`) {
    return storeFailure("validate", "noncanonical-turn-id");
  }
  const attemptFailure = validateAttempts(turn);
  if (attemptFailure !== null) {
    return attemptFailure;
  }
  const outcomeFailure = validateOutcome(turn);
  if (outcomeFailure !== null) {
    return outcomeFailure;
  }
  const latest = turn.attempts.at(-1);
  if (
    turn.status === "running" &&
    (latest?.status !== "running" || turn.outcome !== null)
  ) {
    return storeFailure("validate", "invalid-running-turn");
  }
  if (
    turn.status !== "running" &&
    (latest?.status === "running" || turn.outcome === null)
  ) {
    return storeFailure("validate", "invalid-terminal-turn");
  }
  if (
    (turn.status === "completed" && turn.outcome?.kind !== "success") ||
    (turn.status === "failed" && turn.outcome?.kind !== "failure")
  ) {
    return storeFailure("validate", "turn-outcome-mismatch");
  }
  return null;
};

const validateOutboundItem = (
  item: OutboundItem,
  turnIds: readonly string[]
): StoreError | null => {
  if (!turnIds.includes(item.turnId)) {
    return storeFailure("validate", "outbound-turn-not-found");
  }
  const invalidPublicReply =
    item.kind === "public_reply" &&
    (item.replyId === null || item.id !== `reply:${item.replyId}`);
  const invalidNotice =
    item.kind === "operational_notice" &&
    (item.replyId !== null || !item.id.startsWith(`notice:${item.turnId}:`));
  if (invalidPublicReply || invalidNotice) {
    return storeFailure("validate", "invalid-outbound-identity");
  }
  if (item.status !== "pending" && item.retryAtMillis !== null) {
    return storeFailure("validate", "nonpending-outbound-has-retry");
  }
  if (
    item.retryAtMillis !== null &&
    (!Number.isFinite(item.retryAtMillis) || item.retryAtMillis < 0)
  ) {
    return storeFailure("validate", "invalid-outbound-retry");
  }
  if (
    !Number.isInteger(item.deliveryAttempts) ||
    item.deliveryAttempts < 0 ||
    (item.status !== "pending" && item.deliveryAttempts === 0)
  ) {
    return storeFailure("validate", "invalid-delivery-attempt-count");
  }
  const hasInvalidSlackTimestamp =
    item.status === "delivered" ? item.slackTs === null : item.slackTs !== null;
  return hasInvalidSlackTimestamp
    ? storeFailure("validate", "outbound-slack-ts-mismatch")
    : null;
};

interface ThreadIdentities {
  readonly inputIds: readonly string[];
  readonly outboundIds: readonly string[];
  readonly turnIds: readonly string[];
}

const validateThreadMetadata = (thread: WorkThreadState): StoreError | null => {
  if (thread.id !== canonicalThreadId(thread.channelId, thread.rootTs)) {
    return storeFailure("validate", "noncanonical-thread-id");
  }
  if (
    !(
      Number.isFinite(thread.contextAttempts) &&
      Number.isInteger(thread.contextAttempts)
    ) ||
    thread.contextAttempts < 0
  ) {
    return storeFailure("validate", "invalid-context-attempt-count");
  }
  const retryIsValid =
    thread.contextRetryAtMillis === null ||
    (Number.isFinite(thread.contextRetryAtMillis) &&
      thread.contextRetryAtMillis >= 0);
  if (!retryIsValid) {
    return storeFailure("validate", "invalid-context-retry");
  }
  if (thread.contextStatus === "ready") {
    return thread.contextRetryAtMillis !== null || thread.contextAttempts < 1
      ? storeFailure("validate", "invalid-ready-context-state")
      : null;
  }
  const pendingIsPristine =
    thread.context.length === 0 && !thread.contextIsPartial;
  const pendingRetryIsCoherent =
    thread.contextAttempts === 0
      ? thread.contextRetryAtMillis === null
      : thread.contextRetryAtMillis !== null;
  return pendingIsPristine && pendingRetryIsCoherent
    ? null
    : storeFailure("validate", "invalid-pending-context-state");
};

const messagesEqual = (
  left: readonly NormalizedMessage[],
  right: readonly NormalizedMessage[]
): boolean =>
  left.length === right.length &&
  left.every((message, index) => {
    const candidate = right[index];
    return (
      candidate !== undefined &&
      message.id === candidate.id &&
      message.authorKind === candidate.authorKind &&
      message.authorSlackId === candidate.authorSlackId &&
      message.classification === candidate.classification &&
      message.isActivation === candidate.isActivation &&
      message.slackTs === candidate.slackTs &&
      message.text === candidate.text
    );
  });

const validateThreadMessages = (
  thread: WorkThreadState
): readonly string[] | StoreError => {
  const inputMessages = allInputMessages(thread);
  const inputIds = inputMessages.map((message) => message.id);
  if (duplicateValue(inputIds) !== null) {
    return storeFailure("validate", "duplicate-message-id");
  }
  const activationMessages = inputMessages.filter(
    (message) => message.isActivation
  );
  if (
    activationMessages.length !== 1 ||
    activationMessages[0]?.slackTs !== thread.activationTs
  ) {
    return storeFailure("validate", "invalid-activation-message");
  }
  for (const message of inputMessages) {
    const failure = validateMessage(message, thread.channelId, "input");
    if (failure !== null) {
      return failure;
    }
  }
  for (const message of thread.context) {
    const failure = validateMessage(message, thread.channelId, "context");
    if (failure !== null) {
      return failure;
    }
  }
  return inputIds;
};

const validateThreadTurns = (
  thread: WorkThreadState,
  turnIds: readonly string[]
): StoreError | null => {
  if (duplicateValue(turnIds) !== null) {
    return storeFailure("validate", "duplicate-turn-id");
  }
  const activeTurns = thread.turns.filter(
    (turn) => turn.status === "running" || turn.status === "awaiting_delivery"
  );
  if (activeTurns.length > 1) {
    return storeFailure("validate", "multiple-active-turns");
  }
  for (const [turnIndex, turn] of thread.turns.entries()) {
    const isActive =
      turn.status === "running" || turn.status === "awaiting_delivery";
    if (isActive && turnIndex !== thread.turns.length - 1) {
      return storeFailure("validate", "active-turn-not-last");
    }
    const failure = validateTurn(turn);
    if (failure !== null) {
      return failure;
    }
    if (
      (turnIndex === 0 && !messagesEqual(turn.context, thread.context)) ||
      (turnIndex > 0 && turn.context.length > 0)
    ) {
      return storeFailure("validate", "invalid-turn-context");
    }
    for (const message of turn.context) {
      const messageFailure = validateMessage(
        message,
        thread.channelId,
        "context"
      );
      if (messageFailure !== null) {
        return messageFailure;
      }
    }
  }
  return null;
};

const isSettledOutbound = (item: OutboundItem): boolean =>
  item.status === "delivered" || item.status === "abandoned";

const isUnsettledOutbound = (item: OutboundItem): boolean =>
  item.status === "pending" ||
  item.status === "delivering" ||
  item.status === "blocked";

const validateTurnSettlement = (
  turn: TurnState,
  outbox: readonly OutboundItem[]
): StoreError | null => {
  if (turn.status === "running") {
    return EffectArray.some(outbox, (item) => item.status !== "pending")
      ? storeFailure("validate", "running-turn-with-nonpending-outbound")
      : null;
  }
  if (turn.status === "awaiting_delivery") {
    return EffectArray.some(outbox, isUnsettledOutbound)
      ? null
      : storeFailure("validate", "awaiting-turn-without-unsettled-outbound");
  }
  return EffectArray.every(outbox, isSettledOutbound)
    ? null
    : storeFailure("validate", "settled-turn-with-unsettled-outbound");
};

const validateOutboxTurnOrder = (
  outbox: readonly OutboundItem[],
  turnIds: readonly string[]
): StoreError | null => {
  let previousTurnIndex = -1;
  for (const item of outbox) {
    const turnIndex = turnIds.indexOf(item.turnId);
    if (turnIndex < previousTurnIndex) {
      return storeFailure("validate", "outbox-turn-order-mismatch");
    }
    previousTurnIndex = turnIndex;
  }
  return null;
};

const validateOperationalNotice = (
  notice: OutboundItem,
  turn: TurnState,
  outbox: readonly OutboundItem[]
): StoreError | null => {
  const handlerNoticeId =
    turn.outcome?.kind === "failure"
      ? `notice:${turn.id}:${turn.outcome.category}`
      : null;
  if (notice.id === handlerNoticeId) {
    return null;
  }
  const deliveryTarget = pipe(
    outbox,
    EffectArray.findFirst(
      (item) =>
        item.kind === "public_reply" &&
        notice.id === deliveryFailureNoticeId(item)
    ),
    Option.getOrNull
  );
  return deliveryTarget === null || deliveryTarget.turnId !== turn.id
    ? storeFailure("validate", "orphan-operational-notice")
    : null;
};

const validateTurnOutbox = (
  turn: TurnState,
  outbox: readonly OutboundItem[]
): StoreError | null => {
  const settlementFailure = validateTurnSettlement(turn, outbox);
  if (settlementFailure !== null) {
    return settlementFailure;
  }
  const notices = pipe(
    outbox,
    EffectArray.filter((item) => item.kind === "operational_notice")
  );
  for (const notice of notices) {
    const failure = validateOperationalNotice(notice, turn, outbox);
    if (failure !== null) {
      return failure;
    }
  }
  if (turn.outcome?.kind === "failure") {
    const handlerNoticeId = `notice:${turn.id}:${turn.outcome.category}`;
    if (!EffectArray.some(notices, (item) => item.id === handlerNoticeId)) {
      return storeFailure("validate", "failed-turn-without-handler-notice");
    }
  }
  return null;
};

const validateThreadOutbox = (
  thread: WorkThreadState,
  turnIds: readonly string[],
  outboundIds: readonly string[]
): StoreError | null => {
  if (duplicateValue(outboundIds) !== null) {
    return storeFailure("validate", "duplicate-outbound-id");
  }
  const replyIds = thread.outbox.flatMap((item) =>
    item.replyId === null ? [] : [item.replyId]
  );
  if (duplicateValue(replyIds) !== null) {
    return storeFailure("validate", "duplicate-reply-id");
  }
  const orderFailure = validateOutboxTurnOrder(thread.outbox, turnIds);
  if (orderFailure !== null) {
    return orderFailure;
  }
  for (const item of thread.outbox) {
    const failure = validateOutboundItem(item, turnIds);
    if (failure !== null) {
      return failure;
    }
  }
  for (const turn of thread.turns) {
    const turnOutbox = pipe(
      thread.outbox,
      EffectArray.filter((item) => item.turnId === turn.id)
    );
    const failure = validateTurnOutbox(turn, turnOutbox);
    if (failure !== null) {
      return failure;
    }
  }
  return null;
};

const validateThread = (
  thread: WorkThreadState
): ThreadIdentities | StoreError => {
  const metadataFailure = validateThreadMetadata(thread);
  if (metadataFailure !== null) {
    return metadataFailure;
  }
  const inputIds = validateThreadMessages(thread);
  if (inputIds instanceof StoreError) {
    return inputIds;
  }
  const turnIds = thread.turns.map((turn) => turn.id);
  const outboundIds = thread.outbox.map((item) => item.id);
  const turnFailure = validateThreadTurns(thread, turnIds);
  if (turnFailure !== null) {
    return turnFailure;
  }
  const outboxFailure = validateThreadOutbox(thread, turnIds, outboundIds);
  if (outboxFailure !== null) {
    return outboxFailure;
  }
  return { inputIds, outboundIds, turnIds };
};

const globalIdentityFailure = (
  inputIds: readonly string[],
  turnIds: readonly string[],
  outboundIds: readonly string[]
): StoreError | null => {
  if (duplicateValue(inputIds) !== null) {
    return storeFailure("validate", "duplicate-global-message-id");
  }
  if (duplicateValue(turnIds) !== null) {
    return storeFailure("validate", "duplicate-global-turn-id");
  }
  return duplicateValue(outboundIds) !== null
    ? storeFailure("validate", "duplicate-global-outbound-id")
    : null;
};

const validateAcknowledgements = (state: PrototypeState): StoreError | null => {
  const acknowledgementIds = state.acknowledgements.map(({ id }) => id);
  if (duplicateValue(acknowledgementIds) !== null) {
    return storeFailure("validate", "duplicate-acknowledgement-id");
  }
  for (const acknowledgement of state.acknowledgements) {
    const matchingActivationThreads = pipe(
      state.threads,
      EffectArray.filter(
        (thread) =>
          thread.channelId === acknowledgement.channelId &&
          thread.activationEventId === acknowledgement.eventId &&
          EffectArray.some(
            allInputMessages(thread),
            (message) =>
              message.isActivation &&
              message.slackTs === acknowledgement.messageTs
          )
      )
    );
    const hasRetry = acknowledgement.retryAtMillis !== null;
    const hasError = acknowledgement.lastErrorCategory !== null;
    if (
      acknowledgement.id !==
        stableAcknowledgementId(
          acknowledgement.channelId,
          acknowledgement.messageTs
        ) ||
      !EffectArray.contains(state.seenEventIds, acknowledgement.eventId) ||
      matchingActivationThreads.length !== 1 ||
      !Number.isInteger(acknowledgement.attempts) ||
      acknowledgement.attempts < 0 ||
      (hasRetry &&
        (!Number.isFinite(acknowledgement.retryAtMillis) ||
          (acknowledgement.retryAtMillis ?? -1) < 0)) ||
      (acknowledgement.status !== "permanent_failure" &&
        hasRetry !== hasError) ||
      (acknowledgement.attempts === 0 && hasError) ||
      (acknowledgement.status === "add_pending" &&
        acknowledgement.attempts > 0 &&
        !hasError) ||
      (hasError && acknowledgement.lastErrorCategory?.trim().length === 0) ||
      (acknowledgement.status === "active" && (hasRetry || hasError)) ||
      (acknowledgement.status === "cleanup_pending" &&
        !acknowledgement.cleanupRequested) ||
      (acknowledgement.status === "permanent_failure" &&
        (hasRetry || !hasError))
    ) {
      return storeFailure("validate", "invalid-acknowledgement-state");
    }
  }
  if (
    duplicateValue(
      state.acknowledgements.map(
        (acknowledgement) =>
          `${acknowledgement.channelId}:${acknowledgement.messageTs}`
      )
    ) !== null
  ) {
    return storeFailure("validate", "duplicate-activation-acknowledgement");
  }
  return null;
};

const semanticStateFailure = (state: PrototypeState): StoreError | null => {
  const acknowledgementFailure = validateAcknowledgements(state);
  if (acknowledgementFailure !== null) {
    return acknowledgementFailure;
  }
  if (duplicateValue(state.seenEventIds) !== null) {
    return storeFailure("validate", "duplicate-event-id");
  }
  if (
    EffectArray.some(
      state.ignoredInbound,
      (ignoredInbound) =>
        !EffectArray.contains(state.seenEventIds, ignoredInbound.eventId)
    )
  ) {
    return storeFailure("validate", "ignored-event-not-found");
  }
  if (duplicateValue(state.threads.map((thread) => thread.id)) !== null) {
    return storeFailure("validate", "duplicate-thread-id");
  }
  if (
    EffectArray.some(
      state.threads,
      (thread) =>
        !EffectArray.contains(state.seenEventIds, thread.activationEventId)
    )
  ) {
    return storeFailure("validate", "activation-event-not-found");
  }
  const inputIds: string[] = [];
  const turnIds: string[] = [];
  const outboundIds: string[] = [];
  for (const thread of state.threads) {
    const result = validateThread(thread);
    if (result instanceof StoreError) {
      return result;
    }
    inputIds.push(...result.inputIds);
    turnIds.push(...result.turnIds);
    outboundIds.push(...result.outboundIds);
  }
  return globalIdentityFailure(inputIds, turnIds, outboundIds);
};

const validateState = (state: PrototypeState) =>
  Schema.decodeUnknownEffect(PrototypeStateSchema, {
    onExcessProperty: "error",
  })(state).pipe(
    Effect.mapError(() => storeFailure("validate", "invalid-state")),
    Effect.flatMap((decoded) => {
      const failure = semanticStateFailure(decoded);
      return failure === null ? Effect.void : Effect.fail(failure);
    })
  );

export const makeInMemoryStoreLayer = (
  laborerSlackId: string
): Layer.Layer<PrototypeStore, StoreError> =>
  Layer.effect(
    PrototypeStore,
    makeStore(laborerSlackId, initialPrototypeState, (state) =>
      validateState(state).pipe(Effect.as(published))
    )
  );

export const makeControlledStoreLayer = (options: {
  readonly laborerSlackId: string;
  readonly persist: (state: PrototypeState) => Effect.Effect<void, StoreError>;
  readonly state?: PrototypeState;
}): Layer.Layer<PrototypeStore, StoreError> =>
  Layer.effect(
    PrototypeStore,
    makeStore(
      options.laborerSlackId,
      options.state ?? initialPrototypeState,
      (state) => options.persist(state).pipe(Effect.as(published))
    )
  );

class SnapshotMissing extends Schema.TaggedErrorClass<SnapshotMissing>()(
  "SnapshotMissing",
  {}
) {}

const isMissingFile = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  cause.code === "ENOENT";

const closeFile = async (file: FileHandle): Promise<void> => {
  await file.close();
};

const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

type SnapshotPersistenceStage =
  | "after-rename-hook"
  | "assert-target"
  | "close-directory"
  | "close-temporary-file"
  | "create-temporary-file"
  | "prepare-directory"
  | "rename"
  | "remove-temporary-file"
  | "sync-directory"
  | "sync-temporary-file"
  | "verify-directory-after-rename"
  | "verify-directory-before-rename"
  | "write-temporary-file";

type SnapshotPublicationResult =
  | { readonly _tag: "Published" }
  | {
      readonly _tag: "PublishedWithError";
      readonly failureStage: SnapshotPersistenceStage;
    };

const persistSnapshotPromise = async (
  path: string,
  state: PrototypeState,
  signal: AbortSignal,
  trustedRoot?: string,
  afterRename?: () => Promise<void>
): Promise<SnapshotPublicationResult> => {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let stage: SnapshotPersistenceStage = "prepare-directory";
  const directory = await retainTrustedDirectory(
    dirname(path),
    "persist-snapshot"
  );
  let failure:
    | { readonly cause: unknown; readonly stage: SnapshotPersistenceStage }
    | undefined;
  let wasPublished = false;
  try {
    signal.throwIfAborted();
    stage = "assert-target";
    await assertSafeFilePath({
      ...(trustedRoot === undefined ? {} : { anchor: trustedRoot }),
      operation: "persist-snapshot",
      path,
    });
    stage = "create-temporary-file";
    const file = await open(temporaryPath, "wx", 0o600);
    try {
      stage = "write-temporary-file";
      await file.writeFile(JSON.stringify(state), { encoding: "utf8", signal });
      stage = "sync-temporary-file";
      await file.sync();
    } finally {
      stage = "close-temporary-file";
      await closeFile(file);
    }
    signal.throwIfAborted();
    stage = "verify-directory-before-rename";
    await verifyRetainedDirectory(directory, "persist-snapshot");
    stage = "assert-target";
    await assertSafeFilePath({
      ...(trustedRoot === undefined ? {} : { anchor: trustedRoot }),
      operation: "persist-snapshot",
      path,
    });
    stage = "rename";
    await rename(temporaryPath, path);
    wasPublished = true;
    stage = "after-rename-hook";
    await afterRename?.();
    stage = "verify-directory-after-rename";
    await verifyRetainedDirectory(directory, "persist-snapshot");
    stage = "sync-directory";
    await directory.handle.sync();
  } catch (error) {
    failure = { cause: error, stage };
  }

  if (!wasPublished) {
    try {
      stage = "remove-temporary-file";
      await rm(temporaryPath, { force: true });
    } catch (error) {
      failure ??= { cause: error, stage };
    }
  }
  try {
    stage = "close-directory";
    await closeFile(directory.handle);
  } catch (error) {
    failure ??= { cause: error, stage };
  }

  if (failure === undefined) {
    return { _tag: "Published" };
  }
  if (wasPublished) {
    return {
      _tag: "PublishedWithError",
      failureStage: failure.stage,
    };
  }
  throw failure.cause;
};

const persistSnapshot = (
  path: string,
  state: PrototypeState,
  trustedRoot?: string,
  afterRename?: () => Promise<void>
) =>
  Effect.tryPromise({
    try: (signal) =>
      persistSnapshotPromise(path, state, signal, trustedRoot, afterRename),
    catch: () => storeFailure("persist", "snapshot-unwritable"),
  }).pipe(
    Effect.map(
      (result): PersistenceResult =>
        result._tag === "Published"
          ? published
          : {
              _tag: "PublishedWithError",
              error: storeFailure(
                "persist",
                `snapshot-published-${result.failureStage}-failed`
              ),
            }
    )
  );

const readSnapshotPromise = async (
  path: string,
  trustedRoot?: string
): Promise<unknown> => {
  const directory = await retainTrustedDirectory(
    dirname(path),
    "load-snapshot"
  );
  try {
    await assertSafeFilePath({
      ...(trustedRoot === undefined ? {} : { anchor: trustedRoot }),
      operation: "load-snapshot",
      path,
    });
    const file = await openRegularFileNoFollow(path, "load-snapshot");
    try {
      const source = fatalUtf8Decoder.decode(await file.readFile());
      await verifyRetainedDirectory(directory, "load-snapshot");
      return JSON.parse(source) as unknown;
    } finally {
      await closeFile(file);
    }
  } finally {
    await closeFile(directory.handle);
  }
};

const isUnknownRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const migrateSchemaVersionOneSnapshot = (value: unknown): unknown => {
  if (
    !isUnknownRecord(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.threads) ||
    !Array.isArray(value.seenEventIds)
  ) {
    return value;
  }

  let changed = false;
  let seenEventIds: readonly unknown[] = value.seenEventIds;
  const threads = pipe(
    value.threads,
    EffectArray.map((candidate, index) => {
      if (
        !isUnknownRecord(candidate) ||
        Object.hasOwn(candidate, "activationEventId")
      ) {
        return candidate;
      }
      const threadIdentity =
        typeof candidate.id === "string" ? candidate.id : String(index);
      const activationEventId = `migration:activation:${threadIdentity}`;
      if (!EffectArray.contains(seenEventIds, activationEventId)) {
        seenEventIds = EffectArray.append(seenEventIds, activationEventId);
      }
      changed = true;
      return { ...candidate, activationEventId };
    })
  );

  return changed ? { ...value, seenEventIds, threads } : value;
};

const loadSnapshot = (path: string, trustedRoot?: string) =>
  Effect.tryPromise({
    try: () => readSnapshotPromise(path, trustedRoot),
    catch: (cause) =>
      isMissingFile(cause)
        ? SnapshotMissing.make()
        : storeFailure("load", "snapshot-unreadable"),
  }).pipe(
    Effect.map(migrateSchemaVersionOneSnapshot),
    Effect.flatMap(
      Schema.decodeUnknownEffect(PrototypeStateSchema, {
        onExcessProperty: "error",
      })
    ),
    Effect.mapError((error) =>
      error instanceof SnapshotMissing
        ? error
        : storeFailure("load", "snapshot-invalid")
    ),
    Effect.catchTag("SnapshotMissing", () =>
      persistSnapshot(path, initialPrototypeState, trustedRoot).pipe(
        Effect.flatMap((result) =>
          result._tag === "Published"
            ? Effect.succeed(initialPrototypeState)
            : Effect.fail(result.error)
        )
      )
    )
  );

export const makeFileStoreLayer = (
  laborerSlackId: string,
  snapshotPath: string,
  trustedRoot?: string,
  testHooks?: {
    readonly afterRename?: () => Promise<void>;
  }
): Layer.Layer<PrototypeStore, StoreError> =>
  Layer.effect(
    PrototypeStore,
    Effect.gen(function* () {
      const initial = yield* loadSnapshot(snapshotPath, trustedRoot);
      return yield* makeStore(laborerSlackId, initial, (state) =>
        persistSnapshot(
          snapshotPath,
          state,
          trustedRoot,
          testHooks?.afterRename
        )
      );
    })
  );
