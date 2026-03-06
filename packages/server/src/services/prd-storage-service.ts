import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Context, Data, Effect, Layer } from "effect";
import { ConfigService } from "./config-service.js";

class PrdStorageError extends Data.TaggedError("PrdStorageError")<{
	readonly cause: unknown;
	readonly message: string;
}> {}

const logPrefix = "PrdStorageService";

const slugifyPrdTitle = (title: string): string => {
	const slug = title
		.trim()
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-");

	return slug.length > 0 ? slug : "untitled";
};

const prdFileNameFromTitle = (title: string): string =>
	`PRD-${slugifyPrdTitle(title)}.md`;

const issuesFileNameFromPrdPath = (prdFilePath: string): string => {
	const prdFileName = basename(prdFilePath);
	return prdFileName.endsWith(".md")
		? `${prdFileName.slice(0, -3)}-issues.md`
		: `${prdFileName}-issues.md`;
};

const issuesFilePathFromPrdPath = (prdFilePath: string): string =>
	resolve(join(dirname(prdFilePath), issuesFileNameFromPrdPath(prdFilePath)));

const ISSUE_HEADING_REGEX = /^## Issue (\d+): /gmu;

const getNextIssueNumber = (issuesContent: string): number => {
	const issueNumbers = Array.from(
		issuesContent.matchAll(ISSUE_HEADING_REGEX),
		(match) => Number(match[1])
	).filter((value) => Number.isInteger(value));

	if (issueNumbers.length === 0) {
		return 1;
	}

	return Math.max(...issueNumbers) + 1;
};

const formatIssueSection = (
	issueNumber: number,
	title: string,
	body: string
): string => {
	const trimmedBody = body.trim();
	return trimmedBody.length > 0
		? `## Issue ${issueNumber}: ${title}\n\n${trimmedBody}\n`
		: `## Issue ${issueNumber}: ${title}\n`;
};

const ensureDirectory = (
	directoryPath: string
): Effect.Effect<void, PrdStorageError> =>
	Effect.try({
		try: () => {
			if (!existsSync(directoryPath)) {
				mkdirSync(directoryPath, { recursive: true });
			}
		},
		catch: (cause) =>
			new PrdStorageError({
				message: `Failed to create PRDs directory ${directoryPath}`,
				cause,
			}),
	});

const writeFileAtomic = (
	targetPath: string,
	content: string
): Effect.Effect<void, PrdStorageError> =>
	Effect.gen(function* () {
		yield* ensureDirectory(dirname(targetPath));

		const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

		yield* Effect.try({
			try: () => writeFileSync(tempPath, content, "utf-8"),
			catch: (cause) =>
				new PrdStorageError({
					message: `Failed to write temp PRD file ${tempPath}`,
					cause,
				}),
		});

		yield* Effect.try({
			try: () => renameSync(tempPath, targetPath),
			catch: (cause) =>
				new PrdStorageError({
					message: `Failed to atomically move ${tempPath} to ${targetPath}`,
					cause,
				}),
		});
	});

class PrdStorageService extends Context.Tag("@laborer/PrdStorageService")<
	PrdStorageService,
	{
		readonly createPrdFile: (
			projectRepoPath: string,
			projectName: string,
			title: string,
			content: string
		) => Effect.Effect<string, PrdStorageError>;
		readonly readPrdFile: (
			filePath: string
		) => Effect.Effect<string, PrdStorageError>;
		readonly appendIssue: (
			prdFilePath: string,
			title: string,
			body: string
		) => Effect.Effect<
			{
				readonly issueFilePath: string;
				readonly issueNumber: number;
			},
			PrdStorageError
		>;
		readonly removePrdArtifacts: (
			prdFilePath: string
		) => Effect.Effect<void, PrdStorageError>;
		readonly resolvePrdsDir: (
			projectRepoPath: string,
			projectName: string
		) => Effect.Effect<string, never>;
	}
>() {
	static readonly layer = Layer.effect(
		PrdStorageService,
		Effect.gen(function* () {
			const configService = yield* ConfigService;

			const resolvePrdsDir = Effect.fn("PrdStorageService.resolvePrdsDir")(
				function* (projectRepoPath: string, projectName: string) {
					const resolvedConfig = yield* configService.resolveConfig(
						projectRepoPath,
						projectName
					);

					return resolvedConfig.prdsDir.value;
				}
			);

			const createPrdFile = Effect.fn("PrdStorageService.createPrdFile")(
				function* (
					projectRepoPath: string,
					projectName: string,
					title: string,
					content: string
				) {
					const prdsDir = yield* resolvePrdsDir(projectRepoPath, projectName);
					const filePath = resolve(join(prdsDir, prdFileNameFromTitle(title)));

					yield* writeFileAtomic(filePath, content);

					yield* Effect.logDebug(`Created PRD file at ${filePath}`).pipe(
						Effect.annotateLogs("module", logPrefix)
					);

					return filePath;
				}
			);

			const readPrdFile = Effect.fn("PrdStorageService.readPrdFile")(function* (
				filePath: string
			) {
				return yield* Effect.try({
					try: () => readFileSync(filePath, "utf-8"),
					catch: (cause) =>
						new PrdStorageError({
							message: `Failed to read PRD file ${filePath}`,
							cause,
						}),
				});
			});

			const appendIssue = Effect.fn("PrdStorageService.appendIssue")(function* (
				prdFilePath: string,
				title: string,
				body: string
			) {
				const issueFilePath = issuesFilePathFromPrdPath(prdFilePath);
				const existingContent = existsSync(issueFilePath)
					? yield* Effect.try({
							try: () => readFileSync(issueFilePath, "utf-8"),
							catch: (cause) =>
								new PrdStorageError({
									message: `Failed to read PRD issues file ${issueFilePath}`,
									cause,
								}),
						})
					: "";

				const issueNumber = getNextIssueNumber(existingContent);
				const issueSection = formatIssueSection(issueNumber, title, body);
				const nextContent =
					existingContent.trim().length > 0
						? `${existingContent.trimEnd()}\n\n---\n\n${issueSection}`
						: issueSection;

				yield* writeFileAtomic(issueFilePath, nextContent);

				yield* Effect.logDebug(`Appended PRD issue at ${issueFilePath}`).pipe(
					Effect.annotateLogs("module", logPrefix)
				);

				return {
					issueFilePath,
					issueNumber,
				};
			});

			const removePrdArtifacts = Effect.fn(
				"PrdStorageService.removePrdArtifacts"
			)(function* (prdFilePath: string) {
				const issueFilePath = issuesFilePathFromPrdPath(prdFilePath);

				const removeFileIfPresent = (filePath: string) =>
					Effect.try({
						try: () => {
							if (existsSync(filePath)) {
								unlinkSync(filePath);
							}
						},
						catch: (cause) =>
							new PrdStorageError({
								message: `Failed to remove PRD artifact ${filePath}`,
								cause,
							}),
					});

				yield* removeFileIfPresent(issueFilePath);
				yield* removeFileIfPresent(prdFilePath);

				yield* Effect.logDebug(
					`Removed PRD artifacts at ${prdFilePath} and ${issueFilePath}`
				).pipe(Effect.annotateLogs("module", logPrefix));
			});

			return PrdStorageService.of({
				createPrdFile,
				readPrdFile,
				appendIssue,
				removePrdArtifacts,
				resolvePrdsDir,
			});
		})
	);
}

export {
	PrdStorageError,
	PrdStorageService,
	issuesFilePathFromPrdPath,
	prdFileNameFromTitle,
	slugifyPrdTitle,
	writeFileAtomic,
};
