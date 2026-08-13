/**
 * RPC Handlers
 *
 * Implements handler logic for the LaborerRpcs group.
 * Handlers delegate to Effect services for real work.
 *
 * Terminal operations are delegated to the TerminalClient service, which
 * connects to the standalone terminal service via Effect RPC. The server
 * no longer runs PTY processes in-process.
 *
 * @see Issue #143: Server TerminalClient + remove server terminal modules
 */

import { join } from 'node:path'
import {
  type AgentProvider,
  type BoardTask,
  LaborerRpcs,
  RpcError,
} from '@laborer/shared/rpc'
import type { Task, TaskStatus } from '@laborer/task-db'
import { taskDatabasePath } from '@laborer/task-db/path'
import { Array, Effect, Semaphore, Stream, SubscriptionRef } from 'effect'
import { spawn } from '../lib/spawn.js'
import { ConfigService } from '../services/config-service.js'
import { DeferredServicesReady } from '../services/deferred-service.js'
import { FileService } from '../services/file-service.js'
import { LaborerDatabase } from '../services/laborer-database.js'
import {
  LaborerDatabaseStaleRevisionError,
  type LaborerTask,
  NativeLaborerDatabase,
} from '../services/native-laborer-database.js'
import { NodeTaskBoardDatabase } from '../services/node-task-board-database.js'
import { PrWatcher } from '../services/pr-watcher.js'
import { ProjectRegistry } from '../services/project-registry.js'
import { subscribeToSharedState } from '../services/shared-state-reader.js'
import { planSlackWorkspace } from '../services/slack-workspace-planner.js'
import { subscribeToTaskBoard } from '../services/task-board-reader.js'
import {
  createTaskCard,
  manualTaskBranchName,
  markSlackAnalysisFailed,
} from '../services/task-card-creator.js'
import { inspectTaskWorktree } from '../services/task-worktree.js'
import { TerminalClient } from '../services/terminal-client.js'
import { WorkspaceProvider } from '../services/workspace-provider.js'
import { WorkspaceSyncService } from '../services/workspace-sync-service.js'

const startTime = Date.now()

export const projectContainsRoot = (
  repoPath: string,
  rootPath: string
): boolean =>
  repoPath === rootPath ||
  rootPath.startsWith(repoPath.endsWith('/') ? repoPath : `${repoPath}/`)

const ensureTaskProjects = (tasks: readonly BoardTask[]) =>
  Effect.gen(function* () {
    const registry = yield* ProjectRegistry
    const roots = [...new Set(tasks.map(({ rootPath }) => rootPath))]
    const registered = [...(yield* registry.listProjects())]
    yield* Effect.forEach(
      roots,
      (rootPath) =>
        Effect.gen(function* () {
          if (
            registered.some(({ repoPath }) =>
              projectContainsRoot(repoPath, rootPath)
            )
          ) {
            return
          }
          const project = yield* registry
            .addProject(rootPath, false)
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning(
                  `[task-board] Could not auto-register ${rootPath}: ${error.message}`
                ).pipe(Effect.as(undefined))
              )
            )
          if (project) {
            registered.push(project)
          }
        }),
      { concurrency: 1, discard: true }
    )
  })

const getProject = (projectId: string) =>
  Effect.gen(function* () {
    const registry = yield* ProjectRegistry
    return yield* registry.getProject(projectId)
  })

export const handleConfigGet = ({ projectId }: { projectId: string }) =>
  Effect.gen(function* () {
    const configService = yield* ConfigService

    const project = yield* getProject(projectId)
    return yield* configService
      .resolveConfig(project.repoPath, project.name)
      .pipe(
        Effect.mapError(
          (e) =>
            new RpcError({
              message: e.message,
              code: 'CONFIG_VALIDATION_ERROR',
            })
        ),
        Effect.catchDefect((defect) =>
          Effect.fail(
            new RpcError({
              message:
                defect instanceof Error
                  ? defect.message
                  : 'Unexpected error resolving config',
              code: 'CONFIG_RESOLUTION_ERROR',
            })
          )
        )
      )
  })

