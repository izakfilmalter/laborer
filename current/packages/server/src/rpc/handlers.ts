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
import { type AgentProvider, LaborerRpcs, RpcError } from '@laborer/shared/rpc'
import { events, tables } from '@laborer/shared/schema'
import { Array, Effect, pipe, Stream } from 'effect'
import { spawn } from '../lib/spawn.js'
import { ConfigService } from '../services/config-service.js'
import { ContainerService } from '../services/container-service.js'
import { DeferredServicesReady } from '../services/deferred-service.js'
import { DockerDetection } from '../services/docker-detection.js'
import { FileService } from '../services/file-service.js'
import { LaborerStore } from '../services/laborer-store.js'
import { PrWatcher } from '../services/pr-watcher.js'
import { ProjectRegistry } from '../services/project-registry.js'
import { SandboxProvider } from '../services/sandbox-provider.js'
import { planSlackWorkspace } from '../services/slack-workspace-planner.js'
import { TerminalClient } from '../services/terminal-client.js'
import { WorkspaceProvider } from '../services/workspace-provider.js'
import { WorkspaceSyncService } from '../services/workspace-sync-service.js'

const startTime = Date.now()
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

/** Validate optional string field. */
const isOptionalString = (v: unknown): boolean =>
  v === undefined || typeof v === 'string'

/** Validate optional boolean field. */
const isOptionalBoolean = (v: unknown): boolean =>
  v === undefined || typeof v === 'boolean'

/** Validate optional positive number field. */
const isOptionalPositiveNumber = (v: unknown): boolean =>
  v === undefined || (typeof v === 'number' && v > 0)

/** Validate optional number field. */
const isOptionalNumber = (v: unknown): boolean =>
  v === undefined || typeof v === 'number'

/** Validate optional string array field. */
const isOptionalStringArray = (v: unknown): boolean =>
  v === undefined || (Array.isArray(v) && v.every((s) => typeof s === 'string'))

/** Validate sandbox resources object. */
const isValidSandboxResources = (
  r: { cpu?: unknown; disk?: unknown; memory?: unknown } | undefined
): boolean => {
  if (r === undefined) {
    return true
  }
  if (typeof r !== 'object') {
    return false
  }
  return (
    isOptionalNumber(r.cpu) &&
    isOptionalNumber(r.memory) &&
    isOptionalNumber(r.disk)
  )
}

/**
 * Validate a devServer update payload.
 * Returns true if the update is structurally valid (or undefined/absent).
 */
const validateDevServerUpdate = (
  ds:
    | {
        autoOpen?: boolean | undefined
        autoStopInterval?: number | undefined
        dockerfile?: string | undefined
        image?: string | undefined
        port?: number | undefined
        provider?: 'docker' | 'daytona' | 'none' | undefined
        resources?:
          | {
              cpu?: number | undefined
              disk?: number | undefined
              memory?: number | undefined
            }
          | undefined
        setupScripts?: readonly string[] | undefined
        startCommand?: string | undefined
        workdir?: string | undefined
      }
    | undefined
): boolean => {
  if (ds === undefined) {
    return true
  }
  if (typeof ds !== 'object') {
    return false
  }
  const validProviders = ['docker', 'daytona', 'none']
  const isValidProvider =
    ds.provider === undefined || validProviders.includes(ds.provider)

  return (
    isOptionalBoolean(ds.autoOpen) &&
    isOptionalPositiveNumber(ds.autoStopInterval) &&
    isOptionalString(ds.image) &&
    isOptionalString(ds.dockerfile) &&
    isOptionalString(ds.startCommand) &&
    isOptionalString(ds.workdir) &&
    isOptionalStringArray(ds.setupScripts) &&
    isValidProvider &&
    isValidSandboxResources(ds.resources)
  )
}

