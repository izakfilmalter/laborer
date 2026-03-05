import { FetchHttpClient } from "@effect/platform";
import { RpcClient, RpcSerialization } from "@effect/rpc";
import { RpcError, TerminalRpcs } from "@laborer/shared/rpc";
import { tables } from "@laborer/shared/schema";
import { Array as Arr, Context, Effect, Layer, pipe, Stream } from "effect";
import { LaborerStore } from "./laborer-store.js";
import { TaskManager } from "./task-manager.js";

const ANSI_ESCAPE_REGEX = new RegExp(
	`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`,
	"g"
);

const GITHUB_MARKDOWN_LINK_REGEX =
	/\[([^\]]+)\]\((https:\/\/github\.com\/[^\s)]+\/issues\/\d+)\)/g;

const GITHUB_URL_REGEX = /(https:\/\/github\.com\/[^\s)]+\/issues\/\d+)/g;

const LINEAR_KEY_WITH_TITLE_REGEX =
	/\b([A-Z][A-Z0-9]+-\d+)\b\s*(?:[:-]\s*|\)\s+)(.+)$/;

const TITLE_WITH_LINEAR_KEY_REGEX = /^(.+?)\s+\(([A-Z][A-Z0-9]+-\d+)\)$/;
const CARRIAGE_RETURN_REGEX = /\r/g;
const NULL_CHARACTER = String.fromCharCode(0);
const LEADING_BULLET_REGEX = /^\s*[-*+]\s+/;
const LEADING_ORDERED_LIST_REGEX = /^\s*\d+[.)]\s+/;
const WHITESPACE_REGEX = /\s+/g;
const LEADING_SEPARATOR_REGEX = /^[:\-–—\s]+/;
const TRAILING_SEPARATOR_REGEX = /[:\-–—\s]+$/;
const GITHUB_ISSUE_NUMBER_REGEX = /\/issues\/(\d+)$/;

const logPrefix = "PrdTaskImporter";
const TERMINAL_SCROLLBACK_IDLE_MS = 150;
const TERMINAL_SCROLLBACK_TIMEOUT_MS = 2000;

interface ParsedPrdTask {
	readonly externalId: string;
	readonly title: string;
}

const normalizeText = (value: string): string =>
	value
		.replace(ANSI_ESCAPE_REGEX, "")
		.replace(CARRIAGE_RETURN_REGEX, "\n")
		.split(NULL_CHARACTER)
		.join("")
		.trim();

const normalizeTitle = (value: string): string =>
	value
		.replace(ANSI_ESCAPE_REGEX, "")
		.replace(LEADING_BULLET_REGEX, "")
		.replace(LEADING_ORDERED_LIST_REGEX, "")
		.replace(WHITESPACE_REGEX, " ")
		.replace(LEADING_SEPARATOR_REGEX, "")
		.replace(TRAILING_SEPARATOR_REGEX, "")
		.trim();

const createFallbackTitle = (externalId: string): string =>
	`PRD issue ${externalId}`;

const extractGithubFallbackTitle = (
	line: string,
	externalId: string
): string => {
	const withoutUrl = normalizeTitle(line.replace(externalId, ""));
	if (withoutUrl.length > 0) {
		return withoutUrl;
	}

	const issueNumber =
		externalId.match(GITHUB_ISSUE_NUMBER_REGEX)?.[1] ?? externalId;
	return createFallbackTitle(`#${issueNumber}`);
};

const pushUniqueTask = (
	results: ParsedPrdTask[],
	seenExternalIds: Set<string>,
	task: ParsedPrdTask
): void => {
	if (seenExternalIds.has(task.externalId)) {
		return;
	}

	seenExternalIds.add(task.externalId);
	results.push(task);
};

const parseGithubTasksFromLine = (
	line: string,
	results: ParsedPrdTask[],
	seenExternalIds: Set<string>
): void => {
	for (const match of line.matchAll(GITHUB_MARKDOWN_LINK_REGEX)) {
		const title = normalizeTitle(match[1] ?? "");
		const externalId = match[2]?.trim();
		if (!externalId) {
			continue;
		}

		pushUniqueTask(results, seenExternalIds, {
			externalId,
			title: title.length > 0 ? title : createFallbackTitle(externalId),
		});
	}

	for (const match of line.matchAll(GITHUB_URL_REGEX)) {
		const externalId = match[1]?.trim();
		if (!externalId) {
			continue;
		}

		pushUniqueTask(results, seenExternalIds, {
			externalId,
			title: extractGithubFallbackTitle(line, externalId),
		});
	}
};

