import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { Task, TaskStatus } from '@laborer/task-db'
import { taskDatabasePath } from '@laborer/task-db/path'
import { formatTaskIdentifier } from '@laborer/task-db/task-identifier'
import { createTaskUlid } from '@laborer/task-db/ulid'
import { Context, Effect, Layer, Schema } from 'effect'
import { ConfigService } from './config-service.js'
import { LaborerDatabase } from './laborer-database.js'
import { NodeTaskBoardDatabase } from './node-task-board-database.js'
import {
  findTaskByReference,
  nearestTaskProject,
  type TaskIdentifierProject,
} from './task-identifier-resolver.js'

const MAX_TITLE_LENGTH = 100
const MAX_DESCRIPTION_LENGTH = 100_000
const MAX_SEARCH_LENGTH = 1000

export interface AgentTaskProject extends TaskIdentifierProject {}

export interface AgentTask extends Task {
  readonly identifier: string
}

export interface AgentTaskListFilters {
  readonly includeCancelled?: boolean
  readonly path?: string
  readonly search?: string
  readonly status?: TaskStatus
}

export class AgentTaskError extends Schema.TaggedErrorClass<AgentTaskError>()(
  'AgentTaskError',
  {
    code: Schema.String,
    message: Schema.String,
  }
) {}

