import { Effect } from 'effect'
import type {
  LaborerDatabaseFailure,
  LaborerDatabaseService,
} from './laborer-database.js'
import {
  LaborerDatabaseStaleRevisionError,
  type LaborerTask,
  type LaborerTaskPatch,
} from './native-laborer-database.js'

const MAX_SERVER_CAS_ATTEMPTS = 5

const patchChangesTask = (
  task: LaborerTask,
  patch: LaborerTaskPatch
): boolean =>
  (Object.keys(patch) as (keyof LaborerTaskPatch)[]).some(
    (field) => task[field] !== patch[field]
  )

/**
 * Apply server-observed task facts without overwriting a concurrent writer.
 * Server observations do not arrive with a renderer revision, so each attempt
 * reads the authoritative row and still performs the write through revision
 * CAS. A concurrent winner is re-read and merged on the next attempt.
 */
export const updateServerTaskFacts = (
  service: LaborerDatabaseService,
  taskId: string,
  patch: LaborerTaskPatch,
  attempt = 1
): Effect.Effect<LaborerTask | null, LaborerDatabaseFailure> =>
  service
    .run('update server task facts', (database) => {
      const task = database.findTask(taskId)
      if (task === null || !patchChangesTask(task, patch)) {
        return task
      }
      return database.updateTask(taskId, task.revision, patch).row
    })
    .pipe(
      Effect.catchIf(
        (error) =>
          error instanceof LaborerDatabaseStaleRevisionError &&
          attempt < MAX_SERVER_CAS_ATTEMPTS,
        () => updateServerTaskFacts(service, taskId, patch, attempt + 1)
      )
    )

export const findWorkspaceTask = (
  service: LaborerDatabaseService,
  workspace: {
    readonly id: string
    readonly taskSource: string | null
    readonly worktreePath: string
  }
): Effect.Effect<LaborerTask | null, LaborerDatabaseFailure> =>
  service.run('find workspace task', (database) =>
    workspace.taskSource === null
      ? (database.findTask(workspace.id) ??
        database.findTaskByWorktreePath(workspace.worktreePath))
      : database.findTask(workspace.taskSource)
  )
