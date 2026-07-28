// Laborer adaptation of the parallel planner/reviewer setup from church-work.
// Run from next/ with `bun run sandcastle` after building the Docker image.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createSandbox, Output, opencode, run } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { config as loadEnv } from "dotenv";
import { z } from "zod";
import {
  assertAgentCompleted,
  assertNewWorkAfterAcceptedHead,
  assertRecordedRecoveryLineage,
  canRetryGateAfterIncompleteRepair,
  classifyBranchRecovery,
} from "./agent-completion/index.ts";
import {
  boundedGateFailureContext,
  canReuseCompletedHead,
  mergePullRequestArgs,
  reviewedHeadNeedsPush,
  sandcastleFullGateCommand,
  shellQuote,
} from "./fast-flow/index.ts";
import { GitHubCliIssueGraphSource } from "./github-cli-issue-graph-source/index.ts";
import {
  type ExistingPullRequest,
  type FinalizeIssueSpec,
  type RunnableIssue,
  scheduleIssueGraph,
} from "./issue-graph-scheduler/index.ts";
import { waitForExpectedPrHead } from "./pr-head-observation/index.ts";
import {
  appendSpecProgress,
  assertPullRequestTargets,
  createSpecPullRequestBody,
  implementationMarker,
  PRE_PUBLISH_REVIEW_MARKER,
  recordReviewedHead,
  reviewedHeadFromBody,
  reviewedHeadMarker,
  specClosureOrder,
} from "./spec-pr-progress/index.ts";

loadEnv({ path: ".sandcastle/.env", quiet: true });

const plannedIssueSchema = z
  .object({
    id: z.string().regex(/^\d+$/),
    title: z.string().min(1),
    branch: z.string().regex(/^sandcastle\/(?:issue|spec)-\d+$/),
    needsUi: z.boolean(),
    uiBrief: z.string().min(1).optional(),
  })
  .superRefine((issue, context) => {
    if (issue.needsUi && issue.uiBrief === undefined) {
      context.addIssue({
        code: "custom",
        message: "UI issues require a UI brief.",
        path: ["uiBrief"],
      });
    }
  });

const planSchema = z.object({ issues: z.array(plannedIssueSchema) });
const prStatusSchema = z.object({
  headRefOid: z.string().regex(/^[0-9a-f]{40,64}$/),
  isDraft: z.boolean(),
  mergeable: z.enum(["CONFLICTING", "MERGEABLE", "UNKNOWN"]),
  mergedAt: z.string().datetime().nullable(),
  mergeStateStatus: z.enum([
    "BEHIND",
    "BLOCKED",
    "CLEAN",
    "DIRTY",
    "DRAFT",
    "HAS_HOOKS",
    "UNKNOWN",
    "UNSTABLE",
  ]),
  state: z.enum(["CLOSED", "MERGED", "OPEN"]),
});
interface PlannedIssue extends z.infer<typeof plannedIssueSchema> {
  readonly ancestorPath: RunnableIssue["ancestorPath"];
  readonly descendantLeafNumbers: RunnableIssue["descendantLeafNumbers"];
  readonly kind: RunnableIssue["kind"];
  readonly latestImplementedHead?: string;
  readonly parent: RunnableIssue["parent"];
  readonly pullRequest?: ExistingPullRequest;
  readonly root: RunnableIssue["root"];
}
type Sandbox = Awaited<ReturnType<typeof createSandbox>>;

const MAX_ITERATIONS = positiveIntegerEnv("SANDCASTLE_MAX_ITERATIONS", 10);
const MAX_PARALLEL = positiveIntegerEnv("SANDCASTLE_MAX_PARALLEL", 4);
const MAX_REPAIR_ATTEMPTS = nonNegativeIntegerEnv(
  "SANDCASTLE_MAX_REPAIR_ATTEMPTS",
  3
);
const MAX_LOCAL_GATE_REPAIR_ATTEMPTS = nonNegativeIntegerEnv(
  "SANDCASTLE_MAX_LOCAL_GATE_REPAIR_ATTEMPTS",
  1
);
const GITHUB_POLL_INTERVAL_MS = positiveIntegerEnv(
  "SANDCASTLE_GITHUB_POLL_INTERVAL_MS",
  30_000
);
const HOST_COMMAND_TIMEOUT_MS = positiveIntegerEnv(
  "SANDCASTLE_HOST_COMMAND_TIMEOUT_MS",
  2 * 60_000
);
const SANDBOX_COMMAND_TIMEOUT_SECONDS = positiveIntegerEnv(
  "SANDCASTLE_SANDBOX_COMMAND_TIMEOUT_SECONDS",
  20 * 60
);
const AGENT_RUN_TIMEOUT_MS = positiveIntegerEnv(
  "SANDCASTLE_AGENT_RUN_TIMEOUT_MS",
  4 * 60 * 60_000
);
const AGENT_IDLE_TIMEOUT_SECONDS = positiveIntegerEnv(
  "SANDCASTLE_AGENT_IDLE_TIMEOUT_SECONDS",
  30 * 60
);
const PR_HEAD_OBSERVATION_TIMEOUT_MS = positiveIntegerEnv(
  "SANDCASTLE_PR_HEAD_OBSERVATION_TIMEOUT_MS",
  2 * 60_000
);
const MERGE_TIMEOUT_MS = positiveIntegerEnv(
  "SANDCASTLE_MERGE_TIMEOUT_MS",
  20 * 60_000
);
const AUTO_MERGE_PRS = process.env.SANDCASTLE_AUTO_MERGE !== "false";
const WAIT_FOR_MERGES = process.env.SANDCASTLE_WAIT_FOR_MERGES !== "false";
const BASE_BRANCH = process.env.SANDCASTLE_BASE_BRANCH || defaultBranch();
const SANDBOX_IMAGE_NAME =
  process.env.SANDCASTLE_IMAGE_NAME ?? "sandcastle:laborer-next";
const BUN_CACHE_DIR = resolve(".sandcastle/bun-cache");
const REVIEW_MARKER = PRE_PUBLISH_REVIEW_MARKER;
const FULL_GATE = sandcastleFullGateCommand;
const REPO_ROOT = "..";
const HOST_OPENCODE_CONFIG = resolve(homedir(), ".config/opencode");
const HOST_OPENCODE_AUTH = resolve(
  homedir(),
  ".local/share/opencode/auth.json"
);
const HOST_OPENCODE_ACCOUNT = resolve(
  homedir(),
  ".local/share/opencode/account.json"
);
const VERIFICATION_POLICY = [
  "Run deterministic offline checks only.",
  "Run only targeted checks; the runner owns the single comprehensive `bun run --cwd next check` gate.",
  "Never run live Slack or ACP canaries unless an issue explicitly requires a manual credentialed smoke test.",
].join(" ");

mkdirSync(BUN_CACHE_DIR, { recursive: true });

const allAroundAgent = () =>
  opencode("openai/gpt-5.6-sol", { variant: "medium" });
const uiAgent = () =>
  opencode("anthropic/claude-opus-5", { variant: "medium" });