export const handleConfigUpdate = ({
  projectId,
  config,
}: {
  projectId: string
  config: {
    agent?: AgentProvider | undefined
    setupScripts?: readonly string[] | undefined
    worktreeDir?: string | undefined
  }
}) =>
  Effect.gen(function* () {
    const validAgents = ['opencode2', 'claude', 'codex'] as const
    const isValidAgent =
      config.agent === undefined || validAgents.some((a) => a === config.agent)

    const isValidSetupScripts =
      config.setupScripts === undefined ||
      (config.setupScripts.every((script) => typeof script === 'string') &&
        Array.isArray(config.setupScripts))

    const isValidConfig =
      isValidAgent &&
      (config.worktreeDir === undefined ||
        typeof config.worktreeDir === 'string') &&
      isValidSetupScripts

    if (!isValidConfig) {
      return yield* new RpcError({
        code: 'INVALID_INPUT',
        message:
          'Invalid config payload. Expected optional worktreeDir, agent (opencode2/claude/codex), and setupScripts as a string array.',
      })
    }

    const configService = yield* ConfigService

    const project = yield* getProject(projectId)
    yield* configService.writeProjectConfig(project.repoPath, config)
  })

export const handleGlobalConfigGet = () =>
  Effect.gen(function* () {
    const configService = yield* ConfigService
    const globalConfig = yield* configService.readGlobalConfig()
    return {
      agent: globalConfig.agent,
    }
  })

export const handleGlobalConfigUpdate = ({
  config,
}: {
  config: {
    agent?: AgentProvider | undefined
  }
}) =>
  Effect.gen(function* () {
    const configService = yield* ConfigService
    yield* configService.writeGlobalConfig(config)
  })

export const handleProjectList = () =>
  Effect.gen(function* () {
    const registry = yield* ProjectRegistry
    const projects = yield* registry.listProjects()
    return projects.map((project) => ({
      id: project.id,
      repoPath: project.repoPath,
      name: project.name,
    }))
  })

const taskMoveError = (cause: unknown) =>
  new RpcError({
    code: 'TASK_MOVE_FAILED',
    message: cause instanceof Error ? cause.message : 'Unable to move task',
  })

const taskMoveFailureMessage = (cause: unknown, taskId: string): string => {
  if (cause instanceof LaborerDatabaseStaleRevisionError) {
    return `Task changed while moving: ${taskId}`
  }
  return cause instanceof Error ? cause.message : 'Unable to move task'
}

const isLegacyProvisioningReplay = (
  task: Task,
  status: TaskStatus,
  sortOrder: number | null | undefined,
  mutationId: string | null
): boolean =>
  mutationId === null && sortOrder === undefined && task.status === status

const sharedTaskRow = (task: LaborerTask) => {
  const worktree = inspectTaskWorktree(task.worktreePath, task.executionId)
  return {
    ...task,
    worktreeBotOwned: worktree.botOwned,
    worktreeExists: worktree.exists,
  }
}

const commitTaskMove = (
  path: string,
  taskId: string,
  expectedRevision: number,
  status: TaskStatus,
  sortOrder: number | null | undefined,
  mutationId: string | null
) =>
  Effect.try({
    try: () => {
      const database = NativeLaborerDatabase.open(path)
      try {
        return database.updateTask(
          taskId,
          expectedRevision,
          sortOrder === undefined ? { status } : { sortOrder, status },
          mutationId
        )
      } finally {
        database.close()
      }
    },
    catch: (cause) =>
      new RpcError({
        code:
          cause instanceof LaborerDatabaseStaleRevisionError
            ? 'CAS_CONFLICT'
            : 'TASK_MOVE_FAILED',
        message: taskMoveFailureMessage(cause, taskId),
      }),
  })

const readCommittedTask = (path: string, taskId: string) =>
  Effect.try({
    try: () => {
      const database = NativeLaborerDatabase.open(path)
      try {
        const snapshot = database.snapshot()
        const row = snapshot.tasks.find(({ id }) => id === taskId)
        if (row === undefined) {
          throw new Error(`Task not found: ${taskId}`)
        }
        return { cursor: snapshot.taskCursor, row }
      } finally {
        database.close()
      }
    },
    catch: taskMoveError,
  })

const commitOrReplayTaskMove = (input: {
  readonly expectedRevision: number
  readonly legacyProvisioningReplay: boolean
  readonly mutationId: string | null
  readonly path: string
  readonly sortOrder: number | null | undefined
  readonly status: TaskStatus
  readonly taskId: string
}) =>
  input.legacyProvisioningReplay
    ? readCommittedTask(input.path, input.taskId)
    : commitTaskMove(
        input.path,
        input.taskId,
        input.expectedRevision,
        input.status,
        input.sortOrder,
        input.mutationId
      )

interface TaskMoveLock {
  readonly semaphore: Semaphore.Semaphore
  users: number
}

const taskMoveLocks = new Map<string, TaskMoveLock>()

