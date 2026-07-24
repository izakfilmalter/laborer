import { createHash } from "node:crypto";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  makeOpenCodeLegacySessionTransport,
  makeOpenCodeSessionClientFromV2Api,
  type OpenCodeLegacySessionApi,
  type OpenCodeV2SessionApi,
} from "../src/adapters/opencode-agents.ts";

const OPENCODE_MAX_SESSION_MESSAGES = 200;

describe("OpenCode legacy session transport", () => {
  it("projects legacy messages into descending transport order", async () => {
    const calls: unknown[] = [];
    const api: OpenCodeLegacySessionApi = {
      messages: (input, requestOptions) => {
        calls.push([input, requestOptions]);
        return Promise.resolve({
          data: [
            {
              info: { id: "prompt-1", role: "user", time: { created: 1 } },
              parts: [{ text: "input", type: "text" }],
            },
            {
              info: {
                finish: "tool-calls",
                id: "assistant-tool-only",
                role: "assistant",
                time: { completed: 2 },
              },
              parts: [{ type: "tool" }],
            },
            {
              info: {
                finish: "stop",
                id: "assistant-terminal",
                role: "assistant",
                time: { completed: 3 },
              },
              parts: [
                { text: "final", type: "text" },
                { type: "tool" },
                { text: "response", type: "text" },
              ],
            },
          ],
        });
      },
      prompt: () => Promise.resolve(),
    };
    const transport = makeOpenCodeLegacySessionTransport(api);

    const messages = await transport.messages({
      limit: OPENCODE_MAX_SESSION_MESSAGES,
      order: "desc",
      sessionId: "session-1",
      workingDirectory: "/repo/worktree",
    });

    assert.deepStrictEqual(messages, [
      {
        finish: "stop",
        id: "assistant-terminal",
        role: "assistant",
        status: "completed",
        text: "final\nresponse",
      },
      {
        finish: "tool-calls",
        id: "assistant-tool-only",
        role: "assistant",
        status: "completed",
        text: "",
      },
      { id: "prompt-1", role: "user", text: "input" },
    ]);
    assert.deepStrictEqual(calls, [
      [
        {
          directory: "/repo/worktree",
          limit: OPENCODE_MAX_SESSION_MESSAGES,
          sessionID: "session-1",
        },
        { throwOnError: true },
      ],
    ]);
  });

  it("projects legacy assistant failures and in-progress responses", async () => {
    const api: OpenCodeLegacySessionApi = {
      messages: () =>
        Promise.resolve({
          data: [
            {
              info: { id: "prompt-1", role: "user", time: { created: 1 } },
              parts: [{ text: "input", type: "text" }],
            },
            {
              info: {
                id: "assistant-progress",
                role: "assistant",
                time: { created: 2 },
              },
              parts: [{ text: "partial", type: "text" }],
            },
            {
              info: {
                error: { name: "ProviderAuthError" },
                id: "assistant-error",
                role: "assistant",
                time: { completed: 3 },
              },
              parts: [],
            },
          ],
        }),
      prompt: () => Promise.resolve(),
    };
    const transport = makeOpenCodeLegacySessionTransport(api);

    const messages = await transport.messages({
      limit: OPENCODE_MAX_SESSION_MESSAGES,
      order: "desc",
      sessionId: "session-1",
      workingDirectory: "/repo/worktree",
    });

    assert.deepStrictEqual(messages, [
      {
        id: "assistant-error",
        role: "assistant",
        status: "error",
        text: "",
      },
      {
        id: "assistant-progress",
        role: "assistant",
        status: "in-progress",
        text: "partial",
      },
      { id: "prompt-1", role: "user", text: "input" },
    ]);
  });

  it("returns after the exact synchronous prompt completes without querying status", async () => {
    const calls: unknown[] = [];
    let resolvePrompt = (): void => {
      throw new Error("Prompt resolver was not initialized");
    };
    const promptCompletion = new Promise<void>((resolve) => {
      resolvePrompt = resolve;
    });
    const api: OpenCodeLegacySessionApi = {
      messages: () => Promise.resolve({ data: [] }),
      prompt: (input, requestOptions) => {
        calls.push(["prompt", input, requestOptions]);
        return promptCompletion;
      },
    };
    const transport = makeOpenCodeLegacySessionTransport(api);

    const admittedPromise = transport.prompt({
      agent: "laborer",
      model: { modelID: "gpt-5.6-sol", providerID: "openai" },
      promptId: "prompt-1",
      sessionId: "session-1",
      text: "input",
      workingDirectory: "/repo/worktree",
    });
    const beforePromptCompletion = await Promise.race([
      admittedPromise.then(() => "prompt" as const),
      Promise.resolve("pending" as const),
    ]);

    assert.strictEqual(beforePromptCompletion, "pending");
    resolvePrompt();
    const admitted = await admittedPromise;

    assert.deepStrictEqual(admitted, { id: "prompt-1" });
    assert.deepStrictEqual(calls, [
      [
        "prompt",
        {
          agent: "laborer",
          directory: "/repo/worktree",
          messageID: "prompt-1",
          model: { modelID: "gpt-5.6-sol", providerID: "openai" },
          parts: [{ text: "input", type: "text" }],
          sessionID: "session-1",
        },
        { throwOnError: true },
      ],
    ]);
  });
});

