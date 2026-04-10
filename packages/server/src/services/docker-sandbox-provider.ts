/**
 * DockerSandboxProvider — SandboxProvider implementation for Docker/OrbStack
 *
 * Thin adapter that wraps the existing `ContainerService`, `DepsImageService`,
 * `DockerDetection`, and `TerminalClient` services behind the `SandboxProvider`
 * interface. This allows `WorkspaceProvider` (after Issue 10) to delegate to
 * any `SandboxProvider` implementation without knowing which backend is in use.
 *
 * This is a **pure adapter** — no new behavior is introduced. The existing
 * Docker lifecycle (create, destroy, pause, unpause), terminal spawning
 * (via `docker exec`), state reconciliation (via `docker events` listener),
 * and availability check (via `DockerDetection`) are all delegated directly
 * to their existing implementations.
 *
 * The `ContainerService` internally emits `v1.Container*` events, which
 * materialize into the same `sandbox*` columns as the `v2.Sandbox*` events
 * (both old and new materializers write to the same column names). The v1
 * events continue to work correctly.
 *
 * Issue 9: DockerSandboxProvider — wrap existing ContainerService behind SandboxProvider
 */

import { containerName } from '@laborer/shared/container-name'
import { RpcError } from '@laborer/shared/rpc'
import { tables } from '@laborer/shared/schema'
import { Array as Arr, Context, Effect, Layer, pipe } from 'effect'
import { spawn } from '../lib/spawn.js'
import { ContainerService } from './container-service.js'
import { DepsImageService } from './deps-image-service.js'
import { DockerDetection } from './docker-detection.js'
import { LaborerStore } from './laborer-store.js'
import type {
  CreateSandboxParams,
  SandboxProvider,
} from './sandbox-provider.js'
import { TerminalClient } from './terminal-client.js'

/** Module-level log annotation for structured logging. */
const logPrefix = 'DockerSandboxProvider'

/**
 * Check if a Docker container with the given name exists.
 */
