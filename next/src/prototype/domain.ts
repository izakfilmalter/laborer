/**
 * THROWAWAY ISSUE #204 PROTOTYPE.
 * Runtime-decoded boundary and durable-state records for the tracer bullet.
 */
import { Effect, Schema } from "effect";

export const ProtocolVersion = Schema.Literal(1);
export type ProtocolVersion = typeof ProtocolVersion.Type;

export const EventId = Schema.String.pipe(Schema.brand("EventId"));
export type EventId = typeof EventId.Type;
export const MessageId = Schema.String.pipe(Schema.brand("MessageId"));
export type MessageId = typeof MessageId.Type;
export const ThreadId = Schema.String.pipe(Schema.brand("ThreadId"));
export type ThreadId = typeof ThreadId.Type;
export const TurnId = Schema.String.pipe(Schema.brand("TurnId"));
export type TurnId = typeof TurnId.Type;
export const ReplyId = Schema.String.check(Schema.isPattern(/\S/)).pipe(
  Schema.brand("ReplyId")
);
export type ReplyId = typeof ReplyId.Type;

export const ChannelKind = Schema.Literals(["public", "private", "direct"]);
export type ChannelKind = typeof ChannelKind.Type;
export const AuthorKind = Schema.Literals(["human", "externalBot", "laborer"]);
export type AuthorKind = typeof AuthorKind.Type;

export const NormalizedImageFailureReason = Schema.Literals([
  "download-timeout",
  "image-count-exceeded",
  "invalid-response",
  "metadata-unavailable",
  "mime-mismatch",
  "size-exceeded",
  "storage-failed",
  "unsupported-mime",
  "unsafe-download-url",
]);
export type NormalizedImageFailureReason =
  typeof NormalizedImageFailureReason.Type;

export class ReadyNormalizedImageInput extends Schema.TaggedClass<ReadyNormalizedImageInput>()(
  "Ready",
  {
    byteLength: Schema.Int,
    contentDigest: Schema.NonEmptyString,
    id: Schema.NonEmptyString,
    mimeType: Schema.Literals([
      "image/gif",
      "image/jpeg",
      "image/png",
      "image/webp",
    ]),
    storagePath: Schema.NonEmptyString,
  }
) {}

export class FailedNormalizedImageInput extends Schema.TaggedClass<FailedNormalizedImageInput>()(
  "Failed",
  {
    id: Schema.NonEmptyString,
    reason: NormalizedImageFailureReason,
  }
) {}

export const NormalizedImageInput = Schema.Union([
  ReadyNormalizedImageInput,
  FailedNormalizedImageInput,
]);
export type NormalizedImageInput = typeof NormalizedImageInput.Type;
export const InboundRecordKind = Schema.Literals([
  "message",
  "message_changed",
  "message_deleted",
  "reaction",
  "system",
]);
export type InboundRecordKind = typeof InboundRecordKind.Type;

export class NormalizedInboundEvent extends Schema.Class<NormalizedInboundEvent>(
  "NormalizedInboundEvent"
)({
  authorKind: AuthorKind,
  authorSlackId: Schema.String,
  channelId: Schema.String,
  channelKind: ChannelKind,
  eventId: EventId,
  messageTs: Schema.String,
  recordKind: InboundRecordKind,
  text: Schema.NullOr(Schema.String),
  threadTs: Schema.NullOr(Schema.String),
  workspaceId: Schema.optional(Schema.String),
}) {}

export class NormalizedMessage extends Schema.Class<NormalizedMessage>(
  "NormalizedMessage"
)({
  authorKind: AuthorKind,
  authorSlackId: Schema.String,
  classification: Schema.Literals(["context", "input"]),
  id: MessageId,
  images: Schema.optional(Schema.Array(NormalizedImageInput)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([]))
  ),
  isActivation: Schema.Boolean,
  slackTs: Schema.String,
  text: Schema.String,
}) {}

export class PublicReplyProtocolRecord extends Schema.Class<PublicReplyProtocolRecord>(
  "PublicReplyProtocolRecord"
)({
  protocolVersion: ProtocolVersion,
  replyId: ReplyId,
  text: Schema.String,
  type: Schema.Literal("public_reply"),
}) {}