/** Serialize provisioning replays per task without blocking unrelated cards. */
const withTaskMoveLock = <A, E, R>(
  taskId: string,
  operation: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.uninterruptible(
      Effect.gen(function* () {
        const lock = yield* Effect.sync(() => {
          const existing = taskMoveLocks.get(taskId)
          if (existing !== undefined) {
            existing.users += 1
            return existing
          }
          const created: TaskMoveLock = {
            semaphore: Semaphore.makeUnsafe(1),
            users: 1,
          }
          taskMoveLocks.set(taskId, created)
          return created
        })
        yield* lock.semaphore.take(1)
        return lock
      })
    ),
    () => operation,
    (lock) =>
      lock.semaphore.release(1).pipe(
        Effect.andThen(
          Effect.sync(() => {
            lock.users -= 1
            if (lock.users === 0 && taskMoveLocks.get(taskId) === lock) {
              taskMoveLocks.delete(taskId)
            }
          })
        )
      )
  )

const withTaskDatabase = <A>(
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
    catch: taskMoveError,
  })

const bindTaskWorkspace = (
  path: string,
  taskId: string,
  workspace: { readonly branchName: string; readonly worktreePath: string }
): Effect.Effect<Task, RpcError> =>
  withTaskDatabase(path, (database) => {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const current = database.findTask(taskId)
      if (current === null) {
        throw new Error(`Task not found: ${taskId}`)
      }
      // The background setup can fail before this binding write wins its
      // race. Its failure callback has already returned the task to Todo;
      // do not resurrect provisioning fields in that case.
      if (current.status !== 'in_progress' || current.worktreePath !== null) {
        return current
      }
      try {
        return database.update(taskId, current.revision, {
          branchName: workspace.branchName,
          worktreePath: workspace.worktreePath,
        })
      } catch (error) {
        const stale =
          error instanceof Error && error.message.includes('stale revision')
        if (attempt === 5 || !stale) {
          throw error
        }
      }
    }
    throw new Error(`Could not bind task ${taskId} to its workspace`)
  })

/**
 * Sources whose title is human-authored board text, so their workspace branch
 * is derived from it. Slack tasks get their branch from the planner instead.
 */
const derivesBranchFromTitle = (source: Task['source']): boolean =>
  source === 'manual' || source === 'agent'

const taskWorkspaceBranchName = (task: Task): string | undefined => {
  if (task.branchName !== null) {
    return task.branchName
  }
  return derivesBranchFromTitle(task.source)
    ? manualTaskBranchName(task.title)
    : undefined
}