const sandboxProvider = () =>
  docker({
    env: { GH_TOKEN: requiredEnv("SANDCASTLE_AGENT_GH_TOKEN") },
    imageName: SANDBOX_IMAGE_NAME,
    mounts: [
      {
        hostPath: HOST_OPENCODE_CONFIG,
        sandboxPath: "/home/agent/.config/opencode",
        readonly: true,
      },
      {
        hostPath: HOST_OPENCODE_AUTH,
        sandboxPath: "/home/agent/.local/share/opencode/auth.json",
        readonly: true,
      },
      {
        hostPath: HOST_OPENCODE_ACCOUNT,
        sandboxPath: "/home/agent/.local/share/opencode/account.json",
        readonly: true,
      },
      {
        hostPath: BUN_CACHE_DIR,
        sandboxPath: "/home/agent/.bun/install/cache",
      },
    ],
  });

const acquireSlot = createSlotLimiter(MAX_PARALLEL);
const acquireGateSlot = createSlotLimiter(1);
const issueGraphSource = new GitHubCliIssueGraphSource(
  (args) => runFile("gh", [...args]),
  undefined,
  BASE_BRANCH
);

assertHostReady();

for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
  console.log(
    `\n=== Sandcastle iteration ${iteration}/${MAX_ITERATIONS} ===\n`
  );
  refreshBaseBranch();
  syncPlannerBranchToBase();
  const readyIssueNumbers =
    issueGraphSource.listOpenIssueNumbers("ready-for-agent");
  const schedule = scheduleIssueGraph(issueGraphSource, readyIssueNumbers);
  logWaitingIssueRoots(schedule.waiting);

  let madeProgress = false;
  for (const spec of schedule.finalize) {
    try {
      await finalizeSpec(spec);
      madeProgress = true;
    } catch (error) {
      process.exitCode = 1;
      console.error(
        `  Spec #${spec.root.number} finalization failed: ${String(error)}`
      );
    }
  }
  if (process.exitCode) {
    break;
  }

  const existingStandalonePullRequests = schedule.runnable.filter(
    (issue) => issue.kind === "standalone" && issue.pullRequest !== undefined
  );
  for (const scheduled of existingStandalonePullRequests) {
    const issue = plannedIssueFromRunnable(scheduled, {
      branch: scheduled.branch,
      id: String(scheduled.issue.number),
      needsUi: false,
      title: scheduled.issue.title,
    });
    try {
      await publishAndMaybeMergeStandalone(issue, scheduled.pullRequest?.url);
      madeProgress = true;
    } catch (error) {
      process.exitCode = 1;
      console.error(`  Existing PR for #${issue.id} failed: ${String(error)}`);
    }
  }
  if (process.exitCode) {
    break;
  }

  const buildCandidates = schedule.runnable.filter(
    (issue) => !(issue.kind === "standalone" && issue.pullRequest !== undefined)
  );
  if (buildCandidates.length > 0) {
    const plannedIssues = await classifyRunnableIssues(buildCandidates);
    console.log(
      `Planner classified ${plannedIssues.length} runnable issue(s):`
    );
    for (const issue of plannedIssues) {
      console.log(`  #${issue.id}: ${issue.title} -> ${issue.branch}`);
    }

    const workResults = await Promise.allSettled(
      plannedIssues.map(async (issue) => {
        const releaseSlot = await acquireSlot();
        try {
          await buildIssue(issue);
          if (issue.kind === "spec-leaf") {
            await publishSpecProgress(issue);
            return { issue };
          }
          return { issue, prUrl: publishIssuePr(issue) };
        } finally {
          releaseSlot();
        }
      })
    );

    for (const [index, result] of workResults.entries()) {
      const issue = plannedIssues[index];
      if (!issue) {
        continue;
      }
      if (result.status === "rejected") {
        process.exitCode = 1;
        console.error(`  Issue #${issue.id} failed: ${String(result.reason)}`);
        continue;
      }
      madeProgress = true;
    }

    for (const result of workResults) {
      if (
        result.status === "rejected" ||
        result.value.issue.kind === "spec-leaf"
      ) {
        continue;
      }
      try {
        await publishAndMaybeMergeStandalone(
          result.value.issue,
          result.value.prUrl
        );
      } catch (error) {
        process.exitCode = 1;
        console.error(
          `  Preparing #${result.value.issue.id} failed: ${String(error)}`
        );
      }
    }
  }

  if (process.exitCode) {
    break;
  }
  if (!madeProgress) {
    console.log(
      schedule.waiting.length > 0
        ? "All remaining ready work is blocked. Exiting without selecting a fallback."
        : "No runnable ready-for-agent issues. Exiting."
    );
    break;
  }
  if (!(WAIT_FOR_MERGES && AUTO_MERGE_PRS)) {
    console.log("Stopping after one batch by configuration.");
    break;
  }
}

console.log(
  process.exitCode
    ? "\nSandcastle stopped with errors."
    : "\nSandcastle finished."
);

async function classifyRunnableIssues(
  runnable: readonly RunnableIssue[]
): Promise<PlannedIssue[]> {
  const candidates = runnable.map((issue) => ({
    ancestorPath: issue.ancestorPath,
    branch: issue.branch,
    id: String(issue.issue.number),
    kind: issue.kind,
    ...(issue.latestImplementedHead === undefined
      ? undefined
      : { latestImplementedHead: issue.latestImplementedHead }),
    parent: issue.parent,
    root: issue.root,
    title: issue.issue.title,
  }));
  const plan = await run({
    agent: allAroundAgent(),
    branchStrategy: { type: "branch", branch: "sandcastle/planner" },
    cwd: REPO_ROOT,
    idleTimeoutSeconds: AGENT_IDLE_TIMEOUT_SECONDS,
    maxIterations: 1,
    name: "planner",
    output: Output.object({ tag: "plan", schema: planSchema }),
    promptArgs: { CANDIDATES_JSON: JSON.stringify(candidates, null, 2) },
    promptFile: ".sandcastle/plan-prompt.md",
    sandbox: sandboxProvider(),
    signal: agentRunSignal(),
  });

  if (plan.output.issues.length !== runnable.length) {
    throw new Error(
      `Planner returned ${plan.output.issues.length} classifications for ${runnable.length} runnable issues.`
    );
  }
  const byId = new Map(plan.output.issues.map((issue) => [issue.id, issue]));
  if (byId.size !== plan.output.issues.length) {
    throw new Error("Planner returned duplicate issue classifications.");
  }

  return runnable.map((issue) => {
    const classification = byId.get(String(issue.issue.number));
    if (classification === undefined) {
      throw new Error(`Planner omitted runnable issue #${issue.issue.number}.`);
    }
    if (
      classification.branch !== issue.branch ||
      classification.title !== issue.issue.title
    ) {
      throw new Error(
        `Planner changed the native identity or branch for issue #${issue.issue.number}.`
      );
    }
    return plannedIssueFromRunnable(issue, classification);
  });
}

