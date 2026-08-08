import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  ChatPlane,
  ChatPlaneOperationError,
  type ChatSdkLike,
  type ChatSdkMentionHandler,
  type ChatSdkThreadLike,
  makeChatPlaneLayer,
} from "../src/chat-plane/chat-sdk.ts";
import { placeholderMentionHandler } from "../src/chat-plane/placeholder-handler.ts";

const CHAT_SDK_PACKAGE_IMPORT =
  /from ["'](?:chat|@chat-adapter\/slack|@chat-adapter\/state-memory)["']/;

describe("Chat plane walking skeleton", () => {
  it.effect("bridges a mention Effect into a streamed SDK thread reply", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const lifecycle: string[] = [];
        const streamedChunks: string[] = [];
        let mentionHandler: ChatSdkMentionHandler | undefined;

        const thread: ChatSdkThreadLike = {
          id: "slack:C123:123.456",
          post: async (reply) => {
            for await (const chunk of reply) {
              streamedChunks.push(chunk);
            }
          },
          subscribe: () => {
            lifecycle.push("subscribe");
            return Promise.resolve();
          },
        };
        const sdk: ChatSdkLike = {
          initialize: () => {
            lifecycle.push("initialize");
            return Promise.resolve();
          },
          onNewMention: (handler) => {
            mentionHandler = handler;
          },
          shutdown: () => {
            lifecycle.push("shutdown");
            return Promise.resolve();
          },
        };

        yield* Effect.provide(
          Effect.promise(() => {
            assert.ok(mentionHandler);
            return mentionHandler(thread, { text: "@laborer hello" });
          }),
          makeChatPlaneLayer({
            handler: placeholderMentionHandler,
            makeSdk: () => sdk,
          })
        );

        assert.deepStrictEqual(lifecycle, [
          "initialize",
          "subscribe",
          "shutdown",
        ]);
        assert.deepStrictEqual(streamedChunks, [
          "Hello from ",
          "the Laborer Chat SDK canary.",
        ]);
      })
    )
  );

  it.effect("maps SDK thread failures to schema-tagged operation errors", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread: ChatSdkThreadLike = {
          id: "slack:C123:failure",
          post: () => Promise.reject(new Error("private SDK failure")),
          subscribe: () => Promise.reject(new Error("private SDK failure")),
        };
        const sdk: ChatSdkLike = {
          initialize: () => Promise.resolve(),
          onNewMention: () => undefined,
          shutdown: () => Promise.resolve(),
        };

        const failures = yield* Effect.provide(
          Effect.gen(function* () {
            const service = yield* ChatPlane;
            const subscribe = yield* Effect.flip(service.subscribe(thread));
            const streamReply = yield* Effect.flip(
              service.streamReply(
                thread,
                (async function* () {
                  await Promise.resolve();
                  yield "public";
                })()
              )
            );
            return { streamReply, subscribe };
          }),
          makeChatPlaneLayer({
            handler: placeholderMentionHandler,
            makeSdk: () => sdk,
          })
        );

        assert.instanceOf(failures.subscribe, ChatPlaneOperationError);
        assert.equal(failures.subscribe.operation, "thread.subscribe");
        assert.equal(failures.subscribe.reason, "Chat SDK operation failed");
        assert.instanceOf(failures.streamReply, ChatPlaneOperationError);
        assert.equal(failures.streamReply.operation, "thread.post");
        assert.equal(failures.streamReply.reason, "Chat SDK operation failed");
      })
    )
  );

  it("keeps Chat SDK package imports inside the Effect service module", () => {
    const packageRoot = resolve(process.cwd());
    const files = [
      "src/chat-plane/placeholder-handler.ts",
      "src/chat-plane/live.ts",
      "tests/chat-plane.test.ts",
    ];
    for (const file of files) {
      const source = readFileSync(resolve(packageRoot, file), "utf8");
      assert.notMatch(source, CHAT_SDK_PACKAGE_IMPORT);
    }
  });
});