export class InitializedProtocolRecord extends Schema.Class<InitializedProtocolRecord>(
  "InitializedProtocolRecord"
)({
  protocolVersion: ProtocolVersion,
  type: Schema.Literal("initialized"),
  workingDirectory: Schema.String,
}) {}

export const UnknownProtocolRecord = Schema.Struct({
  protocolVersion: ProtocolVersion,
  type: Schema.String,
});

export class HandlerInputEnvelope extends Schema.Class<HandlerInputEnvelope>(
  "HandlerInputEnvelope"
)({
  messages: Schema.Array(NormalizedMessage),
  protocolVersion: ProtocolVersion,
  stateDirectory: Schema.String,
  turnId: TurnId,
  workThreadId: ThreadId,
}) {}

const IgnoredReason = Schema.Literals([
  "duplicate",
  "laborer-authored",
  "unsupported-channel",
  "blank",
  "unsupported-record",
  "outside-active-thread",
  "duplicate-message",
]);
export type IgnoredReason = typeof IgnoredReason.Type;

export class IgnoredInbound extends Schema.Class<IgnoredInbound>(
  "IgnoredInbound"
)({
  eventId: EventId,
  reason: IgnoredReason,
}) {}

export class HandlerAttempt extends Schema.Class<HandlerAttempt>(
  "HandlerAttempt"
)({
  number: Schema.Number,
  status: Schema.Literals(["running", "interrupted", "succeeded", "failed"]),
}) {}

export class ConversationBlockedState extends Schema.Class<ConversationBlockedState>(
  "ConversationBlockedState"
)({
  attemptId: Schema.NonEmptyString,
  bindingGeneration: Schema.NullOr(Schema.Int),
  blockedAt: Schema.Int,
  conversationId: ThreadId,
  decisionId: Schema.NullOr(Schema.NonEmptyString),
  decisionKind: Schema.NullOr(Schema.Literals(["abandon", "retry"])),
  ownerId: Schema.NonEmptyString,
  ownerKind: Schema.Literals(["application-event", "participant-turn"]),
  processGeneration: Schema.Int,
  promptId: Schema.NonEmptyString,
  replacementAttemptId: Schema.NullOr(Schema.NonEmptyString),
  sessionDisposition: Schema.NullOr(
    Schema.Literals(["replaced", "resumed-quiescent"])
  ),
  workspaceId: Schema.NonEmptyString,
}) {}

export const HandlerFailureCategory = Schema.Literals([
  "spawn",
  "protocol",
  "exit",
  "signal",
  "timeout",
]);
export type HandlerFailureCategory = typeof HandlerFailureCategory.Type;

export class HandlerOutcomeState extends Schema.Class<HandlerOutcomeState>(
  "HandlerOutcomeState"
)({
  category: Schema.NullOr(HandlerFailureCategory),
  kind: Schema.Literals(["success", "failure"]),
  safeDetail: Schema.NullOr(Schema.String),
}) {}

export type JsonValue = typeof Schema.Json.Type;
export type JsonArray = Schema.JsonArray;
export type JsonObject = Schema.JsonObject;

export class OutboundItem extends Schema.Class<OutboundItem>("OutboundItem")({
  deliveryAttempts: Schema.Number,
  id: Schema.String,
  kind: Schema.Literals(["public_reply", "operational_notice"]),
  lastErrorCategory: Schema.NullOr(Schema.String),
  replyId: Schema.NullOr(ReplyId),
  retryAtMillis: Schema.NullOr(Schema.Number),
  slackTs: Schema.NullOr(Schema.String),
  status: Schema.Literals([
    "pending",
    "delivering",
    "delivered",
    "blocked",
    "abandoned",
  ]),
  text: Schema.String,
  turnId: TurnId,
}) {}

export class TurnState extends Schema.Class<TurnState>("TurnState")({
  attempts: Schema.Array(HandlerAttempt),
  blocked: Schema.optional(Schema.NullOr(ConversationBlockedState)),
  context: Schema.Array(NormalizedMessage),
  id: TurnId,
  messages: Schema.Array(NormalizedMessage),
  outcome: Schema.NullOr(HandlerOutcomeState),
  status: Schema.Literals([
    "running",
    "blocked",
    "awaiting_delivery",
    "completed",
    "failed",
  ]),
}) {}

