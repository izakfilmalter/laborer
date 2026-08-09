/**
 * Terminal Service — Utility Process Entry Point
 *
 * Entry point for running the terminal service as an Electron utility process
 * with MessagePort RPC transport.
 *
 * Architecture (flattened):
 * - Runs inside an Electron utility process (forked via bootstrap script)
 * - Receives a MessagePort from the parent process for RPC communication
 * - Receives per-terminal MessagePorts for PTY I/O data channels
 * - Uses node-pty directly (no separate pty-host child process)
 * - TerminalManager and RPC handlers are unchanged — only the transport
 *   and PtyHostClient layers are swapped
 *
 * Session persistence (Issue #18):
 * - Each terminal has a circular replay buffer of recent output
 * - On graceful shutdown (SIGTERM), terminal metadata and replay buffers
 *   are serialized to a temporary file
 * - On startup, persisted state is loaded and terminals are respawned
 *   with the same configuration
 * - On ungraceful termination (crash), terminals are marked as stopped
 *   in the renderer (renderer retains its local xterm buffer)
 *
 * @see .reference/vscode/src/vs/platform/terminal/node/ptyHostMain.ts
 * @see .reference/vscode/src/vs/platform/terminal/node/ptyService.ts line 343
 * @see services/terminal-data-channel.ts — Per-terminal data channel handler
 * @see services/terminal-session-persistence.ts — Replay buffer and serialization
 */

import { createServer } from 'node:http'
import { HttpMiddleware, HttpRouter } from '@effect/platform'
import { NodeHttpServer } from '@effect/platform-node'
import { RpcSerialization, RpcServer } from '@effect/rpc'
import type { AgentStatus, TerminalInfo } from '@laborer/shared/rpc'
import { TerminalRpcs } from '@laborer/shared/rpc'
import type { RpcMessagePort } from '@laborer/shared/rpc-transport-messageport'
import { layerProtocolMessagePort } from '@laborer/shared/rpc-transport-messageport'
import { Context, Effect, Layer, ManagedRuntime, Runtime, Stream } from 'effect'

import { TerminalRpcsLive } from './rpc/handlers.js'
import { directLayer as PtyDirectLayer } from './services/pty-direct.js'
import { handleTerminalDataPort } from './services/terminal-data-channel.js'
import { TerminalManager } from './services/terminal-manager.js'
import type { SerializedState } from './services/terminal-session-persistence.js'
import { createTerminalSessionPersistence } from './services/terminal-session-persistence.js'

// ---------------------------------------------------------------------------
// Electron utility process types
// ---------------------------------------------------------------------------

interface ParentPort {
  on(
    event: 'message',
    listener: (event: { data: unknown; ports: unknown[] }) => void
  ): void
  postMessage(message: unknown): void
  removeListener(
    event: 'message',
    listener: (event: { data: unknown; ports: unknown[] }) => void
  ): void
}

function getParentPort(): ParentPort {
  const pp = (process as unknown as { parentPort?: ParentPort }).parentPort
  if (!pp) {
    throw new Error(
      'process.parentPort is not available. This module must run inside an Electron utility process.'
    )
  }
  return pp
}

// ---------------------------------------------------------------------------
// MessagePort reception
// ---------------------------------------------------------------------------

function waitForRpcPort(): Promise<{
  parentPort: ParentPort
  rpcPort: RpcMessagePort
}> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for MessagePort from parent'))
    }, 10_000)

    const parentPort = getParentPort()

    const listener = (event: { data: unknown; ports: unknown[] }) => {
      const data = event.data as { type?: string }
      if (data?.type === 'port' && event.ports.length > 0) {
        clearTimeout(timeout)
        // Remove this listener so it doesn't fire for subsequent
        // brokered ports (which would call start() prematurely).
        parentPort.removeListener('message', listener)
        const port = event.ports[0] as RpcMessagePort
        port.start?.()
        resolve({ parentPort, rpcPort: port })
      }
    }
    parentPort.on('message', listener)
  })
}