describe("OpenCode v2 session client", () => {
  it.effect("isolates durable prompts in deterministic physical sessions", () =>
    Effect.gen(function* () {
      const calls: Array<readonly [string, unknown]> = [];
      const sessions = new Map<string, string>();
      const messages = new Map<
        string,
        readonly {
          readonly finish?: string;
          readonly id: string;
          readonly role: "assistant" | "user";
          readonly status?: "completed" | "error" | "in-progress";
          readonly text: string;
        }[]
      >();
      const physicalId = (promptId: string): string =>
        `ses_${createHash("sha256")
          .update(JSON.stringify(["logical-session", promptId]))
          .digest("hex")}`;
      const api: OpenCodeV2SessionApi = {
        create: (input) => {
          calls.push(["create", input]);
          sessions.set(input.id, input.workingDirectory);
          return Promise.resolve({ id: input.id });
        },
        get: (input) => {
          calls.push(["get", input]);
          const workingDirectory = sessions.get(input.sessionId);
          return workingDirectory === undefined
            ? Promise.reject({ _tag: "SessionNotFoundError" })
            : Promise.resolve({ id: input.sessionId, workingDirectory });
        },
        interrupt: (input) => {
          calls.push(["interrupt", input]);
          return Promise.resolve();
        },
        messages: (input) => {
          calls.push(["messages", input]);
          return Promise.resolve(messages.get(input.sessionId) ?? []);
        },
        prompt: (input) => {
          calls.push(["prompt", input]);
          messages.set(input.sessionId, [
            {
              finish: "stop",
              id: `response:${input.promptId}`,
              role: "assistant",
              status: "completed",
              text: "done",
            },
            { id: input.promptId, role: "user", text: input.text },
          ]);
          return Promise.resolve({ id: input.promptId });
        },
        wait: (input) => {
          calls.push(["wait", input]);
          return Promise.resolve();
        },
      };
      const client = makeOpenCodeSessionClientFromV2Api(api, {
        agent: "laborer",
        model: { modelID: "gpt-5.6-sol", providerID: "openai" },
        promptIsolation: true,
      });
      const promptIdentity = {
        promptId: "prompt-1",
        sessionId: "logical-session",
        workingDirectory: "/repo/worktree",
      };
      const expectedPhysicalId = physicalId("prompt-1");

      assert.strictEqual(
        yield* client.sessionExists({
          sessionId: "logical-session",
          workingDirectory: "/repo/worktree",
        }),
        false
      );
      yield* client.createSession({
        sessionId: "logical-session",
        workingDirectory: "/repo/worktree",
      });
      yield* client.submitPrompt({ ...promptIdentity, text: "input" });
      yield* client.wait(promptIdentity);
      assert.deepStrictEqual(yield* client.readMessages(promptIdentity), [
        { id: "prompt-1", role: "user", text: "input" },
        {
          finish: "stop",
          id: "response:prompt-1",
          role: "assistant",
          status: "completed",
          text: "done",
        },
      ]);
      yield* client.interrupt(promptIdentity);
      yield* client.submitPrompt({ ...promptIdentity, text: "input" });

      assert.deepStrictEqual(
        calls.filter(([operation]) => operation === "create"),
        [
          [
            "create",
            {
              agent: "laborer",
              id: "logical-session",
              model: { modelID: "gpt-5.6-sol", providerID: "openai" },
              workingDirectory: "/repo/worktree",
            },
          ],
          [
            "create",
            {
              agent: "laborer",
              id: expectedPhysicalId,
              model: { modelID: "gpt-5.6-sol", providerID: "openai" },
              workingDirectory: "/repo/worktree",
            },
          ],
        ]
      );
      assert.deepStrictEqual(
        calls.filter(([operation]) => operation === "prompt"),
        [
          [
            "prompt",
            {
              agent: "laborer",
              model: { modelID: "gpt-5.6-sol", providerID: "openai" },
              promptId: "prompt-1",
              sessionId: expectedPhysicalId,
              text: "input",
              workingDirectory: "/repo/worktree",
            },
          ],
        ]
      );
      assert.ok(
        calls
          .filter(([operation]) =>
            ["messages", "wait", "interrupt"].includes(operation)
          )
          .every(([, input]) =>
            JSON.stringify(input).includes(expectedPhysicalId)
          )
      );

      const conflictingPromptId = "prompt-conflict";
      sessions.set(physicalId(conflictingPromptId), "/wrong/worktree");
      const conflict = yield* Effect.result(
        client.submitPrompt({
          promptId: conflictingPromptId,
          sessionId: "logical-session",
          text: "must not run",
          workingDirectory: "/repo/worktree",
        })
      );
      assert.strictEqual(conflict._tag, "Failure");
      if (conflict._tag === "Failure") {
        assert.strictEqual(
          conflict.failure.safeDetail,
          "OpenCode session identity conflicts"
        );
      }
      assert.ok(
        !calls.some(
          ([operation, input]) =>
            operation === "prompt" &&
            JSON.stringify(input).includes(conflictingPromptId)
        )
      );
      assert.deepStrictEqual(
        calls.filter(([operation]) => operation === "get"),
        [
          ["get", { sessionId: "logical-session" }],
          ["get", { sessionId: expectedPhysicalId }],
          ["get", { sessionId: expectedPhysicalId }],
          ["get", { sessionId: expectedPhysicalId }],
          ["get", { sessionId: physicalId(conflictingPromptId) }],
        ]
      );
    })
  );

  it.effect(
    "does not complete the exact prompt on completed tool-call assistants",
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
            const responses = [
              {
                finish: "tool-calls",
                id: "tool-call-assistant",
                role: "assistant" as const,
                status: "completed" as const,
                text: "",
              },
            ];
            if (messageReads > 1) {
              responses.unshift({
                finish: "stop",
                id: "terminal-assistant",
                role: "assistant" as const,
                status: "completed" as const,
                text: "final response",
              });
            }
            return Promise.resolve([
              ...responses,
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

        yield* client.wait({
          promptId: "prompt-1",
          sessionId: "session-1",
          workingDirectory: "/repo/worktree",
        });

        assert.strictEqual(messageReads, 2);
      })
  );

  it.effect("does not use a later prompt's terminal assistant", () =>
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
              finish: "stop",
              id: "later-terminal-assistant",
              role: "assistant" as const,
              status: "completed" as const,
              text: "later response",
            },
            { id: "prompt-2", role: "user" as const, text: "later input" },
            {
              finish: "tool-calls",
              id: "tool-call-assistant",
              role: "assistant" as const,
              status: "completed" as const,
              text: "",
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
          "OpenCode prompt response did not complete"
        );
      }
    })
  );

  it.effect(
    "does not treat a completed timestamp without finish as terminal",
    () =>
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
                id: "intermediate-assistant",
                role: "assistant" as const,
                status: "completed" as const,
                text: "intermediate",
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
            "OpenCode prompt response did not complete"
          );
        }
      })
  );

  it.effect(
    "polls the exact prompt to terminal completion when native wait is unavailable",
    () =>
      Effect.gen(function* () {
        let messageReads = 0;
        const messageReadLimits: number[] = [];
        const api: OpenCodeV2SessionApi = {
          create: (input) => Promise.resolve({ id: input.id }),
          get: (input) =>
            Promise.resolve({
              id: input.sessionId,
              workingDirectory: "/repo/worktree",
            }),
          interrupt: () => Promise.resolve(),
          messages: (input) => {
            messageReads += 1;
            messageReadLimits.push(input.limit);
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
                finish: "stop",
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
        assert.ok(
          messageReadLimits.every(
            (limit) => limit <= OPENCODE_MAX_SESSION_MESSAGES
          ),
          `all message reads must use a limit at most ${OPENCODE_MAX_SESSION_MESSAGES}`
        );
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
              finish: "stop",
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
        model: { modelID: "gpt-5.6-sol", providerID: "openai" },
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
      assert.deepStrictEqual(
        yield* client.readMessages({ ...identity, promptId: "prompt-1" }),
        [
          { id: "prompt-1", role: "user", text: "input" },
          {
            finish: "stop",
            id: "response-1",
            role: "assistant",
            status: "completed",
            text: "output",
          },
        ]
      );
      yield* client.interrupt({ ...identity, promptId: "prompt-1" });

      assert.deepStrictEqual(calls, [
        ["get", { sessionId: "session-1" }],
        [
          "create",
          {
            agent: "laborer",
            id: "session-1",
            model: { modelID: "gpt-5.6-sol", providerID: "openai" },
            workingDirectory: "/repo/worktree",
          },
        ],
        [
          "prompt",
          {
            agent: "laborer",
            model: { modelID: "gpt-5.6-sol", providerID: "openai" },
            promptId: "prompt-1",
            sessionId: "session-1",
            text: "input",
            workingDirectory: "/repo/worktree",
          },
        ],
        ["wait", { sessionId: "session-1" }],
        [
          "messages",
          {
            limit: OPENCODE_MAX_SESSION_MESSAGES,
            order: "desc",
            sessionId: "session-1",
            workingDirectory: "/repo/worktree",
          },
        ],
        [
          "messages",
          {
            limit: OPENCODE_MAX_SESSION_MESSAGES,
            order: "desc",
            sessionId: "session-1",
            workingDirectory: "/repo/worktree",
          },
        ],
        ["interrupt", { sessionId: "session-1" }],
      ]);
    })
  );
});