export class ApplicationEventState extends Schema.Class<ApplicationEventState>(
  "ApplicationEventState"
)({
  eventId: Schema.String,
  blocked: Schema.optional(Schema.NullOr(ConversationBlockedState)),
  outcome: Schema.NullOr(HandlerOutcomeState).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null))
  ),
  payload: Schema.Json,
  source: Schema.String,
  status: Schema.Literals([
    "pending",
    "running",
    "blocked",
    "awaiting_delivery",
    "completed",
    "failed",
  ]),
}) {}

export class ParticipantApplicationInput extends Schema.TaggedClass<ParticipantApplicationInput>()(
  "ParticipantInput",
  { messageId: Schema.String }
) {}

export class ExternalApplicationInput extends Schema.TaggedClass<ExternalApplicationInput>()(
  "ExternalInput",
  { eventId: Schema.String }
) {}

export const ApplicationInput = Schema.Union([
  ParticipantApplicationInput,
  ExternalApplicationInput,
]);
export type ApplicationInput = typeof ApplicationInput.Type;

export class WorkThreadState extends Schema.Class<WorkThreadState>(
  "WorkThreadState"
)({
  activationEventId: EventId,
  activationTs: Schema.String,
  applicationInputQueue: Schema.Array(ApplicationInput).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([]))
  ),
  channelId: Schema.String,
  context: Schema.Array(NormalizedMessage),
  contextAttempts: Schema.Number,
  contextIsPartial: Schema.Boolean,
  contextRetryAtMillis: Schema.NullOr(Schema.Number),
  contextStatus: Schema.Literals(["pending", "ready"]),
  applicationEvents: Schema.Array(ApplicationEventState).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([]))
  ),
  id: ThreadId,
  initializationStatus: Schema.Literals([
    "not_applicable",
    "pending",
    "completed",
  ]),
  outbox: Schema.Array(OutboundItem),
  rootTs: Schema.String,
  turns: Schema.Array(TurnState),
  unassigned: Schema.Array(NormalizedMessage),
  workingDirectory: Schema.NullOr(Schema.String),
  workspaceId: Schema.optional(Schema.String),
}) {}

export class AcknowledgementState extends Schema.Class<AcknowledgementState>(
  "AcknowledgementState"
)({
  attempts: Schema.Number,
  channelId: Schema.String,
  cleanupRequested: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false))
  ),
  eventId: EventId,
  id: Schema.String,
  lastErrorCategory: Schema.NullOr(Schema.String),
  messageTs: Schema.String,
  retryAtMillis: Schema.NullOr(Schema.Number),
  status: Schema.Literals([
    "add_pending",
    "active",
    "cleanup_pending",
    "permanent_failure",
  ]),
}) {}

export class CompletionReactionState extends Schema.Class<CompletionReactionState>(
  "CompletionReactionState"
)({
  attempts: Schema.Number,
  channelId: Schema.String,
  id: Schema.String,
  lastErrorCategory: Schema.NullOr(Schema.String),
  retryAtMillis: Schema.NullOr(Schema.Number),
  rootTs: Schema.String,
  status: Schema.Literals(["add_pending", "permanent_failure"]),
  threadId: ThreadId,
  turnId: TurnId,
}) {}

export const ConversationStreamOwnerKind = Schema.Literals([
  "application-event",
  "participant-turn",
]);
export type ConversationStreamOwnerKind =
  typeof ConversationStreamOwnerKind.Type;

export const ConversationStreamMode = Schema.Literals(["fallback", "native"]);
export type ConversationStreamMode = typeof ConversationStreamMode.Type;

export const ConversationStreamOperationKind = Schema.Literals([
  "fallback-post",
  "fallback-update",
  "native-append",
  "native-start",
  "native-stop",
]);
export type ConversationStreamOperationKind =
  typeof ConversationStreamOperationKind.Type;

export const ConversationStreamOperationStatus = Schema.Literals([
  "prepared",
  "in_flight",
  "retry",
  "acknowledged",
  "rejected",
  "stopped_by_user",
  "unresolved",
]);
export type ConversationStreamOperationStatus =
  typeof ConversationStreamOperationStatus.Type;

export const ConversationStreamOperationOutcomeCertainty = Schema.Literals([
  "definitely-rejected",
  "unknown",
]);
export type ConversationStreamOperationOutcomeCertainty =
  typeof ConversationStreamOperationOutcomeCertainty.Type;