// ---------------------------------------------------------------------------
// Additional RPC port handling
// ---------------------------------------------------------------------------

/**
 * Serve TerminalRpcs on an additional MessagePort, sharing the existing
 * TerminalManager instance from the managed runtime.
 *
 * Takes a pre-built `sharedServicesLayer` (a `Layer.succeedContext` snapshot
 * of the live services) instead of the raw `ServicesLayer`. This ensures all
 * ports — the initial RPC port, brokered inter-process ports, and renderer
 * ports — share the same TerminalManager and see the same terminals.
 *
 * Follows VS Code's pty-host pattern where a single `PtyService` is registered
 * as a channel on an `IPCServer` and automatically shared with every incoming
 * MessagePort connection.
 *
 * @see .reference/vscode/src/vs/platform/terminal/node/ptyHostMain.ts
 * @see .reference/vscode/src/vs/base/parts/ipc/node/ipc.mp.ts (Server)
 */
function serveRpcOnPort(
  port: RpcMessagePort,
  sharedServicesLayer: Layer.Layer<TerminalManager>
): void {
  const RpcLive = RpcServer.layer(TerminalRpcs).pipe(
    Layer.provide(layerProtocolMessagePort(port)),
    Layer.provide(TerminalRpcsLive),
    Layer.provide(sharedServicesLayer)
  )

  const program = Layer.launch(RpcLive).pipe(
    Effect.scoped,
    Effect.tapErrorCause((cause) =>
      Effect.sync(() => {
        console.error(
          '[terminal-utility] serveRpcOnPort failed:',
          String(cause)
        )
      })
    )
  )
  Effect.runFork(program)
}

function serveWebSocketRpc(
  port: number,
  sharedServicesLayer: Layer.Layer<TerminalManager>
): void {
  const RpcLive = RpcServer.layer(TerminalRpcs).pipe(
    Layer.provide(RpcServer.layerProtocolWebsocket({ path: '/rpc' })),
    Layer.provide(TerminalRpcsLive),
    Layer.provide(sharedServicesLayer)
  )
  const ServerLive = HttpRouter.Default.serve(HttpMiddleware.cors()).pipe(
    Layer.provide(RpcLive),
    Layer.provide(RpcSerialization.layerJson),
    Layer.provide(
      NodeHttpServer.layer(createServer, { host: '127.0.0.1', port })
    )
  )

  Effect.runFork(
    Layer.launch(ServerLive).pipe(
      Effect.tap(() =>
        Effect.logInfo(
          `[terminal-utility] WebSocket RPC listening on 127.0.0.1:${String(port)}`
        )
      ),
      Effect.scoped
    )
  )
}

// ---------------------------------------------------------------------------
// Session persistence integration
// ---------------------------------------------------------------------------

/**
 * Set up session persistence: subscribe to lifecycle events to track
 * terminal spawn/removal, subscribe to terminal output to feed the
 * replay buffer, and register a SIGTERM handler for graceful shutdown
 * serialization.
 */