const parseLinearTaskFromLine = (
	line: string,
	results: ParsedPrdTask[],
	seenExternalIds: Set<string>
): void => {
	const keyWithTitleMatch = line.match(LINEAR_KEY_WITH_TITLE_REGEX);
	if (keyWithTitleMatch?.[1] && keyWithTitleMatch[2]) {
		pushUniqueTask(results, seenExternalIds, {
			externalId: keyWithTitleMatch[1],
			title:
				normalizeTitle(keyWithTitleMatch[2]) ||
				createFallbackTitle(keyWithTitleMatch[1]),
		});
		return;
	}

	const titleWithKeyMatch = line.match(TITLE_WITH_LINEAR_KEY_REGEX);
	if (titleWithKeyMatch?.[1] && titleWithKeyMatch[2]) {
		pushUniqueTask(results, seenExternalIds, {
			externalId: titleWithKeyMatch[2],
			title:
				normalizeTitle(titleWithKeyMatch[1]) ||
				createFallbackTitle(titleWithKeyMatch[2]),
		});
	}
};

const parsePrdGeneratedTasks = (
	terminalOutput: string
): readonly ParsedPrdTask[] => {
	const normalizedOutput = normalizeText(terminalOutput);
	if (normalizedOutput.length === 0) {
		return [];
	}

	const lines = normalizedOutput
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);

	const results: ParsedPrdTask[] = [];
	const seenExternalIds = new Set<string>();

	for (const line of lines) {
		parseGithubTasksFromLine(line, results, seenExternalIds);
		parseLinearTaskFromLine(line, results, seenExternalIds);
	}

	return results;
};

const isStatusControlMessage = (data: string): boolean => {
	if (!(data.startsWith("{") && data.endsWith("}"))) {
		return false;
	}

	try {
		const parsed = JSON.parse(data) as { type?: string };
		return parsed.type === "status";
	} catch {
		return false;
	}
};

const readTerminalScrollback = (
	terminalUrl: string
): Effect.Effect<string, never> =>
	Effect.async<string, never>((resume) => {
		let output = "";
		let done = false;
		let idleTimer: ReturnType<typeof setTimeout> | null = null;
		let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

		const finish = (): void => {
			if (done) {
				return;
			}
			done = true;
			if (idleTimer !== null) {
				clearTimeout(idleTimer);
			}
			if (timeoutTimer !== null) {
				clearTimeout(timeoutTimer);
			}
			resume(Effect.succeed(output));
		};

		const scheduleIdleFinish = (): void => {
			if (idleTimer !== null) {
				clearTimeout(idleTimer);
			}
			idleTimer = setTimeout(finish, TERMINAL_SCROLLBACK_IDLE_MS);
		};

		const socket = new WebSocket(terminalUrl);
		socket.addEventListener("open", scheduleIdleFinish);
		socket.addEventListener("message", (event) => {
			if (typeof event.data !== "string") {
				scheduleIdleFinish();
				return;
			}

			if (!isStatusControlMessage(event.data)) {
				output += event.data;
			}

			scheduleIdleFinish();
		});
		socket.addEventListener("error", finish);
		socket.addEventListener("close", finish);

		timeoutTimer = setTimeout(() => {
			try {
				socket.close();
			} catch {
				finish();
			}
		}, TERMINAL_SCROLLBACK_TIMEOUT_MS);

		return Effect.sync(() => {
			if (socket.readyState === WebSocket.OPEN) {
				socket.close();
			}
		});
	});

class PrdTaskImporter extends Context.Tag("@laborer/PrdTaskImporter")<
	PrdTaskImporter,
	{
		readonly importParsedTasks: (
			workspaceId: string,
			parsedTasks: readonly ParsedPrdTask[]
		) => Effect.Effect<number, RpcError>;
		readonly watchPrdTerminal: (
			terminalId: string,
			workspaceId: string
		) => Effect.Effect<void, never>;
	}
