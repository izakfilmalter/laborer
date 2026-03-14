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
import { LaborerRpcs, RpcError } from '@laborer/shared/rpc'
import { events, tables } from '@laborer/shared/schema'
import { Array, Effect, pipe, Schema } from 'effect'
import { spawn } from '../lib/spawn.js'
import { ConfigService } from '../services/config-service.js'
import { ContainerService } from '../services/container-service.js'
import { DiffService } from '../services/diff-service.js'
import { DockerDetection } from '../services/docker-detection.js'
import { GithubTaskImporter } from '../services/github-task-importer.js'
import { LaborerStore } from '../services/laborer-store.js'
import { LinearTaskImporter } from '../services/linear-task-importer.js'
import { PrWatcher } from '../services/pr-watcher.js'
import {
  type PrdStorageError,
  PrdStorageService,
  slugifyPrdTitle,
} from '../services/prd-storage-service.js'
import { ProjectRegistry } from '../services/project-registry.js'
import { ReviewCommentFetcher } from '../services/review-comment-fetcher.js'
import { TaskManager } from '../services/task-manager.js'
import { TerminalClient } from '../services/terminal-client.js'
import { WorkspaceProvider } from '../services/workspace-provider.js'
import { WorkspaceSyncService } from '../services/workspace-sync-service.js'

const startTime = Date.now()
const PRD_ISSUE_EXTERNAL_ID_REGEX = /:issue:(\d+)$/u

const GhPrViewOutput = Schema.Struct({
  number: Schema.optional(Schema.Number),
})

const toRpcError = (
  error: PrdStorageError,
  code = 'PRD_STORAGE_ERROR'
): RpcError =>
  new RpcError({
    code,
    message: error.message,
  })

const toPrdResponse = (prd: {
  id: string
  projectId: string
  title: string
  slug: string
  filePath: string
  status: string
  createdAt: string
}) => ({
  id: prd.id,
  projectId: prd.projectId,
  title: prd.title,
  slug: prd.slug,
  filePath: prd.filePath,
  status: prd.status as 'draft' | 'active' | 'completed',
  createdAt: prd.createdAt,
})

const toTaskResponse = (task: {
  id: string
  projectId: string
  source: string
  prdId: string | null
  externalId: string | null
  title: string
  status: string
}) => ({
  id: task.id,
  projectId: task.projectId,
  source: task.source,
  prdId: task.prdId ?? undefined,
  externalId: task.externalId ?? undefined,
  title: task.title,
  status: task.status,
})

/**
 * Detect the PR number for a workspace's branch.
 *
 * First checks the LiveStore workspace row for a cached `prNumber`
 * (populated by PrWatcher polling). If not available yet, falls back
 * to running `gh pr view --json number` in the worktree directory.
 *
 * If no PR exists for the branch, yields an RpcError so the caller
 * can surface a clear message to the user.
 */
