import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { RpcError } from "@laborer/shared/rpc";
import { tables } from "@laborer/shared/schema";
import { Context, Effect, Layer } from "effect";
import { LaborerStore } from "./laborer-store.js";
import { TaskManager } from "./task-manager.js";

const execFile = promisify(execFileCallback);

interface GithubIssue {
	readonly html_url: string;
	readonly number: number;
	readonly pull_request?: object;
	readonly title: string;
}

interface GithubIssuesResponse {
	readonly importedCount: number;
	readonly totalCount: number;
}

const GITHUB_HTTPS_REMOTE_REGEX =
	/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/;
const GITHUB_SSH_REMOTE_REGEX = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/;

const parseGithubRepo = (
	remoteUrl: string
): { readonly owner: string; readonly repo: string } | null => {
	const trimmedRemoteUrl = remoteUrl.trim();
	const httpsMatch = trimmedRemoteUrl.match(GITHUB_HTTPS_REMOTE_REGEX);
	if (httpsMatch?.[1] && httpsMatch[2]) {
		return { owner: httpsMatch[1], repo: httpsMatch[2] };
	}

	const sshMatch = trimmedRemoteUrl.match(GITHUB_SSH_REMOTE_REGEX);
	if (sshMatch?.[1] && sshMatch[2]) {
		return { owner: sshMatch[1], repo: sshMatch[2] };
	}

	return null;
};

const getGithubHeaders = (): Record<string, string> => {
	const headers: Record<string, string> = {
		accept: "application/vnd.github+json",
		"user-agent": "laborer",
	};

	const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
	if (token) {
		headers.authorization = `Bearer ${token}`;
	}

	return headers;
};

class GithubTaskImporter extends Context.Tag("@laborer/GithubTaskImporter")<
	GithubTaskImporter,
	{
		readonly importProjectIssues: (
			projectId: string
		) => Effect.Effect<GithubIssuesResponse, RpcError>;
	}
>() {
	static readonly layer = Layer.effect(
		GithubTaskImporter,
		Effect.gen(function* () {
			const { store } = yield* LaborerStore;
			const taskManager = yield* TaskManager;

			const importProjectIssues = Effect.fn(
				"GithubTaskImporter.importProjectIssues"
			)(function* (projectId: string) {
				const project = store.query(tables.projects.where("id", projectId))[0];
				if (!project) {
					return yield* new RpcError({
						message: `Project not found: ${projectId}`,
						code: "NOT_FOUND",
					});
				}

				const remoteUrl = yield* Effect.tryPromise({
					try: async () => {
						const { stdout } = await execFile(
							"git",
							["config", "--get", "remote.origin.url"],
							{ cwd: project.repoPath }
						);
						return stdout.trim();
					},
					catch: () =>
						new RpcError({
							message: `Could not read git remote.origin.url for ${project.repoPath}`,
							code: "GITHUB_REMOTE_NOT_FOUND",
						}),
				});

				const repoInfo = parseGithubRepo(remoteUrl);
				if (!repoInfo) {
					return yield* new RpcError({
						message: `Project remote is not a GitHub repository: ${remoteUrl}`,
						code: "NOT_GITHUB_REPO",
					});
				}

				const response = yield* Effect.tryPromise({
					try: () =>
						fetch(
							`https://api.github.com/repos/${repoInfo.owner}/${repoInfo.repo}/issues?state=open&per_page=100`,
							{
								headers: getGithubHeaders(),
							}
						),
					catch: (error) =>
						new RpcError({
							message:
								error instanceof Error
									? `Failed to fetch GitHub issues: ${error.message}`
									: `Failed to fetch GitHub issues: ${String(error)}`,
							code: "GITHUB_API_FAILED",
						}),
				});

				if (!response.ok) {
					const errorBody = yield* Effect.tryPromise({
						try: () => response.text(),
						catch: () =>
							new RpcError({
								message: `GitHub API request failed (${response.status}) and the error response body could not be read`,
								code: "GITHUB_API_FAILED",
							}),
					});
					return yield* new RpcError({
						message: `GitHub API request failed (${response.status}): ${errorBody || response.statusText}`,
						code: "GITHUB_API_FAILED",
					});
				}

				const issues = yield* Effect.tryPromise({
					try: () => response.json() as Promise<readonly GithubIssue[]>,
					catch: () =>
						new RpcError({
							message: "GitHub API returned an invalid response body",
							code: "GITHUB_API_INVALID_RESPONSE",
						}),
				});

				const existingExternalIds = new Set(
					store
						.query(tables.tasks.where("projectId", projectId))
						.filter(
							(task) => task.source === "github" && task.externalId !== null
						)
						.map((task) => task.externalId as string)
				);

				let importedCount = 0;
				let totalCount = 0;

				for (const issue of issues) {
					if (issue.pull_request) {
						continue;
					}

					totalCount += 1;
					if (existingExternalIds.has(issue.html_url)) {
						continue;
					}

					yield* taskManager.createTask(
						projectId,
						issue.title,
						"github",
						issue.html_url
					);
					existingExternalIds.add(issue.html_url);
					importedCount += 1;
				}

				return {
					importedCount,
					totalCount,
				};
			});

			return GithubTaskImporter.of({
				importProjectIssues,
			});
		})
	);
}

export { GithubTaskImporter, parseGithubRepo };
export type { GithubIssuesResponse };