const handleTaskMoveAtPathUnlocked = (
  {
    expectedRevision,
    mutationId = null,
    sortOrder,
    status,
    taskId,
  }: {
    readonly expectedRevision: number
    readonly mutationId?: string | null
    readonly sortOrder?: number | null
    readonly status: TaskStatus
    readonly taskId: string
  },
  databasePath = taskDatabasePath()
) =>
  Effect.gen(function* () {
    const path = databasePath
    const withDatabase = <A>(
      operation: (database: NodeTaskBoardDatabase) => A
    ): Effect.Effect<A, RpcError> => withTaskDatabase(path, operation)

    const initialTask = yield* withDatabase((database) =>
      database.findTask(taskId)
    )
    if (initialTask === null) {
      return yield* new RpcError({
        code: 'NOT_FOUND',
        message: `Task not found: ${taskId}`,
      })
    }
    let task: Task = initialTask
    const legacyProvisioningReplay = isLegacyProvisioningReplay(
      task,
      status,
      sortOrder,
      mutationId
    )
    if (task.revision !== expectedRevision && !legacyProvisioningReplay) {
      return yield* new RpcError({
        code: 'CAS_CONFLICT',
        message: `Task changed while moving: ${taskId}`,
      })
    }

    const shouldProvision =
      status === 'in_progress' &&
      task.worktreePath === null &&
      (task.source === 'manual' ||
        task.source === 'slack_url' ||
        task.source === 'agent')

    // A failed Slack analysis is retried by the provisioning move itself. Do
    // not create a workspace until the planner has produced the prompt.
    if (
      shouldProvision &&
      task.source === 'slack_url' &&
      task.description === null
    ) {
      if (task.slackPermalink === null) {
        return yield* new RpcError({
          code: 'TASK_MOVE_FAILED',
          message: 'Slack task has no permalink to analyze',
        })
      }
      const plan = yield* planSlackWorkspace(task.slackPermalink, task.rootPath)
      task = yield* withDatabase((database) => {
        const current = database.findTask(taskId)
        if (current === null) {
          throw new Error(`Task not found: ${taskId}`)
        }
        if (current.status !== task.status) {
          throw new Error(`Task changed while planning: ${taskId}`)
        }
        if (current.worktreePath !== null || current.description !== null) {
          return current
        }
        return database.update(taskId, current.revision, {
          branchName: plan.branchName,
          executionStatus: null,
          description: plan.initialPrompt,
          title: plan.title,
        })
      })
    }

    const committed = yield* commitOrReplayTaskMove({
      expectedRevision: task.revision,
      legacyProvisioningReplay,
      mutationId,
      path,
      sortOrder,
      status,
      taskId,
    })
    task = committed.row
    const cursor = committed.cursor

    // An In Progress task without a binding is incomplete durable work. This
    // deliberately retries after a crash between the status write and
    // workspace creation; the task lock prevents concurrent replays from
    // creating duplicates in this server process.
    if (!(shouldProvision && task.worktreePath === null)) {
      return {
        cursor,
        description: null,
        revision: task.revision,
        row: sharedTaskRow(committed.row),
        status: task.status,
        updatedAt: task.updatedAt,
        workspaceId: null,
      }
    }

    const registry = yield* ProjectRegistry
    const project = [...(yield* registry.listProjects())]
      .filter(({ repoPath }) => projectContainsRoot(repoPath, task.rootPath))
      .sort((left, right) => right.repoPath.length - left.repoPath.length)[0]
    if (project === undefined) {
      yield* withDatabase((database) =>
        database.move(taskId, task.revision, 'todo')
      )
      return yield* new RpcError({
        code: 'TASK_MOVE_FAILED',
        message: `No project owns task root: ${task.rootPath}`,
      })
    }

    const bounceToTodo = (_workspaceId: string, error: RpcError) =>
      withDatabase((database) => {
        const current = database.findTask(taskId)
        if (current === null || current.status !== 'in_progress') {
          return
        }
        database.update(taskId, current.revision, {
          branchName: derivesBranchFromTitle(current.source)
            ? null
            : current.branchName,
          status: 'todo',
          worktreePath: null,
        })
      }).pipe(
        Effect.catch((bounceError) =>
          Effect.logError(
            `[task-board] Could not return failed provisioning task ${taskId} to Todo: ${bounceError.message}`
          )
        ),
        Effect.andThen(
          Effect.logWarning(
            `[task-board] Provisioning failed for ${taskId}: ${error.message}`
          )
        )
      )

    const provider = yield* WorkspaceProvider
    const prWatcher = yield* PrWatcher
    const workspaceSyncService = yield* WorkspaceSyncService
    const onReady = (workspaceId: string) =>
      Effect.gen(function* () {
        yield* prWatcher.startPolling(workspaceId)
        yield* workspaceSyncService.startPolling(workspaceId)
      })

    const publishedWorkspace = yield* provider.findWorkspaceForTask(taskId)
    const requestedBranchName = taskWorkspaceBranchName(task)
    const workspace =
      publishedWorkspace ??
      (yield* provider
        .createWorktree(
          project.id,
          requestedBranchName,
          onReady,
          undefined,
          bounceToTodo,
          taskId
        )
        .pipe(Effect.tapError((error) => bounceToTodo('', error))))

    // Bind the workspace's final branch/path via CAS before returning it to the
    // renderer. The provider may still generate a random branch for a manual
    // title that cannot produce a usable slug.
    task = yield* bindTaskWorkspace(path, taskId, workspace)

    const authoritative = yield* readCommittedTask(path, taskId)
    return {
      cursor: authoritative.cursor,
      description: task.description,
      revision: authoritative.row.revision,
      row: sharedTaskRow(authoritative.row),
      status: authoritative.row.status,
      updatedAt: authoritative.row.updatedAt,
      workspaceId: workspace.id,
    }
  })

export const handleTaskMoveAtPath = (
  payload: {
    readonly expectedRevision: number
    readonly mutationId?: string | null
    readonly sortOrder?: number | null
    readonly status: TaskStatus
    readonly taskId: string
  },
  databasePath = taskDatabasePath()
) =>
  withTaskMoveLock(
    payload.taskId,
    handleTaskMoveAtPathUnlocked(payload, databasePath)
  )

/**
 * Analysis and provisioning for a Slack card created directly in In Progress.
 * The move path plans the thread and creates the workspace under the task
 * lock; if the planner never produced a prompt, the card is marked failed so
 * the board offers a retry rather than analyzing forever.
 */