function plannedIssueFromRunnable(
  issue: RunnableIssue,
  classification: z.infer<typeof plannedIssueSchema>
): PlannedIssue {
  const planned = {
    ancestorPath: issue.ancestorPath,
    branch: issue.branch,
    descendantLeafNumbers: issue.descendantLeafNumbers,
    id: String(issue.issue.number),
    kind: issue.kind,
    needsUi: classification.needsUi,
    parent: issue.parent,
    root: issue.root,
    title: issue.issue.title,
  };
  return {
    ...planned,
    ...(classification.uiBrief === undefined
      ? undefined
      : { uiBrief: classification.uiBrief }),
    ...(issue.pullRequest === undefined
      ? undefined
      : { pullRequest: issue.pullRequest }),
    ...(issue.latestImplementedHead === undefined
      ? undefined
      : { latestImplementedHead: issue.latestImplementedHead }),
  };
}

function logWaitingIssueRoots(
  waiting: ReturnType<typeof scheduleIssueGraph>["waiting"]
) {
  for (const root of waiting) {
    console.log(`Spec/root #${root.root.number} is waiting:`);
    for (const blocked of root.blockedLeaves) {
      const blockers = blocked.openBlockers
        .map((blocker) => `#${blocker.number}`)
        .join(", ");
      console.log(`  #${blocked.leaf.number} blocked by ${blockers}`);
    }
  }
}

async function publishSpecProgress(issue: PlannedIssue) {
  const beforePush = issueGraphSource.pullRequest(issue.branch);
  if (beforePush !== undefined) {
    assertOpenDraftSpecPullRequest(beforePush, issue);
  }
  if (
    issue.pullRequest !== undefined &&
    issue.pullRequest.url !== beforePush?.url
  ) {
    throw new Error(
      `Shared PR identity changed while implementing #${issue.id}.`
    );
  }

  const acceptedHead = localBranchHead(issue.branch);
  if (recordedCompletion(issue) !== acceptedHead) {
    throw new Error(
      `Refusing to publish #${issue.id}: local head does not match its completed head.`
    );
  }
  pushIssueBranch(issue.branch, acceptedHead);
  let current = issueGraphSource.pullRequest(issue.branch);
  if (current === undefined) {
    const body = createSpecPullRequestBody(
      issue.root.number,
      Number(issue.id),
      acceptedHead
    );
    runFile("gh", [
      "pr",
      "create",
      "--base",
      BASE_BRANCH,
      "--head",
      issue.branch,
      "--draft",
      "--title",
      `Sandcastle: ${issue.root.title}`,
      "--body",
      body,
    ]);
    current = issueGraphSource.pullRequest(issue.branch);
  }
  if (current === undefined) {
    throw new Error(
      `Shared PR was not observable after publishing #${issue.id}.`
    );
  }
  assertOpenDraftSpecPullRequest(current, issue);
  await waitForPrHead(current.url, acceptedHead);
  const body = recordReviewedHead(
    appendSpecProgress(
      current.body,
      issue.root.number,
      Number(issue.id),
      acceptedHead
    ),
    acceptedHead
  );
  if (body !== current.body) {
    runFile("gh", ["pr", "edit", current.url, "--body", body]);
  }

  const confirmed = issueGraphSource.pullRequest(issue.branch);
  if (confirmed === undefined) {
    throw new Error(`Shared PR disappeared while recording #${issue.id}.`);
  }
  assertOpenDraftSpecPullRequest(confirmed, issue);
  await waitForPrHead(confirmed.url, acceptedHead);
  if (
    !confirmed.body.includes(
      implementationMarker(Number(issue.id), acceptedHead)
    ) ||
    reviewedHeadFromBody(confirmed.body) !== acceptedHead
  ) {
    throw new Error(
      `Shared PR did not retain the implementation and reviewed-head markers for #${issue.id}.`
    );
  }
  deleteRecordedCompletion(issue);
  console.log(`  Recorded #${issue.id} on shared draft PR ${confirmed.url}`);
}

function assertOpenDraftSpecPullRequest(
  pullRequest: ExistingPullRequest,
  issue: PlannedIssue
) {
  assertPullRequestTargets(pullRequest, BASE_BRANCH, issue.branch);
  if (pullRequest.state !== "OPEN" || !pullRequest.isDraft) {
    throw new Error(
      `Shared PR is no longer an open draft; refusing to record #${issue.id}.`
    );
  }
}

async function publishAndMaybeMergeStandalone(
  issue: PlannedIssue,
  existingPrUrl?: string
) {
  const prUrl = existingPrUrl ?? publishIssuePr(issue);
  const pullRequest = issueGraphSource.pullRequest(issue.branch);
  if (pullRequest === undefined || pullRequest.url !== prUrl) {
    throw new Error(`Could not bind ${prUrl} to branch ${issue.branch}.`);
  }
  assertPullRequestTargets(pullRequest, BASE_BRANCH, issue.branch);
  if (pullRequest.state === "MERGED") {
    const reviewedHead = reviewedHeadFromBody(pullRequest.body);
    if (reviewedHead === undefined) {
      throw new Error(`Merged PR has no durable reviewed head: ${prUrl}`);
    }
    assertMergedPullRequestMatches(prUrl, issue.branch, reviewedHead);
    closeIssueIfOpen(Number(issue.id), prUrl);
    deleteRecordedCompletion(issue);
    return;
  }
  const reviewedHead = await preparePrForMerge(issue, prUrl);
  if (reviewedHead === undefined) {
    throw new Error(`PR is not ready to merge: ${prUrl}`);
  }
  markPullRequestReady(prUrl, issue.branch);
  if (!AUTO_MERGE_PRS) {
    console.log(`  Ready for manual merge: ${prUrl}`);
    return;
  }
  await mergePreparedPullRequest(prUrl, reviewedHead, issue.branch);
  closeIssueIfOpen(Number(issue.id), prUrl);
  deleteRecordedCompletion(issue);
}

async function finalizeSpec(spec: FinalizeIssueSpec) {
  const issue = plannedIssueForFinalize(spec);
  assertCurrentPullRequestTargets(spec.pullRequest.url, spec.branch);
  const status = getPrStatus(spec.pullRequest.url);
  if (status.state === "MERGED" || status.mergedAt) {
    assertMergedPullRequestMatches(
      spec.pullRequest.url,
      spec.branch,
      spec.expectedHeadSha
    );
    closeSpecIssues(spec);
    return;
  }
  const reviewedHead = await preparePrForMerge(issue, spec.pullRequest.url);
  if (reviewedHead === undefined) {
    throw new Error(`PR is not ready to merge: ${spec.pullRequest.url}`);
  }
  markPullRequestReady(spec.pullRequest.url, spec.branch);
  if (!AUTO_MERGE_PRS) {
    console.log(`  Spec PR ready for manual merge: ${spec.pullRequest.url}`);
    return;
  }
  await mergePreparedPullRequest(
    spec.pullRequest.url,
    reviewedHead,
    spec.branch
  );
  closeSpecIssues(spec);
}

function plannedIssueForFinalize(spec: FinalizeIssueSpec): PlannedIssue {
  return {
    ancestorPath: [spec.root],
    branch: spec.branch,
    descendantLeafNumbers: spec.descendantLeafNumbers,
    id: String(spec.root.number),
    kind: "spec-leaf",
    needsUi: false,
    parent: null,
    pullRequest: spec.pullRequest,
    root: spec.root,
    title: spec.root.title,
  };
}

