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

export const mergePullRequestArgs = (prUrl: string, headSha: string) => [
  "pr",
  "merge",
  prUrl,
  "--squash",
  "--match-head-commit",
  headSha,
];
