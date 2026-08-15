import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { labelColorForName } from '@laborer/shared/labels'
import { LABEL_NAME_MAX_LENGTH, type LabelColor } from '@laborer/shared/rpc'
import type { Task, TaskStatus } from '@laborer/task-db'
import { taskDatabasePath } from '@laborer/task-db/path'
import { createTaskUlid } from '@laborer/task-db/ulid'
import { Context, Effect, Layer, Schema } from 'effect'
import { LaborerDatabase } from './laborer-database.js'
import {
  type Label,
  LaborerDatabaseLabelNameConflictError,
  LaborerDatabaseStaleRevisionError,
  LaborerDatabaseUnknownLabelError,
  MAX_TASK_LABELS,
} from './native-laborer-database.js'
import { NodeTaskBoardDatabase } from './node-task-board-database.js'

const MAX_TITLE_LENGTH = 100
const MAX_DESCRIPTION_LENGTH = 100_000
const MAX_SEARCH_LENGTH = 1000

export interface AgentTaskProject {
  readonly name: string
  readonly repoPath: string
}

export interface AgentTaskListFilters {
  readonly includeCancelled?: boolean
  readonly path?: string
  readonly search?: string
  readonly status?: TaskStatus
}

export class AgentTaskError extends Schema.TaggedError<AgentTaskError>()(
  'AgentTaskError',
  {
    code: Schema.String,
    message: Schema.String,
  }
) {}

const pathContains = (parent: string, child: string): boolean =>
  parent === child ||
  child.startsWith(parent.endsWith('/') ? parent : `${parent}/`)

const nearestProject = (
  path: string,
  projects: readonly AgentTaskProject[]
): AgentTaskProject | undefined =>
  projects
    .filter((project) => pathContains(project.repoPath, path))
    .sort((left, right) => right.repoPath.length - left.repoPath.length)[0]

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

const validateLabelName = (name: string): string => {
  const value = name.trim()
  if (value.length === 0) {
    throw invalid('Label name must not be blank')
  }
  if (value.length > LABEL_NAME_MAX_LENGTH) {
    throw invalid(
      `Label name must be ${String(LABEL_NAME_MAX_LENGTH)} characters or fewer`
    )
  }
  return value
}

/**
 * Maps a label write failure onto the agent-facing code vocabulary. The
 * database layer wraps unexpected causes, so the original error is unwrapped
 * before it is classified.
 */
const labelFailure = (failure: unknown): AgentTaskError => {
  const cause =
    failure instanceof Error && failure.cause !== undefined
      ? failure.cause
      : failure
  if (cause instanceof LaborerDatabaseLabelNameConflictError) {
    return new AgentTaskError({
      code: 'NAME_CONFLICT',
      message: cause.message,
    })
  }
  if (cause instanceof LaborerDatabaseUnknownLabelError) {
    return new AgentTaskError({ code: 'NOT_FOUND', message: cause.message })
  }
  if (cause instanceof LaborerDatabaseStaleRevisionError) {
    return new AgentTaskError({
      code: 'CAS_CONFLICT',
      message: `${cause.message}. Refetch the row and retry with its latest revision.`,
    })
  }
  return new AgentTaskError({
    code: 'TASK_DATABASE_ERROR',
    message: cause instanceof Error ? cause.message : 'Label operation failed',
  })
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
    readonly createLabel: (input: {
      readonly color?: LabelColor
      readonly name: string
    }) => Effect.Effect<Label, AgentTaskError>
    readonly createTask: (input: {
      readonly description?: string | null
      readonly path: string
      readonly title: string
    }) => Effect.Effect<Task, AgentTaskError>
    readonly deleteLabel: (
      id: string,
      expectedRevision: number
    ) => Effect.Effect<Label, AgentTaskError>
    readonly deleteTask: (
      id: string,
      expectedRevision: number
    ) => Effect.Effect<Task, AgentTaskError>
    readonly getTask: (id: string) => Effect.Effect<Task, AgentTaskError>
    readonly listLabels: () => Effect.Effect<readonly Label[], AgentTaskError>
    readonly listProjects: () => Effect.Effect<readonly AgentTaskProject[]>
    readonly listTasks: (
      filters: AgentTaskListFilters
    ) => Effect.Effect<readonly Task[], AgentTaskError>
    readonly setTaskLabels: (input: {
      readonly expectedRevision: number
      readonly id: string
      readonly labelIds: readonly string[]
    }) => Effect.Effect<Task, AgentTaskError>
    readonly updateLabel: (input: {
      readonly color?: LabelColor
      readonly expectedRevision: number
      readonly id: string
      readonly name?: string
    }) => Effect.Effect<Label, AgentTaskError>
    readonly updateTask: (input: {
      readonly description?: string | null
      readonly expectedRevision: number
      readonly id: string
      readonly title?: string
    }) => Effect.Effect<Task, AgentTaskError>
  }