async function mergePreparedPullRequest(
  prUrl: string,
  reviewedHead: string,
  expectedBranch: string
) {
  assertCurrentPullRequestTargets(prUrl, expectedBranch);
  const initialStatus = getPrStatus(prUrl);
  if (initialStatus.state === "MERGED" || initialStatus.mergedAt) {
    assertMergedPullRequestMatches(prUrl, expectedBranch, reviewedHead);
    return;
  }
  const currentHead = getPrStatus(prUrl).headRefOid;
  if (currentHead !== reviewedHead) {
    throw new Error(
      `PR head moved after review: expected ${reviewedHead}, received ${currentHead ?? "none"}.`
    );
  }
  mergePr(prUrl, reviewedHead);
  const deadline = Date.now() + MERGE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = getPrStatus(prUrl);
    if (status.state === "MERGED" || status.mergedAt) {
      assertMergedPullRequestMatches(prUrl, expectedBranch, reviewedHead);
      return;
    }
    if (status.state === "CLOSED") {
      throw new Error(`${prUrl} closed without merge.`);
    }
    await sleep(GITHUB_POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for ${prUrl} to merge.`);
}

function assertMergedPullRequestMatches(
  prUrl: string,
  expectedBranch: string,
  reviewedHead: string
) {
  const status = getPrStatus(prUrl);
  if (!(status.state === "MERGED" || status.mergedAt)) {
    throw new Error(`${prUrl} was no longer confirmed merged.`);
  }
  if (status.headRefOid !== reviewedHead) {
    throw new Error(
      `Merged PR head differs from reviewed head ${reviewedHead}.`
    );
  }
  assertCurrentPullRequestTargets(prUrl, expectedBranch);
}

function assertCurrentPullRequestTargets(
  prUrl: string,
  expectedBranch: string
) {
  const pullRequest = issueGraphSource.pullRequest(expectedBranch);
  if (pullRequest === undefined || pullRequest.url !== prUrl) {
    throw new Error(`Could not bind ${prUrl} to branch ${expectedBranch}.`);
  }
  assertPullRequestTargets(pullRequest, BASE_BRANCH, expectedBranch);
}

function markPullRequestReady(prUrl: string, expectedBranch: string) {
  const pullRequest = issueGraphSource.pullRequest(expectedBranch);
  if (pullRequest === undefined || pullRequest.url !== prUrl) {
    throw new Error(`Could not bind ${prUrl} to branch ${expectedBranch}.`);
  }
  assertPullRequestTargets(pullRequest, BASE_BRANCH, expectedBranch);
  if (pullRequest.state !== "OPEN") {
    throw new Error(`Cannot mark non-open PR ready: ${prUrl}.`);
  }
  if (pullRequest.isDraft) {
    runFile("gh", ["pr", "ready", prUrl]);
  }
}

function closeSpecIssues(spec: FinalizeIssueSpec) {
  for (const issueNumber of specClosureOrder(
    spec.descendantIssueNumbers,
    spec.root.number
  )) {
    closeIssueIfOpen(issueNumber, spec.pullRequest.url);
  }
}

function closeIssueIfOpen(issueNumber: number, prUrl: string) {
  const state = z
    .enum(["CLOSED", "OPEN"])
    .parse(
      runFile("gh", [
        "issue",
        "view",
        String(issueNumber),
        "--json",
        "state",
        "--jq",
        ".state",
      ]).trim()
    );
  if (state === "OPEN") {
    runFile("gh", [
      "issue",
      "close",
      String(issueNumber),
      "--comment",
      `Delivered through ${prUrl}.`,
    ]);
  }
}

async function buildIssue(issue: PlannedIssue) {
  const sandbox = await createIssueSandbox(issue);
  try {
    const acceptedHead =
      issue.latestImplementedHead ?? baseBranchHead(sandbox.worktreePath);
    const startingHead = worktreeHead(sandbox.worktreePath);
    const recovery = classifyBranchRecovery({
      acceptedHead,
      completedHead: recordedCompletion(issue),
      currentHead: startingHead,
      gatePassedHead: recordedGatePassed(issue),
      gatePendingHead: recordedGatePending(issue),
      implementationHead: recordedImplementation(issue),
      progressHead: recordedProgress(issue),
      uiReviewedHead: recordedUiReview(issue),
    });
    if (recovery !== "build") {
      assertRecordedRecoveryLineage(
        issue.latestImplementedHead,
        startingHead,
        (ancestor, descendant) =>
          commitIsAncestor(sandbox.worktreePath, ancestor, descendant)
      );
      if (recovery === "publish") {
        return [];
      }
      let resumedCommits: Array<{ sha: string }> = [];
      if (recovery === "complete") {
        // The exact head passed the runner gate before interruption.
      } else if (recovery === "gate") {
        resumedCommits = await enforceLocalGate(issue, sandbox, true);
      } else if (recovery === "ui") {
        resumedCommits = await runUiImplementation(issue, sandbox);
        resumedCommits.push(...(await runReviewAndGate(issue, sandbox)));
      } else {
        resumedCommits = await runReviewAndGate(
          issue,
          sandbox,
          true,
          recovery === "code-review"
        );
      }
      const completedHead = worktreeHead(sandbox.worktreePath);
      assertNewWorkAfterAcceptedHead(
        acceptedHead,
        completedHead,
        `Issue #${issue.id}`
      );
      recordCompletion(issue, completedHead);
      deleteRecordedStages(issue);
      return resumedCommits;
    }
    const commits: Array<{ sha: string }> = [];
    const implementation = await sandbox.run({
      agent: allAroundAgent(),
      idleTimeoutSeconds: AGENT_IDLE_TIMEOUT_SECONDS,
      maxIterations: 3,
      name: `all-around-builder-${issue.id}`,
      promptArgs: issuePromptArgs(issue),
      promptFile: ".sandcastle/implement-prompt.md",
      signal: agentRunSignal(),
    });
    assertAgentCompleted(implementation, `implementation for #${issue.id}`);
    commits.push(...implementation.commits);

    if (issue.needsUi) {
      recordImplementation(issue, worktreeHead(sandbox.worktreePath));
      commits.push(...(await runUiImplementation(issue, sandbox)));
    } else {
      recordProgress(issue, worktreeHead(sandbox.worktreePath));
    }

    commits.push(...(await runReviewAndGate(issue, sandbox)));
    const completedHead = worktreeHead(sandbox.worktreePath);
    assertNewWorkAfterAcceptedHead(
      acceptedHead,
      completedHead,
      `Issue #${issue.id}`
    );
    recordCompletion(issue, completedHead);
    deleteRecordedStages(issue);
    return commits;
  } finally {
    await sandbox.close();
  }
}

function completionRef(issue: PlannedIssue) {
  return `refs/sandcastle/completed/${issue.kind}/${issue.root.number}/${issue.id}`;
}

function progressRef(issue: PlannedIssue) {
  return `refs/sandcastle/progress/${issue.kind}/${issue.root.number}/${issue.id}`;
}

function implementationRef(issue: PlannedIssue) {
  return `refs/sandcastle/implemented/${issue.kind}/${issue.root.number}/${issue.id}`;
}

function uiReviewRef(issue: PlannedIssue) {
  return `refs/sandcastle/ui-reviewed/${issue.kind}/${issue.root.number}/${issue.id}`;
}

