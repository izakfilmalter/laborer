import { createSlackAdapter } from "@chat-adapter/slack";
import { createMemoryState } from "@chat-adapter/state-memory";
import { type Adapter, Chat } from "chat";
import { Context, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { slackWebApiRequestPolicy } from "../slack/web-api-request-policy.ts";

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
}

export interface ChatSdkThreadLike {
  readonly allMessages: AsyncIterable<ChatSdkMessageLike>;
  readonly channelMessages: AsyncIterable<ChatSdkMessageLike>;
  readonly id: string;
  readonly isDM: boolean;
  readonly post: (reply: string | AsyncIterable<string>) => Promise<unknown>;
  readonly rootMessageId: string;
  readonly subscribe: () => Promise<void>;
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

const SLACK_MESSAGE_ID = /^(\d+)\.(\d+)$/;

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

export interface LiveChatPlaneConfig {
  readonly appToken: string;
  readonly botToken: string;
  readonly userName: string;
}

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

const toChatSdkMessage = (message: LiveMessageLike): ChatSdkMessageLike => ({
  author: message.author,
  edited: message.metadata.edited,
  id: message.id,
  isMention: message.isMention === true,
  sentAt: message.metadata.dateSent,
  text: message.text,
});

const mapMessages = (
  messages: AsyncIterable<LiveMessageLike>
): AsyncIterable<ChatSdkMessageLike> => ({
  async *[Symbol.asyncIterator]() {
    for await (const message of messages) {
      yield toChatSdkMessage(message);
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

const toChatSdkThread = (thread: LiveThreadLike): ChatSdkThreadLike => ({
  allMessages: mapMessages(thread.allMessages),
  channelMessages: mapMessages(thread.channel.messages),
  id: thread.id,
  isDM: thread.isDM,
  post: (reply) => thread.post(reply),
  rootMessageId: thread.id.slice(thread.id.lastIndexOf(":") + 1),
  subscribe: () => thread.subscribe(),
});

const toChatSdkContext = (
  context: { readonly skipped: readonly LiveMessageLike[] } | undefined
): ChatSdkMessageContextLike => ({
  skipped: context?.skipped.map(toChatSdkMessage) ?? [],
});

export const makeLiveChatPlaneLayer = (
  config: LiveChatPlaneConfig,
  handler: ChatPlaneMessageHandler
): Layer.Layer<ChatPlane, ChatPlaneStartupError> =>
  makeChatPlaneLayer({
    handler,
    makeSdk: () => {
      const slackAdapter = createSlackAdapter({
        appToken: config.appToken,
        botToken: config.botToken,
        mode: "socket",
        webClientOptions: slackWebApiRequestPolicy,
      });
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
        state: createMemoryState(),
        userName: config.userName,
      });

      return {
        initialize: async () => {
          await bot.initialize();
          // The Slack adapter deliberately treats a failed auth.test as a
          // warning. A single-workspace canary cannot route mentions without
          // that identity, so fail startup instead of appearing connected.
          if (slackAdapter.botUserId === undefined) {
            throw new Error("Slack adapter identity unavailable");
          }
        },
        onNewMention: (registeredHandler) => {
          bot.onNewMention((thread, message, context) =>
            registeredHandler(
              toChatSdkThread(thread),
              toChatSdkMessage(message),
              toChatSdkContext(context)
            )
          );
        },
        onSubscribedMessage: (registeredHandler) => {
          bot.onSubscribedMessage((thread, message, context) =>
            registeredHandler(
              toChatSdkThread(thread),
              toChatSdkMessage(message),
              toChatSdkContext(context)
            )
          );
        },
        shutdown: () => bot.shutdown(),
      };
    },
  });