const detectPrNumber = Effect.fn('detectPrNumber')(function* (
  workspaceId: string
) {
  const { store } = yield* LaborerStore
  const allWorkspaces = store.query(tables.workspaces)
  const workspaceOpt = pipe(
    allWorkspaces,
    Array.findFirst((w) => w.id === workspaceId)
  )

  if (workspaceOpt._tag === 'None') {
    return yield* new RpcError({
      message: `Workspace not found: ${workspaceId}`,
      code: 'NOT_FOUND',
    })
  }

  const workspace = workspaceOpt.value

  // Fast path: use cached PR number from PrWatcher polling
  if (typeof workspace.prNumber === 'number' && workspace.prNumber > 0) {
    return workspace.prNumber
  }

  // Slow path: fall back to gh CLI if PrWatcher hasn't polled yet
  const { exitCode, stdout, stderr } = yield* Effect.tryPromise({
    try: async () => {
      const proc = spawn(['gh', 'pr', 'view', '--json', 'number'], {
        cwd: workspace.worktreePath,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const exitCode = await proc.exited
      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()
      return { exitCode, stdout, stderr }
    },
    catch: (error) =>
      new RpcError({
        message: `Failed to run gh pr view: ${String(error)}`,
        code: 'GH_COMMAND_FAILED',
      }),
  })

  if (exitCode !== 0) {
    return yield* new RpcError({
      message: `No pull request found for branch "${workspace.branchName}". Push the branch and open a PR first.\n${stderr.trim()}`,
      code: 'PR_NOT_FOUND',
    })
  }

  const parsed = yield* Schema.decodeUnknown(Schema.parseJson(GhPrViewOutput))(
    stdout.trim()
  ).pipe(
    Effect.mapError(
      () =>
        new RpcError({
          message: `Could not parse PR number from gh output: ${stdout.trim()}`,
          code: 'PR_NOT_FOUND',
        })
    )
  )

  if (typeof parsed.number !== 'number' || parsed.number <= 0) {
    return yield* new RpcError({
      message: `Could not parse PR number from gh output: ${stdout.trim()}`,
      code: 'PR_NOT_FOUND',
    })
  }

  return parsed.number
})

export const handleConfigGet = ({ projectId }: { projectId: string }) =>
  Effect.gen(function* () {
    const registry = yield* ProjectRegistry
    const configService = yield* ConfigService

    const project = yield* registry.getProject(projectId)
    return yield* configService
      .resolveConfig(project.repoPath, project.name)
      .pipe(
        Effect.mapError(
          (e) =>
            new RpcError({
              message: e.message,
              code: 'CONFIG_VALIDATION_ERROR',
            })
        )
      )
  })

export const handleConfigUpdate = ({
  projectId,
  config,
}: {
  projectId: string
  config: {
    agent?: 'opencode' | 'claude' | 'codex' | undefined
    devServer?:
      | {
          autoOpen?: boolean | undefined
          dockerfile?: string | undefined
          image?: string | undefined
          setupScripts?: readonly string[] | undefined
          startCommand?: string | undefined
          workdir?: string | undefined
        }
      | undefined
    prdsDir?: string | undefined
    brrrConfig?: string | undefined
    setupScripts?: readonly string[] | undefined
    worktreeDir?: string | undefined
  }
}) =>
  Effect.gen(function* () {
    const validAgents = ['opencode', 'claude', 'codex'] as const
    const isValidAgent =
      config.agent === undefined || validAgents.some((a) => a === config.agent)

    const isValidSetupScripts =
      config.setupScripts === undefined ||
      (config.setupScripts.every((script) => typeof script === 'string') &&
        Array.isArray(config.setupScripts))

    const isValidDevServerSetupScripts =
      config.devServer?.setupScripts === undefined ||
      (Array.isArray(config.devServer.setupScripts) &&
        config.devServer.setupScripts.every(
          (script) => typeof script === 'string'
        ))

    const isValidDevServer =
      config.devServer === undefined ||
      (typeof config.devServer === 'object' &&
        (config.devServer.autoOpen === undefined ||
          typeof config.devServer.autoOpen === 'boolean') &&
        (config.devServer.image === undefined ||
          typeof config.devServer.image === 'string') &&
        (config.devServer.dockerfile === undefined ||
          typeof config.devServer.dockerfile === 'string') &&
        isValidDevServerSetupScripts &&
        (config.devServer.startCommand === undefined ||
          typeof config.devServer.startCommand === 'string') &&
        (config.devServer.workdir === undefined ||
          typeof config.devServer.workdir === 'string'))

    const isValidConfig =
      isValidAgent &&
      (config.prdsDir === undefined || typeof config.prdsDir === 'string') &&
      (config.worktreeDir === undefined ||
        typeof config.worktreeDir === 'string') &&
      (config.brrrConfig === undefined ||
        typeof config.brrrConfig === 'string') &&
      isValidSetupScripts &&
      isValidDevServer

    if (!isValidConfig) {
      return yield* new RpcError({
        code: 'INVALID_INPUT',
        message:
          'Invalid config payload. Expected optional string fields for prdsDir, worktreeDir, brrrConfig, agent (opencode/claude/codex), setupScripts as string array, and devServer with optional string fields.',
      })
    }

    const registry = yield* ProjectRegistry
    const configService = yield* ConfigService

    const project = yield* registry.getProject(projectId)
    yield* configService.writeProjectConfig(project.repoPath, config)
  })

export const handlePrdCreate = ({
  projectId,
  title,
  content,
}: {
  projectId: string
  title: string
  content: string
}) =>
  Effect.gen(function* () {
    const trimmedTitle = title.trim()
    if (trimmedTitle.length === 0) {
      return yield* new RpcError({
        code: 'INVALID_INPUT',
        message: 'PRD title cannot be empty',
      })
    }

    const registry = yield* ProjectRegistry
    const storage = yield* PrdStorageService
    const { store } = yield* LaborerStore
    const project = yield* registry.getProject(projectId)
    const slug = slugifyPrdTitle(trimmedTitle)

    const existingPrds = store.query(tables.prds.where('projectId', projectId))
    const duplicatePrd = existingPrds.find(
      (prd) => prd.title === trimmedTitle || prd.slug === slug
    )

    if (duplicatePrd) {
      return yield* new RpcError({
        code: 'ALREADY_EXISTS',
        message: `PRD already exists for project ${projectId}: ${trimmedTitle}`,
      })
    }

    const filePath = yield* storage
      .createPrdFile(project.repoPath, project.name, trimmedTitle, content)
      .pipe(Effect.mapError((error) => toRpcError(error)))

    const prd = {
      id: crypto.randomUUID(),
      projectId,
      title: trimmedTitle,
      slug,
      filePath,
      status: 'draft' as const,
      createdAt: new Date().toISOString(),
    }

    store.commit(events.prdCreated(prd))

    return toPrdResponse(prd)
  })

export const handlePrdList = ({ projectId }: { projectId: string }) =>
  Effect.gen(function* () {
    const registry = yield* ProjectRegistry
    const { store } = yield* LaborerStore

    yield* registry.getProject(projectId)

    return store
      .query(tables.prds.where('projectId', projectId))
      .map((prd) => toPrdResponse(prd))
  })

export const handlePrdRead = ({ prdId }: { prdId: string }) =>
  Effect.gen(function* () {
    const storage = yield* PrdStorageService
    const { store } = yield* LaborerStore

    const prd = store.query(tables.prds.where('id', prdId))[0]
    if (!prd) {
      return yield* new RpcError({
        code: 'NOT_FOUND',
        message: `PRD not found: ${prdId}`,
      })
    }

    const content = yield* storage
      .readPrdFile(prd.filePath)
      .pipe(Effect.mapError((error) => toRpcError(error, 'NOT_FOUND')))

    return {
      ...toPrdResponse(prd),
      content,
    }
  })

export const handlePrdRemove = ({ prdId }: { prdId: string }) =>
  Effect.gen(function* () {
    const { store } = yield* LaborerStore
    const storage = yield* PrdStorageService
    const taskManager = yield* TaskManager

    const prd = store.query(tables.prds.where('id', prdId))[0]
    if (!prd) {
      return yield* new RpcError({
        code: 'NOT_FOUND',
        message: `PRD not found: ${prdId}`,
      })
    }

    yield* storage
      .removePrdArtifacts(prd.filePath)
      .pipe(Effect.mapError((error) => toRpcError(error)))

    const linkedTasks = store
      .query(tables.tasks.where('prdId', prdId))
      .filter((task) => task.source === 'prd')

    for (const task of linkedTasks) {
      yield* taskManager.removeTask(task.id)
    }

    store.commit(events.prdRemoved({ id: prdId }))
  })

export const handlePrdUpdate = ({
  prdId,
  content,
}: {
  prdId: string
  content: string
}) =>
  Effect.gen(function* () {
    const { store } = yield* LaborerStore
    const storage = yield* PrdStorageService

    const prd = store.query(tables.prds.where('id', prdId))[0]
    if (!prd) {
      return yield* new RpcError({
        code: 'NOT_FOUND',
        message: `PRD not found: ${prdId}`,
      })
    }

    yield* storage
      .updatePrdFile(prd.filePath, content)
      .pipe(Effect.mapError((error) => toRpcError(error)))

    store.commit(
      events.prdUpdated({
        id: prd.id,
        projectId: prd.projectId,
        title: prd.title,
        slug: prd.slug,
        filePath: prd.filePath,
        status: prd.status as 'draft' | 'active' | 'completed',
        createdAt: prd.createdAt,
      })
    )

    return toPrdResponse(prd)
  })

export const handlePrdUpdateStatus = ({
  prdId,
  status,
}: {
  prdId: string
  status: string
}) =>
  Effect.gen(function* () {
    const { store } = yield* LaborerStore

    const prd = store.query(tables.prds.where('id', prdId))[0]
    if (!prd) {
      return yield* new RpcError({
        code: 'NOT_FOUND',
        message: `PRD not found: ${prdId}`,
      })
    }

    const validStatuses = ['draft', 'active', 'completed'] as const
    if (!validStatuses.some((value) => value === status)) {
      return yield* new RpcError({
        code: 'INVALID_STATUS',
        message: `Invalid PRD status: ${status}. Must be one of: ${validStatuses.join(', ')}`,
      })
    }

    store.commit(
      events.prdStatusChanged({
        id: prdId,
        status: status as 'draft' | 'active' | 'completed',
      })
    )

    return toPrdResponse({
      ...prd,
      status: status as 'draft' | 'active' | 'completed',
    })
  })

export const handlePrdCreateIssue = ({
  prdId,
  title,
  body,
}: {
  prdId: string
  title: string
  body: string
}) =>
  Effect.gen(function* () {
    const trimmedTitle = title.trim()
    const trimmedBody = body.trim()

    if (trimmedTitle.length === 0) {
      return yield* new RpcError({
        code: 'INVALID_INPUT',
        message: 'PRD issue title cannot be empty',
      })
    }

    if (trimmedBody.length === 0) {
      return yield* new RpcError({
        code: 'INVALID_INPUT',
        message: 'PRD issue body cannot be empty',
      })
    }

    const { store } = yield* LaborerStore
    const storage = yield* PrdStorageService
    const taskManager = yield* TaskManager

    const prd = store.query(tables.prds.where('id', prdId))[0]
    if (!prd) {
      return yield* new RpcError({
        code: 'NOT_FOUND',
        message: `PRD not found: ${prdId}`,
      })
    }

    const { issueNumber } = yield* storage
      .appendIssue(prd.filePath, trimmedTitle, trimmedBody)
      .pipe(Effect.mapError((error) => toRpcError(error)))

    const task = yield* taskManager.createTask(
      prd.projectId,
      trimmedTitle,
      'prd',
      `${prd.id}:issue:${issueNumber}`,
      prd.id
    )

    return toTaskResponse(task)
  })

export const handlePrdReadIssues = ({ prdId }: { prdId: string }) =>
  Effect.gen(function* () {
    const { store } = yield* LaborerStore
    const storage = yield* PrdStorageService

    const prd = store.query(tables.prds.where('id', prdId))[0]
    if (!prd) {
      return yield* new RpcError({
        code: 'NOT_FOUND',
        message: `PRD not found: ${prdId}`,
      })
    }

    return yield* storage
      .readIssuesFile(prd.filePath)
      .pipe(Effect.mapError((error) => toRpcError(error)))
  })

export const handlePrdListRemainingIssues = ({ prdId }: { prdId: string }) =>
  Effect.gen(function* () {
    const { store } = yield* LaborerStore

    const prd = store.query(tables.prds.where('id', prdId))[0]
    if (!prd) {
      return yield* new RpcError({
        code: 'NOT_FOUND',
        message: `PRD not found: ${prdId}`,
      })
    }

    const remainingTasks = store
      .query(tables.tasks.where('prdId', prdId))
      .filter(
        (task) =>
          task.source === 'prd' &&
          (task.status === 'pending' || task.status === 'in_progress')
      )
      .map((task) => toTaskResponse(task))

    return remainingTasks
  })

const parseIssueNumberFromExternalId = (
  externalId: string | null
): number | undefined => {
  if (!externalId) {
    return undefined
  }

  const match = externalId.match(PRD_ISSUE_EXTERNAL_ID_REGEX)
  if (!match) {
    return undefined
  }

  const issueNumber = Number(match[1])
  return Number.isInteger(issueNumber) ? issueNumber : undefined
}

export const handlePrdUpdateIssue = ({
  taskId,
  body,
  status,
}: {
  taskId: string
  body?: string | undefined
  status?: string | undefined
}) =>
  Effect.gen(function* () {
    const nextBody = body?.trim()

    if (nextBody === undefined && status === undefined) {
      return yield* new RpcError({
        code: 'INVALID_INPUT',
        message:
          'Provide at least one of body or status when updating a PRD issue',
      })
    }

    if (body !== undefined && nextBody?.length === 0) {
      return yield* new RpcError({
        code: 'INVALID_INPUT',
        message: 'PRD issue body cannot be empty',
      })
    }

    const { store } = yield* LaborerStore
    const storage = yield* PrdStorageService
    const taskManager = yield* TaskManager

    const task = yield* taskManager.getTask(taskId)

    if (task.source !== 'prd' || task.prdId === null) {
      return yield* new RpcError({
        code: 'NOT_FOUND',
        message: `PRD issue task not found: ${taskId}`,
      })
    }

    const prd = store.query(tables.prds.where('id', task.prdId))[0]
    if (!prd) {
      return yield* new RpcError({
        code: 'NOT_FOUND',
        message: `PRD not found for task ${taskId}: ${task.prdId}`,
      })
    }

    if (nextBody !== undefined) {
      yield* storage
        .updateIssue(
          prd.filePath,
          task.title,
          nextBody,
          parseIssueNumberFromExternalId(task.externalId)
        )
        .pipe(Effect.mapError((error) => toRpcError(error, 'NOT_FOUND')))
    }

    if (status !== undefined) {
      yield* taskManager.updateTaskStatus(taskId, status)
    }

    return toTaskResponse(
      status !== undefined
        ? {
            ...task,
            status,
          }
        : task
    )
  })

export const handleProjectList = () =>
  Effect.gen(function* () {
    const registry = yield* ProjectRegistry
    const projects = yield* registry.listProjects()
    return projects.map((project) => ({
      id: project.id,
      repoPath: project.repoPath,
      name: project.name,
      brrrConfig: project.brrrConfig ?? undefined,
    }))
  })

/**
 * RPC handler layer for the LaborerRpcs group.
 *
 * All registered RPC methods are fully implemented:
 * - health.check: returns server uptime (Issue #12)
 * - project.add: delegates to ProjectRegistry.addProject (Issue #21)
 * - project.remove: delegates to ProjectRegistry.removeProject (Issue #22)
 * - config.get/config.update: delegates to ConfigService via ProjectRegistry lookup (Issue #157)
 * - workspace.create: delegates to WorkspaceProvider.createWorktree + DiffService.startPolling (Issue #33/#40/#85)
 * - workspace.destroy: delegates to DiffService.stopPolling + TerminalClient.killAllForWorkspace + WorkspaceProvider.destroyWorktree (Issue #43/#44/#85)
 * - terminal.spawn: delegates to TerminalClient.spawnInWorkspace (Issue #50/#143)
 * - terminal.write/resize/kill/remove/restart: stub — proxied by web app directly to terminal service (Issue #143)
 * - diff.refresh: delegates to DiffService.getDiff (Issue #82)
 * - editor.open: opens file in configured editor (Issue #111)
 * - brrr.startLoop: delegates to TerminalClient.spawnInWorkspace with `brrr build --once` (Issue #92/#143)
 * - brrr.review: delegates to TerminalClient.spawnInWorkspace with `brrr review <prNumber>` (Issue #96/#143)
 * - brrr.fix: delegates to TerminalClient.spawnInWorkspace with `brrr fix <prNumber>` (Issue #98/#143)
 * - task.create: delegates to TaskManager.createTask (Issue #100)
 * - task.updateStatus: delegates to TaskManager.updateTaskStatus + auto-creates workspace on "in_progress" + auto-destroys on "completed"/"cancelled" (Issue #101/#105/#106)
 * - task.remove: delegates to TaskManager.removeTask (Issue #100)
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
    // Docker Prerequisite Detection (Issue 2)
    // -------------------------------------------------------------------
    'docker.status': () =>
      Effect.gen(function* () {
        const dockerDetection = yield* DockerDetection
        return yield* dockerDetection.check()
      }),

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
          brrrConfig: project.brrrConfig ?? undefined,
        }
      }),
    'project.remove': ({ projectId }) =>
      Effect.gen(function* () {
        const registry = yield* ProjectRegistry
        yield* registry.removeProject(projectId)
      }),
    'project.list': handleProjectList,

    // -------------------------------------------------------------------
    // Config RPCs (Issue #157)
    // -------------------------------------------------------------------
    'config.get': handleConfigGet,
    'config.update': handleConfigUpdate,

    // -------------------------------------------------------------------
    // PRD RPCs (Issue #178)
    // -------------------------------------------------------------------
    'prd.create': handlePrdCreate,
    'prd.list': handlePrdList,
    'prd.read': handlePrdRead,
    'prd.remove': handlePrdRemove,
    'prd.update': handlePrdUpdate,
    'prd.updateStatus': handlePrdUpdateStatus,
    'prd.createIssue': handlePrdCreateIssue,
    'prd.readIssues': handlePrdReadIssues,
    'prd.listRemainingIssues': handlePrdListRemainingIssues,
    'prd.updateIssue': handlePrdUpdateIssue,

    // -------------------------------------------------------------------
    // Workspace RPCs (Issue #33-47)
    // -------------------------------------------------------------------
    'workspace.create': ({ projectId, branchName, taskId }) =>
      Effect.gen(function* () {
        const provider = yield* WorkspaceProvider
        // Pass an onReady callback that starts diff/PR polling once the
        // background worktree setup completes and the workspace is 'running'.
        const diffService = yield* DiffService
        const prWatcher = yield* PrWatcher
        const workspaceSyncService = yield* WorkspaceSyncService
        const onReady = (workspaceId: string) =>
          Effect.gen(function* () {
            yield* diffService.startPolling(workspaceId)
            yield* prWatcher.startPolling(workspaceId)
            yield* workspaceSyncService.startPolling(workspaceId)
          })
        const workspace = yield* provider.createWorktree(
          projectId,
          branchName,
          taskId,
          onReady
        )

        return {
          id: workspace.id,
          projectId: workspace.projectId,
          branchName: workspace.branchName,
          worktreePath: workspace.worktreePath,
          port: workspace.port,
          status: workspace.status as
            | 'creating'
            | 'running'
            | 'stopped'
            | 'errored'
            | 'destroyed',
        }
      }),
    'workspace.destroy': ({ workspaceId, force }) =>
      Effect.gen(function* () {
        // Issue #85: Stop diff polling before destroying the workspace.
        const diffService = yield* DiffService
        yield* diffService.stopPolling(workspaceId)

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
    // Container RPCs (Issue 10)
    // -------------------------------------------------------------------
    'container.pause': ({ workspaceId }) =>
      Effect.gen(function* () {
        const containerService = yield* ContainerService
        yield* containerService.pauseContainer(workspaceId)
      }),
    'container.unpause': ({ workspaceId }) =>
      Effect.gen(function* () {
        const containerService = yield* ContainerService
        yield* containerService.unpauseContainer(workspaceId)
      }),

    // -------------------------------------------------------------------
    // Terminal RPCs (Issue #50-59, #143)
    // Only terminal.spawn is handled here — it resolves workspace info
    // (cwd, env) before delegating to the terminal service. All other
    // terminal RPCs (write, resize, kill, remove, restart) are called
    // directly from the web app to the terminal service.
    // -------------------------------------------------------------------
    'terminal.spawn': ({ workspaceId, command, autoRun }) =>
      Effect.gen(function* () {
        const tc = yield* TerminalClient
        return yield* tc.spawnInWorkspace(workspaceId, command, autoRun)
      }),

    // -------------------------------------------------------------------
    // Diff RPCs (Issue #82-86)
    // -------------------------------------------------------------------
    'diff.refresh': ({ workspaceId }) =>
      Effect.gen(function* () {
        const diffService = yield* DiffService
        return yield* diffService.getDiff(workspaceId)
      }),

    // -------------------------------------------------------------------
    // Editor RPCs (Issue #111)
    // -------------------------------------------------------------------
    'editor.open': ({ workspaceId, filePath }) =>
      Effect.gen(function* () {
        const { store } = yield* LaborerStore

        // 1. Look up the workspace to get worktreePath
        const allWorkspaces = store.query(tables.workspaces)
        const workspaceOpt = pipe(
          allWorkspaces,
          Array.findFirst((w) => w.id === workspaceId)
        )

        if (workspaceOpt._tag === 'None') {
          return yield* new RpcError({
            message: `Workspace not found: ${workspaceId}`,
            code: 'NOT_FOUND',
          })
        }

        const workspace = workspaceOpt.value

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
    // brrr RPCs (Issue #92-98, #143)
    // Now delegate to TerminalClient.spawnInWorkspace instead of TerminalManager.
    // -------------------------------------------------------------------
    'brrr.startLoop': ({ workspaceId }) =>
      Effect.gen(function* () {
        const tc = yield* TerminalClient
        return yield* tc.spawnInWorkspace(workspaceId, 'brrr build --once')
      }),
    'brrr.review': ({ workspaceId }) =>
      Effect.gen(function* () {
        const prNumber = yield* detectPrNumber(workspaceId)
        const tc = yield* TerminalClient
        return yield* tc.spawnInWorkspace(
          workspaceId,
          `brrr review ${prNumber}`
        )
      }),
    'brrr.fix': ({ workspaceId }) =>
      Effect.gen(function* () {
        const prNumber = yield* detectPrNumber(workspaceId)
        const tc = yield* TerminalClient
        return yield* tc.spawnInWorkspace(workspaceId, `brrr fix ${prNumber}`)
      }),

    // -------------------------------------------------------------------
    // Task RPCs (Issue #100-102)
    // -------------------------------------------------------------------
    'task.create': ({ projectId, prdId, title }) =>
      Effect.gen(function* () {
        const taskManager = yield* TaskManager
        const task = yield* taskManager.createTask(
          projectId,
          title,
          'manual',
          undefined,
          prdId
        )
        return toTaskResponse(task)
      }),
    'task.importGithub': ({ projectId }) =>
      Effect.gen(function* () {
        const githubTaskImporter = yield* GithubTaskImporter
        return yield* githubTaskImporter.importProjectIssues(projectId)
      }),
    'task.importLinear': ({ projectId }) =>
      Effect.gen(function* () {
        const linearTaskImporter = yield* LinearTaskImporter
        return yield* linearTaskImporter.importProjectIssues(projectId)
      }),
    'task.updateStatus': ({ taskId, status }) =>
      Effect.gen(function* () {
        const taskManager = yield* TaskManager
        yield* taskManager.updateTaskStatus(taskId, status)

        // Issue #105: Task-driven workspace auto-creation.
        if (status === 'in_progress') {
          const { store } = yield* LaborerStore
          const task = yield* taskManager.getTask(taskId)

          const existingWorkspaces = store.query(tables.workspaces)
          const hasWorkspace = pipe(
            existingWorkspaces,
            Array.findFirst(
              (w) => w.taskSource === taskId && w.status !== 'destroyed'
            )
          )

          if (hasWorkspace._tag === 'None') {
            const idPrefix = taskId.slice(0, 8)
            const slug = task.title
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/^-|-$/g, '')
              .slice(0, 40)
            const branchName = `task/${idPrefix}/${slug}`

            const provider = yield* WorkspaceProvider
            const diffService = yield* DiffService
            const prWatcher = yield* PrWatcher
            const workspaceSyncService = yield* WorkspaceSyncService
            const onReady = (workspaceId: string) =>
              Effect.gen(function* () {
                yield* diffService.startPolling(workspaceId)
                yield* prWatcher.startPolling(workspaceId)
                yield* workspaceSyncService.startPolling(workspaceId)
              })
            yield* provider.createWorktree(
              task.projectId,
              branchName,
              taskId,
              onReady
            )
          }
        }

        // Issue #106: Task-driven workspace auto-cleanup.
        if (status === 'completed' || status === 'cancelled') {
          const { store } = yield* LaborerStore
          const allWorkspaces = store.query(tables.workspaces)

          const linkedWorkspaces = pipe(
            allWorkspaces,
            Array.filter(
              (w) => w.taskSource === taskId && w.status !== 'destroyed'
            )
          )

          for (const workspace of linkedWorkspaces) {
            yield* Effect.gen(function* () {
              const diffService = yield* DiffService
              yield* diffService.stopPolling(workspace.id)

              const prWatcher = yield* PrWatcher
              yield* prWatcher.stopPolling(workspace.id)

              const workspaceSyncService = yield* WorkspaceSyncService
              yield* workspaceSyncService.stopPolling(workspace.id)

              const tc = yield* TerminalClient
              yield* tc.killAllForWorkspace(workspace.id)

              const provider = yield* WorkspaceProvider
              yield* provider.destroyWorktree(workspace.id, true)
            }).pipe(
              Effect.catchAll((error) =>
                Effect.logWarning(
                  `Failed to auto-destroy workspace ${workspace.id} for task ${taskId}: ${String(error)}`
                )
              )
            )
          }
        }
      }),
    'task.remove': ({ taskId }) =>
      Effect.gen(function* () {
        const taskManager = yield* TaskManager
        yield* taskManager.removeTask(taskId)
      }),

    // -------------------------------------------------------------------
    // Review RPCs
    // -------------------------------------------------------------------
    'review.fetchComments': ({ workspaceId }) =>
      Effect.gen(function* () {
        const fetcher = yield* ReviewCommentFetcher
        return yield* fetcher.fetchComments(workspaceId)
      }),
    'review.fetchVerdict': ({ workspaceId }) =>
      Effect.gen(function* () {
        const fetcher = yield* ReviewCommentFetcher
        return yield* fetcher.fetchVerdict(workspaceId)
      }),
    'review.addReaction': ({ workspaceId, commentId, content }) =>
      Effect.gen(function* () {
        const fetcher = yield* ReviewCommentFetcher
        return yield* fetcher.addReaction(workspaceId, commentId, content)
      }),
    'review.removeReaction': ({ workspaceId, commentId, reactionId }) =>
      Effect.gen(function* () {
        const fetcher = yield* ReviewCommentFetcher
        yield* fetcher.removeReaction(workspaceId, commentId, reactionId)
      }),
  })
)