function gatePendingRef(issue: PlannedIssue) {
  return `refs/sandcastle/gate-pending/${issue.kind}/${issue.root.number}/${issue.id}`;
}

function gatePassedRef(issue: PlannedIssue) {
  return `refs/sandcastle/gate-passed/${issue.kind}/${issue.root.number}/${issue.id}`;
}

function repairRef(issue: PlannedIssue) {
  return `refs/sandcastle/repaired/${issue.kind}/${issue.root.number}/${issue.id}`;
}

function recordedCompletion(issue: PlannedIssue) {
  const output = tryFile("git", [
    "rev-parse",
    "--verify",
    "--quiet",
    completionRef(issue),
  ]).trim();
  return output || undefined;
}

function recordCompletion(issue: PlannedIssue, completedHead: string) {
  runFile("git", ["update-ref", completionRef(issue), completedHead]);
}

function recordedProgress(issue: PlannedIssue) {
  const output = tryFile("git", [
    "rev-parse",
    "--verify",
    "--quiet",
    progressRef(issue),
  ]).trim();
  return output || undefined;
}

function recordProgress(issue: PlannedIssue, progressHead: string) {
  runFile("git", ["update-ref", progressRef(issue), progressHead]);
}

function deleteRecordedProgress(issue: PlannedIssue) {
  if (recordedProgress(issue) !== undefined) {
    runFile("git", ["update-ref", "-d", progressRef(issue)]);
  }
}

function recordedStageRef(ref: string) {
  const output = tryFile("git", [
    "rev-parse",
    "--verify",
    "--quiet",
    ref,
  ]).trim();
  return output || undefined;
}

function recordedImplementation(issue: PlannedIssue) {
  return recordedStageRef(implementationRef(issue));
}

function recordedUiReview(issue: PlannedIssue) {
  return recordedStageRef(uiReviewRef(issue));
}

function recordedGatePending(issue: PlannedIssue) {
  return recordedStageRef(gatePendingRef(issue));
}

function recordedGatePassed(issue: PlannedIssue) {
  return recordedStageRef(gatePassedRef(issue));
}

function recordedRepair(issue: PlannedIssue) {
  return recordedStageRef(repairRef(issue));
}

function recordImplementation(issue: PlannedIssue, head: string) {
  runFile("git", ["update-ref", implementationRef(issue), head]);
}

function recordUiReview(issue: PlannedIssue, head: string) {
  runFile("git", ["update-ref", uiReviewRef(issue), head]);
}

function recordGatePassed(issue: PlannedIssue, head: string) {
  runFile("git", ["update-ref", gatePassedRef(issue), head]);
}

function recordGatePendingCheckpoint(issue: PlannedIssue, head: string) {
  updateRefsAtomically([
    [progressRef(issue), head],
    [gatePendingRef(issue), head],
  ]);
}

function recordGateRepairCheckpoint(issue: PlannedIssue, head: string) {
  updateRefsAtomically([
    [progressRef(issue), head],
    [gatePendingRef(issue), head],
    [repairRef(issue), head],
  ]);
}

function updateRefsAtomically(
  entries: ReadonlyArray<readonly [string, string]>
) {
  runFileWithInput(
    "git",
    ["update-ref", "--stdin"],
    [
      "start",
      ...entries.map(([ref, head]) => `update ${ref} ${head}`),
      "prepare",
      "commit",
      "",
    ].join("\n")
  );
}

function deleteRecordedStage(ref: string) {
  if (recordedStageRef(ref) !== undefined) {
    runFile("git", ["update-ref", "-d", ref]);
  }
}

function deleteRecordedStages(issue: PlannedIssue) {
  deleteRecordedProgress(issue);
  deleteRecordedStage(implementationRef(issue));
  deleteRecordedStage(uiReviewRef(issue));
  deleteRecordedStage(gatePendingRef(issue));
  deleteRecordedStage(gatePassedRef(issue));
  deleteRecordedStage(repairRef(issue));
}

function deleteRecordedCompletion(issue: PlannedIssue) {
  if (recordedCompletion(issue) !== undefined) {
    runFile("git", ["update-ref", "-d", completionRef(issue)]);
  }
}

function commitIsAncestor(
  worktreePath: string,
  ancestor: string,
  descendant: string
) {
  try {
    runFile("git", [
      "-C",
      worktreePath,
      "merge-base",
      "--is-ancestor",
      ancestor,
      descendant,
    ]);
    return true;
  } catch {
    return false;
  }
}

async function createIssueSandbox(issue: PlannedIssue) {
  prepareLocalIssueBranch(issue.branch);
  const sandbox = await createSandbox({
    branch: issue.branch,
    cwd: REPO_ROOT,
    sandbox: sandboxProvider(),
  });
  try {
    syncWorktreeWithOrigin(sandbox.worktreePath, issue.branch);
    const setup = await sandbox.exec(
      boundedSandboxCommand(
        "gh auth setup-git && bun install --cwd next --frozen-lockfile"
      ),
      { onLine: (line) => console.log(`  ${line}`) }
    );
    if (setup.exitCode !== 0) {
      throw new Error(
        `Sandbox setup failed for #${issue.id} with exit code ${setup.exitCode}.`
      );
    }
    return sandbox;
  } catch (error) {
    await sandbox.close();
    throw error;
  }
}

function prepareLocalIssueBranch(branch: string) {
  const remote = tryFile("git", [
    "ls-remote",
    "--exit-code",
    "--heads",
    "origin",
    branch,
  ]);
  if (!remote.trim()) {
    return;
  }
  runFile("git", [
    "fetch",
    "--no-tags",
    "origin",
    `refs/heads/${branch}:refs/remotes/origin/${branch}`,
  ]);
  const local = tryFile("git", [
    "show-ref",
    "--verify",
    `refs/heads/${branch}`,
  ]);
  if (!local.trim()) {
    runFile("git", ["branch", branch, `origin/${branch}`]);
  }
}

function syncWorktreeWithOrigin(worktreePath: string, branch: string) {
  const remote = tryFile("git", [
    "ls-remote",
    "--exit-code",
    "--heads",
    "origin",
    branch,
  ]);
  if (!remote.trim()) {
    return;
  }
  runFile("git", [
    "-C",
    worktreePath,
    "fetch",
    "--no-tags",
    "origin",
    `refs/heads/${branch}:refs/remotes/origin/${branch}`,
  ]);
  runFile("git", [
    "-C",
    worktreePath,
    "merge",
    "--ff-only",
    `origin/${branch}`,
  ]);
}

async function runUiImplementation(issue: PlannedIssue, sandbox: Sandbox) {
  const ui = await sandbox.run({
    agent: uiAgent(),
    idleTimeoutSeconds: AGENT_IDLE_TIMEOUT_SECONDS,
    maxIterations: 2,
    name: `ui-builder-${issue.id}`,
    promptArgs: issuePromptArgs(issue),
    promptFile: ".sandcastle/ui-prompt.md",
    signal: agentRunSignal(),
  });
  assertAgentCompleted(ui, `UI implementation for #${issue.id}`);
  recordProgress(issue, worktreeHead(sandbox.worktreePath));
  deleteRecordedStage(implementationRef(issue));
  return ui.commits;
}

