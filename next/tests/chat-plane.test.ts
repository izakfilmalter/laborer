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
  type ChatSdkMessageLike,
  type ChatSdkThreadLike,
  makeChatPlaneLayer,
} from "../src/chat-plane/chat-sdk.ts";
import {
  type ChatPlaneTurn,
  makeConversationHandler,
  TURN_FAILED_OPERATIONAL_NOTICE,
} from "../src/chat-plane/conversation-handler.ts";
import { placeholderMentionHandler } from "../src/chat-plane/placeholder-handler.ts";
import {
  ACP_CANARY_SLACK_APP_TOKEN_VARIABLE,
  ACP_CANARY_SLACK_BOT_TOKEN_VARIABLE,
  CHAT_CANARY_SLACK_APP_TOKEN_VARIABLE,
  CHAT_CANARY_SLACK_BOT_TOKEN_VARIABLE,
  loadChatCanarySlackConfig,
} from "../src/slack/config.ts";

const CHAT_SDK_PACKAGE_IMPORT =
  /from ["'](?:chat|@chat-adapter\/slack|@chat-adapter\/state-memory)["']/;
const PRIVATE_FAILURE_DETAIL = /secret|private|TOKEN|value/;

const asMessages = (
  messages: readonly ChatSdkMessageLike[]
): AsyncIterable<ChatSdkMessageLike> => ({
  async *[Symbol.asyncIterator]() {
    yield* messages;
  },
});

const failingMessages = (): AsyncIterable<ChatSdkMessageLike> => ({
  [Symbol.asyncIterator]() {
    return {
      next: () => Promise.reject(new Error("private history failure")),
    };
  },
});

const message = (
  id: string,
  text: string,
  options: {
    readonly isBot?: boolean;
    readonly isMe?: boolean;
    readonly isMention?: boolean;
    readonly isSystem?: boolean;
  } = {}
): ChatSdkMessageLike => ({
  author: {
    isBot: options.isBot ?? false,
    isMe: options.isMe ?? false,
    isSystem: options.isSystem ?? false,
    userId: options.isMe ? "U-LABORER" : `U-${id}`,
  },
  edited: false,
  id,
  isMention: options.isMention ?? false,
  sentAt: new Date(Number(id.split(".")[0] ?? "0") * 1000),
  text,
});

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

      const reusedAcpCanaryTokens = yield* Effect.result(
        loadChatCanarySlackConfig({
          [ACP_CANARY_SLACK_APP_TOKEN_VARIABLE]: appToken,
          [ACP_CANARY_SLACK_BOT_TOKEN_VARIABLE]: botToken,
          [CHAT_CANARY_SLACK_APP_TOKEN_VARIABLE]: appToken,
          [CHAT_CANARY_SLACK_BOT_TOKEN_VARIABLE]: botToken,
        })
      );
      assert.strictEqual(reusedAcpCanaryTokens._tag, "Failure");
      if (reusedAcpCanaryTokens._tag === "Failure") {
        assert.strictEqual(
          reusedAcpCanaryTokens.failure.reason,
          "matches-other-canary-token"
        );
      }

      const reusedAcpCanaryBotToken = yield* Effect.result(
        loadChatCanarySlackConfig({
          [ACP_CANARY_SLACK_APP_TOKEN_VARIABLE]: [
            "x",
            "app",
            "-acp-canary-fixture",
          ].join(""),
          [ACP_CANARY_SLACK_BOT_TOKEN_VARIABLE]: botToken,
          [CHAT_CANARY_SLACK_APP_TOKEN_VARIABLE]: appToken,
          [CHAT_CANARY_SLACK_BOT_TOKEN_VARIABLE]: botToken,
        })
      );
      assert.strictEqual(reusedAcpCanaryBotToken._tag, "Failure");
      if (reusedAcpCanaryBotToken._tag === "Failure") {
        assert.strictEqual(
          reusedAcpCanaryBotToken.failure.variable,
          CHAT_CANARY_SLACK_BOT_TOKEN_VARIABLE
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
        const activation = message("123.456", "@laborer hello", {
          isMention: true,
        });

        const thread: ChatSdkThreadLike = {
          allMessages: asMessages([activation]),
          channelMessages: asMessages([activation]),
          id: "slack:C123:123.456",
          isDM: false,
          post: async (reply) => {
            for await (const chunk of reply) {
              streamedChunks.push(chunk);
            }
          },
          rootMessageId: "123.456",
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
          onSubscribedMessage: () => undefined,
          shutdown: () => {
            lifecycle.push("shutdown");
            return Promise.resolve();
          },
        };

        yield* Effect.provide(
          Effect.promise(() => {
            assert.ok(mentionHandler);
            return mentionHandler(thread, activation);
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
          allMessages: asMessages([]),
          channelMessages: failingMessages(),
          id: "slack:C123:failure",
          isDM: false,
          post: () => Promise.reject(new Error("private SDK failure")),
          rootMessageId: "failure",
          subscribe: () => Promise.reject(new Error("private SDK failure")),
        };
        const sdk: ChatSdkLike = {
          initialize: () => Promise.resolve(),
          onNewMention: () => undefined,
          onSubscribedMessage: () => undefined,
          shutdown: () => Promise.resolve(),
        };

        const failures = yield* Effect.provide(
          Effect.gen(function* () {
            const service = yield* ChatPlane;
            const subscribe = yield* Effect.flip(service.subscribe(thread));
            const history = yield* Effect.flip(
              service.readActivationHistory(
                thread,
                message("failure", "@laborer failure", { isMention: true })
              )
            );
            const postNotice = yield* Effect.flip(
              service.postNotice(thread, "safe notice")
            );
            const streamReply = yield* Effect.flip(
              service.streamReply(
                thread,
                (async function* () {
                  await Promise.resolve();
                  yield "public";
                })()
              )
            );
            return { history, postNotice, streamReply, subscribe };
          }),
          makeChatPlaneLayer({
            handler: placeholderMentionHandler,
            makeSdk: () => sdk,
          })
        );

        assert.instanceOf(failures.subscribe, ChatPlaneOperationError);
        assert.equal(failures.subscribe.operation, "thread.subscribe");
        assert.equal(failures.subscribe.reason, "Chat SDK operation failed");
        assert.instanceOf(failures.history, ChatPlaneOperationError);
        assert.equal(
          failures.history.operation,
          "thread.read-activation-history"
        );
        assert.instanceOf(failures.postNotice, ChatPlaneOperationError);
        assert.equal(failures.postNotice.operation, "thread.post-notice");
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
          onSubscribedMessage: () => {
            lifecycle.push("register-subscribed");
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
          "register-subscribed",
          "initialize",
          "shutdown",
        ]);
      })
    )
  );

  it.effect(
    "activates only authored non-DM mentions and subscribes the thread",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let mentionHandler: ChatSdkMentionHandler | undefined;
          let handled = 0;
          let subscriptions = 0;
          const activation = message("10.000", "@laborer start", {
            isBot: true,
            isMention: true,
          });
          const baseThread: ChatSdkThreadLike = {
            allMessages: asMessages([activation]),
            channelMessages: asMessages([activation]),
            id: "slack:C1:10.000",
            isDM: false,
            post: () => Promise.resolve(),
            rootMessageId: activation.id,
            subscribe: () => {
              subscriptions += 1;
              return Promise.resolve();
            },
          };
          const sdk: ChatSdkLike = {
            initialize: () => Promise.resolve(),
            onNewMention: (handler) => {
              mentionHandler = handler;
            },
            onSubscribedMessage: () => undefined,
            shutdown: () => Promise.resolve(),
          };
          const handler = makeConversationHandler(() => {
            handled += 1;
            return Effect.succeed({});
          });

          yield* Effect.provide(
            Effect.promise(async () => {
              assert.ok(mentionHandler);
              await mentionHandler({ ...baseThread, isDM: true }, activation);
              await mentionHandler(
                baseThread,
                message("10.001", "@laborer self", {
                  isMe: true,
                  isMention: true,
                })
              );
              await mentionHandler(
                baseThread,
                message("10.002", "   ", { isMention: true })
              );
              await mentionHandler(
                baseThread,
                message("10.003", "no explicit mention")
              );
              await mentionHandler(baseThread, activation);
            }),
            makeChatPlaneLayer({ handler, makeSdk: () => sdk })
          );

          assert.equal(handled, 1);
          assert.equal(subscriptions, 1);
        })
      )
  );

  it.effect(
    "classifies root history once, then accepts subscribed replies",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let mentionHandler: ChatSdkMentionHandler | undefined;
          let subscribedHandler: ChatSdkMentionHandler | undefined;
          const activation = message("20.000", "@laborer investigate", {
            isMention: true,
          });
          const contextOne = message("18.000", "first context");
          const contextTwo = message("19.000", "second context", {
            isBot: true,
          });
          const turns: ChatPlaneTurn[] = [];
          const thread: ChatSdkThreadLike = {
            allMessages: asMessages([activation]),
            channelMessages: asMessages([
              activation,
              contextTwo,
              message("18.500", "private", { isMe: true }),
              contextOne,
            ]),
            id: "slack:C1:20.000",
            isDM: false,
            post: () => Promise.resolve(),
            rootMessageId: activation.id,
            subscribe: () => Promise.resolve(),
          };
          const sdk: ChatSdkLike = {
            initialize: () => Promise.resolve(),
            onNewMention: (handler) => {
              mentionHandler = handler;
            },
            onSubscribedMessage: (handler) => {
              subscribedHandler = handler;
            },
            shutdown: () => Promise.resolve(),
          };
          const handler = makeConversationHandler((turn) => {
            turns.push(turn);
            return Effect.succeed({});
          });

          yield* Effect.provide(
            Effect.promise(async () => {
              assert.ok(mentionHandler);
              assert.ok(subscribedHandler);
              await mentionHandler(thread, activation);
              await subscribedHandler(thread, message("21.000", "follow-up"));
            }),
            makeChatPlaneLayer({ handler, makeSdk: () => sdk })
          );

          assert.deepStrictEqual(
            turns.map((turn) =>
              turn.messages.map((item) => ({
                authorKind: item.authorKind,
                classification: item.classification,
                isActivation: item.isActivation,
                text: item.text,
              }))
            ),
            [
              [
                {
                  authorKind: "human",
                  classification: "context",
                  isActivation: false,
                  text: "first context",
                },
                {
                  authorKind: "externalBot",
                  classification: "context",
                  isActivation: false,
                  text: "second context",
                },
                {
                  authorKind: "human",
                  classification: "input",
                  isActivation: true,
                  text: "@laborer investigate",
                },
              ],
              [
                {
                  authorKind: "human",
                  classification: "input",
                  isActivation: false,
                  text: "follow-up",
                },
              ],
            ]
          );
        })
      )
  );

  it.effect("includes the root and earlier replies for reply activation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let mentionHandler: ChatSdkMentionHandler | undefined;
        const root = message("30.000", "root");
        const earlier = message("31.000", "earlier reply");
        const activation = message("32.000", "@laborer join", {
          isMention: true,
        });
        const turns: ChatPlaneTurn[] = [];
        const thread: ChatSdkThreadLike = {
          allMessages: asMessages([
            root,
            earlier,
            activation,
            message("33.000", "too late"),
          ]),
          channelMessages: asMessages([]),
          id: "slack:C1:30.000",
          isDM: false,
          post: () => Promise.resolve(),
          rootMessageId: root.id,
          subscribe: () => Promise.resolve(),
        };
        const sdk: ChatSdkLike = {
          initialize: () => Promise.resolve(),
          onNewMention: (handler) => {
            mentionHandler = handler;
          },
          onSubscribedMessage: () => undefined,
          shutdown: () => Promise.resolve(),
        };

        yield* Effect.provide(
          Effect.promise(async () => {
            assert.ok(mentionHandler);
            await mentionHandler(thread, activation);
          }),
          makeChatPlaneLayer({
            handler: makeConversationHandler((turn) => {
              turns.push(turn);
              return Effect.succeed({});
            }),
            makeSdk: () => sdk,
          })
        );

        assert.deepStrictEqual(
          turns[0]?.messages.map(({ classification, text }) => ({
            classification,
            text,
          })),
          [
            { classification: "context", text: "root" },
            { classification: "context", text: "earlier reply" },
            { classification: "input", text: "@laborer join" },
          ]
        );
      })
    )
  );

  it.effect("surfaces a coalesced backlog in one follow-up turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let subscribedHandler: ChatSdkMentionHandler | undefined;
        const turns: ChatPlaneTurn[] = [];
        const thread: ChatSdkThreadLike = {
          allMessages: asMessages([]),
          channelMessages: asMessages([]),
          id: "slack:C1:40.000",
          isDM: false,
          post: () => Promise.resolve(),
          rootMessageId: "40.000",
          subscribe: () => Promise.resolve(),
        };
        const sdk: ChatSdkLike = {
          initialize: () => Promise.resolve(),
          onNewMention: () => undefined,
          onSubscribedMessage: (handler) => {
            subscribedHandler = handler;
          },
          shutdown: () => Promise.resolve(),
        };

        yield* Effect.provide(
          Effect.promise(async () => {
            assert.ok(subscribedHandler);
            await subscribedHandler(thread, message("43.000", "latest"), {
              skipped: [
                message("41.000", "first while busy"),
                message("42.000", "second while busy"),
              ],
            });
          }),
          makeChatPlaneLayer({
            handler: makeConversationHandler((turn) => {
              turns.push(turn);
              return Effect.succeed({});
            }),
            makeSdk: () => sdk,
          })
        );

        assert.equal(turns.length, 1);
        assert.deepStrictEqual(
          turns[0]?.messages.map((item) => item.text),
          ["first while busy", "second while busy", "latest"]
        );
      })
    )
  );

  it.effect(
    "posts one sanitized failure notice and accepts a later mention",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let mentionHandler: ChatSdkMentionHandler | undefined;
          let subscribedHandler: ChatSdkMentionHandler | undefined;
          const activation = message("50.000", "@laborer fail safely", {
            isMention: true,
          });
          const posts: string[] = [];
          let shouldFail = true;
          const thread: ChatSdkThreadLike = {
            allMessages: asMessages([activation]),
            channelMessages: asMessages([activation]),
            id: "slack:C1:50.000",
            isDM: false,
            post: async (reply) => {
              if (typeof reply === "string") {
                posts.push(reply);
                return;
              }
              let text = "";
              for await (const chunk of reply) {
                text += chunk;
              }
              posts.push(text);
            },
            rootMessageId: activation.id,
            subscribe: () => Promise.resolve(),
          };
          const sdk: ChatSdkLike = {
            initialize: () => Promise.resolve(),
            onNewMention: (handler) => {
              mentionHandler = handler;
            },
            onSubscribedMessage: (handler) => {
              subscribedHandler = handler;
            },
            shutdown: () => Promise.resolve(),
          };
          const handler = makeConversationHandler(() => {
            if (shouldFail) {
              return Effect.die(new Error("secret /private/path TOKEN=value"));
            }
            return Effect.succeed({
              publicReply: (async function* () {
                await Promise.resolve();
                yield "recovered";
              })(),
            });
          });

          yield* Effect.provide(
            Effect.promise(async () => {
              assert.ok(mentionHandler);
              assert.ok(subscribedHandler);
              await mentionHandler(thread, activation);
              shouldFail = false;
              await subscribedHandler(
                thread,
                message("51.000", "@laborer retry", { isMention: true })
              );
            }),
            makeChatPlaneLayer({ handler, makeSdk: () => sdk })
          );

          assert.deepStrictEqual(posts, [
            TURN_FAILED_OPERATIONAL_NOTICE,
            "recovered",
          ]);
          assert.notMatch(posts[0] ?? "", PRIVATE_FAILURE_DETAIL);
        })
      )
  );

  it("keeps Chat SDK package imports inside the Effect service module", () => {
    const packageRoot = resolve(process.cwd());
    const files = [
      "src/chat-plane/placeholder-handler.ts",
      "src/chat-plane/conversation-handler.ts",
      "src/chat-plane/live.ts",
      "tests/chat-plane.test.ts",
    ];
    for (const file of files) {
      const source = readFileSync(resolve(packageRoot, file), "utf8");
      assert.notMatch(source, CHAT_SDK_PACKAGE_IMPORT);
    }
  });
});
