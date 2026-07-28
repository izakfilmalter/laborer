import { readFileSync } from "node:fs";
import { assert, describe, it } from "@effect/vitest";
import {
  canReuseCompletedHead,
  mergePullRequestArgs,
  reviewedHeadNeedsPush,
  shellQuote,
} from "../.sandcastle/fast-flow/index.ts";

describe("Sandcastle fast flow", () => {
  it("merges without asking gh to delete a checked-out worktree branch", () => {
    const args = mergePullRequestArgs("https://example.test/pull/42", "abc123");

    assert.deepStrictEqual(args, [
      "pr",
      "merge",
      "https://example.test/pull/42",
      "--squash",
      "--match-head-commit",
      "abc123",
    ]);
    assert.notInclude(args, "--delete-branch");
  });

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

  it("delegates verification to the final code-review agent", () => {
    const main = readFileSync(".sandcastle/main.ts", "utf8");
    const reviewPrompt = readFileSync(".sandcastle/review-prompt.md", "utf8");

    assert.notInclude(main, "enforceLocalGate");
    assert.notInclude(main, "FULL_GATE");
    assert.notInclude(main, "local-gate-repair");
    assert.include(main, "after implementation for #");
    assert.include(main, "after code review for #");
    assert.include(reviewPrompt, "bun run --cwd next check");
    assert.include(reviewPrompt, "runner will trust your verification");
    assert.include(reviewPrompt, "final checked HEAD");
  });

  it("tells modifying agents that verification is agent-owned", () => {
    for (const prompt of [
      "implement-prompt.md",
      "pr-conflict-repair-prompt.md",
      "review-prompt.md",
      "ui-prompt.md",
      "ui-review-prompt.md",
    ]) {
      const content = readFileSync(`.sandcastle/${prompt}`, "utf8");
      assert.notInclude(content, "runner executes that comprehensive gate");
    }
  });

  it("reuses only the exact completed PR head", () => {
    assert.isTrue(canReuseCompletedHead("abc", "abc"));
    assert.isFalse(canReuseCompletedHead(undefined, "abc"));
    assert.isFalse(canReuseCompletedHead("abc", "def"));
  });
});
