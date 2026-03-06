import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll } from "vitest";
import { ConfigService } from "../src/services/config-service.js";
import {
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

const PrdStorageTestLayer = PrdStorageService.layer.pipe(
	Layer.provide(ConfigService.layer)
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
		assert.strictEqual(
			slugifyPrdTitle(" MCP Server & PRD Workflow! "),
			"mcp-server-prd-workflow"
		);
		assert.strictEqual(prdFileNameFromTitle("Plan / MVP"), "PRD-plan-mvp.md");
	});

	it.effect("creates PRD files under the resolved default prdsDir", () =>
		Effect.gen(function* () {
			const projectDir = join(testRoot, "default-prds-dir-project");
			const worktreeDir = join(testRoot, "default-prds-dir-worktrees");
			mkdirSync(projectDir, { recursive: true });
			writeFileSync(
				join(projectDir, "laborer.json"),
				JSON.stringify({ worktreeDir }, null, 2)
			);

			const service = yield* PrdStorageService;
			const filePath = yield* service.createPrdFile(
				projectDir,
				"default-prds-dir-project",
				"MCP Planning",
				"# PRD\n"
			);

			assert.strictEqual(
				filePath,
				join(worktreeDir, "prds", "PRD-mcp-planning.md")
			);
			assert.isTrue(existsSync(filePath));
			assert.strictEqual(readFileSync(filePath, "utf-8"), "# PRD\n");
		}).pipe(Effect.provide(PrdStorageTestLayer))
	);

	it.effect(
		"uses a custom prdsDir from laborer.json and reads files back",
		() =>
			Effect.gen(function* () {
				const projectDir = join(testRoot, "custom-prds-dir-project");
				const customPrdsDir = join(testRoot, "custom-prds-dir-output");
				mkdirSync(projectDir, { recursive: true });
				writeFileSync(
					join(projectDir, "laborer.json"),
					JSON.stringify({ prdsDir: customPrdsDir }, null, 2)
				);

				const service = yield* PrdStorageService;
				const filePath = yield* service.createPrdFile(
					projectDir,
					"custom-prds-dir-project",
					"Read Me Later",
					"## Body\n"
				);
				const content = yield* service.readPrdFile(filePath);
				const resolvedPrdsDir = yield* service.resolvePrdsDir(
					projectDir,
					"custom-prds-dir-project"
				);

				assert.strictEqual(resolvedPrdsDir, customPrdsDir);
				assert.strictEqual(
					filePath,
					join(customPrdsDir, "PRD-read-me-later.md")
				);
				assert.strictEqual(content, "## Body\n");
			}).pipe(Effect.provide(PrdStorageTestLayer))
	);
});