function setupSessionPersistence(
  managedRuntime: ManagedRuntime.ManagedRuntime<TerminalManager, never>,
  persistedState: SerializedState | null
): void {
  const persistence = createTerminalSessionPersistence()

  const program = Effect.gen(function* () {
    const tm = yield* TerminalManager

    // Capture the runtime for synchronous access in the SIGTERM handler
    const rt = yield* Effect.runtime<TerminalManager>()
    const runSync = Runtime.runSync(rt)

    // ---------------------------------------------------------------
    // Restore persisted terminals
    // ---------------------------------------------------------------
    if (persistedState !== null) {
      console.log(
        `[terminal-utility] Restoring ${persistedState.terminals.length} persisted terminal(s)`
      )

      for (const saved of persistedState.terminals) {
        const spawnResult = yield* Effect.either(
          tm.spawn({
            id: saved.id,
            command: saved.command,
            args: [...saved.args],
            cwd: saved.cwd,
            env: { ...saved.env },
            cols: saved.cols,
            rows: saved.rows,
            workspaceId: saved.workspaceId,
            // Exempt from the orphan leak-guard (ADR 0003): restored
            // terminals wait to be re-adopted, however long that takes.
            restored: true,
          })
        )

        if (spawnResult._tag === 'Right') {
          const record = spawnResult.right
          persistence.registerTerminal(record.id, saved.cols, saved.rows)
          persistence.restoreReplayEvent(record.id, saved.replayEvent)

          yield* tm.setRevivedReplayEvent(record.id, saved.replayEvent)

          console.log(
            `[terminal-utility] Restored terminal ${record.id} (${saved.command})`
          )
        } else {
          console.error(
            `[terminal-utility] Failed to restore terminal ${saved.id}: ${String(spawnResult.left)}`
          )
        }
      }
    }

    // ---------------------------------------------------------------
    // Subscribe to lifecycle events for replay buffer tracking
    // ---------------------------------------------------------------
    const lifecycleStream = Stream.fromPubSub(tm.lifecycleEvents)

    yield* Stream.runForEach(lifecycleStream, (event) =>
      Effect.gen(function* () {
        switch (event._tag) {
          case 'Spawned': {
            persistence.registerTerminal(event.terminal.id, 80, 24)

            // Subscribe with replay=false so the session persistence
            // subscriber does NOT drain the replay buffer. The buffer
            // must remain intact for the renderer's data channel, which
            // subscribes later with replay=true (the default).
            yield* tm.subscribe(
              event.terminal.id,
              (data: string) => {
                persistence.writeOutput(event.terminal.id, data)
              },
              { replay: false }
            )
            break
          }

          case 'Removed': {
            persistence.unregisterTerminal(event.id)
            break
          }

          default:
            break
        }
      })
    ).pipe(Effect.forkDaemon)

    // ---------------------------------------------------------------
    // SIGTERM handler for graceful shutdown serialization
    // ---------------------------------------------------------------
    const handleShutdown = (): void => {
      try {
        const terminals = runSync(tm.getTerminals())

        persistence.serializeState(
          () =>
            terminals.map((t) => ({
              id: t.id,
              workspaceId: t.workspaceId,
              command: t.command,
              args: t.args,
              cwd: t.cwd,
              env: t.env,
              status: t.status,
            })),
          (terminalId) => tm.getScreenState(terminalId),
          (terminalId) => tm.getCommandDetectionState(terminalId)
        )
      } catch (error) {
        console.error(
          `[terminal-utility] Failed to serialize state on shutdown: ${String(error)}`
        )
      }
    }

    process.on('SIGTERM', handleShutdown)
    process.on('SIGINT', handleShutdown)
  })

  managedRuntime.runFork(program)
}

/**
 * Forward only status facts to Electron main. Notification policy deliberately
 * stays out of this service; the generation token lets main reject delivery
 * after an agent process is replaced by another instance with the same label.
 */