const analyzeAndProvisionSlackCard = (taskId: string, databasePath: string) =>
  handleTaskMoveAtPath(
    { expectedRevision: 1, status: 'in_progress', taskId },
    databasePath
  ).pipe(
    Effect.catch((error) =>
      markSlackAnalysisFailed(taskId, databasePath).pipe(
        Effect.catch((markError) =>
          Effect.logError(
            `[task-board] Slack provisioning failed for ${taskId}; the failure marker could not be stored: ${markError.message}`
          )
        ),
        Effect.andThen(
          Effect.logWarning(
            `[task-board] Slack provisioning failed for ${taskId}: ${error.message}`
          )
        )
      )
    )
  )

export const handleTaskCreateAtPath = (
  input: {
    readonly id?: string | null
    readonly rootPath: string
    readonly status: Exclude<TaskStatus, 'cancelled'>
    readonly text: string
  },
  databasePath = taskDatabasePath()
) =>
  Effect.gen(function* () {
    const { inserted, ...created } = yield* createTaskCard(input, databasePath)
    if (!inserted) {
      // An idempotent replay of a client-minted id. The original request's
      // side effects (Slack planning, workspace provisioning) already ran or
      // are still running; repeating them would duplicate analyses and
      // CAS-conflict against the first run's moves.
      return { ...created, description: null, workspaceId: null }
    }
    if (input.status !== 'in_progress') {
      return { ...created, description: null, workspaceId: null }
    }
    if (created.source === 'slack_url') {
      // Analyzing a Slack thread spawns an agent and can run for minutes, so
      // the card stays in the column it was added to and its workspace
      // follows once the planner has named the work.
      yield* analyzeAndProvisionSlackCard(created.id, databasePath).pipe(
        Effect.forkDetach
      )
      return { ...created, description: null, workspaceId: null }
    }
    const moved = yield* handleTaskMoveAtPath(
      {
        expectedRevision: 1,
        status: 'in_progress',
        taskId: created.id,
      },
      databasePath
    )
    return {
      ...created,
      description: moved.description,
      status: 'in_progress' as const,
      workspaceId: moved.workspaceId,
    }
  })

export const handleTaskMove = (payload: {
  readonly expectedRevision: number
  readonly mutationId: string
  readonly sortOrder: number | null
  readonly status: TaskStatus
  readonly taskId: string
}) => handleTaskMoveAtPath(payload)

export const handleProjectMove = (payload: {
  readonly expectedRevision: number
  readonly mutationId: string
  readonly projectId: string
  readonly sortOrder: number | null
}) =>
  Effect.gen(function* () {
    const database = yield* LaborerDatabase
    return yield* database
      .run('move project', (native) =>
        native.moveProject(
          payload.projectId,
          payload.expectedRevision,
          payload.sortOrder,
          payload.mutationId
        )
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new RpcError({
              code:
                cause instanceof LaborerDatabaseStaleRevisionError
                  ? 'CAS_CONFLICT'
                  : 'PROJECT_MOVE_FAILED',
              message:
                cause instanceof LaborerDatabaseStaleRevisionError
                  ? `Project changed while reordering: ${payload.projectId}`
                  : `Unable to reorder project: ${payload.projectId}`,
            })
        )
      )
  })

export const handleAppSettingSet = (payload: {
  readonly expectedRevision: number
  readonly key: string
  readonly mutationId: string
  readonly value: string
}) =>
  Effect.gen(function* () {
    const database = yield* LaborerDatabase
    return yield* database
      .run('set app setting', (native) =>
        native.setSetting(
          payload.key,
          payload.expectedRevision,
          payload.value,
          payload.mutationId
        )
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new RpcError({
              code:
                cause instanceof LaborerDatabaseStaleRevisionError
                  ? 'CAS_CONFLICT'
                  : 'APP_SETTING_WRITE_FAILED',
              message:
                cause instanceof LaborerDatabaseStaleRevisionError
                  ? `Setting changed while saving: ${payload.key}`
                  : `Unable to save setting: ${payload.key}`,
            })
        )
      )
  })

