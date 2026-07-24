import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  makeOpenCodeConversationAgent,
  type OpenCodePromptInput,
  type OpenCodeSessionClient,
  type OpenCodeSessionMessage,
} from "../src/adapters/opencode-agents.ts";
import { HandlerFailure } from "../src/prototype/errors.ts";
import type { ConversationAgentRequest } from "../src/reference-coding-application.ts";

const CREATE_FEATURE_PATTERN = /create-feature/;
const EXISTING_EXECUTION_PATTERN = /existing-execution/;
const NO_ORCHESTRATION_TOOLS_PATTERN = /Do not call todowrite/;
const DEFAULT_CONVERSATION_INSTRUCTIONS = [
  "You are the Conversation agent. Decide autonomously whether to invoke an available Action or reply to Slack.",
  "You are a routing agent, not an implementation agent. Do not call todowrite, task, skill, or other orchestration tools. Decide directly from the supplied conversation. Use repository inspection tools only when required to answer a repository question.",
  "The current OpenCode session is the durable conversation for this Slack thread. Use its prior messages, tool activity, and operation results as continuing context.",
  "Return exactly one JSON object and no markdown.",
  'Action: {"type":"action","action":"<available name>","input":<JSON>}.',
  'Execution control: {"type":"execution_control","control":"<available name>","input":<JSON>}.',
  'Reply: {"type":"reply","text":"<Slack reply>"}.',
  "Only a reply record is shown to Slack. Coding Actions and generic Execution controls are separate interfaces.",
] as const;
const DEFAULT_OPERATION_RESULT_INSTRUCTIONS = [
  "You are the Conversation agent continuing the current Slack thread after an operation result.",
  "Use the supplied conversation and operation result to describe whether the requested operation succeeded or failed.",
  "Return exactly one JSON object and no markdown.",
  'Reply: {"type":"reply","text":"<concise Slack reply describing success or failure>"}.',
  "Do not request another Action or Execution control.",
] as const;
const CONVERSATION_TOOL_POLICY = {
  apply_patch: false,
  bash: false,
  edit: false,
  skill: false,
  task: false,
  todowrite: false,
  write: false,
} as const;

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
  it.effect("accepts a single fenced JSON protocol response", () =>
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
              text: '```json\n{"type":"reply","text":"Done."}\n```',
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
    "uses default routing instructions, supplied identities, and only the final reply",
    () =>
      Effect.gen(function* () {
        const created: Array<{
          readonly sessionId: string;
          readonly workingDirectory: string;
        }> = [];
        const prompted: OpenCodePromptInput[] = [];
        const actionInputs: unknown[] = [];
        const readPromptIds: string[] = [];
        const waitedPromptIds: string[] = [];
        const messages = (
          promptId: string
        ): readonly OpenCodeSessionMessage[] => {
          if (promptId === "conversation-prompt-1") {
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
          readMessages: (input) =>
            Effect.sync(() => {
              readPromptIds.push(input.promptId);
              return messages(input.promptId);
            }),
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
        assert.match(prompted[0]?.text ?? "", NO_ORCHESTRATION_TOOLS_PATTERN);
        const initialPrompt = JSON.parse(prompted[0]?.text ?? "{}") as {
          readonly instructions?: unknown;
        };
        assert.deepStrictEqual(
          initialPrompt.instructions,
          DEFAULT_CONVERSATION_INSTRUCTIONS
        );
        assert.deepStrictEqual(prompted[0]?.tools, CONVERSATION_TOOL_POLICY);
        assert.deepStrictEqual(prompted[1]?.tools, CONVERSATION_TOOL_POLICY);
        assert.deepStrictEqual(actionInputs, [
          { prompt: "Build it", worktreeName: "build-it" },
        ]);
        assert.deepStrictEqual(waitedPromptIds, [
          "conversation-prompt-1",
          "conversation-prompt-1:action-result:1",
        ]);
        assert.deepStrictEqual(readPromptIds, waitedPromptIds);
        assert.deepStrictEqual(replies, [
          { replyId: "assistant-reply-1", text: "Work started." },
        ]);
      })
  );

  it.effect(
    "uses a defensive copy of custom routing instructions exactly",
    () =>
      Effect.gen(function* () {
        let submitted: OpenCodePromptInput | undefined;
        const instructions = ["Custom ordinary routing instruction."];
        const client: OpenCodeSessionClient = {
          createSession: () => Effect.void,
          interrupt: () => Effect.void,
          readMessages: () =>
            Effect.succeed([
              {
                id: "conversation-prompt-1",
                role: "user",
                text: submitted?.text ?? "",
              },
              {
                id: "assistant-reply",
                role: "assistant",
                text: JSON.stringify({ text: "Done.", type: "reply" }),
              },
            ]),
          sessionExists: () => Effect.succeed(false),
          submitPrompt: (input) =>
            Effect.sync(() => {
              submitted = input;
            }),
          wait: () => Effect.void,
        };
        const agent = makeOpenCodeConversationAgent({
          client,
          instructions,
          repositoryDirectory: "/repo",
        });
        instructions[0] = "Mutated ordinary instruction.";

        yield* agent.handle(request());

        const prompt = JSON.parse(submitted?.text ?? "{}") as {
          readonly instructions?: unknown;
        };
        assert.deepStrictEqual(prompt.instructions, [
          "Custom ordinary routing instruction.",
        ]);
      })
  );

  it.effect(
    "uses a defensive copy of custom operation-result instructions exactly",
    () =>
      Effect.gen(function* () {
        const prompted: OpenCodePromptInput[] = [];
        const operationResultInstructions = [
          "Custom operation-result instruction.",
        ];
        const client: OpenCodeSessionClient = {
          createSession: () => Effect.void,
          interrupt: () => Effect.void,
          readMessages: () =>
            Effect.sync(() =>
              prompted.length === 1
                ? [
                    {
                      id: "conversation-prompt-1",
                      role: "user" as const,
                      text: prompted[0]?.text ?? "",
                    },
                    {
                      id: "assistant-action",
                      role: "assistant" as const,
                      text: JSON.stringify({
                        action: "create-feature",
                        input: { prompt: "Build it", worktreeName: "build-it" },
                        type: "action",
                      }),
                    },
                  ]
                : [
                    {
                      id: "conversation-prompt-1:action-result:1",
                      role: "user" as const,
                      text: prompted[1]?.text ?? "",
                    },
                    {
                      id: "assistant-reply",
                      role: "assistant" as const,
                      text: JSON.stringify({
                        text: "Work started.",
                        type: "reply",
                      }),
                    },
                  ]
            ),
          sessionExists: () => Effect.succeed(false),
          submitPrompt: (input) =>
            Effect.sync(() => {
              prompted.push(input);
            }),
          wait: () => Effect.void,
        };
        const agent = makeOpenCodeConversationAgent({
          client,
          instructions: ["Route to the available Action."],
          operationResultInstructions,
          repositoryDirectory: "/repo",
        });
        operationResultInstructions[0] = "Mutated result instruction.";

        yield* agent.handle(
          request({
            actions: [
              {
                description: "Implement a feature.",
                invoke: () =>
                  Effect.succeed({
                    executionId: "execution-1",
                    status: "running",
                  }),
                name: "create-feature",
              },
            ],
          })
        );

        const operationResultPrompt = JSON.parse(prompted[1]?.text ?? "{}") as {
          readonly instructions?: unknown;
        };
        assert.deepStrictEqual(operationResultPrompt.instructions, [
          "Custom operation-result instruction.",
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

  it.effect(
    "recovers a shared-session Action result without submitting it twice",
    () =>
      Effect.gen(function* () {
        let actionCalls = 0;
        let submitCalls = 0;
        const client: OpenCodeSessionClient = {
          createSession: () => Effect.void,
          interrupt: () => Effect.void,
          readMessages: () =>
            Effect.succeed([
              {
                id: "conversation-prompt-1",
                role: "user",
                text: "Start work",
              },
              {
                id: "assistant-action",
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
                text: "persisted Action result",
              },
              {
                id: "assistant-result-reply",
                role: "assistant",
                text: JSON.stringify({
                  text: "Work already started.",
                  type: "reply",
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
        const replies = yield* agent.recover(
          request({
            actions: [
              {
                description: "Implement a feature.",
                invoke: () =>
                  Effect.sync(() => {
                    actionCalls += 1;
                    return { executionId: "execution-1", status: "running" };
                  }),
                name: "create-feature",
              },
            ],
          })
        );

        assert.strictEqual(actionCalls, 1);
        assert.strictEqual(submitCalls, 0);
        assert.deepStrictEqual(replies, [
          {
            replyId: "assistant-result-reply",
            text: "Work already started.",
          },
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
    "uses default operation-result instructions for Action failures",
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
          conversation: {
            context: [],
            executions: [],
            input: "Please implement it",
            messages: [],
            source: "slack",
          },
          instructions: DEFAULT_OPERATION_RESULT_INSTRUCTIONS,
          operationResult: {
            action: "create-feature",
            result: {
              error: {
                category: "protocol",
                safeDetail: "worktree name already exists",
              },
              status: "failure",
            },
            type: "action_result",
          },
        });
      })
  );
});
