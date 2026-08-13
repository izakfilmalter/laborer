/**
 * File Watcher Service — Utility Process Entry Point
 *
 * Alternative entry point for running the file-watcher service as an Electron
 * utility process with MessagePort RPC transport. Replaces the HTTP-based
 * `main.ts` entry point.
 *
 * Architecture:
 * - Runs inside an Electron utility process (forked via bootstrap script)
 * - Receives a MessagePort from the parent process for RPC communication
 * - Uses @parcel/watcher directly (same as the HTTP entry point)
 * - WatcherManager and RPC handlers are unchanged — only the transport
 *   layer is swapped (MessagePort instead of HTTP)
 *
 * MessagePort reception protocol:
 * 1. The bootstrap script loads this module via dynamic import
 * 2. The UtilityProcessManager sends a `{ type: 'port' }` message with a
 *    MessagePort in the `ports` array via `process.parentPort`
 * 3. This module receives the port and uses it for RPC via
 *    `layerProtocolMessagePort(port)`
 * 4. Subsequent `{ type: 'port' }` messages carry additional RPC ports
 *    for inter-process communication (e.g., server calling file-watcher)
 *
 * Layer composition:
 *   RpcServer.layer(FileWatcherRpcs)
 *     + layerProtocolMessagePort(port)    — MessagePort transport (no HTTP)
 *     + FileWatcherRpcsLive               — RPC handler implementations
 *     + WatcherManager.layer              — Watch subscription management
 *     + FileWatcher.layer                 — Low-level fs/native watcher
 *
 * @see main.ts — HTTP-based entry point (to be removed after migration)
 * @see packages/terminal/src/utility-main.ts — Terminal utility process (reference pattern)
 * @see Issue #14: File-watcher as utility process
 */

import { createServer } from 'node:http'
import { NodeHttpServer } from '@effect/platform-node'
import { FileWatcherRpcs } from '@laborer/shared/rpc'
import type { RpcMessagePort } from '@laborer/shared/rpc-transport-messageport'
import { layerProtocolMessagePort } from '@laborer/shared/rpc-transport-messageport'
import { Context, Effect, Layer, ManagedRuntime } from 'effect'
import { HttpMiddleware, HttpRouter } from 'effect/unstable/http'
import { RpcSerialization, RpcServer } from 'effect/unstable/rpc'

import { FileWatcherRpcsLive } from './rpc/handlers.js'
import { FileWatcher } from './services/file-watcher.js'
import { WatcherManager } from './services/watcher-manager.js'

// ---------------------------------------------------------------------------
// Electron utility process types
// ---------------------------------------------------------------------------

/**
 * Electron's `process.parentPort` is only available inside utility processes.
 * Since the file-watcher package doesn't depend on Electron types, we define
 * the minimal interface needed here.
 *
 * @see .reference/vscode/src/vs/base/parts/sandbox/node/electronTypes.ts
 */
