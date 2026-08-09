import { Effect } from "effect";
import type {
  AcpPermissionBroker,
  AcpPermissionInteraction,
  AcpPermissionPresentationRequest,
  AcpPermissionPresenter,
} from "./acp-permission-broker.ts";

export interface ChatPermissionBoundary {
  readonly post: (
    request: AcpPermissionPresentationRequest
  ) => Effect.Effect<{ readonly messageTs: string }, unknown>;
  readonly settle: (request: {
    readonly authorizedSlackUserId: string;
    readonly capability: string;
    readonly category: string;
    readonly channelId: string;
    readonly messageTs: string | null;
    readonly presentationMarker: string;
    readonly rootTs: string;
    readonly state: "allowed" | "cancelled" | "expired" | "rejected";
    readonly workspaceId: string;
  }) => Effect.Effect<void, unknown>;
}

/**
 * Best-effort Chat UI for ACP authority. There is deliberately no recovery or
 * durable publication outbox: the authority repository and broker own the
 * one-shot decision, while cards and block actions are at-most-once.
 */
export const makeChatAcpPermissionPresenter = (
  chat: ChatPermissionBoundary
): AcpPermissionPresenter => ({
  drain: Effect.void,
  post: chat.post,
  settle: (request) => chat.settle(request).pipe(Effect.ignore),
});

export interface ChatPermissionActionDirectory {
  readonly brokerForWorkspace: (
    workspaceId: string
  ) => Effect.Effect<AcpPermissionBroker>;
}

export const handleChatPermissionAction = Effect.fn(
  "AcpRuntime.handleChatPermissionAction"
)(function* (
  directory: ChatPermissionActionDirectory,
  interaction: AcpPermissionInteraction
) {
  const broker = yield* directory.brokerForWorkspace(interaction.workspaceId);
  return yield* broker.handleInteraction(interaction);
});
