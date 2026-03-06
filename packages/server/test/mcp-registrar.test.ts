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
	getDesiredCodexMcpConfigBlock,
	getDesiredMcpServerConfig,
	getDesiredOpencodeMcpConfig,
	McpRegistrar,
	mergeClaudeConfig,
	mergeCodexConfig,
	mergeOpencodeConfig,
	registerClaudeConfig,
	registerCodexConfig,
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
			mcp: {
				github: {
					command: ["bun", "run", "github"],
					type: "local",
				},
			},
			theme: "light",
		};

		const { nextConfig, updated } = mergeOpencodeConfig(existing);

		expect(updated).toBe(true);
		expect(nextConfig.theme).toBe("light");
		expect(nextConfig.mcp).toEqual({
			github: existing.mcp.github,
			laborer: getDesiredOpencodeMcpConfig(),
		});
	});

	it("does not mark config updated when the laborer entry already matches", () => {
		const existing = {
			mcp: {
				laborer: getDesiredOpencodeMcpConfig(),
			},
		};

		const { nextConfig, updated } = mergeOpencodeConfig(existing);

		expect(updated).toBe(false);
		expect(nextConfig).toBe(existing);
	});
});

describe("mergeClaudeConfig", () => {
	it("adds the laborer MCP entry while preserving existing servers", () => {
		const existing = {
			mcpServers: {
				filesystem: {
					args: ["server"],
					command: "node",
					type: "stdio",
				},
			},
		};

		const { nextConfig, updated } = mergeClaudeConfig(existing);

		expect(updated).toBe(true);
		expect(nextConfig.mcpServers).toEqual({
			filesystem: existing.mcpServers.filesystem,
			laborer: getDesiredMcpServerConfig(),
		});
	});
});

describe("mergeCodexConfig", () => {
	it("appends the laborer MCP server block to a new config", () => {
		const { nextConfig, updated } = mergeCodexConfig("");

		expect(updated).toBe(true);
		expect(nextConfig).toBe(getDesiredCodexMcpConfigBlock());
	});

	it("replaces an existing laborer block while preserving other config", () => {
		const existing = [
			'model = "gpt-5.4"',
			"",
			"[mcp_servers.github]",
			'command = "npx"',
			'args = ["-y", "@github/mcp"]',
			"",
			"[mcp_servers.laborer]",
			'command = "node"',
			'args = ["old.js"]',
			"",
		].join("\n");

		const { nextConfig, updated } = mergeCodexConfig(existing);

		expect(updated).toBe(true);
		expect(nextConfig).toContain('model = "gpt-5.4"');
		expect(nextConfig).toContain("[mcp_servers.github]");
		expect(nextConfig).toContain(getDesiredCodexMcpConfigBlock());
		expect(nextConfig).not.toContain('command = "node"');
	});

	it("does not update when the existing laborer block already matches", () => {
		const existing = [
			'model = "gpt-5.4"',
			"",
			getDesiredCodexMcpConfigBlock(),
		].join("\n");

		const { nextConfig, updated } = mergeCodexConfig(existing);

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
			mcp: {
				laborer: getDesiredOpencodeMcpConfig(),
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
					mcp: {
						github: {
							command: ["bun", "run", "github"],
							type: "local",
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
			mcp: {
				github: {
					command: ["bun", "run", "github"],
					type: "local",
				},
				laborer: getDesiredOpencodeMcpConfig(),
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
					mcp: {
						laborer: getDesiredOpencodeMcpConfig(),
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

describe("registerClaudeConfig", () => {
	it("creates a missing Claude config file with the laborer entry", async () => {
		const configPath = join(testRoot, "claude-missing", "claude.json");

		const updatedFiles = await Effect.runPromise(
			registerClaudeConfig({ claudeConfigPath: configPath })
		);

		expect(updatedFiles).toEqual([configPath]);
		expect(readJson(configPath)).toEqual({
			mcpServers: {
				laborer: getDesiredMcpServerConfig(),
			},
		});
	});
});

describe("registerCodexConfig", () => {
	it("creates a missing Codex config file with the laborer MCP block", async () => {
		const configPath = join(testRoot, "codex-missing", "config.toml");

		const updatedFiles = await Effect.runPromise(
			registerCodexConfig({ codexConfigPath: configPath })
		);

		expect(updatedFiles).toEqual([configPath]);
		expect(readFileSync(configPath, "utf-8")).toBe(
			getDesiredCodexMcpConfigBlock()
		);
	});

	it("preserves existing Codex config content when adding the laborer block", async () => {
		const configPath = join(testRoot, "codex-preserve", "config.toml");
		mkdirSync(join(testRoot, "codex-preserve"), { recursive: true });
		writeFileSync(
			configPath,
			[
				'model = "gpt-5.4"',
				"",
				"[mcp_servers.github]",
				'command = "npx"',
				'args = ["-y", "@github/mcp"]',
				"",
			].join("\n")
		);

		await Effect.runPromise(
			registerCodexConfig({ codexConfigPath: configPath })
		);

		const content = readFileSync(configPath, "utf-8");
		expect(content).toContain('model = "gpt-5.4"');
		expect(content).toContain("[mcp_servers.github]");
		expect(content).toContain(getDesiredCodexMcpConfigBlock());
	});

	it("does not rewrite the Codex config when the laborer block is already current", async () => {
		const configPath = join(testRoot, "codex-idempotent", "config.toml");
		mkdirSync(join(testRoot, "codex-idempotent"), { recursive: true });
		writeFileSync(configPath, getDesiredCodexMcpConfigBlock());

		const before = statSync(configPath).mtimeMs;
		await new Promise((resolvePromise) => {
			setTimeout(resolvePromise, 20);
		});

		const updatedFiles = await Effect.runPromise(
			registerCodexConfig({ codexConfigPath: configPath })
		);

		const after = statSync(configPath).mtimeMs;
		expect(updatedFiles).toEqual([]);
		expect(after).toBe(before);
	});
});

describe("McpRegistrar.layer", () => {
	it("runs registration during layer startup", async () => {
		const opencodeConfigPath = join(testRoot, "startup", "opencode.json");
		const claudeConfigPath = join(testRoot, "startup", "claude.json");
		const codexConfigPath = join(testRoot, "startup", "config.toml");

		await Effect.runPromise(
			Effect.flatMap(McpRegistrar, () => Effect.void).pipe(
				Effect.provide(
					McpRegistrar.makeLayer({
						claudeConfigPath,
						codexConfigPath,
						opencodeConfigPath,
					}).pipe(Layer.provide(DummyLaborerStoreLayer))
				)
			)
		);

		expect(readJson(opencodeConfigPath)).toEqual({
			mcp: {
				laborer: getDesiredOpencodeMcpConfig(DEFAULT_MCP_ENTRY_PATH),
			},
		});
		expect(readJson(claudeConfigPath)).toEqual({
			mcpServers: {
				laborer: getDesiredMcpServerConfig(DEFAULT_MCP_ENTRY_PATH),
			},
		});
		expect(readFileSync(codexConfigPath, "utf-8")).toBe(
			getDesiredCodexMcpConfigBlock(DEFAULT_MCP_ENTRY_PATH)
		);
	});
});
