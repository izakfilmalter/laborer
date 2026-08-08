import { Effect } from "effect";
import { ChatPlane, type ChatPlaneMentionHandler } from "./chat-sdk.ts";

const placeholderReply = async function* (): AsyncGenerator<string> {
  yield "Hello from ";
  await Promise.resolve();
  yield "the Laborer Chat SDK canary.";
};

export const placeholderMentionHandler: ChatPlaneMentionHandler = Effect.fn(
  "ChatPlane.placeholderMentionHandler"
)(function* (thread) {
  const chatPlane = yield* ChatPlane;
  yield* chatPlane.subscribe(thread);
  yield* chatPlane.streamReply(thread, placeholderReply());
});
