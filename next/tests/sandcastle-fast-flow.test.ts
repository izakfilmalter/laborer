import { readFileSync } from "node:fs";
import { assert, describe, it } from "@effect/vitest";
import {
  attemptHostStep,
  canReuseCompletedHead,
  hostCheckoutProblem,
  mergeFailureNeedsPreparation,
  mergePullRequestArgs,
  refreshDetachedBase,
  reviewedHeadNeedsPush,
  runnerBaseReuseProblem,
  shellQuote,
  shouldFastForwardPreservedWorktree,
  shouldRefreshUnstartedBranch,
} from "../../.sandcastle/fast-flow/index.ts";

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

  it("re-prepares a PR that becomes conflicting during merge", () => {
    assert.isTrue(mergeFailureNeedsPreparation("DIRTY", "UNKNOWN"));
    assert.isTrue(mergeFailureNeedsPreparation("CLEAN", "CONFLICTING"));
    assert.isFalse(mergeFailureNeedsPreparation("BEHIND", "MERGEABLE"));
    assert.isFalse(mergeFailureNeedsPreparation("CLEAN", "MERGEABLE"));
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

  it("stops safely when another process changes the host checkout", () => {
    assert.strictEqual(hostCheckoutProblem("master", "master", ""), undefined);
    assert.strictEqual(
      hostCheckoutProblem("master", "feature/speed-up", ""),
      "Sandcastle must start from a clean master checkout, but the host is on feature/speed-up. Restore a clean master checkout before restarting Sandcastle; after startup, the runner uses its detached base worktree."
    );
    assert.strictEqual(
      hostCheckoutProblem(
        "master",
        "feature/speed-up",
        " M next/tests/example.test.ts"
      ),
      "Sandcastle must start from a clean master checkout, but the host is on feature/speed-up. The checkout also has uncommitted changes. Restore a clean master checkout before restarting Sandcastle; after startup, the runner uses its detached base worktree."
    );
    assert.strictEqual(
      hostCheckoutProblem("master", "master", " M next/tests/example.test.ts"),
      "Sandcastle must start from a clean master checkout. Commit or stash host changes before restarting Sandcastle."
    );
  });

  it("rejects an attached, foreign, or divergent runner base", () => {
    assert.strictEqual(
      runnerBaseReuseProblem("/repo/.git", "/repo/.git", "", true),
      undefined
    );
    assert.strictEqual(
      runnerBaseReuseProblem("/repo/.git", "/other/.git", "", true),
      "Runner base path belongs to a different Git repository."
    );
    assert.strictEqual(
      runnerBaseReuseProblem(
        "/repo/.git",
        "/repo/.git",
        "feature/unsafe",
        true
      ),
      "Runner base worktree must remain detached, but it is attached to feature/unsafe."
    );
    assert.strictEqual(
      runnerBaseReuseProblem("/repo/.git", "/repo/.git", "", false),
      "Runner base HEAD has diverged from the configured local base branch."
    );
  });

  it("refreshes a detached base without touching the shared checkout", () => {
    const calls: string[][] = [];

    refreshDetachedBase("master", (args) => {
      calls.push(args);
    });

    assert.deepStrictEqual(calls, [
      [
        "fetch",
        "--no-tags",
        "origin",
        "refs/heads/master:refs/remotes/origin/master",
      ],
      ["merge", "--ff-only", "origin/master"],
    ]);
  });

  it("turns an expected host command failure into a reportable result", () => {
    assert.deepStrictEqual(
      attemptHostStep(() => {
        throw new Error("Not possible to fast-forward");
      }),
      { message: "Not possible to fast-forward", ok: false }
    );
    assert.deepStrictEqual(
      attemptHostStep(() => undefined),
      { ok: true }
    );
  });

  it("advances only dormant issue branches when the runner base moves", () => {
    assert.isTrue(
      shouldRefreshUnstartedBranch("old", "base", false, false, true)
    );
    assert.isFalse(
      shouldRefreshUnstartedBranch("base", "base", false, false, true)
    );
    assert.isFalse(
      shouldRefreshUnstartedBranch("old", "base", true, false, true)
    );
    assert.isFalse(
      shouldRefreshUnstartedBranch("old", "base", false, true, true)
    );
    assert.isFalse(
      shouldRefreshUnstartedBranch("other", "base", false, false, false)
    );
  });

  it("does not synchronize over preserved work", () => {
    assert.isTrue(shouldFastForwardPreservedWorktree(false, true));
    assert.isFalse(shouldFastForwardPreservedWorktree(true, true));
    assert.isFalse(shouldFastForwardPreservedWorktree(false, false));
  });

  it("delegates verification to the final code-review agent", () => {
    const main = readFileSync("../.sandcastle/main.ts", "utf8");
    const reviewPrompt = readFileSync(
      "../.sandcastle/review-prompt.md",
      "utf8"
    );

    assert.notInclude(main, "enforceLocalGate");
    assert.notInclude(main, "FULL_GATE");
    assert.notInclude(main, "local-gate-repair");
    assert.include(main, "after implementation for #");
    assert.include(main, "after code review for #");
    assert.include(reviewPrompt, "bun run --cwd next check");
    assert.include(reviewPrompt, "bun run --cwd current check");
    assert.include(reviewPrompt, "runner will trust your verification");
    assert.include(reviewPrompt, "final checked HEAD");
  });

  it("isolates base refreshes and prompts from the shared checkout", () => {
    const main = readFileSync("../.sandcastle/main.ts", "utf8");

    assert.include(main, "const RUNNER_BASE_WORKTREE");
    assert.include(main, '["-C", RUNNER_BASE_WORKTREE, ...args]');
    assert.include(main, "promptFile: runnerPromptFile(");
    assert.include(main, 'resolve(RUNNER_BASE_WORKTREE, ".sandcastle", name)');
    assert.include(main, "bun install --cwd current --frozen-lockfile");
    assert.include(main, "bun install --cwd next --frozen-lockfile");
    assert.include(main, "worktreeIsDirty(sandbox.worktreePath)");
    assert.include(main, '"merge-base",\n    "HEAD",\n    runnerBaseHead()');
    assert.include(
      main,
      "test -d current/node_modules && test -d next/node_modules"
    );
    assert.include(main, "supervisedNoSandbox({");
    assert.notInclude(main, "prepareOpenCodeCredentialSeed");
    assert.notInclude(main, "BUN_CACHE_DIR");
    assert.notInclude(main, "/home/agent");
    assert.notInclude(main, "gh auth setup-git");
    assert.notInclude(main, 'runFile("docker"');
    assert.include(main, "boundedHostCommand(");
    assert.include(main, "Sandcastle stopped safely ");
  });

  it("tells modifying agents that verification is agent-owned", () => {
    for (const prompt of [
      "implement-prompt.md",
      "pr-conflict-repair-prompt.md",
      "review-prompt.md",
      "ui-prompt.md",
      "ui-review-prompt.md",
    ]) {
      const content = readFileSync(`../.sandcastle/${prompt}`, "utf8");
      assert.notInclude(content, "runner executes that comprehensive gate");
    }
  });

  it("reuses only the exact completed PR head", () => {
    assert.isTrue(canReuseCompletedHead("abc", "abc"));
    assert.isFalse(canReuseCompletedHead(undefined, "abc"));
    assert.isFalse(canReuseCompletedHead("abc", "def"));
  });
});
