import { Effect, Schema } from "effect";

export const MessageId = Schema.String.pipe(Schema.brand("MessageId"));
export type MessageId = typeof MessageId.Type;
export const ThreadId = Schema.String.pipe(Schema.brand("ThreadId"));
export type ThreadId = typeof ThreadId.Type;
export const TurnId = Schema.String.pipe(Schema.brand("TurnId"));
export type TurnId = typeof TurnId.Type;

export const AuthorKind = Schema.Literals(["human", "externalBot", "laborer"]);
export type AuthorKind = typeof AuthorKind.Type;

export class NormalizedImageInput extends Schema.Class<NormalizedImageInput>(
  "NormalizedImageInput"
)({
  byteLength: Schema.Int.check(Schema.isGreaterThan(0)),
  contentDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  contentPath: Schema.String.check(
    Schema.isPattern(/^inbound-images\/[a-f0-9]{64}\.(?:gif|jpg|png|webp)$/)
  ),
  id: Schema.String.check(Schema.isPattern(/\S/)),
  mimeType: Schema.Literals([
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/webp",
  ]),
  slackFileId: Schema.String.check(Schema.isPattern(/\S/)),
}) {}

export class UnavailableNormalizedImageInput extends Schema.Class<UnavailableNormalizedImageInput>(
  "UnavailableNormalizedImageInput"
)({
  failureReason: Schema.String.check(Schema.isPattern(/\S/)),
  id: Schema.String.check(Schema.isPattern(/\S/)),
  slackFileId: Schema.String.check(Schema.isPattern(/\S/)),
}) {}

export const NormalizedImage = Schema.Union([
  NormalizedImageInput,
  UnavailableNormalizedImageInput,
]);
export type NormalizedImage = typeof NormalizedImage.Type;

export class NormalizedMessage extends Schema.Class<NormalizedMessage>(
  "NormalizedMessage"
)({
  authorKind: AuthorKind,
  authorSlackId: Schema.String,
  classification: Schema.Literals(["context", "input"]),
  id: MessageId,
  isActivation: Schema.Boolean,
  images: Schema.optional(Schema.Array(NormalizedImage)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([]))
  ),
  slackTs: Schema.String,
  text: Schema.String,
}) {}

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
