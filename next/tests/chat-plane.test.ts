import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  ChatPlane,
  ChatPlaneOperationError,
  ChatPlaneStartupError,
  type ChatSdkLike,
  type ChatSdkMentionHandler,
  type ChatSdkThreadLike,
  makeChatPlaneLayer,
} from "../src/chat-plane/chat-sdk.ts";
import { placeholderMentionHandler } from "../src/chat-plane/placeholder-handler.ts";
import {
  CHAT_CANARY_SLACK_APP_TOKEN_VARIABLE,
  CHAT_CANARY_SLACK_BOT_TOKEN_VARIABLE,
  loadChatCanarySlackConfig,
} from "../src/slack/config.ts";

const CHAT_SDK_PACKAGE_IMPORT =
  /from ["'](?:chat|@chat-adapter\/slack|@chat-adapter\/state-memory)["']/;

describe("Chat plane walking skeleton", () => {
  it.effect("requires valid credentials dedicated to the Chat SDK canary", () =>
    Effect.gen(function* () {
      const appToken = ["x", "app", "-chat-canary-fixture"].join("");
      const botToken = ["x", "oxb", "-chat-canary-fixture"].join("");

      const missingDedicatedTokens = yield* Effect.result(
        loadChatCanarySlackConfig({
          SLACK_APP_TOKEN: ["x", "app", "-production-fixture"].join(""),
          SLACK_BOT_TOKEN: ["x", "oxb", "-production-fixture"].join(""),
        })
      );
      assert.strictEqual(missingDedicatedTokens._tag, "Failure");

      const reusedProductionTokens = yield* Effect.result(
        loadChatCanarySlackConfig({
          [CHAT_CANARY_SLACK_APP_TOKEN_VARIABLE]: appToken,
          [CHAT_CANARY_SLACK_BOT_TOKEN_VARIABLE]: botToken,
          SLACK_APP_TOKEN: appToken,
          SLACK_BOT_TOKEN: botToken,
        })
      );
      assert.strictEqual(reusedProductionTokens._tag, "Failure");
      if (reusedProductionTokens._tag === "Failure") {
        assert.strictEqual(
          reusedProductionTokens.failure.reason,
          "matches-production-token"
        );
      }

      const dedicatedConfig = yield* loadChatCanarySlackConfig({
        [CHAT_CANARY_SLACK_APP_TOKEN_VARIABLE]: appToken,
        [CHAT_CANARY_SLACK_BOT_TOKEN_VARIABLE]: botToken,
      });
      assert.strictEqual(dedicatedConfig.appToken.toString(), "<redacted>");
      assert.strictEqual(dedicatedConfig.botToken.toString(), "<redacted>");
    })
  );

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

  it.effect("shuts down an SDK whose initialization fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const lifecycle: string[] = [];
        const sdk: ChatSdkLike = {
          initialize: () => {
            lifecycle.push("initialize");
            return Promise.reject(new Error("private initialization failure"));
          },
          onNewMention: () => {
            lifecycle.push("register");
          },
          shutdown: () => {
            lifecycle.push("shutdown");
            return Promise.resolve();
          },
        };

        const failure = yield* Effect.flip(
          Effect.provide(
            Effect.asVoid(ChatPlane),
            makeChatPlaneLayer({
              handler: placeholderMentionHandler,
              makeSdk: () => sdk,
            })
          )
        );

        assert.instanceOf(failure, ChatPlaneStartupError);
        assert.equal(failure.operation, "initialize");
        assert.equal(failure.reason, "Chat SDK startup failed");
        assert.deepStrictEqual(lifecycle, [
          "register",
          "initialize",
          "shutdown",
        ]);
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
