export const canReuseCompletedHead = (
  completedHead: string | undefined,
  pullRequestHead: string
) => completedHead !== undefined && completedHead === pullRequestHead;

export const shellQuote = (value: string) =>
  `'${value.replaceAll("'", `'"'"'`)}'`;

export const reviewedHeadNeedsPush = (
  pullRequestHead: string,
  reviewedLocalHead: string
) => pullRequestHead !== reviewedLocalHead;

export const hostCheckoutProblem = (
  baseBranch: string,
  currentBranch: string,
  status: string
) => {
  const dirty = status.trim().length > 0;
  if (currentBranch !== baseBranch) {
    return `Sandcastle must start from a clean ${baseBranch} checkout, but the host is on ${currentBranch}.${dirty ? " The checkout also has uncommitted changes." : ""} Restore a clean ${baseBranch} checkout before restarting Sandcastle; after startup, the runner uses its detached base worktree.`;
  }
  if (dirty) {
    return `Sandcastle must start from a clean ${baseBranch} checkout. Commit or stash host changes before restarting Sandcastle.`;
  }
  return undefined;
};

export const runnerBaseReuseProblem = (
  sourceCommonDirectory: string,
  runnerCommonDirectory: string,
  attachedBranch: string,
  hasExpectedLineage: boolean
) => {
  if (sourceCommonDirectory !== runnerCommonDirectory) {
    return "Runner base path belongs to a different Git repository.";
  }
  if (attachedBranch) {
    return `Runner base worktree must remain detached, but it is attached to ${attachedBranch}.`;
  }
  if (!hasExpectedLineage) {
    return "Runner base HEAD has diverged from the configured local base branch.";
  }
  return undefined;
};

export const refreshDetachedBase = (
  baseBranch: string,
  runGit: (args: string[]) => void
) => {
  runGit([
    "fetch",
    "--no-tags",
    "origin",
    `refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`,
  ]);
  runGit(["merge", "--ff-only", `origin/${baseBranch}`]);
};

export const attemptHostStep = (operation: () => void) => {
  try {
    operation();
    return { ok: true } as const;
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : String(error),
      ok: false,
    } as const;
  }
};

export const mergePullRequestArgs = (prUrl: string, headSha: string) => [
  "pr",
  "merge",
  prUrl,
  "--squash",
  "--match-head-commit",
  headSha,
];
