/**
 * ContainerService — Effect Service
 *
 * Manages Docker container lifecycle for containerized dev servers.
 * Each workspace can optionally have a Docker container that runs the
 * dev server in an isolated Linux environment via OrbStack.
 *
 * Responsibilities:
 * - Container creation via `docker run` with bind-mounted worktree
 * - Container destruction via `docker stop` + `docker rm`
 * - Container state tracking via LiveStore (ContainerStarted/ContainerStopped events)
 * - Container naming via shared `containerName` utility
 *
 * The container runs `sleep infinity` to stay alive — the dev server
 * is started later via a `docker exec` terminal session (Issue 6).
 *
 * Usage:
 * ```ts
 * const program = Effect.gen(function* () {
 *   const containerService = yield* ContainerService
 *   yield* containerService.createContainer({
 *     workspaceId: "ws-123",
 *     worktreePath: "/path/to/worktree",
 *     branchName: "feature/auth",
 *     projectName: "my-app",
 *     devServerConfig: { image: "node:22", workdir: "/app" },
 *   })
 *   yield* containerService.pauseContainer("ws-123")
 *   yield* containerService.unpauseContainer("ws-123")
 *   yield* containerService.destroyContainer("ws-123")
 * })
 * ```
 *
 * Issue 5: ContainerService — create and destroy
 * Issue 10: Container pause/unpause RPCs
 */

import { containerName } from '@laborer/shared/container-name'
import { RpcError } from '@laborer/shared/rpc'
import { events, tables } from '@laborer/shared/schema'
import { Array as Arr, Context, Effect, Layer, pipe, Runtime } from 'effect'
import { spawn } from '../lib/spawn.js'
import { LaborerStore } from './laborer-store.js'

/**
 * Configuration for creating a container, derived from the resolved
 * devServer config in laborer.json.
 */
interface CreateContainerParams {
  /** Branch name used for container naming. */
  readonly branchName: string
  /**
   * Override image from DepsImageService (has node_modules pre-installed).
   * When set, this image is used instead of devServerConfig.image.
   */
  readonly depsImageName?: string | undefined
  /** Resolved devServer config fields. */
  readonly devServerConfig: {
    /** Path to a Dockerfile (mutually exclusive with image). */
    readonly dockerfile: string | null
    /** Base Docker image name (e.g. "node:22"). */
    readonly image: string | null
    /** Docker network to join. When null, uses default bridge networking. */
    readonly network: string | null
    /** Mount point inside the container. */
    readonly workdir: string
  }
  /** Project name used for container naming. */
  readonly projectName: string
  /** Workspace ID to associate the container with. */
  readonly workspaceId: string
  /** Absolute path to the worktree directory on the host. */
  readonly worktreePath: string
}

/** Module-level log annotation for structured logging. */
const logPrefix = 'ContainerService'

class ContainerService extends Context.Tag('@laborer/ContainerService')<
  ContainerService,
  {
    /**
     * Create and start a Docker container for a workspace.
     *
     * Runs `docker run -d --name {containerName} -v {worktreePath}:{workdir} -w {workdir} {image} sleep infinity`.
     * Commits a `ContainerStarted` event to LiveStore with the container ID and URL.
     *
     * @param params - Container creation parameters
     */
    readonly createContainer: (
      params: CreateContainerParams
    ) => Effect.Effect<void, RpcError>

    /**
     * Stop and remove the Docker container for a workspace.
     *
     * Runs `docker stop` then `docker rm` on the container. Follows
     * best-effort cleanup: logs warnings on individual failures but
     * does not abort remaining steps.
     *
     * Commits a `ContainerStopped` event to LiveStore.
     *
     * @param workspaceId - ID of the workspace whose container to destroy
     */
    readonly destroyContainer: (
      workspaceId: string
    ) => Effect.Effect<void, RpcError>

    /**
     * Pause the Docker container for a workspace.
     *
     * Runs `docker pause {containerName}` which freezes all processes
     * in the container using cgroups. The container retains its memory
     * state and can be resumed instantly.
     *
     * Idempotent: pausing an already-paused container returns gracefully.
     *
     * Commits a `ContainerPaused` event to LiveStore.
     *
     * @param workspaceId - ID of the workspace whose container to pause
     */
    readonly pauseContainer: (
      workspaceId: string
    ) => Effect.Effect<void, RpcError>

    /**
     * Unpause a paused Docker container for a workspace.
     *
     * Runs `docker unpause {containerName}` which thaws all frozen
     * processes. The dev server resumes exactly where it left off.
     *
     * Idempotent: unpausing a non-paused container returns gracefully.
     *
     * Commits a `ContainerUnpaused` event to LiveStore.
     *
     * @param workspaceId - ID of the workspace whose container to unpause
     */
    readonly unpauseContainer: (
      workspaceId: string
    ) => Effect.Effect<void, RpcError>
  }
