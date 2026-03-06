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
 *   yield* containerService.destroyContainer("ws-123")
 * })
 * ```
 *
 * Issue 5: ContainerService — create and destroy
 */

import { containerName } from '@laborer/shared/container-name'
import { RpcError } from '@laborer/shared/rpc'
import { events, tables } from '@laborer/shared/schema'
import { Array as Arr, Context, Effect, Layer, pipe } from 'effect'
import { LaborerStore } from './laborer-store.js'

/**
 * Configuration for creating a container, derived from the resolved
 * devServer config in laborer.json.
 */
interface CreateContainerParams {
  /** Branch name used for container naming. */
  readonly branchName: string
  /** Resolved devServer config fields. */
  readonly devServerConfig: {
    /** Path to a Dockerfile (mutually exclusive with image). */
    readonly dockerfile: string | null
    /** Base Docker image name (e.g. "node:22"). */
    readonly image: string | null
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
  }
>() {
  static readonly layer = Layer.effect(
    ContainerService,
    Effect.gen(function* () {
      const { store } = yield* LaborerStore

      const createContainer = Effect.fn('ContainerService.createContainer')(
        function* (params: CreateContainerParams) {
          const {
            branchName,
            devServerConfig,
            projectName,
            workspaceId,
            worktreePath,
          } = params

          // Determine which image to use
          const image = devServerConfig.image
          if (image === null) {
            // Dockerfile-based builds are not yet supported (future work).
            // For v1, an image must be specified.
            return yield* new RpcError({
              message:
                'Container creation requires a devServer.image in laborer.json. Dockerfile builds are not yet supported.',
              code: 'CONTAINER_CONFIG_ERROR',
            })
          }

          // Generate container name and URL
          const { name, url } = containerName(branchName, projectName)
          const workdir = devServerConfig.workdir

          yield* Effect.logInfo(
            `Creating container "${name}" from image "${image}" with worktree mounted at ${workdir}`
          ).pipe(Effect.annotateLogs('module', logPrefix))

          // Run: docker run -d --name {name} -v {worktreePath}:{workdir} -w {workdir} {image} sleep infinity
          const runResult = yield* Effect.tryPromise({
            try: async () => {
              const proc = Bun.spawn(
                [
                  'docker',
                  'run',
                  '-d',
                  '--name',
                  name,
                  '-v',
                  `${worktreePath}:${workdir}`,
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
              const proc = Bun.spawn(['docker', 'stop', containerNameValue], {
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
              const proc = Bun.spawn(['docker', 'rm', containerNameValue], {
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

      return ContainerService.of({
        createContainer,
        destroyContainer,
      })
    })
  )
}

export { ContainerService }
export type { CreateContainerParams }
