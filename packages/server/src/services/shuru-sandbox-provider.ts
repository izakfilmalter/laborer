import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { RpcError } from '@laborer/shared/rpc'
import { events, tables } from '@laborer/shared/schema'
import { Array as Arr, Context, Effect, Layer, pipe } from 'effect'

import { ConfigService } from './config-service.js'
import { detectLockfile, sanitizeProjectSlug } from './deps-image-service.js'
import { LaborerStore } from './laborer-store.js'
import type {
  CreateSandboxParams,
  SandboxProvider,
} from './sandbox-provider.js'
import { ShuruClient } from './shuru-client.js'
import { ShuruDetection } from './shuru-detection.js'

const logPrefix = 'ShuruSandboxProvider'
const MAX_SHURU_CHECKPOINT_NAME_LENGTH = 63
const SHURU_BASE_CHECKPOINT_NAME_PREFIX = 'laborer-shuru-base'
const SHURU_RUNTIME_CHECKPOINT_NAME_PREFIX = 'laborer-shuru-runtime'
const SHURU_CHECKPOINT_IMAGE_PREFIX = 'shuru-checkpoint:'
const SHURU_CHECKPOINTS_DIR = join(
  homedir(),
  '.local',
  'share',
  'shuru',
  'checkpoints'
)
const SHURU_DEFAULT_BOOTSTRAP_SCRIPT = 'exec bash'
const SHURU_PREVIEW_HOST = '127.0.0.1'

interface ShuruBaseCheckpointPlan {
  readonly name: string
  readonly scripts: readonly string[]
}

const buildShuruPreviewUrl = (port: number): string =>
  `http://${SHURU_PREVIEW_HOST}:${String(port)}`

const buildShuruCheckpointImage = (checkpointName: string): string =>
  `${SHURU_CHECKPOINT_IMAGE_PREFIX}${checkpointName}`

