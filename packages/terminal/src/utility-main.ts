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

import { RpcServer } from '@effect/rpc'
import { TerminalRpcs } from '@laborer/shared/rpc'
import type { RpcMessagePort } from '@laborer/shared/rpc-transport-messageport'
import { layerProtocolMessagePort } from '@laborer/shared/rpc-transport-messageport'
import { Effect, Layer, ManagedRuntime, Runtime, Stream } from 'effect'

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

    parentPort.on('message', (event: { data: unknown; ports: unknown[] }) => {
      const data = event.data as { type?: string }
      if (data?.type === 'port' && event.ports.length > 0) {
        clearTimeout(timeout)
        const port = event.ports[0] as RpcMessagePort
        port.start?.()
        resolve({ parentPort, rpcPort: port })
      }
    })
  })
}

// ---------------------------------------------------------------------------
// Additional RPC port handling
// ---------------------------------------------------------------------------

function serveRpcOnPort<R>(
  port: RpcMessagePort,
  managedRuntime: ManagedRuntime.ManagedRuntime<R, never>,
  servicesLayer: Layer.Layer<TerminalManager>
): void {
  const RpcLive = RpcServer.layer(TerminalRpcs).pipe(
    Layer.provide(layerProtocolMessagePort(port)),
    Layer.provide(TerminalRpcsLive),
    Layer.provide(servicesLayer)
  )

  const program = Layer.launch(RpcLive).pipe(Effect.scoped)
  managedRuntime.runFork(program)
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
          })
        )

        if (spawnResult._tag === 'Right') {
          const record = spawnResult.right
          persistence.registerTerminal(record.id, saved.cols, saved.rows)

          if (saved.replayBuffer.length > 0) {
            persistence.writeOutput(record.id, saved.replayBuffer)
          }

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

            yield* tm.subscribe(event.terminal.id, (data: string) => {
              persistence.writeOutput(event.terminal.id, data)
            })
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
          (terminalId) => tm.getScreenState(terminalId)
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

  const managedRuntime = ManagedRuntime.make(FullLayer)
  const runtime = await managedRuntime.runtime()

  // Set up session persistence (replay buffers, SIGTERM handler, restore)
  setupSessionPersistence(managedRuntime, persistedState)

  parentPort.on('message', (event: { data: unknown; ports: unknown[] }) => {
    const data = event.data as { terminalId?: string; type?: string }
    if (
      data?.type === 'terminal-data-port' &&
      typeof data.terminalId === 'string' &&
      event.ports.length > 0
    ) {
      const dataPort = event.ports[0] as RpcMessagePort
      dataPort.start?.()
      handleTerminalDataPort(dataPort, data.terminalId, runtime)
    } else if (data?.type === 'port' && event.ports.length > 0) {
      const additionalRpcPort = event.ports[0] as RpcMessagePort
      additionalRpcPort.start?.()
      console.log(
        '[terminal-utility] Serving TerminalRpcs on additional port (inter-process)'
      )
      serveRpcOnPort(additionalRpcPort, managedRuntime, ServicesLayer)
    }
  })

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
