export const PRE_PUBLISH_REVIEW_MARKER =
  "<!-- sandcastle-pre-publish-review-complete -->";
const commitShaPattern = /^[0-9a-f]{40,64}$/;
const reviewedHeadPattern =
  /<!-- sandcastle-reviewed-head:@([0-9a-f]{40,64}) -->/g;

const issueNumber = (value: number) => {
  if (!(Number.isSafeInteger(value) && value > 0)) {
    throw new Error("issue number must be a positive safe integer");
  }
  return value;
};

const commitSha = (value: string) => {
  if (!commitShaPattern.test(value)) {
    throw new Error(
      "commit SHA must contain 40 to 64 lowercase hex characters"
    );
  }
  return value;
};

export const implementationMarker = (value: number, headSha: string) =>
  `<!-- sandcastle-implemented:#${issueNumber(value)}@${commitSha(headSha)} -->`;

export const reviewedHeadMarker = (headSha: string) =>
  `<!-- sandcastle-reviewed-head:@${commitSha(headSha)} -->`;

export const reviewedHeadFromBody = (body: string) => {
  const matches = [...body.matchAll(reviewedHeadPattern)];
  if (matches.length > 1) {
    throw new Error(
      "pull request body contains ambiguous reviewed-head markers"
    );
  }
  return matches[0]?.[1];
};

export const recordReviewedHead = (body: string, headSha: string) => {
  const withoutExisting = body.replaceAll(reviewedHeadPattern, "").trimEnd();
  return [withoutExisting, "", reviewedHeadMarker(headSha)].join("\n");
};

export const createSpecPullRequestBody = (
  rootIssueNumber: number,
  implementedLeafNumber: number,
  acceptedHeadSha: string
) => {
  const root = issueNumber(rootIssueNumber);
  return [
    `Implements the descendant issues of #${root} on one cumulative branch.`,
    "",
    `Tracks #${root}`,
    "",
    PRE_PUBLISH_REVIEW_MARKER,
    implementationMarker(implementedLeafNumber, acceptedHeadSha),
  ].join("\n");
};

export const appendSpecProgress = (
  body: string,
  rootIssueNumber: number,
  implementedLeafNumber: number,
  acceptedHeadSha: string
) => {
  const rootReference = `Tracks #${issueNumber(rootIssueNumber)}`;
  const marker = implementationMarker(implementedLeafNumber, acceptedHeadSha);
  const baseBody = body.includes(marker)
    ? body
    : body.replaceAll(reviewedHeadPattern, "").trimEnd();
  const additions = [rootReference, PRE_PUBLISH_REVIEW_MARKER, marker].filter(
    (value) => !baseBody.includes(value)
  );
  return additions.length === 0
    ? baseBody
    : [baseBody.trimEnd(), "", ...additions].join("\n");
};

export const specClosureOrder = (
  descendantIssueNumbers: readonly number[],
  rootIssueNumber: number
) => {
  const root = issueNumber(rootIssueNumber);
  const descendants = descendantIssueNumbers.map(issueNumber);
  if (new Set(descendants).size !== descendants.length) {
    throw new Error("descendant issue numbers must be unique");
  }
  if (descendants.includes(root)) {
    throw new Error("the root cannot also be a descendant");
  }
  return [...descendants].reverse().concat(root);
};

export const assertPullRequestTargets = (
  pullRequest: {
    readonly baseRefName: string;
    readonly headRefName: string;
    readonly isCrossRepository: boolean;
  },
  expectedBase: string,
  expectedHead: string
) => {
  if (
    pullRequest.baseRefName !== expectedBase ||
    pullRequest.headRefName !== expectedHead ||
    pullRequest.isCrossRepository
  ) {
    throw new Error(
      `Pull request must target ${expectedBase} from owned branch ${expectedHead}.`
    );
  }
};
