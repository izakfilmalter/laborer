import { randomBytes } from 'node:crypto'
import { RpcError } from '@laborer/shared/rpc'
import { isSlackMessageUrl } from '@laborer/shared/slack-url'
import type { TaskPatch, TaskStatus } from '@laborer/task-db'
import { taskDatabasePath } from '@laborer/task-db/path'
import { Effect } from 'effect'
import { NodeTaskBoardDatabase } from './node-task-board-database.js'
import {
  planSlackWorkspace,
  type SlackWorkspacePlan,
} from './slack-workspace-planner.js'

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const MAX_CAS_ATTEMPTS = 5

export type CreationColumn = Exclude<TaskStatus, 'cancelled'>

export interface CreateTaskCardInput {
  readonly rootPath: string
  readonly status: CreationColumn
  readonly text: string
}

type SlackPlanner = (
  slackUrl: string
) => Effect.Effect<SlackWorkspacePlan, RpcError>

export const createTaskUlid = (time = Date.now()): string => {
  let timestamp = time
  let encodedTime = ''
  for (let index = 0; index < 10; index += 1) {
    encodedTime = CROCKFORD[timestamp % 32] + encodedTime
    timestamp = Math.floor(timestamp / 32)
  }
  const entropy = randomBytes(16)
  let encodedRandom = ''
  for (let index = 0; index < 16; index += 1) {
    encodedRandom += CROCKFORD[(entropy[index] ?? 0) % 32]
  }
  return encodedTime + encodedRandom
}

const databaseError = (cause: unknown) =>
  new RpcError({
    code: 'TASK_CREATE_FAILED',
    message:
      cause instanceof Error ? cause.message : 'Unable to create the task card',
  })

const withDatabase = <A>(
  path: string,
  operation: (database: NodeTaskBoardDatabase) => A
): Effect.Effect<A, RpcError> =>
  Effect.try({
    try: () => {
      const database = NodeTaskBoardDatabase.open(path)
      try {
        return operation(database)
      } finally {
        database.close()
      }
    },
    catch: databaseError,
  })

const updateLatest = (
  path: string,
  taskId: string,
  patch: TaskPatch
): Effect.Effect<void, RpcError> =>
  withDatabase(path, (database) => {
    for (let attempt = 1; attempt <= MAX_CAS_ATTEMPTS; attempt += 1) {
      const task = database.find(taskId)
      if (!task) {
        throw new Error(`Task not found: ${taskId}`)
      }
      try {
        database.update(taskId, task.revision, patch)
        return
      } catch (error) {
        if (
          attempt === MAX_CAS_ATTEMPTS ||
          !(error instanceof Error && error.message.includes('stale revision'))
        ) {
          throw error
        }
      }
    }
  })

export const runSlackTaskPlanning = (
  taskId: string,
  slackUrl: string,
  path = taskDatabasePath(),
  planner: SlackPlanner = planSlackWorkspace
): Effect.Effect<void> =>
  planner(slackUrl).pipe(
    Effect.flatMap((plan) =>
      updateLatest(path, taskId, {
        branchName: plan.branchName,
        executionStatus: null,
        initialPrompt: plan.initialPrompt,
        title: plan.title,
      })
    ),
    Effect.catchAll((error) =>
      updateLatest(path, taskId, { executionStatus: 'failed' }).pipe(
        Effect.catchAll((updateError) =>
          Effect.logError(
            `[task-board] Slack analysis failed for ${taskId}; the failure marker could not be stored: ${updateError.message}`
          )
        ),
        Effect.zipRight(
          Effect.logWarning(
            `[task-board] Slack analysis failed for ${taskId}: ${error.message}`
          )
        )
      )
    )
  )

export const createTaskCard = (
  input: CreateTaskCardInput,
  path = taskDatabasePath(),
  planner: SlackPlanner = planSlackWorkspace
) =>
  Effect.gen(function* () {
    const text = input.text.trim()
    if (text.length === 0) {
      return yield* new RpcError({
        code: 'INVALID_INPUT',
        message: 'Enter a card title or Slack message URL.',
      })
    }

    const slackUrl = isSlackMessageUrl(text) ? new URL(text).toString() : null
    const task = yield* withDatabase(path, (database) =>
      database.insert({
        id: createTaskUlid(),
        rootPath: input.rootPath,
        title: slackUrl ?? text,
        status: slackUrl ? 'todo' : input.status,
        source: slackUrl ? 'slack_url' : 'manual',
        slackPermalink: slackUrl,
        executionStatus: slackUrl ? 'queued' : null,
      })
    )

    if (slackUrl) {
      yield* runSlackTaskPlanning(task.id, slackUrl, path, planner).pipe(
        Effect.forkDaemon
      )
    }

    return {
      id: task.id,
      source: task.source as 'manual' | 'slack_url',
      status: task.status as CreationColumn,
    }
  })
