/**
 * THROWAWAY ISSUE #204 PROTOTYPE.
 * All queue, claim, outcome, and outbox invariants live behind this service.
 */
import { randomUUID } from "node:crypto";
import { type FileHandle, open, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, normalize } from "node:path";
import {
  Context,
  Effect,
  Array as EffectArray,
  Layer,
  Option,
  Order,
  pipe,
  Ref,
  Result,
  Schema,
  Semaphore,
  Struct,
} from "effect";
import {
  AcknowledgementState,
  ApplicationEventState,
  type ClaimedTurn,
  CompletionReactionState,
  canonicalThreadId,
  ExternalApplicationInput,
  HandlerAttempt,
  type HandlerFailureCategory,
  HandlerOutcomeState,
  type IgnoredReason,
  type InboundDecision,
  initialPrototypeState,
  type JsonArray,
  type JsonObject,
  type JsonValue,
  type NormalizedInboundEvent,
  NormalizedMessage,
  OutboundItem,
  ParticipantApplicationInput,
  type PrototypeState,
  PrototypeState as PrototypeStateSchema,
  type ReplyId,
  stableAcknowledgementId,
  stableCompletionReactionId,
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
  assertNoSymlinkPathComponents,
  assertSafeFilePath,
  canonicalDirectory,
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
  readonly acceptApplicationEvent: (event: {
    readonly conversationId: ThreadId;
    readonly eventId: string;
    readonly payload: JsonValue;
    readonly source: string;
  }) => Effect.Effect<
    | { readonly _tag: "Accepted"; readonly eventId: string }
    | { readonly _tag: "Duplicate"; readonly eventId: string },
    StoreError
  >;
  readonly acceptApplicationReply: (
    threadId: ThreadId,
    eventId: string,
    replyId: ReplyId,
    text: string
  ) => Effect.Effect<void, StoreError | ReplyProtocolError>;
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
  readonly claimNextApplicationEvent: (
    threadId: ThreadId
  ) => Effect.Effect<ApplicationEventState | null, StoreError>;
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
  readonly completeApplicationEvent: (
    threadId: ThreadId,
    eventId: string,
    outcome:
      | { readonly _tag: "Success" }
      | {
          readonly _tag: "Failure";
          readonly category: HandlerFailureCategory;
        }
  ) => Effect.Effect<void, StoreError>;
  readonly completeCompletionReaction: (
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
          readonly noticeStyle: "diagnostic" | "generic";
          readonly safeDetail: string | null;
        }
  ) => Effect.Effect<void, StoreError>;
  readonly completeInitialization: (
    threadId: ThreadId,
    workingDirectory: string
  ) => Effect.Effect<void, StoreError>;
  readonly completionReactions: Effect.Effect<
    readonly CompletionReactionState[],
    StoreError
  >;
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
  readonly markCompletionReactionFailure: (
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

const applicationEventTurnId = (eventId: string): TurnId =>
  TurnId.make(`application-event:${eventId}`);

const applicationEventFailureNoticeId = (eventId: string): string =>
  `notice:${applicationEventTurnId(eventId)}:handler-failure`;

const GENERIC_TURN_FAILURE_NOTICE =
  "This conversation turn could not be completed. Please try again.";

const turnFailureNotice = (
  turnId: TurnId,
  category: HandlerFailureCategory,
  safeDetail: string | null,
  noticeStyle: "diagnostic" | "generic"
): string => {
  if (noticeStyle === "generic") {
    return GENERIC_TURN_FAILURE_NOTICE;
  }
  const detail = safeDetail === null ? "" : `: ${safeDetail}`;
  return `Turn ${turnId} failed (${category}${detail}). See Runner logs.`;
};

const settleEligibleApplicationEvents = (
  thread: WorkThreadState
): WorkThreadState =>
  WorkThreadState.make({
    ...thread,
    applicationEvents: pipe(
      thread.applicationEvents,
      EffectArray.map((event) => {
        if (event.status !== "awaiting_delivery") {
          return event;
        }
        const hasUnsettledOutbound = pipe(
          thread.outbox,
          EffectArray.filter(
            (item) => item.turnId === applicationEventTurnId(event.eventId)
          ),
          EffectArray.some(
            (item) => item.status !== "delivered" && item.status !== "abandoned"
          )
        );
        if (hasUnsettledOutbound) {
          return event;
        }
        return ApplicationEventState.make({
          ...event,
          status: event.outcome?.kind === "failure" ? "failed" : "completed",
        });
      })
    ),
  });

const settleEligibleWork = (thread: WorkThreadState): WorkThreadState =>
  settleEligibleApplicationEvents(settleEligibleTurns(thread));

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

const modifyCompletionReaction = (
  state: PrototypeState,
  id: string,
  operation: string,
  update: (current: CompletionReactionState) => CompletionReactionState
): readonly [undefined, PrototypeState] | StoreError => {
  const index = pipe(
    state.completionReactions,
    EffectArray.findFirstIndex((reaction) => reaction.id === id),
    Option.getOrElse(() => -1)
  );
  const current = state.completionReactions[index];
  if (current === undefined) {
    return storeFailure(operation, "completion-reaction-not-found");
  }
  return [
    undefined,
    PrototypeStateSchema.make({
      ...state,
      completionReactions: replaceAt(
        state.completionReactions,
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

const durableInboundIdentity = (event: NormalizedInboundEvent) => {
  const rootTs = event.threadTs ?? event.messageTs;
  return {
    acknowledgementId: stableAcknowledgementId(
      event.channelId,
      event.messageTs,
      event.workspaceId
    ),
    messageId: stableMessageId(
      event.channelId,
      event.messageTs,
      event.workspaceId
    ),
    rootTs,
    threadId: canonicalThreadId(event.channelId, rootTs, event.workspaceId),
  };
};

const optionalWorkspaceIdentity = (
  workspaceId: string | undefined
): { readonly workspaceId?: string } =>
  workspaceId === undefined ? {} : { workspaceId };

const acceptTransition = (
  state: PrototypeState,
  event: NormalizedInboundEvent,
  laborerSlackId: string,
  initializeNewThreads: boolean
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

  const { acknowledgementId, messageId, rootTs, threadId } =
    durableInboundIdentity(event);
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
            applicationEvents: [],
            applicationInputQueue: [
              ParticipantApplicationInput.make({ messageId }),
            ],
            channelId: event.channelId,
            context: [],
            contextAttempts: 0,
            contextIsPartial: false,
            contextRetryAtMillis: null,
            contextStatus: "pending",
            id: threadId,
            initializationStatus: initializeNewThreads
              ? "pending"
              : "not_applicable",
            outbox: [],
            rootTs,
            turns: [],
            unassigned: [message],
            workingDirectory: null,
            ...optionalWorkspaceIdentity(event.workspaceId),
          })
        )
      : pipe(
          state.threads,
          EffectArray.map((thread) =>
            thread.id === threadId
              ? WorkThreadState.make({
                  ...thread,
                  applicationInputQueue: EffectArray.append(
                    thread.applicationInputQueue,
                    ParticipantApplicationInput.make({ messageId })
                  ),
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
              id: acknowledgementId,
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

const findApplicationEventIndex = (
  thread: WorkThreadState,
  eventId: string
): number =>
  pipe(
    thread.applicationEvents,
    EffectArray.findFirstIndex((event) => event.eventId === eventId),
    Option.getOrElse(() => -1)
  );

const isJsonArray = (value: JsonValue): value is JsonArray =>
  globalThis.Array.isArray(value);

const equivalentJson = (left: JsonValue, right: JsonValue): boolean => {
  if (left === right) {
    return true;
  }
  if (isJsonArray(left)) {
    return (
      isJsonArray(right) &&
      left.length === right.length &&
      EffectArray.every(left, (value, index) => {
        const candidate = right[index];
        return candidate !== undefined && equivalentJson(value, candidate);
      })
    );
  }
  if (
    isJsonArray(right) ||
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }
  const leftObject: JsonObject = left;
  const rightObject: JsonObject = right;
  const leftKeys = pipe(
    Struct.keys(leftObject),
    EffectArray.sort(Order.String)
  );
  const rightKeys = pipe(
    Struct.keys(rightObject),
    EffectArray.sort(Order.String)
  );
  if (
    leftKeys.length !== rightKeys.length ||
    !EffectArray.every(leftKeys, (key, index) => key === rightKeys[index])
  ) {
    return false;
  }
  return EffectArray.every(leftKeys, (key) => {
    const leftValue = Struct.get(leftObject, key);
    const rightValue = Struct.get(rightObject, key);
    return (
      leftValue !== undefined &&
      rightValue !== undefined &&
      equivalentJson(leftValue, rightValue)
    );
  });
};

const sameApplicationEvent = (
  current: ApplicationEventState,
  candidate: {
    readonly payload: JsonValue;
    readonly source: string;
  }
): boolean =>
  current.source === candidate.source &&
  equivalentJson(current.payload, candidate.payload);

type ApplicationEventDecision =
  | { readonly _tag: "Accepted"; readonly eventId: string }
  | { readonly _tag: "Duplicate"; readonly eventId: string };

const acceptApplicationEventTransition = (
  state: PrototypeState,
  event: {
    readonly conversationId: ThreadId;
    readonly eventId: string;
    readonly payload: JsonValue;
    readonly source: string;
  }
): readonly [ApplicationEventDecision, PrototypeState] | StoreError =>
  modifyThread<ApplicationEventDecision>(
    state,
    event.conversationId,
    "acceptApplicationEvent",
    (thread) => {
      const duplicate = pipe(
        thread.applicationEvents,
        EffectArray.findFirst(
          (candidate) => candidate.eventId === event.eventId
        ),
        Option.getOrNull
      );
      if (duplicate !== null) {
        return sameApplicationEvent(duplicate, event)
          ? [
              {
                _tag: "Duplicate" as const,
                eventId: event.eventId,
              },
              thread,
            ]
          : storeFailure(
              "acceptApplicationEvent",
              "conflicting-application-event-id"
            );
      }
      return [
        { _tag: "Accepted" as const, eventId: event.eventId },
        WorkThreadState.make({
          ...thread,
          applicationEvents: EffectArray.append(
            thread.applicationEvents,
            ApplicationEventState.make({
              eventId: event.eventId,
              outcome: null,
              payload: event.payload,
              source: event.source,
              status: "pending",
            })
          ),
          applicationInputQueue: EffectArray.append(
            thread.applicationInputQueue,
            ExternalApplicationInput.make({ eventId: event.eventId })
          ),
        }),
      ];
    }
  );

const claimApplicationEventInThread = (
  thread: WorkThreadState
): readonly [ApplicationEventState | null, WorkThreadState] => {
  const activeTurn = pipe(
    thread.turns,
    EffectArray.some(
      (turn) => turn.status === "running" || turn.status === "awaiting_delivery"
    )
  );
  if (activeTurn) {
    return [null, thread];
  }
  const activeEvent = pipe(
    thread.applicationEvents,
    EffectArray.findFirst(
      (event) =>
        event.status === "running" || event.status === "awaiting_delivery"
    ),
    Option.getOrNull
  );
  if (activeEvent !== null) {
    return activeEvent.status === "running"
      ? [activeEvent, thread]
      : [null, thread];
  }
  const head = thread.applicationInputQueue[0];
  if (head?._tag !== "ExternalInput") {
    return [null, thread];
  }
  const index = findApplicationEventIndex(thread, head.eventId);
  const event = thread.applicationEvents[index];
  if (event?.status !== "pending") {
    return [null, thread];
  }
  const running = ApplicationEventState.make({
    ...event,
    status: "running",
  });
  return [
    running,
    WorkThreadState.make({
      ...thread,
      applicationEvents: replaceAt(thread.applicationEvents, index, running),
      applicationInputQueue: EffectArray.drop(thread.applicationInputQueue, 1),
    }),
  ];
};

const enqueueEligibleCompletionReaction = (
  state: PrototypeState,
  threadId: ThreadId,
  turnId: TurnId
): PrototypeState => {
  const thread = state.threads[findThreadIndex(state, threadId)];
  const turn = thread?.turns[findTurnIndex(thread, turnId)];
  if (thread === undefined || turn?.outcome?.kind !== "success") {
    return state;
  }
  const publicReplies = pipe(
    thread.outbox,
    EffectArray.filter(
      (item) => item.turnId === turnId && item.kind === "public_reply"
    )
  );
  if (
    !EffectArray.every(publicReplies, (item) => item.status === "delivered")
  ) {
    return state;
  }
  const id = stableCompletionReactionId(turnId);
  if (
    EffectArray.some(
      state.completionReactions,
      (reaction) => reaction.id === id
    )
  ) {
    return state;
  }
  return PrototypeStateSchema.make({
    ...state,
    completionReactions: EffectArray.append(
      state.completionReactions,
      CompletionReactionState.make({
        attempts: 0,
        channelId: thread.channelId,
        id,
        lastErrorCategory: null,
        retryAtMillis: null,
        rootTs: thread.rootTs,
        status: "add_pending",
        threadId,
        turnId,
      })
    ),
  });
};

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
  if (
    EffectArray.some(
      thread.applicationEvents,
      (event) =>
        event.status === "running" || event.status === "awaiting_delivery"
    )
  ) {
    return [null, thread];
  }
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
        initializationStatus: thread.initializationStatus,
        workingDirectory: thread.workingDirectory,
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
  const queuedParticipantInputs = pipe(
    thread.applicationInputQueue,
    EffectArray.takeWhile((input) => input._tag === "ParticipantInput")
  );
  if (queuedParticipantInputs.length === 0) {
    return [null, thread];
  }
  const queuedMessageIds = pipe(
    queuedParticipantInputs,
    EffectArray.map((input) => input.messageId)
  );
  const messages = pipe(
    queuedMessageIds,
    EffectArray.filterMap((messageId) =>
      pipe(
        thread.unassigned,
        EffectArray.findFirst((message) => message.id === messageId),
        Option.match({
          onNone: () => Result.failVoid,
          onSome: Result.succeed,
        })
      )
    ),
    EffectArray.sort(inputMessageOrder)
  );
  if (messages.length !== queuedMessageIds.length) {
    return storeFailure("claimNextTurn", "queued-message-not-found");
  }
  const first = messages[0];
  if (first === undefined) {
    return storeFailure("claimNextTurn", "empty-unassigned-invariant");
  }
  const turnId = TurnId.make(`turn:${first.id}`);
  const context = thread.turns.length === 0 ? thread.context : [];
  const turn = TurnState.make({
    attempts: [HandlerAttempt.make({ number: 1, status: "running" })],
    context,
    id: turnId,
    messages,
    outcome: null,
    status: "running",
  });
  return [
    {
      attemptNumber: 1,
      channelId: thread.channelId,
      context,
      id: turnId,
      messages,
      rootTs: thread.rootTs,
      threadId,
      initializationStatus: thread.initializationStatus,
      workingDirectory: thread.workingDirectory,
    },
    WorkThreadState.make({
      ...thread,
      applicationInputQueue: EffectArray.drop(
        thread.applicationInputQueue,
        queuedParticipantInputs.length
      ),
      turns: EffectArray.append(thread.turns, turn),
      unassigned: pipe(
        thread.unassigned,
        EffectArray.filter(
          (message) => !EffectArray.contains(queuedMessageIds, message.id)
        )
      ),
    }),
  ];
};

const acceptReplyTransition = (
  state: PrototypeState,
  threadId: ThreadId,
  ownerId: TurnId,
  ownerExists: (thread: WorkThreadState) => boolean,
  replyId: ReplyId,
  text: string
): readonly [undefined, PrototypeState] | StoreError | ReplyProtocolError => {
  const threadIndex = findThreadIndex(state, threadId);
  const thread = state.threads[threadIndex];
  if (thread === undefined) {
    return storeFailure("acceptApplicationReply", "thread-not-found");
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
  if (text.trim().length === 0 || !ownerExists(thread)) {
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
        turnId: ownerId,
      })
    ),
  });
  return [
    undefined,
    PrototypeStateSchema.make({
      ...state,
      threads: replaceAt(state.threads, threadIndex, nextThread),
    }),
  ];
};

const makeStore = Effect.fnUntraced(function* (
  laborerSlackId: string,
  initializeNewThreads: boolean,
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
    completionReactions: Ref.get(ref).pipe(
      Effect.map((state) => state.completionReactions),
      Effect.mapError(() => storeFailure("completionReactions", "read-failed"))
    ),
    accept: (event) =>
      transition("accept", (state) =>
        acceptTransition(state, event, laborerSlackId, initializeNewThreads)
      ),
    acceptApplicationEvent: (event) =>
      transition("acceptApplicationEvent", (state) =>
        acceptApplicationEventTransition(state, event)
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
    markCompletionReactionFailure: (id, category, disposition, retryAtMillis) =>
      transition("markCompletionReactionFailure", (state) =>
        modifyCompletionReaction(
          state,
          id,
          "markCompletionReactionFailure",
          (current) =>
            CompletionReactionState.make({
              ...current,
              attempts: current.attempts + 1,
              lastErrorCategory: category,
              retryAtMillis: disposition === "transient" ? retryAtMillis : null,
              status:
                disposition === "transient"
                  ? "add_pending"
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
    completeCompletionReaction: (id) =>
      transition("completeCompletionReaction", (state) => {
        const index = pipe(
          state.completionReactions,
          EffectArray.findFirstIndex((reaction) => reaction.id === id),
          Option.getOrElse(() => -1)
        );
        if (index < 0) {
          return storeFailure(
            "completeCompletionReaction",
            "completion-reaction-not-found"
          );
        }
        return [
          undefined,
          PrototypeStateSchema.make({
            ...state,
            completionReactions: EffectArray.remove(
              state.completionReactions,
              index
            ),
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
    completeInitialization: (threadId, workingDirectory) =>
      transition("completeInitialization", (state) =>
        modifyThread(state, threadId, "completeInitialization", (thread) => {
          if (thread.initializationStatus !== "pending") {
            return storeFailure(
              "completeInitialization",
              "initialization-not-pending"
            );
          }
          return [
            undefined,
            WorkThreadState.make({
              ...thread,
              initializationStatus: "completed",
              workingDirectory,
            }),
          ];
        })
      ),
    claimNextTurn: (threadId) =>
      transition("claimNextTurn", (state) =>
        modifyThread(state, threadId, "claimNextTurn", (thread) =>
          claimTurnInThread(thread, threadId)
        )
      ),
    claimNextApplicationEvent: (threadId) =>
      transition("claimNextApplicationEvent", (state) =>
        modifyThread(
          state,
          threadId,
          "claimNextApplicationEvent",
          claimApplicationEventInThread
        )
      ),
    acceptPublicReply: (threadId, turnId, replyId, text) =>
      transition<undefined, StoreError | ReplyProtocolError>(
        "acceptPublicReply",
        (state) =>
          acceptReplyTransition(
            state,
            threadId,
            turnId,
            (thread) => findTurnIndex(thread, turnId) >= 0,
            replyId,
            text
          )
      ),
    acceptApplicationReply: (threadId, eventId, replyId, text) =>
      transition<undefined, StoreError | ReplyProtocolError>(
        "acceptApplicationReply",
        (state) =>
          acceptReplyTransition(
            state,
            threadId,
            applicationEventTurnId(eventId),
            (thread) => findApplicationEventIndex(thread, eventId) >= 0,
            replyId,
            text
          )
      ),
    completeApplicationEvent: (threadId, eventId, outcome) =>
      transition("completeApplicationEvent", (state) =>
        modifyThread(state, threadId, "completeApplicationEvent", (thread) => {
          const index = findApplicationEventIndex(thread, eventId);
          const event = thread.applicationEvents[index];
          if (event?.status !== "running") {
            return storeFailure(
              "completeApplicationEvent",
              "application-event-not-running"
            );
          }
          const awaitingDelivery = ApplicationEventState.make({
            ...event,
            outcome: HandlerOutcomeState.make(
              outcome._tag === "Success"
                ? { category: null, kind: "success", safeDetail: null }
                : {
                    category: outcome.category,
                    kind: "failure",
                    safeDetail: null,
                  }
            ),
            status: "awaiting_delivery",
          });
          const ownerId = applicationEventTurnId(eventId);
          const noticeId = applicationEventFailureNoticeId(eventId);
          const outbox =
            outcome._tag === "Failure" &&
            !EffectArray.some(thread.outbox, (item) => item.id === noticeId)
              ? EffectArray.append(
                  thread.outbox,
                  OutboundItem.make({
                    deliveryAttempts: 0,
                    id: noticeId,
                    kind: "operational_notice",
                    lastErrorCategory: null,
                    replyId: null,
                    retryAtMillis: null,
                    slackTs: null,
                    status: "pending",
                    text: "Application event failed. See Runner logs.",
                    turnId: ownerId,
                  })
                )
              : thread.outbox;
          return [
            undefined,
            settleEligibleApplicationEvents(
              WorkThreadState.make({
                ...thread,
                applicationEvents: replaceAt(
                  thread.applicationEvents,
                  index,
                  awaitingDelivery
                ),
                outbox,
              })
            ),
          ];
        })
      ),
    completeHandler: (threadId, turnId, outcome) =>
      transition("completeHandler", (state) => {
        const result = modifyThread(
          state,
          threadId,
          "completeHandler",
          (thread) => {
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
                      status:
                        outcome._tag === "Success" ? "succeeded" : "failed",
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
                  text: turnFailureNotice(
                    turnId,
                    outcome.category,
                    outcome.safeDetail,
                    outcome.noticeStyle
                  ),
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
          }
        );
        if (result instanceof StoreError) {
          return result;
        }
        const [value, next] = result;
        return [
          value,
          enqueueEligibleCompletionReaction(next, threadId, turnId),
        ];
      }),
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
              return [{ _tag: "None" } as const, settleEligibleWork(thread)];
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
      transition("markDelivered", (state) => {
        let deliveredTurnId: TurnId | null = null;
        const result = modifyThread(
          state,
          threadId,
          "markDelivered",
          (thread) => {
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
            deliveredTurnId = item.turnId;
            return [
              undefined,
              settleEligibleWork(
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
          }
        );
        if (result instanceof StoreError || deliveredTurnId === null) {
          return result;
        }
        const [value, next] = result;
        return [
          value,
          enqueueEligibleCompletionReaction(next, threadId, deliveredTurnId),
        ];
      }),
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
            settleEligibleWork(
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
  classification: "context" | "input",
  workspaceId?: string
): StoreError | null => {
  if (message.id !== stableMessageId(channelId, message.slackTs, workspaceId)) {
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
  ownerIds: readonly string[]
): StoreError | null => {
  if (!ownerIds.includes(item.turnId)) {
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

const hasValidThreadInitialization = (thread: WorkThreadState): boolean => {
  if (thread.initializationStatus !== "completed") {
    return thread.workingDirectory === null;
  }
  if (thread.workingDirectory === null) {
    return false;
  }
  return (
    thread.workingDirectory.trim().length > 0 &&
    isAbsolute(thread.workingDirectory) &&
    normalize(thread.workingDirectory) === thread.workingDirectory
  );
};

const validateThreadMetadata = (thread: WorkThreadState): StoreError | null => {
  if (
    thread.id !==
    canonicalThreadId(thread.channelId, thread.rootTs, thread.workspaceId)
  ) {
    return storeFailure("validate", "noncanonical-thread-id");
  }
  if (!hasValidThreadInitialization(thread)) {
    return storeFailure("validate", "invalid-thread-initialization-state");
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
    const failure = validateMessage(
      message,
      thread.channelId,
      "input",
      thread.workspaceId
    );
    if (failure !== null) {
      return failure;
    }
  }
  for (const message of thread.context) {
    const failure = validateMessage(
      message,
      thread.channelId,
      "context",
      thread.workspaceId
    );
    if (failure !== null) {
      return failure;
    }
  }
  return inputIds;
};

const validateApplicationInputQueue = (
  thread: WorkThreadState
): StoreError | null => {
  const queuedParticipantIds = pipe(
    thread.applicationInputQueue,
    EffectArray.filterMap((input) =>
      input._tag === "ParticipantInput"
        ? Result.succeed(input.messageId)
        : Result.failVoid
    )
  );
  const unassignedIds = pipe(
    thread.unassigned,
    EffectArray.map((message) => message.id)
  );
  if (
    duplicateValue(queuedParticipantIds) !== null ||
    queuedParticipantIds.length !== unassignedIds.length ||
    !EffectArray.every(queuedParticipantIds, (id) =>
      EffectArray.contains(unassignedIds, id)
    )
  ) {
    return storeFailure("validate", "participant-input-queue-mismatch");
  }
  const queuedExternalIds = pipe(
    thread.applicationInputQueue,
    EffectArray.filterMap((input) =>
      input._tag === "ExternalInput"
        ? Result.succeed(input.eventId)
        : Result.failVoid
    )
  );
  const pendingExternalIds = pipe(
    thread.applicationEvents,
    EffectArray.filter((event) => event.status === "pending"),
    EffectArray.map((event) => event.eventId)
  );
  return duplicateValue(queuedExternalIds) !== null ||
    queuedExternalIds.length !== pendingExternalIds.length ||
    !EffectArray.every(queuedExternalIds, (id) =>
      EffectArray.contains(pendingExternalIds, id)
    )
    ? storeFailure("validate", "external-input-queue-mismatch")
    : null;
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
        "context",
        thread.workspaceId
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
    if (turnIndex < 0) {
      continue;
    }
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

const validateApplicationEventOutcome = (
  event: ApplicationEventState
): StoreError | null => {
  const isActive = event.status === "pending" || event.status === "running";
  if (
    (isActive && event.outcome !== null) ||
    (!isActive && event.outcome === null)
  ) {
    return storeFailure("validate", "application-event-outcome-mismatch");
  }
  if (
    event.outcome?.kind === "success" &&
    (event.outcome.category !== null || event.outcome.safeDetail !== null)
  ) {
    return storeFailure("validate", "invalid-application-event-success");
  }
  if (
    event.outcome?.kind === "failure" &&
    (event.outcome.category === null || event.outcome.safeDetail !== null)
  ) {
    return storeFailure("validate", "invalid-application-event-failure");
  }
  if (
    (event.status === "completed" && event.outcome?.kind !== "success") ||
    (event.status === "failed" && event.outcome?.kind !== "failure")
  ) {
    return storeFailure("validate", "application-event-status-mismatch");
  }
  return null;
};

const validateApplicationEventSettlement = (
  event: ApplicationEventState,
  outbox: readonly OutboundItem[]
): StoreError | null => {
  if (event.status === "pending" && outbox.length > 0) {
    return storeFailure("validate", "pending-application-event-with-outbound");
  }
  if (
    event.status === "running" &&
    EffectArray.some(outbox, (item) => item.status !== "pending")
  ) {
    return storeFailure(
      "validate",
      "running-application-event-with-nonpending-outbound"
    );
  }
  if (
    event.status === "awaiting_delivery" &&
    !EffectArray.some(outbox, isUnsettledOutbound)
  ) {
    return storeFailure(
      "validate",
      "awaiting-application-event-without-unsettled-outbound"
    );
  }
  if (
    (event.status === "completed" || event.status === "failed") &&
    !EffectArray.every(outbox, isSettledOutbound)
  ) {
    return storeFailure(
      "validate",
      "settled-application-event-with-unsettled-outbound"
    );
  }
  return null;
};

const validateApplicationEventFailureNotice = (
  event: ApplicationEventState,
  outbox: readonly OutboundItem[]
): StoreError | null => {
  const failureNoticeId = applicationEventFailureNoticeId(event.eventId);
  const failureNotices = pipe(
    outbox,
    EffectArray.filter((item) => item.id === failureNoticeId)
  );
  if (event.outcome?.kind === "failure") {
    return failureNotices.length === 1 &&
      failureNotices[0]?.kind === "operational_notice" &&
      failureNotices[0]?.text === "Application event failed. See Runner logs."
      ? null
      : storeFailure(
          "validate",
          "failed-application-event-without-sanitized-notice"
        );
  }
  return failureNotices.length === 0
    ? null
    : storeFailure(
        "validate",
        "successful-application-event-with-failure-notice"
      );
};

const validateApplicationEventOutbox = (
  event: ApplicationEventState,
  outbox: readonly OutboundItem[]
): StoreError | null => {
  const outcomeFailure = validateApplicationEventOutcome(event);
  if (outcomeFailure !== null) {
    return outcomeFailure;
  }
  const settlementFailure = validateApplicationEventSettlement(event, outbox);
  return (
    settlementFailure ?? validateApplicationEventFailureNotice(event, outbox)
  );
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
    const applicationEventOwnerIds = pipe(
      thread.applicationEvents,
      EffectArray.map((event) => applicationEventTurnId(event.eventId))
    );
    const failure = validateOutboundItem(
      item,
      EffectArray.appendAll(turnIds, applicationEventOwnerIds)
    );
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
  for (const event of thread.applicationEvents) {
    const eventOutbox = pipe(
      thread.outbox,
      EffectArray.filter(
        (item) => item.turnId === applicationEventTurnId(event.eventId)
      )
    );
    const failure = validateApplicationEventOutbox(event, eventOutbox);
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
  const applicationInputQueueFailure = validateApplicationInputQueue(thread);
  if (applicationInputQueueFailure !== null) {
    return applicationInputQueueFailure;
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
          acknowledgement.messageTs,
          matchingActivationThreads[0]?.workspaceId
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

const validateCompletionReactions = (
  state: PrototypeState
): StoreError | null => {
  if (
    duplicateValue(state.completionReactions.map((reaction) => reaction.id)) !==
      null ||
    duplicateValue(
      state.completionReactions.map((reaction) => reaction.turnId)
    ) !== null
  ) {
    return storeFailure("validate", "duplicate-completion-reaction");
  }
  for (const reaction of state.completionReactions) {
    const thread = pipe(
      state.threads,
      EffectArray.findFirst((candidate) => candidate.id === reaction.threadId),
      Option.getOrNull
    );
    const turn =
      thread === null
        ? undefined
        : thread.turns[findTurnIndex(thread, reaction.turnId)];
    const publicReplies =
      thread === null
        ? []
        : pipe(
            thread.outbox,
            EffectArray.filter(
              (item) =>
                item.turnId === reaction.turnId && item.kind === "public_reply"
            )
          );
    const hasRetry = reaction.retryAtMillis !== null;
    const hasError = reaction.lastErrorCategory !== null;
    if (
      reaction.id !== stableCompletionReactionId(reaction.turnId) ||
      thread === null ||
      reaction.channelId !== thread.channelId ||
      reaction.rootTs !== thread.rootTs ||
      turn?.outcome?.kind !== "success" ||
      !EffectArray.every(
        publicReplies,
        (item) => item.status === "delivered"
      ) ||
      !Number.isInteger(reaction.attempts) ||
      reaction.attempts < 0 ||
      (hasRetry &&
        (!Number.isFinite(reaction.retryAtMillis) ||
          (reaction.retryAtMillis ?? -1) < 0)) ||
      (reaction.status === "add_pending" && hasRetry !== hasError) ||
      (reaction.attempts === 0 && hasError) ||
      (reaction.attempts > 0 &&
        reaction.status === "add_pending" &&
        !hasError) ||
      (hasError && reaction.lastErrorCategory?.trim().length === 0) ||
      (reaction.status === "permanent_failure" && (hasRetry || !hasError))
    ) {
      return storeFailure("validate", "invalid-completion-reaction-state");
    }
  }
  return null;
};

const semanticStateFailure = (state: PrototypeState): StoreError | null => {
  const acknowledgementFailure = validateAcknowledgements(state);
  if (acknowledgementFailure !== null) {
    return acknowledgementFailure;
  }
  const completionReactionFailure = validateCompletionReactions(state);
  if (completionReactionFailure !== null) {
    return completionReactionFailure;
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
  laborerSlackId: string,
  options?: { readonly initializeNewThreads?: boolean }
): Layer.Layer<PrototypeStore, StoreError> =>
  Layer.effect(
    PrototypeStore,
    makeStore(
      laborerSlackId,
      options?.initializeNewThreads ?? false,
      initialPrototypeState,
      (state) => validateState(state).pipe(Effect.as(published))
    )
  );

export const makeControlledStoreLayer = (options: {
  readonly initializeNewThreads?: boolean;
  readonly laborerSlackId: string;
  readonly persist: (state: PrototypeState) => Effect.Effect<void, StoreError>;
  readonly state?: PrototypeState;
}): Layer.Layer<PrototypeStore, StoreError> =>
  Layer.effect(
    PrototypeStore,
    makeStore(
      options.laborerSlackId,
      options.initializeNewThreads ?? false,
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

const migrateApplicationEventOutcomes = (
  value: unknown
): { readonly changed: boolean; readonly value: unknown } => {
  if (!Array.isArray(value)) {
    return { changed: false, value };
  }
  const changed = EffectArray.some(
    value,
    (event) => isUnknownRecord(event) && !Object.hasOwn(event, "outcome")
  );
  if (!changed) {
    return { changed: false, value };
  }
  return {
    changed: true,
    value: pipe(
      value,
      EffectArray.map((event) => {
        if (!isUnknownRecord(event) || Object.hasOwn(event, "outcome")) {
          return event;
        }
        const isPreviouslyCompleted =
          event.status === "awaiting_delivery" || event.status === "completed";
        return {
          ...event,
          outcome: isPreviouslyCompleted
            ? { category: null, kind: "success", safeDetail: null }
            : null,
        };
      })
    ),
  };
};

const participantInputQueueFromUnassigned = (
  value: unknown
): readonly unknown[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return pipe(
    value,
    EffectArray.flatMap((message) =>
      isUnknownRecord(message) && typeof message.id === "string"
        ? [{ _tag: "ParticipantInput", messageId: message.id }]
        : []
    )
  );
};

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
  const needsCompletionReactions = !Object.hasOwn(value, "completionReactions");
  changed = needsCompletionReactions;
  const threads = pipe(
    value.threads,
    EffectArray.map((candidate, index) => {
      if (!isUnknownRecord(candidate)) {
        return candidate;
      }
      const threadIdentity =
        typeof candidate.id === "string" ? candidate.id : String(index);
      const activationEventId = Object.hasOwn(candidate, "activationEventId")
        ? candidate.activationEventId
        : `migration:activation:${threadIdentity}`;
      const needsActivationEventId = !Object.hasOwn(
        candidate,
        "activationEventId"
      );
      if (
        needsActivationEventId &&
        typeof activationEventId === "string" &&
        !EffectArray.contains(seenEventIds, activationEventId)
      ) {
        seenEventIds = EffectArray.append(seenEventIds, activationEventId);
      }
      const needsInitializationStatus = !Object.hasOwn(
        candidate,
        "initializationStatus"
      );
      const needsWorkingDirectory = !Object.hasOwn(
        candidate,
        "workingDirectory"
      );
      const needsApplicationInputQueue = !Object.hasOwn(
        candidate,
        "applicationInputQueue"
      );
      const applicationInputQueue = participantInputQueueFromUnassigned(
        candidate.unassigned
      );
      const applicationEventMigration = migrateApplicationEventOutcomes(
        candidate.applicationEvents
      );
      changed =
        changed ||
        needsActivationEventId ||
        needsInitializationStatus ||
        needsWorkingDirectory ||
        needsApplicationInputQueue ||
        applicationEventMigration.changed;
      return {
        ...candidate,
        ...(needsActivationEventId ? { activationEventId } : {}),
        ...(needsInitializationStatus
          ? { initializationStatus: "not_applicable" }
          : {}),
        ...(needsWorkingDirectory ? { workingDirectory: null } : {}),
        ...(needsApplicationInputQueue ? { applicationInputQueue } : {}),
        ...(applicationEventMigration.changed
          ? { applicationEvents: applicationEventMigration.value }
          : {}),
      };
    })
  );

  return changed
    ? {
        ...value,
        ...(needsCompletionReactions ? { completionReactions: [] } : {}),
        seenEventIds,
        threads,
      }
    : value;
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
    Effect.tap((state) =>
      Effect.forEach(
        state.threads,
        (thread) => {
          if (
            thread.initializationStatus !== "completed" ||
            thread.workingDirectory === null
          ) {
            return Effect.void;
          }
          return Effect.tryPromise({
            try: async () => {
              await assertNoSymlinkPathComponents(
                thread.workingDirectory ?? "",
                "load-thread-working-directory"
              );
              const canonical = await canonicalDirectory(
                thread.workingDirectory ?? "",
                "load-thread-working-directory"
              );
              if (canonical !== thread.workingDirectory) {
                throw new Error("working directory is not canonical");
              }
            },
            catch: () => storeFailure("load", "working-directory-invalid"),
          });
        },
        { discard: true }
      )
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
  },
  options?: { readonly initializeNewThreads?: boolean }
): Layer.Layer<PrototypeStore, StoreError> =>
  Layer.effect(
    PrototypeStore,
    Effect.gen(function* () {
      const initial = yield* loadSnapshot(snapshotPath, trustedRoot);
      return yield* makeStore(
        laborerSlackId,
        options?.initializeNewThreads ?? false,
        initial,
        (state) =>
          persistSnapshot(
            snapshotPath,
            state,
            trustedRoot,
            testHooks?.afterRename
          )
      );
    })
  );
