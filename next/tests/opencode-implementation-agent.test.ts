import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import {
  makeOpenCodeImplementationAgent,
  type OpenCodePromptInput,
  type OpenCodeSessionClient,
} from "../src/adapters/opencode-agents.ts";
import { HandlerFailure } from "../src/prototype/errors.ts";

const FEATURE_WORKFLOW_PATTERN = /feature workflow/i;
const INITIAL_REQUEST_PATTERN = /Build the requested capability/;
const BUG_WORKFLOW_PATTERN = /bug workflow/i;
const FEATURE_TO_PR_SKILL_PATTERN = /\/laborer-feature-to-pr/;
const BUG_TO_PR_SKILL_PATTERN = /\/laborer-bug-to-pr/;
const NATIVE_SKILL_MECHANISM_PATTERN = /native skill mechanism/i;
const PRIOR_SESSION_HISTORY_PATTERN = /prior messages, tool activity/i;
const INSPECT_CURRENT_WORKTREE_PATTERN = /Inspect the current worktree/i;
const FOLLOW_UP_REQUEST_PATTERN = /Now add coverage/;

describe("OpenCode ImplementationAgent", () => {
  it.effect(
    "accepts a completed response before the implementation prompt becomes terminal",
    () =>
      Effect.gen(function* () {
        const promptTerminal = yield* Deferred.make<void>();
        const responseAccepted = yield* Deferred.make<void>();
        let messages: readonly {
          readonly id: string;
          readonly role: "assistant" | "user";
          readonly status?: "completed" | "error" | "in-progress";
          readonly text: string;
        }[] = [{ id: "prompt-1", role: "user", text: "Build" }];
        const client: OpenCodeSessionClient = {
          createSession: () => Effect.void,
          interrupt: () => Effect.void,
          prepareSessionForReuse: () => Effect.void,
          readMessages: () => Effect.succeed(messages),
          sessionExists: () => Effect.succeed(true),
          submitPrompt: () =>
            Effect.sync(() => {
              messages = [
                ...messages,
                {
                  id: "assistant-progress",
                  role: "assistant",
                  status: "completed",
                  text: "Implemented the first slice.",
                },
              ];
            }),
          wait: () => Deferred.await(promptTerminal),
        };
        const agent = makeOpenCodeImplementationAgent({
          client,
          observationPollIntervalMs: 1,
        });
        const session = yield* agent.start(
          {
            actionName: "create-feature",
            conversationId: "conversation-1",
            executionId: "execution-1",
            implementationSessionId: "session-1",
            prompt: "Build",
            promptId: "prompt-1",
            workingDirectory: "/repo/worktree",
          },
          (response) =>
            Effect.gen(function* () {
              assert.deepStrictEqual(response, {
                responseId: "assistant-progress",
                text: "Implemented the first slice.",
              });
              yield* Deferred.succeed(responseAccepted, undefined);
            })
        );
        const completion = yield* Effect.forkChild(session.completion, {
          startImmediately: true,
        });

        yield* Effect.yieldNow;
        assert.strictEqual(yield* Deferred.isDone(responseAccepted), true);
        assert.strictEqual(yield* Deferred.isDone(promptTerminal), false);
        yield* Deferred.succeed(promptTerminal, undefined);
        yield* Fiber.join(completion);
      })
  );

  it.effect(
    "forwards each textual response while excluding empty tool-only assistants",
    () =>
      Effect.gen(function* () {
        const accepted: Array<{
          readonly responseId: string;
          readonly text: string;
        }> = [];
        const client: OpenCodeSessionClient = {
          createSession: () => Effect.void,
          interrupt: () => Effect.void,
          prepareSessionForReuse: () => Effect.void,
          readMessages: () =>
            Effect.succeed([
              { id: "prompt-1", role: "user", text: "Build" },
              {
                finish: "tool-calls",
                id: "assistant-tool-only",
                role: "assistant",
                status: "completed",
                text: "",
              },
              {
                id: "assistant-in-progress",
                role: "assistant",
                status: "in-progress",
                text: "Mutable snapshot that must remain private.",
              },
              {
                id: "assistant-error",
                role: "assistant",
                status: "error",
                text: "Failed assistant state that must remain private.",
              },
              {
                finish: "tool-calls",
                id: "assistant-progress",
                role: "assistant",
                status: "completed",
                text: "Implemented the change.",
              },
              {
                finish: "stop",
                id: "assistant-terminal",
                role: "assistant",
                status: "completed",
                text: "Tests pass.",
              },
            ]),
          sessionExists: () => Effect.succeed(true),
          submitPrompt: () => Effect.void,
          wait: () => Effect.void,
        };
        const agent = makeOpenCodeImplementationAgent({ client });
        const session = yield* agent.start(
          {
            actionName: "create-feature",
            conversationId: "conversation-1",
            executionId: "execution-1",
            implementationSessionId: "session-1",
            prompt: "Build",
            promptId: "prompt-1",
            workingDirectory: "/repo/worktree",
          },
          (response) =>
            Effect.sync(() => {
              accepted.push(response);
            })
        );

        yield* session.completion;

        assert.deepStrictEqual(accepted, [
          {
            responseId: "assistant-progress",
            text: "Implemented the change.",
          },
          { responseId: "assistant-terminal", text: "Tests pass." },
        ]);
      })
  );

  it.effect(
    "fails closed when a completed response identity changes text",
    () =>
      Effect.gen(function* () {
        let accepted = 0;
        const client: OpenCodeSessionClient = {
          createSession: () => Effect.void,
          interrupt: () => Effect.void,
          prepareSessionForReuse: () => Effect.void,
          readMessages: () =>
            Effect.succeed([
              { id: "prompt-1", role: "user", text: "Build" },
              {
                id: "assistant-conflict",
                role: "assistant",
                status: "completed",
                text: "First immutable text.",
              },
              {
                id: "assistant-conflict",
                role: "assistant",
                status: "completed",
                text: "Conflicting immutable text.",
              },
            ]),
          sessionExists: () => Effect.succeed(true),
          submitPrompt: () => Effect.void,
          wait: () => Effect.void,
        };
        const session = yield* makeOpenCodeImplementationAgent({
          client,
        }).start(
          {
            actionName: "deal-with-bug",
            conversationId: "conversation-1",
            executionId: "execution-1",
            implementationSessionId: "session-1",
            prompt: "Fix",
            promptId: "prompt-1",
            workingDirectory: "/repo/worktree",
          },
          () =>
            Effect.sync(() => {
              accepted += 1;
            })
        );

        const outcome = yield* Effect.result(session.completion);

        assert.strictEqual(outcome._tag, "Failure");
        assert.strictEqual(accepted, 1);
        if (outcome._tag === "Failure") {
          assert.strictEqual(
            outcome.failure.safeDetail,
            "OpenCode Implementation response identity conflicts"
          );
        }
      })
  );

  it.effect("forwards responses only for the exact durable prompt", () =>
    Effect.gen(function* () {
      const accepted: string[] = [];
      const client: OpenCodeSessionClient = {
        createSession: () => Effect.void,
        interrupt: () => Effect.void,
        prepareSessionForReuse: () => Effect.void,
        readMessages: () =>
          Effect.succeed([
            { id: "prompt-1", role: "user", text: "Build" },
            {
              id: "assistant-for-prompt-1",
              role: "assistant",
              status: "completed",
              text: "First response.",
            },
            { id: "prompt-2", role: "user", text: "Later" },
            {
              id: "assistant-for-prompt-2",
              role: "assistant",
              status: "completed",
              text: "Later response.",
            },
          ]),
        sessionExists: () => Effect.succeed(true),
        submitPrompt: () => Effect.void,
        wait: () => Effect.void,
      };
      const agent = makeOpenCodeImplementationAgent({ client });
      assert.ok(agent.recover);
      const session = yield* agent.recover(
        {
          actionName: "create-feature",
          conversationId: "conversation-1",
          executionId: "execution-1",
          implementationSessionId: "session-1",
          prompt: "Build",
          promptId: "prompt-1",
          promptKind: "initial",
          workingDirectory: "/repo/worktree",
        },
        (response) =>
          Effect.sync(() => {
            accepted.push(response.responseId);
          })
      );

      yield* session.completion;

      assert.deepStrictEqual(accepted, ["assistant-for-prompt-1"]);
    })
  );

  it.effect(
    "delegates a feature Action to its PR skill and accepts each response",
    () =>
      Effect.gen(function* () {
        const created: Array<{
          readonly sessionId: string;
          readonly workingDirectory: string;
        }> = [];
        const prompted: OpenCodePromptInput[] = [];
        const accepted: Array<{
          readonly responseId: string;
          readonly text: string;
        }> = [];
        const waitedPromptIds: string[] = [];
        let reusePreparations = 0;
        const client: OpenCodeSessionClient = {
          createSession: (input) =>
            Effect.sync(() => {
              created.push(input);
            }),
          interrupt: () => Effect.void,
          prepareSessionForReuse: () =>
            Effect.sync(() => {
              reusePreparations += 1;
            }),
          readMessages: () =>
            Effect.succeed([
              { id: "implementation-prompt-1", role: "user", text: "Build" },
              {
                id: "assistant-response-1",
                role: "assistant",
                status: "completed",
                text: "Implemented the vertical slice.",
              },
              {
                id: "assistant-response-2",
                role: "assistant",
                status: "completed",
                text: "Focused tests pass.",
              },
            ]),
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
        const agent = makeOpenCodeImplementationAgent({ client });
        const session = yield* agent.start(
          {
            actionName: "create-feature",
            conversationId: "conversation-1",
            executionId: "execution-1",
            implementationSessionId: "implementation-session-1",
            prompt: "Build the requested capability",
            promptId: "implementation-prompt-1",
            workingDirectory: "/repo/worktree",
          },
          (response) =>
            Effect.sync(() => {
              accepted.push(response);
            })
        );

        assert.strictEqual(session.sessionId, "implementation-session-1");
        yield* session.completion;

        assert.deepStrictEqual(created, [
          {
            sessionId: "implementation-session-1",
            workingDirectory: "/repo/worktree",
          },
        ]);
        assert.strictEqual(reusePreparations, 0);
        assert.strictEqual(prompted[0]?.promptId, "implementation-prompt-1");
        assert.ok(!(prompted[0] && "tools" in prompted[0]));
        assert.match(prompted[0]?.text ?? "", FEATURE_WORKFLOW_PATTERN);
        assert.match(prompted[0]?.text ?? "", FEATURE_TO_PR_SKILL_PATTERN);
        assert.match(prompted[0]?.text ?? "", NATIVE_SKILL_MECHANISM_PATTERN);
        assert.match(prompted[0]?.text ?? "", INITIAL_REQUEST_PATTERN);
        assert.deepStrictEqual(waitedPromptIds, ["implementation-prompt-1"]);
        assert.deepStrictEqual(accepted, [
          {
            responseId: "assistant-response-1",
            text: "Implemented the vertical slice.",
          },
          {
            responseId: "assistant-response-2",
            text: "Focused tests pass.",
          },
        ]);
      })
  );

  it.effect("delegates a bug Action to its PR skill and resumes it", () =>
    Effect.gen(function* () {
      const prompted: Array<{
        readonly promptId: string;
        readonly sessionId: string;
        readonly text: string;
      }> = [];
      const accepted: string[] = [];
      const interruptedPromptIds: string[] = [];
      const readPromptIds: string[] = [];
      const client: OpenCodeSessionClient = {
        createSession: () => Effect.void,
        interrupt: (input) =>
          Effect.sync(() => {
            interruptedPromptIds.push(input.promptId);
          }),
        prepareSessionForReuse: () => Effect.void,
        readMessages: (input) => {
          readPromptIds.push(input.promptId);
          const latest = prompted.at(-1);
          return Effect.succeed(
            latest === undefined
              ? []
              : [
                  {
                    id: latest.promptId,
                    role: "user" as const,
                    text: latest.text,
                  },
                  {
                    id: `response:${latest.promptId}`,
                    role: "assistant" as const,
                    status: "completed" as const,
                    text: `answer:${latest.promptId}`,
                  },
                ]
          );
        },
        sessionExists: () => Effect.succeed(true),
        submitPrompt: (input) =>
          Effect.sync(() => {
            prompted.push(input);
          }),
        wait: () => Effect.void,
      };
      const agent = makeOpenCodeImplementationAgent({ client });
      const session = yield* agent.start(
        {
          actionName: "deal-with-bug",
          conversationId: "conversation-1",
          executionId: "execution-1",
          implementationSessionId: "implementation-session-1",
          prompt: "Fix it",
          promptId: "implementation-prompt-1",
          workingDirectory: "/repo/worktree",
        },
        (response) =>
          Effect.sync(() => {
            accepted.push(response.responseId);
          })
      );
      yield* session.completion;
      yield* session.resume(
        {
          conversationId: "conversation-1" as never,
          executionId: "execution-1",
          implementationSessionId: "implementation-session-1",
          prompt: "Now add coverage",
          promptId: "implementation-prompt-2",
          workingDirectory: "/repo/worktree",
        },
        (response) =>
          Effect.sync(() => {
            accepted.push(response.responseId);
          })
      );
      assert.ok(session.control);
      yield* session.control({
        control: "cancel",
        conversationId: "conversation-1" as never,
        executionId: "execution-1",
        implementationSessionId: "implementation-session-1",
        workingDirectory: "/repo/worktree",
      });

      assert.deepStrictEqual(
        prompted.map(({ promptId, sessionId }) => ({ promptId, sessionId })),
        [
          {
            promptId: "implementation-prompt-1",
            sessionId: "implementation-session-1",
          },
          {
            promptId: "implementation-prompt-2",
            sessionId: "implementation-session-1",
          },
        ]
      );
      assert.match(prompted[0]?.text ?? "", BUG_WORKFLOW_PATTERN);
      assert.match(prompted[0]?.text ?? "", BUG_TO_PR_SKILL_PATTERN);
      assert.match(prompted[0]?.text ?? "", NATIVE_SKILL_MECHANISM_PATTERN);
      assert.match(prompted[1]?.text ?? "", PRIOR_SESSION_HISTORY_PATTERN);
      assert.match(prompted[1]?.text ?? "", INSPECT_CURRENT_WORKTREE_PATTERN);
      assert.match(prompted[1]?.text ?? "", FOLLOW_UP_REQUEST_PATTERN);
      assert.deepStrictEqual(readPromptIds, [
        "implementation-prompt-1",
        "implementation-prompt-1",
        "implementation-prompt-2",
        "implementation-prompt-2",
      ]);
      assert.deepStrictEqual(interruptedPromptIds, ["implementation-prompt-2"]);
      assert.deepStrictEqual(accepted, [
        "response:implementation-prompt-1",
        "response:implementation-prompt-2",
      ]);
    })
  );

  it.effect(
    "recovers the supplied durable prompt through idempotent submission",
    () =>
      Effect.gen(function* () {
        let submitCalls = 0;
        const accepted: string[] = [];
        const client: OpenCodeSessionClient = {
          createSession: () => Effect.void,
          interrupt: () => Effect.void,
          prepareSessionForReuse: () => Effect.void,
          readMessages: () =>
            Effect.succeed([
              { id: "implementation-prompt-1", role: "user", text: "Fix it" },
              {
                id: "recovered-response-1",
                role: "assistant",
                status: "completed",
                text: "Recovered durable output.",
              },
            ]),
          sessionExists: () => Effect.succeed(true),
          submitPrompt: () =>
            Effect.sync(() => {
              submitCalls += 1;
            }),
          wait: () => Effect.void,
        };
        const agent = makeOpenCodeImplementationAgent({ client });

        assert.ok(agent.recover);
        const session = yield* agent.recover(
          {
            actionName: "deal-with-bug",
            conversationId: "conversation-1",
            executionId: "execution-1",
            implementationSessionId: "implementation-session-1",
            prompt: "Fix it",
            promptId: "implementation-prompt-1",
            promptKind: "initial",
            workingDirectory: "/repo/worktree",
          },
          (response) =>
            Effect.sync(() => {
              accepted.push(response.responseId);
            })
        );
        yield* session.completion;

        assert.strictEqual(session.sessionId, "implementation-session-1");
        assert.strictEqual(submitCalls, 1);
        assert.deepStrictEqual(accepted, ["recovered-response-1"]);
      })
  );

  it.effect("cancels by interrupting the supplied session", () =>
    Effect.gen(function* () {
      const interrupted: Array<{
        readonly promptId: string;
        readonly sessionId: string;
        readonly workingDirectory: string;
      }> = [];
      const client: OpenCodeSessionClient = {
        createSession: () => Effect.void,
        interrupt: (input) =>
          Effect.sync(() => {
            interrupted.push(input);
          }),
        prepareSessionForReuse: () => Effect.void,
        readMessages: () => Effect.succeed([]),
        sessionExists: () => Effect.succeed(true),
        submitPrompt: () => Effect.void,
        wait: () => Effect.void,
      };
      const agent = makeOpenCodeImplementationAgent({ client });
      const session = yield* agent.start(
        {
          actionName: "create-feature",
          conversationId: "conversation-1",
          executionId: "execution-1",
          implementationSessionId: "implementation-session-1",
          prompt: "Build it",
          promptId: "implementation-prompt-1",
          workingDirectory: "/repo/worktree",
        },
        () => Effect.void
      );

      assert.ok(session.control);
      yield* session.control({
        control: "cancel",
        conversationId: "conversation-1" as never,
        executionId: "execution-1",
        implementationSessionId: "implementation-session-1",
        workingDirectory: "/repo/worktree",
      });

      assert.deepStrictEqual(interrupted, [
        {
          promptId: "implementation-prompt-1",
          sessionId: "implementation-session-1",
          workingDirectory: "/repo/worktree",
        },
      ]);
    })
  );

  it.effect("bounds implementation responses before acceptance", () =>
    Effect.gen(function* () {
      let accepted = 0;
      const client: OpenCodeSessionClient = {
        createSession: () => Effect.void,
        interrupt: () => Effect.void,
        prepareSessionForReuse: () => Effect.void,
        readMessages: () =>
          Effect.succeed([
            { id: "prompt-1", role: "user", text: "Build" },
            {
              id: "oversized-response",
              role: "assistant",
              status: "completed",
              text: "x".repeat(20_000),
            },
          ]),
        sessionExists: () => Effect.succeed(true),
        submitPrompt: () => Effect.void,
        wait: () => Effect.void,
      };
      const agent = makeOpenCodeImplementationAgent({ client });
      const session = yield* agent.start(
        {
          actionName: "create-feature",
          conversationId: "conversation-1",
          executionId: "execution-1",
          implementationSessionId: "session-1",
          prompt: "Build",
          promptId: "prompt-1",
          workingDirectory: "/repo/worktree",
        },
        () =>
          Effect.sync(() => {
            accepted += 1;
          })
      );

      const result = yield* Effect.result(session.completion);

      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual(accepted, 0);
    })
  );

  it.effect(
    "never creates a missing implementation session during recovery",
    () =>
      Effect.gen(function* () {
        let creates = 0;
        let submissions = 0;
        const client: OpenCodeSessionClient = {
          createSession: () =>
            Effect.sync(() => {
              creates += 1;
            }),
          interrupt: () => Effect.void,
          prepareSessionForReuse: () => Effect.void,
          readMessages: () => Effect.succeed([]),
          sessionExists: () => Effect.succeed(false),
          submitPrompt: () =>
            Effect.sync(() => {
              submissions += 1;
            }),
          wait: () => Effect.void,
        };
        const agent = makeOpenCodeImplementationAgent({ client });
        const request = {
          actionName: "create-feature" as const,
          conversationId: "conversation-missing",
          executionId: "execution-missing",
          implementationSessionId: "session-missing",
          prompt: "Persisted prompt",
          promptId: "prompt-missing",
          promptKind: "initial" as const,
          workingDirectory: "/repo/worktree",
        };
        assert.ok(agent.inspect);
        assert.deepStrictEqual(
          yield* agent.inspect({ ...request, creationState: "confirmed" }),
          {
            certainty: "definitive",
            evidence: "definitively-absent",
            status: "missing",
          }
        );
        assert.deepStrictEqual(
          yield* agent.inspect({ ...request, creationState: "unknown" }),
          {
            certainty: "unknown",
            evidence: "inspection-unavailable",
            status: "ambiguous",
          }
        );
        assert.ok(agent.recover);
        const recovery = yield* Effect.result(
          agent.recover(request, () => Effect.void)
        );
        assert.strictEqual(recovery._tag, "Failure");
        assert.strictEqual(creates, 0);
        assert.strictEqual(submissions, 0);
      })
  );

  it.effect(
    "fails closed before prompt submission when legacy permission cleanup fails",
    () =>
      Effect.gen(function* () {
        let submissions = 0;
        const client: OpenCodeSessionClient = {
          createSession: () => Effect.void,
          interrupt: () => Effect.void,
          prepareSessionForReuse: () =>
            HandlerFailure.make({
              category: "exit",
              safeDetail: "OpenCode legacy permission cleanup failed",
            }),
          readMessages: () => Effect.succeed([]),
          sessionExists: () => Effect.succeed(true),
          submitPrompt: () =>
            Effect.sync(() => {
              submissions += 1;
            }),
          wait: () => Effect.void,
        };
        const agent = makeOpenCodeImplementationAgent({ client });
        assert.ok(agent.recover);

        const recovered = yield* Effect.result(
          agent.recover(
            {
              actionName: "create-feature",
              conversationId: "conversation-cleanup-failure",
              executionId: "execution-cleanup-failure",
              implementationSessionId: "session-cleanup-failure",
              prompt: "Do not duplicate this prompt",
              promptId: "prompt-cleanup-failure",
              promptKind: "initial",
              workingDirectory: "/repo/worktree",
            },
            () => Effect.void
          )
        );

        assert.strictEqual(recovered._tag, "Failure");
        assert.strictEqual(submissions, 0);
      })
  );
});
