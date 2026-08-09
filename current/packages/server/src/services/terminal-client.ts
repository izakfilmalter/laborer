/**
 * TerminalClient — Effect Service
 *
 * RPC client connecting to the terminal utility process via a direct
 * MessagePort brokered by the Electron main process. No HTTP, no port
 * allocation — the server and terminal processes communicate via
 * structured clone over MessagePort.
 *
 * Requires a `TerminalRpcPort` service tag in the layer context,
 * provided by the server's utility-main.ts when the main process
 * brokers a server-to-terminal MessagePort.
 *
 * Responsibilities:
 * - RPC client for TerminalRpcs operations (spawn, kill, list)
 * - Subscribes to `terminal.events()` lazily to track workspace→terminal mapping
 * - Provides `killAllForWorkspace(workspaceId)` by iterating tracked terminal IDs
 * - Provides `spawnInWorkspace(workspaceId, command?)` that resolves workspace info and delegates
 * - Graceful handling of terminal service being temporarily unreachable
 *
 * Connection is established lazily on first RPC call, not during layer
 * construction. This allows the server to start and serve health checks
 * without waiting for the terminal utility process to be ready.
 *
 * @see PRD-terminal-extraction.md
 * @see Issue #143: Server TerminalClient + remove server terminal modules
 * @see Issue #163: Worktree detection polish — worktree existence check before spawn
 * @see Issue #13: Server-to-terminal MessagePort channel
 * @see Issue #20: Build script update + port reservation removal
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeSocket } from '@effect/platform-node'
import { RpcClient, RpcSerialization } from '@effect/rpc'
import { RpcError, TerminalRpcs } from '@laborer/shared/rpc'
import type { RpcMessagePort } from '@laborer/shared/rpc-transport-messageport'
import { tables } from '@laborer/shared/schema'
import {
  Array as Arr,
  Context,
  Effect,
  Layer,
  Option,
  pipe,
  Ref,
  Scope,
  Stream,
} from 'effect'
import { withInitialAgentPrompt } from './agent-launch-command.js'
import { LaborerStore } from './laborer-store.js'
import {
  createMessagePortRpcClient,
  sidecarEventStreamSchedule,
} from './sidecar-rpc.js'
import { WorkspaceProvider } from './workspace-provider.js'

/** Logger tag used for structured Effect.log output in this module. */
const logPrefix = 'TerminalClient'
const terminalRpcUrl = process.env.LABORER_TERMINAL_RPC_URL ?? null

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

/**
 * Helper used solely for type inference. Never called at runtime.
 * Uses `createMessagePortRpcClient` (same as the real code path)
 * to derive the return type of the terminal RPC client.
 */
const _inferTerminalRpc = (port: RpcMessagePort, scope: Scope.Scope) =>
  createMessagePortRpcClient(TerminalRpcs, port, scope)

/** The inferred type of the terminal RPC client. */
type TerminalRpc = Effect.Effect.Success<ReturnType<typeof _inferTerminalRpc>>

/**
 * Service tag providing a MessagePort for direct RPC to the
 * terminal utility process. Required for `TerminalClient` to
 * communicate with the terminal service.
 *
 * Provided by the server's utility-main.ts when the main process
 * brokers a server-to-terminal MessagePort.
 *
 * @see Issue #13: Server-to-terminal MessagePort channel
 */
class TerminalRpcPort extends Context.Tag('@laborer/TerminalRpcPort')<
  TerminalRpcPort,
  { readonly awaitPort: Effect.Effect<RpcMessagePort> }
>() {}

export { TerminalRpcPort }

// ---------------------------------------------------------------------------
// Agent hook HTTP server
// ---------------------------------------------------------------------------

/**
 * Read the full request body as a string.
 */
const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
    req.on('error', reject)
  })