async function runReviewAndGate(
  issue: PlannedIssue,
  sandbox: Sandbox,
  trackBuildProgress = true,
  skipUiReview = false
) {
  const commits = await runModifyingReview(
    issue,
    sandbox,
    trackBuildProgress,
    skipUiReview
  );
  if (trackBuildProgress) {
    const reviewedHead = worktreeHead(sandbox.worktreePath);
    recordGatePendingCheckpoint(issue, reviewedHead);
    deleteRecordedStage(uiReviewRef(issue));
  }
  commits.push(...(await enforceLocalGate(issue, sandbox, trackBuildProgress)));
  if (trackBuildProgress) {
    recordGatePassed(issue, worktreeHead(sandbox.worktreePath));
  }
  return commits;
}

async function runRecoverableReviewAndGate(
  issue: PlannedIssue,
  sandbox: Sandbox
) {
  const currentHead = worktreeHead(sandbox.worktreePath);
  if (recordedGatePassed(issue) === currentHead) {
    return [];
  }
  if (recordedGatePending(issue) === currentHead) {
    const commits = await enforceLocalGate(issue, sandbox, true);
    recordGatePassed(issue, worktreeHead(sandbox.worktreePath));
    return commits;
  }
  return runReviewAndGate(
    issue,
    sandbox,
    true,
    recordedUiReview(issue) === currentHead
  );
}

async function runModifyingReview(
  issue: PlannedIssue,
  sandbox: Sandbox,
  trackBuildProgress: boolean,
  skipUiReview: boolean
) {
  const commits: Array<{ sha: string }> = [];
  if (issue.needsUi && !skipUiReview) {
    const uiReview = await sandbox.run({
      agent: uiAgent(),
      idleTimeoutSeconds: AGENT_IDLE_TIMEOUT_SECONDS,
      maxIterations: 1,
      name: `pre-publish-ui-review-${issue.id}`,
      promptArgs: issuePromptArgs(issue),
      promptFile: ".sandcastle/ui-review-prompt.md",
      signal: agentRunSignal(),
    });
    assertAgentCompleted(uiReview, `UI review for #${issue.id}`);
    commits.push(...uiReview.commits);
    if (trackBuildProgress) {
      recordUiReview(issue, worktreeHead(sandbox.worktreePath));
    }
  }

  const review = await sandbox.run({
    agent: allAroundAgent(),
    idleTimeoutSeconds: AGENT_IDLE_TIMEOUT_SECONDS,
    maxIterations: 1,
    name: `pre-publish-code-review-${issue.id}`,
    promptArgs: issuePromptArgs(issue),
    promptFile: ".sandcastle/review-prompt.md",
    signal: agentRunSignal(),
  });
  assertAgentCompleted(review, `code review for #${issue.id}`);
  commits.push(...review.commits);
  return commits;
}

async function enforceLocalGate(
  issue: PlannedIssue,
  sandbox: Sandbox,
  trackBuildProgress: boolean
) {
  const commits: Array<{ sha: string }> = [];
  let infrastructureRetryUsed = false;
  for (let attempt = 0; ; attempt++) {
    assertWorktreeClean(
      sandbox.worktreePath,
      `before the gate for #${issue.id}`
    );
    const gatedHead = worktreeHead(sandbox.worktreePath);
    const releaseGateSlot = await acquireGateSlot();
    const result = await sandbox
      .exec(boundedSandboxCommand(FULL_GATE), {
        onLine: (line) => console.log(`  ${line}`),
      })
      .finally(releaseGateSlot);
    if (worktreeHead(sandbox.worktreePath) !== gatedHead) {
      throw new Error(`Branch head moved while gating #${issue.id}.`);
    }
    if (result.exitCode === 0) {
      assertWorktreeClean(
        sandbox.worktreePath,
        `after the gate for #${issue.id}`
      );
      return commits;
    }
    if (
      attempt >= MAX_LOCAL_GATE_REPAIR_ATTEMPTS ||
      infrastructureRetryUsed ||
      recordedRepair(issue) === gatedHead
    ) {
      throw new Error(
        `Local gate failed for #${issue.id} with exit code ${result.exitCode}.`
      );
    }
    const repair = await sandbox.run({
      agent: allAroundAgent(),
      idleTimeoutSeconds: AGENT_IDLE_TIMEOUT_SECONDS,
      maxIterations: 1,
      name: `local-gate-repair-${issue.id}-${attempt + 1}`,
      promptArgs: {
        ...issuePromptArgs(issue),
        GATE_CONTEXT: boundedGateFailureContext(result),
      },
      promptFile: ".sandcastle/verify-fix-prompt.md",
      signal: agentRunSignal(),
    });
    const repairedHead = worktreeHead(sandbox.worktreePath);
    if (canRetryGateAfterIncompleteRepair(repair, gatedHead, repairedHead)) {
      assertWorktreeClean(
        sandbox.worktreePath,
        `after an infrastructure-blocked gate repair for #${issue.id}`
      );
      console.warn(
        `  Repair for #${issue.id} reported an infrastructure blocker; retrying the unchanged gate once.`
      );
      infrastructureRetryUsed = true;
      continue;
    }
    assertAgentCompleted(repair, `local gate repair for #${issue.id}`);
    if (trackBuildProgress) {
      recordGateRepairCheckpoint(issue, repairedHead);
    }
    commits.push(...repair.commits);
  }
}

async function reviewPublishedBranch(issue: PlannedIssue, prUrl: string) {
  console.log(`  Reviewing current PR head: ${prUrl}`);
  const sandbox = await createIssueSandbox(issue);
  let reviewedLocalHead: string;
  try {
    await runRecoverableReviewAndGate(issue, sandbox);
    reviewedLocalHead = worktreeHead(sandbox.worktreePath);
  } finally {
    await sandbox.close();
  }
  if (reviewedHeadNeedsPush(requiredPrHead(prUrl), reviewedLocalHead)) {
    pushIssueBranch(issue.branch, reviewedLocalHead);
  }
  if (!reviewIsComplete(prUrl)) {
    runFile("gh", ["pr", "comment", prUrl, "--body", REVIEW_MARKER]);
  }
  await waitForPrHead(prUrl, reviewedLocalHead);
  recordPullRequestReviewedHead(issue, prUrl, reviewedLocalHead);
  deleteRecordedStages(issue);
  return reviewedLocalHead;
}

