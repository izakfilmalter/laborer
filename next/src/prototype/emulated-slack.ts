/**
 * THROWAWAY ISSUE #204 PROTOTYPE.
 * Genuine official WebClient HTTP reads/writes against a strictly-scoped Emulate server.
 */
import { createServer } from "node:net";
import {
  WebAPIHTTPError,
  WebAPIPlatformError,
  WebAPIRateLimitedError,
  WebAPIRequestError,
  WebClient,
} from "@slack/web-api";
import {
  Effect,
  Array as EffectArray,
  Order,
  pipe,
  Result,
  type Scope,
} from "effect";
import { createEmulator, type Emulator } from "emulate";
import { NormalizedMessage, stableMessageId } from "./domain.ts";
import {
  ContextReadError,
  DeliveryError,
  type DeliveryFailureDisposition,
  EmulatorError,
} from "./errors.ts";
import type {
  ActivationAcknowledgerShape,
  CompletionReactorShape,
  SlackGatewayShape,
  SlackNativeStreamCapability,
} from "./runtime.ts";
import type { ActivationContextRequest } from "./store.ts";

const HUMAN_TOKEN = "prototype-human-token";
const BOT_TOKEN = "prototype-bot-token";
const BOT_ID = "B204000001";
const BOT_USER_ID = "U204LABORER";
const PUBLIC_CHANNEL_NAME = "tracer-bullet";
const PRIVATE_CHANNEL_NAME = "private-tracer";
const MAX_START_ATTEMPTS = 5;
const DEFAULT_PAGE_SIZE = 2;
const DEFAULT_TRANSIENT_RETRY_MILLIS = 1000;

const reserveAvailablePort = (): Effect.Effect<number, EmulatorError> =>
  Effect.callback<number, EmulatorError>((resume) => {
    const server = createServer();
    server.once("error", () =>
      resume(
        EmulatorError.make({
          operation: "reserve-port",
          reason: "listen-failed",
        })
      )
    );
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        resume(
          EmulatorError.make({
            operation: "reserve-port",
            reason: "address-unavailable",
          })
        );
        return;
      }
      server.close((error) =>
        resume(
          error === undefined
            ? Effect.succeed(address.port)
            : EmulatorError.make({
                operation: "reserve-port",
                reason: "close-failed",
              })
        )
      );
    });
    return Effect.sync(() => server.close());
  });

const startRawEmulator = Effect.fnUntraced(function* () {
  let attempt = 0;
  while (attempt < MAX_START_ATTEMPTS) {
    attempt += 1;
    const port = yield* reserveAvailablePort();
    const result = yield* Effect.result(
      Effect.tryPromise({
        try: () =>
          createEmulator({
            service: "slack",
            port,
            seed: {
              slack: {
                team: {
                  name: "Laborer Prototype",
                  domain: "laborer-prototype",
                },
                users: [
                  {
                    name: "prototype-human",
                    real_name: "Prototype Human",
                    email: "human@example.com",
                  },
                  {
                    name: "external-bot-user",
                    real_name: "External Bot User",
                    email: "external-bot@example.com",
                  },
                ],
                channels: [
                  { name: PUBLIC_CHANNEL_NAME },
                  { name: PRIVATE_CHANNEL_NAME, is_private: true },
                ],
                bots: [{ name: "laborer" }],
                oauth_apps: [
                  {
                    app_id: "A204000001",
                    bot_id: BOT_ID,
                    bot_name: "laborer",
                    bot_user_id: BOT_USER_ID,
                    client_id: "204.1",
                    client_secret: "prototype-secret",
                    name: "Laborer",
                    redirect_uris: ["http://localhost/unused"],
                    scopes: [
                      "chat:write",
                      "channels:read",
                      "channels:history",
                      "groups:read",
                      "groups:history",
                      "groups:write",
                      "reactions:read",
                      "reactions:write",
                    ],
                  },
                ],
                tokens: [
                  {
                    token: HUMAN_TOKEN,
                    user: "prototype-human",
                    scopes: [
                      "chat:write",
                      "channels:read",
                      "channels:history",
                      "groups:read",
                      "groups:history",
                      "groups:write",
                      "reactions:read",
                    ],
                  },
                  {
                    token: BOT_TOKEN,
                    user_id: BOT_USER_ID,
                    bot_id: BOT_ID,
                    bot_user_id: BOT_USER_ID,
                    app_id: "A204000001",
                    scopes: [
                      "chat:write",
                      "channels:read",
                      "channels:history",
                      "groups:read",
                      "groups:history",
                      "reactions:read",
                      "reactions:write",
                    ],
                  },
                ],
                strict_scopes: true,
              },
            },
          }),
        catch: () =>
          EmulatorError.make({
            operation: "start",
            reason: "bind-or-start-failed",
          }),
      })
    );
    if (result._tag === "Success") {
      return result.success;
    }
    if (attempt >= MAX_START_ATTEMPTS) {
      return yield* result.failure;
    }
  }
  return yield* EmulatorError.make({
    operation: "start",
    reason: "attempts-exhausted",
  });
});