const getCheckpointNameFromImage = (
  sandboxImage: string | null
): string | null =>
  sandboxImage?.startsWith(SHURU_CHECKPOINT_IMAGE_PREFIX) === true
    ? sandboxImage.slice(SHURU_CHECKPOINT_IMAGE_PREFIX.length)
    : null

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`

const getShuruCheckpointDir = (): string => {
  const override = process.env.LABORER_TEST_SHURU_CHECKPOINT_DIR?.trim()
  return override && override.length > 0 ? override : SHURU_CHECKPOINTS_DIR
}

const checkpointExists = (checkpointName: string): boolean => {
  const checkpointDir = getShuruCheckpointDir()
  return [
    join(checkpointDir, `${checkpointName}.ext4`),
    join(checkpointDir, `${checkpointName}.idx`),
  ].some((path) => existsSync(path))
}

const buildShuruBaseCheckpointName = (
  projectName: string,
  cacheHash: string
): string =>
  `${SHURU_BASE_CHECKPOINT_NAME_PREFIX}-${sanitizeProjectSlug(projectName)}-${cacheHash}`.slice(
    0,
    MAX_SHURU_CHECKPOINT_NAME_LENGTH
  )

const buildShuruRuntimeCheckpointName = (workspaceId: string): string =>
  `${SHURU_RUNTIME_CHECKPOINT_NAME_PREFIX}-${workspaceId}`.slice(
    0,
    MAX_SHURU_CHECKPOINT_NAME_LENGTH
  )

const buildShuruBaseCheckpointScripts = (params: {
  readonly installCommand: string | null
  readonly lockfileInstallCommand: string | null
  readonly setupScripts: readonly string[]
}): readonly string[] => {
  const scripts = params.setupScripts
    .map((script) => script.trim())
    .filter(
      (script) => script.length > 0 && script !== SHURU_DEFAULT_BOOTSTRAP_SCRIPT
    )

  const installCommand =
    params.installCommand ??
    (scripts.length === 0 ? params.lockfileInstallCommand : null)

  if (
    installCommand !== null &&
    installCommand.trim().length > 0 &&
    !scripts.includes(installCommand.trim())
  ) {
    scripts.push(installCommand.trim())
  }

  return scripts
}

const buildShuruBaseCheckpointPlan = (params: {
  readonly installCommand: string | null
  readonly lockfileHash: string | null
  readonly lockfileInstallCommand: string | null
  readonly projectName: string
  readonly projectRepoPath: string
  readonly setupScripts: readonly string[]
  readonly workdir: string
}): ShuruBaseCheckpointPlan | null => {
  if (params.lockfileHash === null && params.installCommand === null) {
    return null
  }

  const scripts = buildShuruBaseCheckpointScripts({
    installCommand: params.installCommand,
    lockfileInstallCommand: params.lockfileInstallCommand,
    setupScripts: params.setupScripts,
  })

  if (scripts.length === 0) {
    return null
  }

  const cacheHash = createHash('sha256')
    .update(
      JSON.stringify({
        installCommand: params.installCommand,
        lockfileHash: params.lockfileHash,
        projectRepoPath: params.projectRepoPath,
        setupScripts: scripts,
        workdir: params.workdir,
      })
    )
    .digest('hex')
    .slice(0, 12)

  return {
    name: buildShuruBaseCheckpointName(params.projectName, cacheHash),
    scripts,
  }
}

const buildShuruCheckpointCommand = (
  scripts: readonly string[],
  workdir: string
): string => {
  const lines = [`cd ${shellQuote(workdir)}`]
  lines.push(...scripts)
  return lines.join('\n')
}

const getEphemeralPort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, SHURU_PREVIEW_HOST, () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close((error) => {
          reject(error ?? new Error('Unable to determine the allocated port'))
        })
        return
      }

      server.close((error) => {
        if (error) {
          reject(error)
          return
        }

        resolve(address.port)
      })
    })
  })

const allocatePreviewPort = async (
  allocatedPorts: ReadonlySet<number>
): Promise<number> => {
  while (true) {
    const port = await getEphemeralPort()
    if (!allocatedPorts.has(port)) {
      return port
    }
  }
}

const buildShuruTerminalCommand = (
  setupScripts: readonly string[],
  startCommand: string | null
): string | null => {
  const lines = [...setupScripts]
  if (startCommand !== null) {
    lines.push(startCommand)
  }

  if (lines.length === 0) {
    return null
  }

  return lines.join('\n')
}

class ShuruSandboxProvider extends Context.Tag('@laborer/ShuruSandboxProvider')<
  ShuruSandboxProvider,
  SandboxProvider['Type']
>() {
  static readonly layer: Layer.Layer<
    ShuruSandboxProvider,
    never,
    ConfigService | LaborerStore | ShuruClient | ShuruDetection
  > = Layer.effect(
    ShuruSandboxProvider,
    Effect.gen(function* () {
      const configService = yield* ConfigService
      const { store } = yield* LaborerStore
      const shuruClient = yield* ShuruClient
      const shuruDetection = yield* ShuruDetection
      const allocatedPreviewPorts = new Set<number>()
      const workspaceRuntimeCheckpoints = new Map<string, string>()
      const workspacePreviewPorts = new Map<string, number>()

      const findWorkspace = (workspaceId: string) =>
        pipe(
          store.query(tables.workspaces),
          Arr.findFirst((candidate) => candidate.id === workspaceId)
        )

      const releasePreviewPort = (
        workspaceId: string,
        fallbackPort: number | null
      ) =>
        Effect.sync(() => {
          const allocatedPort =
            workspacePreviewPorts.get(workspaceId) ?? fallbackPort
          workspacePreviewPorts.delete(workspaceId)

          if (allocatedPort !== null) {
            allocatedPreviewPorts.delete(allocatedPort)
          }
        })

      const stopSandboxBestEffort = (workspaceId: string, context: string) =>
        shuruClient
          .stopSandbox(workspaceId)
          .pipe(
            Effect.catchAll((error) =>
              Effect.logWarning(
                `${context}: failed to stop Shuru runtime for workspace "${workspaceId}": ${error.message}`
              ).pipe(Effect.annotateLogs('module', logPrefix))
            )
          )

      const stopPersistedSandboxIfPresent = (workspaceId: string) =>
        Effect.sync(() => {
          const workspace = findWorkspace(workspaceId)
          if (workspace._tag === 'Some' && workspace.value.sandboxId !== null) {
            store.commit(events.sandboxStopped({ workspaceId }))
          }
        })

      const pausePersistedSandboxIfNeeded = (workspaceId: string) =>
        Effect.sync(() => {
          const workspace = findWorkspace(workspaceId)
          if (
            workspace._tag === 'Some' &&
            workspace.value.sandboxId !== null &&
            workspace.value.sandboxStatus !== 'paused'
          ) {
            store.commit(events.sandboxPaused({ workspaceId }))
          }
        })

      const setSetupStep = (workspaceId: string, step: string | null) =>
        Effect.sync(() => {
          store.commit(events.sandboxSetupStepChanged({ workspaceId, step }))
        })

      const resolveBaseCheckpoint = Effect.fn(
        'ShuruSandboxProvider.resolveBaseCheckpoint'
      )(function* (params: CreateSandboxParams) {
        const workspace = pipe(
          store.query(tables.workspaces),
          Arr.findFirst((candidate) => candidate.id === params.workspaceId)
        )

        const project =
          workspace._tag === 'Some'
            ? pipe(
                store.query(tables.projects),
                Arr.findFirst(
                  (candidate) => candidate.id === workspace.value.projectId
                )
              )
            : { _tag: 'None' as const }

        const projectRepoPath =
          project._tag === 'Some' ? project.value.repoPath : params.worktreePath

        const lockfile = detectLockfile(params.worktreePath)
        const checkpointPlan = buildShuruBaseCheckpointPlan({
          installCommand: params.devServerConfig.installCommand,
          lockfileHash: lockfile?.hash ?? null,
          lockfileInstallCommand: lockfile?.installCommand ?? null,
          projectName: params.projectName,
          projectRepoPath,
          setupScripts: params.devServerConfig.setupScripts,
          workdir: params.devServerConfig.workdir,
        })

        if (checkpointPlan === null) {
          return null
        }

        if (checkpointExists(checkpointPlan.name)) {
          yield* Effect.logInfo(
            `Reusing shared Shuru base checkpoint "${checkpointPlan.name}" for workspace "${params.workspaceId}"`
          ).pipe(Effect.annotateLogs('module', logPrefix))

          yield* setSetupStep(params.workspaceId, 'restoring-checkpoint')
          return checkpointPlan.name
        }

        yield* Effect.logInfo(
          `Building shared Shuru base checkpoint "${checkpointPlan.name}" for workspace "${params.workspaceId}"`
        ).pipe(Effect.annotateLogs('module', logPrefix))

        yield* setSetupStep(params.workspaceId, 'building-base-checkpoint')

        const checkpointWorkspaceId = `${params.workspaceId}:base-checkpoint`
        const checkpointCommand = buildShuruCheckpointCommand(
          checkpointPlan.scripts,
          params.devServerConfig.workdir
        )

        yield* shuruClient.startSandbox({
          allowNet: true,
          workspaceId: checkpointWorkspaceId,
          worktreePath: params.worktreePath,
        })

        const commandResult = yield* shuruClient
          .runCommand(checkpointWorkspaceId, ['sh', '-lc', checkpointCommand])
          .pipe(
            Effect.catchAll((error) =>
              shuruClient.stopSandbox(checkpointWorkspaceId).pipe(
                Effect.catchAll(() => Effect.void),
                Effect.andThen(Effect.fail(error))
              )
            )
          )

        if (commandResult.exitCode !== 0) {
          yield* shuruClient
            .stopSandbox(checkpointWorkspaceId)
            .pipe(Effect.catchAll(() => Effect.void))

          return yield* new RpcError({
            message: `Failed to build shared Shuru base checkpoint for workspace "${params.workspaceId}" (exit ${String(commandResult.exitCode)}): ${commandResult.stderr || commandResult.stdout || 'setup command failed'}`,
            code: 'SHURU_CHECKPOINT_FAILED',
          })
        }

        yield* shuruClient
          .checkpointSandbox(checkpointWorkspaceId, checkpointPlan.name)
          .pipe(
            Effect.catchAll((error) =>
              shuruClient.stopSandbox(checkpointWorkspaceId).pipe(
                Effect.catchAll(() => Effect.void),
                Effect.andThen(Effect.fail(error))
              )
            )
          )

        yield* setSetupStep(params.workspaceId, 'restoring-checkpoint')
        return checkpointPlan.name
      })

      const resolveResumeCheckpoint = Effect.fn(
        'ShuruSandboxProvider.resolveResumeCheckpoint'
      )(function* (workspaceId: string, sandboxImage: string | null) {
        const runtimeCheckpoint = workspaceRuntimeCheckpoints.get(workspaceId)
        if (
          runtimeCheckpoint !== undefined &&
          checkpointExists(runtimeCheckpoint)
        ) {
          return runtimeCheckpoint
        }

        if (runtimeCheckpoint !== undefined) {
          yield* Effect.sync(() => {
            workspaceRuntimeCheckpoints.delete(workspaceId)
          })
        }

        const baseCheckpoint = getCheckpointNameFromImage(sandboxImage)
        if (baseCheckpoint !== null && checkpointExists(baseCheckpoint)) {
          return baseCheckpoint
        }

        return null
      })

      const createSandbox = Effect.fn('ShuruSandboxProvider.createSandbox')(
        function* (params: CreateSandboxParams) {
          if (params.worktreePath.length === 0) {
            return yield* new RpcError({
              message:
                'Shuru sandbox creation requires a local worktree path, but none was provided.',
              code: 'SHURU_CONFIG_ERROR',
            })
          }

          yield* Effect.logInfo(
            `Creating Shuru sandbox for workspace "${params.workspaceId}" from worktree "${params.worktreePath}"`
          ).pipe(Effect.annotateLogs('module', logPrefix))

          const baseCheckpoint = yield* resolveBaseCheckpoint(params)

          const previewPort =
            params.devServerConfig.port === null
              ? null
              : yield* setSetupStep(params.workspaceId, 'allocating-port').pipe(
                  Effect.andThen(
                    Effect.tryPromise({
                      try: () => allocatePreviewPort(allocatedPreviewPorts),
                      catch: (error) =>
                        new RpcError({
                          message: `Failed to allocate a localhost preview port for workspace "${params.workspaceId}": ${error instanceof Error ? error.message : String(error)}`,
                          code: 'SHURU_START_FAILED',
                        }),
                    })
                  )
                )

          if (previewPort !== null) {
            yield* Effect.sync(() => {
              allocatedPreviewPorts.add(previewPort)
            })
          }

          let sandboxStarted = false
          let setupCompleted = false

          const cleanupIncompleteSetup = Effect.sync(() => setupCompleted).pipe(
            Effect.flatMap((isCompleted) =>
              isCompleted
                ? Effect.void
                : (sandboxStarted
                    ? stopSandboxBestEffort(
                        params.workspaceId,
                        'Cleaning up failed Shuru sandbox setup'
                      )
                    : Effect.void
                  ).pipe(
                    Effect.andThen(
                      releasePreviewPort(params.workspaceId, previewPort)
                    ),
                    Effect.andThen(setSetupStep(params.workspaceId, null)),
                    Effect.andThen(
                      stopPersistedSandboxIfPresent(params.workspaceId)
                    )
                  )
            )
          )

          yield* Effect.gen(function* () {
            yield* setSetupStep(params.workspaceId, 'starting-shuru')

            const sandbox = yield* shuruClient.startSandbox({
              fromCheckpoint: baseCheckpoint,
              portForward:
                previewPort === null || params.devServerConfig.port === null
                  ? null
                  : {
                      guestPort: params.devServerConfig.port,
                      hostPort: previewPort,
                    },
              workspaceId: params.workspaceId,
              worktreePath: params.worktreePath,
            })

            sandboxStarted = true

            if (previewPort !== null) {
              yield* Effect.sync(() => {
                workspacePreviewPorts.set(params.workspaceId, previewPort)
              })
            }

            store.commit(
              events.sandboxStarted({
                workspaceId: params.workspaceId,
                sandboxId: sandbox.sandboxId,
                sandboxPort: previewPort ?? undefined,
                sandboxUrl: previewPort === null ? '' : SHURU_PREVIEW_HOST,
                sandboxImage:
                  baseCheckpoint === null
                    ? 'shuru'
                    : buildShuruCheckpointImage(baseCheckpoint),
                sandboxProvider: 'shuru',
              })
            )

            if (params.onReady !== undefined) {
              yield* params.onReady(params.workspaceId)
            }

            setupCompleted = true
          }).pipe(Effect.ensuring(cleanupIncompleteSetup))
        }
      )

      const destroySandbox = Effect.fn('ShuruSandboxProvider.destroySandbox')(
        function* (workspaceId: string) {
          const allWorkspaces = store.query(tables.workspaces)
          const workspace = pipe(
            allWorkspaces,
            Arr.findFirst((candidate) => candidate.id === workspaceId)
          )

          if (workspace._tag === 'None') {
            yield* releasePreviewPort(workspaceId, null)
            return
          }

          yield* shuruClient.stopSandbox(workspaceId).pipe(
            Effect.either,
            Effect.tap((result) =>
              result._tag === 'Right'
                ? releasePreviewPort(
                    workspaceId,
                    workspace.value.sandboxPort
                  ).pipe(
                    Effect.andThen(
                      Effect.sync(() => {
                        workspaceRuntimeCheckpoints.delete(workspaceId)
                      })
                    )
                  )
                : Effect.logWarning(
                    `Failed to stop Shuru runtime for workspace "${workspaceId}": ${result.left.message}`
                  ).pipe(Effect.annotateLogs('module', logPrefix))
            )
          )

          if (workspace.value.sandboxId !== null) {
            store.commit(events.sandboxStopped({ workspaceId }))
          }
        }
      )

      const pauseSandbox = Effect.fn('ShuruSandboxProvider.pauseSandbox')(
        function* (workspaceId: string) {
          const allWorkspaces = store.query(tables.workspaces)
          const workspace = pipe(
            allWorkspaces,
            Arr.findFirst((candidate) => candidate.id === workspaceId)
          )

          if (
            workspace._tag === 'None' ||
            workspace.value.sandboxId === null ||
            workspace.value.sandboxProvider !== 'shuru'
          ) {
            return yield* new RpcError({
              message: `Cannot pause: workspace "${workspaceId}" has no active Shuru sandbox.`,
              code: 'NOT_FOUND',
            })
          }

          if (workspace.value.sandboxStatus === 'paused') {
            return
          }

          const checkpointName = buildShuruRuntimeCheckpointName(workspaceId)

          yield* shuruClient.checkpointSandbox(workspaceId, checkpointName)

          yield* Effect.sync(() => {
            workspaceRuntimeCheckpoints.set(workspaceId, checkpointName)
          })

          store.commit(events.sandboxPaused({ workspaceId }))
        }
      )

      const resumeSandbox = Effect.fn('ShuruSandboxProvider.resumeSandbox')(
        function* (workspaceId: string) {
          const allWorkspaces = store.query(tables.workspaces)
          const workspace = pipe(
            allWorkspaces,
            Arr.findFirst((candidate) => candidate.id === workspaceId)
          )

          if (
            workspace._tag === 'None' ||
            workspace.value.sandboxId === null ||
            workspace.value.sandboxProvider !== 'shuru'
          ) {
            return yield* new RpcError({
              message: `Cannot resume: workspace "${workspaceId}" has no paused Shuru sandbox.`,
              code: 'NOT_FOUND',
            })
          }

          if (workspace.value.sandboxStatus === 'running') {
            return
          }

          const allProjects = store.query(tables.projects)
          const project = pipe(
            allProjects,
            Arr.findFirst(
              (candidate) => candidate.id === workspace.value.projectId
            )
          )

          if (project._tag === 'None') {
            return yield* new RpcError({
              message: `Cannot resume: project for workspace "${workspaceId}" was not found.`,
              code: 'NOT_FOUND',
            })
          }

          const resolvedConfig = yield* configService
            .resolveConfig(project.value.repoPath, project.value.name)
            .pipe(
              Effect.mapError(
                (error) =>
                  new RpcError({
                    message: error.message,
                    code: 'CONFIG_VALIDATION_ERROR',
                  })
              )
            )

          const checkpointName = yield* resolveResumeCheckpoint(
            workspaceId,
            workspace.value.sandboxImage
          )
          const sandboxPort = workspace.value.sandboxPort

          if (sandboxPort !== null) {
            yield* Effect.sync(() => {
              allocatedPreviewPorts.add(sandboxPort)
              workspacePreviewPorts.set(workspaceId, sandboxPort)
            })
          }

          let sandboxStarted = false
          let resumeCompleted = false

          const cleanupInterruptedResume = Effect.sync(
            () => resumeCompleted
          ).pipe(
            Effect.flatMap((isCompleted) =>
              isCompleted
                ? Effect.void
                : (sandboxStarted
                    ? stopSandboxBestEffort(
                        workspaceId,
                        'Cleaning up interrupted Shuru sandbox resume'
                      )
                    : Effect.void
                  ).pipe(
                    Effect.andThen(
                      releasePreviewPort(workspaceId, sandboxPort)
                    ),
                    Effect.andThen(pausePersistedSandboxIfNeeded(workspaceId))
                  )
            )
          )

          yield* Effect.gen(function* () {
            const sandbox = yield* shuruClient.startSandbox({
              fromCheckpoint: checkpointName,
              portForward:
                sandboxPort === null ||
                resolvedConfig.devServer.port.value === null
                  ? null
                  : {
                      guestPort: resolvedConfig.devServer.port.value,
                      hostPort: sandboxPort,
                    },
              workspaceId,
              worktreePath: workspace.value.worktreePath,
            })

            sandboxStarted = true

            store.commit(
              events.sandboxStarted({
                workspaceId,
                sandboxId: sandbox.sandboxId,
                sandboxPort: sandboxPort ?? undefined,
                sandboxUrl: sandboxPort === null ? '' : SHURU_PREVIEW_HOST,
                sandboxImage:
                  checkpointName === null
                    ? 'shuru'
                    : buildShuruCheckpointImage(checkpointName),
                sandboxProvider: 'shuru',
              })
            )

            resumeCompleted = true
          }).pipe(Effect.ensuring(cleanupInterruptedResume))
        }
      )

      const getPreviewUrl = Effect.fn('ShuruSandboxProvider.getPreviewUrl')(
        function* (workspaceId: string, _port: number) {
          const allWorkspaces = store.query(tables.workspaces)
          const workspace = pipe(
            allWorkspaces,
            Arr.findFirst((candidate) => candidate.id === workspaceId)
          )

          if (
            workspace._tag === 'None' ||
            workspace.value.sandboxId === null ||
            workspace.value.sandboxPort === null
          ) {
            return yield* new RpcError({
              message: `Cannot get preview URL: workspace "${workspaceId}" has no active Shuru preview`,
              code: 'NOT_FOUND',
            })
          }

          if (workspace.value.sandboxUrl !== SHURU_PREVIEW_HOST) {
            store.commit(
              events.sandboxUrlChanged({
                workspaceId,
                sandboxUrl: SHURU_PREVIEW_HOST,
              })
            )
          }

          return buildShuruPreviewUrl(workspace.value.sandboxPort)
        }
      )

      const spawnTerminal = Effect.fn('ShuruSandboxProvider.spawnTerminal')(
        function* (workspaceId: string, opts) {
          if (opts?.autoRun !== true) {
            return yield* new RpcError({
              message:
                'Shuru only supports sandboxed dev-server sessions in v1. Use a regular workspace terminal for host-local shells.',
              code: 'SHURU_NOT_IMPLEMENTED',
            })
          }

          const allWorkspaces = store.query(tables.workspaces)
          const workspace = pipe(
            allWorkspaces,
            Arr.findFirst((candidate) => candidate.id === workspaceId)
          )

          if (
            workspace._tag === 'None' ||
            workspace.value.sandboxId === null ||
            workspace.value.sandboxProvider !== 'shuru'
          ) {
            return yield* new RpcError({
              message: `Cannot spawn a Shuru dev-server session: workspace "${workspaceId}" has no active Shuru sandbox.`,
              code: 'NOT_FOUND',
            })
          }

          const allProjects = store.query(tables.projects)
          const project = pipe(
            allProjects,
            Arr.findFirst(
              (candidate) => candidate.id === workspace.value.projectId
            )
          )

          if (project._tag === 'None') {
            return yield* new RpcError({
              message: `Cannot spawn a Shuru dev-server session: project for workspace "${workspaceId}" was not found.`,
              code: 'NOT_FOUND',
            })
          }

          const resolvedConfig = yield* configService
            .resolveConfig(project.value.repoPath, project.value.name)
            .pipe(
              Effect.mapError(
                (error) =>
                  new RpcError({
                    message: error.message,
                    code: 'CONFIG_VALIDATION_ERROR',
                  })
              )
            )

          const command = buildShuruTerminalCommand(
            workspace.value.sandboxImage?.startsWith(
              SHURU_CHECKPOINT_IMAGE_PREFIX
            ) === true
              ? []
              : resolvedConfig.devServer.setupScripts.value,
            opts.command ?? resolvedConfig.devServer.startCommand.value
          )

          if (command === null) {
            return yield* new RpcError({
              message:
                'No devServer.startCommand is configured, so Laborer cannot start a sandboxed Shuru dev-server session.',
              code: 'SHURU_CONFIG_ERROR',
            })
          }

          return yield* shuruClient.spawnTerminal({
            argv: ['sh', '-lc', command],
            command:
              opts.command ??
              resolvedConfig.devServer.startCommand.value ??
              'sh -lc',
            cwd: resolvedConfig.devServer.workdir.value,
            env: {
              COLORTERM: 'truecolor',
              TERM: 'xterm-256color',
            },
            workspaceId,
          })
        }
      )

      const resizeTerminal = Effect.fn('ShuruSandboxProvider.resizeTerminal')(
        function* () {
          // Shuru spawn sessions are stream-backed rather than PTY-backed.
          // Resize requests are intentionally ignored.
        }
      )

      const killTerminal = Effect.fn('ShuruSandboxProvider.killTerminal')(
        function* (terminalId: string) {
          yield* shuruClient.killTerminal(terminalId)
        }
      )

      const removeTerminal = Effect.fn('ShuruSandboxProvider.removeTerminal')(
        function* (terminalId: string) {
          yield* shuruClient.removeTerminal(terminalId)
        }
      )

      const reconcileOneWorkspace = Effect.fn(
        'ShuruSandboxProvider.reconcileOneWorkspace'
      )(function* (workspace: {
        readonly id: string
        readonly sandboxId: string
        readonly sandboxPort: number | null
        readonly sandboxStatus: string | null
      }) {
        const hasLiveRuntime = yield* shuruClient.hasSandbox(workspace.id)

        if (hasLiveRuntime) {
          if (workspace.sandboxStatus !== 'running') {
            yield* Effect.logInfo(
              `Reconcile: workspace "${workspace.id}" has a live Shuru runtime in this session, marking the sandbox as running.`
            ).pipe(Effect.annotateLogs('module', logPrefix))

            store.commit(events.sandboxResumed({ workspaceId: workspace.id }))
          }

          return
        }

        yield* releasePreviewPort(workspace.id, workspace.sandboxPort)

        if (workspace.sandboxStatus === 'running') {
          yield* Effect.logInfo(
            `Reconcile: stale Shuru sandbox "${workspace.sandboxId}" has no live runtime in this session, marking workspace "${workspace.id}" as paused.`
          ).pipe(Effect.annotateLogs('module', logPrefix))

          store.commit(events.sandboxPaused({ workspaceId: workspace.id }))
        }
      })

      const runReconciliationPass = Effect.fn(
        'ShuruSandboxProvider.runReconciliationPass'
      )(function* () {
        const shuruWorkspaces = pipe(
          store.query(tables.workspaces),
          Arr.filter(
            (workspace) =>
              workspace.sandboxProvider === 'shuru' &&
              workspace.sandboxId !== null
          )
        )

        if (shuruWorkspaces.length === 0) {
          return
        }

        yield* Effect.logDebug(
          `Reconciling Shuru state for ${String(shuruWorkspaces.length)} workspace(s)`
        ).pipe(Effect.annotateLogs('module', logPrefix))

        yield* Effect.forEach(
          shuruWorkspaces,
          (workspace) =>
            reconcileOneWorkspace({
              id: workspace.id,
              sandboxId: workspace.sandboxId as string,
              sandboxPort: workspace.sandboxPort,
              sandboxStatus: workspace.sandboxStatus,
            }),
          { discard: true }
        )
      })

      const reconcileState = Effect.fn('ShuruSandboxProvider.reconcileState')(
        function* () {
          yield* runReconciliationPass()
        }
      )

      const checkAvailability = Effect.fn(
        'ShuruSandboxProvider.checkAvailability'
      )(function* () {
        return yield* shuruDetection.check()
      })

      const setAutoStopInterval = Effect.fn(
        'ShuruSandboxProvider.setAutoStopInterval'
      )(function* () {
        // Shuru does not currently expose a provider-managed auto-stop setting.
      })

      yield* Effect.logInfo(
        'Running initial Shuru state reconciliation pass'
      ).pipe(Effect.annotateLogs('module', logPrefix))
      yield* runReconciliationPass()

      return ShuruSandboxProvider.of({
        createSandbox,
        destroySandbox,
        pauseSandbox,
        resumeSandbox,
        getPreviewUrl,
        spawnTerminal,
        resizeTerminal,
        killTerminal,
        removeTerminal,
        reconcileState,
        checkAvailability,
        setAutoStopInterval,
      })
    })
  )
}

export { ShuruSandboxProvider }
