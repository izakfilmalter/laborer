import { rmSync } from "node:fs";
import { assert, describe, it } from "@effect/vitest";
import { events, tables } from "@laborer/shared/schema";
import { Cause, Effect, Exit, Layer } from "effect";
import { afterEach, vi } from "vitest";
import { GithubTaskImporter } from "../src/services/github-task-importer.js";
import { LaborerStore } from "../src/services/laborer-store.js";
import { TaskManager } from "../src/services/task-manager.js";
import { createTempDir, git } from "./helpers/git-helpers.js";
import { TestLaborerStore } from "./helpers/test-store.js";

const TestLayer = GithubTaskImporter.layer.pipe(
	Layer.provide(TaskManager.layer),
	Layer.provideMerge(TestLaborerStore)
);

const GITHUB_API_ERROR_REGEX =
	/GitHub API request failed \(403\): rate limited/;

const createGithubRepo = (remoteUrl: string, tempRoots: string[]): string => {
	const repoPath = createTempDir("laborer-github-import");
	tempRoots.push(repoPath);
	git("init", repoPath);
	git(`remote add origin ${remoteUrl}`, repoPath);
	return repoPath;
};

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("GithubTaskImporter.importProjectIssues", () => {
	it.scoped(
		"imports GitHub issues and skips pull requests and duplicates",
		() =>
			Effect.gen(function* () {
				const tempRoots: string[] = [];
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => {
						for (const root of tempRoots) {
							rmSync(root, { force: true, recursive: true });
						}
					})
				);

				const repoPath = createGithubRepo(
					"git@github.com:acme/laborer.git",
					tempRoots
				);
				const fetchMock = vi.fn().mockResolvedValue({
					ok: true,
					json: async () => [
						{
							html_url: "https://github.com/acme/laborer/issues/101",
							number: 101,
							title: "Add GitHub task import",
						},
						{
							html_url: "https://github.com/acme/laborer/issues/102",
							number: 102,
							title: "Skip pull requests",
							pull_request: {},
						},
						{
							html_url: "https://github.com/acme/laborer/issues/103",
							number: 103,
							title: "Import task source picker issues",
						},
					],
				});
				vi.stubGlobal("fetch", fetchMock);

				const { store } = yield* LaborerStore;
				store.commit(
					events.projectCreated({
						id: "project-1",
						repoPath,
						name: "laborer",
						rlphConfig: null,
					})
				);
				store.commit(
					events.taskCreated({
						id: "existing-task",
						projectId: "project-1",
						source: "github",
						prdId: null,
						externalId: "https://github.com/acme/laborer/issues/101",
						title: "Already imported",
						status: "pending",
					})
				);

				const importer = yield* GithubTaskImporter;
				const result = yield* importer.importProjectIssues("project-1");

				assert.strictEqual(result.importedCount, 1);
				assert.strictEqual(result.totalCount, 2);

				const importedTasks = store.query(
					tables.tasks.where("projectId", "project-1")
				);
				assert.strictEqual(importedTasks.length, 2);

				const newTask = importedTasks.find(
					(t) => t.externalId === "https://github.com/acme/laborer/issues/103"
				);
				assert.isDefined(newTask);
				if (newTask === undefined) {
					assert.fail("Expected newly imported task to exist");
				}
				assert.strictEqual(newTask.source, "github");
				assert.strictEqual(newTask.title, "Import task source picker issues");
				assert.strictEqual(newTask.status, "pending");

				assert.strictEqual(fetchMock.mock.calls.length, 1);
				const [calledUrl, calledOpts] = fetchMock.mock.calls[0] as [
					string,
					Record<string, unknown>,
				];
				assert.strictEqual(
					calledUrl,
					"https://api.github.com/repos/acme/laborer/issues?state=open&per_page=100"
				);
				const headers = calledOpts.headers as Record<string, string>;
				assert.strictEqual(headers.accept, "application/vnd.github+json");
				assert.strictEqual(headers["user-agent"], "laborer");
			}).pipe(Effect.provide(TestLayer))
	);

	it.scoped("returns a typed error when the GitHub API request fails", () =>
		Effect.gen(function* () {
			const tempRoots: string[] = [];
			yield* Effect.addFinalizer(() =>
				Effect.sync(() => {
					for (const root of tempRoots) {
						rmSync(root, { force: true, recursive: true });
					}
				})
			);

			const repoPath = createGithubRepo(
				"https://github.com/acme/laborer.git",
				tempRoots
			);
			vi.stubGlobal(
				"fetch",
				vi.fn().mockResolvedValue({
					ok: false,
					status: 403,
					statusText: "Forbidden",
					text: async () => "rate limited",
				})
			);

			const { store } = yield* LaborerStore;
			store.commit(
				events.projectCreated({
					id: "project-1",
					repoPath,
					name: "laborer",
					rlphConfig: null,
				})
			);

			const importer = yield* GithubTaskImporter;
			const exit = yield* Effect.exit(
				importer.importProjectIssues("project-1")
			);
			assert.isTrue(Exit.isFailure(exit));
			if (Exit.isFailure(exit)) {
				const error = Cause.squash(exit.cause);
				assert.isTrue(
					GITHUB_API_ERROR_REGEX.test(
						String(error instanceof Error ? error.message : error)
					)
				);
			}
		}).pipe(Effect.provide(TestLayer))
	);
});
