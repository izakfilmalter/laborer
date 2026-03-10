/**
 * TerminalClient — Effect Service
 *
 * RPC client connecting to the standalone terminal service at
 * `http://localhost:${TERMINAL_PORT}`. This service replaces the server's
 * local TerminalManager, PtyHostClient, and terminal WebSocket route by
 * delegating all terminal operations to the extracted terminal service.
 *
 * Responsibilities:
 * - RPC client for TerminalRpcs operations (spawn, kill, list)
 * - Subscribes to `terminal.events()` on startup to track workspace→terminal mapping
 * - Provides `killAllForWorkspace(workspaceId)` by iterating tracked terminal IDs
 * - Provides `spawnInWorkspace(workspaceId, command?)` that resolves workspace info and delegates
 * - Graceful handling of terminal service being temporarily unreachable
 *
 * @see PRD-terminal-extraction.md
 * @see Issue #143: Server TerminalClient + remove server terminal modules
 * @see Issue #163: Worktree detection polish — worktree existence check before spawn
 */

import { existsSync } from 'node:fs'
import { FetchHttpClient } from '@effect/platform'
import { RpcClient, RpcSerialization } from '@effect/rpc'
import { RpcError, TerminalRpcs } from '@laborer/shared/rpc'
import { tables } from '@laborer/shared/schema'
import {
  Array as Arr,
  Context,
  Duration,
  Effect,
  Layer,
  pipe,
  Ref,
  Schedule,
  Stream,
} from 'effect'
import { ConfigService } from './config-service.js'
import { LaborerStore } from './laborer-store.js'
import { ProjectRegistry } from './project-registry.js'
import { WorkspaceProvider } from './workspace-provider.js'

/** Logger tag used for structured Effect.log output in this module. */
const logPrefix = 'TerminalClient'

/**
 * Map from terminal ID to workspace ID, maintained by the event stream
 * subscriber. Used by `killAllForWorkspace` to find which terminals belong
 * to a given workspace.
 */
type TerminalWorkspaceMap = Map<string, string>

/**
 * Shape of a terminal record returned to RPC handlers.
 * Matches the fields needed for the TerminalResponse RPC schema in LaborerRpcs.
 */
interface TerminalRecord {
  readonly command: string
  readonly id: string
  readonly status: 'running' | 'stopped'
  readonly workspaceId: string
}

class TerminalClient extends Context.Tag('@laborer/TerminalClient')<
  TerminalClient,
  {
    /**
     * Spawn a terminal in a workspace directory.
     * Resolves workspace info (worktree path, env vars) locally, then
     * delegates the actual PTY spawn to the terminal service.
     *
     * When `autoRun` is true and the workspace is containerized, auto-types
     * setup scripts from `laborer.json` followed by the `devServer.startCommand`
     * into the terminal after spawn. The scripts are written with small delays
     * between them to allow the shell to process each line.
     */
    readonly spawnInWorkspace: (
      workspaceId: string,
      command?: string,
      autoRun?: boolean
    ) => Effect.Effect<TerminalRecord, RpcError>

    /**
     * Kill all terminals belonging to a workspace.
     * Iterates the tracked workspace→terminal mapping and calls kill for each.
     */
    readonly killAllForWorkspace: (
      workspaceId: string
    ) => Effect.Effect<number, never>
  }
