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
import { tables } from '@laborer/shared/schema'
import { Array, Effect, pipe, Stream } from 'effect'
import { spawn } from '../lib/spawn.js'
import { ConfigService } from '../services/config-service.js'
import { DeferredServicesReady } from '../services/deferred-service.js'
import { FileService } from '../services/file-service.js'
import { LaborerStore } from '../services/laborer-store.js'
import { PrWatcher } from '../services/pr-watcher.js'
import { ProjectRegistry } from '../services/project-registry.js'
import { planSlackWorkspace } from '../services/slack-workspace-planner.js'
import { subscribeToTaskBoard } from '../services/task-board-reader.js'
import { createTaskCard } from '../services/task-card-creator.js'
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
            .addProject(rootPath)
            .pipe(
              Effect.catchAll((error) =>
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

const getProjectFromStore = (projectId: string) =>
  Effect.gen(function* () {
    const { store } = yield* LaborerStore
    const project = store.query(tables.projects.where('id', projectId))[0]

    if (!project) {
      return yield* new RpcError({
        message: `Project not found: ${projectId}`,
        code: 'NOT_FOUND',
      })
    }

    return project
  })

export const handleConfigGet = ({ projectId }: { projectId: string }) =>
  Effect.gen(function* () {
    const configService = yield* ConfigService

    const project = yield* getProjectFromStore(projectId)
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
        Effect.catchAllDefect((defect) =>
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

    const project = yield* getProjectFromStore(projectId)
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
          return ref.changes.pipe(
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

    'task.board.subscribe': () =>
      subscribeToTaskBoard().pipe(
        Stream.tap(({ tasks }) => ensureTaskProjects(tasks))
      ),
    'task.create': ({ projectId, status, text }) =>
      Effect.gen(function* () {
        const project = yield* getProjectFromStore(projectId)
        return yield* createTaskCard({
          rootPath: project.repoPath,
          status,
          text,
        })
      }),

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
