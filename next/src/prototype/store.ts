/**
 * THROWAWAY ISSUE #204 PROTOTYPE.
 * All queue, claim, outcome, and outbox invariants live behind this service.
 */
import { randomUUID } from "node:crypto";
import { type FileHandle, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
  Context,
  Effect,
  Array as EffectArray,
  Layer,
  Option,
  Order,
  pipe,
  Schema,
  SynchronizedRef,
} from "effect";
import {
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
  readonly claimNextTurn: (
    threadId: ThreadId
  ) => Effect.Effect<ClaimedTurn | null, StoreError>;
  readonly claimOutboundHead: (
    threadId: ThreadId,
    nowMillis: number
  ) => Effect.Effect<OutboxClaim, StoreError>;
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
  readonly retryBlocked: (
    threadId: ThreadId
  ) => Effect.Effect<void, StoreError>;
  readonly snapshot: Effect.Effect<PrototypeState, StoreError>;
  readonly threadIds: Effect.Effect<readonly ThreadId[], StoreError>;
}

export class PrototypeStore extends Context.Service<
  PrototypeStore,
  PrototypeStoreShape
>()("@laborer/issue-204/PrototypeStore") {}

type Transition<A> = (
  state: PrototypeState
) => readonly [A, PrototypeState] | StoreError;

const storeFailure = (operation: string, reason: string): StoreError =>
  StoreError.make({ operation, reason });

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
  persist: (state: PrototypeState) => Effect.Effect<void, StoreError>
) {
  yield* validateState(initial);
  const ref = yield* SynchronizedRef.make(initial);

  const transition = <A>(_operation: string, apply: Transition<A>) =>
    SynchronizedRef.modifyEffect(ref, (state) => {
      const result = apply(state);
      if (result instanceof StoreError) {
        return Effect.fail(result);
      }
      const [value, next] = result;
      return validateState(next).pipe(
        Effect.andThen(persist(next)),
        Effect.as([value, next] as const)
      );
    });

  const service: PrototypeStoreShape = {
    accept: (event) =>
      transition("accept", (state) =>
        acceptTransition(state, event, laborerSlackId)
      ),
    contextRequest: (threadId) =>
      SynchronizedRef.get(ref).pipe(
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
      SynchronizedRef.modifyEffect<
        PrototypeState,
        undefined,
        StoreError | ReplyProtocolError,
        never
      >(ref, (state) => {
        const threadIndex = findThreadIndex(state, threadId);
        const thread = state.threads[threadIndex];
        if (thread === undefined) {
          return Effect.fail(
            storeFailure("acceptPublicReply", "thread-not-found")
          );
        }
        const duplicate = pipe(
          thread.outbox,
          EffectArray.findFirst((item) => item.replyId === replyId),
          Option.getOrNull
        );
        if (duplicate !== null) {
          return duplicate.text === text
            ? Effect.succeed([undefined, state] as const)
            : Effect.fail(
                ReplyProtocolError.make({ reason: "conflicting-reply-id" })
              );
        }
        if (text.trim().length === 0 || findTurnIndex(thread, turnId) < 0) {
          return Effect.fail(
            ReplyProtocolError.make({ reason: "invalid-public-reply" })
          );
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
        return validateState(next).pipe(
          Effect.andThen(persist(next)),
          Effect.as([undefined, next] as const)
        );
      }),
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
    snapshot: SynchronizedRef.get(ref).pipe(
      Effect.mapError(() => storeFailure("snapshot", "read-failed"))
    ),
    threadIds: SynchronizedRef.get(ref).pipe(
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
    if (attempt.number !== index + 1) {
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
    thread.contextStatus === "ready" &&
    thread.contextRetryAtMillis !== null
  ) {
    return storeFailure("validate", "ready-context-has-retry");
  }
  return !Number.isInteger(thread.contextAttempts) || thread.contextAttempts < 0
    ? storeFailure("validate", "invalid-context-attempt-count")
    : null;
};

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

const semanticStateFailure = (state: PrototypeState): StoreError | null => {
  if (duplicateValue(state.seenEventIds) !== null) {
    return storeFailure("validate", "duplicate-event-id");
  }
  if (duplicateValue(state.threads.map((thread) => thread.id)) !== null) {
    return storeFailure("validate", "duplicate-thread-id");
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
  Schema.decodeUnknownEffect(PrototypeStateSchema)(state).pipe(
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
    makeStore(laborerSlackId, initialPrototypeState, validateState)
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
      options.persist
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

const persistSnapshotPromise = async (
  path: string,
  state: PrototypeState,
  signal: AbortSignal
): Promise<void> => {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    signal.throwIfAborted();
    const file = await open(temporaryPath, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(state), { encoding: "utf8", signal });
      await file.sync();
    } finally {
      await closeFile(file);
    }
    signal.throwIfAborted();
    await rename(temporaryPath, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await closeFile(directory);
    }
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
};

const persistSnapshot = (path: string, state: PrototypeState) =>
  Effect.tryPromise({
    try: (signal) => persistSnapshotPromise(path, state, signal),
    catch: () => storeFailure("persist", "snapshot-unwritable"),
  });

const loadSnapshot = (path: string) =>
  Effect.tryPromise({
    try: async () => JSON.parse(await readFile(path, "utf8")) as unknown,
    catch: (cause) =>
      isMissingFile(cause)
        ? SnapshotMissing.make()
        : storeFailure("load", "snapshot-unreadable"),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(PrototypeStateSchema)),
    Effect.mapError((error) =>
      error instanceof SnapshotMissing
        ? error
        : storeFailure("load", "snapshot-invalid")
    ),
    Effect.catchTag("SnapshotMissing", () =>
      persistSnapshot(path, initialPrototypeState).pipe(
        Effect.as(initialPrototypeState)
      )
    )
  );

export const makeFileStoreLayer = (
  laborerSlackId: string,
  snapshotPath: string
): Layer.Layer<PrototypeStore, StoreError> =>
  Layer.effect(
    PrototypeStore,
    Effect.gen(function* () {
      const initial = yield* loadSnapshot(snapshotPath);
      return yield* makeStore(laborerSlackId, initial, (state) =>
        persistSnapshot(snapshotPath, state)
      );
    })
  );
