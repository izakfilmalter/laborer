/**
 * THROWAWAY ISSUE #204 PROTOTYPE.
 * Genuine official WebClient HTTP reads/writes against a strictly-scoped Emulate server.
 */
import { createServer } from "node:net";
import { WebClient } from "@slack/web-api";
import {
  Effect,
  Array as EffectArray,
  Order,
  pipe,
  Result,
  type Scope,
} from "effect";
import { createEmulator, type Emulator } from "emulate";
import { classifySlackError } from "../slack/error-classification.ts";
import { makeSlackNativeStreamCapability } from "../slack/native-stream.ts";
import { NormalizedMessage, stableMessageId } from "./domain.ts";
import { ContextReadError, DeliveryError, EmulatorError } from "./errors.ts";
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
const SECONDARY_HUMAN_NAME = "external-bot-user";
const MAX_START_ATTEMPTS = 5;
const DEFAULT_PAGE_SIZE = 2;

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
                    name: SECONDARY_HUMAN_NAME,
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
                      "users:read",
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
                      "users:read",
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

const ROOT_CONTEXT_MESSAGE_LIMIT = 10;

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
  return kind === "root"
    ? EffectArray.takeRight(sorted, ROOT_CONTEXT_MESSAGE_LIMIT)
    : sorted;
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
      const bounded = finalizeContext(collected, "root");
      if (bounded.length === ROOT_CONTEXT_MESSAGE_LIMIT) {
        return bounded;
      }
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
  readonly secondaryHumanUserId: string;
  readonly teamId: string;
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
      const [humanAuth, botAuth, channelId, privateChannelId, users] =
        await Promise.all([
          humanClient.auth.test(),
          botClient.auth.test(),
          findChannelId(humanClient, PUBLIC_CHANNEL_NAME),
          findChannelId(humanClient, PRIVATE_CHANNEL_NAME),
          botClient.users.list({}),
        ]);
      const secondaryHumanUserId = users.members?.find(
        (user) => user.name === SECONDARY_HUMAN_NAME
      )?.id;
      if (
        humanAuth.user_id === undefined ||
        botAuth.team_id === undefined ||
        botAuth.user_id !== BOT_USER_ID ||
        humanAuth.user_id === botAuth.user_id ||
        secondaryHumanUserId === undefined
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
          nativeStreaming: makeSlackNativeStreamCapability({
            client: botClient.chat,
            recipientTeamId: botAuth.team_id,
          }),
          pageSize,
        }),
        humanClient,
        humanUserId: humanAuth.user_id,
        privateChannelId,
        secondaryHumanUserId,
        teamId: botAuth.team_id,
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
