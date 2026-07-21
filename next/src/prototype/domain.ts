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
}) {}

export class NormalizedMessage extends Schema.Class<NormalizedMessage>(
  "NormalizedMessage"
)({
  authorKind: AuthorKind,
  authorSlackId: Schema.String,
  classification: Schema.Literals(["context", "input"]),
  id: MessageId,
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
  context: Schema.Array(NormalizedMessage),
  id: TurnId,
  messages: Schema.Array(NormalizedMessage),
  outcome: Schema.NullOr(HandlerOutcomeState),
  status: Schema.Literals([
    "running",
    "awaiting_delivery",
    "completed",
    "failed",
  ]),
}) {}

export class WorkThreadState extends Schema.Class<WorkThreadState>(
  "WorkThreadState"
)({
  activationEventId: EventId,
  activationTs: Schema.String,
  channelId: Schema.String,
  context: Schema.Array(NormalizedMessage),
  contextAttempts: Schema.Number,
  contextIsPartial: Schema.Boolean,
  contextRetryAtMillis: Schema.NullOr(Schema.Number),
  contextStatus: Schema.Literals(["pending", "ready"]),
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

export class PrototypeState extends Schema.Class<PrototypeState>(
  "PrototypeState"
)({
  acknowledgements: Schema.Array(AcknowledgementState).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([]))
  ),
  completionReactions: Schema.Array(CompletionReactionState).pipe(
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
  rootTs: string
): ThreadId => ThreadId.make(`${channelId}:${rootTs}`);

export const stableMessageId = (
  channelId: string,
  messageTs: string
): MessageId => MessageId.make(`${channelId}:${messageTs}`);

export const stableAcknowledgementId = (
  channelId: string,
  messageTs: string
): string => `ack:${channelId}:${messageTs}`;

export const stableCompletionReactionId = (turnId: TurnId): string =>
  `completion-reaction:${turnId}`;