/**
 * Start a lightweight HTTP server that accepts agent hook POSTs and
 * forwards them to the terminal service via the `terminal.setAgentStatus`
 * RPC.
 *
 * The server listens on port 0 (OS-assigned random port). Spawned
 * agent terminals receive this port via `LABORER_HOOK_URL` so their
 * hook scripts/plugins can POST lifecycle events.
 *
 * Returns the port the server is listening on.
 */
const startAgentHookServer = (
  rpcClient: TerminalRpc,
  scope: Scope.Scope
): Effect.Effect<number> =>
  Effect.async<number>((resume) => {
    const server: Server = createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/hook/agent-status') {
        res.writeHead(404)
        res.end()
        return
      }

      readBody(req)
        .then((body) => {
          const parsed = JSON.parse(body) as {
            terminalId?: string
            event?: string
          }
          const { terminalId, event } = parsed

          if (
            typeof terminalId !== 'string' ||
            (event !== 'active' &&
              event !== 'waiting_for_input' &&
              event !== 'clear')
          ) {
            res.writeHead(400)
            res.end()
            return
          }

          Effect.runPromise(
            rpcClient.terminal.setAgentStatus({ id: terminalId, event })
          )
            .then(() => {
              res.writeHead(200)
              res.end()
            })
            .catch(() => {
              res.writeHead(500)
              res.end()
            })
        })
        .catch(() => {
          res.writeHead(400)
          res.end()
        })
    })

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0
      resume(Effect.succeed(port))
    })

    // Register a finalizer to close the server when the scope closes
    Effect.runFork(
      Scope.addFinalizer(
        scope,
        Effect.async<void>((done) => {
          server.close(() => done(Effect.void))
        })
      )
    )
  })

/** Build the OpenCode command and environment passed to the terminal spawn. */
const buildOpenCodeSpawnCommand = (
  agentCommand: 'opencode' | 'opencode2',
  terminalId: string,
  terminalPort: number,
  initialPrompt?: string
): { command: string; extraEnv: Record<string, string> } => {
  const launchCommand = withInitialAgentPrompt(agentCommand, initialPrompt)
  return {
    command: launchCommand.command,
    extraEnv: {
      LABORER_TERMINAL_ID: terminalId,
      LABORER_HOOK_URL: `http://localhost:${terminalPort}/hook/agent-status`,
      ...launchCommand.extraEnv,
    },
  }
}

