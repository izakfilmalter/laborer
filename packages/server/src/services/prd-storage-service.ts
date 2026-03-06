import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { Context, Data, Effect, Layer } from 'effect'
import { ConfigService } from './config-service.js'

class PrdStorageError extends Data.TaggedError('PrdStorageError')<{
  readonly cause: unknown
  readonly message: string
}> {}

const logPrefix = 'PrdStorageService'

const slugifyPrdTitle = (title: string): string => {
  const slug = title
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')

  return slug.length > 0 ? slug : 'untitled'
}

const prdFileNameFromTitle = (title: string): string =>
  `PRD-${slugifyPrdTitle(title)}.md`

const issuesFileNameFromPrdPath = (prdFilePath: string): string => {
  const prdFileName = basename(prdFilePath)
  return prdFileName.endsWith('.md')
    ? `${prdFileName.slice(0, -3)}-issues.md`
    : `${prdFileName}-issues.md`
}

const issuesFilePathFromPrdPath = (prdFilePath: string): string =>
  resolve(join(dirname(prdFilePath), issuesFileNameFromPrdPath(prdFilePath)))

const ISSUE_HEADING_REGEX = /^## Issue (\d+): /gmu
const ISSUE_SECTION_REGEX = /^## Issue (\d+): (.+)$/gmu
const ISSUE_SECTION_SEPARATOR = '\n\n---\n\n'

const getNextIssueNumber = (issuesContent: string): number => {
  const issueNumbers = Array.from(
    issuesContent.matchAll(ISSUE_HEADING_REGEX),
    (match) => Number(match[1])
  ).filter((value) => Number.isInteger(value))

  if (issueNumbers.length === 0) {
    return 1
  }

  return Math.max(...issueNumbers) + 1
}

const formatIssueSection = (
  issueNumber: number,
  title: string,
  body: string
): string => {
  const trimmedBody = body.trim()
  return trimmedBody.length > 0
    ? `## Issue ${issueNumber}: ${title}\n\n${trimmedBody}\n`
    : `## Issue ${issueNumber}: ${title}\n`
}

interface IssueSection {
  readonly issueNumber: number
  readonly section: string
  readonly title: string
}

const parseIssueSections = (issuesContent: string): readonly IssueSection[] => {
  const matches = Array.from(issuesContent.matchAll(ISSUE_SECTION_REGEX))

  return matches.map((match, index) => {
    const start = match.index ?? 0
    const nextStart = matches[index + 1]?.index ?? issuesContent.length
    const rawSection = issuesContent.slice(start, nextStart)
    const section = rawSection.replace(/^\n+|\n+$/g, '')

    return {
      issueNumber: Number(match[1]),
      section,
      title: match[2]?.trim() ?? '',
    }
  })
}

const ensureDirectory = (
  directoryPath: string
): Effect.Effect<void, PrdStorageError> =>
  Effect.try({
    try: () => {
      if (!existsSync(directoryPath)) {
        mkdirSync(directoryPath, { recursive: true })
      }
    },
    catch: (cause) =>
      new PrdStorageError({
        message: `Failed to create PRDs directory ${directoryPath}`,
        cause,
      }),
  })

const writeFileAtomic = (
  targetPath: string,
  content: string
): Effect.Effect<void, PrdStorageError> =>
  Effect.gen(function* () {
    yield* ensureDirectory(dirname(targetPath))

    const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    yield* Effect.try({
      try: () => writeFileSync(tempPath, content, 'utf-8'),
      catch: (cause) =>
        new PrdStorageError({
          message: `Failed to write temp PRD file ${tempPath}`,
          cause,
        }),
    })

    yield* Effect.try({
      try: () => renameSync(tempPath, targetPath),
      catch: (cause) =>
        new PrdStorageError({
          message: `Failed to atomically move ${tempPath} to ${targetPath}`,
          cause,
        }),
    })
  })

class PrdStorageService extends Context.Tag('@laborer/PrdStorageService')<
  PrdStorageService,
  {
    readonly createPrdFile: (
      projectRepoPath: string,
      projectName: string,
      title: string,
      content: string
    ) => Effect.Effect<string, PrdStorageError>
    readonly readPrdFile: (
      filePath: string
    ) => Effect.Effect<string, PrdStorageError>
    readonly readIssuesFile: (
      prdFilePath: string
    ) => Effect.Effect<string, PrdStorageError>
    readonly updatePrdFile: (
      filePath: string,
      content: string
    ) => Effect.Effect<void, PrdStorageError>
    readonly appendIssue: (
      prdFilePath: string,
      title: string,
      body: string
    ) => Effect.Effect<
      {
        readonly issueFilePath: string
        readonly issueNumber: number
      },
      PrdStorageError
    >
    readonly updateIssue: (
      prdFilePath: string,
      title: string,
      body: string,
      issueNumber?: number
    ) => Effect.Effect<void, PrdStorageError>
    readonly removePrdArtifacts: (
      prdFilePath: string
    ) => Effect.Effect<void, PrdStorageError>
    readonly resolvePrdsDir: (
      projectRepoPath: string,
      projectName: string
    ) => Effect.Effect<string, never>
  }
