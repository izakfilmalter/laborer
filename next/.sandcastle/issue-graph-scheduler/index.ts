import { reviewedHeadFromBody } from "../spec-pr-progress/index.ts";

export interface IssueIdentity {
  readonly number: number;
  readonly title: string;
}

export interface GitHubIssue extends IssueIdentity {
  readonly childNumbers: readonly number[];
  readonly openBlockers: readonly IssueIdentity[];
  readonly parentNumber?: number;
  readonly state: "CLOSED" | "OPEN";
}

export interface ExistingPullRequest {
  readonly baseRefName: string;
  readonly body: string;
  readonly headRefName: string;
  readonly isCrossRepository: boolean;
  readonly isDraft: boolean;
  readonly state: "CLOSED" | "MERGED" | "OPEN";
  readonly url: string;
}

export interface IssueGraphSource {
  readonly baseBranch: string;
  readonly issue: (number: number) => GitHubIssue;
  readonly pullRequest: (branch: string) => ExistingPullRequest | undefined;
}

export interface RunnableIssue {
  readonly ancestorPath: readonly IssueIdentity[];
  readonly branch: string;
  readonly descendantLeafNumbers: readonly number[];
  readonly issue: IssueIdentity;
  readonly kind: "spec-leaf" | "standalone";
  readonly latestImplementedHead?: string;
  readonly parent: IssueIdentity | null;
  readonly pullRequest?: ExistingPullRequest;
  readonly root: IssueIdentity;
}

export interface WaitingLeaf {
  readonly ancestorPath: readonly IssueIdentity[];
  readonly leaf: IssueIdentity;
  readonly openBlockers: readonly IssueIdentity[];
}

export interface WaitingIssueRoot {
  readonly blockedLeaves: readonly WaitingLeaf[];
  readonly branch: string;
  readonly descendantLeafNumbers: readonly number[];
  readonly pullRequest?: ExistingPullRequest;
  readonly root: IssueIdentity;
}

export interface FinalizeIssueSpec {
  readonly branch: string;
  readonly descendantIssueNumbers: readonly number[];
  readonly descendantLeafNumbers: readonly number[];
  readonly expectedHeadSha: string;
  readonly pullRequest: ExistingPullRequest;
  readonly root: IssueIdentity;
}

export interface IssueGraphSchedule {
  readonly finalize: readonly FinalizeIssueSpec[];
  readonly runnable: readonly RunnableIssue[];
  readonly waiting: readonly WaitingIssueRoot[];
}

export class IssueGraphRelationshipError extends Error {
  override readonly name = "IssueGraphRelationshipError";
}

interface DescendantLeaf {
  readonly ancestorPath: readonly IssueIdentity[];
  readonly issue: GitHubIssue;
  readonly parent: GitHubIssue;
}

const identity = (issue: GitHubIssue): IssueIdentity => ({
  number: issue.number,
  title: issue.title,
});

const withPullRequest = <Value extends object>(
  value: Value,
  pullRequest: ExistingPullRequest | undefined
): Value & { readonly pullRequest?: ExistingPullRequest } =>
  pullRequest === undefined ? value : { ...value, pullRequest };

const scheduleStandalone = (
  root: GitHubIssue,
  source: IssueGraphSource,
  runnable: RunnableIssue[],
  waiting: WaitingIssueRoot[]
) => {
  if (root.state !== "OPEN") {
    return;
  }
  const rootIdentity = identity(root);
  const branch = `sandcastle/issue-${root.number}`;
  const pullRequest = source.pullRequest(branch);
  assertPullRequestIsRecoverable(branch, pullRequest, source.baseBranch);
  if (root.openBlockers.length === 0) {
    runnable.push(
      withPullRequest(
        {
          ancestorPath: [rootIdentity],
          branch,
          descendantLeafNumbers: [],
          issue: rootIdentity,
          kind: "standalone" as const,
          parent: null,
          root: rootIdentity,
        },
        pullRequest
      )
    );
    return;
  }
  waiting.push(
    withPullRequest(
      {
        blockedLeaves: [
          {
            ancestorPath: [rootIdentity],
            leaf: rootIdentity,
            openBlockers: root.openBlockers,
          },
        ],
        branch,
        descendantLeafNumbers: [],
        root: rootIdentity,
      },
      pullRequest
    )
  );
};