export const handleConfigUpdate = ({
  projectId,
  config,
}: {
  projectId: string
  config: {
    agent?: AgentProvider | undefined
    devServer?:
      | {
          autoOpen?: boolean | undefined
          autoStopInterval?: number | undefined
          dockerfile?: string | undefined
          image?: string | undefined
          port?: number | undefined
          provider?: 'docker' | 'daytona' | 'none' | undefined
          resources?:
            | {
                cpu?: number | undefined
                disk?: number | undefined
                memory?: number | undefined
              }
            | undefined
          setupScripts?: readonly string[] | undefined
          startCommand?: string | undefined
          workdir?: string | undefined
        }
      | undefined
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

    const isValidDevServer = validateDevServerUpdate(config.devServer)

    const isValidConfig =
      isValidAgent &&
      (config.worktreeDir === undefined ||
        typeof config.worktreeDir === 'string') &&
      isValidSetupScripts &&
      isValidDevServer

    if (!isValidConfig) {
      return yield* new RpcError({
        code: 'INVALID_INPUT',
        message:
          'Invalid config payload. Expected optional worktreeDir and agent fields, setupScripts as a string array, and devServer settings.',
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
      defaultSandboxProvider: globalConfig.defaultSandboxProvider,
    }
  })

export const handleGlobalConfigUpdate = ({
  config,
}: {
  config: {
    agent?: AgentProvider | undefined
    defaultSandboxProvider?: 'docker' | 'daytona' | 'none' | undefined
  }
}) =>
  Effect.gen(function* () {
    const configService = yield* ConfigService
    yield* configService.writeGlobalConfig(config)
  })

export const handleSettingsGetDefaultProvider = () =>
  Effect.gen(function* () {
    const configService = yield* ConfigService
    const globalConfig = yield* configService.readGlobalConfig()
    return {
      provider: globalConfig.defaultSandboxProvider ?? null,
    }
  })

export const handleSettingsSetDefaultProvider = ({
  provider,
}: {
  provider: 'docker' | 'daytona' | 'none'
}) =>
  Effect.gen(function* () {
    const configService = yield* ConfigService
    yield* configService.writeGlobalConfig({ defaultSandboxProvider: provider })
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
    // Global Config RPCs
    // -------------------------------------------------------------------
    'globalConfig.get': handleGlobalConfigGet,
    'globalConfig.update': handleGlobalConfigUpdate,

    // -------------------------------------------------------------------
    // Settings RPCs
    // -------------------------------------------------------------------
    'settings.getDefaultProvider': handleSettingsGetDefaultProvider,
    'settings.setDefaultProvider': handleSettingsSetDefaultProvider,

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
    'workspace.startContainer': ({ workspaceId }) =>
      Effect.gen(function* () {
        const provider = yield* WorkspaceProvider
        const prWatcher = yield* PrWatcher
        const workspaceSyncService = yield* WorkspaceSyncService
        const onReady = (wsId: string) =>
          Effect.gen(function* () {
            yield* prWatcher.startPolling(wsId)
            yield* workspaceSyncService.startPolling(wsId)
          })
        yield* provider.startSandbox(workspaceId, onReady)
      }),

    // -------------------------------------------------------------------
    // Container RPCs (Issue 10)
    // -------------------------------------------------------------------
    'container.setPort': ({ workspaceId, port }) =>
      Effect.gen(function* () {
        const { store } = yield* LaborerStore
        store.commit(
          events.containerPortChanged({
            workspaceId,
            containerPort: port,
          })
        )
      }),
    'container.pause': ({ workspaceId }) =>
      Effect.gen(function* () {
        const containerService = yield* ContainerService
        yield* containerService.pauseContainer(workspaceId)
      }),
    'container.unpause': ({ workspaceId }) =>
      Effect.gen(function* () {
        const containerService = yield* ContainerService
        yield* containerService.unpauseContainer(workspaceId)
      }).pipe(
        Effect.catchIf(
          (err) =>
            err._tag === 'RpcError' && err.code === 'CONTAINER_NOT_FOUND',
          () =>
            Effect.gen(function* () {
              yield* Effect.logInfo(
                `Container not found for workspace "${workspaceId}", recreating`
              )
              const provider = yield* WorkspaceProvider
              const prWatcher = yield* PrWatcher
              const workspaceSyncService = yield* WorkspaceSyncService
              const onReady = (wsId: string) =>
                Effect.gen(function* () {
                  yield* prWatcher.startPolling(wsId)
                  yield* workspaceSyncService.startPolling(wsId)
                })
              yield* provider.startSandbox(workspaceId, onReady)
            })
        )
      ),

    // -------------------------------------------------------------------
    // Sandbox RPCs (provider-agnostic — canonical names going forward)
    //
    // These delegate to the SandboxProvider abstraction. The old
    // container.* / docker.* handlers above are kept as backward-compat
    // aliases that go through the Docker-specific services directly.
    // -------------------------------------------------------------------
    'sandbox.providerStatus': () =>
      Effect.gen(function* () {
        const sandboxProvider = yield* SandboxProvider
        return yield* sandboxProvider.checkAvailability()
      }),
    'workspace.startSandbox': ({ workspaceId }) =>
      Effect.gen(function* () {
        const provider = yield* WorkspaceProvider
        const prWatcher = yield* PrWatcher
        const workspaceSyncService = yield* WorkspaceSyncService
        const onReady = (wsId: string) =>
          Effect.gen(function* () {
            yield* prWatcher.startPolling(wsId)
            yield* workspaceSyncService.startPolling(wsId)
          })
        yield* provider.startSandbox(workspaceId, onReady)
      }),
    'sandbox.setPort': ({ workspaceId, port }) =>
      Effect.gen(function* () {
        const { store } = yield* LaborerStore
        store.commit(
          events.sandboxPortChanged({
            workspaceId,
            sandboxPort: port,
          })
        )

        // For Daytona workspaces, refresh the preview URL when the port
        // changes. Daytona preview URLs are port-specific (e.g.,
        // https://3000-abc123.preview.daytona.io) unlike Docker URLs
        // where the port is simply appended to the hostname.
        if (port !== null) {
          const allWorkspaces = store.query(tables.workspaces)
          const workspace = pipe(
            allWorkspaces,
            Array.findFirst((w) => w.id === workspaceId)
          )
          if (
            workspace._tag === 'Some' &&
            workspace.value.sandboxProvider === 'daytona'
          ) {
            const sandboxProvider = yield* SandboxProvider
            yield* sandboxProvider
              .getPreviewUrl(workspaceId, port)
              .pipe(Effect.catchAll(() => Effect.void))
          }
        }
      }),
    'sandbox.pause': ({ workspaceId }) =>
      Effect.gen(function* () {
        const sandboxProvider = yield* SandboxProvider
        yield* sandboxProvider.pauseSandbox(workspaceId)
      }),
    'sandbox.resume': ({ workspaceId }) =>
      Effect.gen(function* () {
        const sandboxProvider = yield* SandboxProvider
        yield* sandboxProvider.resumeSandbox(workspaceId)
      }).pipe(
        Effect.catchIf(
          (err) =>
            err._tag === 'RpcError' && err.code === 'CONTAINER_NOT_FOUND',
          () =>
            Effect.gen(function* () {
              yield* Effect.logInfo(
                `Sandbox not found for workspace "${workspaceId}", recreating`
              )
              const provider = yield* WorkspaceProvider
              const prWatcher = yield* PrWatcher
              const workspaceSyncService = yield* WorkspaceSyncService
              const onReady = (wsId: string) =>
                Effect.gen(function* () {
                  yield* prWatcher.startPolling(wsId)
                  yield* workspaceSyncService.startPolling(wsId)
                })
              yield* provider.startSandbox(workspaceId, onReady)
            })
        )
      ),
    'sandbox.setAutoStop': ({ workspaceId, interval }) =>
      Effect.gen(function* () {
        const sandboxProvider = yield* SandboxProvider
        yield* sandboxProvider.setAutoStopInterval(workspaceId, interval)
      }),

    'sandbox.openInVsCode': ({ workspaceId }) =>
      Effect.gen(function* () {
        const { store } = yield* LaborerStore

        // Look up workspace to verify it exists and uses Daytona
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
        if (workspace.sandboxProvider !== 'daytona') {
          return yield* new RpcError({
            message:
              'Open in VS Code via SSH is only available for Daytona sandboxes',
            code: 'INVALID_ARGUMENT',
          })
        }

        if (
          workspace.sandboxId === null ||
          workspace.sandboxStatus !== 'running'
        ) {
          return yield* new RpcError({
            message: 'Sandbox must be running to open in VS Code',
            code: 'INVALID_ARGUMENT',
          })
        }

        // Build and execute the VS Code remote command
        const hostAlias = `laborer-${workspaceId}`
        const remoteArg = `ssh-remote+${hostAlias}`
        const projectDir = '/home/daytona/project'

        yield* Effect.tryPromise({
          try: async () => {
            const { exec } = await import('node:child_process')
            const { promisify } = await import('node:util')
            const execAsync = promisify(exec)
            await execAsync(`code --remote ${remoteArg} ${projectDir}`)
          },
          catch: (error) =>
            new RpcError({
              message: `Failed to open VS Code: ${error instanceof Error ? error.message : String(error)}`,
              code: 'INTERNAL_ERROR',
            }),
        })
      }),

    // -------------------------------------------------------------------
    // Terminal RPCs (Issue #50-59, #143)
    // terminal.spawn resolves workspace info (cwd, env) before
    // delegating to the terminal service.
    //
    // terminal.resize, terminal.kill, terminal.remove route through
    // the SandboxProvider so Daytona terminals are handled by the
    // server (PtyHandle WebSocket) while Docker/host terminals are
    // forwarded to the terminal utility process. The web app sends
    // these for Daytona terminals only (detected by `daytona:` prefix);
    // local terminals are handled directly by TerminalServiceClient.
    // -------------------------------------------------------------------
    'terminal.spawn': ({ workspaceId, command, initialPrompt, autoRun }) =>
      Effect.gen(function* () {
        const { store } = yield* LaborerStore
        const workspace = store.query(
          tables.workspaces.where('id', workspaceId)
        )[0]

        if (
          workspace?.sandboxProvider === 'daytona' &&
          workspace.sandboxId !== null
        ) {
          const sandboxProvider = yield* SandboxProvider
          return yield* sandboxProvider.spawnTerminal(workspaceId, {
            command,
            initialPrompt,
            autoRun,
          })
        }

        const tc = yield* TerminalClient
        return yield* tc.spawnInWorkspace(
          workspaceId,
          command,
          autoRun,
          initialPrompt
        )
      }),

    'terminal.resize': ({ id, cols, rows }) =>
      Effect.gen(function* () {
        const sandboxProvider = yield* SandboxProvider
        yield* sandboxProvider.resizeTerminal(id, cols, rows)
      }),

    'terminal.kill': ({ id }) =>
      Effect.gen(function* () {
        const sandboxProvider = yield* SandboxProvider
        yield* sandboxProvider.killTerminal(id)
      }),

    'terminal.remove': ({ id }) =>
      Effect.gen(function* () {
        const sandboxProvider = yield* SandboxProvider
        yield* sandboxProvider.removeTerminal(id)
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