>()('@laborer/server/AgentTaskService') {
  static layer(
    path = taskDatabasePath()
  ): Layer.Layer<AgentTaskService, never, LaborerDatabase> {
    return Layer.effect(
      AgentTaskService,
      Effect.gen(function* () {
        const laborerDatabase = yield* LaborerDatabase
        const listProjects = () =>
          laborerDatabase.read('list agent task projects', (database) =>
            database
              .listProjects()
              .map(({ name, rootPath: repoPath }) => ({ name, repoPath }))
          )
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
              nearestProject(canonical, projects) ??
              nearestProject(linkedWorktreeMainPath(canonical) ?? '', projects)
            if (!project) {
              return yield* new AgentTaskError({
                code: 'UNKNOWN_PROJECT',
                message: `Path does not belong to a registered Laborer project: ${candidate}`,
              })
            }
            return project
          })
        const requireLabel = (id: string) =>
          laborerDatabase
            .read('find agent label', (database) => database.findLabel(id))
            .pipe(
              Effect.flatMap((label) =>
                label === null
                  ? new AgentTaskError({
                      code: 'NOT_FOUND',
                      message: `Label not found: ${id}`,
                    })
                  : Effect.succeed(label)
              )
            )

        return AgentTaskService.of({
          listProjects,
          createTask: ({ description, path: candidate, title }) =>
            Effect.gen(function* () {
              const project = yield* resolveProject(candidate)
              const validTitle = yield* serviceTry(() => validateTitle(title))
              const validDescription = yield* serviceTry(() =>
                validateDescription(description)
              )
              return yield* withDatabase((database) =>
                database.insert({
                  description: validDescription ?? null,
                  id: createTaskUlid(),
                  rootPath: project.repoPath,
                  source: 'agent',
                  status: 'todo',
                  title: validTitle,
                })
              )
            }),
          getTask: (id) =>
            withDatabase((database) => {
              const task = database.find(id)
              if (!task) {
                throw new AgentTaskError({
                  code: 'NOT_FOUND',
                  message: `Task not found: ${id}`,
                })
              }
              return task
            }),
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
                database.snapshot().tasks.filter((task) => {
                  const taskProject = nearestProject(task.rootPath, projects)
                  return (
                    (filters.includeCancelled === true ||
                      task.status !== 'cancelled') &&
                    (!filters.status || task.status === filters.status) &&
                    (!project || taskProject?.repoPath === project.repoPath) &&
                    (!search ||
                      task.title.toLowerCase().includes(search) ||
                      task.branchName?.toLowerCase().includes(search) === true)
                  )
                })
              )
            }),
          updateTask: ({ description, expectedRevision, id, title }) =>
            withDatabase((database) => {
              const current = database.find(id)
              if (!current) {
                throw new AgentTaskError({
                  code: 'NOT_FOUND',
                  message: `Task not found: ${id}`,
                })
              }
              if (current.source === 'execution') {
                throw new AgentTaskError({
                  code: 'LOCKED_TASK',
                  message:
                    'Execution-source tasks are read-only to update_task',
                })
              }
              return database.update(
                id,
                expectedRevision,
                editablePatch({
                  ...(description === undefined ? {} : { description }),
                  ...(title === undefined ? {} : { title }),
                })
              )
            }),
          listLabels: () =>
            laborerDatabase.read('list agent labels', (database) =>
              database.listLabels()
            ),
          createLabel: ({ color, name }) =>
            Effect.gen(function* () {
              const validName = yield* serviceTry(() => validateLabelName(name))
              const result = yield* laborerDatabase
                .run('create agent label', (database) =>
                  database.createLabel({
                    color: color ?? labelColorForName(validName),
                    name: validName,
                  })
                )
                .pipe(Effect.mapError(labelFailure))
              return result.row
            }),
          updateLabel: ({ color, expectedRevision, id, name }) =>
            Effect.gen(function* () {
              if (color === undefined && name === undefined) {
                return yield* invalid('update_label requires name and/or color')
              }
              const validName =
                name === undefined
                  ? undefined
                  : yield* serviceTry(() => validateLabelName(name))
              yield* requireLabel(id)
              const result = yield* laborerDatabase
                .run('update agent label', (database) =>
                  database.updateLabel(id, expectedRevision, {
                    ...(color === undefined ? {} : { color }),
                    ...(validName === undefined ? {} : { name: validName }),
                  })
                )
                .pipe(Effect.mapError(labelFailure))
              return result.row
            }),
          deleteLabel: (id, expectedRevision) =>
            Effect.gen(function* () {
              yield* requireLabel(id)
              const result = yield* laborerDatabase
                .run('delete agent label', (database) =>
                  database.deleteLabel(id, expectedRevision)
                )
                .pipe(Effect.mapError(labelFailure))
              return result.row
            }),
          setTaskLabels: ({ expectedRevision, id, labelIds }) =>
            Effect.gen(function* () {
              const requested = [...new Set(labelIds)]
              if (requested.length > MAX_TASK_LABELS) {
                return yield* invalid(
                  `A task carries at most ${String(MAX_TASK_LABELS)} labels`
                )
              }
              yield* withDatabase((database) => {
                if (!database.find(id)) {
                  throw new AgentTaskError({
                    code: 'NOT_FOUND',
                    message: `Task not found: ${id}`,
                  })
                }
                return null
              })
              yield* laborerDatabase
                .run('set agent task labels', (database) =>
                  database.setTaskLabels(
                    id,
                    expectedRevision,
                    requested,
                    createTaskUlid()
                  )
                )
                .pipe(Effect.mapError(labelFailure))
              return yield* withDatabase((database) => {
                const task = database.find(id)
                if (!task) {
                  throw new AgentTaskError({
                    code: 'NOT_FOUND',
                    message: `Task not found: ${id}`,
                  })
                }
                return task
              })
            }),
          deleteTask: (id, expectedRevision) =>
            withDatabase((database) => {
              const current = database.find(id)
              if (!current) {
                throw new AgentTaskError({
                  code: 'NOT_FOUND',
                  message: `Task not found: ${id}`,
                })
              }
              return database.update(id, expectedRevision, {
                status: 'cancelled',
              })
            }),
        })
      })
    )
  }
}
