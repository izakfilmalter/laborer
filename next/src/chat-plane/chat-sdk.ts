import { createSlackAdapter } from "@chat-adapter/slack";
import {
  type Adapter,
  type Attachment,
  type CardElement,
  Chat,
  type SentMessage,
} from "chat";
import { Context, Effect, Layer, ManagedRuntime, Schema } from "effect";
import type { NormalizedImage } from "../core/domain.ts";
import { slackWebApiRequestPolicy } from "../slack/web-api-request-policy.ts";
import { hydrateChatImageAttachments } from "./attachment-hydration.ts";
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
  readonly images?: readonly NormalizedImage[];
  readonly isMention: boolean;
  readonly sentAt: Date;
  readonly text: string;
  readonly workspaceId: string;
}

export interface ChatSdkThreadLike {
  readonly allMessages: AsyncIterable<ChatSdkMessageLike>;
  readonly channelId: string;
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
  readonly getPermalink?: (
    workspaceId: string,
    channelId: string,
    messageTs: string
  ) => Promise<string>;
  readonly initialize: () => Promise<void>;
  readonly onAction?: (handler: ChatSdkActionHandler) => void;
  readonly onNewMention: (handler: ChatSdkMessageHandler) => void;
  readonly onSubscribedMessage: (handler: ChatSdkMessageHandler) => void;
  readonly postPermission?: (
    request: ChatPermissionPresentation
  ) => Promise<{ readonly messageTs: string }>;
  readonly postToThread?: (
    workspaceId: string,
    channelId: string,
    rootTs: string,
    output: string
  ) => Promise<void>;
  readonly settlePermission?: (
    request: ChatPermissionSettlement
  ) => Promise<void>;
  readonly shutdown: () => Promise<void>;
}

export interface ChatSdkActionLike {
  readonly actionId: string;
  readonly capability: string;
  readonly channelId: string;
  readonly messageTs: string;
  readonly rootTs: string;
  readonly slackUserId: string;
  readonly workspaceId: string;
}

export type ChatSdkActionHandler = (action: ChatSdkActionLike) => Promise<void>;

export interface ChatPermissionPresentation {
  readonly authorizedSlackUserId: string;
  readonly capability: string;
  readonly category: string;
  readonly channelId: string;
  readonly presentationMarker: string;
  readonly rootTs: string;
  readonly workspaceId: string;
}

export interface ChatPermissionSettlement extends ChatPermissionPresentation {
  readonly messageTs: string | null;
  readonly state: "allowed" | "cancelled" | "expired" | "rejected";
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
  readonly getPermalink: (
    workspaceId: string,
    channelId: string,
    messageTs: string
  ) => Effect.Effect<string, ChatPlaneOperationError>;
  readonly postNotice: (
    thread: ChatSdkThreadLike,
    notice: string
  ) => Effect.Effect<void, ChatPlaneOperationError>;
  readonly postPermission: (
    request: ChatPermissionPresentation
  ) => Effect.Effect<{ readonly messageTs: string }, ChatPlaneOperationError>;
  readonly postToThread: (
    workspaceId: string,
    channelId: string,
    rootTs: string,
    output: string
  ) => Effect.Effect<void, ChatPlaneOperationError>;
  readonly readActivationHistory: (
    thread: ChatSdkThreadLike,
    activation: ChatSdkMessageLike
  ) => Effect.Effect<readonly ChatSdkMessageLike[], ChatPlaneOperationError>;
  readonly settlePermission: (
    request: ChatPermissionSettlement
  ) => Effect.Effect<void, ChatPlaneOperationError>;
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
  readonly actionHandler?: (
    action: ChatSdkActionLike
  ) => Effect.Effect<void, unknown>;
  readonly handler: ChatPlaneMessageHandler;
  readonly makeSdk: () => ChatSdkLike;
  readonly onReady?: (service: ChatPlaneShape) => void;
}

const operationFailure = (operation: string): ChatPlaneOperationError =>
  ChatPlaneOperationError.make({
    operation,
    reason: "Chat SDK operation failed",
  });

const permissionCard = (request: ChatPermissionPresentation): CardElement => ({
  children: [
    {
      content: `<@${request.authorizedSlackUserId}> allow ${request.category}?`,
      type: "text",
    },
    {
      children: [
        {
          id: "laborer_permission_allow_once",
          label: "Allow once",
          style: "primary",
          type: "button",
          value: request.capability,
        },
        {
          id: "laborer_permission_reject_once",
          label: "Reject",
          style: "danger",
          type: "button",
          value: request.capability,
        },
      ],
      type: "actions",
    },
  ],
  type: "card",
});