>() {
  static readonly layer = Layer.scoped(
    TerminalClient,
    Effect.gen(function* () {
      const { store } = yield* LaborerStore
      const workspaceProvider = yield* WorkspaceProvider
      const configService = yield* ConfigService
      const registry = yield* ProjectRegistry

      // Build the RPC client for the terminal service.
      // TERMINAL_PORT is resolved lazily to avoid import-time side effects.
      const { env } = yield* Effect.promise(() => import('@laborer/env/server'))
      const terminalServiceUrl = `http://localhost:${env.TERMINAL_PORT}`

      const rpcClient = yield* RpcClient.make(TerminalRpcs).pipe(
        Effect.provide(
          RpcClient.layerProtocolHttp({
            url: `${terminalServiceUrl}/rpc`,
          }).pipe(
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(RpcSerialization.layerJson)
          )
        )
      )

      // In-memory map of terminal ID → workspace ID.
      // Populated by the event stream subscriber.
      const terminalMapRef = yield* Ref.make<TerminalWorkspaceMap>(new Map())

      // Seed the map from the terminal service's current terminal list.
      // This handles the case where the server restarts but the terminal
      // service has existing terminals from before.
      yield* Effect.gen(function* () {
        const existingTerminals = yield* rpcClient.terminal.list()
        const initialMap = new Map<string, string>()
        for (const terminal of existingTerminals) {
          initialMap.set(terminal.id, terminal.workspaceId)
        }
        yield* Ref.set(terminalMapRef, initialMap)
        yield* Effect.log(
          `Seeded terminal map with ${initialMap.size} existing terminal(s)`
        ).pipe(Effect.annotateLogs('module', logPrefix))
      }).pipe(
        Effect.catchAll((error) =>
          Effect.logWarning(
            `Failed to seed terminal map from terminal service: ${String(error)}`
          ).pipe(Effect.annotateLogs('module', logPrefix))
        )
      )

      // Subscribe to terminal lifecycle events from the terminal service.
      // This stream runs as a background daemon fiber for the lifetime
      // of this layer's scope. It keeps the workspace→terminal map in
      // sync.
      yield* rpcClient.terminal.events().pipe(
        Stream.tap((event) =>
          Effect.gen(function* () {
            if (event._tag === 'Spawned') {
              yield* Ref.update(terminalMapRef, (map) => {
                const next = new Map(map)
                next.set(event.id, event.workspaceId)
                return next
              })
            } else if (event._tag === 'Removed') {
              yield* Ref.update(terminalMapRef, (map) => {
                const next = new Map(map)
                next.delete(event.id)
                return next
              })
            }
          })
        ),
        Stream.runDrain,
        // Retry with exponential backoff if the terminal service disconnects
        Effect.retry(
          Schedule.exponential('1 second').pipe(
            Schedule.union(Schedule.spaced('30 seconds'))
          )
        ),
        Effect.catchAll((error) =>
          Effect.logWarning(
            `Terminal event stream ended: ${String(error)}`
          ).pipe(Effect.annotateLogs('module', logPrefix))
        ),
        Effect.forkScoped
      )

      yield* Effect.log(
        `Connected to terminal service at ${terminalServiceUrl}`
      ).pipe(Effect.annotateLogs('module', logPrefix))

      const defaultShell = process.env.SHELL ?? '/bin/sh'

      /**
       * Convert a TerminalRpcError from the terminal service into a
       * server-side RpcError for propagation to the web client.
       */
      const mapTerminalError = (
        error: unknown
      ): Effect.Effect<never, RpcError> =>
        Effect.fail(
          new RpcError({
            message: error instanceof Error ? error.message : String(error),
            code: 'TERMINAL_ERROR',
          })
        )

      /**
       * Auto-type setup scripts and dev server start command into a terminal.
       * Runs as a fire-and-forget background fiber so it doesn't block the
       * spawn response. Scripts are written sequentially with delays to allow
       * the shell to process each line.
       */
      const autoTypeScripts = (
        terminalId: string,
        setupScripts: readonly string[],
        startCommand: string | null
      ): Effect.Effect<void, never> =>
        Effect.gen(function* () {
          // Wait for the shell inside the container to initialize.
          // Docker exec + /bin/sh startup takes a moment.
          yield* Effect.sleep(Duration.millis(500))

          // Auto-type each setup script
          for (const script of setupScripts) {
            yield* Effect.log(`Auto-typing setup script: ${script}`).pipe(
              Effect.annotateLogs('module', logPrefix)
            )

            yield* rpcClient.terminal
              .write({
                id: terminalId,
                data: `${script}\n`,
              })
              .pipe(
                Effect.catchAll((err) =>
                  Effect.logWarning(
                    `Failed to auto-type setup script '${script}': ${String(err)}`
                  ).pipe(Effect.annotateLogs('module', logPrefix))
                )
              )

            // Small delay between scripts to allow the shell to process
            yield* Effect.sleep(Duration.millis(200))
          }

          // Auto-type the dev server start command
          if (startCommand !== null) {
            yield* Effect.log(
              `Auto-typing start command: ${startCommand}`
            ).pipe(Effect.annotateLogs('module', logPrefix))

            yield* rpcClient.terminal
              .write({
                id: terminalId,
                data: `${startCommand}\n`,
              })
              .pipe(
                Effect.catchAll((err) =>
                  Effect.logWarning(
                    `Failed to auto-type start command '${startCommand}': ${String(err)}`
                  ).pipe(Effect.annotateLogs('module', logPrefix))
                )
              )
          }

          yield* Effect.log(
            `Auto-typing complete for terminal ${terminalId}`
          ).pipe(Effect.annotateLogs('module', logPrefix))
        })

      /**
       * Resolve config and schedule auto-typing of setup scripts and start
       * command into a terminal. Runs as a fire-and-forget daemon fiber.
       */
      const scheduleAutoRun = (
        terminalId: string,
        projectId: string,
        containerImage: string | null
      ): Effect.Effect<void, never> =>
        Effect.gen(function* () {
          const project = yield* registry.getProject(projectId)
          const resolvedConfig = yield* configService
            .resolveConfig(project.repoPath, project.name)
            .pipe(
              Effect.catchAll((err) =>
                Effect.logWarning(
                  `Failed to resolve config for auto-run: ${err.message}`
                ).pipe(
                  Effect.annotateLogs('module', logPrefix),
                  Effect.map(() => null)
                )
              )
            )

          if (resolvedConfig !== null) {
            // Skip setup scripts when a cached deps image was used —
            // node_modules and other setup is already baked into the image.
            const hasCachedDeps =
              containerImage?.startsWith('laborer-deps/') === true
            const setupScripts = hasCachedDeps
              ? []
              : resolvedConfig.devServer.setupScripts.value

            if (hasCachedDeps) {
              yield* Effect.logInfo(
                'Skipping container setup scripts — using cached deps image'
              ).pipe(Effect.annotateLogs('module', logPrefix))
            }

            yield* autoTypeScripts(
              terminalId,
              setupScripts,
              resolvedConfig.devServer.startCommand.value
            )
          }
        }).pipe(
          Effect.catchAll((err) =>
            Effect.logWarning(
              `Auto-run failed for terminal ${terminalId}: ${String(err)}`
            ).pipe(Effect.annotateLogs('module', logPrefix))
          )
        )

      /**
       * Spawn a terminal inside a Docker container via `docker exec`.
       * Optionally auto-types setup scripts + start command when `autoRun` is true.
       */
      const spawnContainerTerminal = Effect.fn(
        'TerminalClient.spawnContainerTerminal'
      )(function* (
        workspace: {
          readonly containerId: string | null
          readonly containerImage: string | null
          readonly containerUrl: string | null
          readonly projectId: string
          readonly worktreePath: string
        },
        workspaceId: string,
        command: string | undefined,
        autoRun: boolean | undefined
      ) {
        const containerNameValue =
          workspace.containerUrl?.replace('.orb.local', '') ?? workspaceId

        yield* Effect.log(
          `Spawning container terminal: docker exec -it ${containerNameValue} /bin/sh`
        ).pipe(Effect.annotateLogs('module', logPrefix))

        const dockerArgs = command
          ? ['exec', '-it', containerNameValue, '/bin/sh', '-c', command]
          : ['exec', '-it', containerNameValue, '/bin/sh']

        const terminalInfo = yield* rpcClient.terminal
          .spawn({
            command: 'docker',
            args: dockerArgs,
            cwd: workspace.worktreePath,
            env: {
              ...process.env,
              TERM: 'xterm-256color',
              COLORTERM: 'truecolor',
            } as Record<string, string>,
            cols: 80,
            rows: 24,
            workspaceId,
          })
          .pipe(Effect.catchAll(mapTerminalError))

        // Auto-type setup scripts + start command when autoRun is requested.
        // Runs as a fire-and-forget background fiber so it doesn't block
        // the spawn response back to the client.
        if (autoRun === true && command === undefined) {
          yield* scheduleAutoRun(
            terminalInfo.id,
            workspace.projectId,
            workspace.containerImage ?? null
          ).pipe(Effect.forkDaemon)
        }

        return {
          id: terminalInfo.id,
          workspaceId,
          command: command ?? 'docker exec /bin/sh',
          status: terminalInfo.status as 'running' | 'stopped',
        }
      })

      /**
       * Spawn a terminal on the host for a non-containerized workspace.
       */
      const spawnHostTerminal = Effect.fn('TerminalClient.spawnHostTerminal')(
        function* (
          workspace: { readonly worktreePath: string },
          workspaceId: string,
          command: string | undefined
        ) {
          const workspaceEnv =
            yield* workspaceProvider.getWorkspaceEnv(workspaceId)

          const resolvedCommand = command ?? defaultShell
          const shellPath = command ? defaultShell : resolvedCommand
          const shellArgs = command ? ['-c', resolvedCommand] : []

          const terminalInfo = yield* rpcClient.terminal
            .spawn({
              command: shellPath,
              args: shellArgs,
              cwd: workspace.worktreePath,
              env: {
                ...process.env,
                ...workspaceEnv,
                TERM: 'xterm-256color',
                COLORTERM: 'truecolor',
              } as Record<string, string>,
              cols: 80,
              rows: 24,
              workspaceId,
            })
            .pipe(Effect.catchAll(mapTerminalError))

          return {
            id: terminalInfo.id,
            workspaceId,
            command: resolvedCommand,
            status: terminalInfo.status as 'running' | 'stopped',
          }
        }
      )

      const spawnInWorkspace = Effect.fn('TerminalClient.spawnInWorkspace')(
        function* (workspaceId: string, command?: string, autoRun?: boolean) {
          // 1. Validate workspace exists and get its info from LiveStore
          const allWorkspaces = store.query(tables.workspaces)
          const workspaceOpt = pipe(
            allWorkspaces,
            Arr.findFirst((w) => w.id === workspaceId)
          )

          if (workspaceOpt._tag === 'None') {
            return yield* new RpcError({
              message: `Workspace not found: ${workspaceId}`,
              code: 'NOT_FOUND',
            })
          }

          const workspace = workspaceOpt.value

          if (
            workspace.status !== 'running' &&
            workspace.status !== 'creating' &&
            workspace.status !== 'stopped'
          ) {
            return yield* new RpcError({
              message: `Workspace ${workspaceId} is in status "${workspace.status}" — cannot spawn terminal`,
              code: 'INVALID_STATE',
            })
          }

          // 1b. Verify worktree directory exists on disk
          if (!existsSync(workspace.worktreePath)) {
            return yield* new RpcError({
              message: `Worktree directory does not exist: ${workspace.worktreePath}. The git worktree may have been removed outside of Laborer.`,
              code: 'WORKTREE_NOT_FOUND',
            })
          }

          // 2. Dev server terminal in containerized workspace: spawn inside container
          if (workspace.containerId != null && autoRun === true) {
            return yield* spawnContainerTerminal(
              workspace,
              workspaceId,
              command,
              autoRun
            )
          }

          // 3. Regular terminal: always spawn on host (even for containerized workspaces)
          return yield* spawnHostTerminal(workspace, workspaceId, command)
        }
      )

      const killAllForWorkspace = Effect.fn(
        'TerminalClient.killAllForWorkspace'
      )(function* (workspaceId: string) {
        const map = yield* Ref.get(terminalMapRef)
        const workspaceTerminalIds = pipe(
          [...map.entries()],
          Arr.filter(([_, wsId]) => wsId === workspaceId),
          Arr.map(([terminalId]) => terminalId)
        )

        if (workspaceTerminalIds.length === 0) {
          return 0
        }

        let killedCount = 0
        yield* Effect.forEach(
          workspaceTerminalIds,
          (terminalId) =>
            pipe(
              rpcClient.terminal.kill({ id: terminalId }),
              Effect.tap(() =>
                Effect.sync(() => {
                  killedCount += 1
                })
              ),
              Effect.catchAll((err) =>
                Effect.logWarning(
                  `Failed to kill terminal ${terminalId} during workspace cleanup: ${String(err)}`
                ).pipe(Effect.annotateLogs('module', logPrefix))
              )
            ),
          { discard: true }
        )

        yield* Effect.log(
          `Killed ${killedCount}/${workspaceTerminalIds.length} terminals for workspace ${workspaceId}`
        ).pipe(Effect.annotateLogs('module', logPrefix))

        return killedCount
      })

      yield* Effect.addFinalizer(() =>
        Effect.log('Shutdown: disconnecting from terminal service').pipe(
          Effect.annotateLogs('module', logPrefix)
        )
      )

      return TerminalClient.of({
        spawnInWorkspace,
        killAllForWorkspace,
      })
    })
  )
}

export { TerminalClient }