async function preparePrForMerge(
  issue: PlannedIssue,
  prUrl: string
): Promise<string | undefined> {
  if (!(await ensureBranchUpToDate(issue, prUrl))) {
    return undefined;
  }
  const status = getPrStatus(prUrl);
  if (status.state === "MERGED" || status.mergedAt) {
    throw new Error(`Cannot prepare an already merged PR: ${prUrl}`);
  }
  const pullRequest = issueGraphSource.pullRequest(issue.branch);
  if (pullRequest === undefined || pullRequest.url !== prUrl) {
    throw new Error(`Could not bind ${prUrl} to branch ${issue.branch}.`);
  }
  assertPullRequestTargets(pullRequest, BASE_BRANCH, issue.branch);
  const durableReviewedHead = reviewedHeadFromBody(pullRequest.body);
  if (durableReviewedHead === status.headRefOid) {
    console.log(
      `  Reusing reviewed PR head ${status.headRefOid.slice(0, 12)}.`
    );
    const reviewedHead = assertReviewedHead(prUrl, durableReviewedHead);
    deleteRecordedStages(issue);
    return reviewedHead;
  }
  const completedHead = recordedCompletion(issue);
  if (canReuseCompletedHead(completedHead, status.headRefOid)) {
    console.log(
      `  Reusing pre-publish review and gate for ${status.headRefOid.slice(0, 12)}.`
    );
    recordPullRequestReviewedHead(issue, prUrl, status.headRefOid);
    const reviewedHead = assertReviewedHead(prUrl, status.headRefOid);
    deleteRecordedStages(issue);
    return reviewedHead;
  }
  const reviewedHead = await reviewPublishedBranch(issue, prUrl);
  return assertReviewedHead(prUrl, reviewedHead);
}

function recordPullRequestReviewedHead(
  issue: PlannedIssue,
  prUrl: string,
  reviewedHead: string
) {
  const pullRequest = issueGraphSource.pullRequest(issue.branch);
  if (pullRequest === undefined || pullRequest.url !== prUrl) {
    throw new Error(`Could not bind ${prUrl} to branch ${issue.branch}.`);
  }
  assertPullRequestTargets(pullRequest, BASE_BRANCH, issue.branch);
  if (pullRequest.state !== "OPEN") {
    throw new Error(`Cannot record review for non-open PR: ${prUrl}.`);
  }
  assertPrHead(prUrl, reviewedHead);
  const body = recordReviewedHead(pullRequest.body, reviewedHead);
  if (body !== pullRequest.body) {
    runFile("gh", ["pr", "edit", prUrl, "--body", body]);
  }
  const confirmed = issueGraphSource.pullRequest(issue.branch);
  if (
    confirmed === undefined ||
    confirmed.url !== prUrl ||
    confirmed.state !== "OPEN" ||
    !confirmed.body.includes(reviewedHeadMarker(reviewedHead))
  ) {
    throw new Error(`PR did not retain reviewed head ${reviewedHead}.`);
  }
  assertPullRequestTargets(confirmed, BASE_BRANCH, issue.branch);
  assertPrHead(prUrl, reviewedHead);
}

async function ensureBranchUpToDate(issue: PlannedIssue, prUrl: string) {
  for (let attempt = 1; attempt <= MAX_REPAIR_ATTEMPTS + 1; attempt++) {
    const status = getPrStatus(prUrl);
    if (status.state === "MERGED" || status.mergedAt) {
      return true;
    }
    if (
      status.mergeStateStatus === "DIRTY" ||
      status.mergeable === "CONFLICTING"
    ) {
      if (attempt > MAX_REPAIR_ATTEMPTS) {
        return false;
      }
      await repairConflict(issue, prUrl, attempt);
      continue;
    }
    if (status.mergeStateStatus === "BEHIND") {
      if (attempt > MAX_REPAIR_ATTEMPTS) {
        return false;
      }
      await updateBehindBranch(issue, prUrl);
      continue;
    }
    return true;
  }
  return false;
}

async function updateBehindBranch(issue: PlannedIssue, prUrl: string) {
  const sandbox = await createIssueSandbox(issue);
  let reviewedLocalHead: string;
  try {
    const baseRef = `origin/${BASE_BRANCH}`;
    const merge = await sandbox.exec(
      boundedSandboxCommand(
        `git fetch --no-tags origin ${shellQuote(BASE_BRANCH)} && git merge --no-edit ${shellQuote(baseRef)}`
      ),
      { onLine: (line) => console.log(`  ${line}`) }
    );
    if (merge.exitCode !== 0) {
      await sandbox.exec(boundedSandboxCommand("git merge --abort"));
      throw new Error(`Could not update ${issue.branch} from ${BASE_BRANCH}.`);
    }
    await runRecoverableReviewAndGate(issue, sandbox);
    reviewedLocalHead = worktreeHead(sandbox.worktreePath);
  } finally {
    await sandbox.close();
  }
  pushIssueBranch(issue.branch, reviewedLocalHead);
  await waitForPrHead(prUrl, reviewedLocalHead);
  recordPullRequestReviewedHead(issue, prUrl, reviewedLocalHead);
  deleteRecordedStages(issue);
}

async function repairConflict(
  issue: PlannedIssue,
  prUrl: string,
  attempt: number
) {
  const sandbox = await createIssueSandbox(issue);
  let reviewedLocalHead: string;
  try {
    const repair = await sandbox.run({
      agent: allAroundAgent(),
      idleTimeoutSeconds: AGENT_IDLE_TIMEOUT_SECONDS,
      maxIterations: 1,
      name: `pr-conflict-repair-${issue.id}-${attempt}`,
      promptArgs: {
        ...issuePromptArgs(issue),
        BASE_BRANCH,
        PR_URL: prUrl,
      },
      promptFile: ".sandcastle/pr-conflict-repair-prompt.md",
      signal: agentRunSignal(),
    });
    assertAgentCompleted(repair, `conflict repair for #${issue.id}`);
    await runRecoverableReviewAndGate(issue, sandbox);
    reviewedLocalHead = worktreeHead(sandbox.worktreePath);
  } finally {
    await sandbox.close();
  }
  pushIssueBranch(issue.branch, reviewedLocalHead);
  await waitForPrHead(prUrl, reviewedLocalHead);
  recordPullRequestReviewedHead(issue, prUrl, reviewedLocalHead);
  deleteRecordedStages(issue);
  return reviewedLocalHead;
}

function publishIssuePr(issue: PlannedIssue) {
  const completedHead = recordedCompletion(issue);
  if (completedHead === undefined) {
    throw new Error(
      `Refusing to publish #${issue.id} without a completed head.`
    );
  }
  if (localBranchHead(issue.branch) !== completedHead) {
    throw new Error(
      `Refusing to publish #${issue.id}: local head does not match its completed head.`
    );
  }
  pushIssueBranch(issue.branch, completedHead);
  const existing = findIssuePr(issue);
  if (existing) {
    return existing;
  }
  return runFile("gh", [
    "pr",
    "create",
    "--base",
    BASE_BRANCH,
    "--head",
    issue.branch,
    "--draft",
    "--title",
    `Sandcastle: ${issue.title}`,
    "--body",
    [
      `Closes #${issue.id}`,
      "",
      "Implemented and reviewed by the local Sandcastle workflow.",
      "",
      REVIEW_MARKER,
    ].join("\n"),
  ]).trim();
}

function pushIssueBranch(branch: string, expectedHead: string) {
  if (localBranchHead(branch) !== expectedHead) {
    throw new Error(`Refusing to push moved branch ${branch}.`);
  }
  runFile("git", [
    "push",
    "--set-upstream",
    "origin",
    `${expectedHead}:refs/heads/${branch}`,
  ]);
}

function findIssuePr(issue: PlannedIssue) {
  return (
    tryFile("gh", [
      "pr",
      "view",
      issue.branch,
      "--json",
      "url",
      "--jq",
      ".url",
    ]).trim() || undefined
  );
}