const settledPermissionCard = (
  state: ChatPermissionSettlement["state"]
): CardElement => ({
  children: [{ content: `Permission ${state}.`, type: "text" }],
  type: "card",
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

const makeService = (sdk: ChatSdkLike): ChatPlaneShape => ({
  getPermalink: (workspaceId, channelId, messageTs) =>
    Effect.tryPromise({
      try: () => {
        if (sdk.getPermalink === undefined) {
          throw new Error("Chat permalink lookup unavailable");
        }
        return sdk.getPermalink(workspaceId, channelId, messageTs);
      },
      catch: () => operationFailure("chat.getPermalink"),
    }),
  postPermission: (request) =>
    Effect.tryPromise({
      try: () => {
        if (sdk.postPermission === undefined) {
          throw new Error("Chat permission presentation unavailable");
        }
        return sdk.postPermission(request);
      },
      catch: () => operationFailure("thread.post-permission"),
    }),
  postToThread: (workspaceId, channelId, rootTs, output) =>
    Effect.tryPromise({
      try: () => {
        if (sdk.postToThread === undefined) {
          throw new Error("Chat thread publication unavailable");
        }
        return sdk.postToThread(workspaceId, channelId, rootTs, output);
      },
      catch: () => operationFailure("thread.post-external-output"),
    }),
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
  settlePermission: (request) =>
    Effect.tryPromise({
      try: () => sdk.settlePermission?.(request) ?? Promise.resolve(),
      catch: () => operationFailure("message.edit-permission"),
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
      const service = makeService(sdk);
      yield* Effect.sync(() => options.onReady?.(service));
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
          if (
            options.actionHandler !== undefined &&
            sdk.onAction !== undefined
          ) {
            sdk.onAction((action) =>
              inboundRuntime.runPromise(
                options.actionHandler?.(action) ?? Effect.void
              )
            );
          }
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
  team: Schema.optional(
    Schema.Union([Schema.String, Schema.Struct({ id: Schema.String })])
  ),
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
    typeof decoded.team === "string" &&
    decoded.team_id !== undefined &&
    decoded.team !== decoded.team_id
  ) {
    throw new Error("Slack workspace identity unavailable");
  }
  const workspaceId =
    decoded.team_id ??
    (typeof decoded.team === "string" ? decoded.team : decoded.team?.id);
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
  readonly attachments?: Attachment[];
  readonly author: ChatSdkMessageLike["author"];
  readonly id: string;
  readonly isMention?: boolean;
  readonly metadata: {
    readonly dateSent: Date;
    readonly edited: boolean;
  };
  readonly text: string;
}

const toChatSdkMessage = async (
  message: LiveMessageLike,
  workspaceId: string,
  attachmentStorageRoot?: string
): Promise<ChatSdkMessageLike> => ({
  author: message.author,
  edited: message.metadata.edited,
  id: message.id,
  isMention: message.isMention === true,
  images:
    attachmentStorageRoot === undefined
      ? []
      : await hydrateChatImageAttachments(
          message.attachments ?? [],
          attachmentStorageRoot
        ),
  sentAt: message.metadata.dateSent,
  text: message.text,
  workspaceId,
});

const mapMessages = (
  messages: AsyncIterable<LiveMessageLike>,
  workspaceId: string,
  attachmentStorageRoot?: string
): AsyncIterable<ChatSdkMessageLike> => ({
  async *[Symbol.asyncIterator]() {
    for await (const message of messages) {
      yield await toChatSdkMessage(message, workspaceId, attachmentStorageRoot);
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
  workspaceId: string,
  attachmentStorageRoot?: string
): ChatSdkThreadLike => ({
  allMessages: mapMessages(
    thread.allMessages,
    workspaceId,
    attachmentStorageRoot
  ),
  channelId: thread.id.slice(
    thread.id.indexOf(":") + 1,
    thread.id.lastIndexOf(":")
  ),
  channelMessages: mapMessages(
    thread.channel.messages,
    workspaceId,
    attachmentStorageRoot
  ),
  id: thread.id,
  isDM: thread.isDM,
  post: (reply) => thread.post(reply),
  rootMessageId: thread.id.slice(thread.id.lastIndexOf(":") + 1),
  subscribe: () => thread.subscribe(),
  workspaceId,
});

const toChatSdkContext = async (
  context: { readonly skipped: readonly LiveMessageLike[] } | undefined,
  workspaceId: string,
  attachmentStorageRoot?: string
): Promise<ChatSdkMessageContextLike> => ({
  skipped: await Promise.all(
    context?.skipped.map((message) =>
      toChatSdkMessage(message, workspaceId, attachmentStorageRoot)
    ) ?? []
  ),
});

export const makeLiveChatPlaneLayer = (
  config: LiveChatPlaneConfig,
  handler: ChatPlaneMessageHandler,
  options: {
    readonly actionHandler?: (
      action: ChatSdkActionLike
    ) => Effect.Effect<void, unknown>;
    readonly onReady?: (service: ChatPlaneShape) => void;
    readonly attachmentStorageRoot?: (
      workspaceId: string
    ) => string | undefined;
  } = {}
): Layer.Layer<ChatPlane, ChatPlaneStartupError> =>
  makeChatPlaneLayer({
    ...options,
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
      const permissionMessages = new Map<string, SentMessage<unknown>>();
      const withWorkspaceToken = <A>(
        workspaceId: string,
        operation: () => Promise<A>
      ): Promise<A> => {
        if (config.installations === undefined) {
          return operation();
        }
        const installation = config.installations.find(
          (candidate) => candidate.teamId === workspaceId
        );
        if (installation === undefined) {
          return Promise.reject(new Error("Unknown Slack workspace"));
        }
        return slackAdapter.withBotToken(installation.botToken, operation, {
          installationId: workspaceId,
        });
      };

      return {
        getPermalink: async (workspaceId, channelId, messageTs) => {
          const response = await withWorkspaceToken(workspaceId, () =>
            slackAdapter.webClient.chat.getPermalink({
              channel: channelId,
              message_ts: messageTs,
            })
          );
          if (!(response.ok && typeof response.permalink === "string")) {
            throw new Error("Slack permalink unavailable");
          }
          return response.permalink;
        },
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
          bot.onNewMention(async (thread, message, context) => {
            const workspaceId = workspaceIdFromRawSlackMessage(
              message.raw,
              configuredWorkspaceIds
            );
            const storageRoot = options.attachmentStorageRoot?.(workspaceId);
            return registeredHandler(
              toChatSdkThread(thread, workspaceId, storageRoot),
              await toChatSdkMessage(message, workspaceId, storageRoot),
              await toChatSdkContext(context, workspaceId, storageRoot)
            );
          });
        },
        onAction: (registeredHandler) => {
          bot.onAction(
            ["laborer_permission_allow_once", "laborer_permission_reject_once"],
            (event) => {
              const workspaceId = workspaceIdFromRawSlackMessage(
                event.raw,
                configuredWorkspaceIds
              );
              const thread = event.thread;
              if (thread === null || event.value === undefined) {
                return Promise.resolve();
              }
              const channelId = thread.id.slice(
                thread.id.indexOf(":") + 1,
                thread.id.lastIndexOf(":")
              );
              return registeredHandler({
                actionId: event.actionId,
                capability: event.value,
                channelId,
                messageTs: event.messageId,
                rootTs: thread.id.slice(thread.id.lastIndexOf(":") + 1),
                slackUserId: event.user.userId,
                workspaceId,
              });
            }
          );
        },
        onSubscribedMessage: (registeredHandler) => {
          bot.onSubscribedMessage(async (thread, message, context) => {
            const workspaceId = workspaceIdFromRawSlackMessage(
              message.raw,
              configuredWorkspaceIds
            );
            const storageRoot = options.attachmentStorageRoot?.(workspaceId);
            return registeredHandler(
              toChatSdkThread(thread, workspaceId, storageRoot),
              await toChatSdkMessage(message, workspaceId, storageRoot),
              await toChatSdkContext(context, workspaceId, storageRoot)
            );
          });
        },
        postPermission: async (request) => {
          const sent = await withWorkspaceToken(request.workspaceId, () =>
            bot.thread(`slack:${request.channelId}:${request.rootTs}`).post({
              card: permissionCard(request),
              fallbackText: "Laborer permission requested",
            })
          );
          permissionMessages.set(request.presentationMarker, sent);
          return { messageTs: sent.id };
        },
        postToThread: async (workspaceId, channelId, rootTs, output) => {
          await withWorkspaceToken(workspaceId, () =>
            bot.thread(`slack:${channelId}:${rootTs}`).post(output)
          );
        },
        settlePermission: async (request) => {
          const sent = permissionMessages.get(request.presentationMarker);
          permissionMessages.delete(request.presentationMarker);
          if (sent === undefined) {
            return;
          }
          await withWorkspaceToken(request.workspaceId, () =>
            sent.edit({
              card: settledPermissionCard(request.state),
              fallbackText: `Laborer permission ${request.state}`,
            })
          );
        },
        shutdown: () => bot.shutdown(),
      };
    },
  });
