import { basename, dirname, join } from 'node:path'
import {
  NativeTaskDatabase,
  type Task,
  TaskStaleRevisionError,
} from '@laborer/task-db'
import { createTaskUlid } from '@laborer/task-db/ulid'
import { Console, Context, Effect, Schema } from 'effect'
import { CreateFeatureActionInput } from '../action-catalog.ts'
import type { ExecutionStatus } from './root-runtime.ts'

export interface ExecutionTaskProjection {
  readonly acceptedAtUnixMs: number
  readonly actionName: string
  readonly conversationId: string
  readonly executionId: string
  readonly input: unknown
  readonly status: ExecutionStatus
  readonly workspaceId: string
}

export interface ExecutionTaskEmitter {
  readonly emit: (
    execution: ExecutionTaskProjection
  ) => Effect.Effect<void, never, never>
}

export class ExecutionTaskEmission extends Context.Service<
  ExecutionTaskEmission,
  ExecutionTaskEmitter
>()('@laborer/task-db/ExecutionTaskEmission') {}

export const noopExecutionTaskEmitter: ExecutionTaskEmitter = {
  emit: () => Effect.void,
}

export class TaskEmissionDiagnostic extends Error {
  readonly _tag = 'TaskEmissionDiagnostic'
  override readonly cause: unknown
  readonly executionId: string | null

  constructor(executionId: string | null, cause: unknown) {
    super('Best-effort task emission was dropped')
    this.executionId = executionId
    this.cause = cause
  }
}

const SLACK_PERMALINK_TIMEOUT_MS = 5000

const executionInput = (
  value: unknown
): { readonly title: string; readonly worktreeName: string } => {
  const input = Schema.decodeUnknownSync(CreateFeatureActionInput)(value)
  return { title: input.title, worktreeName: input.worktreeName }
}

const taskStatusPatch = (
  status: ExecutionStatus
): Pick<Task, 'status'> | Record<never, never> => {
  if (status === 'completed') {
    return { status: 'in_review' }
  }
  if (status === 'cancelled') {
    return { status: 'cancelled' }
  }
  return {}
}

const initialTaskStatus = (
  status: ExecutionStatus
): 'in_progress' | 'in_review' | 'cancelled' => {
  if (status === 'completed') {
    return 'in_review'
  }
  return status === 'cancelled' ? 'cancelled' : 'in_progress'
}

const slackCoordinates = (
  execution: ExecutionTaskProjection
): { readonly channelId: string; readonly rootTs: string } | null => {
  const prefix = `workspace:${execution.workspaceId}:`
  if (!execution.conversationId.startsWith(prefix)) {
    return null
  }
  const [channelId, rootTs, ...remainder] = execution.conversationId
    .slice(prefix.length)
    .split(':')
  return channelId && rootTs && remainder.length === 0
    ? { channelId, rootTs }
    : null
}

export interface NativeExecutionTaskEmitterOptions {
  readonly databasePath: string
  readonly repositoryPath?: string
  readonly resolveSlackPermalink?: (request: {
    readonly channelId: string
    readonly rootTs: string
    readonly workspaceId: string
  }) => Promise<string>
  readonly rootPath: string
}

export interface OpenedExecutionTaskEmitter extends ExecutionTaskEmitter {
  readonly close: () => void
}

export const openExecutionTaskEmitter = (
  options: NativeExecutionTaskEmitterOptions
): OpenedExecutionTaskEmitter => {
  const database = NativeTaskDatabase.open(options.databasePath)
  const pendingPermalinks = new Map<
    string,
    {
      readonly reject: (cause: Error) => void
      readonly timeout: ReturnType<typeof setTimeout>
    }
  >()
  let closed = false

  const update = (task: Task, execution: ExecutionTaskProjection): Task => {
    let current = task
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const statusPatch = taskStatusPatch(execution.status)
      if (
        current.executionStatus === execution.status &&
        (!('status' in statusPatch) || current.status === statusPatch.status)
      ) {
        return current
      }
      try {
        return database.update(current.id, current.revision, {
          executionStatus: execution.status,
          ...statusPatch,
        })
      } catch (error) {
        if (
          !(error instanceof TaskStaleRevisionError) ||
          error.current === null
        ) {
          throw error
        }
        current = error.current
      }
    }
    throw new Error('Task emission CAS retry limit exceeded')
  }

  const enrichPermalink = async (
    execution: ExecutionTaskProjection,
    coordinates: { readonly channelId: string; readonly rootTs: string }
  ): Promise<void> => {
    if (
      options.resolveSlackPermalink === undefined ||
      pendingPermalinks.has(execution.executionId)
    ) {
      return
    }
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const permalink = await Promise.race([
        options.resolveSlackPermalink({
          ...coordinates,
          workspaceId: execution.workspaceId,
        }),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error('Slack permalink lookup timed out')),
            SLACK_PERMALINK_TIMEOUT_MS
          )
          pendingPermalinks.set(execution.executionId, { reject, timeout })
        }),
      ])
      if (closed) {
        return
      }
      const latest = database.findByExecutionId(execution.executionId)
      if (latest !== null && latest.slackPermalink === null) {
        database.update(latest.id, latest.revision, {
          slackPermalink: permalink,
        })
      }
    } catch {
      // Permalinks are optional enrichment and never gate an Execution.
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout)
      }
      pendingPermalinks.delete(execution.executionId)
    }
  }

  const emitUnsafe = (execution: ExecutionTaskProjection): void => {
    if (
      execution.actionName !== 'create-feature' &&
      execution.actionName !== 'deal-with-bug'
    ) {
      return
    }
    const input = executionInput(execution.input)
    const repositoryPath = options.repositoryPath ?? options.rootPath
    const worktreeRoot = join(
      dirname(repositoryPath),
      `${basename(repositoryPath)}.worktrees`
    )
    const inserted = database.insert({
      actionName: execution.actionName,
      branchName: `laborer/${input.worktreeName}`,
      createdAt: execution.acceptedAtUnixMs,
      executionId: execution.executionId,
      executionStatus: execution.status,
      id: createTaskUlid(execution.acceptedAtUnixMs),
      rootPath: options.rootPath,
      source: 'execution',
      status: initialTaskStatus(execution.status),
      title: input.title,
      worktreePath: join(worktreeRoot, input.worktreeName),
    })
    const task = inserted.inserted
      ? inserted.task
      : update(inserted.task, execution)
    if (
      task.slackPermalink !== null ||
      options.resolveSlackPermalink === undefined
    ) {
      return
    }
    const coordinates = slackCoordinates(execution)
    if (coordinates === null) {
      return
    }
    enrichPermalink(execution, coordinates).catch(() => undefined)
  }

  return {
    close: () => {
      closed = true
      for (const pending of pendingPermalinks.values()) {
        clearTimeout(pending.timeout)
        pending.reject(new Error('Execution task emitter closed'))
      }
      pendingPermalinks.clear()
      database.close()
    },
    emit: (execution) =>
      Effect.try(() => emitUnsafe(execution)).pipe(
        Effect.catch((cause) =>
          Console.error(
            new TaskEmissionDiagnostic(execution.executionId, cause)
          )
        )
      ),
  }
}
