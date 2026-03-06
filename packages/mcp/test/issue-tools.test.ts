import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import { LaborerRpcClient } from "../src/services/laborer-rpc-client.js";
import { ProjectDiscovery } from "../src/services/project-discovery.js";
import { IssueTools, makeIssueToolHandlers } from "../src/tools/issue-tools.js";

const project = {
	id: "project-1",
	name: "laborer",
	repoPath: "/repo/laborer",
	rlphConfig: undefined,
} as const;

const task = {
	id: "task-1",
	projectId: project.id,
	source: "prd",
	prdId: "prd-1",
	externalId: "prd-1-issue-1",
	title: "Implement issue tools",
	status: "pending",
} as const;

const issuesMarkdown =
	"## Issue 1: Implement issue tools\n\n### What to build\n\nAdd MCP issue tools.";

const makeProjectDiscoveryLayer = () =>
	Layer.succeed(
		ProjectDiscovery,
		ProjectDiscovery.of({
			discoverProject: () => Effect.succeed(project),
		})
	);

const makeLaborerRpcClientLayer = (
	overrides: Partial<LaborerRpcClient["Type"]> = {}
) =>
	Layer.succeed(
		LaborerRpcClient,
		LaborerRpcClient.of({
			createIssue: () => Effect.succeed(task),
			createPrd: () => Effect.die("Not implemented in this test"),
			listProjects: () => Effect.succeed([project]),
			listRemainingIssues: () => Effect.succeed([task]),
			listPrds: () => Effect.die("Not implemented in this test"),
			readPrd: () => Effect.die("Not implemented in this test"),
			readIssues: () => Effect.succeed(issuesMarkdown),
			updateIssue: () => Effect.succeed({ ...task, status: "completed" }),
			updatePrd: () => Effect.die("Not implemented in this test"),
			...overrides,
		})
	);

const makeToolkit = (rpcOverrides: Partial<LaborerRpcClient["Type"]> = {}) =>
	IssueTools.pipe(
		Effect.provide(
			IssueTools.toLayer(makeIssueToolHandlers).pipe(
				Layer.provide(makeProjectDiscoveryLayer()),
				Layer.provide(makeLaborerRpcClientLayer(rpcOverrides))
			)
		)
	);

describe("IssueTools", () => {
	it("registers the expected MCP issue tools", () => {
		expect(Object.keys(IssueTools.tools)).toEqual([
			"create_issue",
			"read_issues",
			"update_issue",
			"list_remaining_issues",
		]);

		expect(IssueTools.tools.create_issue.description).toContain(
			"issues markdown file"
		);
		expect(IssueTools.tools.list_remaining_issues.description).toContain(
			"pending or in-progress"
		);
	});

	it("create_issue delegates to prd.createIssue", async () => {
		const createIssue = vi.fn(() => Effect.succeed(task));
		const toolkit = await Effect.runPromise(
			makeToolkit({
				createIssue,
			})
		);

		const result = await Effect.runPromise(
			toolkit.handle("create_issue", {
				prdId: task.prdId,
				title: task.title,
				body: "### What to build\n\nAdd MCP issue tools.",
			})
		);

		expect(createIssue).toHaveBeenCalledWith({
			prdId: task.prdId,
			title: task.title,
			body: "### What to build\n\nAdd MCP issue tools.",
		});
		expect(result.result).toEqual(task);
	});

	it("read_issues delegates to prd.readIssues", async () => {
		const readIssues = vi.fn(() => Effect.succeed(issuesMarkdown));
		const toolkit = await Effect.runPromise(
			makeToolkit({
				readIssues,
			})
		);

		const result = await Effect.runPromise(
			toolkit.handle("read_issues", { prdId: task.prdId })
		);

		expect(readIssues).toHaveBeenCalledWith({ prdId: task.prdId });
		expect(result.result).toBe(issuesMarkdown);
	});

	it("update_issue delegates to prd.updateIssue", async () => {
		const updateIssue = vi.fn(() =>
			Effect.succeed({
				...task,
				status: "completed",
			})
		);
		const toolkit = await Effect.runPromise(
			makeToolkit({
				updateIssue,
			})
		);

		const result = await Effect.runPromise(
			toolkit.handle("update_issue", {
				taskId: task.id,
				body: "### What to build\n\nShip the issue tools.",
				status: "completed",
			})
		);

		expect(updateIssue).toHaveBeenCalledWith({
			taskId: task.id,
			body: "### What to build\n\nShip the issue tools.",
			status: "completed",
		});
		expect(result.result).toEqual({
			...task,
			status: "completed",
		});
	});

	it("list_remaining_issues delegates to prd.listRemainingIssues", async () => {
		const listRemainingIssues = vi.fn(() => Effect.succeed([task]));
		const toolkit = await Effect.runPromise(
			makeToolkit({
				listRemainingIssues,
			})
		);

		const result = await Effect.runPromise(
			toolkit.handle("list_remaining_issues", {
				prdId: task.prdId,
			})
		);

		expect(listRemainingIssues).toHaveBeenCalledWith({ prdId: task.prdId });
		expect(result.result).toEqual([task]);
	});
});
