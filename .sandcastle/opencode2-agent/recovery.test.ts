import { describe, expect, test } from "bun:test";
import { classifyRecoveredAssistant } from "./recovery.ts";

describe("classifyRecoveredAssistant", () => {
  test("keeps going after the output limit interrupts a tool call", () => {
    expect(
      classifyRecoveredAssistant({
        content: [
          {
            name: "shell",
            state: { status: "streaming" },
            type: "tool",
          },
        ],
        finish: "length",
        time: { completed: 1 },
      })
    ).toEqual({ status: "incomplete" });
  });

  test("keeps going when the latest message ends on tool calls", () => {
    expect(
      classifyRecoveredAssistant({
        content: [],
        finish: "tool-calls",
        time: { completed: 1 },
      })
    ).toEqual({ status: "incomplete" });
  });

  test("accepts a terminal response and recovers its text", () => {
    expect(
      classifyRecoveredAssistant({
        content: [{ text: "<promise>COMPLETE</promise>", type: "text" }],
        finish: "stop",
        time: { completed: 1 },
      })
    ).toEqual({
      status: "succeeded",
      text: ["<promise>COMPLETE</promise>"],
    });
  });

  test("preserves provider failures for retry policy", () => {
    expect(
      classifyRecoveredAssistant({
        error: { message: "transport failed", type: "provider.transport" },
        finish: "error",
        time: { completed: 1 },
      })
    ).toEqual({
      error: "transport failed",
      errorType: "provider.transport",
      status: "failed",
    });
  });

  test.each(["content-filter", "error", "unknown", undefined])(
    "rejects unsafe finish reason %s",
    (finish) => {
      expect(
        classifyRecoveredAssistant({
          finish,
          time: { completed: 1 },
        })
      ).toEqual({
        error: `OpenCode assistant stopped with unsafe finish reason: ${finish ?? "missing"}.`,
        status: "failed",
      });
    }
  );
});
