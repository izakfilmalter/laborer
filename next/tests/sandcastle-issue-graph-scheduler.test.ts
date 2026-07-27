import { assert, describe, it } from "@effect/vitest";
import {
  type ExistingPullRequest,
  type GitHubIssue,
  IssueGraphRelationshipError,
  type IssueGraphSource,
  scheduleIssueGraph,
} from "../.sandcastle/issue-graph-scheduler/index.ts";

const head267 = "a".repeat(40);
const head268 = "b".repeat(40);
const head3 = "c".repeat(40);
const reviewedHead = "d".repeat(40);
const marker = (issueNumber: number, headSha: string) =>
  `<!-- sandcastle-implemented:#${issueNumber}@${headSha} -->`;

const issue = (
  number: number,
  options: Partial<Omit<GitHubIssue, "number">> = {}
): GitHubIssue => ({
  childNumbers: [],
  number,
  openBlockers: [],
  state: "OPEN",
  title: `Issue ${number}`,
  ...options,
});

const source = (
  issues: readonly GitHubIssue[],
  pullRequests: Readonly<Record<string, ExistingPullRequest>> = {}
): IssueGraphSource => {
  const byNumber = new Map(issues.map((item) => [item.number, item]));
  return {
    baseBranch: "master",
    issue(number) {
      const item = byNumber.get(number);
      if (item === undefined) {
        throw new Error(`missing issue #${number}`);
      }
      return item;
    },
    pullRequest(branch) {
      return pullRequests[branch];
    },
  };
};

