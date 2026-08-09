/**
 * MCP Service — Utility Process Entry Point
 *
 * Alternative entry point for running the MCP service as an Electron
 * utility process with MessagePort IPC. Replaces the stdio-based
 * `main.ts` entry point for the desktop app context.
 *
 * Architecture:
 * - Runs inside an Electron utility process (forked via bootstrap script)
 * - Receives initial MessagePort from parent for renderer RPC (currently
 *   unused, but reserved for future MCP status/control RPC surface)
 * - Connects to the backend child over WebSocket RPC for project discovery
 * - The MCP server (`McpServer.layerStdio`) is NOT used in this mode —
 *   external MCP clients (Claude, OpenCode, Codex) use the standalone
 *   `main.ts` entry point which is registered by the `McpRegistrar`
 *   server service
 * - Instead, this entry point keeps the MCP service alive and ready to
 *   spawn external MCP server child processes internally via
 *   `child_process.spawn()` when needed
 *
 * What this enables:
 * - The MCP utility process receives commands from the main process via
 *   MessagePort (not stdin, since utilityProcess.fork() ignores stdin)
 * - The MCP utility process connects to the server via WebSocket RPC
 * - External MCP servers can be spawned as child_process with stdin pipe
 *   (the utility process has full access to child_process APIs)
 *
 * MessagePort reception protocol:
 * 1. Bootstrap script loads this module via dynamic import
 * 2. UtilityProcessManager sends `{ type: 'port' }` with initial RPC
 *    MessagePort (for parent/renderer communication)
 * 3. The backend child port is inherited through `PORT`, so MCP connects to
 *    `LaborerRpcs` over the same WebSocket RPC endpoint as other clients
 *
 * Layer composition:
 *   ProjectDiscovery.layer
 *     + LaborerRpcClient.layer (WebSocket RPC-backed)
 *     + McpServer.layerStdio (stdin/stdout for external MCP clients —
 *       only active if stdin is available, i.e. when spawned by an
 *       external tool, not by the desktop app)
 *
 * @see main.ts — stdio-based entry point for external MCP clients
 * @see packages/file-watcher/src/utility-main.ts — Reference pattern
 * @see Issue #15: MCP as utility process
 */

import type { RpcMessagePort } from '@laborer/shared/rpc-transport-messageport'

// ---------------------------------------------------------------------------
// Electron utility process types
// ---------------------------------------------------------------------------

/**
 * Electron's `process.parentPort` is only available inside utility processes.
 * Since the MCP package doesn't depend on Electron types, we define the
 * minimal interface needed here.
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

interface PortResult {
  parentPort: ParentPort
  rpcPort: RpcMessagePort
}

/**
 * Wait for the parent process to transfer the initial RPC MessagePort via
 * `process.parentPort`. Returns a promise that resolves with the port.
 *
 * The UtilityProcessManager sends `{ type: 'port' }` with the actual
 * `MessagePort` in the `ports` array after the utility process spawns.
 */
function waitForRpcPort(): Promise<PortResult> {
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
 * Build and launch the MCP service with WebSocket RPC server communication.
 *
 * This is the main entry point logic. It:
 * 1. Waits for the initial RPC MessagePort from the parent process
 * 2. Builds the MCP service layer with WebSocket-backed LaborerRpcClient
 * 3. Keeps the process alive for the parent to manage
 */
async function main(): Promise<void> {
  await waitForRpcPort()

  // Dynamically import the service modules after the port is available.
  // This avoids loading @effect/ai and other heavy dependencies until needed.
  const { Effect, Layer, Logger } = await import('effect')
  const { LaborerRpcClient } = await import('./services/laborer-rpc-client.js')
  const { ProjectDiscovery } = await import('./services/project-discovery.js')

  // Server now runs as a backend child process with WebSocket RPC, not as a
  // utility process with brokered MessagePorts.
  const LaborerRpcClientLive = LaborerRpcClient.layer

  // The utility process does NOT serve MCP tools via stdio.
  // Electron utility processes have stdin set to 'ignore', so
  // McpServer.layerStdio would fail immediately (causing "All fibers
  // interrupted without errors").
  //
  // External MCP clients (Claude, OpenCode, Codex) use the standalone
  // `main.ts` entry point instead, which IS registered by the server's
  // McpRegistrar service and has proper stdin/stdout access.
  //
  // This utility process keeps the LaborerRpcClient and ProjectDiscovery
  // services alive for future inter-process MCP management features
  // (e.g., spawning MCP server child processes on demand).
  const AppLive = ProjectDiscovery.layer.pipe(
    Layer.provide(LaborerRpcClientLive),
    Layer.provide(Logger.add(Logger.prettyLogger({ stderr: true })))
  )

  // Build the layer and keep the process alive until interrupted.
  // Layer.launch keeps the scoped resources alive; Effect.never ensures
  // the process doesn't exit (the parent manages lifecycle via kill).
  const program = Effect.gen(function* () {
    yield* AppLive.pipe(Layer.launch, Effect.forkScoped)
    return yield* Effect.never
  }).pipe(Effect.scoped)

  // Use Effect.runPromise instead of NodeRuntime.runMain to avoid
  // installing duplicate signal handlers in the utility process.
  // The parent process manages the lifecycle (kill/restart).
  await Effect.runPromise(program)
}

main().catch((error) => {
  console.error(`[mcp-utility] Fatal error: ${String(error)}`)
  if (error instanceof Error && error.stack) {
    console.error(error.stack)
  }
  process.exit(1)
})