export const handleTaskUpdate = (
  {
    description,
    expectedRevision,
    taskId,
    title,
  }: {
    readonly description: string | null
    readonly expectedRevision: number
    readonly taskId: string
    readonly title: string
  },
  databasePath = taskDatabasePath()
) =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () => NodeTaskBoardDatabase.open(databasePath),
      catch: () =>
        new RpcError({
          code: 'TASK_UPDATE_FAILED',
          message: 'Unable to open the task database',
        }),
    }),
    (database) =>
      Effect.try({
        try: () => {
          const trimmedTitle = title.trim()
          if (trimmedTitle.length === 0 || trimmedTitle.length > 100) {
            throw new Error('Task titles must be between 1 and 100 characters')
          }
          if (description !== null && description.length > 100_000) {
            throw new Error(
              'Task descriptions must be 100000 characters or fewer'
            )
          }
          return database.update(taskId, expectedRevision, {
            description,
            title: trimmedTitle,
          })
        },
        catch: (cause) =>
          new RpcError({
            code:
              cause instanceof Error && cause.message.includes('stale revision')
                ? 'CAS_CONFLICT'
                : 'TASK_UPDATE_FAILED',
            message:
              cause instanceof Error ? cause.message : 'Unable to update task',
          }),
      }).pipe(
        Effect.map((task) => ({
          description: task.description,
          revision: task.revision,
          title: task.title,
          updatedAt: task.updatedAt,
        }))
      ),
    (database) => Effect.sync(() => database.close())
  )

export const handleTaskTerminalAttach = (
  { taskId }: { readonly taskId: string },
  databasePath = taskDatabasePath()
) =>
  Effect.gen(function* () {
    const task = yield* Effect.try({
      try: () => {
        const database = NodeTaskBoardDatabase.open(databasePath)
        try {
          return database.findTask(taskId)
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
              : 'Unable to read the task board',
        }),
    })
    if (task === null) {
      return yield* new RpcError({
        code: 'NOT_FOUND',
        message: `Task not found: ${taskId}`,
      })
    }
    const inspection = inspectTaskWorktree(task.worktreePath, task.executionId)
    if (!(inspection.exists && task.worktreePath)) {
      return yield* new RpcError({
        code: 'WORKTREE_NOT_FOUND',
        message: 'The task worktree is not available on disk',
      })
    }
    const terminalClient = yield* TerminalClient
    const terminal = yield* terminalClient.spawnInDirectory(
      `task:${task.id}`,
      task.worktreePath
    )
    return { botOwned: inspection.botOwned, terminal }
  })

/**
 * RPC handler layer for the LaborerRpcs group.
 *
 * All registered RPC methods are fully implemented:
 * - health.check: returns server uptime (Issue #12)
 * - project.add: delegates to ProjectRegistry.addProject (Issue #21)
 * - project.remove: delegates to ProjectRegistry.removeProject (Issue #22)
 * - config.get/config.update: delegates to ConfigService via ProjectRegistry lookup (Issue #157)
 * - workspace.create: delegates to WorkspaceProvider.createWorktree (Issue #33/#40/#85)
 * - workspace.destroy: delegates to TerminalClient.killAllForWorkspace + WorkspaceProvider.destroyWorktree (Issue #43/#44/#85)
 * - terminal.spawn: delegates to TerminalClient.spawnInWorkspace (Issue #50/#143)
 * - terminal.write/resize/kill/remove/restart: stub — proxied by web app directly to terminal service (Issue #143)
 * - editor.open: opens file in configured editor (Issue #111)
 */
