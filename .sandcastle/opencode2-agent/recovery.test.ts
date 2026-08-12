import { describe, expect, test } from "bun:test";
import {
  API_OUTAGE_GRACE_MS,
  classifyRecoveredAssistant,
  decideRecoveryStep,
} from "./recovery.ts";

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

describe("decideRecoveryStep", () => {
  const deadlineMs = 4 * 60 * 60_000;

  test("waits through a short API outage such as an OpenCode auto-update binary swap", () => {
    expect(
      decideRecoveryStep(
        { type: "api_failure" },
        { apiFailingSinceMs: 1_000, deadlineMs, nowMs: 16_000 }
      )
    ).toEqual({ apiFailingSinceMs: 1_000, type: "wait" });
  });

  test("starts tracking an outage from the first failed poll", () => {
    expect(
      decideRecoveryStep(
        { type: "api_failure" },
        { deadlineMs, nowMs: 5_000 }
      )
    ).toEqual({ apiFailingSinceMs: 5_000, type: "wait" });
  });

  test("gives up only after a sustained API outage", () => {
    expect(
      decideRecoveryStep(
        { type: "api_failure" },
        {
          apiFailingSinceMs: 1_000,
          deadlineMs,
          nowMs: 1_000 + API_OUTAGE_GRACE_MS,
        }
      )
    ).toEqual({ outcome: { status: "ambiguous" }, type: "settled" });
  });

  test("clears outage tracking once the API answers again", () => {
    expect(
      decideRecoveryStep(
        { type: "session_active" },
        { apiFailingSinceMs: 1_000, deadlineMs, nowMs: 20_000 }
      )
    ).toEqual({ type: "wait" });
  });

  test("declares ambiguity at the recovery deadline", () => {
    expect(
      decideRecoveryStep(
        { type: "session_active" },
        { deadlineMs, nowMs: deadlineMs }
      )
    ).toEqual({ outcome: { status: "ambiguous" }, type: "settled" });
  });

  test("keeps waiting while a restarting daemon resumes a mid-flight turn", () => {
    // Regression: issue #436 review — the daemon updated itself, the session
    // briefly left the active list while its turn kept executing, and the
    // runner refused to replay even though the session later succeeded.
    expect(
      decideRecoveryStep(
        {
          assistant: { time: { created: 1 }, type: "assistant" },
          type: "session_inactive",
        },
        { deadlineMs, nowMs: 60_000 }
      )
    ).toEqual({ type: "wait" });
  });

  test("keeps waiting when the message log is briefly unavailable", () => {
    expect(
      decideRecoveryStep(
        { type: "session_inactive" },
        { deadlineMs, nowMs: 60_000 }
      )
    ).toEqual({ type: "wait" });
  });

  test("settles on a durable terminal response once the session leaves the active list", () => {
    expect(
      decideRecoveryStep(
        {
          assistant: {
            content: [{ text: "<promise>COMPLETE</promise>", type: "text" }],
            finish: "stop",
            time: { completed: 2 },
            type: "assistant",
          },
          type: "session_inactive",
        },
        { deadlineMs, nowMs: 60_000 }
      )
    ).toEqual({
      outcome: {
        status: "succeeded",
        text: ["<promise>COMPLETE</promise>"],
      },
      type: "settled",
    });
  });

  test("settles as incomplete when the durable turn ended on tool calls", () => {
    expect(
      decideRecoveryStep(
        {
          assistant: {
            content: [],
            finish: "tool-calls",
            time: { completed: 2 },
            type: "assistant",
          },
          type: "session_inactive",
        },
        { deadlineMs, nowMs: 60_000 }
      )
    ).toEqual({ outcome: { status: "incomplete" }, type: "settled" });
  });
});
