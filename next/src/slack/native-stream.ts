import type {
  ChatAppendStreamArguments,
  ChatAppendStreamResponse,
  ChatStartStreamArguments,
  ChatStartStreamResponse,
  ChatStopStreamArguments,
  ChatStopStreamResponse,
} from "@slack/web-api";
import { Effect } from "effect";
import { classifySlackError } from "../prototype/emulated-slack.ts";
import { DeliveryError } from "../prototype/errors.ts";
import type { SlackNativeStreamCapability } from "../prototype/runtime.ts";

const SLACK_MARKDOWN_TEXT_LIMIT = 12_000;

export interface SlackNativeStreamWebApiClient {
  readonly appendStream: (
    request: ChatAppendStreamArguments
  ) => Promise<ChatAppendStreamResponse>;
  readonly startStream: (
    request: ChatStartStreamArguments
  ) => Promise<ChatStartStreamResponse>;
  readonly stopStream: (
    request: ChatStopStreamArguments
  ) => Promise<ChatStopStreamResponse>;
}

export const splitSlackMarkdown = (
  text: string,
  characterLimit = SLACK_MARKDOWN_TEXT_LIMIT
): readonly string[] => {
  if (!Number.isSafeInteger(characterLimit) || characterLimit <= 0) {
    throw new RangeError("Slack Markdown character limit must be positive");
  }
  const segments: string[] = [];
  let current = "";
  let currentCharacters = 0;
  for (const codePoint of text) {
    if (currentCharacters === characterLimit) {
      segments.push(current);
      current = "";
      currentCharacters = 0;
    }
    current = `${current}${codePoint}`;
    currentCharacters += 1;
  }
  if (current.length > 0) {
    segments.push(current);
  }
  return segments;
};

const deliveryError = (cause: unknown): DeliveryError => {
  const failure = classifySlackError(cause);
  return DeliveryError.make({
    category: failure.category,
    disposition: failure.disposition,
    retryAfterMillis: failure.retryAfterMillis,
  });
};

const validatedStreamTs = (
  method: "chat.appendStream" | "chat.startStream" | "chat.stopStream",
  response: { readonly ok?: boolean; readonly ts?: string }
): string => {
  if (response.ok !== true) {
    throw new Error(`${method} returned an unsuccessful response`);
  }
  if (typeof response.ts !== "string" || response.ts.length === 0) {
    throw new Error(`${method} response omitted ts`);
  }
  return response.ts;
};

export const makeSlackNativeStreamCapability = (options: {
  readonly client: SlackNativeStreamWebApiClient;
  readonly markdownTextLimit?: number;
  readonly recipientTeamId: string;
}): SlackNativeStreamCapability => {
  const markdownTextLimit =
    options.markdownTextLimit ?? SLACK_MARKDOWN_TEXT_LIMIT;
  const bestEffortStop = async (
    channelId: string,
    streamTs: string
  ): Promise<void> => {
    try {
      const response = await options.client.stopStream({
        channel: channelId,
        ts: streamTs,
      });
      validatedStreamTs("chat.stopStream", response);
    } catch {
      // Preserve the append failure that triggered this cleanup attempt.
    }
  };
  return {
    append: ({ channelId, streamTs, text }) =>
      Effect.tryPromise({
        try: async () => {
          const segments = splitSlackMarkdown(text, markdownTextLimit);
          for (const segment of segments) {
            const response = await options.client.appendStream({
              channel: channelId,
              markdown_text: segment,
              ts: streamTs,
            });
            validatedStreamTs("chat.appendStream", response);
          }
        },
        catch: deliveryError,
      }),
    start: ({ channelId, recipientUserId, rootTs, text }) =>
      Effect.tryPromise({
        try: async () => {
          const [initialSegment, ...remainingSegments] = splitSlackMarkdown(
            text,
            markdownTextLimit
          );
          if (initialSegment === undefined) {
            throw new Error("Slack native stream cannot start with empty text");
          }
          const response = await options.client.startStream({
            channel: channelId,
            markdown_text: initialSegment,
            recipient_team_id: options.recipientTeamId,
            recipient_user_id: recipientUserId,
            thread_ts: rootTs,
          });
          const streamTs = validatedStreamTs("chat.startStream", response);
          try {
            for (const segment of remainingSegments) {
              const appendResponse = await options.client.appendStream({
                channel: channelId,
                markdown_text: segment,
                ts: streamTs,
              });
              validatedStreamTs("chat.appendStream", appendResponse);
            }
          } catch (cause) {
            await bestEffortStop(channelId, streamTs);
            throw cause;
          }
          return { ts: streamTs };
        },
        catch: deliveryError,
      }),
    stop: ({ channelId, streamTs }) =>
      Effect.tryPromise({
        try: async () => {
          const response = await options.client.stopStream({
            channel: channelId,
            ts: streamTs,
          });
          validatedStreamTs("chat.stopStream", response);
        },
        catch: deliveryError,
      }).pipe(Effect.asVoid),
  };
};
