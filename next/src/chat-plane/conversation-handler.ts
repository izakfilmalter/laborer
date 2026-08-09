import { Effect, Schema } from "effect";
import { NormalizedImage } from "../core/domain.ts";
import {
  ChatPlane,
  type ChatPlaneMessageHandler,
  type ChatSdkMessageLike,
} from "./chat-sdk.ts";

export class ChatPlaneNormalizedMessage extends Schema.Class<ChatPlaneNormalizedMessage>(
  "ChatPlaneNormalizedMessage"
)({
  authorKind: Schema.Literals(["human", "externalBot"]),
  authorSlackId: Schema.String,
  classification: Schema.Literals(["context", "input"]),
  id: Schema.String,
  images: Schema.optional(Schema.Array(NormalizedImage)),
  isActivation: Schema.Boolean,
  slackTs: Schema.String,
  text: Schema.String,
}) {}

export interface ChatPlaneTurn {
  readonly channelId: string;
  readonly messages: readonly ChatPlaneNormalizedMessage[];
  readonly rootTs: string;
  readonly threadId: string;
  readonly workspaceId: string;
}

export interface ChatPlaneWorkResult {
  readonly publicReply?: AsyncIterable<string>;
}

export type ChatPlaneWorkHandler = (
  turn: ChatPlaneTurn
) => Effect.Effect<ChatPlaneWorkResult, unknown>;

export const TURN_FAILED_OPERATIONAL_NOTICE =
  "Laborer turn failed (category: work-handler). Mention Laborer again to continue.";

type TurnFailureCategory = "chat-operation" | "internal" | "work-handler";

const operationalNotice = (category: TurnFailureCategory): string =>
  `Laborer turn failed (category: ${category}). Mention Laborer again to continue.`;

const normalizeMessage = (
  message: ChatSdkMessageLike,
  classification: "context" | "input",
  isActivation: boolean
): ChatPlaneNormalizedMessage =>
  ChatPlaneNormalizedMessage.make({
    authorKind: message.author.isBot === true ? "externalBot" : "human",
    authorSlackId: message.author.userId,
    classification,
    id: message.id,
    images: message.images === undefined ? [] : [...message.images],
    isActivation,
    slackTs: message.id,
    text: message.text,
  });

const isEligibleInput = (message: ChatSdkMessageLike): boolean =>
  !message.author.isMe &&
  message.author.isSystem !== true &&
  !message.edited &&
  message.text.trim().length > 0;

export const makeConversationHandler = (
  workHandler: ChatPlaneWorkHandler
): ChatPlaneMessageHandler =>
  Effect.fn("ChatPlane.conversationHandler")(
    function* (thread, message, context, isActivation) {
      const chatPlane = yield* ChatPlane;
      const runTurn = Effect.gen(function* () {
        if (isActivation) {
          yield* chatPlane
            .subscribe(thread)
            .pipe(Effect.mapError(() => "chat-operation" as const));
        }
        const history = isActivation
          ? yield* chatPlane
              .readActivationHistory(thread, message)
              .pipe(Effect.mapError(() => "chat-operation" as const))
          : [];
        const backlog = context.skipped.filter(isEligibleInput);
        const messages = [
          ...history.map((historical) =>
            normalizeMessage(historical, "context", false)
          ),
          ...backlog.map((skipped) =>
            normalizeMessage(skipped, "input", false)
          ),
          normalizeMessage(message, "input", isActivation),
        ];
        const result = yield* workHandler({
          channelId: thread.channelId,
          messages,
          rootTs: thread.rootMessageId,
          threadId: thread.id,
          workspaceId: thread.workspaceId,
        }).pipe(Effect.catchCause(() => Effect.fail("work-handler" as const)));
        if (result.publicReply !== undefined) {
          yield* chatPlane
            .streamReply(thread, result.publicReply)
            .pipe(Effect.mapError(() => "chat-operation" as const));
        }
      });

      yield* runTurn.pipe(
        Effect.catch((category) =>
          chatPlane
            .postNotice(thread, operationalNotice(category))
            .pipe(Effect.ignore)
        ),
        Effect.catchCause(() =>
          chatPlane
            .postNotice(thread, operationalNotice("internal"))
            .pipe(Effect.ignore)
        )
      );
    }
  );
