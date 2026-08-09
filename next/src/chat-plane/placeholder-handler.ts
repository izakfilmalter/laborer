import { Effect } from "effect";
import {
  type ChatPlaneWorkHandler,
  makeConversationHandler,
} from "./conversation-handler.ts";

const placeholderReply = async function* (): AsyncGenerator<string> {
  yield "Hello from ";
  await Promise.resolve();
  yield "the Laborer Chat SDK canary.";
};

const placeholderWorkHandler: ChatPlaneWorkHandler = Effect.fn(
  "ChatPlane.placeholderWorkHandler"
)(() => Effect.succeed({ publicReply: placeholderReply() }));

export const placeholderMentionHandler = makeConversationHandler(
  placeholderWorkHandler
);