const implementedMarkers = (
  pullRequest: ExistingPullRequest | undefined
): readonly { issueNumber: number; headSha: string }[] => {
  const implemented: { issueNumber: number; headSha: string }[] = [];
  if (pullRequest === undefined || pullRequest.state === "CLOSED") {
    return implemented;
  }
  const marker =
    /<!-- sandcastle-implemented:#([1-9]\d*)@([0-9a-f]{40,64}) -->/g;
  for (const match of pullRequest.body.matchAll(marker)) {
    const number = Number(match[1]);
    const headSha = match[2];
    if (Number.isSafeInteger(number) && headSha !== undefined) {
      implemented.push({ headSha, issueNumber: number });
    }
  }
  return implemented;
};

const reviewedHead = (pullRequest: ExistingPullRequest | undefined) =>
  pullRequest === undefined
    ? undefined
    : reviewedHeadFromBody(pullRequest.body);

export const scheduleIssueGraph = (
  source: IssueGraphSource,
  readyIssueNumbers: readonly number[]
): IssueGraphSchedule => {
  const issueCache = new Map<number, GitHubIssue>();
  const loadIssue = (number: number): GitHubIssue => {
    const cached = issueCache.get(number);
    if (cached !== undefined) {
      return cached;
    }
    const loaded = source.issue(number);
    if (loaded.number !== number) {
      throw new IssueGraphRelationshipError(
        `source returned issue #${loaded.number} for requested issue #${number}`
      );
    }
    issueCache.set(number, loaded);
    return loaded;
  };

  const findRoot = (readyNumber: number): GitHubIssue => {
    let current = loadIssue(readyNumber);
    const path = new Set<number>();
    while (current.parentNumber !== undefined) {
      if (path.has(current.number)) {
        throw new IssueGraphRelationshipError(
          `parent cycle includes issue #${current.number}`
        );
      }
      path.add(current.number);
      const childNumber = current.number;
      const parent = loadIssue(current.parentNumber);
      const occurrences = parent.childNumbers.filter(
        (number) => number === childNumber
      ).length;
      if (occurrences !== 1) {
        throw new IssueGraphRelationshipError(
          `issue #${childNumber} is not one direct child of parent #${parent.number}`
        );
      }
      current = parent;
    }
    return current;
  };

  const roots: GitHubIssue[] = [];
  const seenRoots = new Set<number>();
  for (const readyNumber of readyIssueNumbers) {
    const root = findRoot(readyNumber);
    if (!seenRoots.has(root.number)) {
      seenRoots.add(root.number);
      roots.push(root);
    }
  }

  const runnable: RunnableIssue[] = [];
  const waiting: WaitingIssueRoot[] = [];
  const finalize: FinalizeIssueSpec[] = [];

  for (const root of roots) {
    const rootIdentity = identity(root);
    if (root.childNumbers.length === 0) {
      scheduleStandalone(root, source, runnable, waiting);
      continue;
    }

    const branch = `sandcastle/spec-${root.number}`;
    const pullRequest = source.pullRequest(branch);
    assertPullRequestIsRecoverable(branch, pullRequest, source.baseBranch);
    const leaves: DescendantLeaf[] = [];
    const containers: GitHubIssue[] = [root];
    const descendantIssueNumbers: number[] = [];
    const visited = new Set<number>([root.number]);
    const visitChildren = (
      parent: GitHubIssue,
      parentPath: readonly IssueIdentity[]
    ): void => {
      const directChildren = new Set<number>();
      for (const childNumber of parent.childNumbers) {
        if (directChildren.has(childNumber) || visited.has(childNumber)) {
          throw new IssueGraphRelationshipError(
            `issue #${childNumber} appears more than once under root #${root.number}`
          );
        }
        directChildren.add(childNumber);
        visited.add(childNumber);
        descendantIssueNumbers.push(childNumber);
        const child = loadIssue(childNumber);
        if (child.parentNumber !== parent.number) {
          throw new IssueGraphRelationshipError(
            `issue #${child.number} does not name #${parent.number} as its parent`
          );
        }
        const childPath = [...parentPath, identity(child)];
        if (child.childNumbers.length === 0) {
          leaves.push({ ancestorPath: childPath, issue: child, parent });
        } else {
          containers.push(child);
          visitChildren(child, childPath);
        }
      }
    };
    visitChildren(root, [rootIdentity]);

    const descendantLeafNumbers = leaves.map((leaf) => leaf.issue.number);
    const descendantLeafNumberSet = new Set(descendantLeafNumbers);
    const validMarkers = implementedMarkers(pullRequest).filter((marker) =>
      descendantLeafNumberSet.has(marker.issueNumber)
    );
    const implemented = new Set(
      validMarkers.map((marker) => marker.issueNumber)
    );
    const latestImplementedHead = validMarkers.at(-1)?.headSha;
    const latestReviewedHead = reviewedHead(pullRequest);
    assertDescendantStateIsConsistent(
      root,
      containers,
      leaves,
      pullRequest,
      implemented
    );
    const unresolvedBlockers = (leaf: DescendantLeaf) =>
      leaf.issue.openBlockers.filter(
        (blocker) => !implemented.has(blocker.number)
      );
    const remaining = leaves.filter(
      ({ issue }) => issue.state === "OPEN" && !implemented.has(issue.number)
    );
    assertPullRequestCanScheduleRemaining(
      branch,
      pullRequest,
      remaining.length
    );
    const selected = remaining.find(
      (leaf) => unresolvedBlockers(leaf).length === 0
    );
    if (selected !== undefined) {
      runnable.push(
        withPullRequest(
          {
            ancestorPath: selected.ancestorPath,
            branch,
            descendantLeafNumbers,
            issue: identity(selected.issue),
            kind: "spec-leaf" as const,
            ...(latestImplementedHead === undefined
              ? undefined
              : { latestImplementedHead }),
            parent: identity(selected.parent),
            root: rootIdentity,
          },
          pullRequest
        )
      );
      continue;
    }

    if (remaining.length > 0) {
      waiting.push(
        withPullRequest(
          {
            blockedLeaves: remaining.map((leaf) => ({
              ancestorPath: leaf.ancestorPath,
              leaf: identity(leaf.issue),
              openBlockers: unresolvedBlockers(leaf),
            })),
            branch,
            descendantLeafNumbers,
            root: rootIdentity,
          },
          pullRequest
        )
      );
      continue;
    }

    if (pullRequest?.state === "OPEN" || pullRequest?.state === "MERGED") {
      if (latestImplementedHead === undefined) {
        throw new IssueGraphRelationshipError(
          `shared pull request for ${branch} has no accepted implementation head`
        );
      }
      finalize.push({
        branch,
        descendantIssueNumbers,
        descendantLeafNumbers,
        expectedHeadSha: latestReviewedHead ?? latestImplementedHead,
        pullRequest,
        root: rootIdentity,
      });
    }
  }

  return { finalize, runnable, waiting };
};