const closeEmulator = (
  emulator: Emulator
): Effect.Effect<void, EmulatorError> =>
  Effect.tryPromise({
    try: () => emulator.close(),
    catch: () =>
      EmulatorError.make({ operation: "close", reason: "close-rejected" }),
  });

export const closeEmulatedSlack = (
  fixture: EmulatedSlackFixture
): Effect.Effect<void, EmulatorError> => closeEmulator(fixture.emulator);

const slackErrorCode = (cause: unknown): string => {
  if (typeof cause !== "object" || cause === null) {
    return "unknown";
  }
  if ("data" in cause) {
    const data = cause.data;
    if (typeof data === "object" && data !== null && "error" in data) {
      return typeof data.error === "string" ? data.error : "unknown";
    }
  }
  return "unknown";
};

const TRANSIENT_PLATFORM_ERRORS = [
  "fatal_error",
  "internal_error",
  "org_login_required",
  "rate_limited",
  "ratelimited",
  "service_unavailable",
  "team_added_to_org",
  "temporarily_unavailable",
] as const;

const ITEM_PERMANENT_PLATFORM_ERRORS = [
  "attachment_payload_limit_exceeded",
  "invalid_arg_name",
  "invalid_arguments",
  "invalid_array_arg",
  "invalid_blocks",
  "invalid_blocks_format",
  "invalid_charset",
  "invalid_form_data",
  "invalid_metadata_format",
  "invalid_metadata_schema",
  "invalid_post_type",
  "markdown_text_conflict",
  "metadata_too_large",
  "missing_post_type",
  "msg_blocks_too_long",
  "msg_too_long",
  "no_text",
  "request_timeout",
  "too_many_attachments",
  "too_many_contact_cards",
] as const;

const DESTINATION_PERMANENT_PLATFORM_ERRORS = [
  "access_denied",
  "accesslimited",
  "account_inactive",
  "app_access_restricted",
  "cannot_reply_to_message",
  "channel_not_found",
  "deprecated_endpoint",
  "ekm_access_denied",
  "enterprise_is_restricted",
  "invalid_auth",
  "is_archived",
  "messages_tab_disabled",
  "method_deprecated",
  "missing_scope",
  "no_permission",
  "not_allowed_token_type",
  "not_authed",
  "not_in_channel",
  "restricted_action",
  "restricted_action_non_threadable_channel",
  "restricted_action_read_only_channel",
  "restricted_action_thread_locked",
  "restricted_action_thread_only_channel",
  "team_access_not_granted",
  "team_not_found",
  "token_expired",
  "token_revoked",
  "two_factor_setup_required",
] as const;

const platformDisposition = (category: string): DeliveryFailureDisposition => {
  if (EffectArray.contains(TRANSIENT_PLATFORM_ERRORS, category)) {
    return "transient";
  }
  if (EffectArray.contains(ITEM_PERMANENT_PLATFORM_ERRORS, category)) {
    return "item-permanent";
  }
  if (EffectArray.contains(DESTINATION_PERMANENT_PLATFORM_ERRORS, category)) {
    return "destination-permanent";
  }
  // Unknown platform failures are not retried blindly. Slack explicitly allows
  // undocumented errors, and treating one as destination-wide prevents a hot
  // loop and a speculative notice call with the same broken credentials/path.
  return "destination-permanent";
};

