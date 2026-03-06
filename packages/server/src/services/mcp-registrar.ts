import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Context, Data, Effect, Layer } from "effect";
import { LaborerStore } from "./laborer-store.js";

class RegistrarIOError extends Data.TaggedError("RegistrarIOError")<{
	readonly message: string;
	readonly cause: unknown;
}> {}

const logPrefix = "McpRegistrar";

const MCP_SERVER_NAME = "laborer";

const DEFAULT_MCP_ENTRY_PATH = fileURLToPath(
	new URL("../../../mcp/src/main.ts", import.meta.url)
);

const OPENCODE_CONFIG_PATH = join(
	homedir(),
	".config",
	"opencode",
	"config.json"
);

const CLAUDE_CONFIG_PATH = join(homedir(), ".claude.json");

const CODEX_CONFIG_PATH = join(homedir(), ".codex", "config.toml");

interface McpRegistrarOptions {
	readonly claudeConfigPath?: string;
	readonly codexConfigPath?: string;
	readonly mcpEntryPath?: string;
	readonly opencodeConfigPath?: string;
}

interface McpServerConfig {
	readonly args: readonly string[];
	readonly command: string;
	readonly type: "stdio";
}

interface OpencodeLocalMcpConfig {
	readonly command: readonly string[];
	readonly type: "local";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

const getDesiredMcpServerConfig = (
	mcpEntryPath: string = DEFAULT_MCP_ENTRY_PATH
): McpServerConfig => ({
	args: ["run", resolve(mcpEntryPath)],
	command: "bun",
	type: "stdio",
});

const getDesiredOpencodeMcpConfig = (
	mcpEntryPath: string = DEFAULT_MCP_ENTRY_PATH
): OpencodeLocalMcpConfig => ({
	command: ["bun", "run", resolve(mcpEntryPath)],
	type: "local",
});

const hasMatchingMcpServerConfig = (
	value: unknown,
	expected: McpServerConfig
): boolean => {
	if (!isRecord(value)) {
		return false;
	}

	const { args, command, type } = value;

	return (
		command === expected.command &&
		type === expected.type &&
		Array.isArray(args) &&
		args.length === expected.args.length &&
		args.every(
			(argument, index) =>
				typeof argument === "string" && argument === expected.args[index]
		)
	);
};

const hasMatchingOpencodeMcpConfig = (
	value: unknown,
	expected: OpencodeLocalMcpConfig
): boolean => {
	if (!isRecord(value)) {
		return false;
	}

	const { command, type } = value;

	return (
		type === expected.type &&
		Array.isArray(command) &&
		command.length === expected.command.length &&
		command.every(
			(argument, index) =>
				typeof argument === "string" && argument === expected.command[index]
		)
	);
};

const mergeOpencodeConfig = (
	existingConfig: Record<string, unknown>,
	mcpEntryPath: string = DEFAULT_MCP_ENTRY_PATH
): {
	readonly nextConfig: Record<string, unknown>;
	readonly updated: boolean;
} => {
	const expectedServerConfig = getDesiredOpencodeMcpConfig(mcpEntryPath);
	const existingMcp = isRecord(existingConfig.mcp) ? existingConfig.mcp : {};
	const existingLaborerEntry = existingMcp[MCP_SERVER_NAME];

	if (
		hasMatchingOpencodeMcpConfig(existingLaborerEntry, expectedServerConfig)
	) {
		return {
			nextConfig: existingConfig,
			updated: false,
		};
	}

	return {
		nextConfig: {
			...existingConfig,
			mcp: {
				...existingMcp,
				[MCP_SERVER_NAME]: expectedServerConfig,
			},
		},
		updated: true,
	};
};

const mergeClaudeConfig = (
	existingConfig: Record<string, unknown>,
	mcpEntryPath: string = DEFAULT_MCP_ENTRY_PATH
): {
	readonly nextConfig: Record<string, unknown>;
	readonly updated: boolean;
} => {
	const expectedServerConfig = getDesiredMcpServerConfig(mcpEntryPath);
	const existingServers = isRecord(existingConfig.mcpServers)
		? existingConfig.mcpServers
		: {};
	const existingLaborerEntry = existingServers[MCP_SERVER_NAME];

	if (hasMatchingMcpServerConfig(existingLaborerEntry, expectedServerConfig)) {
		return {
			nextConfig: existingConfig,
			updated: false,
		};
	}

	return {
		nextConfig: {
			...existingConfig,
			mcpServers: {
				...existingServers,
				[MCP_SERVER_NAME]: expectedServerConfig,
			},
		},
		updated: true,
	};
};

const getDesiredCodexMcpConfigBlock = (
	mcpEntryPath: string = DEFAULT_MCP_ENTRY_PATH
): string => {
	const resolvedPath = resolve(mcpEntryPath).replaceAll("\\", "\\\\");
	return [
		`[mcp_servers.${MCP_SERVER_NAME}]`,
		'command = "bun"',
		`args = ["run", "${resolvedPath}"]`,
		"",
	].join("\n");
};

const mergeCodexConfig = (
	existingConfig: string,
	mcpEntryPath: string = DEFAULT_MCP_ENTRY_PATH
): {
	readonly nextConfig: string;
	readonly updated: boolean;
} => {
	const desiredBlock = getDesiredCodexMcpConfigBlock(mcpEntryPath);
	const normalizedExisting = existingConfig.replace(/\r\n/g, "\n");
	const codexSectionRegex = new RegExp(
		`(^|\\n)\\[mcp_servers\\.${MCP_SERVER_NAME.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\]\\n[\\s\\S]*?(?=\\n\\[|$)`,
		"u"
	);
	const match = normalizedExisting.match(codexSectionRegex);

	if (match?.[0] === `\n${desiredBlock}` || match?.[0] === desiredBlock) {
		return {
			nextConfig: normalizedExisting,
			updated: false,
		};
	}

	if (match) {
		const replacementPrefix = match[0].startsWith("\n") ? "\n" : "";
		return {
			nextConfig: normalizedExisting.replace(
				codexSectionRegex,
				`${replacementPrefix}${desiredBlock}`
			),
			updated: true,
		};
	}

	let separator = "";
	if (normalizedExisting.length > 0 && !normalizedExisting.endsWith("\n\n")) {
		separator = normalizedExisting.endsWith("\n") ? "\n" : "\n\n";
	}

	return {
		nextConfig: `${normalizedExisting}${separator}${desiredBlock}`,
		updated: true,
	};
};

const ensureParentDirectory = (
	filePath: string
): Effect.Effect<void, RegistrarIOError> =>
	Effect.try({
		try: () => mkdirSync(dirname(filePath), { recursive: true }),
		catch: (cause) =>
			new RegistrarIOError({
				message: `Failed to create directory for ${filePath}`,
				cause,
			}),
	});

const readJsonObject = (
	filePath: string
): Effect.Effect<Record<string, unknown> | undefined, RegistrarIOError> =>
	Effect.gen(function* () {
		if (!existsSync(filePath)) {
			return undefined;
		}

		const content = yield* Effect.try({
			try: () => readFileSync(filePath, "utf-8"),
			catch: (cause) =>
				new RegistrarIOError({
					message: `Failed to read config file ${filePath}`,
					cause,
				}),
		});

		const parsed = yield* Effect.try({
			try: () => JSON.parse(content) as unknown,
			catch: (cause) =>
				new RegistrarIOError({
					message: `Failed to parse config file ${filePath}`,
					cause,
				}),
		});

		if (!isRecord(parsed)) {
			return yield* new RegistrarIOError({
				message: `Expected JSON object in ${filePath}`,
				cause: parsed,
			});
		}

		return parsed;
	});

const writeJsonAtomic = (
	filePath: string,
	content: Record<string, unknown>
): Effect.Effect<void, RegistrarIOError> =>
	Effect.gen(function* () {
		yield* ensureParentDirectory(filePath);

		const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

		yield* Effect.try({
			try: () =>
				writeFileSync(tempPath, `${JSON.stringify(content, null, 2)}\n`, {
					encoding: "utf-8",
				}),
			catch: (cause) =>
				new RegistrarIOError({
					message: `Failed to write temp config file ${tempPath}`,
					cause,
				}),
		});

		yield* Effect.try({
			try: () => renameSync(tempPath, filePath),
			catch: (cause) =>
				new RegistrarIOError({
					message: `Failed to atomically move ${tempPath} to ${filePath}`,
					cause,
				}),
		});
	});

const readTextFile = (
	filePath: string
): Effect.Effect<string | undefined, RegistrarIOError> =>
	Effect.gen(function* () {
		if (!existsSync(filePath)) {
			return undefined;
		}

		return yield* Effect.try({
			try: () => readFileSync(filePath, "utf-8"),
			catch: (cause) =>
				new RegistrarIOError({
					message: `Failed to read config file ${filePath}`,
					cause,
				}),
		});
	});

const writeTextAtomic = (
	filePath: string,
	content: string
): Effect.Effect<void, RegistrarIOError> =>
	Effect.gen(function* () {
		yield* ensureParentDirectory(filePath);

		const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

		yield* Effect.try({
			try: () =>
				writeFileSync(tempPath, content, {
					encoding: "utf-8",
				}),
			catch: (cause) =>
				new RegistrarIOError({
					message: `Failed to write temp config file ${tempPath}`,
					cause,
				}),
		});

		yield* Effect.try({
			try: () => renameSync(tempPath, filePath),
			catch: (cause) =>
				new RegistrarIOError({
					message: `Failed to atomically move ${tempPath} to ${filePath}`,
					cause,
				}),
		});
	});

const registerOpencodeConfig = ({
	mcpEntryPath = DEFAULT_MCP_ENTRY_PATH,
	opencodeConfigPath = OPENCODE_CONFIG_PATH,
}: McpRegistrarOptions = {}): Effect.Effect<readonly string[], never> =>
	Effect.gen(function* () {
		const existingConfig =
			(yield* readJsonObject(opencodeConfigPath)) ??
			({} as Record<string, unknown>);
		const { nextConfig, updated } = mergeOpencodeConfig(
			existingConfig,
			mcpEntryPath
		);

		if (!updated) {
			return [] as const;
		}

		yield* writeJsonAtomic(opencodeConfigPath, nextConfig);
		yield* Effect.logInfo(`Updated MCP config: ${opencodeConfigPath}`).pipe(
			Effect.annotateLogs("module", logPrefix)
		);
		return [opencodeConfigPath] as const;
	}).pipe(
		Effect.catchAll((error) =>
			Effect.gen(function* () {
				yield* Effect.logWarning(
					`${error.message}: ${String(error.cause)}`
				).pipe(Effect.annotateLogs("module", logPrefix));
				return [] as const;
			})
		)
	);

const registerClaudeConfig = ({
	claudeConfigPath = CLAUDE_CONFIG_PATH,
	mcpEntryPath = DEFAULT_MCP_ENTRY_PATH,
}: McpRegistrarOptions = {}): Effect.Effect<readonly string[], never> =>
	Effect.gen(function* () {
		const existingConfig =
			(yield* readJsonObject(claudeConfigPath)) ??
			({} as Record<string, unknown>);
		const { nextConfig, updated } = mergeClaudeConfig(
			existingConfig,
			mcpEntryPath
		);

		if (!updated) {
			return [] as const;
		}

		yield* writeJsonAtomic(claudeConfigPath, nextConfig);
		yield* Effect.logInfo(`Updated MCP config: ${claudeConfigPath}`).pipe(
			Effect.annotateLogs("module", logPrefix)
		);
		return [claudeConfigPath] as const;
	}).pipe(
		Effect.catchAll((error) =>
			Effect.gen(function* () {
				yield* Effect.logWarning(
					`${error.message}: ${String(error.cause)}`
				).pipe(Effect.annotateLogs("module", logPrefix));
				return [] as const;
			})
		)
	);

const registerCodexConfig = ({
	codexConfigPath = CODEX_CONFIG_PATH,
	mcpEntryPath = DEFAULT_MCP_ENTRY_PATH,
}: McpRegistrarOptions = {}): Effect.Effect<readonly string[], never> =>
	Effect.gen(function* () {
		const existingConfig = (yield* readTextFile(codexConfigPath)) ?? "";
		const { nextConfig, updated } = mergeCodexConfig(
			existingConfig,
			mcpEntryPath
		);

		if (!updated) {
			return [] as const;
		}

		yield* writeTextAtomic(codexConfigPath, nextConfig);
		yield* Effect.logInfo(`Updated MCP config: ${codexConfigPath}`).pipe(
			Effect.annotateLogs("module", logPrefix)
		);
		return [codexConfigPath] as const;
	}).pipe(
		Effect.catchAll((error) =>
			Effect.gen(function* () {
				yield* Effect.logWarning(
					`${error.message}: ${String(error.cause)}`
				).pipe(Effect.annotateLogs("module", logPrefix));
				return [] as const;
			})
		)
	);

class McpRegistrar extends Context.Tag("@laborer/McpRegistrar")<
	McpRegistrar,
	{
		readonly registerClaude: () => Effect.Effect<readonly string[], never>;
		readonly registerCodex: () => Effect.Effect<readonly string[], never>;
		readonly registerOpencode: () => Effect.Effect<readonly string[], never>;
		readonly registerTargets: () => Effect.Effect<readonly string[], never>;
	}
>() {
	static makeLayer(options: McpRegistrarOptions = {}) {
		return Layer.scoped(
			McpRegistrar,
			Effect.gen(function* () {
				yield* LaborerStore;

				const service = McpRegistrar.of({
					registerClaude: () => registerClaudeConfig(options),
					registerCodex: () => registerCodexConfig(options),
					registerOpencode: () => registerOpencodeConfig(options),
					registerTargets: () =>
						Effect.all([
							registerOpencodeConfig(options),
							registerClaudeConfig(options),
							registerCodexConfig(options),
						]).pipe(Effect.map((updatedFiles) => updatedFiles.flat())),
				});

				yield* service.registerTargets();
				return service;
			})
		);
	}

	static readonly layer = McpRegistrar.makeLayer();
}

export {
	DEFAULT_MCP_ENTRY_PATH,
	CLAUDE_CONFIG_PATH,
	CODEX_CONFIG_PATH,
	getDesiredMcpServerConfig,
	getDesiredOpencodeMcpConfig,
	getDesiredCodexMcpConfigBlock,
	hasMatchingMcpServerConfig,
	hasMatchingOpencodeMcpConfig,
	McpRegistrar,
	mergeClaudeConfig,
	mergeCodexConfig,
	mergeOpencodeConfig,
	OPENCODE_CONFIG_PATH,
	registerClaudeConfig,
	registerCodexConfig,
	registerOpencodeConfig,
};

export type { McpRegistrarOptions, McpServerConfig, OpencodeLocalMcpConfig };
