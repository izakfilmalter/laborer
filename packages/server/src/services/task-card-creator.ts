import { RpcError } from '@laborer/shared/rpc'
import { isSlackMessageUrl } from '@laborer/shared/slack-url'
import type { TaskPatch, TaskStatus } from '@laborer/task-db'
import { taskDatabasePath } from '@laborer/task-db/path'
import { createTaskUlid, isTaskUlid } from '@laborer/task-db/ulid'
import { Effect } from 'effect'
import { NodeTaskBoardDatabase } from './node-task-board-database.js'
import {
  planSlackWorkspace,
  type SlackWorkspacePlan,
} from './slack-workspace-planner.js'

const MAX_CAS_ATTEMPTS = 5
const MAX_MANUAL_TITLE_LENGTH = 100
const MAX_MANUAL_BRANCH_SLUG_LENGTH = 48
const MANUAL_BRANCH_INVALID_CHARACTERS_PATTERN = /[^a-z0-9]+/gu
const MANUAL_BRANCH_BOUNDARY_HYPHENS_PATTERN = /^-+|-+$/gu
const UNICODE_MARK_PATTERN = /\p{M}+/gu

export type CreationColumn = Exclude<TaskStatus, 'cancelled'>

export interface CreateTaskCardInput {
  /**
   * Renderer-minted task ULID. When present, the stored row reuses the id the
   * optimistic card already renders under, and re-sending it is an
   * idempotent retry rather than a duplicate card.
   */
  readonly id?: string | null
  readonly rootPath: string
  readonly status: CreationColumn
  readonly text: string
}

/**
 * Unadorned branch name for a manually titled task.
 */
export const manualTaskBranchName = (title: string): string => {
  const slug = title
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(UNICODE_MARK_PATTERN, '')
    .replace(MANUAL_BRANCH_INVALID_CHARACTERS_PATTERN, '-')
    .replace(MANUAL_BRANCH_BOUNDARY_HYPHENS_PATTERN, '')
    .slice(0, MAX_MANUAL_BRANCH_SLUG_LENGTH)
    .replace(MANUAL_BRANCH_BOUNDARY_HYPHENS_PATTERN, '')
  return slug.length > 0 ? slug : 'task'
}

type SlackPlanner = (
  slackUrl: string,
  cwd?: string
) => Effect.Effect<SlackWorkspacePlan, RpcError>

/**
 * The stored card a client-minted id already refers to, if any. A retry
 * after a dropped response finds the original card here instead of
 * inserting a duplicate.
 */
const findReplayedCard = (
  path: string,
  requestedId: string | null
): Effect.Effect<
  {
    readonly id: string
    readonly inserted: false
    readonly source: 'manual' | 'slack_url'
  } | null,
  RpcError
> =>
  requestedId === null
    ? Effect.succeed(null)
    : withDatabase(path, (database) => {
        const existing = database.find(requestedId)
        if (existing === null) {
          return null
        }
        return {
          id: existing.id,
          inserted: false as const,
          source:
            existing.source === 'slack_url'
              ? ('slack_url' as const)
              : ('manual' as const),
        }
      })

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

/**
 * Mark a Slack card whose analysis never produced a prompt as failed, so the
 * board shows a retry instead of an indefinite spinner. A card that already
 * carries its prompt is left alone: its analysis did finish, and whatever went
 * wrong afterwards is not an analysis failure.
 */
export const markSlackAnalysisFailed = (
  taskId: string,
  path = taskDatabasePath()
): Effect.Effect<void, RpcError> =>
  withDatabase(path, (database) => {
    const task = database.find(taskId)
    return task !== null && task.description === null
  }).pipe(
    Effect.flatMap((unplanned) =>
      unplanned
        ? updateLatest(path, taskId, { executionStatus: 'failed' })
        : Effect.void
    )
  )

export const runSlackTaskPlanning = (
  taskId: string,
  slackUrl: string,
  rootPath: string,
  path = taskDatabasePath(),
  planner: SlackPlanner = planSlackWorkspace
): Effect.Effect<void> =>
  planner(slackUrl, rootPath).pipe(
    Effect.flatMap((plan) =>
      updateLatest(path, taskId, {
        branchName: plan.branchName,
        executionStatus: null,
        description: plan.initialPrompt,
        title: plan.title,
      })
    ),
    Effect.catch((error) =>
      updateLatest(path, taskId, { executionStatus: 'failed' }).pipe(
        Effect.catch((updateError) =>
          Effect.logError(
            `[task-board] Slack analysis failed for ${taskId}; the failure marker could not be stored: ${updateError.message}`
          )
        ),
        Effect.andThen(
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

    const isSlackUrl = isSlackMessageUrl(text)
    if (!isSlackUrl && text.length > MAX_MANUAL_TITLE_LENGTH) {
      return yield* new RpcError({
        code: 'INVALID_INPUT',
        message: `Card titles must be ${String(MAX_MANUAL_TITLE_LENGTH)} characters or fewer.`,
      })
    }

    const requestedId = input.id ?? null
    if (requestedId !== null && !isTaskUlid(requestedId)) {
      return yield* new RpcError({
        code: 'INVALID_INPUT',
        message: 'Task ids must be 26-character Crockford ULIDs.',
      })
    }

    const slackUrl = isSlackUrl ? new URL(text).toString() : null

    // A client-minted id makes creation idempotent: a retry after a dropped
    // response finds the stored card instead of inserting a duplicate. The
    // caller must not re-run side effects (planning, provisioning) for a
    // card that already exists, so the replay is reported explicitly.
    const replayed = yield* findReplayedCard(path, requestedId)
    if (replayed !== null) {
      return { ...replayed, status: input.status }
    }

    const task = yield* withDatabase(path, (database) =>
      database.insert({
        id: requestedId ?? createTaskUlid(),
        rootPath: input.rootPath,
        title: slackUrl ?? text,
        status: input.status,
        source: slackUrl ? 'slack_url' : 'manual',
        slackPermalink: slackUrl,
        executionStatus: slackUrl ? 'queued' : null,
      })
    )

    // A Slack card dropped straight into In Progress is analyzed by the
    // provisioning path instead: it needs the plan and the workspace created
    // under one task lock, so planning it here would duplicate the analysis.
    if (slackUrl && input.status !== 'in_progress') {
      yield* runSlackTaskPlanning(
        task.id,
        slackUrl,
        input.rootPath,
        path,
        planner
      ).pipe(Effect.forkDetach)
    }

    return {
      id: task.id,
      inserted: true,
      source: slackUrl === null ? ('manual' as const) : ('slack_url' as const),
      status: input.status,
    }
  })