const retryAfterHeaderMillis = (headers: Record<string, string>): number => {
  const retryAfter = Number(headers["retry-after"]);
  return Number.isFinite(retryAfter) && retryAfter >= 0
    ? retryAfter * 1000
    : DEFAULT_TRANSIENT_RETRY_MILLIS;
};

export const classifySlackError = (
  cause: unknown
): {
  readonly category: string;
  readonly disposition: DeliveryFailureDisposition;
  readonly retryAfterMillis: number;
} => {
  if (cause instanceof WebAPIRateLimitedError) {
    return {
      category: "ratelimited",
      disposition: "transient",
      retryAfterMillis: cause.retryAfter * 1000,
    };
  }
  if (cause instanceof WebAPIPlatformError) {
    const category = cause.data.error;
    const disposition = platformDisposition(category);
    return {
      category,
      disposition,
      retryAfterMillis:
        disposition === "transient" ? DEFAULT_TRANSIENT_RETRY_MILLIS : 0,
    };
  }
  if (cause instanceof WebAPIHTTPError) {
    const isTransient =
      cause.statusCode === 408 ||
      cause.statusCode === 429 ||
      cause.statusCode >= 500;
    return {
      category: `http_${cause.statusCode}`,
      disposition: isTransient ? "transient" : "destination-permanent",
      retryAfterMillis: isTransient ? retryAfterHeaderMillis(cause.headers) : 0,
    };
  }
  if (cause instanceof WebAPIRequestError) {
    return {
      category: "request_error",
      disposition: "transient",
      retryAfterMillis: DEFAULT_TRANSIENT_RETRY_MILLIS,
    };
  }
  const category = slackErrorCode(cause);
  const disposition = platformDisposition(category);
  return {
    category,
    disposition,
    retryAfterMillis:
      disposition === "transient" ? DEFAULT_TRANSIENT_RETRY_MILLIS : 0,
  };
};

export const normalizeSlackHistoryMessage = (options: {
  readonly botId: string;
  readonly botUserId: string;
  readonly channelId: string;
  readonly message: Record<string, unknown>;
  readonly workspaceId?: string;
}): NormalizedMessage | null => {
  const { message } = options;
  const slackTs = typeof message.ts === "string" ? message.ts : null;
  const text = typeof message.text === "string" ? message.text : null;
  const subtype = typeof message.subtype === "string" ? message.subtype : null;
  const botId = typeof message.bot_id === "string" ? message.bot_id : null;
  const userId = typeof message.user === "string" ? message.user : null;
  const supportedSubtype =
    subtype === null || subtype === "bot_message" || subtype === "file_share";
  if (
    slackTs === null ||
    text === null ||
    text.trim().length === 0 ||
    !supportedSubtype ||
    botId === options.botId ||
    userId === options.botUserId
  ) {
    return null;
  }
  const isBot = botId !== null || subtype === "bot_message";
  const authorSlackId = userId ?? botId;
  if (authorSlackId === null) {
    return null;
  }
  return NormalizedMessage.make({
    id: stableMessageId(options.channelId, slackTs, options.workspaceId),
    classification: "context",
    isActivation: false,
    authorKind: isBot ? "externalBot" : "human",
    authorSlackId,
    slackTs,
    text,
  });
};

const timestampOrder = pipe(
  Order.Number,
  Order.mapInput((message: NormalizedMessage) => Number(message.slackTs))
);

const finalizeContext = (
  messages: readonly NormalizedMessage[],
  kind: "root" | "reply"
): NormalizedMessage[] => {
  const byId = new Map<string, NormalizedMessage>();
  for (const message of messages) {
    byId.set(message.id, message);
  }
  const sorted = pipe(
    EffectArray.fromIterable(byId.values()),
    EffectArray.sort(timestampOrder)
  );
  return kind === "root" ? EffectArray.takeRight(sorted, 10) : sorted;
};

