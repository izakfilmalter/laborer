import { createSlackAdapter } from "@chat-adapter/slack";
import { createMemoryState } from "@chat-adapter/state-memory";
import { type Adapter, Chat } from "chat";
import { Context, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { slackWebApiRequestPolicy } from "../slack/web-api-request-policy.ts";

export interface ChatSdkMessageLike {
  readonly text: string;
  readonly workspaceId: string;
}

export interface ChatSdkThreadLike {
  readonly id: string;
  readonly post: (reply: AsyncIterable<string>) => Promise<unknown>;
  readonly subscribe: () => Promise<void>;
  readonly workspaceId: string;
}

export type ChatSdkMentionHandler = (
  thread: ChatSdkThreadLike,
  message: ChatSdkMessageLike
) => Promise<void>;

export interface ChatSdkLike {
  readonly initialize: () => Promise<void>;
  readonly onNewMention: (handler: ChatSdkMentionHandler) => void;
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
          sdk.onNewMention((thread, message) =>
            inboundRuntime.runPromise(options.handler(thread, message))
          );
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

const workspaceIdFromRawSlackMessage = (raw: unknown): string => {
  const decoded = Schema.decodeUnknownSync(SlackMessageWorkspace)(raw);
  if (
    decoded.team !== undefined &&
    decoded.team_id !== undefined &&
    decoded.team !== decoded.team_id
  ) {
    throw new Error("Conflicting Slack workspace identity");
  }
  const workspaceId = decoded.team_id ?? decoded.team;
  if (workspaceId === undefined || !SLACK_TEAM_ID_PATTERN.test(workspaceId)) {
    throw new Error("Slack workspace identity unavailable");
  }
  return workspaceId;
};

export const makeLiveChatPlaneLayer = (
  config: LiveChatPlaneConfig,
  handler: ChatPlaneMentionHandler
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
        state: createMemoryState(),
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
          bot.onNewMention((thread, message) => {
            const workspaceId = workspaceIdFromRawSlackMessage(message.raw);
            return registeredHandler(
              {
                id: thread.id,
                post: (reply) => thread.post(reply),
                subscribe: () => thread.subscribe(),
                workspaceId,
              },
              { text: message.text, workspaceId }
            );
          });
        },
        shutdown: () => bot.shutdown(),
      };
    },
  });
