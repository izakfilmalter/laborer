/**
 * Terminal Service — Utility Process Entry Point
 *
 * Alternative entry point for running the terminal service as an Electron
 * utility process with MessagePort RPC transport. Replaces the HTTP-based
 * `main.ts` entry point.
 *
 * Architecture (flattened):
 * - Runs inside an Electron utility process (forked via bootstrap script)
 * - Receives a MessagePort from the parent process for RPC communication
 * - Receives per-terminal MessagePorts for PTY I/O data channels
 * - Uses node-pty directly (no separate pty-host child process)
 * - TerminalManager and RPC handlers are unchanged — only the transport
 *   and PtyHostClient layers are swapped
 *
 * MessagePort reception protocol:
 * 1. The bootstrap script loads this module via dynamic import
 * 2. The UtilityProcessManager sends a `{ type: 'port' }` message with a
 *    MessagePort in the `ports` array via `process.parentPort`
 * 3. This module receives the port and uses it for RPC via
 *    `layerProtocolMessagePort(port)`
 * 4. Subsequent `{ type: 'terminal-data-port', terminalId }` messages
 *    carry per-terminal MessagePorts for PTY I/O data channels
 *
 * Layer composition:
 *   RpcServer.layer(TerminalRpcs)
 *     + layerProtocolMessagePort(port)    — MessagePort transport (no HTTP)
 *     + TerminalRpcsLive                  — RPC handler implementations
 *     + TerminalManager.layer             — Terminal lifecycle management
 *     + PtyHostClient directLayer         — Direct node-pty (no child process)
 *
 * @see main.ts — HTTP-based entry point (to be removed after migration)
 * @see .reference/vscode/src/vs/platform/terminal/node/ptyHostMain.ts
 * @see services/terminal-data-channel.ts — Per-terminal data channel handler
 */

import { RpcServer } from '@effect/rpc'
import { TerminalRpcs } from '@laborer/shared/rpc'
import type { RpcMessagePort } from '@laborer/shared/rpc-transport-messageport'
import { layerProtocolMessagePort } from '@laborer/shared/rpc-transport-messageport'
import { Layer, ManagedRuntime } from 'effect'

import { TerminalRpcsLive } from './rpc/handlers.js'
import { directLayer as PtyDirectLayer } from './services/pty-direct.js'
import { handleTerminalDataPort } from './services/terminal-data-channel.js'
import { TerminalManager } from './services/terminal-manager.js'

// ---------------------------------------------------------------------------
// Electron utility process types
// ---------------------------------------------------------------------------

/**
 * Electron's `process.parentPort` is only available inside utility processes.
 * Since the terminal package doesn't depend on Electron types, we define
 * the minimal interface needed here.
 *
 * @see .reference/vscode/src/vs/base/parts/sandbox/node/electronTypes.ts
 */
interface ParentPort {
  on(
    event: 'message',
    listener: (event: { data: unknown; ports: unknown[] }) => void
  ): void
}

/**
 * Access `process.parentPort` with proper typing.
 * This property only exists in Electron utility processes.
 */
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

/**
 * Wait for the parent process to transfer the initial RPC MessagePort via
 * `process.parentPort`. Returns a promise that resolves with the port.
 *
 * The UtilityProcessManager sends `{ type: 'port' }` with the actual
 * `MessagePort` in the `ports` array after the utility process spawns.
 *
 * After the RPC port is received, subsequent `{ type: 'terminal-data-port' }`
 * messages are handled by the data channel listener set up in `main()`.
 */
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
        // Electron MessagePortMain requires start() to begin receiving
        port.start?.()
        resolve({ parentPort, rpcPort: port })
      }
    })
  })
}

// ---------------------------------------------------------------------------
// Service composition and launch
// ---------------------------------------------------------------------------

/**
 * Build and launch the terminal service layer with MessagePort RPC.
 *
 * This is the main entry point logic. It:
 * 1. Waits for the RPC MessagePort from the parent process
 * 2. Builds the shared services layer (TerminalManager + PtyDirect)
 * 3. Creates a ManagedRuntime to keep services alive and provide a
 *    runtime for data channel handlers
 * 4. Builds the RPC server using the same service instances
 * 5. Listens for per-terminal data port messages from the parent
 */
async function main(): Promise<void> {
  const { parentPort, rpcPort } = await waitForRpcPort()

  // Services layer — provides both TerminalManager and PtyHostClient.
  //
  // PtyDirectLayer provides PtyHostClient (the direct node-pty impl).
  // TerminalManager.layer requires PtyHostClient and provides TerminalManager.
  // By merging them with PtyDirectLayer as the dependency, both services
  // are available in the output context — needed by the data channel
  // handlers which call ptyHostClient.write() and ptyHostClient.ack().
  const ServicesLayer = Layer.merge(TerminalManager.layer, PtyDirectLayer).pipe(
    Layer.provide(PtyDirectLayer)
  )

  // RPC server layer — serves TerminalRpcs over MessagePort.
  const RpcLive = RpcServer.layer(TerminalRpcs).pipe(
    Layer.provide(layerProtocolMessagePort(rpcPort)),
    Layer.provide(TerminalRpcsLive),
    Layer.provide(ServicesLayer)
  )

  // Full layer: RPC server + services passthrough.
  // The RPC server runs as part of the layer (long-lived).
  // The services passthrough gives the ManagedRuntime access to
  // TerminalManager + PtyHostClient for data channel handlers.
  const FullLayer = Layer.merge(RpcLive, ServicesLayer)

  // Create managed runtime. This:
  // 1. Builds the layer (starts TerminalManager, PtyDirect, RPC server)
  // 2. Keeps everything alive until dispose() is called
  // 3. Provides a runtime with TerminalManager + PtyHostClient for
  //    forking data channel handlers
  const managedRuntime = ManagedRuntime.make(FullLayer)
  const runtime = await managedRuntime.runtime()

  // Listen for per-terminal data port messages from the parent.
  // These arrive when the renderer requests a dedicated I/O channel
  // for a specific terminal via `acquireTerminalDataPort()`.
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
    }
  })

  // Keep the process alive indefinitely. The parent process manages
  // the lifecycle (kill/restart). The managed runtime keeps the layer
  // alive until dispose() is called.
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