const normalizeReplyPage = (
  messages: readonly Record<string, unknown>[],
  request: ActivationContextRequest,
  botId: string,
  botUserId: string,
  workspaceId?: string
): NormalizedMessage[] =>
  pipe(
    messages,
    EffectArray.filter(
      (message) => Number(message.ts) < Number(request.activationTs)
    ),
    EffectArray.filterMap((message) => {
      const result = normalizeSlackHistoryMessage({
        botId,
        botUserId,
        channelId: request.channelId,
        message,
        ...(workspaceId === undefined ? {} : { workspaceId }),
      });
      return result === null ? Result.failVoid : Result.succeed(result);
    })
  );

const nextPageCursor = (
  next: string | undefined,
  seenCursors: string[]
): string | undefined => {
  if (
    next === undefined ||
    next.length === 0 ||
    EffectArray.contains(seenCursors, next)
  ) {
    return undefined;
  }
  seenCursors.push(next);
  return next;
};

export const makeSlackGateway = (options: {
  readonly botClient: WebClient;
  readonly botId?: string;
  readonly botUserId?: string;
  readonly nativeStreaming?: SlackNativeStreamCapability;
  readonly pageSize: number;
  readonly workspaceId?: string;
}): SlackGatewayShape => {
  const readRootContext = Effect.fnUntraced(function* (
    request: ActivationContextRequest
  ) {
    let cursor: string | undefined;
    let collected: NormalizedMessage[] = [];
    const seenCursors: string[] = [];
    do {
      const response = yield* Effect.tryPromise({
        try: () =>
          options.botClient.conversations.history({
            channel: request.channelId,
            limit: options.pageSize,
            ...(cursor === undefined ? {} : { cursor }),
          }),
        catch: (cause) => {
          const failure = classifySlackError(cause);
          return ContextReadError.make({
            category: failure.category,
            isTransient: failure.disposition === "transient",
            partial: finalizeContext(collected, "root"),
          });
        },
      });
      const normalized = pipe(
        response.messages ?? [],
        EffectArray.filter(
          (message) =>
            message.thread_ts === undefined &&
            Number(message.ts) < Number(request.activationTs)
        ),
        EffectArray.filterMap((message) => {
          const result = normalizeSlackHistoryMessage({
            botId: options.botId ?? BOT_ID,
            botUserId: options.botUserId ?? BOT_USER_ID,
            channelId: request.channelId,
            message: message as Record<string, unknown>,
            ...(options.workspaceId === undefined
              ? {}
              : { workspaceId: options.workspaceId }),
          });
          return result === null ? Result.failVoid : Result.succeed(result);
        })
      );
      collected = EffectArray.appendAll(collected, normalized);
      cursor = nextPageCursor(
        response.response_metadata?.next_cursor,
        seenCursors
      );
    } while (cursor !== undefined);
    return finalizeContext(collected, "root");
  });

  const readReplyContext = Effect.fnUntraced(function* (
    request: ActivationContextRequest
  ) {
    let cursor: string | undefined;
    let collected: NormalizedMessage[] = [];
    const seenCursors: string[] = [];
    let reachedActivation = false;
    let reachedRoot = false;
    do {
      const response = yield* Effect.tryPromise({
        try: () =>
          options.botClient.conversations.replies({
            channel: request.channelId,
            ts: request.rootTs,
            limit: options.pageSize,
            ...(cursor === undefined ? {} : { cursor }),
          }),
        catch: (cause) => {
          const failure = classifySlackError(cause);
          return ContextReadError.make({
            category: failure.category,
            isTransient: failure.disposition === "transient",
            partial: finalizeContext(collected, "reply"),
          });
        },
      });
      reachedActivation =
        reachedActivation ||
        EffectArray.some(
          response.messages ?? [],
          (message) => message.ts === request.activationTs
        );
      reachedRoot =
        reachedRoot ||
        EffectArray.some(
          response.messages ?? [],
          (message) => message.ts === request.rootTs
        );
      const normalized = normalizeReplyPage(
        (response.messages ?? []) as Record<string, unknown>[],
        request,
        options.botId ?? BOT_ID,
        options.botUserId ?? BOT_USER_ID,
        options.workspaceId
      );
      collected = EffectArray.appendAll(collected, normalized);
      cursor = nextPageCursor(
        response.response_metadata?.next_cursor,
        seenCursors
      );
    } while (cursor !== undefined);

    // Emulate 0.9 truncates conversations.replies without returning a cursor.
    // Keep the official WebClient boundary, but compensate with one bounded
    // high-limit read so this prototype can still prove reply activation.
    if (reachedActivation && !reachedRoot) {
      const fallback = yield* Effect.tryPromise({
        try: () =>
          options.botClient.conversations.replies({
            channel: request.channelId,
            ts: request.rootTs,
            limit: 100,
          }),
        catch: (cause) => {
          const failure = classifySlackError(cause);
          return ContextReadError.make({
            category: failure.category,
            isTransient: failure.disposition === "transient",
            partial: finalizeContext(collected, "reply"),
          });
        },
      });
      collected = normalizeReplyPage(
        (fallback.messages ?? []) as Record<string, unknown>[],
        request,
        options.botId ?? BOT_ID,
        options.botUserId ?? BOT_USER_ID,
        options.workspaceId
      );
    }
    return finalizeContext(collected, "reply");
  });

  return {
    ...(options.nativeStreaming === undefined
      ? {}
      : { nativeStreaming: options.nativeStreaming }),
    readActivationContext: (request) =>
      request.isReplyActivation
        ? readReplyContext(request)
        : readRootContext(request),
    postThreadMessage: ({ channelId, rootTs, text }) =>
      Effect.tryPromise({
        try: async () => {
          const response = await options.botClient.chat.postMessage({
            channel: channelId,
            thread_ts: rootTs,
            text,
          });
          if (response.ts === undefined) {
            throw new Error("missing timestamp");
          }
          return { ts: response.ts };
        },
        catch: (cause) => {
          const failure = classifySlackError(cause);
          return DeliveryError.make({
            category: failure.category,
            disposition: failure.disposition,
            retryAfterMillis: failure.retryAfterMillis,
          });
        },
      }),
    updateThreadMessage: ({ channelId, messageTs, text }) =>
      Effect.tryPromise({
        try: async () => {
          await options.botClient.chat.update({
            channel: channelId,
            ts: messageTs,
            text,
          });
        },
        catch: (cause) => {
          const failure = classifySlackError(cause);
          return DeliveryError.make({
            category: failure.category,
            disposition: failure.disposition,
            retryAfterMillis: failure.retryAfterMillis,
          });
        },
      }),
  };
};

