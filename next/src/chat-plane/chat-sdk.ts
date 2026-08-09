import { createSlackAdapter } from "@chat-adapter/slack";
import { type Adapter, Chat } from "chat";
import { Context, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { slackWebApiRequestPolicy } from "../slack/web-api-request-policy.ts";
import { createSQLiteState } from "./sqlite-state-adapter.ts";

export interface ChatSdkMessageLike {
  readonly text: string;
}

export interface ChatSdkThreadLike {
  readonly id: string;
  readonly post: (reply: AsyncIterable<string>) => Promise<unknown>;
  readonly subscribe: () => Promise<void>;
}

export type ChatSdkMentionHandler = (
  thread: ChatSdkThreadLike,
  message: ChatSdkMessageLike
) => Promise<void>;

export interface ChatSdkLike {
  readonly initialize: () => Promise<void>;
  readonly onNewMention: (handler: ChatSdkMentionHandler) => void;
  readonly onSubscribedMessage: (handler: ChatSdkMentionHandler) => void;
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

export type ChatPlaneMentionHandler = (
  thread: ChatSdkThreadLike,
  message: ChatSdkMessageLike
) => Effect.Effect<void, ChatPlaneOperationError, ChatPlane>;

interface MakeChatPlaneLayerOptions {
  readonly handler: ChatPlaneMentionHandler;
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

const makeService = (): ChatPlaneShape => ({
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
          const runHandler: ChatSdkMentionHandler = (thread, message) =>
            inboundRuntime.runPromise(options.handler(thread, message));
          sdk.onNewMention(runHandler);
          sdk.onSubscribedMessage(runHandler);
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
  readonly statePath: string;
  readonly userName: string;
}

export const makeLiveChatPlaneLayer = (
  config: LiveChatPlaneConfig,
  handler: ChatPlaneMentionHandler
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
        state: createSQLiteState({ path: config.statePath }),
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
          bot.onNewMention((thread, message) =>
            registeredHandler(
              {
                id: thread.id,
                post: (reply) => thread.post(reply),
                subscribe: () => thread.subscribe(),
              },
              { text: message.text }
            )
          );
        },
        onSubscribedMessage: (registeredHandler) => {
          bot.onSubscribedMessage((thread, message) =>
            registeredHandler(
              {
                id: thread.id,
                post: (reply) => thread.post(reply),
                subscribe: () => thread.subscribe(),
              },
              { text: message.text }
            )
          );
        },
        shutdown: () => bot.shutdown(),
      };
    },
  });
