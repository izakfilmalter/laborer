import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  makeOpenCodeSessionClientFromV2Api,
  type OpenCodeV2SessionApi,
} from "../src/adapters/opencode-agents.ts";

describe("OpenCode v2 session client", () => {
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
            { id: "response-1", role: "assistant", text: "output" },
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
      yield* client.wait(identity);
      assert.deepStrictEqual(yield* client.readMessages(identity), [
        { id: "prompt-1", role: "user", text: "input" },
        { id: "response-1", role: "assistant", text: "output" },
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
        ["interrupt", { sessionId: "session-1" }],
      ]);
    })
  );
});
