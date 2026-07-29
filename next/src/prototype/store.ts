/**
 * THROWAWAY ISSUE #204 PROTOTYPE.
 * All queue, claim, outcome, and outbox invariants live behind this service.
 */
import { createHash, randomUUID } from "node:crypto";
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
  SLACK_MARKDOWN_TEXT_CODE_POINT_LIMIT,
  slackCodePointLength,
} from "../slack/message-bounds.ts";
import {
  AcknowledgementState,
  ApplicationEventState,
  type ClaimedTurn,
  CompletionReactionState,
  ConversationBlockedState,
  ConversationStreamChunkEvidence,
  ConversationStreamChunkHashEvidence,
  type ConversationStreamMode,
  ConversationStreamOperation,
  ConversationStreamOperationEvidence,
  type ConversationStreamOperationKind,
  type ConversationStreamOperationOutcomeCertainty,
  type ConversationStreamOwnerKind,
  ConversationStreamRateBudget,
  ConversationStreamState,
  ConversationStreamTombstone,
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
import {
  type RecoveryNoticeKind,
  recoveryNoticeText,
} from "./recovery-notice.ts";

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
      readonly workspaceId: string;
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
  readonly acceptConversationStreamChunk: (request: {
    readonly messageId: string;
    readonly nowMillis: number;
    readonly ownerId: string;
    readonly ownerKind: ConversationStreamOwnerKind;
    readonly sequence: number | null;
    readonly text: string;
    readonly threadId: ThreadId;
  }) => Effect.Effect<
    | { readonly _tag: "Accepted"; readonly streamId: string }
    | { readonly _tag: "Duplicate"; readonly streamId: string },
    StoreError
  >;
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
  readonly blockConversationOwner: (
    blocked: ConversationBlockedState
  ) => Effect.Effect<void, StoreError>;
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
  readonly completeConversationStreamLocally: (
    streamId: string,
    terminalReason: string,
    nowMillis: number
  ) => Effect.Effect<void, StoreError>;
  readonly completeFallbackConversationStream: (
    streamId: string,
    terminalReason: string,
    nowMillis: number
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
  readonly configureConversationStream: (request: {
    readonly flushDeadlineMillis: number | null;
    readonly mode: ConversationStreamMode;
    readonly streamId: string;
  }) => Effect.Effect<void, StoreError>;
  readonly contextRequest: (
    threadId: ThreadId
  ) => Effect.Effect<ActivationContextRequest | null, StoreError>;
  readonly conversationStreams: Effect.Effect<
    readonly ConversationStreamState[],
    StoreError
  >;
  readonly conversationStreamTombstones: Effect.Effect<
    readonly ConversationStreamTombstone[],
    StoreError
  >;
  readonly deferSlackRateBudget: (request: {
    readonly method: string;
    readonly retryAtMillis: number;
    readonly workspaceId: string;
  }) => Effect.Effect<void, StoreError>;
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
  readonly markConversationStreamOperationInFlight: (
    operationId: string,
    nowMillis: number
  ) => Effect.Effect<void, StoreError>;
  readonly markConversationStreamUnresolved: (
    streamId: string,
    terminalReason: string,
    nowMillis: number
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
  readonly prepareConversationStreamOperation: (request: {
    readonly kind: ConversationStreamOperationKind;
    readonly nowMillis: number;
    readonly payloadEndOffset: number;
    readonly payloadStartOffset: number;
    readonly payloadText: string;
    readonly streamId: string;
  }) => Effect.Effect<
    | {
        readonly _tag: "Prepared";
        readonly operation: ConversationStreamOperation;
      }
    | { readonly _tag: "Unresolved" },
    StoreError
  >;
  readonly reconcileConversationStreamsOnRestart: (
    nowMillis: number
  ) => Effect.Effect<readonly string[], StoreError>;
  readonly requestAcknowledgementCleanup: (
    id: string
  ) => Effect.Effect<void, StoreError>;
  readonly requestConversationStreamFinalization: (request: {
    readonly ownerId: string;
    readonly ownerKind: ConversationStreamOwnerKind;
    readonly terminalReason: string;
    readonly threadId: ThreadId;
  }) => Effect.Effect<readonly string[], StoreError>;
  readonly reserveConversationStreamRateSlot: (request: {
    readonly nowMillis: number;
    readonly operationId: string;
    readonly spacingMillis: number;
  }) => Effect.Effect<number, StoreError>;
  readonly reserveSlackRateSlot: (request: {
    readonly channelId: string;
    readonly channelSpacingMillis: number;
    readonly method: string;
    readonly methodSpacingMillis: number;
    readonly nowMillis: number;
    readonly workspaceId: string;
  }) => Effect.Effect<number, StoreError>;
  readonly resolveConversationBlocked: (request: {
    readonly attemptId: string;
    readonly conversationId: ThreadId;
    readonly decisionId: string;
    readonly kind: "abandon" | "retry";
    readonly ownerId: string;
    readonly ownerKind: ConversationStreamOwnerKind;
    readonly replacementAttemptId: string | null;
    readonly workspaceId: string;
  }) => Effect.Effect<"AlreadyResolved" | "Resolved", StoreError>;
  readonly retryBlocked: (
    threadId: ThreadId
  ) => Effect.Effect<void, StoreError>;
  readonly settleConversationStreamOperation: (request: {
    readonly category: string | null;
    readonly certainty: ConversationStreamOperationOutcomeCertainty | null;
    readonly nowMillis: number;
    readonly operationId: string;
    readonly outcome:
      | "acknowledged"
      | "rejected"
      | "retry"
      | "stopped_by_user"
      | "unresolved";
    readonly retryAtMillis: number | null;
    readonly slackTs: string | null;
  }) => Effect.Effect<void, StoreError>;
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

const MAX_CONVERSATION_STREAMS = 256;
const MAX_CONVERSATION_STREAM_CHUNKS = 1024;
const MAX_CONVERSATION_STREAM_OPERATIONS = 64;
const MAX_CONVERSATION_STREAM_OPERATION_ATTEMPTS = 5;
const MAX_CONVERSATION_STREAM_RATE_BUDGETS = 128;
const MAX_RUNNER_STATE_BYTES = 4 * 1024 * 1024;
const MAX_RETAINED_STOPPED_STREAMS = 32;
const MAX_CONVERSATION_STREAM_TOMBSTONES = 256;
const MAX_CONVERSATION_STREAM_TOMBSTONE_BYTES = 512 * 1024;
const CONVERSATION_STREAM_TOMBSTONE_RETENTION_MILLIS = 7 * 24 * 60 * 60 * 1000;

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export const stableConversationStreamId = (request: {
  readonly messageId: string;
  readonly ownerId: string;
  readonly ownerKind: ConversationStreamOwnerKind;
  readonly threadId: ThreadId;
  readonly workspaceId: string;
}): string =>
  `stream:${sha256(
    JSON.stringify([
      request.workspaceId,
      request.threadId,
      request.ownerKind,
      request.ownerId,
      request.messageId,
    ])
  )}`;

type ConversationStreamChunkDecision =
  | { readonly _tag: "Accepted"; readonly streamId: string }
  | { readonly _tag: "Duplicate"; readonly streamId: string };

const latestHumanRecipient = (thread: WorkThreadState): string | null => {
  let recipient: string | null = null;
  for (const turn of thread.turns) {
    for (const message of turn.messages) {
      if (message.authorKind === "human") {
        recipient = message.authorSlackId;
      }
    }
  }
  for (const message of thread.unassigned) {
    if (message.authorKind === "human") {
      recipient = message.authorSlackId;
    }
  }
  return recipient;
};

const conversationStreamRecipient = (
  thread: WorkThreadState,
  ownerKind: ConversationStreamOwnerKind,
  ownerId: string
): string | null => {
  if (ownerKind === "application-event") {
    return latestHumanRecipient(thread);
  }
  const turn = thread.turns.find((candidate) => candidate.id === ownerId);
  let recipient: string | null = null;
  for (const message of turn?.messages ?? []) {
    if (message.authorKind === "human") {
      recipient = message.authorSlackId;
    }
  }
  return recipient;
};

const conversationStreamOwnerExists = (
  thread: WorkThreadState,
  ownerKind: ConversationStreamOwnerKind,
  ownerId: string
): boolean =>
  ownerKind === "participant-turn"
    ? thread.turns.some((turn) => turn.id === ownerId)
    : thread.applicationEvents.some((event) => event.eventId === ownerId);

const conversationStreamOwnerIsRunning = (
  thread: WorkThreadState,
  ownerKind: ConversationStreamOwnerKind,
  ownerId: string
): boolean =>
  ownerKind === "participant-turn"
    ? thread.turns.some(
        (turn) => turn.id === ownerId && turn.status === "running"
      )
    : thread.applicationEvents.some(
        (event) => event.eventId === ownerId && event.status === "running"
      );

const recipientBelongsToConversationStreamOwner = (
  thread: WorkThreadState,
  ownerKind: ConversationStreamOwnerKind,
  ownerId: string,
  recipientUserId: string | null
): boolean => {
  if (recipientUserId === null) {
    return true;
  }
  if (ownerKind === "participant-turn") {
    const turn = thread.turns.find((candidate) => candidate.id === ownerId);
    return (
      turn?.messages.some(
        (message) =>
          message.authorKind === "human" &&
          message.authorSlackId === recipientUserId
      ) ?? false
    );
  }
  return [...thread.turns, { messages: thread.unassigned }].some(
    ({ messages }) =>
      messages.some(
        (message) =>
          message.authorKind === "human" &&
          message.authorSlackId === recipientUserId
      )
  );
};

const tombstoneEncodedBytes = (
  tombstones: readonly ConversationStreamTombstone[]
): number => new TextEncoder().encode(JSON.stringify(tombstones)).byteLength;

const boundConversationStreamTombstones = (
  tombstones: readonly ConversationStreamTombstone[],
  nowMillis: number
): readonly ConversationStreamTombstone[] => {
  const cutoff = nowMillis - CONVERSATION_STREAM_TOMBSTONE_RETENTION_MILLIS;
  const retained = tombstones
    .filter((tombstone) => tombstone.stoppedAtMillis >= cutoff)
    .sort((left, right) => left.stoppedAtMillis - right.stoppedAtMillis);
  while (
    retained.length > MAX_CONVERSATION_STREAM_TOMBSTONES ||
    tombstoneEncodedBytes(retained) > MAX_CONVERSATION_STREAM_TOMBSTONE_BYTES
  ) {
    retained.shift();
  }
  return retained;
};

const tombstoneForConversationStream = (
  stream: ConversationStreamState,
  nowMillis: number
): ConversationStreamTombstone =>
  ConversationStreamTombstone.make({
    acceptedSequence: stream.acceptedSequence,
    channelId: stream.channelId,
    chunkHashes: stream.chunks.map(({ sequence, textHash }) =>
      ConversationStreamChunkHashEvidence.make({ sequence, textHash })
    ),
    cumulativeHash: stream.cumulativeHash,
    confirmedHash: stream.confirmedHash,
    confirmedOffset: stream.confirmedOffset,
    id: stream.id,
    lifecycle: stream.lifecycle === "unresolved" ? "unresolved" : "stopped",
    messageId: stream.messageId,
    mode: stream.mode,
    operations: stream.operations.flatMap((operation) =>
      operation.status === "acknowledged" ||
      operation.status === "rejected" ||
      operation.status === "stopped_by_user" ||
      operation.status === "unresolved"
        ? [
            ConversationStreamOperationEvidence.make({
              attempt: operation.attempt,
              errorCategory: operation.errorCategory,
              errorCertainty: operation.errorCertainty,
              inFlightAtMillis: operation.inFlightAtMillis,
              kind: operation.kind,
              payloadEndOffset: operation.payloadEndOffset,
              payloadHash: operation.payloadHash,
              payloadStartOffset: operation.payloadStartOffset,
              preparedAtMillis: operation.preparedAtMillis,
              settledAtMillis: operation.settledAtMillis,
              status: operation.status,
            }),
          ]
        : []
    ),
    ownerId: stream.ownerId,
    ownerKind: stream.ownerKind,
    recipientUserId: stream.recipientUserId,
    rootTs: stream.rootTs,
    slackTs: stream.slackTs,
    stoppedAtMillis: stream.stoppedAtMillis ?? nowMillis,
    terminalReason: stream.terminalReason ?? "completed",
    threadId: stream.threadId,
    workspaceId: stream.workspaceId,
  });

const compactTerminalConversationStream = (
  state: PrototypeState,
  streamIndex: number,
  stream: ConversationStreamState,
  nowMillis: number
): PrototypeState =>
  PrototypeStateSchema.make({
    ...state,
    conversationStreams: state.conversationStreams.filter(
      (_candidate, index) => index !== streamIndex
    ),
    conversationStreamTombstones: boundConversationStreamTombstones(
      [
        ...state.conversationStreamTombstones,
        tombstoneForConversationStream(stream, nowMillis),
      ],
      nowMillis
    ),
  });

const compactStoppedConversationStreams = (
  state: PrototypeState,
  nowMillis: number,
  reserveLiveCapacity: boolean
): PrototypeState => {
  const stopped = state.conversationStreams
    .filter((stream) => stream.lifecycle === "stopped")
    .sort(
      (left, right) =>
        (left.stoppedAtMillis ?? left.createdAtMillis) -
        (right.stoppedAtMillis ?? right.createdAtMillis)
    );
  const cutoff = nowMillis - CONVERSATION_STREAM_TOMBSTONE_RETENTION_MILLIS;
  const compactIds = new Set<string>();
  let retainedStopped = stopped.length;
  let retainedStreams = state.conversationStreams.length;
  for (const stream of stopped) {
    const stoppedAt = stream.stoppedAtMillis ?? stream.createdAtMillis;
    const shouldCompact =
      stoppedAt <= cutoff ||
      retainedStopped > MAX_RETAINED_STOPPED_STREAMS ||
      (reserveLiveCapacity && retainedStreams >= MAX_CONVERSATION_STREAMS);
    if (!shouldCompact) {
      continue;
    }
    compactIds.add(stream.id);
    retainedStopped -= 1;
    retainedStreams -= 1;
  }
  const compacted = stopped
    .filter((stream) => compactIds.has(stream.id))
    .map((stream) => tombstoneForConversationStream(stream, nowMillis));
  return PrototypeStateSchema.make({
    ...state,
    conversationStreams: state.conversationStreams.filter(
      (stream) => !compactIds.has(stream.id)
    ),
    conversationStreamTombstones: boundConversationStreamTombstones(
      [...state.conversationStreamTombstones, ...compacted],
      nowMillis
    ),
  });
};

const compactSettledConversationStreamOperations = (
  stream: ConversationStreamState
): ConversationStreamState => {
  const compacted = stream.operations.filter(
    (operation) =>
      operation.status === "acknowledged" || operation.status === "rejected"
  );
  if (compacted.length === 0) {
    return stream;
  }
  return ConversationStreamState.make({
    ...stream,
    compactedConfirmedHash: stream.confirmedHash,
    compactedConfirmedOffset: stream.confirmedOffset,
    compactedOperationCount: stream.compactedOperationCount + compacted.length,
    operations: stream.operations.filter(
      (operation) =>
        operation.status !== "acknowledged" && operation.status !== "rejected"
    ),
  });
};

const findConversationStreamIndex = (
  state: PrototypeState,
  streamId: string
): number =>
  state.conversationStreams.findIndex((stream) => stream.id === streamId);

const findConversationStreamOperation = (
  state: PrototypeState,
  operationId: string
): {
  readonly operation: ConversationStreamOperation;
  readonly operationIndex: number;
  readonly stream: ConversationStreamState;
  readonly streamIndex: number;
} | null => {
  for (const [streamIndex, stream] of state.conversationStreams.entries()) {
    const operationIndex = stream.operations.findIndex(
      (operation) => operation.id === operationId
    );
    const operation = stream.operations[operationIndex];
    if (operation !== undefined) {
      return { operation, operationIndex, stream, streamIndex };
    }
  }
  return null;
};

const replaceConversationStream = (
  state: PrototypeState,
  index: number,
  stream: ConversationStreamState
): PrototypeState =>
  PrototypeStateSchema.make({
    ...state,
    conversationStreams: replaceAt(state.conversationStreams, index, stream),
  });

const configureConversationStreamTransition = (
  state: PrototypeState,
  request: {
    readonly flushDeadlineMillis: number | null;
    readonly mode: ConversationStreamMode;
    readonly streamId: string;
  }
): readonly [undefined, PrototypeState] | StoreError => {
  const index = findConversationStreamIndex(state, request.streamId);
  const stream = state.conversationStreams[index];
  if (stream === undefined) {
    return storeFailure("configureConversationStream", "stream-not-found");
  }
  if (stream.mode !== null && stream.mode !== request.mode) {
    return storeFailure("configureConversationStream", "stream-mode-conflict");
  }
  if (
    request.flushDeadlineMillis !== null &&
    (!Number.isSafeInteger(request.flushDeadlineMillis) ||
      request.flushDeadlineMillis < 0)
  ) {
    return storeFailure("configureConversationStream", "invalid-deadline");
  }
  const deadline =
    stream.flushDeadlineMillis ?? request.flushDeadlineMillis ?? null;
  return [
    undefined,
    replaceConversationStream(
      state,
      index,
      ConversationStreamState.make({
        ...stream,
        flushDeadlineMillis: deadline,
        mode: request.mode,
      })
    ),
  ];
};

const prepareConversationStreamOperationTransition = (
  state: PrototypeState,
  request: {
    readonly kind: ConversationStreamOperationKind;
    readonly nowMillis: number;
    readonly payloadEndOffset: number;
    readonly payloadStartOffset: number;
    readonly payloadText: string;
    readonly streamId: string;
  }
):
  | readonly [
      (
        | {
            readonly _tag: "Prepared";
            readonly operation: ConversationStreamOperation;
          }
        | { readonly _tag: "Unresolved" }
      ),
      PrototypeState,
    ]
  | StoreError => {
  const index = findConversationStreamIndex(state, request.streamId);
  const current = state.conversationStreams[index];
  if (current === undefined) {
    return storeFailure(
      "prepareConversationStreamOperation",
      "stream-not-found"
    );
  }
  if (
    current.lifecycle === "stopped" ||
    current.lifecycle === "unresolved" ||
    !operationKindMatchesMode(current.mode, request.kind) ||
    ((request.kind === "native-start" || request.kind === "fallback-post") &&
      current.slackTs !== null) ||
    ((request.kind === "native-append" ||
      request.kind === "native-stop" ||
      request.kind === "fallback-update") &&
      current.slackTs === null) ||
    !Number.isSafeInteger(request.nowMillis) ||
    !Number.isSafeInteger(request.payloadStartOffset) ||
    !Number.isSafeInteger(request.payloadEndOffset) ||
    request.payloadStartOffset < 0 ||
    request.payloadEndOffset < request.payloadStartOffset ||
    request.payloadEndOffset > [...current.cumulativeText].length
  ) {
    return storeFailure(
      "prepareConversationStreamOperation",
      "invalid-operation"
    );
  }
  const stream = compactSettledConversationStreamOperations(current);
  if (
    stream.operations.some(
      (operation) =>
        operation.status === "prepared" ||
        operation.status === "in_flight" ||
        operation.status === "retry"
    )
  ) {
    return storeFailure(
      "prepareConversationStreamOperation",
      "operation-already-active"
    );
  }
  if (stream.operations.length >= MAX_CONVERSATION_STREAM_OPERATIONS) {
    const unresolved = ConversationStreamState.make({
      ...stream,
      flushDeadlineMillis: null,
      lifecycle: "unresolved",
      terminalReason: "stream-operation-capacity-exhausted",
    });
    return [
      { _tag: "Unresolved" },
      replaceConversationStream(state, index, unresolved),
    ];
  }
  const operation = ConversationStreamOperation.make({
    attempt: 0,
    errorCategory: null,
    errorCertainty: null,
    id: `${stream.id}:operation:${request.kind}:${request.payloadStartOffset}:${request.payloadEndOffset}`,
    inFlightAtMillis: null,
    kind: request.kind,
    payloadEndOffset: request.payloadEndOffset,
    payloadHash: sha256(request.payloadText),
    payloadStartOffset: request.payloadStartOffset,
    payloadText: request.payloadText,
    preparedAtMillis: request.nowMillis,
    retryAtMillis: null,
    settledAtMillis: null,
    status: "prepared",
  });
  const updated = ConversationStreamState.make({
    ...stream,
    operations: EffectArray.append(stream.operations, operation),
  });
  return [
    { _tag: "Prepared", operation },
    replaceConversationStream(state, index, updated),
  ];
};

const slackMethodForOperationKind = (
  kind: ConversationStreamOperationKind
): string => {
  switch (kind) {
    case "fallback-post":
      return "chat.postMessage";
    case "fallback-update":
      return "chat.update";
    case "native-append":
      return "chat.appendStream";
    case "native-start":
      return "chat.startStream";
    case "native-stop":
      return "chat.stopStream";
    default:
      return kind;
  }
};

interface SlackRateSlotRequest {
  readonly channelId: string;
  readonly channelSpacingMillis: number;
  readonly method: string;
  readonly methodSpacingMillis: number;
  readonly nowMillis: number;
  readonly workspaceId: string;
}

const reserveSlackRateSlotTransition = (
  state: PrototypeState,
  request: SlackRateSlotRequest
): readonly [number, PrototypeState] | StoreError => {
  if (
    request.workspaceId.trim().length === 0 ||
    request.channelId.trim().length === 0 ||
    request.method.trim().length === 0 ||
    !Number.isSafeInteger(request.nowMillis) ||
    !Number.isSafeInteger(request.methodSpacingMillis) ||
    !Number.isSafeInteger(request.channelSpacingMillis) ||
    request.methodSpacingMillis < 0 ||
    request.channelSpacingMillis < 0
  ) {
    return storeFailure("reserveSlackRateSlot", "invalid-reservation");
  }
  const requestedScopes = [
    {
      channelId: null,
      scope: "method" as const,
      spacingMillis: request.methodSpacingMillis,
    },
    ...(request.method === "chat.postMessage"
      ? [
          {
            channelId: request.channelId,
            scope: "channel" as const,
            spacingMillis: request.channelSpacingMillis,
          },
        ]
      : []),
  ];
  const isRequestedBudget = (budget: ConversationStreamRateBudget): boolean =>
    budget.workspaceId === request.workspaceId &&
    budget.method === request.method &&
    requestedScopes.some(
      (scope) =>
        budget.scope === scope.scope && budget.channelId === scope.channelId
    );
  const requestedBudgets =
    state.conversationStreamRateBudgets.filter(isRequestedBudget);
  const slot = requestedBudgets.reduce(
    (candidate, budget) => Math.max(candidate, budget.nextAvailableAtMillis),
    request.nowMillis
  );
  const retainedBudgets = state.conversationStreamRateBudgets.filter(
    (budget) =>
      !isRequestedBudget(budget) &&
      budget.nextAvailableAtMillis > request.nowMillis
  );
  if (
    retainedBudgets.length + requestedScopes.length >
    MAX_CONVERSATION_STREAM_RATE_BUDGETS
  ) {
    return storeFailure(
      "reserveConversationStreamRateSlot",
      "rate-budget-bound-exceeded"
    );
  }
  const updated = requestedScopes.map(({ channelId, scope, spacingMillis }) =>
    ConversationStreamRateBudget.make({
      channelId,
      method: request.method,
      nextAvailableAtMillis: slot + spacingMillis,
      scope,
      workspaceId: request.workspaceId,
    })
  );
  return [
    slot,
    PrototypeStateSchema.make({
      ...state,
      conversationStreamRateBudgets: [...retainedBudgets, ...updated],
    }),
  ];
};

const reserveConversationStreamRateSlotTransition = (
  state: PrototypeState,
  request: {
    readonly nowMillis: number;
    readonly operationId: string;
    readonly spacingMillis: number;
  }
): readonly [number, PrototypeState] | StoreError => {
  const found = findConversationStreamOperation(state, request.operationId);
  if (
    found === null ||
    (found.operation.status !== "prepared" &&
      found.operation.status !== "retry")
  ) {
    return storeFailure(
      "reserveConversationStreamRateSlot",
      "invalid-reservation"
    );
  }
  return reserveSlackRateSlotTransition(state, {
    channelId: found.stream.channelId,
    channelSpacingMillis: request.spacingMillis,
    method: slackMethodForOperationKind(found.operation.kind),
    methodSpacingMillis: request.spacingMillis,
    nowMillis: request.nowMillis,
    workspaceId: found.stream.workspaceId,
  });
};

const deferSlackRateBudgetTransition = (
  state: PrototypeState,
  request: {
    readonly method: string;
    readonly retryAtMillis: number;
    readonly workspaceId: string;
  }
): readonly [undefined, PrototypeState] | StoreError => {
  if (
    request.method.trim().length === 0 ||
    request.workspaceId.trim().length === 0 ||
    !Number.isSafeInteger(request.retryAtMillis) ||
    request.retryAtMillis < 0
  ) {
    return storeFailure("deferSlackRateBudget", "invalid-deferral");
  }
  return [
    undefined,
    PrototypeStateSchema.make({
      ...state,
      conversationStreamRateBudgets: state.conversationStreamRateBudgets.map(
        (budget) =>
          budget.scope === "method" &&
          budget.workspaceId === request.workspaceId &&
          budget.method === request.method
            ? ConversationStreamRateBudget.make({
                ...budget,
                nextAvailableAtMillis: Math.max(
                  budget.nextAvailableAtMillis,
                  request.retryAtMillis
                ),
              })
            : budget
      ),
    }),
  ];
};

const markConversationStreamOperationInFlightTransition = (
  state: PrototypeState,
  operationId: string,
  nowMillis: number
): readonly [undefined, PrototypeState] | StoreError => {
  const found = findConversationStreamOperation(state, operationId);
  if (
    found === null ||
    (found.operation.status !== "prepared" &&
      found.operation.status !== "retry") ||
    !Number.isSafeInteger(nowMillis)
  ) {
    return storeFailure(
      "markConversationStreamOperationInFlight",
      "operation-not-requestable"
    );
  }
  const operation = ConversationStreamOperation.make({
    ...found.operation,
    attempt: found.operation.attempt + 1,
    errorCategory: null,
    errorCertainty: null,
    inFlightAtMillis: nowMillis,
    retryAtMillis: null,
    status: "in_flight",
  });
  const stream = ConversationStreamState.make({
    ...found.stream,
    operations: replaceAt(
      found.stream.operations,
      found.operationIndex,
      operation
    ),
  });
  return [
    undefined,
    replaceConversationStream(state, found.streamIndex, stream),
  ];
};

interface ConversationStreamSettlementRequest {
  readonly category: string | null;
  readonly certainty: ConversationStreamOperationOutcomeCertainty | null;
  readonly nowMillis: number;
  readonly operationId: string;
  readonly outcome:
    | "acknowledged"
    | "rejected"
    | "retry"
    | "stopped_by_user"
    | "unresolved";
  readonly retryAtMillis: number | null;
  readonly slackTs: string | null;
}

const operationStatusFor = (
  outcome: ConversationStreamSettlementRequest["outcome"]
): ConversationStreamOperation["status"] => {
  if (outcome === "acknowledged" || outcome === "retry") {
    return outcome;
  }
  if (outcome === "stopped_by_user" || outcome === "unresolved") {
    return outcome;
  }
  return "rejected";
};

const projectConversationStreamSettlement = (
  stream: ConversationStreamState,
  operation: ConversationStreamOperation,
  request: ConversationStreamSettlementRequest
): ConversationStreamState | StoreError => {
  let lifecycle = stream.lifecycle;
  let terminalReason = stream.terminalReason;
  let slackTs = stream.slackTs;
  let confirmedOffset = stream.confirmedOffset;
  let confirmedHash = stream.confirmedHash;
  let flushDeadlineMillis = stream.flushDeadlineMillis;
  let stoppedAtMillis = stream.stoppedAtMillis;
  if (request.outcome === "acknowledged") {
    const operationCreatesMessage =
      operation.kind === "native-start" || operation.kind === "fallback-post";
    if (operationCreatesMessage) {
      if (request.slackTs === null || request.slackTs.length === 0) {
        return storeFailure(
          "settleConversationStreamOperation",
          "start-ack-omitted-ts"
        );
      }
      slackTs = request.slackTs;
    }
    if (operation.kind === "native-stop") {
      lifecycle = "stopped";
      stoppedAtMillis = request.nowMillis;
      terminalReason ??= "completed";
    } else {
      confirmedOffset = operation.payloadEndOffset;
      confirmedHash = sha256(
        [...stream.cumulativeText].slice(0, confirmedOffset).join("")
      );
      flushDeadlineMillis = null;
    }
  }
  if (request.outcome === "stopped_by_user") {
    lifecycle = "stopped";
    stoppedAtMillis = request.nowMillis;
    terminalReason = "stopped_by_user";
  }
  if (request.outcome === "rejected" || request.outcome === "unresolved") {
    lifecycle = "unresolved";
    stoppedAtMillis = request.nowMillis;
    terminalReason = request.category ?? request.outcome;
  }
  const settledOperation = ConversationStreamOperation.make({
    ...operation,
    errorCategory: request.category,
    errorCertainty: request.certainty,
    retryAtMillis: request.outcome === "retry" ? request.retryAtMillis : null,
    settledAtMillis: request.outcome === "retry" ? null : request.nowMillis,
    status: operationStatusFor(request.outcome),
  });
  const operationIndex = stream.operations.findIndex(
    (candidate) => candidate.id === operation.id
  );
  return ConversationStreamState.make({
    ...stream,
    confirmedHash,
    confirmedOffset,
    flushDeadlineMillis,
    lifecycle,
    operations: replaceAt(stream.operations, operationIndex, settledOperation),
    slackTs,
    stoppedAtMillis,
    terminalReason,
  });
};

const settleConversationStreamOperationTransition = (
  state: PrototypeState,
  request: ConversationStreamSettlementRequest
): readonly [undefined, PrototypeState] | StoreError => {
  const found = findConversationStreamOperation(state, request.operationId);
  if (
    found === null ||
    found.operation.status !== "in_flight" ||
    !Number.isSafeInteger(request.nowMillis)
  ) {
    return storeFailure(
      "settleConversationStreamOperation",
      "operation-not-in-flight"
    );
  }
  const projected = projectConversationStreamSettlement(
    found.stream,
    found.operation,
    request
  );
  if (projected instanceof StoreError) {
    return projected;
  }
  const stream = projected;
  const isTerminal =
    stream.lifecycle === "stopped" || stream.lifecycle === "unresolved";
  let next = isTerminal
    ? compactTerminalConversationStream(
        state,
        found.streamIndex,
        stream,
        request.nowMillis
      )
    : replaceConversationStream(state, found.streamIndex, stream);
  if (request.outcome === "retry" && request.retryAtMillis !== null) {
    next = PrototypeStateSchema.make({
      ...next,
      conversationStreamRateBudgets: next.conversationStreamRateBudgets.map(
        (budget) =>
          budget.scope === "method" &&
          budget.workspaceId === found.stream.workspaceId &&
          budget.method === slackMethodForOperationKind(found.operation.kind)
            ? ConversationStreamRateBudget.make({
                ...budget,
                nextAvailableAtMillis: Math.max(
                  budget.nextAvailableAtMillis,
                  request.retryAtMillis ?? budget.nextAvailableAtMillis
                ),
              })
            : budget
      ),
    });
  }
  if (
    stream.ownerKind === "participant-turn" &&
    stream.lifecycle === "stopped"
  ) {
    next = enqueueEligibleCompletionReaction(
      next,
      stream.threadId,
      TurnId.make(stream.ownerId)
    );
  }
  return [undefined, next];
};

const requestConversationStreamFinalizationTransition = (
  state: PrototypeState,
  request: {
    readonly ownerId: string;
    readonly ownerKind: ConversationStreamOwnerKind;
    readonly terminalReason: string;
    readonly threadId: ThreadId;
  }
): readonly [readonly string[], PrototypeState] => {
  const streamIds: string[] = [];
  const streams = state.conversationStreams.map((stream) => {
    if (
      stream.threadId !== request.threadId ||
      stream.ownerId !== request.ownerId ||
      stream.ownerKind !== request.ownerKind ||
      (stream.lifecycle !== "open" && stream.lifecycle !== "finalizing")
    ) {
      return stream;
    }
    streamIds.push(stream.id);
    return ConversationStreamState.make({
      ...stream,
      lifecycle: "finalizing",
      replayBoundaryOffset: null,
      replayCursorOffset: null,
      terminalReason: stream.terminalReason ?? request.terminalReason,
    });
  });
  return [
    streamIds,
    PrototypeStateSchema.make({ ...state, conversationStreams: streams }),
  ];
};

const reconcileConversationStreamsOnRestartTransition = (
  state: PrototypeState,
  nowMillis: number
): readonly [readonly string[], PrototypeState] | StoreError => {
  if (!Number.isSafeInteger(nowMillis) || nowMillis < 0) {
    return storeFailure(
      "reconcileConversationStreamsOnRestart",
      "invalid-restart-time"
    );
  }
  const terminal = state.conversationStreams.filter(
    (stream) =>
      stream.lifecycle === "stopped" || stream.lifecycle === "unresolved"
  );
  const live = state.conversationStreams.filter(
    (stream) =>
      stream.lifecycle !== "stopped" && stream.lifecycle !== "unresolved"
  );
  const reconciled = live.map((stream) => {
    if (stream.lifecycle === "finalizing") {
      return stream;
    }
    const boundary =
      stream.replayBoundaryOffset ?? [...stream.cumulativeText].length;
    return ConversationStreamState.make({
      ...stream,
      flushDeadlineMillis: null,
      replayBoundaryOffset: boundary,
      replayCursorOffset: stream.replayCursorOffset ?? 0,
    });
  });
  const tombstones = terminal.map((stream) =>
    tombstoneForConversationStream(stream, nowMillis)
  );
  return [
    reconciled.map((stream) => stream.id),
    PrototypeStateSchema.make({
      ...state,
      conversationStreams: reconciled,
      conversationStreamTombstones: boundConversationStreamTombstones(
        [...state.conversationStreamTombstones, ...tombstones],
        nowMillis
      ),
    }),
  ];
};

const completeFallbackConversationStreamTransition = (
  state: PrototypeState,
  streamId: string,
  terminalReason: string,
  nowMillis: number
): readonly [undefined, PrototypeState] | StoreError => {
  const index = findConversationStreamIndex(state, streamId);
  const stream = state.conversationStreams[index];
  if (
    stream === undefined ||
    stream.mode !== "fallback" ||
    stream.confirmedOffset !== [...stream.cumulativeText].length ||
    stream.operations.some(
      (operation) =>
        operation.status === "prepared" ||
        operation.status === "in_flight" ||
        operation.status === "retry"
    )
  ) {
    return storeFailure(
      "completeFallbackConversationStream",
      "fallback-stream-not-complete"
    );
  }
  const stopped = ConversationStreamState.make({
    ...stream,
    flushDeadlineMillis: null,
    lifecycle: "stopped",
    stoppedAtMillis: nowMillis,
    terminalReason,
  });
  let next = compactTerminalConversationStream(
    state,
    index,
    stopped,
    nowMillis
  );
  if (stopped.ownerKind === "participant-turn") {
    next = enqueueEligibleCompletionReaction(
      next,
      stopped.threadId,
      TurnId.make(stopped.ownerId)
    );
  }
  return [undefined, next];
};

const streamChunkRequestFailure = (request: {
  readonly messageId: string;
  readonly nowMillis: number;
  readonly ownerId: string;
  readonly sequence: number | null;
}): StoreError | null =>
  request.messageId.trim().length === 0 ||
  request.ownerId.trim().length === 0 ||
  !Number.isSafeInteger(request.nowMillis) ||
  request.nowMillis < 0 ||
  (request.sequence !== null &&
    (!Number.isSafeInteger(request.sequence) || request.sequence < 0))
    ? storeFailure("acceptConversationStreamChunk", "invalid-stream-chunk")
    : null;

const existingStreamChunkDecision = (
  current: ConversationStreamState | undefined,
  request: { readonly sequence: number; readonly text: string },
  streamId: string
): ConversationStreamChunkDecision | StoreError | null => {
  if (current !== undefined && request.sequence <= current.acceptedSequence) {
    const evidence = current.chunks.find(
      (chunk) => chunk.sequence === request.sequence
    );
    return evidence?.text === request.text
      ? { _tag: "Duplicate", streamId }
      : storeFailure(
          "acceptConversationStreamChunk",
          "conflicting-stream-sequence"
        );
  }
  if (request.sequence !== (current?.acceptedSequence ?? -1) + 1) {
    return storeFailure("acceptConversationStreamChunk", "stream-sequence-gap");
  }
  if (current?.lifecycle === "stopped" || current?.lifecycle === "unresolved") {
    return storeFailure("acceptConversationStreamChunk", "stream-is-terminal");
  }
  const exceedsChunkBound =
    (current?.chunks.length ?? 0) >= MAX_CONVERSATION_STREAM_CHUNKS;
  return exceedsChunkBound
    ? storeFailure("acceptConversationStreamChunk", "stream-bound-exceeded")
    : null;
};

const completeConversationStreamLocallyTransition = (
  state: PrototypeState,
  streamId: string,
  terminalReason: string,
  nowMillis: number
): readonly [undefined, PrototypeState] | StoreError => {
  const index = findConversationStreamIndex(state, streamId);
  const stream = state.conversationStreams[index];
  if (
    stream === undefined ||
    stream.slackTs !== null ||
    stream.cumulativeText.trim().length > 0 ||
    stream.operations.length > 0
  ) {
    return storeFailure(
      "completeConversationStreamLocally",
      "stream-has-slack-delivery"
    );
  }
  const stopped = replaceConversationStream(
    state,
    index,
    ConversationStreamState.make({
      ...stream,
      flushDeadlineMillis: null,
      lifecycle: "stopped",
      stoppedAtMillis: nowMillis,
      terminalReason,
    })
  );
  const terminal = stopped.conversationStreams[index];
  if (terminal === undefined) {
    return storeFailure(
      "completeConversationStreamLocally",
      "stream-not-found-after-stop"
    );
  }
  return [
    undefined,
    compactTerminalConversationStream(stopped, index, terminal, nowMillis),
  ];
};

const markConversationStreamUnresolvedTransition = (
  state: PrototypeState,
  streamId: string,
  terminalReason: string,
  nowMillis: number
): readonly [undefined, PrototypeState] | StoreError => {
  const index = findConversationStreamIndex(state, streamId);
  const stream = state.conversationStreams[index];
  if (stream === undefined || stream.lifecycle === "stopped") {
    return storeFailure(
      "markConversationStreamUnresolved",
      "stream-not-unresolved-capable"
    );
  }
  const unresolved = ConversationStreamState.make({
    ...stream,
    flushDeadlineMillis: null,
    lifecycle: "unresolved",
    stoppedAtMillis: nowMillis,
    terminalReason,
  });
  return [
    undefined,
    compactTerminalConversationStream(state, index, unresolved, nowMillis),
  ];
};

interface ConversationStreamChunkRequest {
  readonly messageId: string;
  readonly nowMillis: number;
  readonly ownerId: string;
  readonly ownerKind: ConversationStreamOwnerKind;
  readonly sequence: number | null;
  readonly text: string;
  readonly threadId: ThreadId;
}

const tombstoneStreamChunkDecision = (
  state: PrototypeState,
  tombstone: ConversationStreamTombstone,
  request: ConversationStreamChunkRequest,
  streamId: string
): readonly [ConversationStreamChunkDecision, PrototypeState] | StoreError => {
  if (
    request.sequence === null ||
    request.sequence > tombstone.acceptedSequence
  ) {
    return storeFailure("acceptConversationStreamChunk", "stream-is-terminal");
  }
  const evidence = tombstone.chunkHashes.find(
    (chunk) => chunk.sequence === request.sequence
  );
  return evidence?.textHash === sha256(request.text)
    ? [{ _tag: "Duplicate", streamId }, state]
    : storeFailure(
        "acceptConversationStreamChunk",
        "conflicting-stream-sequence"
      );
};

const conversationStreamAppendFailure = (
  state: PrototypeState,
  thread: WorkThreadState,
  current: ConversationStreamState | undefined,
  request: ConversationStreamChunkRequest,
  cumulativeText: string
): StoreError | null => {
  if (
    !conversationStreamOwnerIsRunning(
      thread,
      request.ownerKind,
      request.ownerId
    )
  ) {
    return storeFailure(
      "acceptConversationStreamChunk",
      "stream-owner-not-running"
    );
  }
  if (
    current === undefined &&
    state.conversationStreams.length >= MAX_CONVERSATION_STREAMS
  ) {
    return storeFailure(
      "acceptConversationStreamChunk",
      "stream-bound-exceeded"
    );
  }
  return slackCodePointLength(cumulativeText) >
    SLACK_MARKDOWN_TEXT_CODE_POINT_LIMIT
    ? storeFailure(
        "acceptConversationStreamChunk",
        "conversation-message-too-long"
      )
    : null;
};

const appendConversationStreamChunk = (
  state: PrototypeState,
  thread: WorkThreadState,
  current: ConversationStreamState | undefined,
  streamIndex: number,
  request: ConversationStreamChunkRequest,
  sequence: number,
  streamId: string,
  workspaceId: string
): readonly [ConversationStreamChunkDecision, PrototypeState] | StoreError => {
  const cumulativeText = `${current?.cumulativeText ?? ""}${request.text}`;
  const appendFailure = conversationStreamAppendFailure(
    state,
    thread,
    current,
    request,
    cumulativeText
  );
  if (appendFailure !== null) {
    return appendFailure;
  }
  const chunk = ConversationStreamChunkEvidence.make({
    sequence,
    text: request.text,
    textHash: sha256(request.text),
  });
  const stream = ConversationStreamState.make({
    acceptedSequence: sequence,
    channelId: thread.channelId,
    chunks: EffectArray.append(current?.chunks ?? [], chunk),
    compactedConfirmedHash: current?.compactedConfirmedHash ?? sha256(""),
    compactedConfirmedOffset: current?.compactedConfirmedOffset ?? 0,
    compactedOperationCount: current?.compactedOperationCount ?? 0,
    confirmedHash: current?.confirmedHash ?? sha256(""),
    confirmedOffset: current?.confirmedOffset ?? 0,
    createdAtMillis: current?.createdAtMillis ?? request.nowMillis,
    cumulativeHash: sha256(cumulativeText),
    cumulativeText,
    flushDeadlineMillis: current?.flushDeadlineMillis ?? null,
    id: streamId,
    lifecycle: current?.lifecycle ?? "open",
    messageId: request.messageId,
    mode: current?.mode ?? null,
    operations: current?.operations ?? [],
    ownerId: request.ownerId,
    ownerKind: request.ownerKind,
    recipientUserId:
      current?.recipientUserId ??
      conversationStreamRecipient(thread, request.ownerKind, request.ownerId),
    replayBoundaryOffset: current?.replayBoundaryOffset ?? null,
    replayCursorOffset: current?.replayCursorOffset ?? null,
    rootTs: thread.rootTs,
    slackTs: current?.slackTs ?? null,
    stoppedAtMillis: current?.stoppedAtMillis ?? null,
    terminalReason: current?.terminalReason ?? null,
    threadId: request.threadId,
    workspaceId,
  });
  const conversationStreams =
    current === undefined
      ? EffectArray.append(state.conversationStreams, stream)
      : replaceAt(state.conversationStreams, streamIndex, stream);
  return [
    { _tag: "Accepted", streamId },
    PrototypeStateSchema.make({ ...state, conversationStreams }),
  ];
};

const acceptConversationStreamChunkTransition = (
  state: PrototypeState,
  request: ConversationStreamChunkRequest
): readonly [ConversationStreamChunkDecision, PrototypeState] | StoreError => {
  const requestFailure = streamChunkRequestFailure(request);
  if (requestFailure !== null) {
    return requestFailure;
  }
  const compactedState = compactStoppedConversationStreams(
    state,
    request.nowMillis,
    true
  );
  const thread =
    compactedState.threads[findThreadIndex(compactedState, request.threadId)];
  if (thread === undefined) {
    return storeFailure("acceptConversationStreamChunk", "thread-not-found");
  }
  const workspaceId = thread.workspaceId ?? `legacy:${thread.id}`;
  const streamId = stableConversationStreamId({ ...request, workspaceId });
  const streamIndex = compactedState.conversationStreams.findIndex(
    (stream) => stream.id === streamId
  );
  const current = compactedState.conversationStreams[streamIndex];
  const tombstone = compactedState.conversationStreamTombstones.find(
    (candidate) => candidate.id === streamId
  );
  if (tombstone !== undefined) {
    return tombstoneStreamChunkDecision(
      compactedState,
      tombstone,
      request,
      streamId
    );
  }
  let acceptedState = compactedState;
  let acceptedCurrent = current;
  let acceptedRequest = request;
  if (request.sequence === null && current !== undefined) {
    const reconciliation = reconcileUnsequencedConversationStreamChunk(
      compactedState,
      current,
      streamIndex,
      request,
      streamId
    );
    if (reconciliation instanceof StoreError) {
      return reconciliation;
    }
    if (reconciliation._tag === "Duplicate") {
      return [{ _tag: "Duplicate", streamId }, reconciliation.state];
    }
    acceptedState = reconciliation.value.state;
    acceptedCurrent = reconciliation.value.current;
    acceptedRequest = reconciliation.value.request;
  }
  const sequence =
    acceptedRequest.sequence ?? (acceptedCurrent?.acceptedSequence ?? -1) + 1;
  const existingDecision = existingStreamChunkDecision(
    acceptedCurrent,
    { sequence, text: acceptedRequest.text },
    streamId
  );
  if (existingDecision instanceof StoreError) {
    return existingDecision;
  }
  if (existingDecision !== null) {
    return [existingDecision, acceptedState];
  }
  return appendConversationStreamChunk(
    acceptedState,
    thread,
    acceptedCurrent,
    streamIndex,
    acceptedRequest,
    sequence,
    streamId,
    workspaceId
  );
};

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

const recoveryNoticeId = (
  ownerKind: ConversationStreamOwnerKind,
  ownerId: string,
  kind: RecoveryNoticeKind,
  correlationId: string
): string => {
  const correlationDigest = createHash("sha256")
    .update("laborer-recovery-notice-v1\0", "utf8")
    .update(correlationId, "utf8")
    .digest("base64url");
  return `notice:${ownerTurnId(ownerKind, ownerId)}:recovery:${kind}:${correlationDigest}`;
};

const ownerTurnId = (
  ownerKind: ConversationStreamOwnerKind,
  ownerId: string
): TurnId =>
  ownerKind === "participant-turn"
    ? TurnId.make(ownerId)
    : applicationEventTurnId(ownerId);

const appendRecoveryNotice = (
  thread: WorkThreadState,
  ownerKind: ConversationStreamOwnerKind,
  ownerId: string,
  kind: RecoveryNoticeKind,
  correlationId: string
): readonly OutboundItem[] => {
  const id = recoveryNoticeId(ownerKind, ownerId, kind, correlationId);
  if (thread.outbox.some((item) => item.id === id)) {
    return thread.outbox;
  }
  return [
    ...thread.outbox,
    OutboundItem.make({
      deliveryAttempts: 0,
      id,
      kind: "operational_notice",
      lastErrorCategory: null,
      replyId: null,
      retryAtMillis: null,
      slackTs: null,
      status: "pending",
      text: recoveryNoticeText(kind),
      turnId: ownerTurnId(ownerKind, ownerId),
    }),
  ];
};

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
): readonly [ApplicationEventDecision, PrototypeState] | StoreError => {
  const existingOwner = pipe(
    state.threads,
    EffectArray.findFirst((thread) =>
      thread.applicationEvents.some(
        (candidate) => candidate.eventId === event.eventId
      )
    ),
    Option.getOrNull
  );
  if (existingOwner !== null) {
    const existing = existingOwner.applicationEvents.find(
      (candidate) => candidate.eventId === event.eventId
    );
    if (
      existingOwner.id === event.conversationId &&
      existing !== undefined &&
      sameApplicationEvent(existing, event)
    ) {
      return [{ _tag: "Duplicate", eventId: event.eventId }, state];
    }
    return storeFailure(
      "acceptApplicationEvent",
      "conflicting-application-event-id"
    );
  }
  return modifyThread<ApplicationEventDecision>(
    state,
    event.conversationId,
    "acceptApplicationEvent",
    (thread) => {
      return [
        { _tag: "Accepted" as const, eventId: event.eventId },
        WorkThreadState.make({
          ...thread,
          applicationEvents: EffectArray.append(
            thread.applicationEvents,
            ApplicationEventState.make({
              blocked: null,
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
};

const claimApplicationEventInThread = (
  thread: WorkThreadState
): readonly [ApplicationEventState | null, WorkThreadState] => {
  const activeTurn = pipe(
    thread.turns,
    EffectArray.some(
      (turn) =>
        turn.status === "running" ||
        turn.status === "awaiting_delivery" ||
        turn.status === "blocked"
    )
  );
  if (activeTurn) {
    return [null, thread];
  }
  const activeEvent = pipe(
    thread.applicationEvents,
    EffectArray.findFirst(
      (event) =>
        event.status === "running" ||
        event.status === "awaiting_delivery" ||
        event.status === "blocked"
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
  const conversationStreams = state.conversationStreams.filter(
    (stream) =>
      stream.threadId === threadId &&
      stream.ownerKind === "participant-turn" &&
      stream.ownerId === turnId
  );
  if (conversationStreams.some((stream) => stream.lifecycle !== "stopped")) {
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
        event.status === "running" ||
        event.status === "awaiting_delivery" ||
        event.status === "blocked"
    )
  ) {
    return [null, thread];
  }
  const activeTurn = pipe(
    thread.turns,
    EffectArray.findFirst(
      (turn) =>
        turn.status === "running" ||
        turn.status === "awaiting_delivery" ||
        turn.status === "blocked"
    ),
    Option.getOrNull
  );
  if (
    activeTurn?.status === "awaiting_delivery" ||
    activeTurn?.status === "blocked"
  ) {
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
    blocked: null,
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

const blockConversationOwnerTransition = (
  state: PrototypeState,
  blocked: ConversationBlockedState
): readonly [undefined, PrototypeState] | StoreError => {
  const persistedBlocked = ConversationBlockedState.make({ ...blocked });
  return modifyThread(
    state,
    blocked.conversationId,
    "blockConversationOwner",
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Both owner variants must validate and publish the same atomic durable block transition.
    (thread) => {
      const workspaceId = thread.workspaceId ?? `legacy:${thread.id}`;
      const workspaceMatches =
        workspaceId === blocked.workspaceId ||
        (thread.workspaceId === undefined && blocked.workspaceId === "legacy");
      if (!workspaceMatches) {
        return storeFailure("blockConversationOwner", "wrong-scope");
      }
      if (blocked.ownerKind === "participant-turn") {
        const index = findTurnIndex(thread, TurnId.make(blocked.ownerId));
        const turn = thread.turns[index];
        if (turn?.status === "blocked") {
          return turn.blocked?.attemptId === blocked.attemptId
            ? [undefined, thread]
            : storeFailure("blockConversationOwner", "blocked-owner-conflict");
        }
        if (turn?.status !== "running") {
          return storeFailure("blockConversationOwner", "owner-not-running");
        }
        const attempts = turn.attempts.map((attempt, attemptIndex) =>
          attemptIndex === turn.attempts.length - 1 &&
          attempt.status === "running"
            ? HandlerAttempt.make({ ...attempt, status: "interrupted" })
            : attempt
        );
        return [
          undefined,
          WorkThreadState.make({
            ...thread,
            outbox: appendRecoveryNotice(
              thread,
              blocked.ownerKind,
              blocked.ownerId,
              "blocked",
              blocked.attemptId
            ),
            turns: replaceAt(
              thread.turns,
              index,
              TurnState.make({
                ...turn,
                attempts,
                blocked: persistedBlocked,
                status: "blocked",
              })
            ),
          }),
        ];
      }
      const index = findApplicationEventIndex(thread, blocked.ownerId);
      const event = thread.applicationEvents[index];
      if (event?.status === "blocked") {
        return event.blocked?.attemptId === blocked.attemptId
          ? [undefined, thread]
          : storeFailure("blockConversationOwner", "blocked-owner-conflict");
      }
      if (event?.status !== "running") {
        return storeFailure("blockConversationOwner", "owner-not-running");
      }
      return [
        undefined,
        WorkThreadState.make({
          ...thread,
          applicationEvents: replaceAt(
            thread.applicationEvents,
            index,
            ApplicationEventState.make({
              ...event,
              blocked: persistedBlocked,
              status: "blocked",
            })
          ),
          outbox: appendRecoveryNotice(
            thread,
            blocked.ownerKind,
            blocked.ownerId,
            "blocked",
            blocked.attemptId
          ),
        }),
      ];
    }
  );
};

interface ResolveConversationBlockedRequest {
  readonly attemptId: string;
  readonly conversationId: ThreadId;
  readonly decisionId: string;
  readonly kind: "abandon" | "retry";
  readonly ownerId: string;
  readonly ownerKind: ConversationStreamOwnerKind;
  readonly replacementAttemptId: string | null;
  readonly workspaceId: string;
}

const resolveBlockedTurn = (
  thread: WorkThreadState,
  request: ResolveConversationBlockedRequest
): readonly ["AlreadyResolved" | "Resolved", WorkThreadState] | StoreError => {
  const index = findTurnIndex(thread, TurnId.make(request.ownerId));
  const turn = thread.turns[index];
  if (turn === undefined) {
    return storeFailure("resolveConversationBlocked", "owner-not-found");
  }
  if (turn.status !== "blocked") {
    return turn.status === "running" ||
      turn.status === "awaiting_delivery" ||
      turn.status === "completed"
      ? ["AlreadyResolved", thread]
      : storeFailure("resolveConversationBlocked", "owner-not-blocked");
  }
  if (
    turn.blocked?.attemptId !== request.attemptId ||
    turn.blocked.ownerId !== request.ownerId
  ) {
    return storeFailure("resolveConversationBlocked", "blocked-owner-conflict");
  }
  const nextTurn =
    request.kind === "retry"
      ? TurnState.make({
          ...turn,
          attempts: [
            ...turn.attempts,
            HandlerAttempt.make({
              number: turn.attempts.length + 1,
              status: "running",
            }),
          ],
          blocked: null,
          status: "running",
        })
      : TurnState.make({
          ...turn,
          attempts: turn.attempts.map((attempt, attemptIndex) =>
            attemptIndex === turn.attempts.length - 1
              ? HandlerAttempt.make({ ...attempt, status: "succeeded" })
              : attempt
          ),
          blocked: null,
          outcome: HandlerOutcomeState.make({
            category: null,
            kind: "success",
            safeDetail: null,
          }),
          status: "awaiting_delivery",
        });
  return [
    "Resolved",
    settleEligibleTurns(
      WorkThreadState.make({
        ...thread,
        outbox: appendRecoveryNotice(
          thread,
          request.ownerKind,
          request.ownerId,
          request.kind,
          request.decisionId
        ),
        turns: replaceAt(thread.turns, index, nextTurn),
      })
    ),
  ];
};

const resolveBlockedApplicationEvent = (
  thread: WorkThreadState,
  request: ResolveConversationBlockedRequest
): readonly ["AlreadyResolved" | "Resolved", WorkThreadState] | StoreError => {
  const index = findApplicationEventIndex(thread, request.ownerId);
  const event = thread.applicationEvents[index];
  if (event === undefined) {
    return storeFailure("resolveConversationBlocked", "owner-not-found");
  }
  if (event.status !== "blocked") {
    return event.status === "running" ||
      event.status === "awaiting_delivery" ||
      event.status === "completed"
      ? ["AlreadyResolved", thread]
      : storeFailure("resolveConversationBlocked", "owner-not-blocked");
  }
  if (
    event.blocked?.attemptId !== request.attemptId ||
    event.blocked.ownerId !== request.ownerId
  ) {
    return storeFailure("resolveConversationBlocked", "blocked-owner-conflict");
  }
  const nextEvent = ApplicationEventState.make({
    ...event,
    blocked: null,
    outcome:
      request.kind === "abandon"
        ? HandlerOutcomeState.make({
            category: null,
            kind: "success",
            safeDetail: null,
          })
        : null,
    status: request.kind === "retry" ? "running" : "awaiting_delivery",
  });
  return [
    "Resolved",
    settleEligibleApplicationEvents(
      WorkThreadState.make({
        ...thread,
        applicationEvents: replaceAt(
          thread.applicationEvents,
          index,
          nextEvent
        ),
        outbox: appendRecoveryNotice(
          thread,
          request.ownerKind,
          request.ownerId,
          request.kind,
          request.decisionId
        ),
      })
    ),
  ];
};

const resolveConversationBlockedTransition = (
  state: PrototypeState,
  request: ResolveConversationBlockedRequest
): readonly ["AlreadyResolved" | "Resolved", PrototypeState] | StoreError =>
  modifyThread(
    state,
    request.conversationId,
    "resolveConversationBlocked",
    (thread) => {
      const workspaceId = thread.workspaceId ?? `legacy:${thread.id}`;
      const workspaceMatches =
        workspaceId === request.workspaceId ||
        (thread.workspaceId === undefined && request.workspaceId === "legacy");
      if (!workspaceMatches) {
        return storeFailure("resolveConversationBlocked", "wrong-scope");
      }
      return request.ownerKind === "participant-turn"
        ? resolveBlockedTurn(thread, request)
        : resolveBlockedApplicationEvent(thread, request);
    }
  );

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
    blockConversationOwner: (blocked) =>
      transition("blockConversationOwner", (state) =>
        blockConversationOwnerTransition(state, blocked)
      ),
    acknowledgements: Ref.get(ref).pipe(
      Effect.map((state) => state.acknowledgements),
      Effect.mapError(() => storeFailure("acknowledgements", "read-failed"))
    ),
    completionReactions: Ref.get(ref).pipe(
      Effect.map((state) => state.completionReactions),
      Effect.mapError(() => storeFailure("completionReactions", "read-failed"))
    ),
    conversationStreams: Ref.get(ref).pipe(
      Effect.map((state) => state.conversationStreams),
      Effect.mapError(() => storeFailure("conversationStreams", "read-failed"))
    ),
    conversationStreamTombstones: Ref.get(ref).pipe(
      Effect.map((state) => state.conversationStreamTombstones),
      Effect.mapError(() =>
        storeFailure("conversationStreamTombstones", "read-failed")
      )
    ),
    accept: (event) =>
      transition("accept", (state) =>
        acceptTransition(state, event, laborerSlackId, initializeNewThreads)
      ),
    acceptApplicationEvent: (event) =>
      transition("acceptApplicationEvent", (state) =>
        acceptApplicationEventTransition(state, event)
      ),
    acceptConversationStreamChunk: (request) =>
      transition("acceptConversationStreamChunk", (state) =>
        acceptConversationStreamChunkTransition(state, request)
      ),
    configureConversationStream: (request) =>
      transition("configureConversationStream", (state) =>
        configureConversationStreamTransition(state, request)
      ),
    prepareConversationStreamOperation: (request) =>
      transition("prepareConversationStreamOperation", (state) =>
        prepareConversationStreamOperationTransition(state, request)
      ),
    reserveConversationStreamRateSlot: (request) =>
      transition("reserveConversationStreamRateSlot", (state) =>
        reserveConversationStreamRateSlotTransition(state, request)
      ),
    reserveSlackRateSlot: (request) =>
      transition("reserveSlackRateSlot", (state) =>
        reserveSlackRateSlotTransition(state, request)
      ),
    deferSlackRateBudget: (request) =>
      transition("deferSlackRateBudget", (state) =>
        deferSlackRateBudgetTransition(state, request)
      ),
    markConversationStreamOperationInFlight: (operationId, nowMillis) =>
      transition("markConversationStreamOperationInFlight", (state) =>
        markConversationStreamOperationInFlightTransition(
          state,
          operationId,
          nowMillis
        )
      ),
    settleConversationStreamOperation: (request) =>
      transition("settleConversationStreamOperation", (state) =>
        settleConversationStreamOperationTransition(state, request)
      ),
    requestConversationStreamFinalization: (request) =>
      transition<readonly string[], StoreError>(
        "requestConversationStreamFinalization",
        (state) =>
          requestConversationStreamFinalizationTransition(state, request)
      ),
    reconcileConversationStreamsOnRestart: (nowMillis) =>
      transition<readonly string[], StoreError>(
        "reconcileConversationStreamsOnRestart",
        (state) =>
          reconcileConversationStreamsOnRestartTransition(state, nowMillis)
      ),
    completeFallbackConversationStream: (streamId, terminalReason, nowMillis) =>
      transition("completeFallbackConversationStream", (state) =>
        completeFallbackConversationStreamTransition(
          state,
          streamId,
          terminalReason,
          nowMillis
        )
      ),
    completeConversationStreamLocally: (streamId, terminalReason, nowMillis) =>
      transition("completeConversationStreamLocally", (state) =>
        completeConversationStreamLocallyTransition(
          state,
          streamId,
          terminalReason,
          nowMillis
        )
      ),
    markConversationStreamUnresolved: (streamId, terminalReason, nowMillis) =>
      transition("markConversationStreamUnresolved", (state) =>
        markConversationStreamUnresolvedTransition(
          state,
          streamId,
          terminalReason,
          nowMillis
        )
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
                workspaceId: thread.workspaceId ?? `legacy:${thread.id}`,
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
    resolveConversationBlocked: (request) =>
      transition("resolveConversationBlocked", (state) =>
        resolveConversationBlockedTransition(state, request)
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

interface ReconciledConversationStreamChunk {
  readonly current: ConversationStreamState;
  readonly request: ConversationStreamChunkRequest;
  readonly state: PrototypeState;
}

const commonCodePointPrefixLength = (
  left: readonly string[],
  right: readonly string[]
): number => {
  const length = Math.min(left.length, right.length);
  let index = 0;
  while (index < length && left[index] === right[index]) {
    index += 1;
  }
  return index;
};

const withReplayCursor = (
  state: PrototypeState,
  streamIndex: number,
  stream: ConversationStreamState,
  replayCursorOffset: number | null
): PrototypeState =>
  replaceConversationStream(
    state,
    streamIndex,
    ConversationStreamState.make({
      ...stream,
      replayBoundaryOffset:
        replayCursorOffset === null ? null : stream.replayBoundaryOffset,
      replayCursorOffset,
    })
  );

const reconcileUnsequencedConversationStreamChunk = (
  state: PrototypeState,
  current: ConversationStreamState,
  streamIndex: number,
  request: ConversationStreamChunkRequest,
  streamId: string
):
  | {
      readonly _tag: "Append";
      readonly value: ReconciledConversationStreamChunk;
    }
  | { readonly _tag: "Duplicate"; readonly state: PrototypeState }
  | StoreError => {
  const boundary = current.replayBoundaryOffset;
  const cursor = current.replayCursorOffset;
  if (boundary === null || cursor === null) {
    return {
      _tag: "Append",
      value: { current, request, state },
    };
  }
  if (cursor < 0 || cursor > boundary) {
    return storeFailure(
      "acceptConversationStreamChunk",
      "invalid-stream-replay-cursor"
    );
  }
  if (cursor === boundary) {
    const nextState = withReplayCursor(state, streamIndex, current, null);
    const nextCurrent = nextState.conversationStreams[streamIndex];
    if (nextCurrent === undefined) {
      return storeFailure(
        "acceptConversationStreamChunk",
        "stream-not-found-after-replay"
      );
    }
    return {
      _tag: "Append",
      value: { current: nextCurrent, request, state: nextState },
    };
  }
  const durableRemainder = [...current.cumulativeText].slice(cursor, boundary);
  const incoming = [...request.text];
  const commonLength = commonCodePointPrefixLength(durableRemainder, incoming);
  if (commonLength === incoming.length) {
    return {
      _tag: "Duplicate",
      state: withReplayCursor(
        state,
        streamIndex,
        current,
        cursor + incoming.length
      ),
    };
  }
  if (commonLength === durableRemainder.length) {
    const continuation = incoming.slice(commonLength).join("");
    const nextState = withReplayCursor(state, streamIndex, current, null);
    const nextCurrent = nextState.conversationStreams[streamIndex];
    if (nextCurrent === undefined) {
      return storeFailure(
        "acceptConversationStreamChunk",
        "stream-not-found-after-replay"
      );
    }
    return {
      _tag: "Append",
      value: {
        current: nextCurrent,
        request: { ...request, text: continuation },
        state: nextState,
      },
    };
  }
  if (cursor === 0 && commonLength === 0) {
    const nextState = withReplayCursor(state, streamIndex, current, null);
    const nextCurrent = nextState.conversationStreams[streamIndex];
    if (nextCurrent === undefined) {
      return storeFailure(
        "acceptConversationStreamChunk",
        "stream-not-found-after-replay"
      );
    }
    return {
      _tag: "Append",
      value: { current: nextCurrent, request, state: nextState },
    };
  }
  return storeFailure(
    "acceptConversationStreamChunk",
    `conflicting-stream-replay:${streamId}`
  );
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
  if (turn.status === "blocked") {
    return "interrupted";
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
  const blockIsCoherent =
    turn.status === "blocked"
      ? turn.blocked != null &&
        turn.outcome === null &&
        latest?.status === "interrupted"
      : turn.blocked == null;
  if (!blockIsCoherent) {
    return storeFailure("validate", "invalid-blocked-turn");
  }
  if (
    turn.status === "running" &&
    (latest?.status !== "running" || turn.outcome !== null)
  ) {
    return storeFailure("validate", "invalid-running-turn");
  }
  if (
    turn.status !== "running" &&
    turn.status !== "blocked" &&
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
    (turn) =>
      turn.status === "running" ||
      turn.status === "awaiting_delivery" ||
      turn.status === "blocked"
  );
  if (activeTurns.length > 1) {
    return storeFailure("validate", "multiple-active-turns");
  }
  for (const [turnIndex, turn] of thread.turns.entries()) {
    const isActive =
      turn.status === "running" ||
      turn.status === "awaiting_delivery" ||
      turn.status === "blocked";
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

const runningOwnerHasOnlyPendingNewOutbound = (
  ownerId: TurnId,
  outbox: readonly OutboundItem[]
): boolean => {
  const retryNoticePrefix = `notice:${ownerId}:recovery:retry`;
  let latestRetryNoticeIndex = -1;
  for (const [index, item] of outbox.entries()) {
    if (item.id.startsWith(retryNoticePrefix)) {
      latestRetryNoticeIndex = index;
    }
  }
  const newOutbound = outbox.slice(latestRetryNoticeIndex + 1);
  return EffectArray.every(newOutbound, (item) => item.status === "pending");
};

const validateTurnSettlement = (
  turn: TurnState,
  outbox: readonly OutboundItem[]
): StoreError | null => {
  if (turn.status === "running") {
    return runningOwnerHasOnlyPendingNewOutbound(turn.id, outbox)
      ? null
      : storeFailure("validate", "running-turn-with-nonpending-outbound");
  }
  if (turn.status === "blocked") {
    return null;
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
  if (notice.id.startsWith(`notice:${turn.id}:recovery:`)) {
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
  const isActive =
    event.status === "pending" ||
    event.status === "running" ||
    event.status === "blocked";
  if (
    (event.status === "blocked") !== (event.blocked != null) ||
    (event.blocked != null && event.blocked.ownerId !== event.eventId)
  ) {
    return storeFailure("validate", "invalid-blocked-application-event");
  }
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
  if (event.status === "blocked") {
    return null;
  }
  if (
    event.status === "running" &&
    !runningOwnerHasOnlyPendingNewOutbound(
      applicationEventTurnId(event.eventId),
      outbox
    )
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
      state.acknowledgements.map((acknowledgement) => {
        const activationThread = state.threads.find(
          (thread) =>
            thread.channelId === acknowledgement.channelId &&
            thread.activationEventId === acknowledgement.eventId
        );
        return `${activationThread?.workspaceId ?? ""}\u0000${acknowledgement.channelId}\u0000${acknowledgement.messageTs}`;
      })
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

const operationKindMatchesMode = (
  mode: ConversationStreamMode | null,
  kind: ConversationStreamOperationKind
): boolean => {
  if (mode === "native") {
    return (
      kind === "native-start" ||
      kind === "native-append" ||
      kind === "native-stop"
    );
  }
  return mode === "fallback"
    ? kind === "fallback-post" || kind === "fallback-update"
    : false;
};

const invalidOperationTimestamps = (
  operation: ConversationStreamOperation
): boolean => {
  const hasInFlight = operation.inFlightAtMillis !== null;
  const hasRetry = operation.retryAtMillis !== null;
  const hasSettlement = operation.settledAtMillis !== null;
  if (
    !Number.isSafeInteger(operation.preparedAtMillis) ||
    operation.preparedAtMillis < 0 ||
    (hasInFlight &&
      (!Number.isSafeInteger(operation.inFlightAtMillis) ||
        (operation.inFlightAtMillis ?? -1) < operation.preparedAtMillis)) ||
    (hasRetry &&
      (!Number.isSafeInteger(operation.retryAtMillis) ||
        (operation.retryAtMillis ?? -1) < (operation.inFlightAtMillis ?? 0))) ||
    (hasSettlement &&
      (!Number.isSafeInteger(operation.settledAtMillis) ||
        (operation.settledAtMillis ?? -1) < (operation.inFlightAtMillis ?? 0)))
  ) {
    return true;
  }
  switch (operation.status) {
    case "prepared":
      return (
        hasInFlight || hasRetry || hasSettlement || operation.attempt !== 0
      );
    case "in_flight":
      return !hasInFlight || hasRetry || hasSettlement || operation.attempt < 1;
    case "retry":
      return (
        !(hasInFlight && hasRetry) || hasSettlement || operation.attempt < 1
      );
    case "acknowledged":
    case "rejected":
    case "stopped_by_user":
    case "unresolved":
      return (
        !hasInFlight || hasRetry || !hasSettlement || operation.attempt < 1
      );
    default:
      return true;
  }
};

const invalidConversationStreamOperation = (
  operation: ConversationStreamOperation,
  stream: ConversationStreamState
): boolean => {
  const operationIsActive =
    operation.status === "prepared" ||
    operation.status === "in_flight" ||
    operation.status === "retry";
  const invalidActiveNativeAppend =
    operation.kind === "native-append" &&
    operationIsActive &&
    ((stream.lifecycle !== "open" && stream.lifecycle !== "finalizing") ||
      operation.payloadStartOffset !== stream.confirmedOffset ||
      operation.payloadEndOffset <= stream.confirmedOffset);
  return (
    !operationKindMatchesMode(stream.mode, operation.kind) ||
    operation.payloadHash !== sha256(operation.payloadText) ||
    !Number.isSafeInteger(operation.payloadStartOffset) ||
    !Number.isSafeInteger(operation.payloadEndOffset) ||
    operation.payloadStartOffset < 0 ||
    operation.payloadEndOffset < operation.payloadStartOffset ||
    operation.payloadEndOffset > [...stream.cumulativeText].length ||
    (operation.kind === "native-stop"
      ? operation.payloadText.length > 0 ||
        operation.payloadStartOffset !== operation.payloadEndOffset
      : operation.payloadText !==
        [...stream.cumulativeText]
          .slice(operation.payloadStartOffset, operation.payloadEndOffset)
          .join("")) ||
    !Number.isSafeInteger(operation.attempt) ||
    operation.attempt < 0 ||
    operation.attempt > MAX_CONVERSATION_STREAM_OPERATION_ATTEMPTS ||
    invalidOperationTimestamps(operation) ||
    ((operation.kind === "native-append" ||
      operation.kind === "native-stop" ||
      operation.kind === "fallback-update") &&
      stream.slackTs === null) ||
    ((operation.status === "rejected" || operation.status === "unresolved") &&
      operation.errorCategory === null) ||
    (operation.status === "rejected" &&
      operation.errorCertainty !== "definitely-rejected") ||
    (operation.status === "stopped_by_user" &&
      (operation.errorCategory !== "stopped_by_user" ||
        operation.errorCertainty !== "definitely-rejected")) ||
    (operation.status === "unresolved" &&
      operation.errorCertainty !== "unknown") ||
    invalidActiveNativeAppend
  );
};

const conversationStreamOwnerStatusIsCompatible = (
  state: PrototypeState,
  stream: ConversationStreamState
): boolean => {
  const thread = state.threads.find(
    (candidate) => candidate.id === stream.threadId
  );
  if (thread === undefined) {
    return false;
  }
  if (stream.lifecycle === "stopped" || stream.lifecycle === "unresolved") {
    return true;
  }
  if (
    stream.lifecycle === "finalizing" &&
    stream.terminalReason === "restart"
  ) {
    return true;
  }
  if (stream.ownerKind === "participant-turn") {
    return (
      thread.turns.find((turn) => turn.id === stream.ownerId)?.status ===
      "running"
    );
  }
  return (
    thread.applicationEvents.find((event) => event.eventId === stream.ownerId)
      ?.status === "running"
  );
};

const invalidConversationStreamReplayCursor = (
  stream: ConversationStreamState,
  totalOffset: number
): boolean => {
  const hasReplayCursor =
    stream.replayBoundaryOffset !== null || stream.replayCursorOffset !== null;
  if (!hasReplayCursor) {
    return false;
  }
  const lifecycleIsValid =
    (stream.lifecycle === "open" && stream.terminalReason === null) ||
    (stream.lifecycle === "finalizing" && stream.terminalReason === "restart");
  return (
    stream.replayBoundaryOffset === null ||
    stream.replayCursorOffset === null ||
    !lifecycleIsValid ||
    stream.replayCursorOffset < 0 ||
    stream.replayBoundaryOffset < stream.replayCursorOffset ||
    stream.replayBoundaryOffset > totalOffset
  );
};

const conversationStreamFailure = (
  state: PrototypeState,
  stream: ConversationStreamState,
  operationIds: string[]
): StoreError | null => {
  const totalOffset = slackCodePointLength(stream.cumulativeText);
  const expectedId = stableConversationStreamId({
    messageId: stream.messageId,
    ownerId: stream.ownerId,
    ownerKind: stream.ownerKind,
    threadId: stream.threadId,
    workspaceId: stream.workspaceId,
  });
  const reconstructed = stream.chunks.map((chunk) => chunk.text).join("");
  const activeCount = stream.operations.filter(
    (operation) =>
      operation.status === "prepared" ||
      operation.status === "in_flight" ||
      operation.status === "retry"
  ).length;
  const hasInvalidChunks =
    stream.chunks.length === 0 ||
    stream.chunks.length > MAX_CONVERSATION_STREAM_CHUNKS ||
    stream.acceptedSequence !== stream.chunks.length - 1 ||
    stream.chunks.some(
      (chunk, index) =>
        chunk.sequence !== index || chunk.textHash !== sha256(chunk.text)
    );
  const hasInvalidText =
    reconstructed !== stream.cumulativeText ||
    stream.cumulativeHash !== sha256(stream.cumulativeText) ||
    totalOffset > SLACK_MARKDOWN_TEXT_CODE_POINT_LIMIT;
  const hasInvalidConfirmation =
    stream.confirmedOffset < 0 ||
    stream.confirmedOffset > totalOffset ||
    stream.confirmedHash !==
      sha256(
        [...stream.cumulativeText].slice(0, stream.confirmedOffset).join("")
      );
  const hasInvalidCompaction =
    !Number.isSafeInteger(stream.compactedOperationCount) ||
    stream.compactedOperationCount < 0 ||
    !Number.isSafeInteger(stream.compactedConfirmedOffset) ||
    stream.compactedConfirmedOffset < 0 ||
    stream.compactedConfirmedOffset > stream.confirmedOffset ||
    (stream.compactedConfirmedHash !== "" &&
      stream.compactedConfirmedHash !==
        sha256(
          [...stream.cumulativeText]
            .slice(0, stream.compactedConfirmedOffset)
            .join("")
        ));
  const hasInvalidTimes =
    !Number.isSafeInteger(stream.createdAtMillis) ||
    stream.createdAtMillis < 0 ||
    (stream.stoppedAtMillis !== null &&
      (!Number.isSafeInteger(stream.stoppedAtMillis) ||
        stream.stoppedAtMillis < stream.createdAtMillis)) ||
    (stream.lifecycle === "stopped" || stream.lifecycle === "unresolved") !==
      (stream.stoppedAtMillis !== null);
  const terminalWithActiveOperation =
    (stream.lifecycle === "stopped" || stream.lifecycle === "unresolved") &&
    activeCount > 0;
  const terminalOutcomeMismatch = stream.operations.some(
    (operation) =>
      ((operation.status === "unresolved" || operation.status === "rejected") &&
        stream.lifecycle !== "unresolved") ||
      (operation.status === "stopped_by_user" && stream.lifecycle !== "stopped")
  );
  const invalidReplayCursor = invalidConversationStreamReplayCursor(
    stream,
    totalOffset
  );
  if (
    stream.id !== expectedId ||
    hasInvalidChunks ||
    hasInvalidText ||
    hasInvalidConfirmation ||
    hasInvalidCompaction ||
    hasInvalidTimes ||
    activeCount > 1 ||
    terminalWithActiveOperation ||
    terminalOutcomeMismatch ||
    invalidReplayCursor ||
    !conversationStreamOwnerStatusIsCompatible(state, stream) ||
    stream.operations.length > MAX_CONVERSATION_STREAM_OPERATIONS
  ) {
    return storeFailure("validate", "invalid-conversation-stream-state");
  }
  for (const operation of stream.operations) {
    operationIds.push(operation.id);
    if (invalidConversationStreamOperation(operation, stream)) {
      return storeFailure("validate", "invalid-conversation-stream-operation");
    }
  }
  return null;
};

const conversationStreamRecordIdentityFailure = (
  state: PrototypeState,
  record: {
    readonly channelId: string;
    readonly id: string;
    readonly messageId: string;
    readonly ownerId: string;
    readonly ownerKind: ConversationStreamOwnerKind;
    readonly recipientUserId: string | null;
    readonly rootTs: string;
    readonly threadId: ThreadId;
    readonly workspaceId: string;
  }
): StoreError | null => {
  const thread = state.threads.find(
    (candidate) => candidate.id === record.threadId
  );
  const expectedWorkspaceId =
    thread?.workspaceId ?? (thread === undefined ? "" : `legacy:${thread.id}`);
  if (
    thread === undefined ||
    record.workspaceId !== expectedWorkspaceId ||
    record.channelId !== thread.channelId ||
    record.rootTs !== thread.rootTs ||
    record.threadId !==
      canonicalThreadId(thread.channelId, thread.rootTs, thread.workspaceId) ||
    !conversationStreamOwnerExists(thread, record.ownerKind, record.ownerId) ||
    !recipientBelongsToConversationStreamOwner(
      thread,
      record.ownerKind,
      record.ownerId,
      record.recipientUserId
    ) ||
    record.id !== stableConversationStreamId(record)
  ) {
    return storeFailure("validate", "invalid-conversation-stream-identity");
  }
  return null;
};

const conversationStreamTombstoneFailure = (
  state: PrototypeState,
  tombstone: ConversationStreamTombstone
): StoreError | null => {
  const identityFailure = conversationStreamRecordIdentityFailure(
    state,
    tombstone
  );
  if (identityFailure !== null) {
    return identityFailure;
  }
  const invalidOperationEvidence = tombstone.operations.some((operation) => {
    const hasInFlight = operation.inFlightAtMillis !== null;
    const hasSettlement = operation.settledAtMillis !== null;
    return (
      !(
        operationKindMatchesMode(tombstone.mode, operation.kind) &&
        Number.isSafeInteger(operation.attempt)
      ) ||
      operation.attempt < 1 ||
      operation.attempt > MAX_CONVERSATION_STREAM_OPERATION_ATTEMPTS ||
      !Number.isSafeInteger(operation.preparedAtMillis) ||
      operation.preparedAtMillis < 0 ||
      !hasInFlight ||
      !Number.isSafeInteger(operation.inFlightAtMillis) ||
      (operation.inFlightAtMillis ?? -1) < operation.preparedAtMillis ||
      !hasSettlement ||
      !Number.isSafeInteger(operation.settledAtMillis) ||
      (operation.settledAtMillis ?? -1) < (operation.inFlightAtMillis ?? 0) ||
      operation.payloadStartOffset < 0 ||
      operation.payloadEndOffset < operation.payloadStartOffset ||
      operation.payloadHash.trim().length === 0 ||
      ((operation.status === "rejected" || operation.status === "unresolved") &&
        operation.errorCategory === null) ||
      (operation.status === "rejected" &&
        operation.errorCertainty !== "definitely-rejected") ||
      (operation.status === "stopped_by_user" &&
        (operation.errorCategory !== "stopped_by_user" ||
          operation.errorCertainty !== "definitely-rejected")) ||
      (operation.status === "unresolved" &&
        operation.errorCertainty !== "unknown") ||
      ((operation.status === "rejected" || operation.status === "unresolved") &&
        tombstone.lifecycle !== "unresolved") ||
      (operation.status === "stopped_by_user" &&
        tombstone.lifecycle !== "stopped")
    );
  });
  if (
    !Number.isSafeInteger(tombstone.stoppedAtMillis) ||
    tombstone.stoppedAtMillis < 0 ||
    tombstone.acceptedSequence !== tombstone.chunkHashes.length - 1 ||
    tombstone.chunkHashes.some(
      (chunk, index) =>
        chunk.sequence !== index || chunk.textHash.trim().length === 0
    ) ||
    tombstone.cumulativeHash.trim().length === 0 ||
    tombstone.confirmedHash.trim().length === 0 ||
    !Number.isSafeInteger(tombstone.confirmedOffset) ||
    tombstone.confirmedOffset < 0 ||
    tombstone.terminalReason.trim().length === 0 ||
    invalidOperationEvidence
  ) {
    return storeFailure("validate", "invalid-conversation-stream-tombstone");
  }
  return null;
};

const validateConversationStreams = (
  state: PrototypeState
): StoreError | null => {
  const duplicateStreamId = duplicateValue(
    state.conversationStreams.map((stream) => stream.id)
  );
  const duplicateBudget = duplicateValue(
    state.conversationStreamRateBudgets.map(
      (budget) =>
        `${budget.workspaceId}\u0000${budget.method}\u0000${budget.scope}\u0000${budget.channelId ?? ""}`
    )
  );
  const recordIdentities = [
    ...state.conversationStreams,
    ...state.conversationStreamTombstones,
  ];
  const duplicateOwnerMessage = duplicateValue(
    recordIdentities.map(
      (record) =>
        `${record.threadId}\u0000${record.ownerKind}\u0000${record.ownerId}\u0000${record.messageId}`
    )
  );
  const duplicateRecordId = duplicateValue(
    recordIdentities.map((record) => record.id)
  );
  if (
    state.conversationStreams.length > MAX_CONVERSATION_STREAMS ||
    state.conversationStreamTombstones.length >
      MAX_CONVERSATION_STREAM_TOMBSTONES ||
    tombstoneEncodedBytes(state.conversationStreamTombstones) >
      MAX_CONVERSATION_STREAM_TOMBSTONE_BYTES ||
    state.conversationStreamRateBudgets.length >
      MAX_CONVERSATION_STREAM_RATE_BUDGETS ||
    duplicateStreamId !== null ||
    duplicateBudget !== null ||
    duplicateOwnerMessage !== null ||
    duplicateRecordId !== null
  ) {
    return storeFailure("validate", "invalid-conversation-stream-collection");
  }
  const operationIds: string[] = [];
  for (const stream of state.conversationStreams) {
    const identityFailure = conversationStreamRecordIdentityFailure(
      state,
      stream
    );
    if (identityFailure !== null) {
      return identityFailure;
    }
    const failure = conversationStreamFailure(state, stream, operationIds);
    if (failure !== null) {
      return failure;
    }
  }
  for (const tombstone of state.conversationStreamTombstones) {
    const failure = conversationStreamTombstoneFailure(state, tombstone);
    if (failure !== null) {
      return failure;
    }
  }
  if (duplicateValue(operationIds) !== null) {
    return storeFailure("validate", "duplicate-conversation-stream-operation");
  }
  const invalidBudget = state.conversationStreamRateBudgets.some(
    (budget) =>
      !Number.isSafeInteger(budget.nextAvailableAtMillis) ||
      budget.nextAvailableAtMillis < 0 ||
      budget.method.trim().length === 0 ||
      (budget.scope === "method" && budget.channelId !== null) ||
      (budget.scope === "channel" &&
        (budget.method !== "chat.postMessage" || budget.channelId === null))
  );
  return invalidBudget
    ? storeFailure("validate", "invalid-conversation-stream-rate-budget")
    : null;
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
  const streamFailure = validateConversationStreams(state);
  if (streamFailure !== null) {
    return streamFailure;
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
      if (
        new TextEncoder().encode(JSON.stringify(decoded)).byteLength >
        MAX_RUNNER_STATE_BYTES
      ) {
        return Effect.fail(
          storeFailure("validate", "state-byte-bound-exceeded")
        );
      }
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
      const encoded = JSON.stringify(state);
      if (
        new TextEncoder().encode(encoded).byteLength > MAX_RUNNER_STATE_BYTES
      ) {
        throw new Error("Runner state exceeds its byte bound");
      }
      await file.writeFile(encoded, { encoding: "utf8", signal });
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
      const metadata = await file.stat();
      if (metadata.size > MAX_RUNNER_STATE_BYTES) {
        throw new Error("Runner state exceeds its byte bound");
      }
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

const numericOperationTimes = (
  operations: readonly Record<string, unknown>[],
  key: "preparedAtMillis" | "settledAtMillis"
): number[] =>
  operations
    .map((operation) => operation[key])
    .filter((time): time is number => typeof time === "number");

const inferredStoppedAtMillis = (
  candidate: Record<string, unknown>,
  settledTimes: readonly number[],
  createdAtMillis: number
): number | null => {
  if (candidate.lifecycle !== "stopped") {
    return null;
  }
  return settledTimes.length === 0
    ? createdAtMillis
    : Math.max(...settledTimes);
};

const missingMigrationField = (
  candidate: Record<string, unknown>,
  key: string,
  value: unknown
): Record<string, unknown> =>
  Object.hasOwn(candidate, key) ? {} : { [key]: value };

const migrateConversationStream = (
  candidate: unknown
): { readonly changed: boolean; readonly value: unknown } => {
  if (!isUnknownRecord(candidate)) {
    return { changed: false, value: candidate };
  }
  const operations = Array.isArray(candidate.operations)
    ? candidate.operations.filter(isUnknownRecord)
    : [];
  const migratedOperations = operations.map((operation) => ({
    ...operation,
    ...missingMigrationField(operation, "errorCertainty", null),
  }));
  const preparedTimes = numericOperationTimes(operations, "preparedAtMillis");
  const settledTimes = numericOperationTimes(operations, "settledAtMillis");
  const createdAtMillis =
    preparedTimes.length === 0 ? 0 : Math.min(...preparedTimes);
  const stoppedAtMillis = inferredStoppedAtMillis(
    candidate,
    settledTimes,
    createdAtMillis
  );
  const additions = {
    ...missingMigrationField(candidate, "compactedConfirmedHash", sha256("")),
    ...missingMigrationField(candidate, "compactedConfirmedOffset", 0),
    ...missingMigrationField(candidate, "compactedOperationCount", 0),
    ...missingMigrationField(candidate, "createdAtMillis", createdAtMillis),
    ...(migratedOperations.some(
      (operation, index) => operation !== operations[index]
    )
      ? { operations: migratedOperations }
      : {}),
    ...missingMigrationField(candidate, "replayBoundaryOffset", null),
    ...missingMigrationField(candidate, "replayCursorOffset", null),
    ...missingMigrationField(candidate, "stoppedAtMillis", stoppedAtMillis),
  };
  return Object.keys(additions).length === 0
    ? { changed: false, value: candidate }
    : { changed: true, value: { ...candidate, ...additions } };
};

const migrateConversationStreamTombstones = (
  value: unknown
): { readonly changed: boolean; readonly value: unknown } => {
  if (!Array.isArray(value)) {
    return { changed: false, value };
  }
  const migrated = value.map((candidate) => {
    if (!isUnknownRecord(candidate)) {
      return candidate;
    }
    return {
      ...candidate,
      ...missingMigrationField(candidate, "confirmedHash", sha256("")),
      ...missingMigrationField(candidate, "confirmedOffset", 0),
      ...missingMigrationField(candidate, "lifecycle", "stopped"),
      ...missingMigrationField(candidate, "mode", null),
      ...missingMigrationField(candidate, "operations", []),
      ...missingMigrationField(candidate, "terminalReason", "completed"),
    };
  });
  const changed = migrated.some(
    (candidate, index) => candidate !== value[index]
  );
  return { changed, value: migrated };
};

const migrateConversationStreams = (
  value: unknown
): { readonly changed: boolean; readonly value: unknown } => {
  if (!Array.isArray(value)) {
    return { changed: false, value };
  }
  const migrations = value.map(migrateConversationStream);
  return {
    changed: migrations.some(({ changed }) => changed),
    value: migrations.map((migration) => migration.value),
  };
};

const migrateConversationStreamRateBudgets = (
  value: unknown
): { readonly changed: boolean; readonly value: unknown } => {
  if (!Array.isArray(value)) {
    return { changed: false, value };
  }
  let changed = false;
  const methodBudgets = new Map<string, Record<string, unknown>>();
  const channelBudgets = new Map<string, Record<string, unknown>>();
  for (const candidate of value) {
    if (
      !isUnknownRecord(candidate) ||
      typeof candidate.workspaceId !== "string" ||
      typeof candidate.method !== "string" ||
      typeof candidate.nextAvailableAtMillis !== "number"
    ) {
      continue;
    }
    const legacyKinds: readonly ConversationStreamOperationKind[] = [
      "fallback-post",
      "fallback-update",
      "native-append",
      "native-start",
      "native-stop",
    ];
    const method = legacyKinds.includes(
      candidate.method as ConversationStreamOperationKind
    )
      ? slackMethodForOperationKind(
          candidate.method as ConversationStreamOperationKind
        )
      : candidate.method;
    changed = changed || method !== candidate.method || !("scope" in candidate);
    const methodKey = `${candidate.workspaceId}\u0000${method}`;
    const existingMethod = methodBudgets.get(methodKey);
    methodBudgets.set(methodKey, {
      channelId: null,
      method,
      nextAvailableAtMillis: Math.max(
        candidate.nextAvailableAtMillis,
        typeof existingMethod?.nextAvailableAtMillis === "number"
          ? existingMethod.nextAvailableAtMillis
          : 0
      ),
      scope: "method",
      workspaceId: candidate.workspaceId,
    });
    if (
      method === "chat.postMessage" &&
      typeof candidate.channelId === "string"
    ) {
      const channelKey = `${methodKey}\u0000${candidate.channelId}`;
      const existingChannel = channelBudgets.get(channelKey);
      channelBudgets.set(channelKey, {
        channelId: candidate.channelId,
        method,
        nextAvailableAtMillis: Math.max(
          candidate.nextAvailableAtMillis,
          typeof existingChannel?.nextAvailableAtMillis === "number"
            ? existingChannel.nextAvailableAtMillis
            : 0
        ),
        scope: "channel",
        workspaceId: candidate.workspaceId,
      });
    }
  }
  return {
    changed,
    value: [...methodBudgets.values(), ...channelBudgets.values()],
  };
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
  const streamMigration = migrateConversationStreams(value.conversationStreams);
  const tombstoneMigration = migrateConversationStreamTombstones(
    value.conversationStreamTombstones
  );
  const budgetMigration = migrateConversationStreamRateBudgets(
    value.conversationStreamRateBudgets
  );
  changed =
    needsCompletionReactions ||
    streamMigration.changed ||
    tombstoneMigration.changed ||
    budgetMigration.changed;
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
        ...(budgetMigration.changed
          ? { conversationStreamRateBudgets: budgetMigration.value }
          : {}),
        ...(streamMigration.changed
          ? { conversationStreams: streamMigration.value }
          : {}),
        ...(tombstoneMigration.changed
          ? { conversationStreamTombstones: tombstoneMigration.value }
          : {}),
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
