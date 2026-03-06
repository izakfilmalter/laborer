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
});