>() {
	static readonly layer = Layer.scoped(
		PrdTaskImporter,
		Effect.gen(function* () {
			const { store } = yield* LaborerStore;
			const taskManager = yield* TaskManager;

			const { env } = yield* Effect.promise(
				() => import("@laborer/env/server")
			);
			const terminalServiceUrl = `http://localhost:${env.TERMINAL_PORT}`;

			const rpcClient = yield* RpcClient.make(TerminalRpcs).pipe(
				Effect.provide(
					RpcClient.layerProtocolHttp({
						url: `${terminalServiceUrl}/rpc`,
					}).pipe(
						Layer.provide(FetchHttpClient.layer),
						Layer.provide(RpcSerialization.layerJson)
					)
				)
			);

			const importParsedTasks = Effect.fn("PrdTaskImporter.importParsedTasks")(
				function* (workspaceId: string, parsedTasks: readonly ParsedPrdTask[]) {
					if (parsedTasks.length === 0) {
						return 0;
					}

					const workspace = pipe(
						store.query(tables.workspaces),
						Arr.findFirst((entry) => entry.id === workspaceId)
					);

					if (workspace._tag === "None") {
						return yield* new RpcError({
							message: `Workspace not found: ${workspaceId}`,
							code: "NOT_FOUND",
						});
					}

					const projectId = workspace.value.projectId;
					const existingExternalIds = new Set(
						store
							.query(tables.tasks.where("projectId", projectId))
							.filter(
								(task) => task.source === "prd" && task.externalId !== null
							)
							.map((task) => task.externalId as string)
					);

					let importedCount = 0;
					for (const task of parsedTasks) {
						if (existingExternalIds.has(task.externalId)) {
							continue;
						}

						yield* taskManager.createTask(
							projectId,
							task.title,
							"prd",
							task.externalId
						);
						existingExternalIds.add(task.externalId);
						importedCount += 1;
					}

					return importedCount;
				}
			);

			const watchPrdTerminal = (terminalId: string, workspaceId: string) =>
				Effect.gen(function* () {
					const list = yield* rpcClient.terminal
						.list()
						.pipe(Effect.catchAll(() => Effect.succeed([])));

					const terminal = list.find((entry) => entry.id === terminalId);
					if (terminal?.status !== "stopped") {
						yield* rpcClient.terminal.events().pipe(
							Stream.filter(
								(event) =>
									(event._tag === "Exited" && event.id === terminalId) ||
									(event._tag === "Removed" && event.id === terminalId) ||
									(event._tag === "StatusChanged" &&
										event.id === terminalId &&
										event.status === "stopped")
							),
							Stream.take(1),
							Stream.runDrain
						);
					}

					const output = yield* readTerminalScrollback(
						`ws://localhost:${env.TERMINAL_PORT}/terminal?id=${encodeURIComponent(terminalId)}`
					);
					const parsedTasks = parsePrdGeneratedTasks(output);

					if (parsedTasks.length === 0) {
						yield* Effect.log(
							`No PRD-generated tasks detected for terminal ${terminalId}`
						).pipe(Effect.annotateLogs("module", logPrefix));
						return;
					}

					const importedCount = yield* importParsedTasks(
						workspaceId,
						parsedTasks
					);

					yield* Effect.log(
						`Imported ${importedCount}/${parsedTasks.length} PRD-generated tasks for terminal ${terminalId}`
					).pipe(Effect.annotateLogs("module", logPrefix));
				}).pipe(
					Effect.catchAll((error) =>
						Effect.logWarning(
							`Failed to import PRD-generated tasks for terminal ${terminalId}: ${error instanceof Error ? error.message : String(error)}`
						).pipe(Effect.annotateLogs("module", logPrefix))
					)
				);

			return PrdTaskImporter.of({
				importParsedTasks,
				watchPrdTerminal,
			});
		})
	);
}

export { parsePrdGeneratedTasks, PrdTaskImporter };
export type { ParsedPrdTask };