function setupAgentStatusReporting(
  managedRuntime: ManagedRuntime.ManagedRuntime<TerminalManager, never>,
  parentPort: ParentPort
): void {
  interface Owner {
    readonly agentId: string
    readonly agentName: string
    readonly generation: number
    readonly present: boolean
    readonly processId: number | null
  }

  const owners = new Map<string, Owner>()
  const beginsNewGeneration = (
    previous: Owner | undefined,
    processId: number | null,
    agentName: string
  ): boolean =>
    previous === undefined ||
    (!previous.present && previous.processId !== null) ||
    (previous.processId !== null &&
      processId !== null &&
      previous.processId !== processId) ||
    previous.agentName !== agentName

  interface StatusFact {
    readonly agentId: string
    readonly agentName: string
    readonly status: AgentStatus | null
    readonly workspaceId: string
  }
  const lastFact = new Map<string, StatusFact>()
  const isSameFact = (
    previous: StatusFact | undefined,
    current: StatusFact
  ): boolean =>
    previous?.agentId === current.agentId &&
    previous.agentName === current.agentName &&
    previous.status === current.status &&
    previous.workspaceId === current.workspaceId

  const report = (
    terminal: TerminalInfo & { readonly agentProcessIds?: readonly number[] }
  ): void => {
    const detectedAgent =
      terminal.processChain.find((process) => process.category === 'agent') ??
      (terminal.foregroundProcess?.category === 'agent'
        ? terminal.foregroundProcess
        : null)
    const previousOwner = owners.get(terminal.id)
    let owner = previousOwner

    if (detectedAgent !== null) {
      const processId = terminal.agentProcessIds?.[0] ?? null
      const isNewGeneration = beginsNewGeneration(
        previousOwner,
        processId,
        detectedAgent.label
      )
      const generation = isNewGeneration
        ? (previousOwner?.generation ?? 0) + 1
        : previousOwner.generation
      owner = {
        agentId: `${terminal.id}:${String(generation)}`,
        agentName: detectedAgent.label,
        generation,
        processId,
        present: true,
      }
      owners.set(terminal.id, owner)
    } else if (previousOwner?.present) {
      owner = { ...previousOwner, present: false }
      owners.set(terminal.id, owner)
    }

    if (terminal.agentStatus !== null && owner === undefined) {
      owner = {
        agentId: `${terminal.id}:1`,
        agentName: 'Agent',
        generation: 1,
        processId: null,
        present: false,
      }
      owners.set(terminal.id, owner)
    }

    const status: AgentStatus | null = terminal.agentStatus?.status ?? null
    const fact = {
      agentId: owner?.agentId ?? `${terminal.id}:none`,
      agentName: owner?.agentName ?? 'Agent',
      status,
      terminalId: terminal.id,
      type: 'terminal-agent-status' as const,
      workspaceId: terminal.workspaceId,
    }
    if (isSameFact(lastFact.get(terminal.id), fact)) {
      return
    }
    lastFact.set(terminal.id, fact)
    parentPort.postMessage(fact)
  }

  const program = Effect.gen(function* () {
    const tm = yield* TerminalManager
    yield* Stream.runForEach(Stream.fromPubSub(tm.lifecycleEvents), (event) =>
      Effect.sync(() => {
        if (
          event._tag === 'Spawned' ||
          event._tag === 'Restarted' ||
          event._tag === 'ProcessChanged'
        ) {
          report(event.terminal)
        } else if (event._tag === 'Removed') {
          const owner = owners.get(event.id)
          parentPort.postMessage({
            agentId: owner?.agentId ?? `${event.id}:none`,
            agentName: owner?.agentName ?? 'Agent',
            status: null,
            terminalId: event.id,
            type: 'terminal-agent-status',
            workspaceId: '',
          })
          owners.delete(event.id)
          lastFact.delete(event.id)
        }
      })
    )
  })
  managedRuntime.runFork(program)
}

