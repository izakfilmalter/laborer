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
 */

import { RpcServer } from '@effect/rpc'
import { TerminalRpcs } from '@laborer/shared/rpc'
import type { RpcMessagePort } from '@laborer/shared/rpc-transport-messageport'
import { layerProtocolMessagePort } from '@laborer/shared/rpc-transport-messageport'
import { Effect, Layer } from 'effect'

import { TerminalRpcsLive } from './rpc/handlers.js'
import { directLayer as PtyDirectLayer } from './services/pty-direct.js'
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
 * Wait for the parent process to transfer a MessagePort via
 * `process.parentPort`. Returns a promise that resolves with the port.
 *
 * The UtilityProcessManager sends `{ type: 'port' }` with the actual
 * `MessagePort` in the `ports` array after the utility process spawns.
 */
function waitForPort(): Promise<RpcMessagePort> {
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
        resolve(port)
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
 * 1. Waits for the MessagePort from the parent process
 * 2. Builds the Effect layer stack with MessagePort transport
 * 3. Launches the layer (keeps running until interrupted)
 */
async function main(): Promise<void> {
  const port = await waitForPort()

  // Build the RPC layer with MessagePort transport.
  // Unlike the HTTP entry point, we don't need:
  // - NodeHttpServer / ServerLive (no HTTP server)
  // - RpcSerialization.layerJson (MessagePort uses structured clone)
  // - HealthRouteLive, TerminalWsRouteLive, AgentHookRouteLive (no HTTP routes)
  const RpcLive = RpcServer.layer(TerminalRpcs).pipe(
    Layer.provide(layerProtocolMessagePort(port)),
    Layer.provide(TerminalRpcsLive)
  )

  // Full service layer stack.
  const ServiceLayer = RpcLive.pipe(
    Layer.provide(TerminalManager.layer),
    Layer.provide(PtyDirectLayer)
  )

  // Launch the layer — keeps running until the process is killed.
  const program = ServiceLayer.pipe(Layer.launch, Effect.scoped)

  // Use Effect.runPromise instead of NodeRuntime.runMain to avoid
  // installing duplicate signal handlers in the utility process.
  // The parent process manages the lifecycle (kill/restart).
  await Effect.runPromise(program)
}

main().catch((error) => {
  console.error(`[terminal-utility] Fatal error: ${String(error)}`)
  if (error instanceof Error && error.stack) {
    console.error(error.stack)
  }
  process.exit(1)
})
