import {
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LaborerStore } from "../src/services/laborer-store.js";
import {
	DEFAULT_MCP_ENTRY_PATH,
	getDesiredMcpServerConfig,
	McpRegistrar,
	mergeOpencodeConfig,
	registerOpencodeConfig,
} from "../src/services/mcp-registrar.js";

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

const readJson = (filePath: string): Record<string, unknown> =>
	JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;

const DummyLaborerStoreLayer = Layer.succeed(LaborerStore, {
	store: {} as never,
});

let testRoot: string;

beforeAll(() => {
	testRoot = createTempDir("mcp-registrar");
});

afterAll(() => {
	if (testRoot) {
		rmSync(testRoot, { force: true, recursive: true });
	}
});

describe("mergeOpencodeConfig", () => {
	it("adds the laborer MCP entry while preserving existing servers", () => {
		const existing = {
			mcpServers: {
				github: {
					args: ["run", "github"],
					command: "bun",
					type: "stdio",
				},
			},
			theme: "light",
		};

		const { nextConfig, updated } = mergeOpencodeConfig(existing);

		expect(updated).toBe(true);
		expect(nextConfig.theme).toBe("light");
		expect(nextConfig.mcpServers).toEqual({
			github: existing.mcpServers.github,
			laborer: getDesiredMcpServerConfig(),
		});
	});

	it("does not mark config updated when the laborer entry already matches", () => {
		const existing = {
			mcpServers: {
				laborer: getDesiredMcpServerConfig(),
			},
		};

		const { nextConfig, updated } = mergeOpencodeConfig(existing);

		expect(updated).toBe(false);
		expect(nextConfig).toBe(existing);
	});
});

describe("registerOpencodeConfig", () => {
	it("creates a missing Opencode config file with the laborer entry", async () => {
		const configPath = join(testRoot, "missing", "config.json");

		const updatedFiles = await Effect.runPromise(
			registerOpencodeConfig({ opencodeConfigPath: configPath })
		);

		expect(updatedFiles).toEqual([configPath]);
		expect(readJson(configPath)).toEqual({
			mcpServers: {
				laborer: getDesiredMcpServerConfig(),
			},
		});
	});

	it("preserves existing Opencode MCP servers when updating the config", async () => {
		const configPath = join(testRoot, "preserve-existing", "config.json");
		mkdirSync(join(testRoot, "preserve-existing"), { recursive: true });
		writeFileSync(
			configPath,
			JSON.stringify(
				{
					mcpServers: {
						github: {
							args: ["run", "github"],
							command: "bun",
							type: "stdio",
						},
					},
				},
				null,
				2
			)
		);

		await Effect.runPromise(
			registerOpencodeConfig({ opencodeConfigPath: configPath })
		);

		expect(readJson(configPath)).toEqual({
			mcpServers: {
				github: {
					args: ["run", "github"],
					command: "bun",
					type: "stdio",
				},
				laborer: getDesiredMcpServerConfig(),
			},
		});
	});

	it("does not rewrite the file when the laborer entry is already current", async () => {
		const configPath = join(testRoot, "idempotent", "config.json");
		mkdirSync(join(testRoot, "idempotent"), { recursive: true });
		writeFileSync(
			configPath,
			`${JSON.stringify(
				{
					mcpServers: {
						laborer: getDesiredMcpServerConfig(),
					},
				},
				null,
				2
			)}\n`
		);

		const before = statSync(configPath).mtimeMs;
		await new Promise((resolvePromise) => {
			setTimeout(resolvePromise, 20);
		});

		const updatedFiles = await Effect.runPromise(
			registerOpencodeConfig({ opencodeConfigPath: configPath })
		);

		const after = statSync(configPath).mtimeMs;
		expect(updatedFiles).toEqual([]);
		expect(after).toBe(before);
	});
});

describe("McpRegistrar.layer", () => {
	it("runs registration during layer startup", async () => {
		const configPath = join(testRoot, "startup", "config.json");

		await Effect.runPromise(
			Effect.flatMap(McpRegistrar, () => Effect.void).pipe(
				Effect.provide(
					McpRegistrar.makeLayer({ opencodeConfigPath: configPath }).pipe(
						Layer.provide(DummyLaborerStoreLayer)
					)
				)
			)
		);

		expect(readJson(configPath)).toEqual({
			mcpServers: {
				laborer: getDesiredMcpServerConfig(DEFAULT_MCP_ENTRY_PATH),
			},
		});
	});
});