>() {
  static readonly layer = Layer.effect(
    PrdStorageService,
    Effect.gen(function* () {
      const configService = yield* ConfigService

      const resolvePrdsDir = Effect.fn('PrdStorageService.resolvePrdsDir')(
        function* (projectRepoPath: string, projectName: string) {
          const resolvedConfig = yield* configService
            .resolveConfig(projectRepoPath, projectName)
            .pipe(Effect.orDie)

          return resolvedConfig.prdsDir.value
        }
      )

      const createPrdFile = Effect.fn('PrdStorageService.createPrdFile')(
        function* (
          projectRepoPath: string,
          projectName: string,
          title: string,
          content: string
        ) {
          const prdsDir = yield* resolvePrdsDir(projectRepoPath, projectName)
          const filePath = resolve(join(prdsDir, prdFileNameFromTitle(title)))

          yield* writeFileAtomic(filePath, content)

          yield* Effect.logDebug(`Created PRD file at ${filePath}`).pipe(
            Effect.annotateLogs('module', logPrefix)
          )

          return filePath
        }
      )

      const readPrdFile = Effect.fn('PrdStorageService.readPrdFile')(function* (
        filePath: string
      ) {
        return yield* Effect.try({
          try: () => readFileSync(filePath, 'utf-8'),
          catch: (cause) =>
            new PrdStorageError({
              message: `Failed to read PRD file ${filePath}`,
              cause,
            }),
        })
      })

      const readIssuesFile = Effect.fn('PrdStorageService.readIssuesFile')(
        function* (prdFilePath: string) {
          const issueFilePath = issuesFilePathFromPrdPath(prdFilePath)

          if (!existsSync(issueFilePath)) {
            return ''
          }

          return yield* Effect.try({
            try: () => readFileSync(issueFilePath, 'utf-8'),
            catch: (cause) =>
              new PrdStorageError({
                message: `Failed to read PRD issues file ${issueFilePath}`,
                cause,
              }),
          })
        }
      )

      const updatePrdFile = Effect.fn('PrdStorageService.updatePrdFile')(
        function* (filePath: string, content: string) {
          yield* writeFileAtomic(filePath, content)

          yield* Effect.logDebug(`Updated PRD file at ${filePath}`).pipe(
            Effect.annotateLogs('module', logPrefix)
          )
        }
      )

      const appendIssue = Effect.fn('PrdStorageService.appendIssue')(function* (
        prdFilePath: string,
        title: string,
        body: string
      ) {
        const issueFilePath = issuesFilePathFromPrdPath(prdFilePath)
        const existingContent = existsSync(issueFilePath)
          ? yield* Effect.try({
              try: () => readFileSync(issueFilePath, 'utf-8'),
              catch: (cause) =>
                new PrdStorageError({
                  message: `Failed to read PRD issues file ${issueFilePath}`,
                  cause,
                }),
            })
          : ''

        const issueNumber = getNextIssueNumber(existingContent)
        const issueSection = formatIssueSection(issueNumber, title, body)
        const nextContent =
          existingContent.trim().length > 0
            ? `${existingContent.trimEnd()}${ISSUE_SECTION_SEPARATOR}${issueSection}`
            : issueSection

        yield* writeFileAtomic(issueFilePath, nextContent)

        yield* Effect.logDebug(`Appended PRD issue at ${issueFilePath}`).pipe(
          Effect.annotateLogs('module', logPrefix)
        )

        return {
          issueFilePath,
          issueNumber,
        }
      })

      const updateIssue = Effect.fn('PrdStorageService.updateIssue')(function* (
        prdFilePath: string,
        title: string,
        body: string,
        issueNumber?: number
      ) {
        const issueFilePath = issuesFilePathFromPrdPath(prdFilePath)
        const issuesContent = yield* Effect.try({
          try: () => readFileSync(issueFilePath, 'utf-8'),
          catch: (cause) =>
            new PrdStorageError({
              message: `Failed to read PRD issues file ${issueFilePath}`,
              cause,
            }),
        })

        const sections = parseIssueSections(issuesContent)
        const targetIndex = sections.findIndex((section) =>
          issueNumber === undefined
            ? section.title === title
            : section.issueNumber === issueNumber || section.title === title
        )

        if (targetIndex === -1) {
          return yield* new PrdStorageError({
            message:
              issueNumber === undefined
                ? `PRD issue not found for title ${title}`
                : `PRD issue not found for issue ${issueNumber}: ${title}`,
            cause: new Error('Issue section not found'),
          })
        }

        const updatedSections = sections.map((section, index) =>
          index === targetIndex
            ? formatIssueSection(
                section.issueNumber,
                section.title,
                body
              ).trimEnd()
            : section.section
        )

        yield* writeFileAtomic(
          issueFilePath,
          `${updatedSections.join(ISSUE_SECTION_SEPARATOR)}\n`
        )

        yield* Effect.logDebug(`Updated PRD issue in ${issueFilePath}`).pipe(
          Effect.annotateLogs('module', logPrefix)
        )
      })

      const removePrdArtifacts = Effect.fn(
        'PrdStorageService.removePrdArtifacts'
      )(function* (prdFilePath: string) {
        const issueFilePath = issuesFilePathFromPrdPath(prdFilePath)

        const removeFileIfPresent = (filePath: string) =>
          Effect.try({
            try: () => {
              if (existsSync(filePath)) {
                unlinkSync(filePath)
              }
            },
            catch: (cause) =>
              new PrdStorageError({
                message: `Failed to remove PRD artifact ${filePath}`,
                cause,
              }),
          })

        yield* removeFileIfPresent(issueFilePath)
        yield* removeFileIfPresent(prdFilePath)

        yield* Effect.logDebug(
          `Removed PRD artifacts at ${prdFilePath} and ${issueFilePath}`
        ).pipe(Effect.annotateLogs('module', logPrefix))
      })

      return PrdStorageService.of({
        createPrdFile,
        readPrdFile,
        readIssuesFile,
        updatePrdFile,
        appendIssue,
        updateIssue,
        removePrdArtifacts,
        resolvePrdsDir,
      })
    })
  )
}

export {
  PrdStorageError,
  PrdStorageService,
  issuesFilePathFromPrdPath,
  prdFileNameFromTitle,
  slugifyPrdTitle,
  writeFileAtomic,
}
