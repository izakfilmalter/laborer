import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigService } from "../src/services/config-service.js";
import {
	issuesFilePathFromPrdPath,
	PrdStorageService,
	prdFileNameFromTitle,
	slugifyPrdTitle,
} from "../src/services/prd-storage-service.js";

const createTempDir = (prefix: string): string => {
	const dir = join(
		homedir(),
		".config",
		"laborer-test",
		`${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
	);
	mkdirSync(dir, { recursive: true });
	return dir;
};

const runWithServices = <A>(
	effect: Effect.Effect<A, unknown, PrdStorageService>
): Promise<A> =>
	Effect.runPromise(
		effect.pipe(
			Effect.provide(
				PrdStorageService.layer.pipe(Layer.provide(ConfigService.layer))
			)
		)
	);

let testRoot: string;

beforeAll(() => {
	testRoot = createTempDir("prd-storage-service");
});

afterAll(() => {
	if (testRoot) {
		rmSync(testRoot, { recursive: true, force: true });
	}
});

describe("PrdStorageService", () => {
	it("slugifies PRD titles into safe file names", () => {
		expect(slugifyPrdTitle(" MCP Server & PRD Workflow! ")).toBe(
			"mcp-server-prd-workflow"
		);
		expect(prdFileNameFromTitle("Plan / MVP")).toBe("PRD-plan-mvp.md");
	});

	it("creates PRD files under the resolved default prdsDir", async () => {
		const projectDir = join(testRoot, "default-prds-dir-project");
		const worktreeDir = join(testRoot, "default-prds-dir-worktrees");
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(
			join(projectDir, "laborer.json"),
			JSON.stringify({ worktreeDir }, null, 2)
		);

		const filePath = await runWithServices(
			Effect.gen(function* () {
				const service = yield* PrdStorageService;
				return yield* service.createPrdFile(
					projectDir,
					"default-prds-dir-project",
					"MCP Planning",
					"# PRD\n"
				);
			})
		);

		expect(filePath).toBe(join(worktreeDir, "prds", "PRD-mcp-planning.md"));
		expect(existsSync(filePath)).toBe(true);
		expect(readFileSync(filePath, "utf-8")).toBe("# PRD\n");
	});

	it("uses a custom prdsDir from laborer.json and reads files back", async () => {
		const projectDir = join(testRoot, "custom-prds-dir-project");
		const customPrdsDir = join(testRoot, "custom-prds-dir-output");
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(
			join(projectDir, "laborer.json"),
			JSON.stringify({ prdsDir: customPrdsDir }, null, 2)
		);

		const result = await runWithServices(
			Effect.gen(function* () {
				const service = yield* PrdStorageService;
				const filePath = yield* service.createPrdFile(
					projectDir,
					"custom-prds-dir-project",
					"Read Me Later",
					"## Body\n"
				);
				const content = yield* service.readPrdFile(filePath);
				return {
					content,
					filePath,
					resolvedPrdsDir: yield* service.resolvePrdsDir(
						projectDir,
						"custom-prds-dir-project"
					),
				};
			})
		);

		expect(result.resolvedPrdsDir).toBe(customPrdsDir);
		expect(result.filePath).toBe(join(customPrdsDir, "PRD-read-me-later.md"));
		expect(result.content).toBe("## Body\n");
	});

	it("overwrites existing PRD files atomically", async () => {
		const projectDir = join(testRoot, "update-prds-dir-project");
		const customPrdsDir = join(testRoot, "update-prds-dir-output");
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(
			join(projectDir, "laborer.json"),
			JSON.stringify({ prdsDir: customPrdsDir }, null, 2)
		);

		const result = await runWithServices(
			Effect.gen(function* () {
				const service = yield* PrdStorageService;
				const filePath = yield* service.createPrdFile(
					projectDir,
					"update-prds-dir-project",
					"Editable Plan",
					"# Draft\n"
				);

				yield* service.updatePrdFile(filePath, "# Final\n");

				return {
					content: yield* service.readPrdFile(filePath),
					filePath,
				};
			})
		);

		expect(result.filePath).toBe(join(customPrdsDir, "PRD-editable-plan.md"));
		expect(result.content).toBe("# Final\n");
	});

	it("creates and appends companion PRD issues files with numbered sections", async () => {
		const projectDir = join(testRoot, "issues-prds-dir-project");
		const customPrdsDir = join(testRoot, "issues-prds-dir-output");
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(
			join(projectDir, "laborer.json"),
			JSON.stringify({ prdsDir: customPrdsDir }, null, 2)
		);

		const result = await runWithServices(
			Effect.gen(function* () {
				const service = yield* PrdStorageService;
				const prdFilePath = yield* service.createPrdFile(
					projectDir,
					"issues-prds-dir-project",
					"Issue Workflow",
					"# PRD\n"
				);

				const firstIssue = yield* service.appendIssue(
					prdFilePath,
					"Create issue RPC",
					"### What to build\n\nAdd the RPC handler."
				);
				const secondIssue = yield* service.appendIssue(
					prdFilePath,
					"List remaining issues",
					"### What to build\n\nFilter pending tasks."
				);

				return {
					firstIssue,
					issuesContent: readFileSync(firstIssue.issueFilePath, "utf-8"),
					issuesFilePath: firstIssue.issueFilePath,
					secondIssue,
				};
			})
		);

		expect(result.firstIssue.issueNumber).toBe(1);
		expect(result.secondIssue.issueNumber).toBe(2);
		expect(result.issuesFilePath).toBe(
			issuesFilePathFromPrdPath(join(customPrdsDir, "PRD-issue-workflow.md"))
		);
		expect(existsSync(result.issuesFilePath)).toBe(true);
		expect(result.issuesContent).toContain("## Issue 1: Create issue RPC");
		expect(result.issuesContent).toContain("## Issue 2: List remaining issues");
		expect(result.issuesContent).toContain("\n\n---\n\n");
	});

	it("reads companion PRD issues files and returns an empty string when missing", async () => {
		const projectDir = join(testRoot, "read-issues-prds-dir-project");
		const customPrdsDir = join(testRoot, "read-issues-prds-dir-output");
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(
			join(projectDir, "laborer.json"),
			JSON.stringify({ prdsDir: customPrdsDir }, null, 2)
		);

		const result = await runWithServices(
			Effect.gen(function* () {
				const service = yield* PrdStorageService;
				const prdFilePath = yield* service.createPrdFile(
					projectDir,
					"read-issues-prds-dir-project",
					"Issue Reader",
					"# PRD\n"
				);

				const emptyIssues = yield* service.readIssuesFile(prdFilePath);

				yield* service.appendIssue(
					prdFilePath,
					"Read issues RPC",
					"### What to build\n\nReturn issues content."
				);

				const populatedIssues = yield* service.readIssuesFile(prdFilePath);

				return {
					emptyIssues,
					populatedIssues,
				};
			})
		);

		expect(result.emptyIssues).toBe("");
		expect(result.populatedIssues).toContain("## Issue 1: Read issues RPC");
	});

	it("removes PRD files and companion issues files when deleting a PRD", async () => {
		const projectDir = join(testRoot, "remove-prd-project");
		const customPrdsDir = join(testRoot, "remove-prd-output");
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(
			join(projectDir, "laborer.json"),
			JSON.stringify({ prdsDir: customPrdsDir }, null, 2)
		);

		const result = await runWithServices(
			Effect.gen(function* () {
				const service = yield* PrdStorageService;
				const prdFilePath = yield* service.createPrdFile(
					projectDir,
					"remove-prd-project",
					"Disposable Plan",
					"# PRD\n"
				);

				const issue = yield* service.appendIssue(
					prdFilePath,
					"Linked issue",
					"### What to build\n\nDelete files."
				);

				yield* service.removePrdArtifacts(prdFilePath);

				return {
					issueFilePath: issue.issueFilePath,
					prdFilePath,
				};
			})
		);

		expect(existsSync(result.prdFilePath)).toBe(false);
		expect(existsSync(result.issueFilePath)).toBe(false);
	});
});