>() {
  static readonly layer = Layer.scoped(
    ContainerService,
    Effect.gen(function* () {
      const { store } = yield* LaborerStore

      const createContainer = Effect.fn('ContainerService.createContainer')(
        function* (params: CreateContainerParams) {
          const {
            branchName,
            depsImageName,
            devServerConfig,
            projectName,
            workspaceId,
            worktreePath,
          } = params

          // Determine which image to use: deps image (with pre-installed node_modules) or base image
          const image = depsImageName ?? devServerConfig.image
          if (image === null) {
            // Dockerfile-based builds are not yet supported (future work).
            // For v1, an image must be specified.
            return yield* new RpcError({
              message:
                'Container creation requires a devServer.image in laborer.json. Dockerfile builds are not yet supported.',
              code: 'CONTAINER_CONFIG_ERROR',
            })
          }

          // Generate container name and OrbStack URL.
          // The .orb.local URL is always stored as containerUrl because it
          // doubles as the Docker container name (strip ".orb.local" suffix).
          // The UI derives the user-facing URL from the network mode and port.
          const { name, url } = containerName(branchName, projectName)
          const workdir = devServerConfig.workdir

          yield* Effect.logInfo(
            `Creating container "${name}" from image "${image}"${depsImageName ? ' (cached deps)' : ''} with worktree mounted at ${workdir}`
          ).pipe(Effect.annotateLogs('module', logPrefix))

          // Build network flags: use specified network or fall back to default
          // bridge networking. Bridge mode gives each container its own IP and
          // .orb.local domain, enabling isolated port spaces across workspaces.
          // Containers can still reach:
          //  - Native Mac services via host.docker.internal (OrbStack provides this)
          //  - Other Docker containers via their .orb.local domains
          //  - Docker-compose services via service.project.orb.local
          const networkFlags = devServerConfig.network
            ? ['--network', devServerConfig.network]
            : []

          // Build volume flags: bind mount for worktree source code.
          // node_modules are pre-seeded into the worktree by DepsImageService
          // so they come through the bind mount naturally.
          const volumeFlags = ['-v', `${worktreePath}:${workdir}`]

          // Run: docker run -d --name {name} {networkFlags} {volumeFlags} -w {workdir} {image} sleep infinity
          const runResult = yield* Effect.tryPromise({
            try: async () => {
              const proc = spawn(
                [
                  'docker',
                  'run',
                  '-d',
                  '--name',
                  name,
                  ...networkFlags,
                  ...volumeFlags,
                  '-w',
                  workdir,
                  image,
                  'sleep',
                  'infinity',
                ],
                {
                  stdout: 'pipe',
                  stderr: 'pipe',
                }
              )
              const exitCode = await proc.exited
              const stdout = await new Response(proc.stdout).text()
              const stderr = await new Response(proc.stderr).text()
              return { exitCode, stdout, stderr }
            },
            catch: (error) =>
              new RpcError({
                message: `Failed to spawn docker run: ${String(error)}`,
                code: 'CONTAINER_CREATE_FAILED',
              }),
          })

          if (runResult.exitCode !== 0) {
            yield* Effect.logWarning(
              `docker run failed (exit ${runResult.exitCode}): ${runResult.stderr.trim()}`
            ).pipe(Effect.annotateLogs('module', logPrefix))

            return yield* new RpcError({
              message: `Failed to create container "${name}" (exit ${runResult.exitCode}): ${runResult.stderr.trim()}`,
              code: 'CONTAINER_CREATE_FAILED',
            })
          }

          // Docker outputs the container ID on stdout
          const containerId = runResult.stdout.trim()

          yield* Effect.logInfo(
            `Container "${name}" created (id: ${containerId.slice(0, 12)}), URL: ${url}`
          ).pipe(Effect.annotateLogs('module', logPrefix))

          // Commit ContainerStarted event to LiveStore
          store.commit(
            events.containerStarted({
              workspaceId,
              containerId,
              containerUrl: url,
              containerImage: image,
            })
          )
        }
      )

      const destroyContainer = Effect.fn('ContainerService.destroyContainer')(
        function* (workspaceId: string) {
          // Look up the workspace to get the container ID
          const allWorkspaces = store.query(tables.workspaces)
          const workspaceOpt = pipe(
            allWorkspaces,
            Arr.findFirst((w) => w.id === workspaceId)
          )

          if (workspaceOpt._tag === 'None') {
            yield* Effect.logWarning(
              `Cannot destroy container: workspace "${workspaceId}" not found in LiveStore`
            ).pipe(Effect.annotateLogs('module', logPrefix))
            return
          }

          const workspace = workspaceOpt.value

          // If no container is associated, nothing to destroy
          if (workspace.containerId === null) {
            yield* Effect.logDebug(
              `Workspace "${workspaceId}" has no container, skipping container destroy`
            ).pipe(Effect.annotateLogs('module', logPrefix))
            return
          }

          const containerNameValue =
            workspace.containerUrl?.replace('.orb.local', '') ?? workspaceId

          yield* Effect.logInfo(
            `Destroying container "${containerNameValue}" for workspace "${workspaceId}"`
          ).pipe(Effect.annotateLogs('module', logPrefix))

          // Step 1: docker stop (best-effort)
          yield* Effect.tryPromise({
            try: async () => {
              const proc = spawn(['docker', 'stop', containerNameValue], {
                stdout: 'pipe',
                stderr: 'pipe',
              })
              const exitCode = await proc.exited
              const stderr = await new Response(proc.stderr).text()
              return { exitCode, stderr }
            },
            catch: (error) =>
              new RpcError({
                message: `Failed to spawn docker stop: ${String(error)}`,
                code: 'CONTAINER_STOP_FAILED',
              }),
          }).pipe(
            Effect.tap(({ exitCode, stderr }) =>
              exitCode !== 0
                ? Effect.logWarning(
                    `docker stop failed (exit ${exitCode}): ${stderr.trim()}`
                  ).pipe(Effect.annotateLogs('module', logPrefix))
                : Effect.logDebug(
                    `Container "${containerNameValue}" stopped`
                  ).pipe(Effect.annotateLogs('module', logPrefix))
            ),
            Effect.catchAll((error) =>
              Effect.logWarning(
                `Failed to stop container "${containerNameValue}": ${String(error)}`
              ).pipe(Effect.annotateLogs('module', logPrefix))
            )
          )

          // Step 2: docker rm (best-effort)
          yield* Effect.tryPromise({
            try: async () => {
              const proc = spawn(['docker', 'rm', containerNameValue], {
                stdout: 'pipe',
                stderr: 'pipe',
              })
              const exitCode = await proc.exited
              const stderr = await new Response(proc.stderr).text()
              return { exitCode, stderr }
            },
            catch: (error) =>
              new RpcError({
                message: `Failed to spawn docker rm: ${String(error)}`,
                code: 'CONTAINER_REMOVE_FAILED',
              }),
          }).pipe(
            Effect.tap(({ exitCode, stderr }) =>
              exitCode !== 0
                ? Effect.logWarning(
                    `docker rm failed (exit ${exitCode}): ${stderr.trim()}`
                  ).pipe(Effect.annotateLogs('module', logPrefix))
                : Effect.logDebug(
                    `Container "${containerNameValue}" removed`
                  ).pipe(Effect.annotateLogs('module', logPrefix))
            ),
            Effect.catchAll((error) =>
              Effect.logWarning(
                `Failed to remove container "${containerNameValue}": ${String(error)}`
              ).pipe(Effect.annotateLogs('module', logPrefix))
            )
          )

          // Commit ContainerStopped event to LiveStore
          store.commit(events.containerStopped({ workspaceId }))

          yield* Effect.logInfo(
            `Container cleanup complete for workspace "${workspaceId}"`
          ).pipe(Effect.annotateLogs('module', logPrefix))
        }
      )

      /**
       * Helper to look up a workspace and its container name from LiveStore.
       * Returns null if the workspace or containerId is missing.
       */
      const lookupContainer = (workspaceId: string) => {
        const allWorkspaces = store.query(tables.workspaces)
        const workspaceOpt = pipe(
          allWorkspaces,
          Arr.findFirst((w) => w.id === workspaceId)
        )

        if (workspaceOpt._tag === 'None') {
          return null
        }

        const workspace = workspaceOpt.value
        if (workspace.containerId === null) {
          return null
        }

        const name =
          workspace.containerUrl?.replace('.orb.local', '') ?? workspaceId

        return { workspace, name }
      }

      /**
       * Query the actual Docker container status via `docker inspect`.
       * Returns the status string (e.g. "running", "paused", "exited", "created")
       * or null if the container doesn't exist or inspect fails.
       */
      const getDockerContainerStatus = (
        containerName: string
      ): Effect.Effect<string | null> =>
        Effect.tryPromise({
          try: async () => {
            const proc = spawn(
              [
                'docker',
                'inspect',
                '--format',
                '{{.State.Status}}',
                containerName,
              ],
              {
                stdout: 'pipe',
                stderr: 'pipe',
              }
            )
            const exitCode = await proc.exited
            const stdout = await new Response(proc.stdout).text()
            if (exitCode !== 0) {
              return null
            }
            return stdout.trim() || null
          },
          catch: () => null,
        }).pipe(Effect.catchAll(() => Effect.succeed(null)))

      const pauseContainer = Effect.fn('ContainerService.pauseContainer')(
        function* (workspaceId: string) {
          const lookup = lookupContainer(workspaceId)

          if (lookup === null) {
            return yield* new RpcError({
              message: `Cannot pause container: workspace "${workspaceId}" not found or has no container`,
              code: 'CONTAINER_NOT_FOUND',
            })
          }

          const { name: containerNameValue } = lookup

          // Check actual Docker state to handle external state changes
          // (e.g. user paused/stopped via OrbStack UI)
          const dockerStatus =
            yield* getDockerContainerStatus(containerNameValue)

          // Container is already paused — sync LiveStore and return gracefully
          if (dockerStatus === 'paused') {
            yield* Effect.logDebug(
              `Container "${containerNameValue}" is already paused in Docker, syncing LiveStore`
            ).pipe(Effect.annotateLogs('module', logPrefix))
            store.commit(events.containerPaused({ workspaceId }))
            return
          }

          // Container is not running (exited, stopped, or gone) — sync LiveStore
          // and report the actual state instead of failing with a confusing
          // Docker daemon error
          if (dockerStatus !== 'running') {
            yield* Effect.logWarning(
              `Container "${containerNameValue}" is not running (docker status: ${dockerStatus ?? 'not found'}), syncing LiveStore`
            ).pipe(Effect.annotateLogs('module', logPrefix))
            store.commit(events.containerStopped({ workspaceId }))
            return yield* new RpcError({
              message: `Container "${containerNameValue}" is not running (status: ${dockerStatus ?? 'not found'})`,
              code: 'CONTAINER_NOT_FOUND',
            })
          }

          yield* Effect.logInfo(
            `Pausing container "${containerNameValue}" for workspace "${workspaceId}"`
          ).pipe(Effect.annotateLogs('module', logPrefix))

          const result = yield* Effect.tryPromise({
            try: async () => {
              const proc = spawn(['docker', 'pause', containerNameValue], {
                stdout: 'pipe',
                stderr: 'pipe',
              })
              const exitCode = await proc.exited
              const stderr = await new Response(proc.stderr).text()
              return { exitCode, stderr }
            },
            catch: (error) =>
              new RpcError({
                message: `Failed to spawn docker pause: ${String(error)}`,
                code: 'CONTAINER_PAUSE_FAILED',
              }),
          })

          if (result.exitCode !== 0) {
            yield* Effect.logWarning(
              `docker pause failed (exit ${result.exitCode}): ${result.stderr.trim()}`
            ).pipe(Effect.annotateLogs('module', logPrefix))

            return yield* new RpcError({
              message: `Failed to pause container "${containerNameValue}" (exit ${result.exitCode}): ${result.stderr.trim()}`,
              code: 'CONTAINER_PAUSE_FAILED',
            })
          }

          store.commit(events.containerPaused({ workspaceId }))

          yield* Effect.logInfo(
            `Container "${containerNameValue}" paused`
          ).pipe(Effect.annotateLogs('module', logPrefix))
        }
      )

      const unpauseContainer = Effect.fn('ContainerService.unpauseContainer')(
        function* (workspaceId: string) {
          const lookup = lookupContainer(workspaceId)

          if (lookup === null) {
            return yield* new RpcError({
              message: `Cannot unpause container: workspace "${workspaceId}" not found or has no container`,
              code: 'CONTAINER_NOT_FOUND',
            })
          }

          const { name: containerNameValue } = lookup

          // Check actual Docker state to handle external state changes
          // (e.g. user resumed via OrbStack UI)
          const dockerStatus =
            yield* getDockerContainerStatus(containerNameValue)

          // Container is already running — sync LiveStore and return gracefully
          if (dockerStatus === 'running') {
            yield* Effect.logDebug(
              `Container "${containerNameValue}" is already running in Docker, syncing LiveStore`
            ).pipe(Effect.annotateLogs('module', logPrefix))
            store.commit(events.containerUnpaused({ workspaceId }))
            return
          }

          // Container is not paused (exited, stopped, or gone) — sync LiveStore
          // and report the actual state
          if (dockerStatus !== 'paused') {
            yield* Effect.logWarning(
              `Container "${containerNameValue}" is not paused (docker status: ${dockerStatus ?? 'not found'}), syncing LiveStore`
            ).pipe(Effect.annotateLogs('module', logPrefix))
            store.commit(events.containerStopped({ workspaceId }))
            return yield* new RpcError({
              message: `Container "${containerNameValue}" is not available (status: ${dockerStatus ?? 'not found'})`,
              code: 'CONTAINER_NOT_FOUND',
            })
          }

          yield* Effect.logInfo(
            `Unpausing container "${containerNameValue}" for workspace "${workspaceId}"`
          ).pipe(Effect.annotateLogs('module', logPrefix))

          const result = yield* Effect.tryPromise({
            try: async () => {
              const proc = spawn(['docker', 'unpause', containerNameValue], {
                stdout: 'pipe',
                stderr: 'pipe',
              })
              const exitCode = await proc.exited
              const stderr = await new Response(proc.stderr).text()
              return { exitCode, stderr }
            },
            catch: (error) =>
              new RpcError({
                message: `Failed to spawn docker unpause: ${String(error)}`,
                code: 'CONTAINER_UNPAUSE_FAILED',
              }),
          })

          if (result.exitCode !== 0) {
            yield* Effect.logWarning(
              `docker unpause failed (exit ${result.exitCode}): ${result.stderr.trim()}`
            ).pipe(Effect.annotateLogs('module', logPrefix))

            return yield* new RpcError({
              message: `Failed to unpause container "${containerNameValue}" (exit ${result.exitCode}): ${result.stderr.trim()}`,
              code: 'CONTAINER_UNPAUSE_FAILED',
            })
          }

          store.commit(events.containerUnpaused({ workspaceId }))

          yield* Effect.logInfo(
            `Container "${containerNameValue}" unpaused`
          ).pipe(Effect.annotateLogs('module', logPrefix))
        }
      )

      // ── Startup reconciliation ──────────────────────────────────
      // On startup, check every workspace that LiveStore thinks has a
      // container and verify against actual Docker state. This catches
      // containers that were stopped/removed/paused while the app was
      // not running (e.g. OrbStack restart, manual `docker stop`, etc.).

      /**
       * Reconcile a single workspace's container state against Docker.
       * Commits the appropriate LiveStore event if the states diverge.
       */
      const reconcileWorkspaceContainer = Effect.fn(
        'ContainerService.reconcileWorkspaceContainer'
      )(function* (workspace: {
        readonly id: string
        readonly containerId: string | null
        readonly containerUrl: string | null
        readonly containerStatus: string | null
      }) {
        const name =
          workspace.containerUrl?.replace('.orb.local', '') ?? workspace.id
        const dockerStatus = yield* getDockerContainerStatus(name)
        const lsStatus = workspace.containerStatus

        // Already in sync — nothing to do
        if (
          (dockerStatus === 'running' && lsStatus === 'running') ||
          (dockerStatus === 'paused' && lsStatus === 'paused')
        ) {
          return
        }

        yield* Effect.logInfo(
          `Reconcile: container "${name}" is ${dockerStatus ?? 'not found'} in Docker but "${lsStatus}" in LiveStore, syncing`
        ).pipe(Effect.annotateLogs('module', logPrefix))

        if (dockerStatus === 'paused') {
          store.commit(events.containerPaused({ workspaceId: workspace.id }))
        } else if (dockerStatus === 'running') {
          store.commit(events.containerUnpaused({ workspaceId: workspace.id }))
        } else {
          // exited, dead, not found, etc. — container is gone
          store.commit(events.containerStopped({ workspaceId: workspace.id }))
        }
      })

      // Run reconciliation for all containerized workspaces at startup
      const containerized = store
        .query(tables.workspaces)
        .filter((ws) => ws.containerId !== null)

      if (containerized.length > 0) {
        yield* Effect.logInfo(
          `Reconciling Docker state for ${containerized.length} containerized workspace(s)`
        ).pipe(Effect.annotateLogs('module', logPrefix))

        yield* Effect.forEach(
          containerized,
          (workspace) =>
            reconcileWorkspaceContainer(workspace).pipe(
              Effect.catchAll((error) =>
                Effect.logWarning(
                  `Reconcile: failed to check workspace "${workspace.id}": ${String(error)}`
                ).pipe(Effect.annotateLogs('module', logPrefix))
              )
            ),
          { discard: true }
        )
      }

      // ── Docker events listener ────────────────────────────────
      // Spawn `docker events` as a long-running subprocess that streams
      // container state changes in real time. When a tracked container
      // (one that exists in LiveStore) is paused, unpaused, stopped, or
      // dies externally (e.g. via OrbStack UI or `docker` CLI), we sync
      // the LiveStore state to match reality so the UI updates immediately.

      /**
       * Build a reverse lookup from container name → workspaceId so we can
       * match incoming Docker events to our tracked workspaces.
       */
      const getContainerNameToWorkspaceId = () => {
        const allWorkspaces = store.query(tables.workspaces)
        const map = new Map<string, string>()
        for (const workspace of allWorkspaces) {
          if (workspace.containerId === null) {
            continue
          }
          const name =
            workspace.containerUrl?.replace('.orb.local', '') ?? workspace.id
          map.set(name, workspace.id)
        }
        return map
      }

      /**
       * Process a single line from `docker events` JSON output.
       * Matches the container name against tracked workspaces and commits
       * the appropriate LiveStore event when external state changes are detected.
       */
      const handleDockerEvent = Effect.fn('ContainerService.handleDockerEvent')(
        function* (line: string) {
          // Parse the JSON event line. docker events --format '{{json .}}'
          // produces objects with fields: status, id, from, Type, Action,
          // Actor (with Attributes.name), time, timeNano
          const parsed = yield* Effect.try({
            try: () =>
              JSON.parse(line) as {
                readonly Action?: string
                readonly Actor?: {
                  readonly Attributes?: { readonly name?: string }
                }
                readonly status?: string
              },
            catch: () => new Error('Invalid JSON from docker events'),
          }).pipe(Effect.option)

          if (parsed._tag === 'None') {
            return
          }

          const event = parsed.value
          const containerNameValue = event.Actor?.Attributes?.name
          if (containerNameValue === undefined) {
            return
          }

          const lookup = getContainerNameToWorkspaceId()
          const workspaceId = lookup.get(containerNameValue)
          if (workspaceId === undefined) {
            return // Not one of our tracked containers
          }

          const action = event.Action ?? event.status
          if (action === undefined) {
            return
          }

          switch (action) {
            case 'pause': {
              yield* Effect.logInfo(
                `Docker event: container "${containerNameValue}" paused externally, syncing LiveStore`
              ).pipe(Effect.annotateLogs('module', logPrefix))
              store.commit(events.containerPaused({ workspaceId }))
              break
            }
            case 'unpause': {
              yield* Effect.logInfo(
                `Docker event: container "${containerNameValue}" unpaused externally, syncing LiveStore`
              ).pipe(Effect.annotateLogs('module', logPrefix))
              store.commit(events.containerUnpaused({ workspaceId }))
              break
            }
            case 'die':
            case 'stop': {
              yield* Effect.logInfo(
                `Docker event: container "${containerNameValue}" ${action} externally, syncing LiveStore`
              ).pipe(Effect.annotateLogs('module', logPrefix))
              store.commit(events.containerStopped({ workspaceId }))
              break
            }
            default:
              // Ignore other events (start, create, destroy, etc.)
              // We handle 'start' via our own createContainer flow
              break
          }
        }
      )

      /**
       * Read lines from a ReadableStream, buffering partial lines across
       * chunks. Calls onLine for each complete line.
       */
      const readLines = async (
        stream: ReadableStream<Uint8Array>,
        onLine: (line: string) => void
      ) => {
        const reader = stream.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) {
              break
            }
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            // Last element is the incomplete line (or empty string)
            buffer = lines.pop() ?? ''
            for (const line of lines) {
              const trimmed = line.trim()
              if (trimmed.length > 0) {
                onLine(trimmed)
              }
            }
          }
          // Process any remaining data in buffer
          const remaining = buffer.trim()
          if (remaining.length > 0) {
            onLine(remaining)
          }
        } catch {
          // Stream closed or errored — expected on shutdown
        }
      }

      /**
       * Start the docker events listener as a long-running subprocess.
       * Uses the Effect runtime to fork event handlers so they run with
       * the full service context (logging, etc.).
       */
      let dockerEventsProc: ReturnType<typeof spawn> | null = null

      const runtime = yield* Effect.runtime<never>()

      const startDockerEventsListener = Effect.gen(function* () {
        yield* Effect.logInfo('Starting docker events listener').pipe(
          Effect.annotateLogs('module', logPrefix)
        )

        const proc = spawn(
          [
            'docker',
            'events',
            '--filter',
            'type=container',
            '--format',
            '{{json .}}',
          ],
          { stdout: 'pipe', stderr: 'ignore' }
        )
        dockerEventsProc = proc

        // Read lines from the docker events stream. Each line is processed
        // to detect external state changes and sync LiveStore.
        yield* Effect.tryPromise({
          try: () =>
            readLines(proc.stdout, (line) => {
              // Fork each event handler on the service runtime so it has
              // access to the full service context (logging, etc.)
              Runtime.runFork(runtime)(handleDockerEvent(line))
            }),
          catch: () => new Error('Docker events stream ended'),
        }).pipe(
          Effect.tapError((error) =>
            Effect.logWarning(
              `Docker events listener stopped: ${String(error)}`
            ).pipe(Effect.annotateLogs('module', logPrefix))
          ),
          Effect.catchAll(() => Effect.void)
        )
      })

      // Fork the docker events listener as a daemon fiber so it runs
      // in the background for the lifetime of the service.
      yield* Effect.forkDaemon(startDockerEventsListener)

      // Clean up the docker events subprocess on service shutdown
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (dockerEventsProc !== null) {
            dockerEventsProc.kill()
            dockerEventsProc = null
          }
        }).pipe(
          Effect.tap(() =>
            Effect.logInfo('Docker events listener stopped').pipe(
              Effect.annotateLogs('module', logPrefix)
            )
          )
        )
      )

      return ContainerService.of({
        createContainer,
        destroyContainer,
        pauseContainer,
        unpauseContainer,
      })
    })
  )
}

export { ContainerService }
export type { CreateContainerParams }
