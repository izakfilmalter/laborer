import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { parseOpenCodeJsonl } from "../src/conversation-execution-live-canary-prototype/opencode-runner.ts";
import { makeCanarySocketPath } from "../src/conversation-execution-live-canary-prototype/runtime-paths.ts";

const MAXIMUM_MACOS_UNIX_SOCKET_PATH_BYTES = 103;

describe("live conversation/execution canary boundaries", () => {
  it("keeps its Unix socket below the macOS path limit", () => {
    const runtimeRoot = `/Users/example/${"nested-project-directory/".repeat(8)}.laborer-runtime`;
    const socketPath = makeCanarySocketPath(runtimeRoot);

    assert.ok(
      Buffer.byteLength(socketPath, "utf8") <=
        MAXIMUM_MACOS_UNIX_SOCKET_PATH_BYTES
    );
  });

  it.effect(
    "collects completed OpenCode text from one consistent session",
    () =>
      Effect.gen(function* () {
        const result = yield* parseOpenCodeJsonl(
          [
            JSON.stringify({
              part: { text: "first" },
              sessionID: "session-1",
              type: "text",
            }),
            JSON.stringify({
              part: { text: "final useful reply" },
              sessionID: "session-1",
              type: "text",
            }),
          ].join("\n")
        );

        assert.strictEqual(result.sessionId, "session-1");
        assert.strictEqual(result.text, "final useful reply");
      })
  );

  it.effect("rejects mixed OpenCode sessions at the JSONL boundary", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        parseOpenCodeJsonl(
          [
            JSON.stringify({
              part: { text: "first" },
              sessionID: "session-1",
              type: "text",
            }),
            JSON.stringify({
              part: { text: "second" },
              sessionID: "session-2",
              type: "text",
            }),
          ].join("\n")
        )
      );

      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.strictEqual(result.failure.reason, "inconsistent-session");
      }
    })
  );
});
