import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { events, schema, tables } from "@laborer/shared/schema";
import { makeAdapter } from "@livestore/adapter-node";
import { createStore, provideOtel } from "@livestore/livestore";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GithubTaskImporter } from "../src/services/github-task-importer.js";
import { LaborerStore } from "../src/services/laborer-store.js";
import { TaskManager } from "../src/services/task-manager.js";

const makeTestStore = Effect.gen(function* () {
	const adapter = makeAdapter({ storage: { type: "in-memory" } });
	const store = yield* createStore({
		schema,
		storeId: `test-${crypto.randomUUID()}`,
		adapter,
		batchUpdates: (run) => run(),
		disableDevtools: true,
	});
	return { store };
}).pipe(provideOtel({}));

const TestLaborerStore = Layer.scoped(LaborerStore, makeTestStore).pipe(
	Layer.orDie
);

const TestLayer = GithubTaskImporter.layer.pipe(
	Layer.provide(TaskManager.layer),
	Layer.provideMerge(TestLaborerStore)
);

const runWithTestServices = <A, E>(
	effect: Effect.Effect<A, E, GithubTaskImporter | LaborerStore>
): Promise<A> =>
	Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const context = yield* Layer.build(TestLayer);
				return yield* Effect.provide(effect, Layer.succeedContext(context));
			})
		)
	);

const GITHUB_API_ERROR_REGEX =
	/GitHub API request failed \(403\): rate limited/;

describe("GithubTaskImporter.importProjectIssues", () => {
	const createdRepos: string[] = [];

	const createGithubRepo = (remoteUrl: string): string => {
		const repoPath = mkdtempSync(join(tmpdir(), "laborer-github-import-"));
		createdRepos.push(repoPath);
		execFileSync("git", ["init"], { cwd: repoPath });
		execFileSync("git", ["remote", "add", "origin", remoteUrl], {
			cwd: repoPath,
		});
		return repoPath;
	};

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		for (const repoPath of createdRepos.splice(0)) {
			rmSync(repoPath, { force: true, recursive: true });
		}
	});

	it("imports GitHub issues and skips pull requests and duplicates", async () => {
		const repoPath = createGithubRepo("git@github.com:acme/laborer.git");
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

		await runWithTestServices(
			Effect.gen(function* () {
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
						externalId: "https://github.com/acme/laborer/issues/101",
						title: "Already imported",
						status: "pending",
					})
				);

				const importer = yield* GithubTaskImporter;
				const result = yield* importer.importProjectIssues("project-1");

				expect(result).toEqual({ importedCount: 1, totalCount: 2 });

				const importedTasks = store.query(
					tables.tasks.where("projectId", "project-1")
				);
				expect(importedTasks).toHaveLength(2);
				expect(importedTasks).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							source: "github",
							externalId: "https://github.com/acme/laborer/issues/103",
							title: "Import task source picker issues",
							status: "pending",
						}),
					])
				);
			})
		);

		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.github.com/repos/acme/laborer/issues?state=open&per_page=100",
			expect.objectContaining({
				headers: expect.objectContaining({
					accept: "application/vnd.github+json",
					"user-agent": "laborer",
				}),
			})
		);
	});

	it("returns a typed error when the GitHub API request fails", async () => {
		const repoPath = createGithubRepo("https://github.com/acme/laborer.git");
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: false,
				status: 403,
				statusText: "Forbidden",
				text: async () => "rate limited",
			})
		);

		await expect(
			runWithTestServices(
				Effect.gen(function* () {
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
					return yield* importer.importProjectIssues("project-1");
				})
			)
		).rejects.toThrow(GITHUB_API_ERROR_REGEX);
	});
});
