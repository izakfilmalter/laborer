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

interface McpRegistrarOptions {
	readonly mcpEntryPath?: string;
	readonly opencodeConfigPath?: string;
}

interface McpServerConfig {
	readonly args: readonly string[];
	readonly command: string;
	readonly type: "stdio";
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

const mergeOpencodeConfig = (
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

class McpRegistrar extends Context.Tag("@laborer/McpRegistrar")<
	McpRegistrar,
	{
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
					registerOpencode: () => registerOpencodeConfig(options),
					registerTargets: () => registerOpencodeConfig(options),
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
	getDesiredMcpServerConfig,
	hasMatchingMcpServerConfig,
	McpRegistrar,
	mergeOpencodeConfig,
	OPENCODE_CONFIG_PATH,
	registerOpencodeConfig,
};

export type { McpRegistrarOptions, McpServerConfig };
