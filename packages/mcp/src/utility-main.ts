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
 * - Receives a brokered MessagePort to the server utility process for
 *   `LaborerRpcs` calls (project listing, PRD CRUD, issue CRUD)
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
 * - The MCP utility process connects to the server via a brokered
 *   MessagePort for LaborerRpcs, replacing the HTTP RPC client
 * - External MCP servers can be spawned as child_process with stdin pipe
 *   (the utility process has full access to child_process APIs)
 *
 * MessagePort reception protocol:
 * 1. Bootstrap script loads this module via dynamic import
 * 2. UtilityProcessManager sends `{ type: 'port' }` with initial RPC
 *    MessagePort (for parent/renderer communication)
 * 3. Main process brokers a MessagePort between MCP and server utility
 *    processes: MCP receives `{ type: 'server-rpc-port' }` with a port
 *    connected to the server's LaborerRpcs
 *
 * Layer composition:
 *   PrdToolsLayer + IssueToolsLayer
 *     + ProjectDiscovery.layer
 *     + LaborerRpcClient.layer (MessagePort-backed)
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
// Server RPC port — deferred resolution
// ---------------------------------------------------------------------------

/**
 * Deferred resolver for the server RPC MessagePort.
 *
 * The main process brokers a `MessageChannelMain` pair between the MCP
 * and server utility processes after both are healthy. The port arrives
 * via `process.parentPort` with `{ type: 'server-rpc-port' }`.
 *
 * The `LaborerRpcClient` service uses this port to call `LaborerRpcs`
 * on the server utility process via MessagePort instead of HTTP.
 *
 * @see Issue #15: MCP as utility process
 */
let resolveServerRpcPort: ((port: RpcMessagePort) => void) | null = null
const serverRpcPortPromise = new Promise<RpcMessagePort>((resolve) => {
  resolveServerRpcPort = resolve
})

/**
 * Export the promise for use by `LaborerRpcClient.utilityLayer`.
 * The layer blocks until the main process sends the brokered port.
 */
export { serverRpcPortPromise }

// ---------------------------------------------------------------------------
// Service composition and launch
// ---------------------------------------------------------------------------

/**
 * Build and launch the MCP service with MessagePort-based server
 * communication.
 *
 * This is the main entry point logic. It:
 * 1. Waits for the initial RPC MessagePort from the parent process
 * 2. Waits for the brokered server RPC port
 * 3. Builds the MCP service layer with MessagePort-backed LaborerRpcClient
 * 4. Keeps the process alive for the parent to manage
 */
async function main(): Promise<void> {
  const { parentPort, rpcPort: _rpcPort } = await waitForRpcPort()

  // Listen for additional port messages from the parent process.
  //
  // - `server-rpc-port`: Direct MessagePort to the server utility process,
  //   brokered by the main process. Used by LaborerRpcClient to call
  //   LaborerRpcs via MessagePort instead of HTTP.
  //   @see Issue #15: MCP as utility process
  parentPort.on('message', (event: { data: unknown; ports: unknown[] }) => {
    const data = event.data as { type?: string }
    if (data?.type === 'server-rpc-port' && event.ports.length > 0) {
      const serverPort = event.ports[0] as RpcMessagePort
      serverPort.start?.()
      console.log('[mcp-utility] Received server RPC port from main process')
      resolveServerRpcPort?.(serverPort)
    }
  })

  // Wait for the brokered server RPC port before building the service layer.
  // The MCP service cannot function without access to the server's LaborerRpcs
  // (project discovery, PRD/issue operations all depend on it).
  const serverRpcPort = await serverRpcPortPromise
  console.log(
    '[mcp-utility] Server RPC port resolved, building service layer...'
  )

  // Dynamically import the service modules after the port is available.
  // This avoids loading @effect/ai and other heavy dependencies until needed.
  const { Effect, Layer, Logger } = await import('effect')
  const { McpServer } = await import('@effect/ai')
  const { NodeSink, NodeStream } = await import('@effect/platform-node')
  const { LaborerRpcClient } = await import('./services/laborer-rpc-client.js')
  const { ProjectDiscovery } = await import('./services/project-discovery.js')
  const { PrdToolsLayer } = await import('./tools/prd-tools.js')
  const { IssueToolsLayer } = await import('./tools/issue-tools.js')

  // Build the LaborerRpcClient layer backed by the brokered MessagePort.
  const LaborerRpcClientLive = LaborerRpcClient.utilityLayer(serverRpcPort)

  // The MCP server layer uses stdio for communication with external MCP
  // clients. In the utility process context, stdin may not be available
  // (Electron utility processes have stdin set to 'ignore'). The MCP
  // server will gracefully handle this — if no external client connects,
  // the tools are simply not invoked via stdio, but the service stays
  // alive for management by the main process.
  const McpLive = McpServer.layerStdio({
    name: 'laborer',
    version: '0.0.0',
    stdin: NodeStream.stdin,
    stdout: NodeSink.stdout,
  })

  const AppLive = PrdToolsLayer.pipe(
    Layer.merge(IssueToolsLayer),
    Layer.provide(ProjectDiscovery.layer),
    Layer.provide(LaborerRpcClientLive),
    Layer.provide(McpLive),
    Layer.provide(Logger.add(Logger.prettyLogger({ stderr: true })))
  )

  const program = AppLive.pipe(Layer.launch, Effect.scoped)

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