export class ConversationStreamChunkEvidence extends Schema.Class<ConversationStreamChunkEvidence>(
  "ConversationStreamChunkEvidence"
)({
  sequence: Schema.Number,
  text: Schema.String,
  textHash: Schema.String,
}) {}

export class ConversationStreamChunkHashEvidence extends Schema.Class<ConversationStreamChunkHashEvidence>(
  "ConversationStreamChunkHashEvidence"
)({
  sequence: Schema.Number,
  textHash: Schema.String,
}) {}

export class ConversationStreamOperation extends Schema.Class<ConversationStreamOperation>(
  "ConversationStreamOperation"
)({
  attempt: Schema.Number,
  errorCategory: Schema.NullOr(Schema.String),
  errorCertainty: Schema.NullOr(
    ConversationStreamOperationOutcomeCertainty
  ).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  id: Schema.String,
  kind: ConversationStreamOperationKind,
  payloadEndOffset: Schema.Number,
  payloadHash: Schema.String,
  payloadStartOffset: Schema.Number,
  payloadText: Schema.String,
  preparedAtMillis: Schema.Number,
  inFlightAtMillis: Schema.NullOr(Schema.Number),
  retryAtMillis: Schema.NullOr(Schema.Number),
  settledAtMillis: Schema.NullOr(Schema.Number),
  status: ConversationStreamOperationStatus,
}) {}

export class ConversationStreamOperationEvidence extends Schema.Class<ConversationStreamOperationEvidence>(
  "ConversationStreamOperationEvidence"
)({
  attempt: Schema.Number,
  errorCategory: Schema.NullOr(Schema.String),
  errorCertainty: Schema.NullOr(ConversationStreamOperationOutcomeCertainty),
  inFlightAtMillis: Schema.NullOr(Schema.Number),
  kind: ConversationStreamOperationKind,
  payloadEndOffset: Schema.Number,
  payloadHash: Schema.String,
  payloadStartOffset: Schema.Number,
  preparedAtMillis: Schema.Number,
  settledAtMillis: Schema.NullOr(Schema.Number),
  status: Schema.Literals([
    "acknowledged",
    "rejected",
    "stopped_by_user",
    "unresolved",
  ]),
}) {}

export class ConversationStreamState extends Schema.Class<ConversationStreamState>(
  "ConversationStreamState"
)({
  acceptedSequence: Schema.Number,
  channelId: Schema.String,
  chunks: Schema.Array(ConversationStreamChunkEvidence),
  compactedConfirmedHash: Schema.String.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(""))
  ),
  compactedConfirmedOffset: Schema.Number.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(0))
  ),
  compactedOperationCount: Schema.Number.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(0))
  ),
  confirmedHash: Schema.String,
  confirmedOffset: Schema.Number,
  createdAtMillis: Schema.Number.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(0))
  ),
  cumulativeHash: Schema.String,
  cumulativeText: Schema.String,
  flushDeadlineMillis: Schema.NullOr(Schema.Number),
  id: Schema.String,
  lifecycle: Schema.Literals(["open", "finalizing", "stopped", "unresolved"]),
  messageId: Schema.String,
  mode: Schema.NullOr(ConversationStreamMode),
  operations: Schema.Array(ConversationStreamOperation),
  ownerId: Schema.String,
  ownerKind: ConversationStreamOwnerKind,
  recipientUserId: Schema.NullOr(Schema.String),
  replayBoundaryOffset: Schema.NullOr(Schema.Number).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null))
  ),
  replayCursorOffset: Schema.NullOr(Schema.Number).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null))
  ),
  rootTs: Schema.String,
  slackTs: Schema.NullOr(Schema.String),
  stoppedAtMillis: Schema.NullOr(Schema.Number).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null))
  ),
  terminalReason: Schema.NullOr(Schema.String),
  threadId: ThreadId,
  workspaceId: Schema.String,
}) {}

