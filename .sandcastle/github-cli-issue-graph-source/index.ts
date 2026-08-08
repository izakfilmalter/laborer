import { z } from "zod";
import type {
  ExistingPullRequest,
  GitHubIssue,
  IssueGraphSource,
} from "../issue-graph-scheduler/index.ts";

export type GitHubCommandRunner = (args: readonly string[]) => string;

const parentIssuePathPattern =
  /^\/repos\/([^/]+)\/([^/]+)\/issues\/([1-9]\d*)$/;
const issueNumberSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const repositorySchema = z
  .string()
  .regex(
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/,
    "expected repository nameWithOwner"
  );
const httpsUrlSchema = z
  .string()
  .url()
  .refine(
    (value) => new URL(value).protocol === "https:",
    "expected an HTTPS URL"
  );
const labelSchema = z.object({ name: z.string().min(1) });
const restIssueSchema = z.object({
  html_url: httpsUrlSchema,
  labels: z.array(labelSchema),
  number: issueNumberSchema,
  parent_issue_url: httpsUrlSchema.nullable().optional(),
  pull_request: z.unknown().optional(),
  state: z.enum(["open", "closed"]),
  title: z.string().min(1),
});
const issuePagesSchema = z.array(z.array(restIssueSchema));
const pullRequestSchema = z.object({
  baseRefName: z.string().min(1),
  body: z.string(),
  headRefName: z.string().min(1),
  isCrossRepository: z.boolean(),
  isDraft: z.boolean(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  title: z.string().min(1),
  url: httpsUrlSchema,
});
const pullRequestsSchema = z.array(pullRequestSchema);
const repositoryOutputSchema = z.object({ nameWithOwner: repositorySchema });

const parseJson = (output: string): unknown => JSON.parse(output);

export class GitHubCliIssueGraphSource implements IssueGraphSource {
  readonly baseBranch: string;
  readonly #runCommand: GitHubCommandRunner;
  #repository: string | undefined;

  constructor(
    runCommand: GitHubCommandRunner,
    repository?: string,
    baseBranch = "master"
  ) {
    this.#runCommand = runCommand;
    this.baseBranch = z.string().min(1).parse(baseBranch);
    this.#repository =
      repository === undefined ? undefined : repositorySchema.parse(repository);
  }

  listOpenIssueNumbers(label: string): readonly number[] {
    const repository = this.repository();
    const validatedLabel = z.string().min(1).parse(label);
    const pages = issuePagesSchema.parse(
      parseJson(
        this.#runCommand([
          "api",
          "--method",
          "GET",
          `repos/${repository}/issues`,
          "-f",
          "state=open",
          "-f",
          `labels=${validatedLabel}`,
          "-f",
          "per_page=100",
          "--paginate",
          "--slurp",
        ])
      )
    );

    return pages
      .flat()
      .filter((issue) => issue.pull_request === undefined)
      .map((issue) => issue.number);
  }

  issue(number: number): GitHubIssue {
    const issueNumber = issueNumberSchema.parse(number);
    const repository = this.repository();
    const endpoint = `repos/${repository}/issues/${issueNumber}`;
    const issue = restIssueSchema.parse(
      parseJson(this.#runCommand(["api", "--method", "GET", endpoint]))
    );
    if (issue.number !== issueNumber) {
      throw new Error(
        `GitHub returned issue #${issue.number} for requested issue #${issueNumber}`
      );
    }

    const children = this.issuePages(`${endpoint}/sub_issues`);
    const openBlockers = this.issuePages(`${endpoint}/dependencies/blocked_by`)
      .filter((blocker) => blocker.state === "open")
      .map((blocker) => ({ number: blocker.number, title: blocker.title }));
    const parentNumber = this.parentNumber(issue.parent_issue_url, repository);
    const result = {
      childNumbers: children.map((child) => child.number),
      number: issue.number,
      openBlockers,
      state: issue.state === "open" ? ("OPEN" as const) : ("CLOSED" as const),
      title: issue.title,
    };

    return parentNumber === undefined ? result : { ...result, parentNumber };
  }

  pullRequest(branch: string): ExistingPullRequest | undefined {
    const validatedBranch = z.string().min(1).parse(branch);
    const pullRequests = pullRequestsSchema.parse(
      parseJson(
        this.#runCommand([
          "pr",
          "list",
          "--repo",
          this.repository(),
          "--state",
          "all",
          "--head",
          validatedBranch,
          "--limit",
          "2",
          "--json",
          "baseRefName,body,headRefName,isCrossRepository,isDraft,state,title,url",
        ])
      )
    );
    const pullRequest = pullRequests[0];
    if (pullRequest === undefined) {
      return undefined;
    }
    if (pullRequests.length > 1) {
      throw new Error(
        `multiple open pull requests match branch ${validatedBranch}`
      );
    }
    return {
      baseRefName: pullRequest.baseRefName,
      body: pullRequest.body,
      headRefName: pullRequest.headRefName,
      isCrossRepository: pullRequest.isCrossRepository,
      isDraft: pullRequest.isDraft,
      state: pullRequest.state,
      url: pullRequest.url,
    };
  }

  private issuePages(endpoint: string): z.infer<typeof restIssueSchema>[] {
    return issuePagesSchema
      .parse(
        parseJson(
          this.#runCommand([
            "api",
            "--method",
            "GET",
            endpoint,
            "-f",
            "per_page=100",
            "--paginate",
            "--slurp",
          ])
        )
      )
      .flat();
  }

  private parentNumber(
    parentIssueUrl: string | null | undefined,
    repository: string
  ): number | undefined {
    if (parentIssueUrl === null || parentIssueUrl === undefined) {
      return undefined;
    }

    const url = new URL(parentIssueUrl);
    const match = parentIssuePathPattern.exec(url.pathname);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "api.github.com" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      match === null
    ) {
      throw new Error(`invalid parent_issue_url: ${parentIssueUrl}`);
    }

    const parentRepository = `${match[1]}/${match[2]}`;
    if (parentRepository.toLowerCase() !== repository.toLowerCase()) {
      throw new Error(
        `parent_issue_url belongs to ${parentRepository}, not ${repository}`
      );
    }
    return issueNumberSchema.parse(Number(match[3]));
  }

  private repository(): string {
    if (this.#repository === undefined) {
      this.#repository = repositoryOutputSchema.parse(
        parseJson(this.#runCommand(["repo", "view", "--json", "nameWithOwner"]))
      ).nameWithOwner;
    }
    return this.#repository;
  }
}
