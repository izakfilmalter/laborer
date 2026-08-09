import { createSlackAdapter } from "@chat-adapter/slack";
import { type Adapter, Chat } from "chat";
import { Context, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { slackWebApiRequestPolicy } from "../slack/web-api-request-policy.ts";
import { createSQLiteState } from "./sqlite-state-adapter.ts";

export interface ChatSdkMessageLike {
  readonly author: {
    readonly isBot: boolean | "unknown";
    readonly isMe: boolean;
    readonly isSystem?: boolean;
    readonly userId: string;
  };
  readonly edited: boolean;
  readonly id: string;
  readonly isMention: boolean;
  readonly sentAt: Date;
  readonly text: string;
  readonly workspaceId: string;
}

export interface ChatSdkThreadLike {
  readonly allMessages: AsyncIterable<ChatSdkMessageLike>;
  readonly channelMessages: AsyncIterable<ChatSdkMessageLike>;
  readonly id: string;
  readonly isDM: boolean;
  readonly post: (reply: string | AsyncIterable<string>) => Promise<unknown>;
  readonly rootMessageId: string;
  readonly subscribe: () => Promise<void>;
  readonly workspaceId: string;
}

export interface ChatSdkMessageContextLike {
  readonly skipped: readonly ChatSdkMessageLike[];
}

export type ChatSdkMessageHandler = (
  thread: ChatSdkThreadLike,
  message: ChatSdkMessageLike,
  context?: ChatSdkMessageContextLike
) => Promise<void>;

export type ChatSdkMentionHandler = ChatSdkMessageHandler;

export interface ChatSdkLike {
  readonly initialize: () => Promise<void>;
  readonly onNewMention: (handler: ChatSdkMessageHandler) => void;
  readonly onSubscribedMessage: (handler: ChatSdkMessageHandler) => void;
  readonly shutdown: () => Promise<void>;
}

export class ChatPlaneStartupError extends Schema.TaggedErrorClass<ChatPlaneStartupError>()(
  "ChatPlaneStartupError",
  {
    operation: Schema.String,
    reason: Schema.String,
  }
) {}

export class ChatPlaneOperationError extends Schema.TaggedErrorClass<ChatPlaneOperationError>()(
  "ChatPlaneOperationError",
  {
    operation: Schema.String,
    reason: Schema.String,
  }
) {}

export interface ChatPlaneShape {
  readonly postNotice: (
    thread: ChatSdkThreadLike,
    notice: string
  ) => Effect.Effect<void, ChatPlaneOperationError>;
  readonly readActivationHistory: (
    thread: ChatSdkThreadLike,
    activation: ChatSdkMessageLike
  ) => Effect.Effect<readonly ChatSdkMessageLike[], ChatPlaneOperationError>;
  readonly streamReply: (
    thread: ChatSdkThreadLike,
    chunks: AsyncIterable<string>
  ) => Effect.Effect<void, ChatPlaneOperationError>;
  readonly subscribe: (
    thread: ChatSdkThreadLike
  ) => Effect.Effect<void, ChatPlaneOperationError>;
}

export class ChatPlane extends Context.Service<ChatPlane, ChatPlaneShape>()(
  "@laborer/chat-plane/ChatPlane"
) {}

export type ChatPlaneMessageHandler = (
  thread: ChatSdkThreadLike,
  message: ChatSdkMessageLike,
  context: ChatSdkMessageContextLike,
  isActivation: boolean
) => Effect.Effect<void, ChatPlaneOperationError, ChatPlane>;

export type ChatPlaneMentionHandler = ChatPlaneMessageHandler;

interface MakeChatPlaneLayerOptions {
  readonly handler: ChatPlaneMessageHandler;
  readonly makeSdk: () => ChatSdkLike;
}

const operationFailure = (operation: string): ChatPlaneOperationError =>
  ChatPlaneOperationError.make({
    operation,
    reason: "Chat SDK operation failed",
  });

const startupFailure = (operation: string): ChatPlaneStartupError =>
  ChatPlaneStartupError.make({
    operation,
    reason: "Chat SDK startup failed",
  });

const MAX_HISTORY_MESSAGES_SCANNED = 1000;
const ROOT_HISTORY_MESSAGE_LIMIT = 10;

const isEligibleAuthoredText = (message: ChatSdkMessageLike): boolean =>
  !message.author.isMe &&
  message.author.isSystem !== true &&
  !message.edited &&
  message.text.trim().length > 0;

const SLACK_MESSAGE_ID = /^(\d{1,20})\.(\d{1,20})$/;

const isBeforeActivation = (
  message: ChatSdkMessageLike,
  activation: ChatSdkMessageLike,
  activationTime: number
): boolean => {
  const messageId = SLACK_MESSAGE_ID.exec(message.id);
  const activationId = SLACK_MESSAGE_ID.exec(activation.id);
  if (messageId && activationId) {
    const messageSeconds = BigInt(messageId[1] ?? "0");
    const activationSeconds = BigInt(activationId[1] ?? "0");
    if (messageSeconds !== activationSeconds) {
      return messageSeconds < activationSeconds;
    }
    const messageFraction = messageId[2] ?? "";
    const activationFraction = activationId[2] ?? "";
    const precision = Math.max(
      messageFraction.length,
      activationFraction.length
    );
    return (
      BigInt(messageFraction.padEnd(precision, "0")) <
      BigInt(activationFraction.padEnd(precision, "0"))
    );
  }
  return message.sentAt.getTime() < activationTime;
};

const collectActivationHistory = async (
  thread: ChatSdkThreadLike,
  activation: ChatSdkMessageLike
): Promise<readonly ChatSdkMessageLike[]> => {
  const isRootActivation = thread.rootMessageId === activation.id;
  const messages = isRootActivation
    ? thread.channelMessages
    : thread.allMessages;
  const collected: ChatSdkMessageLike[] = [];
  const activationTime = activation.sentAt.getTime();
  if (!Number.isFinite(activationTime)) {
    throw new Error("activation timestamp is invalid");
  }
  let scanned = 0;

  for await (const message of messages) {
    scanned += 1;
    if (scanned > MAX_HISTORY_MESSAGES_SCANNED) {
      throw new Error("history scan limit exceeded");
    }
    const messageTime = message.sentAt.getTime();
    if (!Number.isFinite(messageTime)) {
      throw new Error("history message timestamp is invalid");
    }
    if (
      message.id === activation.id ||
      !isBeforeActivation(message, activation, activationTime)
    ) {
      // Channel history is newest-first, whereas Thread.allMessages is
      // oldest-first. Once reply history reaches the activation, no later
      // message can be historical context.
      if (!isRootActivation) {
        break;
      }
      continue;
    }
    if (isEligibleAuthoredText(message)) {
      collected.push(message);
      if (isRootActivation && collected.length === ROOT_HISTORY_MESSAGE_LIMIT) {
        break;
      }
    }
  }

  return isRootActivation ? collected.reverse() : collected;
};

const makeService = (): ChatPlaneShape => ({
  postNotice: (thread, notice) =>
    Effect.tryPromise({
      try: () => thread.post(notice),
      catch: () => operationFailure("thread.post-notice"),
    }).pipe(Effect.asVoid),
  readActivationHistory: (thread, activation) =>
    Effect.tryPromise({
      try: () => collectActivationHistory(thread, activation),
      catch: () => operationFailure("thread.read-activation-history"),
    }),
  streamReply: (thread, chunks) =>
    Effect.tryPromise({
      try: () => thread.post(chunks),
      catch: () => operationFailure("thread.post"),
    }).pipe(Effect.asVoid),
  subscribe: (thread) =>
    Effect.tryPromise({
      try: () => thread.subscribe(),
      catch: () => operationFailure("thread.subscribe"),
    }),
});

export const makeChatPlaneLayer = (
  options: MakeChatPlaneLayerOptions
): Layer.Layer<ChatPlane, ChatPlaneStartupError> =>
  Layer.effect(
    ChatPlane,
    Effect.gen(function* () {
      const sdk = yield* Effect.try({
        try: options.makeSdk,
        catch: () => startupFailure("construct"),
      });
      const service = makeService();
      const inboundRuntime = ManagedRuntime.make(
        Layer.succeed(ChatPlane, service)
      );
      yield* Effect.addFinalizer(() =>
        Effect.tryPromise({
          try: () => sdk.shutdown(),
          catch: () => startupFailure("shutdown"),
        }).pipe(Effect.ignore, Effect.andThen(inboundRuntime.disposeEffect))
      );

      yield* Effect.try({
        try: () => {
          const bridge =
            (isActivation: boolean): ChatSdkMessageHandler =>
            (thread, message, context = { skipped: [] }) => {
              if (
                thread.isDM ||
                message.author.isMe ||
                message.author.isSystem === true ||
                message.edited ||
                message.text.trim().length === 0 ||
                (isActivation && !message.isMention)
              ) {
                return Promise.resolve();
              }
              return inboundRuntime.runPromise(
                options.handler(thread, message, context, isActivation)
              );
            };
          sdk.onNewMention(bridge(true));
          sdk.onSubscribedMessage(bridge(false));
        },
        catch: () => startupFailure("register-mention-handler"),
      });
      yield* Effect.tryPromise({
        try: () => sdk.initialize(),
        catch: () => startupFailure("initialize"),
      });

      return service;
    })
  );

interface BaseLiveChatPlaneConfig {
  readonly appToken: string;
  readonly statePath: string;
  readonly userName: string;
}

export type LiveChatPlaneConfig = BaseLiveChatPlaneConfig &
  (
    | {
        readonly botToken: string;
        readonly installations?: never;
      }
    | {
        readonly botToken?: never;
        readonly installations: readonly LocalSlackInstallation[];
      }
  );

export interface LocalSlackInstallation {
  readonly botToken: string;
  readonly teamId: string;
}

export interface LocalSlackInstallationProvider {
  readonly getInstallation: (
    installationId: string,
    isEnterpriseInstall: boolean
  ) => Promise<LocalSlackResolvedInstallation | null>;
  readonly recordBotUserId: (teamId: string, botUserId: string) => void;
}

export interface LocalSlackResolvedInstallation {
  readonly botToken: string;
  readonly botUserId?: string;
}

export const makeLocalSlackInstallationProvider = (
  installations: readonly LocalSlackInstallation[]
): LocalSlackInstallationProvider => {
  const byTeam = new Map<string, LocalSlackResolvedInstallation>();
  for (const installation of installations) {
    if (byTeam.has(installation.teamId)) {
      throw new Error("Duplicate local Slack workspace installation");
    }
    byTeam.set(installation.teamId, { botToken: installation.botToken });
  }

  return {
    getInstallation: (installationId, isEnterpriseInstall) =>
      Promise.resolve(
        isEnterpriseInstall ? null : (byTeam.get(installationId) ?? null)
      ),
    recordBotUserId: (teamId, botUserId) => {
      const installation = byTeam.get(teamId);
      if (installation === undefined) {
        throw new Error("Unknown local Slack workspace installation");
      }
      byTeam.set(teamId, { ...installation, botUserId });
    },
  };
};

const SlackMessageWorkspace = Schema.Struct({
  team: Schema.optional(Schema.String),
  team_id: Schema.optional(Schema.String),
});
const SLACK_TEAM_ID_PATTERN = /^T[A-Z0-9]+$/;

export const workspaceIdFromRawSlackMessage = (
  raw: unknown,
  configuredWorkspaceIds?: ReadonlySet<string>
): string => {
  let decoded: typeof SlackMessageWorkspace.Type;
  try {
    decoded = Schema.decodeUnknownSync(SlackMessageWorkspace)(raw);
  } catch {
    // Schema parse errors include the rejected value. Keep Slack message
    // payloads out of the adapter's error logs by replacing them here.
    throw new Error("Slack workspace identity unavailable");
  }
  if (
    decoded.team !== undefined &&
    decoded.team_id !== undefined &&
    decoded.team !== decoded.team_id
  ) {
    throw new Error("Slack workspace identity unavailable");
  }
  const workspaceId = decoded.team_id ?? decoded.team;
  if (
    workspaceId === undefined ||
    !SLACK_TEAM_ID_PATTERN.test(workspaceId) ||
    (configuredWorkspaceIds !== undefined &&
      !configuredWorkspaceIds.has(workspaceId))
  ) {
    throw new Error("Slack workspace identity unavailable");
  }
  return workspaceId;
};

interface LiveMessageLike {
  readonly author: ChatSdkMessageLike["author"];
  readonly id: string;
  readonly isMention?: boolean;
  readonly metadata: {
    readonly dateSent: Date;
    readonly edited: boolean;
  };
  readonly text: string;
}

const toChatSdkMessage = (
  message: LiveMessageLike,
  workspaceId: string
): ChatSdkMessageLike => ({
  author: message.author,
  edited: message.metadata.edited,
  id: message.id,
  isMention: message.isMention === true,
  sentAt: message.metadata.dateSent,
  text: message.text,
  workspaceId,
});

const mapMessages = (
  messages: AsyncIterable<LiveMessageLike>,
  workspaceId: string
): AsyncIterable<ChatSdkMessageLike> => ({
  async *[Symbol.asyncIterator]() {
    for await (const message of messages) {
      yield toChatSdkMessage(message, workspaceId);
    }
  },
});

interface LiveThreadLike {
  readonly allMessages: AsyncIterable<LiveMessageLike>;
  readonly channel: { readonly messages: AsyncIterable<LiveMessageLike> };
  readonly id: string;
  readonly isDM: boolean;
  readonly post: (reply: string | AsyncIterable<string>) => Promise<unknown>;
  readonly subscribe: () => Promise<void>;
}

const toChatSdkThread = (
  thread: LiveThreadLike,
  workspaceId: string
): ChatSdkThreadLike => ({
  allMessages: mapMessages(thread.allMessages, workspaceId),
  channelMessages: mapMessages(thread.channel.messages, workspaceId),
  id: thread.id,
  isDM: thread.isDM,
  post: (reply) => thread.post(reply),
  rootMessageId: thread.id.slice(thread.id.lastIndexOf(":") + 1),
  subscribe: () => thread.subscribe(),
  workspaceId,
});

const toChatSdkContext = (
  context: { readonly skipped: readonly LiveMessageLike[] } | undefined,
  workspaceId: string
): ChatSdkMessageContextLike => ({
  skipped:
    context?.skipped.map((message) => toChatSdkMessage(message, workspaceId)) ??
    [],
});

export const makeLiveChatPlaneLayer = (
  config: LiveChatPlaneConfig,
  handler: ChatPlaneMessageHandler
): Layer.Layer<ChatPlane, ChatPlaneStartupError> =>
  makeChatPlaneLayer({
    handler,
    makeSdk: () => {
      if (
        (config.botToken === undefined) ===
        (config.installations === undefined)
      ) {
        throw new Error(
          "Configure either one bot token or local workspace installations"
        );
      }
      const installationProvider = makeLocalSlackInstallationProvider(
        config.installations ?? []
      );
      const configuredWorkspaceIds =
        config.installations === undefined
          ? undefined
          : new Set(
              config.installations.map((installation) => installation.teamId)
            );
      const slackAdapter = createSlackAdapter(
        config.botToken !== undefined
          ? {
              appToken: config.appToken,
              botToken: config.botToken,
              mode: "socket",
              webClientOptions: slackWebApiRequestPolicy,
            }
          : {
              appToken: config.appToken,
              installationProvider,
              mode: "socket",
              webClientOptions: slackWebApiRequestPolicy,
            }
      );
      const bot = new Chat({
        adapters: {
          // SlackAdapter implements Adapter at runtime, but its botUserId getter
          // is declared `string | undefined` rather than as an optional property.
          // Narrow the bridge to that one upstream exact-optional mismatch so a
          // future incompatibility in any other Adapter member still fails here.
          slack: slackAdapter as Omit<typeof slackAdapter, "botUserId"> &
            Pick<Adapter, "botUserId">,
        },
        concurrency: "queue",
        logger: "info",
        state: createSQLiteState({ path: config.statePath }),
        userName: config.userName,
      });

      return {
        initialize: async () => {
          if (config.installations !== undefined) {
            for (const installation of config.installations) {
              const identity = await slackAdapter.withBotToken(
                installation.botToken,
                () => slackAdapter.webClient.auth.test(),
                { installationId: installation.teamId }
              );
              if (
                !identity.ok ||
                identity.team_id !== installation.teamId ||
                identity.user_id === undefined
              ) {
                throw new Error("Slack installation identity mismatch");
              }
              installationProvider.recordBotUserId(
                installation.teamId,
                identity.user_id
              );
            }
          }
          await bot.initialize();
          // The Slack adapter deliberately treats a failed auth.test as a
          // warning. A single-workspace canary cannot route mentions without
          // that identity, so fail startup instead of appearing connected.
          if (
            config.botToken !== undefined &&
            slackAdapter.botUserId === undefined
          ) {
            throw new Error("Slack adapter identity unavailable");
          }
        },
        onNewMention: (registeredHandler) => {
          bot.onNewMention((thread, message, context) => {
            const workspaceId = workspaceIdFromRawSlackMessage(
              message.raw,
              configuredWorkspaceIds
            );
            return registeredHandler(
              toChatSdkThread(thread, workspaceId),
              toChatSdkMessage(message, workspaceId),
              toChatSdkContext(context, workspaceId)
            );
          });
        },
        onSubscribedMessage: (registeredHandler) => {
          bot.onSubscribedMessage((thread, message, context) => {
            const workspaceId = workspaceIdFromRawSlackMessage(
              message.raw,
              configuredWorkspaceIds
            );
            return registeredHandler(
              toChatSdkThread(thread, workspaceId),
              toChatSdkMessage(message, workspaceId),
              toChatSdkContext(context, workspaceId)
            );
          });
        },
        shutdown: () => bot.shutdown(),
      };
    },
  });