const assertPullRequestIsRecoverable = (
  branch: string,
  pullRequest: ExistingPullRequest | undefined,
  baseBranch: string
) => {
  if (pullRequest?.state === "CLOSED") {
    throw new IssueGraphRelationshipError(
      `pull request for ${branch} was closed without merge`
    );
  }
  if (
    pullRequest !== undefined &&
    (pullRequest.baseRefName !== baseBranch ||
      pullRequest.headRefName !== branch ||
      pullRequest.isCrossRepository)
  ) {
    throw new IssueGraphRelationshipError(
      `pull request for ${branch} has ambiguous head ownership`
    );
  }
};

const assertPullRequestCanScheduleRemaining = (
  branch: string,
  pullRequest: ExistingPullRequest | undefined,
  remainingCount: number
) => {
  if (remainingCount === 0) {
    return;
  }
  if (pullRequest?.state === "MERGED") {
    throw new IssueGraphRelationshipError(
      `merged pull request for ${branch} omitted open descendant work`
    );
  }
  if (pullRequest?.state === "OPEN" && !pullRequest.isDraft) {
    throw new IssueGraphRelationshipError(
      `pull request for ${branch} became ready before all descendants were implemented`
    );
  }
};

const assertDescendantStateIsConsistent = (
  root: GitHubIssue,
  containers: readonly GitHubIssue[],
  leaves: readonly DescendantLeaf[],
  pullRequest: ExistingPullRequest | undefined,
  implemented: ReadonlySet<number>
) => {
  const closedContainers = new Set(
    containers
      .filter((container) => container.state === "CLOSED")
      .map((container) => container.number)
  );
  const openLeafUnderClosedContainer = leaves.some(
    (leaf) =>
      leaf.issue.state === "OPEN" &&
      leaf.ancestorPath
        .slice(0, -1)
        .some((ancestor) => closedContainers.has(ancestor.number))
  );
  if (openLeafUnderClosedContainer) {
    throw new IssueGraphRelationshipError(
      `closed container under root #${root.number} still has open descendant work`
    );
  }
  if (
    pullRequest !== undefined &&
    leaves.some(
      (leaf) =>
        leaf.issue.state === "CLOSED" && !implemented.has(leaf.issue.number)
    )
  ) {
    throw new IssueGraphRelationshipError(
      `descendant under root #${root.number} closed before its shared pull request merged`
    );
  }
};