const isAlreadyReacted = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "data" in cause &&
  typeof cause.data === "object" &&
  cause.data !== null &&
  "error" in cause.data &&
  cause.data.error === "already_reacted";

const isReactionAbsent = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "data" in cause &&
  typeof cause.data === "object" &&
  cause.data !== null &&
  "error" in cause.data &&
  cause.data.error === "no_reaction";

interface ReactionsClient {
  readonly reactions: {
    readonly add: (request: {
      readonly channel: string;
      readonly name: string;
      readonly timestamp: string;
    }) => Promise<unknown>;
    readonly remove: (request: {
      readonly channel: string;
      readonly name: string;
      readonly timestamp: string;
    }) => Promise<unknown>;
  };
}

interface SlackReactionFailure {
  readonly cause: unknown;
}

const performSlackReaction = (
  botClient: ReactionsClient,
  operation: "add" | "remove",
  name: string,
  channelId: string,
  timestamp: string
): Effect.Effect<void, DeliveryError> =>
  Effect.tryPromise({
    try: () =>
      botClient.reactions[operation]({
        channel: channelId,
        name,
        timestamp,
      }),
    catch: (cause): SlackReactionFailure => ({ cause }),
  }).pipe(
    Effect.asVoid,
    Effect.catch(({ cause }) => {
      const isIdempotent =
        (operation === "add" && isAlreadyReacted(cause)) ||
        (operation === "remove" && isReactionAbsent(cause));
      if (isIdempotent) {
        return Effect.void;
      }
      const failure = classifySlackError(cause);
      return DeliveryError.make({
        category: failure.category,
        disposition: failure.disposition,
        retryAfterMillis: failure.retryAfterMillis,
      });
    })
  );

