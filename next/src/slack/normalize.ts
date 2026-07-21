import { Effect, Schema } from "effect";
import {
  EventId,
  type InboundRecordKind,
  NormalizedInboundEvent,
} from "../prototype/domain.ts";
import type { SlackRuntimeIdentity } from "./config.ts";
import { SlackBoundaryError } from "./errors.ts";

const SlackMessageFragment = Schema.Struct({
  bot_id: Schema.optional(Schema.String),
  channel: Schema.optional(Schema.String),
  channel_type: Schema.optional(Schema.String),
  deleted_ts: Schema.optional(Schema.String),
  event_ts: Schema.optional(Schema.String),
  message: Schema.optional(Schema.Unknown),
  previous_message: Schema.optional(Schema.Unknown),
  subtype: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  thread_ts: Schema.optional(Schema.String),
  ts: Schema.optional(Schema.String),
  type: Schema.String,
  user: Schema.optional(Schema.String),
});

const SlackEventCallback = Schema.Struct({
  event: SlackMessageFragment,
  event_id: Schema.String,
  team_id: Schema.String,
  type: Schema.Literal("event_callback"),
});

type SlackMessageFragmentType = typeof SlackMessageFragment.Type;

const decodeFragment = (
  value: unknown,
  field: string
): Effect.Effect<SlackMessageFragmentType | null, SlackBoundaryError> =>
  value === undefined
    ? Effect.succeed(null)
    : Schema.decodeUnknownEffect(SlackMessageFragment)(value).pipe(
        Effect.mapError(() => boundaryFailure(`invalid-${field}`))
      );

const channelKindFor = (
  channelId: string,
  channelType: string | undefined
): "public" | "private" | "direct" | null => {
  if (channelType === "channel") {
    return "public";
  }
  if (channelType === "group") {
    return "private";
  }
  if (channelType === "im" || channelType === "mpim") {
    return "direct";
  }
  if (channelId.startsWith("D")) {
    return "direct";
  }
  if (channelId.startsWith("G")) {
    return "private";
  }
  return channelId.startsWith("C") ? "public" : null;
};

const recordKindFor = (
  eventType: string,
  subtype: string | undefined
): InboundRecordKind => {
  if (eventType === "app_mention") {
    return "message";
  }
  if (subtype === "message_changed") {
    return "message_changed";
  }
  if (subtype === "message_deleted") {
    return "message_deleted";
  }
  return subtype === undefined ||
    subtype === "bot_message" ||
    subtype === "file_share" ||
    subtype === "thread_broadcast"
    ? "message"
    : "system";
};

const boundaryFailure = (reason: string): SlackBoundaryError =>
  SlackBoundaryError.make({ boundary: "slack-events-api", reason });

const authoredFragmentFor = (
  raw: SlackMessageFragmentType,
  nestedMessage: SlackMessageFragmentType | null,
  previousMessage: SlackMessageFragmentType | null
): SlackMessageFragmentType => {
  if (raw.subtype === "message_changed") {
    return nestedMessage ?? raw;
  }
  if (raw.subtype === "message_deleted") {
    return previousMessage ?? raw;
  }
  return raw;
};

const messageTimestampFor = (
  raw: SlackMessageFragmentType,
  authored: SlackMessageFragmentType
): string | undefined => {
  if (raw.subtype === "message_deleted") {
    return raw.deleted_ts ?? authored.ts ?? raw.event_ts;
  }
  return authored.ts ?? raw.ts ?? raw.event_ts;
};

const authorFor = (
  raw: SlackMessageFragmentType,
  authored: SlackMessageFragmentType,
  identity: SlackRuntimeIdentity
): {
  readonly id: string;
  readonly kind: "human" | "externalBot" | "laborer";
} => {
  const userId = authored.user ?? raw.user;
  const botId = authored.bot_id ?? raw.bot_id;
  if (userId === identity.botUserId || botId === identity.botId) {
    return { id: userId ?? botId ?? "system", kind: "laborer" };
  }
  if (botId !== undefined || raw.subtype === "bot_message") {
    return { id: userId ?? botId ?? "system", kind: "externalBot" };
  }
  return { id: userId ?? "system", kind: "human" };
};

export const normalizeSlackEvent = (
  input: unknown,
  identity: SlackRuntimeIdentity
): Effect.Effect<NormalizedInboundEvent | null, SlackBoundaryError> =>
  Effect.gen(function* () {
    const callback = yield* Schema.decodeUnknownEffect(SlackEventCallback)(
      input
    ).pipe(Effect.mapError(() => boundaryFailure("invalid-event-callback")));
    if (callback.team_id !== identity.teamId) {
      return yield* boundaryFailure("unexpected-workspace");
    }
    const raw = callback.event;
    if (raw.type !== "app_mention" && raw.type !== "message") {
      return null;
    }

    const nestedMessage = yield* decodeFragment(raw.message, "message");
    const previousMessage = yield* decodeFragment(
      raw.previous_message,
      "previous-message"
    );
    const recordKind = recordKindFor(raw.type, raw.subtype);
    const authored = authoredFragmentFor(raw, nestedMessage, previousMessage);
    const channelId = raw.channel ?? authored.channel;
    const messageTs = messageTimestampFor(raw, authored);
    if (channelId === undefined || messageTs === undefined) {
      return yield* boundaryFailure("missing-message-routing");
    }
    const channelKind = channelKindFor(
      channelId,
      raw.channel_type ?? authored.channel_type
    );
    if (channelKind === null) {
      return yield* boundaryFailure("unsupported-channel-identity");
    }
    const author = authorFor(raw, authored, identity);
    const text =
      recordKind === "message" ? (authored.text ?? raw.text ?? null) : null;

    return NormalizedInboundEvent.make({
      authorKind: author.kind,
      authorSlackId: author.id,
      channelId,
      channelKind,
      eventId: EventId.make(callback.event_id),
      messageTs,
      recordKind,
      text,
      threadTs: authored.thread_ts ?? raw.thread_ts ?? null,
    });
  });