export const LaborerRpcsLive = LaborerRpcs.toLayer(
  LaborerRpcs.of({
    // -------------------------------------------------------------------
    // Health Check (Issue #12)
    // -------------------------------------------------------------------
    'health.check': () =>
      Effect.succeed({
        status: 'ok' as const,
        uptime: (Date.now() - startTime) / 1000,
      }),

    // -------------------------------------------------------------------
    // Lifecycle — Deferred service initialization status (Issue #15)
    // -------------------------------------------------------------------
    'lifecycle.initStatus': () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const { ref } = yield* DeferredServicesReady
          return SubscriptionRef.changes(ref).pipe(
            Stream.map((ready) => ({ ready })),
            // Complete after emitting { ready: true } — client only needs
            // this signal once and keeping the stream open wastes resources.
            Stream.takeUntil(({ ready }) => ready)
          )
        })
      ),

    // -------------------------------------------------------------------
    // Project RPCs (Issue #21-25)
    // -------------------------------------------------------------------
    'project.add': ({ repoPath }) =>
      Effect.gen(function* () {
        const registry = yield* ProjectRegistry
        const project = yield* registry.addProject(repoPath)
        return {
          id: project.id,
          repoPath: project.repoPath,
          name: project.name,
        }
      }),
    'project.remove': ({ projectId }) =>
      Effect.gen(function* () {
        const registry = yield* ProjectRegistry
        yield* registry.removeProject(projectId)
      }),
    'project.list': handleProjectList,
    'project.move': handleProjectMove,

    'task.board.subscribe': () =>
      subscribeToTaskBoard().pipe(
        Stream.tap(({ tasks }) => ensureTaskProjects(tasks))
      ),
    'state.subscribe': () =>
      subscribeToSharedState().pipe(
        Stream.tap((update) =>
          update.tasks === undefined
            ? Effect.void
            : ensureTaskProjects(update.tasks.rows)
        )
      ),
    'appSetting.set': handleAppSettingSet,
    'task.create': ({ id, projectId, status, text }) =>
      Effect.gen(function* () {
        const project = yield* getProject(projectId)
        return yield* handleTaskCreateAtPath({
          id: id ?? null,
          rootPath: project.repoPath,
          status,
          text,
        })
      }),
    'task.move': handleTaskMove,
    'task.update': (payload) => handleTaskUpdate(payload),

    'task.terminal.attach': (payload) => handleTaskTerminalAttach(payload),

    // -------------------------------------------------------------------
    // Config RPCs (Issue #157)
    // -------------------------------------------------------------------
    'config.get': handleConfigGet,
    'config.update': handleConfigUpdate,

    // -------------------------------------------------------------------
    // Global Config RPCs
    // -------------------------------------------------------------------
    'globalConfig.get': handleGlobalConfigGet,
    'globalConfig.update': handleGlobalConfigUpdate,

    // -------------------------------------------------------------------

    // -------------------------------------------------------------------
    // Workspace RPCs (Issue #33-47)
    // -------------------------------------------------------------------
    'workspace.create': ({ projectId, branchName, baseWorkspaceId }) =>
      Effect.gen(function* () {
        const provider = yield* WorkspaceProvider
        // Pass an onReady callback that starts PR polling once the
        // background worktree setup completes and the workspace is 'running'.
        const prWatcher = yield* PrWatcher
        const workspaceSyncService = yield* WorkspaceSyncService
        const onReady = (workspaceId: string) =>
          Effect.gen(function* () {
            yield* prWatcher.startPolling(workspaceId)
            yield* workspaceSyncService.startPolling(workspaceId)
          })
        const workspace = yield* provider.createWorktree(
          projectId,
          branchName,
          onReady,
          baseWorkspaceId
        )

        return {
          id: workspace.id,
          projectId: workspace.projectId,
          branchName: workspace.branchName,
          worktreePath: workspace.worktreePath,
          status: workspace.status as
            | 'creating'
            | 'running'
            | 'stopped'
            | 'errored'
            | 'destroyed',
        }
      }),
    'workspace.planFromSlack': ({ slackUrl }) => planSlackWorkspace(slackUrl),
    'workspace.destroy': ({ workspaceId, force }) =>
      Effect.gen(function* () {
        // Stop PR polling before destroying the workspace.
        const prWatcher = yield* PrWatcher
        yield* prWatcher.stopPolling(workspaceId)

        const workspaceSyncService = yield* WorkspaceSyncService
        yield* workspaceSyncService.stopPolling(workspaceId)

        // Issue #44/#143: Kill all workspace terminals via terminal service.
        const tc = yield* TerminalClient
        yield* tc.killAllForWorkspace(workspaceId)

        const provider = yield* WorkspaceProvider
        yield* provider.destroyWorktree(workspaceId, force)
      }),
    'workspace.checkDirty': ({ workspaceId }) =>
      Effect.gen(function* () {
        const provider = yield* WorkspaceProvider
        return yield* provider.checkDirtyFiles(workspaceId)
      }),
    'workspace.refreshPr': ({ workspaceId }) =>
      Effect.gen(function* () {
        const prWatcher = yield* PrWatcher
        const prData = yield* prWatcher.checkPr(workspaceId)

        return {
          number: prData.number,
          state: prData.state,
          title: prData.title,
          url: prData.url,
        }
      }),
    'workspace.refreshSyncStatus': ({ workspaceId }) =>
      Effect.gen(function* () {
        const workspaceSyncService = yield* WorkspaceSyncService
        return yield* workspaceSyncService.checkStatus(workspaceId)
      }),
    'workspace.push': ({ workspaceId }) =>
      Effect.gen(function* () {
        const workspaceSyncService = yield* WorkspaceSyncService
        return yield* workspaceSyncService.push(workspaceId)
      }),
    'workspace.pull': ({ workspaceId }) =>
      Effect.gen(function* () {
        const workspaceSyncService = yield* WorkspaceSyncService
        return yield* workspaceSyncService.pull(workspaceId)
      }),
    // -------------------------------------------------------------------
    // Terminal RPCs (Issue #50-59, #143)
    // terminal.spawn resolves workspace info (cwd, env) before
    // delegating to the terminal service.
    //
    // -------------------------------------------------------------------
    'terminal.spawn': ({ workspaceId, command, initialPrompt }) =>
      Effect.gen(function* () {
        const tc = yield* TerminalClient
        return yield* tc.spawnInWorkspace(workspaceId, command, initialPrompt)
      }),

    // -------------------------------------------------------------------
    // Editor RPCs (Issue #111)
    // -------------------------------------------------------------------
    'editor.open': ({ workspaceId, filePath }) =>
      Effect.gen(function* () {
        const workspaceProvider = yield* WorkspaceProvider
        const workspace =
          yield* workspaceProvider.findWorkspaceForTask(workspaceId)

        if (workspace === null) {
          return yield* new RpcError({
            message: `Workspace not found: ${workspaceId}`,
            code: 'NOT_FOUND',
          })
        }

        // 2. Build the target path
        const targetPath = filePath
          ? join(workspace.worktreePath, filePath)
          : workspace.worktreePath

        // 3. Get the editor command from env
        const { env } = yield* Effect.promise(
          () => import('@laborer/env/server')
        )
        const editorCommand = env.EDITOR_COMMAND

        // 4. Execute the editor command
        yield* Effect.tryPromise({
          try: async () => {
            const proc = spawn([editorCommand, targetPath], {
              stdout: 'ignore',
              stderr: 'pipe',
            })
            const exitCode = await proc.exited
            if (exitCode !== 0) {
              const stderr = await new Response(proc.stderr).text()
              throw new Error(
                `Editor command '${editorCommand} ${targetPath}' exited with code ${exitCode}: ${stderr.trim()}`
              )
            }
          },
          catch: (error) =>
            new RpcError({
              message:
                error instanceof Error
                  ? error.message
                  : `Failed to open editor: ${String(error)}`,
              code: 'EDITOR_FAILED',
            }),
        })
      }),

    // -------------------------------------------------------------------
    // GitHub OAuth RPCs
    // -------------------------------------------------------------------
    'github.exchangeOAuthCode': ({ code }) =>
      Effect.gen(function* () {
        // GitHub Desktop dev OAuth App credentials (public, from open-source repo)
        const clientId = '3a723b10ac5575cc5bb9'
        const clientSecret = '22c34d87789a365981ed921352a7b9a8c3f69d54'

        const res = yield* Effect.tryPromise({
          try: () =>
            fetch('https://github.com/login/oauth/access_token', {
              method: 'POST',
              headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                'User-Agent': 'GitHubDesktop/3.4.12 (Macintosh)',
              },
              body: JSON.stringify({
                client_id: clientId,
                client_secret: clientSecret,
                code,
              }),
            }),
          catch: (err) =>
            new RpcError({
              message: `GitHub OAuth token exchange failed: ${String(err)}`,
            }),
        })

        const body = yield* Effect.tryPromise({
          try: () =>
            res.json() as Promise<{
              access_token?: string
              scope?: string
              token_type?: string
              error?: string
              error_description?: string
            }>,
          catch: () =>
            new RpcError({ message: 'Failed to parse GitHub OAuth response' }),
        })

        if (body.error || !body.access_token) {
          return yield* new RpcError({
            message:
              body.error_description ??
              body.error ??
              'No access token returned',
          })
        }

        return {
          accessToken: body.access_token,
          scope: body.scope ?? '',
          tokenType: body.token_type ?? 'bearer',
        }
      }),

    // -------------------------------------------------------------------
    // File Service RPCs (Lazy File Service)
    // -------------------------------------------------------------------
    'file.list': ({ workspaceId, dir }) =>
      Effect.gen(function* () {
        const fileService = yield* FileService
        return yield* fileService.list(workspaceId, dir)
      }),

    'file.read': ({ workspaceId, filePath }) =>
      Effect.gen(function* () {
        const fileService = yield* FileService
        return yield* fileService.read(workspaceId, filePath)
      }),

    'file.status': ({ workspaceId }) =>
      Effect.gen(function* () {
        const fileService = yield* FileService
        return yield* fileService.status(workspaceId)
      }),

    'file.diff': ({ workspaceId }) =>
      Effect.gen(function* () {
        const fileService = yield* FileService
        return yield* fileService.diff(workspaceId)
      }),

    // -------------------------------------------------------------------
    // File Watcher Streaming RPCs (Lazy File Service)
    // -------------------------------------------------------------------
    'file.watcher.subscribe': ({ workspaceId }) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const fileService = yield* FileService
          return fileService.watcherSubscribe(workspaceId)
        })
      ),
  })
)