export const makeSlackActivationAcknowledger = (
  botClient: ReactionsClient
): ActivationAcknowledgerShape => ({
  acknowledge: ({ channelId, messageTs }) =>
    performSlackReaction(
      botClient,
      "add",
      "hourglass_flowing_sand",
      channelId,
      messageTs
    ),
  complete: ({ channelId, messageTs }) =>
    performSlackReaction(
      botClient,
      "remove",
      "hourglass_flowing_sand",
      channelId,
      messageTs
    ),
});

export const makeSlackCompletionReactor = (
  botClient: ReactionsClient
): CompletionReactorShape => ({
  react: ({ channelId, rootTs }) =>
    performSlackReaction(
      botClient,
      "add",
      "white_check_mark",
      channelId,
      rootTs
    ),
});

export interface EmulatedSlackFixture {
  readonly botClient: WebClient;
  readonly botId: string;
  readonly botUserId: string;
  readonly channelId: string;
  readonly emulator: Emulator;
  readonly gateway: SlackGatewayShape;
  readonly humanClient: WebClient;
  readonly humanUserId: string;
  readonly privateChannelId: string;
}

const findChannelId = async (
  client: WebClient,
  name: string
): Promise<string> => {
  const response = await client.conversations.list({
    types: "public_channel,private_channel",
  });
  const channel = response.channels?.find(
    (candidate) => candidate.name === name
  );
  if (channel?.id === undefined) {
    throw new Error(`missing channel ${name}`);
  }
  return channel.id;
};

const validateFixture = (
  emulator: Emulator,
  pageSize: number
): Effect.Effect<EmulatedSlackFixture, EmulatorError> =>
  Effect.tryPromise({
    try: async () => {
      const humanClient = new WebClient(HUMAN_TOKEN, {
        slackApiUrl: `${emulator.url}/api/`,
      });
      const botClient = new WebClient(BOT_TOKEN, {
        rejectRateLimitedCalls: true,
        slackApiUrl: `${emulator.url}/api/`,
      });
      const [humanAuth, botAuth, channelId, privateChannelId] =
        await Promise.all([
          humanClient.auth.test(),
          botClient.auth.test(),
          findChannelId(humanClient, PUBLIC_CHANNEL_NAME),
          findChannelId(humanClient, PRIVATE_CHANNEL_NAME),
        ]);
      if (
        humanAuth.user_id === undefined ||
        botAuth.user_id !== BOT_USER_ID ||
        humanAuth.user_id === botAuth.user_id
      ) {
        throw new Error("Emulate actor identities were not distinct");
      }
      await humanClient.conversations.invite({
        channel: privateChannelId,
        users: BOT_USER_ID,
      });
      return {
        botClient,
        botId: BOT_ID,
        botUserId: BOT_USER_ID,
        channelId,
        emulator,
        gateway: makeSlackGateway({
          botClient,
          botId: BOT_ID,
          botUserId: BOT_USER_ID,
          pageSize,
        }),
        humanClient,
        humanUserId: humanAuth.user_id,
        privateChannelId,
      };
    },
    catch: () =>
      EmulatorError.make({ operation: "validate", reason: "fixture-invalid" }),
  });

export const startEmulatedSlack = (options?: {
  readonly pageSize?: number;
}): Effect.Effect<EmulatedSlackFixture, EmulatorError, Scope.Scope> =>
  Effect.acquireRelease(startRawEmulator(), (emulator) =>
    closeEmulator(emulator).pipe(Effect.orDie)
  ).pipe(
    Effect.flatMap((emulator) =>
      validateFixture(emulator, options?.pageSize ?? DEFAULT_PAGE_SIZE)
    )
  );
