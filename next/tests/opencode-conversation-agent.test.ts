import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  makeOpenCodeConversationAgent,
  type OpenCodeSessionClient,
  type OpenCodeSessionMessage,
} from "../src/adapters/opencode-agents.ts";
import { HandlerFailure } from "../src/prototype/errors.ts";
import type { ConversationAgentRequest } from "../src/reference-coding-application.ts";

const CREATE_FEATURE_PATTERN = /create-feature/;
const EXISTING_EXECUTION_PATTERN = /existing-execution/;

const request = (
  overrides: Partial<ConversationAgentRequest> = {}
): ConversationAgentRequest => ({
  actions: [],
  context: [],
  conversationId: "conversation-1",
  conversationSessionId: "conversation-session-1",
  conversationSessionIsNew: true,
  executions: [],
  executionControls: [],
  input: "Please implement it",
  messages: [],
  promptId: "conversation-prompt-1",
  source: "slack",
  turnId: "turn-1",
  ...overrides,
});

describe("OpenCode ConversationAgent", () => {
  it.effect(
    "selects the terminal nonempty protocol response after tool-only assistants",
    () =>
      Effect.gen(function* () {
        const client: OpenCodeSessionClient = {
          createSession: () => Effect.void,
          interrupt: () => Effect.void,
          readMessages: () =>
            Effect.succeed([
              { id: "conversation-prompt-1", role: "user", text: "input" },
              {
                finish: "tool-calls",
                id: "assistant-tool-1",
                role: "assistant",
                status: "completed",
                text: "",
              },
              {
                finish: "tool-calls",
                id: "assistant-tool-2",
                role: "assistant",
                status: "completed",
                text: "",
              },
              {
                finish: "stop",
                id: "assistant-terminal",
                role: "assistant",
                status: "completed",
                text: JSON.stringify({ type: "reply", text: "Done." }),
              },
            ]),
          sessionExists: () => Effect.succeed(false),
          submitPrompt: () => Effect.void,
          wait: () => Effect.void,
        };
        const agent = makeOpenCodeConversationAgent({
          client,
          repositoryDirectory: "/repo",
        });

        const replies = yield* agent.handle(request());

        assert.deepStrictEqual(replies, [
          { replyId: "assistant-terminal", text: "Done." },
        ]);
      })
  );

  it.effect("reports a terminal empty stop as no response", () =>
    Effect.gen(function* () {
      const client: OpenCodeSessionClient = {
        createSession: () => Effect.void,
        interrupt: () => Effect.void,
        readMessages: () =>
          Effect.succeed([
            { id: "conversation-prompt-1", role: "user", text: "input" },
            {
              finish: "stop",
              id: "assistant-terminal",
              role: "assistant",
              status: "completed",
              text: "",
            },
          ]),
        sessionExists: () => Effect.succeed(false),
        submitPrompt: () => Effect.void,
        wait: () => Effect.void,
      };
      const agent = makeOpenCodeConversationAgent({
        client,
        repositoryDirectory: "/repo",
      });

      const result = yield* Effect.result(agent.handle(request()));

      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.strictEqual(
          result.failure.safeDetail,
          "OpenCode Conversation produced no response"
        );
      }
    })
  );

  it.effect(
    "uses supplied identities, invokes a requested Action, and returns only the final reply",
    () =>
      Effect.gen(function* () {
        const created: Array<{
          readonly sessionId: string;
          readonly workingDirectory: string;
        }> = [];
        const prompted: Array<{
          readonly promptId: string;
          readonly sessionId: string;
          readonly text: string;
        }> = [];
        const actionInputs: unknown[] = [];
        const waitedPromptIds: string[] = [];
        const messages = (): readonly OpenCodeSessionMessage[] => {
          if (prompted.length === 1) {
            return [
              {
                id: "conversation-prompt-1",
                role: "user",
                text: prompted[0]?.text ?? "",
              },
              {
                id: "assistant-action-1",
                role: "assistant",
                text: JSON.stringify({
                  action: "create-feature",
                  input: { prompt: "Build it", worktreeName: "build-it" },
                  type: "action",
                }),
              },
            ];
          }
          return [
            {
              id: "conversation-prompt-1",
              role: "user",
              text: prompted[0]?.text ?? "",
            },
            {
              id: "assistant-action-1",
              role: "assistant",
              text: JSON.stringify({
                action: "create-feature",
                input: { prompt: "Build it", worktreeName: "build-it" },
                type: "action",
              }),
            },
            {
              id: "conversation-prompt-1:action-result:1",
              role: "user",
              text: prompted[1]?.text ?? "",
            },
            {
              id: "assistant-reply-1",
              role: "assistant",
              text: JSON.stringify({ type: "reply", text: "Work started." }),
            },
          ];
        };
        const client: OpenCodeSessionClient = {
          createSession: (input) =>
            Effect.sync(() => {
              created.push(input);
            }),
          interrupt: () => Effect.void,
          readMessages: () => Effect.sync(messages),
          sessionExists: () => Effect.succeed(false),
          submitPrompt: (input) =>
            Effect.sync(() => {
              prompted.push(input);
            }),
          wait: (input) =>
            Effect.sync(() => {
              waitedPromptIds.push(input.promptId);
            }),
        };
        const agent = makeOpenCodeConversationAgent({
          client,
          repositoryDirectory: "/repo",
        });

        const replies = yield* agent.handle(
          request({
            actions: [
              {
                description: "Implement a feature.",
                invoke: (input) =>
                  Effect.sync(() => {
                    actionInputs.push(input);
                    return { executionId: "execution-1", status: "running" };
                  }),
                name: "create-feature",
              },
            ],
            executions: [
              {
                actionName: "create-feature",
                activePromptId: null,
                conversationId: "conversation-1" as never,
                executionId: "existing-execution",
                implementationSessionId: null,
                status: "completed",
                workingDirectory: "/repo/worktree",
                worktreeName: "existing",
              },
            ],
          })
        );

        assert.deepStrictEqual(created, [
          {
            sessionId: "conversation-session-1",
            workingDirectory: "/repo",
          },
        ]);
        assert.strictEqual(prompted[0]?.sessionId, "conversation-session-1");
        assert.strictEqual(prompted[0]?.promptId, "conversation-prompt-1");
        assert.match(prompted[0]?.text ?? "", CREATE_FEATURE_PATTERN);
        assert.match(prompted[0]?.text ?? "", EXISTING_EXECUTION_PATTERN);
        assert.deepStrictEqual(actionInputs, [
          { prompt: "Build it", worktreeName: "build-it" },
        ]);
        assert.deepStrictEqual(waitedPromptIds, [
          "conversation-prompt-1",
          "conversation-prompt-1:action-result:1",
        ]);
        assert.deepStrictEqual(replies, [
          { replyId: "assistant-reply-1", text: "Work started." },
        ]);
      })
  );

  it.effect("recovers a durable prompt without resubmitting it", () =>
    Effect.gen(function* () {
      let createCalls = 0;
      let submitCalls = 0;
      const client: OpenCodeSessionClient = {
        createSession: () =>
          Effect.sync(() => {
            createCalls += 1;
          }),
        interrupt: () => Effect.void,
        readMessages: () =>
          Effect.succeed([
            {
              id: "conversation-prompt-1",
              role: "user",
              text: "durable input",
            },
            {
              id: "assistant-recovered-1",
              role: "assistant",
              text: JSON.stringify({
                type: "reply",
                text: "Recovered reply.",
              }),
            },
          ]),
        sessionExists: () => Effect.succeed(true),
        submitPrompt: () =>
          Effect.sync(() => {
            submitCalls += 1;
          }),
        wait: () => Effect.void,
      };
      const agent = makeOpenCodeConversationAgent({
        client,
        repositoryDirectory: "/repo",
      });

      assert.ok(agent.recover);
      const replies = yield* agent.recover(request());

      assert.strictEqual(createCalls, 0);
      assert.strictEqual(submitCalls, 0);
      assert.deepStrictEqual(replies, [
        { replyId: "assistant-recovered-1", text: "Recovered reply." },
      ]);
    })
  );

  it.effect("rejects oversized output with a bounded secret-safe failure", () =>
    Effect.gen(function* () {
      const secret = "sk-secret-must-not-leak";
      const client: OpenCodeSessionClient = {
        createSession: () => Effect.void,
        interrupt: () => Effect.void,
        readMessages: () =>
          Effect.succeed([
            {
              id: "conversation-prompt-1",
              role: "user",
              text: "input",
            },
            {
              id: "oversized-response",
              role: "assistant",
              text: JSON.stringify({
                type: "reply",
                text: `${secret}${"x".repeat(20_000)}`,
              }),
            },
          ]),
        sessionExists: () => Effect.succeed(false),
        submitPrompt: () => Effect.void,
        wait: () => Effect.void,
      };
      const agent = makeOpenCodeConversationAgent({
        client,
        repositoryDirectory: "/repo",
      });

      const result = yield* Effect.result(agent.handle(request()));

      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.ok((result.failure.safeDetail?.length ?? 0) < 200);
        assert.ok(!result.failure.safeDetail?.includes("sk-secret"));
      }
    })
  );

  it.effect("rejects oversized prompt input before submission", () =>
    Effect.gen(function* () {
      let submitCalls = 0;
      const client: OpenCodeSessionClient = {
        createSession: () => Effect.void,
        interrupt: () => Effect.void,
        readMessages: () => Effect.succeed([]),
        sessionExists: () => Effect.succeed(false),
        submitPrompt: () =>
          Effect.sync(() => {
            submitCalls += 1;
          }),
        wait: () => Effect.void,
      };
      const agent = makeOpenCodeConversationAgent({
        client,
        repositoryDirectory: "/repo",
      });

      const result = yield* Effect.result(
        agent.handle(request({ input: "x".repeat(100_000) }))
      );

      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual(submitCalls, 0);
    })
  );

  it.effect(
    "returns Action failures to Conversation as action-result data",
    () =>
      Effect.gen(function* () {
        const submitted: string[] = [];
        const client: OpenCodeSessionClient = {
          createSession: () => Effect.void,
          interrupt: () => Effect.void,
          readMessages: () =>
            Effect.sync(() =>
              submitted.length === 1
                ? [
                    {
                      id: "conversation-prompt-1",
                      role: "user" as const,
                      text: submitted[0] ?? "",
                    },
                    {
                      id: "assistant-collision",
                      role: "assistant" as const,
                      text: JSON.stringify({
                        action: "create-feature",
                        input: {
                          prompt: "Build it",
                          worktreeName: "collision",
                        },
                        type: "action",
                      }),
                    },
                  ]
                : [
                    {
                      id: "conversation-prompt-1",
                      role: "user" as const,
                      text: submitted[0] ?? "",
                    },
                    {
                      id: "assistant-collision",
                      role: "assistant" as const,
                      text: JSON.stringify({
                        action: "create-feature",
                        input: {
                          prompt: "Build it",
                          worktreeName: "collision",
                        },
                        type: "action",
                      }),
                    },
                    {
                      id: "conversation-prompt-1:action-result:1",
                      role: "user" as const,
                      text: submitted[1] ?? "",
                    },
                    {
                      id: "assistant-after-collision",
                      role: "assistant" as const,
                      text: JSON.stringify({
                        text: "That worktree name is already in use.",
                        type: "reply",
                      }),
                    },
                  ]
            ),
          sessionExists: () => Effect.succeed(false),
          submitPrompt: (input) =>
            Effect.sync(() => {
              submitted.push(input.text);
            }),
          wait: () => Effect.void,
        };
        const agent = makeOpenCodeConversationAgent({
          client,
          repositoryDirectory: "/repo",
        });

        const replies = yield* agent.handle(
          request({
            actions: [
              {
                description: "Implement a feature.",
                invoke: () =>
                  Effect.fail(
                    HandlerFailure.make({
                      category: "protocol",
                      safeDetail: "worktree name already exists",
                    })
                  ),
                name: "create-feature",
              },
            ],
          })
        );

        assert.deepStrictEqual(replies, [
          {
            replyId: "assistant-after-collision",
            text: "That worktree name is already in use.",
          },
        ]);
        assert.deepStrictEqual(JSON.parse(submitted[1] ?? "{}"), {
          action: "create-feature",
          result: {
            error: {
              category: "protocol",
              safeDetail: "worktree name already exists",
            },
            status: "failure",
          },
          type: "action_result",
        });
      })
  );
});