class TerminalClient extends Context.Tag('@laborer/TerminalClient')<
  TerminalClient,
  {
    /**
     * Spawn a terminal in a workspace directory.
     * Resolves workspace info (worktree path, env vars) locally, then
     * delegates the actual PTY spawn to the terminal service.
     *
     */
    readonly spawnInWorkspace: (
      workspaceId: string,
      command?: string,
      autoRun?: boolean,
      initialPrompt?: string
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

      // Capture the layer's scope so lazy connection can use it later.
      // The scope lives for the lifetime of this service layer.
      const layerScope = yield* Effect.scope

      // In-memory map of terminal ID → workspace ID.
      // Populated by the event stream subscriber.
      const terminalMapRef = yield* Ref.make<TerminalWorkspaceMap>(new Map())

      // Check if a MessagePort for the terminal is available (utility
      // process mode). When running as an Electron utility process, the
      // main process brokers a direct MessagePort between the server and
      // terminal processes.
      const terminalRpcPort = yield* Effect.serviceOption(TerminalRpcPort)

      /**
       * Get or create the RPC client. On first call, establishes the
       * connection to the terminal utility process via MessagePort,
       * seeds the terminal map, and starts the event stream subscription.
       *
       * Uses Effect.cached to ensure only one fiber runs initialization,
       * preventing duplicate RPC connections and event stream subscriptions
       * when multiple fibers call getOrCreateClient concurrently.
       *
       * Returns both the client and the terminal port so callers don't
       * need to resolve the env separately.
       *
       * The captured layerScope is provided so the RPC client's lifecycle
       * is tied to the layer, and the event stream fiber is forked into
       * the layer's scope for proper cleanup on shutdown.
       */
      const getOrCreateClient = yield* Effect.cached(
        Effect.gen(function* () {
          const client = yield* (() => {
            if (Option.isSome(terminalRpcPort)) {
              return Effect.gen(function* () {
                const port = yield* terminalRpcPort.value.awaitPort
                return yield* createMessagePortRpcClient(
                  TerminalRpcs,
                  port,
                  layerScope
                )
              })
            }

            if (terminalRpcUrl) {
              return Effect.gen(function* () {
                const socketLayer = NodeSocket.layerWebSocket(terminalRpcUrl)
                const context = yield* Layer.build(
                  RpcClient.layerProtocolSocket({
                    retryTransientErrors: true,
                  }).pipe(
                    Layer.provide(
                      Layer.mergeAll(socketLayer, RpcSerialization.layerJson)
                    )
                  )
                )
                return yield* RpcClient.make(TerminalRpcs).pipe(
                  Effect.provide(context)
                )
              })
            }

            return Effect.die(
              'TerminalRpcPort is not available and LABORER_TERMINAL_RPC_URL is unset — cannot connect to terminal service'
            )
          })()

          // Seed the map from the terminal service's current terminal list.
          // This handles the case where the server restarts but the terminal
          // service has existing terminals from before.
          yield* Effect.gen(function* () {
            const existingTerminals = yield* client.terminal.list()
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
          // This runs as a background fiber in the layer's scope for the
          // lifetime of the layer. It keeps the workspace→terminal map in sync.
          yield* client.terminal.events().pipe(
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
            Effect.retry(sidecarEventStreamSchedule),
            Effect.catchAll((error) =>
              Effect.logWarning(
                `Terminal event stream ended: ${String(error)}`
              ).pipe(Effect.annotateLogs('module', logPrefix))
            ),
            Effect.provideService(Scope.Scope, layerScope),
            Effect.forkIn(layerScope)
          )

          yield* Effect.log('Connected to terminal service').pipe(
            Effect.annotateLogs('module', logPrefix)
          )

          // Lightweight HTTP server for agent hook callbacks.
          // Agent CLIs (OpenCode plugin, Claude hooks) POST lifecycle
          // events here. The server forwards them to the terminal
          // service via the `terminal.setAgentStatus` RPC.
          const hookPort = yield* startAgentHookServer(client, layerScope)

          yield* Effect.log(
            `Agent hook server listening on port ${hookPort}`
          ).pipe(Effect.annotateLogs('module', logPrefix))

          return { client, terminalPort: hookPort }
        })
      )

      const defaultShell = process.env.SHELL ?? '/bin/sh'

      /**
       * Known agent commands that support hook-based lifecycle reporting.
       * Each agent has a different mechanism:
       * - `claude` — supports `--settings` with hooks JSON
       * - `opencode2` — supports plugins via `.opencode/plugins/` directory
       *   (plugin is created at workspace setup, not per-spawn)
       */
      const HOOKABLE_AGENTS = new Set(['claude', 'opencode', 'opencode2'])
      const PROMPTABLE_AGENTS = new Set(['opencode', 'opencode2'])

      /**
       * Build the Claude Code `--settings` JSON for agent hook injection.
       * The hooks fire `curl` to the terminal service's hook endpoint
       * on lifecycle transitions (SessionStart, Stop, Notification).
       *
       * @see .reference/cmux/Resources/bin/claude — cmux's approach
       */
      /**
       * Build the Claude Code hooks settings JSON object.
       *
       * The hook commands use curl to POST to the terminal service.
       * Commands read LABORER_TERMINAL_ID and LABORER_HOOK_URL from the
       * environment (set on the PTY process), avoiding the need to embed
       * the terminal ID and URL in the JSON itself.
       *
       * @see .reference/cmux/Resources/bin/claude — cmux's approach
       */
      const buildClaudeHooksSettings = (): Record<string, unknown> => ({
        hooks: {
          SessionStart: [
            {
              matcher: '',
              hooks: [
                {
                  type: 'command',
                  command:
                    'curl -s -X POST "$LABORER_HOOK_URL" -H "Content-Type: application/json" -d "{\\"terminalId\\":\\"$LABORER_TERMINAL_ID\\",\\"event\\":\\"active\\"}" > /dev/null 2>&1',
                  timeout: 10,
                },
              ],
            },
          ],
          Stop: [
            {
              matcher: '',
              hooks: [
                {
                  type: 'command',
                  command:
                    'curl -s -X POST "$LABORER_HOOK_URL" -H "Content-Type: application/json" -d "{\\"terminalId\\":\\"$LABORER_TERMINAL_ID\\",\\"event\\":\\"waiting_for_input\\"}" > /dev/null 2>&1',
                  timeout: 10,
                },
              ],
            },
          ],
          Notification: [
            {
              matcher: '',
              hooks: [
                {
                  type: 'command',
                  command:
                    'curl -s -X POST "$LABORER_HOOK_URL" -H "Content-Type: application/json" -d "{\\"terminalId\\":\\"$LABORER_TERMINAL_ID\\",\\"event\\":\\"waiting_for_input\\"}" > /dev/null 2>&1',
                  timeout: 10,
                },
              ],
            },
          ],
        },
      })

      /**
       * Write a Claude Code settings file with hooks and return the
       * path. The file is written to a temp location so it persists
       * for the lifetime of the terminal session.
       */
      const writeClaudeSettings = (terminalId: string): string => {
        const settingsDir = join(tmpdir(), 'laborer-agent-hooks')
        mkdirSync(settingsDir, { recursive: true })
        const settingsPath = join(settingsDir, `${terminalId}.json`)
        writeFileSync(
          settingsPath,
          JSON.stringify(buildClaudeHooksSettings()),
          'utf-8'
        )
        return settingsPath
      }

      /**
       * Build the shell command string for spawning an agent with hooks.
       * Returns the modified command and any extra env vars needed.
       */
      const buildAgentCommand = (
        agentCommand: string,
        terminalId: string,
        terminalPort: number,
        initialPrompt?: string
      ): { command: string; extraEnv: Record<string, string> } => {
        const hookUrl = `http://localhost:${terminalPort}/hook/agent-status`
        const extraEnv: Record<string, string> = {
          LABORER_TERMINAL_ID: terminalId,
          LABORER_HOOK_URL: hookUrl,
        }

        if (agentCommand === 'claude') {
          const settingsPath = writeClaudeSettings(terminalId)
          return {
            command: `claude --settings ${settingsPath}`,
            extraEnv,
          }
        }

        // For OpenCode and other agents, add any supported initial prompt.
        // OpenCode hooks are handled via a plugin file that reads
        // LABORER_TERMINAL_ID and LABORER_HOOK_URL from the environment.
        return buildOpenCodeSpawnCommand(
          agentCommand as 'opencode' | 'opencode2',
          terminalId,
          terminalPort,
          initialPrompt
        )
      }

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

      const provideLayerScope = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(Effect.provideService(Scope.Scope, layerScope))

      /**
       * Spawn a terminal in the local worktree.
       *
       * When the command is a known agent CLI (claude, opencode2), hook
       * settings are injected so the agent reports its lifecycle state
       * back to the terminal service. This enables accurate "needs input"
       * detection for agents that stay running as interactive CLIs.
       */
      const spawnHostTerminal = Effect.fn('TerminalClient.spawnHostTerminal')(
        function* (
          workspace: { readonly worktreePath: string },
          workspaceId: string,
          command: string | undefined,
          initialPrompt?: string
        ) {
          const { client: rpcClient, terminalPort } =
            yield* provideLayerScope(getOrCreateClient)

          const workspaceEnv =
            yield* workspaceProvider.getWorkspaceEnv(workspaceId)

          const isHookableAgent =
            command !== undefined && HOOKABLE_AGENTS.has(command)
          const isPromptableAgent =
            command !== undefined && PROMPTABLE_AGENTS.has(command)

          // Pre-generate terminal ID when spawning an agent so we can
          // inject it into the hook settings/env before the PTY starts.
          const terminalId = isHookableAgent ? crypto.randomUUID() : undefined

          // Build the command, potentially wrapping it with hook settings
          let launchCommand = {
            command: command ?? defaultShell,
            extraEnv: {} as Record<string, string>,
          }
          if (isHookableAgent && terminalId !== undefined) {
            launchCommand = buildAgentCommand(
              command,
              terminalId,
              terminalPort,
              initialPrompt
            )
          } else if (isPromptableAgent) {
            launchCommand = withInitialAgentPrompt(command, initialPrompt)
          }
          const { command: agentCmd, extraEnv } = launchCommand

          const resolvedCommand = command ?? defaultShell
          const shellPath = command ? defaultShell : resolvedCommand
          const shellArgs = command ? ['-c', agentCmd] : []

          const terminalInfo = yield* provideLayerScope(
            rpcClient.terminal
              .spawn({
                command: shellPath,
                args: shellArgs,
                cwd: workspace.worktreePath,
                env: {
                  ...process.env,
                  ...workspaceEnv,
                  ...extraEnv,
                  TERM: 'xterm-256color',
                  COLORTERM: 'truecolor',
                } as Record<string, string>,
                id: terminalId,
                cols: 80,
                rows: 24,
                workspaceId,
              })
              .pipe(Effect.catchAll(mapTerminalError))
          )

          return {
            id: terminalInfo.id,
            workspaceId,
            command: resolvedCommand,
            status: terminalInfo.status as 'running' | 'stopped',
          }
        }
      )

      const spawnInWorkspace = Effect.fn('TerminalClient.spawnInWorkspace')(
        function* (
          workspaceId: string,
          command?: string,
          _autoRun?: boolean,
          initialPrompt?: string
        ) {
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

          if (workspace.status === 'destroyed') {
            return yield* new RpcError({
              message: `Workspace ${workspaceId} has been destroyed — cannot spawn terminal`,
              code: 'INVALID_STATE',
            })
          }

          if (workspace.worktreePath.trim() === '') {
            return yield* new RpcError({
              message: `Workspace ${workspaceId} has no local worktree.`,
              code: 'INVALID_STATE',
            })
          }

          // Verify the local worktree directory exists on disk.
          if (!existsSync(workspace.worktreePath)) {
            return yield* new RpcError({
              message: `Worktree directory does not exist: ${workspace.worktreePath}. The git worktree may have been removed outside of Laborer.`,
              code: 'WORKTREE_NOT_FOUND',
            })
          }

          return yield* spawnHostTerminal(
            workspace,
            workspaceId,
            command,
            initialPrompt
          )
        }
      )

      const killAllForWorkspace = (
        workspaceId: string
      ): Effect.Effect<number, never> =>
        Effect.gen(function* () {
          const map = yield* Ref.get(terminalMapRef)
          const workspaceTerminalIds = pipe(
            [...map.entries()],
            Arr.filter(([_, wsId]) => wsId === workspaceId),
            Arr.map(([terminalId]) => terminalId)
          )

          if (workspaceTerminalIds.length === 0) {
            return 0
          }

          const { client: rpcClient } =
            yield* provideLayerScope(getOrCreateClient)

          let killedCount = 0
          yield* Effect.forEach(
            workspaceTerminalIds,
            (terminalId) =>
              pipe(
                provideLayerScope(rpcClient.terminal.kill({ id: terminalId })),
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

export { buildOpenCodeSpawnCommand, TerminalClient }