const dockerContainerExists = (name: string): Effect.Effect<boolean, never> =>
  Effect.tryPromise({
    try: async () => {
      const proc = spawn(['docker', 'inspect', name], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const exitCode = await proc.exited
      return exitCode === 0
    },
    catch: () => false,
  }).pipe(Effect.catchAll(() => Effect.succeed(false)))

/**
 * Best-effort removal of a Docker container by name.
 * Used as a fallback when the container has no `sandboxId` in LiveStore
 * but may exist with a deterministic name (e.g., from a failed creation).
 */
const destroyContainerByName = (
  name: string,
  workspaceId: string
): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    const exists = yield* dockerContainerExists(name)
    if (!exists) {
      yield* Effect.logDebug(
        `No Docker container named "${name}" found for workspace "${workspaceId}", skipping fallback cleanup`
      ).pipe(Effect.annotateLogs('module', logPrefix))
      return
    }

    yield* Effect.logInfo(
      `Destroying leaked container "${name}" for workspace "${workspaceId}" via deterministic fallback`
    ).pipe(Effect.annotateLogs('module', logPrefix))

    yield* Effect.tryPromise({
      try: async () => {
        const proc = spawn(['docker', 'rm', '-f', name], {
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const exitCode = await proc.exited
        const stderr = await new Response(proc.stderr).text()
        return { exitCode, stderr }
      },
      catch: (error) => String(error),
    }).pipe(
      Effect.tap((result) => {
        if (typeof result === 'string') {
          return Effect.logWarning(
            `Failed to remove leaked container "${name}": ${result}`
          )
        }

        if (result.exitCode !== 0) {
          return Effect.logWarning(
            `docker rm -f failed for leaked container "${name}" (exit ${result.exitCode}): ${result.stderr.trim()}`
          )
        }

        return Effect.logDebug(`Leaked container "${name}" removed`)
      }),
      Effect.annotateLogs('module', logPrefix),
      Effect.catchAll(() => Effect.void)
    )
  })

// ---------------------------------------------------------------------------
// Service tag (for layer identification / future provider-specific deps)
// ---------------------------------------------------------------------------

/**
 * Tag identifying the Docker-specific `SandboxProvider` implementation.
 *
 * The `layer` on this class builds a `SandboxProvider` value by delegating
 * to `ContainerService`, `DepsImageService`, `DockerDetection`,
 * `TerminalClient`, and `LaborerStore`.
 */
class DockerSandboxProvider extends Context.Tag(
  '@laborer/DockerSandboxProvider'
)<DockerSandboxProvider, SandboxProvider['Type']>() {
  /**
   * Provide the `SandboxProvider` service using the Docker/OrbStack backend.
   *
   * Dependencies:
   * - `ContainerService` — Docker container lifecycle
   * - `DepsImageService` — cached deps image builds
   * - `DockerDetection` — Docker availability check
   * - `TerminalClient` — terminal spawning (delegates to `docker exec`)
   * - `LaborerStore` — LiveStore access for workspace lookups
   */
  static readonly layer: Layer.Layer<
    DockerSandboxProvider,
    never,
    | ContainerService
    | DepsImageService
    | DockerDetection
    | TerminalClient
    | LaborerStore
  > = Layer.effect(
    DockerSandboxProvider,
    Effect.gen(function* () {
      const containerService = yield* ContainerService
      const depsImageService = yield* DepsImageService
      const dockerDetection = yield* DockerDetection
      const terminalClient = yield* TerminalClient
      const { store } = yield* LaborerStore

      // ── createSandbox ─────────────────────────────────────────
      // Orchestrates deps image build + container creation.
      // Orchestrates the deps image build + container creation flow
      // exposed through the SandboxProvider interface.

      const createSandbox = Effect.fn('DockerSandboxProvider.createSandbox')(
        function* (params: CreateSandboxParams) {
          const {
            branchName,
            devServerConfig,
            projectName,
            workspaceId,
            worktreePath,
          } = params

          const image = devServerConfig.image
          if (image === null && devServerConfig.dockerfile === null) {
            return yield* new RpcError({
              message:
                'Docker sandbox creation requires a devServer.image in laborer.json. Dockerfile builds are not yet supported.',
              code: 'CONTAINER_CONFIG_ERROR',
            })
          }

          // Step 1: Build or reuse cached deps image (if image is set)
          let depsImageName: string | undefined

          if (image !== null) {
            // Look up the project's repo path from LiveStore for lockfile detection.
            // The worktreePath is a subdirectory; the repo root is needed for the lockfile.
            const allWorkspaces = store.query(tables.workspaces)
            const workspaceOpt = pipe(
              allWorkspaces,
              Arr.findFirst((w) => w.id === workspaceId)
            )

            // Determine projectRoot from workspace's project
            let projectRoot = worktreePath
            if (workspaceOpt._tag === 'Some') {
              const ws = workspaceOpt.value
              // Try to find the project to get the repoPath
              const allProjects = store.query(tables.projects)
              const projectOpt = pipe(
                allProjects,
                Arr.findFirst((p) => p.id === ws.projectId)
              )
              if (projectOpt._tag === 'Some') {
                projectRoot = projectOpt.value.repoPath
              }
            }

            const depsResult = yield* depsImageService
              .ensureDepsImage({
                projectRoot,
                projectName,
                baseImage: image,
                workdir: devServerConfig.workdir,
                worktreePath,
                installCommand: devServerConfig.installCommand ?? undefined,
                setupScripts:
                  devServerConfig.setupScripts.length > 0
                    ? devServerConfig.setupScripts
                    : undefined,
              })
              .pipe(
                Effect.catchAll((error: RpcError) =>
                  Effect.gen(function* () {
                    yield* Effect.logWarning(
                      `Deps image build failed, falling back to base image: ${error.message}`
                    ).pipe(Effect.annotateLogs('module', logPrefix))
                    return null
                  })
                )
              )

            depsImageName = depsResult?.imageName
          }

          // Step 2: Create the Docker container
          yield* containerService.createContainer({
            workspaceId,
            worktreePath,
            branchName,
            projectName,
            depsImageName,
            devServerConfig: {
              image: devServerConfig.image,
              dockerfile: devServerConfig.dockerfile,
              network: devServerConfig.network,
              port: devServerConfig.port,
              workdir: devServerConfig.workdir,
            },
          })

          // Step 3: Invoke the onReady callback if provided
          if (params.onReady !== undefined) {
            yield* params.onReady(workspaceId)
          }

          yield* Effect.logInfo(
            `Docker sandbox created for workspace "${workspaceId}"`
          ).pipe(Effect.annotateLogs('module', logPrefix))
        }
      )

      // ── destroySandbox ────────────────────────────────────────

      const destroySandbox = Effect.fn('DockerSandboxProvider.destroySandbox')(
        function* (workspaceId: string) {
          // Look up workspace to determine cleanup strategy
          const allWorkspaces = store.query(tables.workspaces)
          const workspaceOpt = pipe(
            allWorkspaces,
            Arr.findFirst((w) => w.id === workspaceId)
          )

          if (workspaceOpt._tag === 'None') {
            yield* Effect.logDebug(
              `Workspace "${workspaceId}" not found in LiveStore, skipping container destroy`
            ).pipe(Effect.annotateLogs('module', logPrefix))
            return
          }

          const workspace = workspaceOpt.value

          if (workspace.sandboxId !== null) {
            // Container is tracked — destroy via ContainerService
            yield* containerService.destroyContainer(workspaceId)
          } else if (workspace.origin === 'laborer') {
            // No tracked container but workspace is laborer-managed —
            // attempt deterministic name-based cleanup for leaked containers.
            // This handles the case where container creation failed mid-way
            // and no sandboxId was committed to LiveStore.
            const allProjects = store.query(tables.projects)
            const projectOpt = pipe(
              allProjects,
              Arr.findFirst((p) => p.id === workspace.projectId)
            )
            if (projectOpt._tag === 'Some') {
              const deterministicName = containerName(
                workspace.branchName,
                projectOpt.value.name
              ).name
              yield* destroyContainerByName(deterministicName, workspaceId)
            }
          }
        }
      )

      // ── pauseSandbox ──────────────────────────────────────────

      const pauseSandbox = Effect.fn('DockerSandboxProvider.pauseSandbox')(
        function* (workspaceId: string) {
          yield* containerService.pauseContainer(workspaceId)
        }
      )

      // ── resumeSandbox ─────────────────────────────────────────

      const resumeSandbox = Effect.fn('DockerSandboxProvider.resumeSandbox')(
        function* (workspaceId: string) {
          yield* containerService.unpauseContainer(workspaceId)
        }
      )

      // ── getPreviewUrl ─────────────────────────────────────────
      // Constructs the `.orb.local` URL from the workspace's
      // branch + project names (matching the containerName utility)
      // and appends the port.

      const getPreviewUrl = Effect.fn('DockerSandboxProvider.getPreviewUrl')(
        function* (workspaceId: string, port: number) {
          // Look up workspace to get its container URL, or derive from
          // branch + project name
          const allWorkspaces = store.query(tables.workspaces)
          const workspaceOpt = pipe(
            allWorkspaces,
            Arr.findFirst((w) => w.id === workspaceId)
          )

          if (workspaceOpt._tag === 'None') {
            return yield* new RpcError({
              message: `Cannot get preview URL: workspace "${workspaceId}" not found`,
              code: 'NOT_FOUND',
            })
          }

          const workspace = workspaceOpt.value

          // If the sandbox URL is stored, use it directly
          if (workspace.sandboxUrl !== null) {
            return `http://${workspace.sandboxUrl}:${port}`
          }

          // Derive from branch + project name
          const allProjects = store.query(tables.projects)
          const projectOpt = pipe(
            allProjects,
            Arr.findFirst((p) => p.id === workspace.projectId)
          )

          if (projectOpt._tag === 'None') {
            return yield* new RpcError({
              message: `Cannot get preview URL: project for workspace "${workspaceId}" not found`,
              code: 'NOT_FOUND',
            })
          }

          const { url } = containerName(
            workspace.branchName,
            projectOpt.value.name
          )
          return `http://${url}:${port}`
        }
      )

      // ── spawnTerminal ─────────────────────────────────────────
      // Delegates to TerminalClient.spawnInWorkspace which already
      // handles the Docker exec path for containerized workspaces.

      const spawnTerminal = Effect.fn('DockerSandboxProvider.spawnTerminal')(
        function* (workspaceId: string, opts?) {
          const result = yield* terminalClient.spawnInWorkspace(
            workspaceId,
            opts?.command,
            opts?.autoRun
          )
          return result
        }
      )

      // ── Terminal lifecycle: resize / kill / remove ────────────
      // Docker terminals live in the terminal utility process, so
      // these delegate to TerminalClient which forwards via the
      // MessagePort RPC bridge. In the surgical routing approach,
      // these won't be called (the web app routes Docker terminal
      // operations directly to the terminal process), but they're
      // here for interface completeness.

      const resizeTerminal = Effect.fn('DockerSandboxProvider.resizeTerminal')(
        function* (terminalId: string, cols: number, rows: number) {
          yield* terminalClient.resizeTerminal(terminalId, cols, rows)
        }
      )

      const killTerminal = Effect.fn('DockerSandboxProvider.killTerminal')(
        function* (terminalId: string) {
          yield* terminalClient.killTerminal(terminalId)
        }
      )

      const removeTerminal = Effect.fn('DockerSandboxProvider.removeTerminal')(
        function* (terminalId: string) {
          yield* terminalClient.removeTerminal(terminalId)
        }
      )

      // ── reconcileState ────────────────────────────────────────
      // The existing ContainerService already runs startup
      // reconciliation and a `docker events` listener as daemon
      // fibers during its layer construction. No additional work
      // needed here — state is already being reconciled.

      const reconcileState = Effect.fn('DockerSandboxProvider.reconcileState')(
        function* () {
          yield* Effect.logDebug(
            'Docker reconciliation is handled by ContainerService layer construction (startup + docker events listener)'
          ).pipe(Effect.annotateLogs('module', logPrefix))
        }
      )

      // ── checkAvailability ─────────────────────────────────────

      const checkAvailability = Effect.fn(
        'DockerSandboxProvider.checkAvailability'
      )(function* () {
        return yield* dockerDetection.check()
      })

      // ── setAutoStopInterval ────────────────────────────────────
      // No-op for Docker — containers don't have auto-stop intervals.
      const setAutoStopInterval = Effect.fn(
        'DockerSandboxProvider.setAutoStopInterval'
      )(function* (_workspaceId: string, _interval: number) {
        yield* Effect.logDebug(
          'setAutoStopInterval is a no-op for Docker provider'
        ).pipe(Effect.annotateLogs('module', 'DockerSandboxProvider'))
      })

      // ── Return the SandboxProvider implementation ─────────────

      return DockerSandboxProvider.of({
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

export { DockerSandboxProvider }