describe("native GitHub issue graph scheduler", () => {
  it("selects the first unblocked child and preserves its spec context", () => {
    const graph = source([
      issue(266, { childNumbers: [267, 268], title: "Parent spec" }),
      issue(267, { parentNumber: 266, title: "First leaf" }),
      issue(268, {
        openBlockers: [{ number: 267, title: "First leaf" }],
        parentNumber: 266,
        title: "Second leaf",
      }),
    ]);

    assert.deepStrictEqual(scheduleIssueGraph(graph, [266]), {
      finalize: [],
      runnable: [
        {
          ancestorPath: [
            { number: 266, title: "Parent spec" },
            { number: 267, title: "First leaf" },
          ],
          branch: "sandcastle/spec-266",
          descendantLeafNumbers: [267, 268],
          issue: { number: 267, title: "First leaf" },
          kind: "spec-leaf",
          parent: { number: 266, title: "Parent spec" },
          root: { number: 266, title: "Parent spec" },
        },
      ],
      waiting: [],
    });
  });

  it("waits with every blocked leaf and its open blocker identities", () => {
    const graph = source([
      issue(266, { childNumbers: [267, 268], title: "Parent spec" }),
      issue(267, {
        openBlockers: [{ number: 101, title: "External prerequisite" }],
        parentNumber: 266,
        title: "First leaf",
      }),
      issue(268, {
        openBlockers: [{ number: 267, title: "First leaf" }],
        parentNumber: 266,
        title: "Second leaf",
      }),
    ]);

    const schedule = scheduleIssueGraph(graph, [266]);

    assert.deepStrictEqual(schedule.runnable, []);
    assert.deepStrictEqual(schedule.finalize, []);
    assert.deepStrictEqual(schedule.waiting, [
      {
        blockedLeaves: [
          {
            ancestorPath: [
              { number: 266, title: "Parent spec" },
              { number: 267, title: "First leaf" },
            ],
            leaf: { number: 267, title: "First leaf" },
            openBlockers: [{ number: 101, title: "External prerequisite" }],
          },
          {
            ancestorPath: [
              { number: 266, title: "Parent spec" },
              { number: 268, title: "Second leaf" },
            ],
            leaf: { number: 268, title: "Second leaf" },
            openBlockers: [{ number: 267, title: "First leaf" }],
          },
        ],
        branch: "sandcastle/spec-266",
        descendantLeafNumbers: [267, 268],
        root: { number: 266, title: "Parent spec" },
      },
    ]);
  });

  it("progresses to the next leaf when its blocker is implemented on the shared PR", () => {
    const pullRequest = {
      baseRefName: "master",
      body: ["Work in progress", marker(267, head267)].join("\n"),
      headRefName: "sandcastle/spec-266",
      isCrossRepository: false,
      isDraft: true,
      state: "OPEN" as const,
      url: "https://github.test/pull/42",
    };
    const graph = source(
      [
        issue(266, { childNumbers: [267, 268], title: "Parent spec" }),
        issue(267, { parentNumber: 266, title: "First leaf" }),
        issue(268, {
          openBlockers: [{ number: 267, title: "First leaf" }],
          parentNumber: 266,
          title: "Second leaf",
        }),
      ],
      { "sandcastle/spec-266": pullRequest }
    );

    const schedule = scheduleIssueGraph(graph, [267]);

    assert.strictEqual(schedule.waiting.length, 0);
    assert.strictEqual(schedule.finalize.length, 0);
    assert.deepStrictEqual(schedule.runnable, [
      {
        ancestorPath: [
          { number: 266, title: "Parent spec" },
          { number: 268, title: "Second leaf" },
        ],
        branch: "sandcastle/spec-266",
        descendantLeafNumbers: [267, 268],
        issue: { number: 268, title: "Second leaf" },
        kind: "spec-leaf",
        latestImplementedHead: head267,
        parent: { number: 266, title: "Parent spec" },
        pullRequest,
        root: { number: 266, title: "Parent spec" },
      },
    ]);
  });

  it("finalizes an open shared PR after every leaf is delivered or implemented", () => {
    const pullRequest = {
      baseRefName: "master",
      body: [marker(267, head267), marker(268, head268)].join("\n"),
      headRefName: "sandcastle/spec-266",
      isCrossRepository: false,
      isDraft: true,
      state: "OPEN" as const,
      url: "https://github.test/pull/42",
    };
    const graph = source(
      [
        issue(266, { childNumbers: [267, 268], title: "Parent spec" }),
        issue(267, { parentNumber: 266, state: "CLOSED" }),
        issue(268, { parentNumber: 266 }),
      ],
      { "sandcastle/spec-266": pullRequest }
    );

    assert.deepStrictEqual(scheduleIssueGraph(graph, [266]), {
      finalize: [
        {
          branch: "sandcastle/spec-266",
          descendantIssueNumbers: [267, 268],
          descendantLeafNumbers: [267, 268],
          expectedHeadSha: head268,
          pullRequest,
          root: { number: 266, title: "Parent spec" },
        },
      ],
      runnable: [],
      waiting: [],
    });
  });

  it("includes nested containers in the merge-gated closure set", () => {
    const pullRequest = {
      baseRefName: "master",
      body: marker(3, head3),
      headRefName: "sandcastle/spec-1",
      isCrossRepository: false,
      isDraft: true,
      state: "OPEN" as const,
      url: "https://github.test/pull/42",
    };
    const graph = source(
      [
        issue(1, { childNumbers: [2] }),
        issue(2, { childNumbers: [3], parentNumber: 1 }),
        issue(3, { parentNumber: 2 }),
      ],
      { "sandcastle/spec-1": pullRequest }
    );

    assert.deepStrictEqual(scheduleIssueGraph(graph, [1]).finalize[0], {
      branch: "sandcastle/spec-1",
      descendantIssueNumbers: [2, 3],
      descendantLeafNumbers: [3],
      expectedHeadSha: head3,
      pullRequest,
      root: { number: 1, title: "Issue 1" },
    });
  });

  it("recovers merge-gated issue closure from an already merged shared PR", () => {
    const pullRequest = {
      baseRefName: "master",
      body: marker(267, head267),
      headRefName: "sandcastle/spec-266",
      isCrossRepository: false,
      isDraft: false,
      state: "MERGED" as const,
      url: "https://github.test/pull/42",
    };
    const graph = source(
      [issue(266, { childNumbers: [267] }), issue(267, { parentNumber: 266 })],
      { "sandcastle/spec-266": pullRequest }
    );

    assert.deepStrictEqual(scheduleIssueGraph(graph, [266]).finalize, [
      {
        branch: "sandcastle/spec-266",
        descendantIssueNumbers: [267],
        descendantLeafNumbers: [267],
        expectedHeadSha: head267,
        pullRequest,
        root: { number: 266, title: "Issue 266" },
      },
    ]);
  });

  it("recovers closure at the durable reviewed head after review adds commits", () => {
    const pullRequest = {
      baseRefName: "master",
      body: [
        marker(267, head267),
        `<!-- sandcastle-reviewed-head:@${reviewedHead} -->`,
      ].join("\n"),
      headRefName: "sandcastle/spec-266",
      isCrossRepository: false,
      isDraft: false,
      state: "MERGED" as const,
      url: "https://github.test/pull/42",
    };
    const graph = source(
      [issue(266, { childNumbers: [267] }), issue(267, { parentNumber: 266 })],
      { "sandcastle/spec-266": pullRequest }
    );

    assert.strictEqual(
      scheduleIssueGraph(graph, [266]).finalize[0]?.expectedHeadSha,
      reviewedHead
    );
  });

  it("fails closed when a merged shared PR omitted an open leaf", () => {
    const graph = source(
      [
        issue(266, { childNumbers: [267, 268] }),
        issue(267, { parentNumber: 266 }),
        issue(268, { parentNumber: 266 }),
      ],
      {
        "sandcastle/spec-266": {
          baseRefName: "master",
          body: marker(267, head267),
          headRefName: "sandcastle/spec-266",
          isCrossRepository: false,
          isDraft: false,
          state: "MERGED",
          url: "https://github.test/pull/42",
        },
      }
    );

    assert.throws(
      () => scheduleIssueGraph(graph, [266]),
      IssueGraphRelationshipError
    );
  });

  it("fails closed when a shared spec PR was closed without merge", () => {
    const graph = source(
      [issue(266, { childNumbers: [267] }), issue(267, { parentNumber: 266 })],
      {
        "sandcastle/spec-266": {
          baseRefName: "master",
          body: marker(267, head267),
          headRefName: "sandcastle/spec-266",
          isCrossRepository: false,
          isDraft: false,
          state: "CLOSED",
          url: "https://github.test/pull/42",
        },
      }
    );

    assert.throws(
      () => scheduleIssueGraph(graph, [266]),
      IssueGraphRelationshipError
    );
  });

  it("fails closed when a shared PR becomes ready before all leaves are implemented", () => {
    const graph = source(
      [
        issue(266, { childNumbers: [267, 268] }),
        issue(267, { parentNumber: 266 }),
        issue(268, { parentNumber: 266 }),
      ],
      {
        "sandcastle/spec-266": {
          baseRefName: "master",
          body: marker(267, head267),
          headRefName: "sandcastle/spec-266",
          isCrossRepository: false,
          isDraft: false,
          state: "OPEN",
          url: "https://github.test/pull/42",
        },
      }
    );

    assert.throws(
      () => scheduleIssueGraph(graph, [266]),
      IssueGraphRelationshipError
    );
  });

  it("fails closed before scheduling from a PR targeting the wrong base", () => {
    const graph = source(
      [issue(266, { childNumbers: [267] }), issue(267, { parentNumber: 266 })],
      {
        "sandcastle/spec-266": {
          baseRefName: "release",
          body: "Work in progress",
          headRefName: "sandcastle/spec-266",
          isCrossRepository: false,
          isDraft: true,
          state: "OPEN",
          url: "https://github.test/pull/42",
        },
      }
    );

    assert.throws(
      () => scheduleIssueGraph(graph, [266]),
      IssueGraphRelationshipError
    );
  });

  it("treats an entirely closed spec without a PR as complete", () => {
    const graph = source([
      issue(266, { childNumbers: [267, 268] }),
      issue(267, { parentNumber: 266, state: "CLOSED" }),
      issue(268, { parentNumber: 266, state: "CLOSED" }),
    ]);

    assert.deepStrictEqual(scheduleIssueGraph(graph, [266]), {
      finalize: [],
      runnable: [],
      waiting: [],
    });
  });

  it("fails closed when a descendant closed before its shared PR merged", () => {
    const graph = source(
      [
        issue(266, { childNumbers: [267] }),
        issue(267, { parentNumber: 266, state: "CLOSED" }),
      ],
      {
        "sandcastle/spec-266": {
          baseRefName: "master",
          body: "Work in progress",
          headRefName: "sandcastle/spec-266",
          isCrossRepository: false,
          isDraft: true,
          state: "OPEN",
          url: "https://github.test/pull/42",
        },
      }
    );

    assert.throws(
      () => scheduleIssueGraph(graph, [266]),
      IssueGraphRelationshipError
    );
  });

  it("fails closed when a closed container still has open descendant work", () => {
    const closedRoot = source([
      issue(1, { childNumbers: [2], state: "CLOSED" }),
      issue(2, { parentNumber: 1 }),
    ]);
    const closedNestedContainer = source([
      issue(1, { childNumbers: [2] }),
      issue(2, { childNumbers: [3], parentNumber: 1, state: "CLOSED" }),
      issue(3, { parentNumber: 2 }),
    ]);

    assert.throws(
      () => scheduleIssueGraph(closedRoot, [2]),
      IssueGraphRelationshipError
    );
    assert.throws(
      () => scheduleIssueGraph(closedNestedContainer, [3]),
      IssueGraphRelationshipError
    );
  });

  it("allows open work in a sibling subtree of a completed closed container", () => {
    const graph = source([
      issue(1, { childNumbers: [2, 4] }),
      issue(2, { childNumbers: [3], parentNumber: 1, state: "CLOSED" }),
      issue(3, { parentNumber: 2, state: "CLOSED" }),
      issue(4, { parentNumber: 1 }),
    ]);

    assert.strictEqual(
      scheduleIssueGraph(graph, [4]).runnable[0]?.issue.number,
      4
    );
  });

  it("runs independent standalone and spec roots on deterministic branches", () => {
    const graph = source([
      issue(10, { title: "Standalone" }),
      issue(20, { childNumbers: [21], title: "Independent spec" }),
      issue(21, { parentNumber: 20, title: "Spec leaf" }),
    ]);

    const schedule = scheduleIssueGraph(graph, [10, 20]);

    assert.deepStrictEqual(schedule.runnable, [
      {
        ancestorPath: [{ number: 10, title: "Standalone" }],
        branch: "sandcastle/issue-10",
        descendantLeafNumbers: [],
        issue: { number: 10, title: "Standalone" },
        kind: "standalone",
        parent: null,
        root: { number: 10, title: "Standalone" },
      },
      {
        ancestorPath: [
          { number: 20, title: "Independent spec" },
          { number: 21, title: "Spec leaf" },
        ],
        branch: "sandcastle/spec-20",
        descendantLeafNumbers: [21],
        issue: { number: 21, title: "Spec leaf" },
        kind: "spec-leaf",
        parent: { number: 20, title: "Independent spec" },
        root: { number: 20, title: "Independent spec" },
      },
    ]);
  });

  it("deduplicates child and parent ready entries to one topmost root", () => {
    const graph = source([
      issue(266, { childNumbers: [267, 268] }),
      issue(267, { parentNumber: 266 }),
      issue(268, { parentNumber: 266 }),
    ]);

    const schedule = scheduleIssueGraph(graph, [267, 266]);

    assert.strictEqual(schedule.runnable.length, 1);
    assert.deepStrictEqual(schedule.runnable[0]?.root, {
      number: 266,
      title: "Issue 266",
    });
    assert.deepStrictEqual(
      schedule.runnable[0]?.descendantLeafNumbers,
      [267, 268]
    );
  });

  it("traverses nested descendants depth-first in native child order", () => {
    const graph = source([
      issue(1, { childNumbers: [2, 5], title: "Root" }),
      issue(2, { childNumbers: [3, 4], parentNumber: 1, title: "Section" }),
      issue(3, { parentNumber: 2, state: "CLOSED", title: "Delivered" }),
      issue(4, { parentNumber: 2, title: "Nested target" }),
      issue(5, { parentNumber: 1, title: "Later target" }),
    ]);

    const schedule = scheduleIssueGraph(graph, [4]);

    assert.deepStrictEqual(schedule.runnable[0], {
      ancestorPath: [
        { number: 1, title: "Root" },
        { number: 2, title: "Section" },
        { number: 4, title: "Nested target" },
      ],
      branch: "sandcastle/spec-1",
      descendantLeafNumbers: [3, 4, 5],
      issue: { number: 4, title: "Nested target" },
      kind: "spec-leaf",
      parent: { number: 2, title: "Section" },
      root: { number: 1, title: "Root" },
    });
  });

  it("ignores malformed and non-leaf implementation markers", () => {
    const graph = source(
      [
        issue(266, { childNumbers: [267, 268] }),
        issue(267, { parentNumber: 266 }),
        issue(268, { parentNumber: 266 }),
      ],
      {
        "sandcastle/spec-266": {
          baseRefName: "master",
          body: [
            "<!-- sandcastle-implemented: #267 -->",
            "<!-- sandcastle-implemented:#0267 -->",
            "<!-- sandcastle-implemented:#267-->",
            "<!-- sandcastle-implemented:#999 -->",
          ].join("\n"),
          headRefName: "sandcastle/spec-266",
          isCrossRepository: false,
          isDraft: true,
          state: "OPEN",
          url: "https://github.test/pull/42",
        },
      }
    );

    assert.strictEqual(
      scheduleIssueGraph(graph, [266]).runnable[0]?.issue.number,
      267
    );
  });

  it("propagates source failures unchanged", () => {
    const issueFailure = new Error("issue lookup failed");
    const pullRequestFailure = new Error("PR lookup failed");
    const issueFailureSource: IssueGraphSource = {
      baseBranch: "master",
      issue() {
        throw issueFailure;
      },
      pullRequest() {
        return undefined;
      },
    };
    const pullRequestFailureSource: IssueGraphSource = {
      baseBranch: "master",
      issue() {
        return issue(1);
      },
      pullRequest() {
        throw pullRequestFailure;
      },
    };

    let caughtIssueFailure: unknown;
    let caughtPullRequestFailure: unknown;
    try {
      scheduleIssueGraph(issueFailureSource, [1]);
    } catch (error) {
      caughtIssueFailure = error;
    }
    try {
      scheduleIssueGraph(pullRequestFailureSource, [1]);
    } catch (error) {
      caughtPullRequestFailure = error;
    }

    assert.strictEqual(caughtIssueFailure, issueFailure);
    assert.strictEqual(caughtPullRequestFailure, pullRequestFailure);
  });

  it("fails closed when native parent and child relationships disagree", () => {
    const graph = source([
      issue(1, { childNumbers: [2] }),
      issue(2, { parentNumber: 3 }),
    ]);

    assert.throws(
      () => scheduleIssueGraph(graph, [1]),
      IssueGraphRelationshipError
    );
  });
});