interface ParentPort {
  on(
    event: 'message',
    listener: (event: { data: unknown; ports: unknown[] }) => void
  ): void
  removeListener(
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
 * After the RPC port is received, subsequent `{ type: 'port' }` messages
 * carry additional RPC ports for inter-process communication.
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

    const listener = (event: { data: unknown; ports: unknown[] }) => {
      const data = event.data as { type?: string }
      if (data?.type === 'port' && event.ports.length > 0) {
        clearTimeout(timeout)
        // Remove this listener so it doesn't fire for subsequent
        // brokered ports (which would call start() prematurely).
        parentPort.removeListener('message', listener)
        const port = event.ports[0] as RpcMessagePort
        // Electron MessagePortMain requires start() to begin receiving
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
 * Serve `FileWatcherRpcs` on an additional MessagePort, sharing the
 * existing WatcherManager instance from the managed runtime.
 *
 * Takes a pre-built `sharedServicesLayer` (a `Layer.succeedContext`
 * snapshot of the live services) instead of the raw `ServicesLayer`.
 * This ensures all ports share the same WatcherManager and FileWatcher.
 *
 * @see .reference/vscode/src/vs/base/parts/ipc/node/ipc.mp.ts (Server)
 * @see Issue #14: File-watcher as utility process
 */
function serveRpcOnPort(
  port: RpcMessagePort,
  sharedServicesLayer: Layer.Layer<WatcherManager>
): void {
  const RpcLive = RpcServer.layer(FileWatcherRpcs).pipe(
    Layer.provide(layerProtocolMessagePort(port)),
    Layer.provide(FileWatcherRpcsLive),
    Layer.provide(sharedServicesLayer)
  )

  console.log(
    '[file-watcher-utility] serveRpcOnPort: launching RPC server layer...'
  )
  const program = Effect.gen(function* () {
    console.log(
      '[file-watcher-utility] serveRpcOnPort: inside Effect.gen, about to Layer.launch'
    )
    return yield* Layer.launch(RpcLive)
  }).pipe(
    Effect.scoped,
    Effect.tapCause((cause) =>
      Effect.sync(() => {
        console.error(
          '[file-watcher-utility] serveRpcOnPort failed:',
          String(cause)
        )
      })
    )
  )
  Effect.runFork(program)
}

function serveWebSocketRpc(
  port: number,
  sharedServicesLayer: Layer.Layer<WatcherManager>
): void {
  const RpcLive = RpcServer.layer(FileWatcherRpcs).pipe(
    Layer.provide(RpcServer.layerProtocolWebsocket({ path: '/rpc' })),
    Layer.provide(FileWatcherRpcsLive),
    Layer.provide(sharedServicesLayer)
  )
  const ServerLive = HttpRouter.serve(RpcLive, {
    middleware: HttpMiddleware.cors(),
  }).pipe(
    Layer.provide(RpcSerialization.layerJson),
    Layer.provide(
      NodeHttpServer.layer(createServer, { host: '127.0.0.1', port })
    )
  )

  Effect.runFork(
    Layer.launch(ServerLive).pipe(
      Effect.tap(() =>
        Effect.logInfo(
          `[file-watcher-utility] WebSocket RPC listening on 127.0.0.1:${String(port)}`
        )
      ),
      Effect.scoped
    )
  )
}

// ---------------------------------------------------------------------------
// Service composition and launch
// ---------------------------------------------------------------------------

/**
 * Build and launch the file-watcher service layer with MessagePort RPC.
 *
 * This is the main entry point logic. It:
 * 1. Waits for the RPC MessagePort from the parent process
 * 2. Builds the shared services layer (WatcherManager + FileWatcher)
 * 3. Creates a ManagedRuntime to keep services alive
 * 4. Builds the RPC server using the same service instances
 * 5. Listens for additional RPC port messages from the parent
 */
async function main(): Promise<void> {
  const { parentPort, rpcPort } = await waitForRpcPort()

  // Services layer — provides WatcherManager and FileWatcher.
  //
  // FileWatcher.layer provides FileWatcher (the native/@parcel/watcher impl).
  // WatcherManager.layer requires FileWatcher and provides WatcherManager.
  // By merging them with FileWatcher.layer as the dependency, both services
  // are available in the output context.
  const ServicesLayer = Layer.merge(
    WatcherManager.layer,
    FileWatcher.layer
  ).pipe(Layer.provide(FileWatcher.layer))

  // RPC server layer — serves FileWatcherRpcs over MessagePort.
  const RpcLive = RpcServer.layer(FileWatcherRpcs).pipe(
    Layer.provide(layerProtocolMessagePort(rpcPort)),
    Layer.provide(FileWatcherRpcsLive),
    Layer.provide(ServicesLayer)
  )

  // Full layer: RPC server + services passthrough.
  // The RPC server runs as part of the layer (long-lived).
  // The services passthrough gives the ManagedRuntime access to
  // WatcherManager + FileWatcher for additional RPC port handlers.
  const FullLayer = Layer.merge(RpcLive, ServicesLayer)

  // Create managed runtime. This:
  // 1. Builds the layer (starts WatcherManager, FileWatcher, RPC server)
  // 2. Keeps everything alive until dispose() is called
  // 3. Provides a runtime with WatcherManager + FileWatcher for
  //    forking additional RPC handlers
  // Buffer additional ports that arrive before the runtime is ready.
  // The brokered inter-process port may arrive during managedRuntime
  // initialization (after waitForRpcPort's listener is removed but
  // before the main handler is registered). Buffering ensures no
  // ports are lost.
  const bufferedPorts: RpcMessagePort[] = []
  let portHandler: ((port: RpcMessagePort) => void) | null = null

  // Register the message listener BEFORE awaiting the runtime to
  // avoid dropping messages that arrive during initialization.
  parentPort.on('message', (event: { data: unknown; ports: unknown[] }) => {
    const data = event.data as { type?: string }
    if (data?.type === 'port' && event.ports.length > 0) {
      const additionalRpcPort = event.ports[0] as RpcMessagePort
      console.log(
        '[file-watcher-utility] Serving FileWatcherRpcs on additional port (inter-process)'
      )
      if (portHandler) {
        portHandler(additionalRpcPort)
      } else {
        bufferedPorts.push(additionalRpcPort)
      }
    }
  })

  const managedRuntime = ManagedRuntime.make(FullLayer)
  const context = await managedRuntime.context()

  // Extract the live WatcherManager from the managed runtime's context.
  const sharedServicesLayer = Layer.succeedContext(
    Context.make(WatcherManager, Context.get(context, WatcherManager))
  )

  const httpPort = Number(process.env.LABORER_FILE_WATCHER_HTTP_PORT ?? '0')
  if (httpPort > 0) {
    serveWebSocketRpc(httpPort, sharedServicesLayer)
  }

  // Wire up the port handler now that the runtime is ready.
  portHandler = (port) => {
    // Test: attach a raw listener to verify port connectivity
    if (typeof port.on === 'function') {
      port.on('message', (msg: unknown) => {
        console.log(
          '[file-watcher-utility] RAW message on brokered port:',
          typeof msg,
          JSON.stringify(msg)?.slice(0, 200)
        )
      })
      port.start?.()
      console.log(
        '[file-watcher-utility] RAW listener attached + started on brokered port'
      )
    }
    serveRpcOnPort(port, sharedServicesLayer)
  }

  // Drain any ports that arrived during initialization.
  for (const port of bufferedPorts) {
    // Same raw listener test for buffered ports
    if (typeof port.on === 'function') {
      port.on('message', (msg: unknown) => {
        console.log(
          '[file-watcher-utility] RAW message on BUFFERED port:',
          typeof msg,
          JSON.stringify(msg)?.slice(0, 200)
        )
      })
      port.start?.()
      console.log(
        '[file-watcher-utility] RAW listener attached + started on BUFFERED port'
      )
    }
    serveRpcOnPort(port, sharedServicesLayer)
  }

  // Keep the process alive indefinitely. The parent process manages
  // the lifecycle (kill/restart). The managed runtime keeps the layer
  // alive until dispose() is called.
  await new Promise(() => {
    // Never resolves — process stays alive
  })
}

main().catch((error) => {
  console.error(`[file-watcher-utility] Fatal error: ${String(error)}`)
  if (error instanceof Error && error.stack) {
    console.error(error.stack)
  }
  process.exit(1)
})