const linkedWorktreeMainPath = (path: string): string | undefined => {
  try {
    const commonDirectory = execFileSync(
      'git',
      ['-c', 'core.fsmonitor=false', 'rev-parse', '--git-common-dir'],
      { cwd: path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim()
    return dirname(realpathSync(resolve(path, commonDirectory)))
  } catch {
    return undefined
  }
}

const invalid = (message: string): AgentTaskError =>
  new AgentTaskError({ code: 'INVALID_INPUT', message })

const validateTitle = (title: string): string => {
  const value = title.trim()
  if (value.length === 0) {
    throw invalid('Task title must not be blank')
  }
  if (value.length > MAX_TITLE_LENGTH) {
    throw invalid(
      `Task title must be ${String(MAX_TITLE_LENGTH)} characters or fewer`
    )
  }
  return value
}

const validateDescription = (description: string | null | undefined) => {
  if (
    description !== undefined &&
    description !== null &&
    description.length > MAX_DESCRIPTION_LENGTH
  ) {
    throw invalid(
      `Task description must be ${String(MAX_DESCRIPTION_LENGTH)} characters or fewer`
    )
  }
  return description
}

const editablePatch = (input: {
  readonly description?: string | null
  readonly title?: string
}) => {
  if (input.title === undefined && input.description === undefined) {
    throw invalid('update_task requires title and/or description')
  }
  return {
    ...(input.title === undefined ? {} : { title: validateTitle(input.title) }),
    ...(input.description === undefined
      ? {}
      : { description: validateDescription(input.description) ?? null }),
  }
}

const serviceTry = <A>(operation: () => A): Effect.Effect<A, AgentTaskError> =>
  Effect.try({
    try: operation,
    catch: (cause) => {
      if (cause instanceof AgentTaskError) {
        return cause
      }
      const message =
        cause instanceof Error
          ? cause.message
          : 'Task database operation failed'
      const isCasConflict =
        message.toLowerCase().includes('stale revision') ||
        message.toLowerCase().includes('changed while moving')
      return new AgentTaskError({
        code: isCasConflict ? 'CAS_CONFLICT' : 'TASK_DATABASE_ERROR',
        message: isCasConflict
          ? `${message}. Refetch the task and retry with its latest revision.`
          : message,
      })
    },
  })

export class AgentTaskService extends Context.Service<
  AgentTaskService,
  {
    readonly createTask: (input: {
      readonly description?: string | null
      readonly path: string
      readonly title: string
    }) => Effect.Effect<AgentTask, AgentTaskError>
    readonly deleteTask: (
      id: string,
      expectedRevision: number
    ) => Effect.Effect<AgentTask, AgentTaskError>
    readonly getTask: (id: string) => Effect.Effect<AgentTask, AgentTaskError>
    readonly listProjects: () => Effect.Effect<
      readonly AgentTaskProject[],
      AgentTaskError
    >
    readonly listTasks: (
      filters: AgentTaskListFilters
    ) => Effect.Effect<readonly AgentTask[], AgentTaskError>
    readonly updateTask: (input: {
      readonly description?: string | null
      readonly expectedRevision: number
      readonly id: string
      readonly title?: string
    }) => Effect.Effect<AgentTask, AgentTaskError>
  }
>()('@laborer/server/AgentTaskService') {
  static layer(
    path = taskDatabasePath()
  ): Layer.Layer<AgentTaskService, never, LaborerDatabase> {
    return Layer.effect(
      AgentTaskService,
      Effect.gen(function* () {
        const laborerDatabase = yield* LaborerDatabase
        const configService = yield* ConfigService
        const listRegisteredProjects = () =>
          laborerDatabase.read('list agent task projects', (database) =>
            database
              .listProjects()
              .map(({ name, rootPath: repoPath }) => ({ name, repoPath }))
          )
        const listProjects = () =>
          Effect.gen(function* () {
            const projects = yield* listRegisteredProjects()
            return yield* Effect.forEach(projects, (project) =>
              configService.resolveConfig(project.repoPath, project.name).pipe(
                Effect.map((config) => ({
                  ...project,
                  aliases: config.shortNameAliases.value,
                  shortName: config.shortName.value,
                })),
                Effect.mapError(
                  (error) =>
                    new AgentTaskError({
                      code: 'INVALID_PROJECT_CONFIG',
                      message: `${project.repoPath}: ${error.message}`,
                    })
                )
              )
            )
          })
        const withDatabase = <A>(
          operation: (database: NodeTaskBoardDatabase) => A
        ) =>
          serviceTry(() => {
            const database = NodeTaskBoardDatabase.open(path)
            try {
              return operation(database)
            } finally {
              database.close()
            }
          })
        const resolveProject = (candidate: string) =>
          Effect.gen(function* () {
            const canonical = yield* Effect.try({
              try: () => realpathSync(candidate),
              catch: () =>
                new AgentTaskError({
                  code: 'UNKNOWN_PROJECT',
                  message: `Path does not belong to a registered Laborer project: ${candidate}`,
                }),
            })
            const projects = yield* listProjects()
            const project =
              nearestTaskProject(canonical, projects) ??
              nearestTaskProject(
                linkedWorktreeMainPath(canonical) ?? '',
                projects
              )
            if (!project) {
              return yield* new AgentTaskError({
                code: 'UNKNOWN_PROJECT',
                message: `Path does not belong to a registered Laborer project: ${candidate}`,
              })
            }
            return project
          })
        const exposeTask = (
          task: Task,
          projects: readonly AgentTaskProject[]
        ): AgentTask => {
          const project = nearestTaskProject(task.rootPath, projects)
          const shortName = project?.shortName ?? 'TASK'
          return {
            ...task,
            identifier: formatTaskIdentifier(shortName, task.taskNumber),
          }
        }
        const resolveTask = (id: string) =>
          Effect.gen(function* () {
            const projects = yield* listProjects()
            const task = yield* withDatabase((database) =>
              findTaskByReference(
                database,
                id,
                projects,
                (code, message) => new AgentTaskError({ code, message })
              )
            )
            return exposeTask(task, projects)
          })

        return AgentTaskService.of({
          listProjects,
          createTask: ({ description, path: candidate, title }) =>
            Effect.gen(function* () {
              const project = yield* resolveProject(candidate)
              const validTitle = yield* serviceTry(() => validateTitle(title))
              const validDescription = yield* serviceTry(() =>
                validateDescription(description)
              )
              const task = yield* withDatabase((database) =>
                database.insert({
                  description: validDescription ?? null,
                  id: createTaskUlid(),
                  rootPath: project.repoPath,
                  source: 'agent',
                  status: 'todo',
                  title: validTitle,
                })
              )
              return exposeTask(task, yield* listProjects())
            }),
          getTask: resolveTask,
          listTasks: (filters) =>
            Effect.gen(function* () {
              const project = filters.path
                ? yield* resolveProject(filters.path)
                : undefined
              const search = filters.search?.trim().toLowerCase()
              if (search && search.length > MAX_SEARCH_LENGTH) {
                return yield* invalid(
                  `Task search must be ${String(MAX_SEARCH_LENGTH)} characters or fewer`
                )
              }
              const projects = yield* listProjects()
              return yield* withDatabase((database) =>
                database
                  .snapshot()
                  .tasks.filter((task) => {
                    const taskProject = nearestTaskProject(
                      task.rootPath,
                      projects
                    )
                    const identifier = formatTaskIdentifier(
                      taskProject?.shortName ?? 'TASK',
                      task.taskNumber
                    ).toLowerCase()
                    return (
                      (filters.includeCancelled === true ||
                        task.status !== 'cancelled') &&
                      (!filters.status || task.status === filters.status) &&
                      (!project ||
                        taskProject?.repoPath === project.repoPath) &&
                      (!search ||
                        task.title.toLowerCase().includes(search) ||
                        task.branchName?.toLowerCase().includes(search) ===
                          true ||
                        identifier.includes(search))
                    )
                  })
                  .map((task) => exposeTask(task, projects))
              )
            }),
          updateTask: ({ description, expectedRevision, id, title }) =>
            Effect.gen(function* () {
              const resolved = yield* resolveTask(id)
              const projects = yield* listProjects()
              return yield* withDatabase((database) => {
                const current = database.find(resolved.id)
                if (!current) {
                  throw invalid(`Task not found: ${id}`)
                }
                if (current.source === 'execution') {
                  throw new AgentTaskError({
                    code: 'LOCKED_TASK',
                    message:
                      'Execution-source tasks are read-only to update_task',
                  })
                }
                const updated = database.update(
                  current.id,
                  expectedRevision,
                  editablePatch({
                    ...(description === undefined ? {} : { description }),
                    ...(title === undefined ? {} : { title }),
                  })
                )
                return exposeTask(updated, projects)
              })
            }),
          deleteTask: (id, expectedRevision) =>
            Effect.gen(function* () {
              const resolved = yield* resolveTask(id)
              const projects = yield* listProjects()
              const task = yield* withDatabase((database) =>
                database.update(resolved.id, expectedRevision, {
                  status: 'cancelled',
                })
              )
              return exposeTask(task, projects)
            }),
        })
      })
    ).pipe(Layer.provide(ConfigService.layer))
  }
}