export class ConversationStreamTombstone extends Schema.Class<ConversationStreamTombstone>(
  "ConversationStreamTombstone"
)({
  acceptedSequence: Schema.Number,
  channelId: Schema.String,
  chunkHashes: Schema.Array(ConversationStreamChunkHashEvidence),
  cumulativeHash: Schema.String,
  confirmedHash: Schema.String,
  confirmedOffset: Schema.Number,
  id: Schema.String,
  lifecycle: Schema.Literals(["stopped", "unresolved"]),
  messageId: Schema.String,
  mode: Schema.NullOr(ConversationStreamMode),
  operations: Schema.Array(ConversationStreamOperationEvidence).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([]))
  ),
  ownerId: Schema.String,
  ownerKind: ConversationStreamOwnerKind,
  recipientUserId: Schema.NullOr(Schema.String),
  rootTs: Schema.String,
  slackTs: Schema.NullOr(Schema.String),
  stoppedAtMillis: Schema.Number,
  terminalReason: Schema.String,
  threadId: ThreadId,
  workspaceId: Schema.String,
}) {}

export const ConversationStreamRateBudgetScope = Schema.Literals([
  "channel",
  "method",
]);
export type ConversationStreamRateBudgetScope =
  typeof ConversationStreamRateBudgetScope.Type;

export class ConversationStreamRateBudget extends Schema.Class<ConversationStreamRateBudget>(
  "ConversationStreamRateBudget"
)({
  channelId: Schema.NullOr(Schema.String),
  method: Schema.String,
  nextAvailableAtMillis: Schema.Number,
  scope: ConversationStreamRateBudgetScope,
  workspaceId: Schema.String,
}) {}

export class PrototypeState extends Schema.Class<PrototypeState>(
  "PrototypeState"
)({
  acknowledgements: Schema.Array(AcknowledgementState).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([]))
  ),
  completionReactions: Schema.Array(CompletionReactionState).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([]))
  ),
  conversationStreamRateBudgets: Schema.Array(
    ConversationStreamRateBudget
  ).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  conversationStreams: Schema.Array(ConversationStreamState).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([]))
  ),
  conversationStreamTombstones: Schema.Array(ConversationStreamTombstone).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([]))
  ),
  ignoredInbound: Schema.Array(IgnoredInbound),
  schemaVersion: Schema.Literal(1),
  seenEventIds: Schema.Array(EventId),
  threads: Schema.Array(WorkThreadState),
}) {}

export const initialPrototypeState = PrototypeState.make({
  acknowledgements: [],
  completionReactions: [],
  conversationStreamRateBudgets: [],
  conversationStreams: [],
  conversationStreamTombstones: [],
  schemaVersion: 1,
  seenEventIds: [],
  ignoredInbound: [],
  threads: [],
});

export type InboundDecision =
  | {
      readonly _tag: "Ignored";
      readonly eventId: EventId;
      readonly reason: IgnoredReason;
    }
  | {
      readonly _tag: "Accepted";
      readonly eventId: EventId;
      readonly isActivation: boolean;
      readonly threadId: ThreadId;
    };

export interface ClaimedTurn {
  readonly attemptNumber: number;
  readonly channelId: string;
  readonly context: readonly NormalizedMessage[];
  readonly id: TurnId;
  readonly initializationStatus: WorkThreadState["initializationStatus"];
  readonly messages: readonly NormalizedMessage[];
  readonly rootTs: string;
  readonly threadId: ThreadId;
  readonly workingDirectory: string | null;
}

export const canonicalThreadId = (
  channelId: string,
  rootTs: string,
  workspaceId?: string
): ThreadId =>
  ThreadId.make(
    workspaceId === undefined
      ? `${channelId}:${rootTs}`
      : `workspace:${workspaceId}:${channelId}:${rootTs}`
  );

export const stableMessageId = (
  channelId: string,
  messageTs: string,
  workspaceId?: string
): MessageId =>
  MessageId.make(
    workspaceId === undefined
      ? `${channelId}:${messageTs}`
      : `workspace:${workspaceId}:${channelId}:${messageTs}`
  );

export const stableAcknowledgementId = (
  channelId: string,
  messageTs: string,
  workspaceId?: string
): string => `ack:${stableMessageId(channelId, messageTs, workspaceId)}`;

export const stableEventId = (workspaceId: string, eventId: string): EventId =>
  EventId.make(`workspace:${workspaceId}:event:${eventId}`);

export const stableCompletionReactionId = (turnId: TurnId): string =>
  `completion-reaction:${turnId}`;