// ---------------------------------------------------------------------------
// Service composition and launch
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Load persisted state before setting up services
  const persistence = createTerminalSessionPersistence()
  const persistedState = persistence.loadPersistedState()

  const { parentPort, rpcPort } = await waitForRpcPort()

  const ServicesLayer = Layer.merge(TerminalManager.layer, PtyDirectLayer).pipe(
    Layer.provide(PtyDirectLayer)
  )

  const RpcLive = RpcServer.layer(TerminalRpcs).pipe(
    Layer.provide(layerProtocolMessagePort(rpcPort)),
    Layer.provide(TerminalRpcsLive),
    Layer.provide(ServicesLayer)
  )

  const FullLayer = Layer.merge(RpcLive, ServicesLayer)

  // Buffer additional ports and data ports that arrive before the
  // runtime is ready. The brokered inter-process port may arrive
  // during managedRuntime initialization.
  type BufferedMessage =
    | { type: 'port'; port: RpcMessagePort }
    | { type: 'data-port'; port: RpcMessagePort; terminalId: string }
    | { type: 'workspace-presence'; workspaceIds: readonly string[] }
  const bufferedMessages: BufferedMessage[] = []
  let messageHandler: ((msg: BufferedMessage) => void) | null = null

  // Register the listener BEFORE awaiting the runtime to avoid
  // dropping messages that arrive during initialization.
  parentPort.on('message', (event: { data: unknown; ports: unknown[] }) => {
    const data = event.data as {
      terminalId?: string
      type?: string
      workspaceIds?: unknown
    }
    if (
      data?.type === 'terminal-data-port' &&
      typeof data.terminalId === 'string' &&
      event.ports.length > 0
    ) {
      const dataPort = event.ports[0] as RpcMessagePort
      // Do NOT call start() here — the data channel will call start()
      // after attaching its message listener. Starting before a listener
      // exists causes input messages (keypresses) to be silently dropped.
      const msg: BufferedMessage = {
        type: 'data-port',
        port: dataPort,
        terminalId: data.terminalId,
      }
      if (messageHandler) {
        messageHandler(msg)
      } else {
        bufferedMessages.push(msg)
      }
    } else if (
      data?.type === 'workspace-presence' &&
      Array.isArray(data.workspaceIds)
    ) {
      const workspaceIds = data.workspaceIds
        .filter(
          (workspaceId): workspaceId is string =>
            typeof workspaceId === 'string' && workspaceId.length > 0
        )
        .slice(0, 1000)
      const msg: BufferedMessage = { type: 'workspace-presence', workspaceIds }
      if (messageHandler) {
        messageHandler(msg)
      } else {
        bufferedMessages.push(msg)
      }
    } else if (data?.type === 'port' && event.ports.length > 0) {
      const additionalRpcPort = event.ports[0] as RpcMessagePort
      const msg: BufferedMessage = { type: 'port', port: additionalRpcPort }
      if (messageHandler) {
        messageHandler(msg)
      } else {
        bufferedMessages.push(msg)
      }
    }
  })

  const managedRuntime = ManagedRuntime.make(FullLayer)
  const runtime = await managedRuntime.runtime()

  // Extract the live TerminalManager from the managed runtime's context.
  const sharedServicesLayer = Layer.succeedContext(
    Context.make(TerminalManager, Context.get(runtime.context, TerminalManager))
  )

  const httpPort = Number(process.env.LABORER_TERMINAL_HTTP_PORT ?? '0')
  if (httpPort > 0) {
    serveWebSocketRpc(httpPort, sharedServicesLayer)
  }

  // Set up session persistence (replay buffers, SIGTERM handler, restore)
  setupSessionPersistence(managedRuntime, persistedState)
  setupAgentStatusReporting(managedRuntime, parentPort)

  // Wire up the message handler now that the runtime is ready.
  const processMessage = (msg: BufferedMessage) => {
    if (msg.type === 'data-port') {
      handleTerminalDataPort(msg.port, msg.terminalId, runtime)
    } else if (msg.type === 'port') {
      serveRpcOnPort(msg.port, sharedServicesLayer)
    } else {
      managedRuntime.runFork(
        Effect.flatMap(TerminalManager, (manager) =>
          manager.setObservedWorkspaces(new Set(msg.workspaceIds))
        )
      )
    }
  }
  messageHandler = processMessage

  // Drain any messages that arrived during initialization.
  for (const msg of bufferedMessages) {
    processMessage(msg)
  }

  await new Promise(() => {
    // Never resolves — process stays alive
  })
}

main().catch((error) => {
  console.error(`[terminal-utility] Fatal error: ${String(error)}`)
  if (error instanceof Error && error.stack) {
    console.error(error.stack)
  }
  process.exit(1)
})
