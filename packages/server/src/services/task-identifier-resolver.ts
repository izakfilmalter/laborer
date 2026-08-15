import { RpcError } from '@laborer/shared/rpc'
import type { Task } from '@laborer/task-db'
import { parseTaskIdentifier } from '@laborer/task-db/task-identifier'
import { Array, Effect } from 'effect'
import { ConfigService } from './config-service.js'
import { NativeLaborerDatabase } from './native-laborer-database.js'
import { NodeTaskBoardDatabase } from './node-task-board-database.js'
import { resolveProjectTaskIdentifierNamespaces } from './project-task-identifiers.js'

export interface TaskIdentifierProject {
  readonly aliases: readonly string[]
  readonly name: string
  readonly repoPath: string
  readonly shortName: string
}

type IdentifierError = (code: string, message: string) => Error

const pathContains = (parent: string, child: string): boolean =>
  parent === child ||
  child.startsWith(parent.endsWith('/') ? parent : `${parent}/`)

export const nearestTaskProject = (
  path: string,
  projects: readonly TaskIdentifierProject[]
): TaskIdentifierProject | undefined =>
  projects
    .filter((project) => pathContains(project.repoPath, path))
    .sort((left, right) => right.repoPath.length - left.repoPath.length)[0]

export const findTaskByReference = (
  database: NodeTaskBoardDatabase,
  reference: string,
  projects: readonly TaskIdentifierProject[],
  makeError: IdentifierError
): Task => {
  const direct = database.find(reference)
  if (direct) {
    return direct
  }
  const parsed = parseTaskIdentifier(reference)
  const matchingProjects = parsed
    ? Array.filter(projects, (project) =>
        [project.shortName, ...project.aliases].includes(
          parsed.projectShortName
        )
      )
    : []
  if (matchingProjects.length > 1) {
    throw makeError(
      'AMBIGUOUS_IDENTIFIER',
      `Task identifier prefix ${parsed?.projectShortName ?? ''} belongs to more than one project. Set unique project short names in project settings.`
    )
  }
  const project = matchingProjects[0]
  const matches = project
    ? Array.filter(
        database.snapshot().tasks,
        (candidate) =>
          nearestTaskProject(candidate.rootPath, projects)?.repoPath ===
            project.repoPath && candidate.taskNumber === parsed?.taskNumber
      )
    : []
  if (matches.length > 1) {
    throw makeError(
      'AMBIGUOUS_IDENTIFIER',
      `Task identifier ${reference} matches more than one task`
    )
  }
  const task = matches[0]
  if (!task) {
    throw makeError('NOT_FOUND', `Task not found: ${reference}`)
  }
  return task
}

export const resolveTaskReferenceAtPath = (
  reference: string,
  databasePath: string
): Effect.Effect<Task, RpcError> =>
  Effect.gen(function* () {
    const direct = yield* Effect.try({
      try: () => {
        const database = NodeTaskBoardDatabase.open(databasePath)
        try {
          return database.find(reference)
        } finally {
          database.close()
        }
      },
      catch: (cause) =>
        new RpcError({
          code: 'TASK_BOARD_READ_FAILED',
          message:
            cause instanceof Error
              ? cause.message
              : 'Unable to read task board',
        }),
    })
    if (direct) {
      return direct
    }

    const storedProjects = yield* Effect.try({
      try: () => {
        const database = NativeLaborerDatabase.open(databasePath)
        try {
          return database.listProjects().map((project) => ({
            id: project.id,
            name: project.name,
            repoPath: project.rootPath,
          }))
        } finally {
          database.close()
        }
      },
      catch: (cause) =>
        new RpcError({
          code: 'TASK_BOARD_READ_FAILED',
          message:
            cause instanceof Error ? cause.message : 'Unable to read projects',
        }),
    })
    const configService = yield* ConfigService
    const projects = yield* resolveProjectTaskIdentifierNamespaces(
      storedProjects,
      configService
    ).pipe(
      Effect.mapError(
        (error) =>
          new RpcError({
            code: 'INVALID_PROJECT_CONFIG',
            message: error.message,
          })
      )
    )
    return yield* Effect.try({
      try: () => {
        const database = NodeTaskBoardDatabase.open(databasePath)
        try {
          return findTaskByReference(
            database,
            reference,
            projects,
            (code, message) => new RpcError({ code, message })
          )
        } finally {
          database.close()
        }
      },
      catch: (cause) =>
        cause instanceof RpcError
          ? cause
          : new RpcError({
              code: 'TASK_BOARD_READ_FAILED',
              message:
                cause instanceof Error
                  ? cause.message
                  : 'Unable to resolve task identifier',
            }),
    })
  }).pipe(Effect.provide(ConfigService.layer))
