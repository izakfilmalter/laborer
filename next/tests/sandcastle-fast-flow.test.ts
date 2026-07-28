import { readFileSync } from "node:fs";
import { assert, describe, it } from "@effect/vitest";
import {
  boundedGateFailureContext,
  canReuseCompletedHead,
  reviewedHeadNeedsPush,
  shellQuote,
} from "../.sandcastle/fast-flow/index.ts";

describe("Sandcastle fast flow", () => {
  it("quotes untrusted Git refs as inert shell arguments", () => {
    assert.strictEqual(shellQuote("main"), "'main'");
    assert.strictEqual(
      shellQuote("release/$(touch nope)'x"),
      "'release/$(touch nope)'\"'\"'x'"
    );
  });

  it("pushes a recovered reviewed head when GitHub still has the old head", () => {
    assert.isTrue(reviewedHeadNeedsPush("old", "reviewed"));
    assert.isFalse(reviewedHeadNeedsPush("reviewed", "reviewed"));
  });

  it("keeps the comprehensive gate runner-owned and single-path", () => {
    const main = readFileSync(".sandcastle/main.ts", "utf8");
    const gateExecutions = main.match(
      /\.exec\(boundedSandboxCommand\(FULL_GATE\)/g
    );

    assert.lengthOf(gateExecutions ?? [], 1);
    assert.notInclude(main, "verify-fixer");
    assert.include(main, "const acquireGateSlot = createSlotLimiter(1)");
    assert.include(main, "shellQuote(command)");
    assert.notInclude(main, "JSON.stringify(command)");
  });

  it("tells every modifying agent to leave the comprehensive gate to the runner", () => {
    for (const prompt of [
      "implement-prompt.md",
      "pr-conflict-repair-prompt.md",
      "review-prompt.md",
      "ui-prompt.md",
      "ui-review-prompt.md",
      "verify-fix-prompt.md",
    ]) {
      const content = readFileSync(`.sandcastle/${prompt}`, "utf8");
      assert.include(content, "Do not run `bun run --cwd next check`");
    }
  });

  it("reuses only the exact completed PR head", () => {
    assert.isTrue(canReuseCompletedHead("abc", "abc"));
    assert.isFalse(canReuseCompletedHead(undefined, "abc"));
    assert.isFalse(canReuseCompletedHead("abc", "def"));
  });

  it("bounds untrusted gate diagnostics while preserving the useful tail", () => {
    const context = boundedGateFailureContext(
      {
        exitCode: 1,
        stderr: `old-error-${"x".repeat(100)}`,
        stdout: `old-output-${"y".repeat(100)}\nfinal failure`,
      },
      240
    );

    assert.isAtMost(context.length, 700);
    assert.include(context, "untrusted diagnostic data");
    assert.include(context, "final failure");
    assert.notInclude(context, "old-error");
  });

  it("bounds diagnostics after control-character escaping", () => {
    const context = boundedGateFailureContext(
      { exitCode: 1, stderr: "\u0000".repeat(1000), stdout: "" },
      120
    );

    assert.isAtMost(context.length, 500);
  });
});