function reviewIsComplete(prUrl: string) {
  const text = tryFile("gh", [
    "pr",
    "view",
    prUrl,
    "--json",
    "body,comments",
    "--jq",
    '[.body, .comments[].body] | join("\\n")',
  ]);
  return text.includes(REVIEW_MARKER);
}

function mergePr(prUrl: string, headSha: string) {
  runFile("gh", mergePullRequestArgs(prUrl, headSha));
  console.log(`  Merged ${prUrl}`);
}

function getPrStatus(prUrl: string) {
  const json = runFile("gh", [
    "pr",
    "view",
    prUrl,
    "--json",
    "state,mergedAt,mergeStateStatus,mergeable,headRefOid,isDraft",
  ]);
  return prStatusSchema.parse(JSON.parse(json));
}

function requiredPrHead(prUrl: string) {
  const head = getPrStatus(prUrl).headRefOid;
  if (!head) {
    throw new Error(`Could not resolve the PR head for ${prUrl}.`);
  }
  return head;
}

function assertPrHead(prUrl: string, expectedHead: string) {
  const currentHead = requiredPrHead(prUrl);
  if (currentHead !== expectedHead) {
    throw new Error(
      `PR head mismatch: expected ${expectedHead}, received ${currentHead}.`
    );
  }
}

async function waitForPrHead(prUrl: string, expectedHead: string) {
  await waitForExpectedPrHead({
    expectedHead,
    now: Date.now,
    pause: async () => {
      await sleep(1000);
    },
    readHead: () => requiredPrHead(prUrl),
    timeoutMs: PR_HEAD_OBSERVATION_TIMEOUT_MS,
  });
}

function localBranchHead(branch: string) {
  return runFile("git", ["rev-parse", branch]).trim();
}

function assertReviewedHead(prUrl: string, reviewedHead: string) {
  const currentHead = requiredPrHead(prUrl);
  if (currentHead !== reviewedHead) {
    throw new Error(
      `PR head moved after review: expected ${reviewedHead}, received ${currentHead}.`
    );
  }
  return reviewedHead;
}

function issuePromptArgs(issue: PlannedIssue) {
  return {
    ANCESTOR_PATH: issue.ancestorPath
      .map((ancestor) => `#${ancestor.number} ${ancestor.title}`)
      .join(" -> "),
    BRANCH: issue.branch,
    ISSUE_TITLE: issue.title,
    NEEDS_UI: String(issue.needsUi),
    ROOT_ID: String(issue.root.number),
    ROOT_TITLE: issue.root.title,
    TASK_ID: issue.id,
    UI_BRIEF: issue.uiBrief ?? "No dedicated UI phase requested.",
    VERIFICATION_POLICY,
  };
}

function assertHostReady() {
  if (currentBranch() !== BASE_BRANCH) {
    throw new Error(
      `Run Sandcastle from ${BASE_BRANCH}; current branch is ${currentBranch()}.`
    );
  }
  if (runFile("git", ["status", "--porcelain"]).trim()) {
    throw new Error("Commit or stash host changes before running Sandcastle.");
  }
  runFile("docker", ["image", "inspect", SANDBOX_IMAGE_NAME]);
  runFile("gh", ["auth", "status"]);
  requiredEnv("SANDCASTLE_AGENT_GH_TOKEN");
  assertDirectoryExists(HOST_OPENCODE_CONFIG);
  assertFileExists(HOST_OPENCODE_AUTH);
  assertFileExists(HOST_OPENCODE_ACCOUNT);
}

function refreshBaseBranch() {
  runFile("git", ["fetch", "origin", BASE_BRANCH]);
  runFile("git", ["pull", "--ff-only", "origin", BASE_BRANCH]);
}

function syncPlannerBranchToBase() {
  const branch = "sandcastle/planner";
  const worktreePath = resolve(
    REPO_ROOT,
    ".sandcastle/worktrees/sandcastle-planner"
  );
  if (existsSync(worktreePath)) {
    assertWorktreeClean(worktreePath, "before planner synchronization");
    runFile("git", ["-C", worktreePath, "merge", "--ff-only", BASE_BRANCH]);
    return;
  }

  const local = tryFile("git", [
    "show-ref",
    "--verify",
    `refs/heads/${branch}`,
  ]);
  if (!local.trim()) {
    return;
  }
  runFile("git", ["merge-base", "--is-ancestor", branch, BASE_BRANCH]);
  runFile("git", ["branch", "-f", branch, BASE_BRANCH]);
}

function assertWorktreeClean(worktreePath: string, context: string) {
  const status = runFile("git", [
    "-C",
    worktreePath,
    "status",
    "--porcelain",
  ]).trim();
  if (status) {
    throw new Error(`Sandcastle worktree is dirty ${context}:\n${status}`);
  }
}

function worktreeHead(worktreePath: string) {
  return runFile("git", ["-C", worktreePath, "rev-parse", "HEAD"]).trim();
}

function baseBranchHead(worktreePath: string) {
  return runFile("git", ["-C", worktreePath, "rev-parse", BASE_BRANCH]).trim();
}

function currentBranch() {
  return runFile("git", ["branch", "--show-current"]).trim();
}

function defaultBranch() {
  const branch = tryFile("gh", [
    "repo",
    "view",
    "--json",
    "defaultBranchRef",
    "--jq",
    ".defaultBranchRef.name",
  ]).trim();
  if (!branch) {
    throw new Error("Could not determine the repository default branch.");
  }
  return branch;
}

function runFile(command: string, args: string[]) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: HOST_COMMAND_TIMEOUT_MS,
  });
}

function runFileWithInput(command: string, args: string[], input: string) {
  return execFileSync(command, args, {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: HOST_COMMAND_TIMEOUT_MS,
  });
}

function tryFile(command: string, args: string[]) {
  try {
    return runFile(command, args);
  } catch (error) {
    if (typeof error === "object" && error !== null && "stdout" in error) {
      const { stdout } = error;
      if (typeof stdout === "string") {
        return stdout;
      }
    }
    return "";
  }
}

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be set in .sandcastle/.env.`);
  }
  return value;
}

function boundedSandboxCommand(command: string) {
  return [
    "timeout",
    "--signal=TERM",
    "--kill-after=10s",
    `${SANDBOX_COMMAND_TIMEOUT_SECONDS}s`,
    "sh",
    "-c",
    shellQuote(command),
  ].join(" ");
}

function agentRunSignal() {
  return AbortSignal.timeout(AGENT_RUN_TIMEOUT_MS);
}

function assertFileExists(path: string) {
  if (!(existsSync(path) && statSync(path).isFile())) {
    throw new Error(`Required Sandcastle credential file is missing: ${path}`);
  }
}

function assertDirectoryExists(path: string) {
  if (!(existsSync(path) && statSync(path).isDirectory())) {
    throw new Error(`Required Sandcastle directory is missing: ${path}`);
  }
}

function createSlotLimiter(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  return async () => {
    if (active >= limit) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active++;
    return () => {
      active--;
      queue.shift()?.();
    };
  };
}

function positiveIntegerEnv(name: string, fallback: number) {
  const value =
    process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function nonNegativeIntegerEnv(name: string, fallback: number) {
  const value =
    process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return value;
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
