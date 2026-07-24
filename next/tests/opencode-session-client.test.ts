import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  makeOpenCodeSessionClientFromV2Api,
  type OpenCodeV2SessionApi,
} from "../src/adapters/opencode-agents.ts";

describe("OpenCode v2 session client", () => {
  it.effect(
    "polls the exact prompt to terminal completion when native wait is unavailable",
    () =>
      Effect.gen(function* () {
        let messageReads = 0;
        const api: OpenCodeV2SessionApi = {
          create: (input) => Promise.resolve({ id: input.id }),
          get: (input) =>
            Promise.resolve({
              id: input.sessionId,
              workingDirectory: "/repo/worktree",
            }),
          interrupt: () => Promise.resolve(),
          messages: () => {
            messageReads += 1;
            if (messageReads === 1) {
              return Promise.resolve([
                {
                  id: "stale-assistant",
                  role: "assistant" as const,
                  status: "completed" as const,
                  text: "stale output",
                },
              ]);
            }
            if (messageReads === 2) {
              return Promise.resolve([
                {
                  id: "pending-assistant",
                  role: "assistant" as const,
                  status: "in-progress" as const,
                  text: "partial output",
                },
                { id: "prompt-1", role: "user" as const, text: "input" },
                {
                  id: "stale-assistant",
                  role: "assistant" as const,
                  status: "completed" as const,
                  text: "stale output",
                },
              ]);
            }
            return Promise.resolve([
              {
                id: "completed-assistant",
                role: "assistant" as const,
                status: "completed" as const,
                text: "fresh output",
              },
              { id: "prompt-1", role: "user" as const, text: "input" },
              {
                id: "stale-assistant",
                role: "assistant" as const,
                status: "completed" as const,
                text: "stale output",
              },
            ]);
          },
          prompt: (input) => Promise.resolve({ id: input.promptId }),
          wait: () =>
            Promise.reject(
              new Error("Session wait is not available yet", {
                cause: {
                  body: {
                    _tag: "ServiceUnavailableError",
                    message: "Session wait is not available yet",
                    service: "session.wait",
                  },
                  status: 503,
                },
              })
            ),
        };
        const client = makeOpenCodeSessionClientFromV2Api(api, {
          waitPollIntervalMs: 0,
          waitPollMaxAttempts: 3,
        });

        yield* client.wait({
          promptId: "prompt-1",
          sessionId: "session-1",
          workingDirectory: "/repo/worktree",
        });

        assert.strictEqual(messageReads, 3);
      })
  );

  it.effect("fails when the assistant response terminates with an error", () =>
    Effect.gen(function* () {
      const api: OpenCodeV2SessionApi = {
        create: (input) => Promise.resolve({ id: input.id }),
        get: (input) =>
          Promise.resolve({
            id: input.sessionId,
            workingDirectory: "/repo/worktree",
          }),
        interrupt: () => Promise.resolve(),
        messages: () =>
          Promise.resolve([
            {
              id: "failed-assistant",
              role: "assistant" as const,
              status: "error" as const,
              text: "provider detail",
            },
            { id: "prompt-1", role: "user" as const, text: "input" },
          ]),
        prompt: (input) => Promise.resolve({ id: input.promptId }),
        wait: () => Promise.resolve(),
      };
      const client = makeOpenCodeSessionClientFromV2Api(api);

      const result = yield* Effect.result(
        client.wait({
          promptId: "prompt-1",
          sessionId: "session-1",
          workingDirectory: "/repo/worktree",
        })
      );

      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.strictEqual(
          result.failure.safeDetail,
          "OpenCode assistant response failed"
        );
        assert.ok(!result.failure.safeDetail?.includes("provider detail"));
      }
    })
  );

  it.effect("fails distinctly when the admitted prompt never completes", () =>
    Effect.gen(function* () {
      let messageReads = 0;
      const api: OpenCodeV2SessionApi = {
        create: (input) => Promise.resolve({ id: input.id }),
        get: (input) =>
          Promise.resolve({
            id: input.sessionId,
            workingDirectory: "/repo/worktree",
          }),
        interrupt: () => Promise.resolve(),
        messages: () => {
          messageReads += 1;
          return Promise.resolve([
            {
              id: "pending-assistant",
              role: "assistant" as const,
              status: "in-progress" as const,
              text: "partial",
            },
            { id: "prompt-1", role: "user" as const, text: "input" },
          ]);
        },
        prompt: (input) => Promise.resolve({ id: input.promptId }),
        wait: () =>
          Promise.reject({
            _tag: "ServiceUnavailableError",
            message: "Session wait is not available yet",
            service: "session.wait",
          }),
      };
      const client = makeOpenCodeSessionClientFromV2Api(api, {
        waitPollIntervalMs: 0,
        waitPollMaxAttempts: 2,
      });

      const result = yield* Effect.result(
        client.wait({
          promptId: "prompt-1",
          sessionId: "session-1",
          workingDirectory: "/repo/worktree",
        })
      );

      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual(messageReads, 2);
      if (result._tag === "Failure") {
        assert.strictEqual(
          result.failure.safeDetail,
          "OpenCode prompt response timed out"
        );
      }
    })
  );

  it.effect("fails when the exact prompt never appears", () =>
    Effect.gen(function* () {
      let messageReads = 0;
      const api: OpenCodeV2SessionApi = {
        create: (input) => Promise.resolve({ id: input.id }),
        get: (input) =>
          Promise.resolve({
            id: input.sessionId,
            workingDirectory: "/repo/worktree",
          }),
        interrupt: () => Promise.resolve(),
        messages: () => {
          messageReads += 1;
          return Promise.resolve([
            {
              id: "stale-assistant",
              role: "assistant" as const,
              status: "completed" as const,
              text: "stale output",
            },
          ]);
        },
        prompt: (input) => Promise.resolve({ id: input.promptId }),
        wait: () =>
          Promise.reject({
            _tag: "ServiceUnavailableError",
            message: "Session wait is not available yet",
            service: "session.wait",
          }),
      };
      const client = makeOpenCodeSessionClientFromV2Api(api, {
        waitPollIntervalMs: 0,
        waitPollMaxAttempts: 2,
      });

      const result = yield* Effect.result(
        client.wait({
          promptId: "prompt-1",
          sessionId: "session-1",
          workingDirectory: "/repo/worktree",
        })
      );

      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual(messageReads, 2);
      if (result._tag === "Failure") {
        assert.strictEqual(
          result.failure.safeDetail,
          "OpenCode prompt is unavailable"
        );
      }
    })
  );

  it.effect("does not poll for unrelated native wait failures", () =>
    Effect.gen(function* () {
      let messageReads = 0;
      const api: OpenCodeV2SessionApi = {
        create: (input) => Promise.resolve({ id: input.id }),
        get: (input) =>
          Promise.resolve({
            id: input.sessionId,
            workingDirectory: "/repo/worktree",
          }),
        interrupt: () => Promise.resolve(),
        messages: () => {
          messageReads += 1;
          return Promise.resolve([]);
        },
        prompt: (input) => Promise.resolve({ id: input.promptId }),
        wait: () =>
          Promise.reject({
            _tag: "ServiceUnavailableError",
            message: "Another service is unavailable",
            service: "provider",
          }),
      };
      const client = makeOpenCodeSessionClientFromV2Api(api);

      const result = yield* Effect.result(
        client.wait({
          promptId: "prompt-1",
          sessionId: "session-1",
          workingDirectory: "/repo/worktree",
        })
      );

      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual(messageReads, 0);
      if (result._tag === "Failure") {
        assert.strictEqual(result.failure.category, "exit");
        assert.strictEqual(
          result.failure.safeDetail,
          "OpenCode session wait failed"
        );
      }
    })
  );

  it.effect("maps caller identities to durable v2 session operations", () =>
    Effect.gen(function* () {
      const calls: Array<readonly [string, unknown]> = [];
      const api: OpenCodeV2SessionApi = {
        create: (input) => {
          calls.push(["create", input]);
          return Promise.resolve({ id: input.id });
        },
        get: (input) => {
          calls.push(["get", input]);
          return Promise.resolve({
            id: input.sessionId,
            workingDirectory: "/repo/worktree",
          });
        },
        interrupt: (input) => {
          calls.push(["interrupt", input]);
          return Promise.resolve();
        },
        messages: (input) => {
          calls.push(["messages", input]);
          return Promise.resolve([
            {
              id: "response-1",
              role: "assistant",
              status: "completed",
              text: "output",
            },
            { id: "prompt-1", role: "user", text: "input" },
          ] as const);
        },
        prompt: (input) => {
          calls.push(["prompt", input]);
          return Promise.resolve({ id: input.promptId });
        },
        wait: (input) => {
          calls.push(["wait", input]);
          return Promise.resolve();
        },
      };
      const client = makeOpenCodeSessionClientFromV2Api(api, {
        agent: "laborer",
      });
      const identity = {
        sessionId: "session-1",
        workingDirectory: "/repo/worktree",
      };

      assert.strictEqual(yield* client.sessionExists(identity), true);
      yield* client.createSession(identity);
      yield* client.submitPrompt({
        ...identity,
        promptId: "prompt-1",
        text: "input",
      });
      yield* client.wait({ ...identity, promptId: "prompt-1" });
      assert.deepStrictEqual(yield* client.readMessages(identity), [
        { id: "prompt-1", role: "user", text: "input" },
        {
          id: "response-1",
          role: "assistant",
          status: "completed",
          text: "output",
        },
      ]);
      yield* client.interrupt(identity);

      assert.deepStrictEqual(calls, [
        ["get", { sessionId: "session-1" }],
        [
          "create",
          {
            agent: "laborer",
            id: "session-1",
            workingDirectory: "/repo/worktree",
          },
        ],
        [
          "prompt",
          { promptId: "prompt-1", sessionId: "session-1", text: "input" },
        ],
        ["wait", { sessionId: "session-1" }],
        ["messages", { limit: 256, order: "desc", sessionId: "session-1" }],
        ["messages", { limit: 256, order: "desc", sessionId: "session-1" }],
        ["interrupt", { sessionId: "session-1" }],
      ]);
    })
  );
});
