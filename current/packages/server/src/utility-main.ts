/**
 * Laborer Server — Utility Process Entry Point
 *
 * Alternative entry point for running the server as an Electron utility
 * process with MessagePort RPC transport. Replaces the HTTP-based
 * `main.ts` entry point for the desktop app.
 *
 * Architecture:
 * - Runs inside an Electron utility process (forked via bootstrap script)
 * - Receives a MessagePort from the parent process for RPC communication
 * - LaborerRpcs served over MessagePort (no HTTP server)
 * - Command-service proxies are exposed immediately; real services hydrate in
 *   background fibers
 * - LiveStore setup preserved (sync channel migrated separately in #11)
 * - Server-to-terminal and server-to-file-watcher connections use lazy
 *   MessagePort acquisition so startup does not wait for sidecar ports
 *
 * What's removed vs main.ts:
 * - No NodeHttpServer / ServerLive (no HTTP server binding)
 * - No RpcSerialization.layerJson (MessagePort uses structured clone)
 * - No CustomRoutesLive (no HTTP health/init-status routes — init status
 *   is available via the `lifecycle.initStatus` RPC)
 * - No SyncRpcLive (LiveStore WebSocket sync migrated in #11)
 * - No HttpRouter / HttpMiddleware / CORS
 *
 * What's preserved:
 * - LaborerRpcsLive (all ~40 RPC handlers)
 * - DeferredServicesProxyLive (Ref-backed proxies + background init fiber)
 * - DeferredServicesReadyLayer
 * - LaborerStoreLive (LiveStore + SQLite persistence)
 * - ConfigService.layer
 * - RepositoryIdentity.layer
 * - Full service stack (all ~20 services)
 *
 * MessagePort reception protocol:
 * 1. The bootstrap script loads this module via dynamic import
 * 2. The UtilityProcessManager sends a `{ type: 'port' }` message with a
 *    MessagePort in the `ports` array via `process.parentPort`
 * 3. This module receives the port and uses it for RPC via
 *    `layerProtocolMessagePort(port)`
 *
 * @see main.ts — HTTP-based entry point (to be removed after migration)
 * @see packages/terminal/src/utility-main.ts — Terminal utility process (reference pattern)
 * @see Issue #10: Server utility process: RPC over MessagePort
 */

import { createServer } from 'node:http'
import { HttpRouter } from '@effect/platform'
import { NodeHttpServer } from '@effect/platform-node'
import { RpcServer } from '@effect/rpc'
import { LaborerRpcs } from '@laborer/shared/rpc'
import type { RpcMessagePort } from '@laborer/shared/rpc-transport-messageport'
import { layerProtocolMessagePort } from '@laborer/shared/rpc-transport-messageport'
import { Context, Effect, Fiber, Layer, pipe, Ref, Stream } from 'effect'

import { LaborerRpcsLive } from './rpc/handlers.js'
import { AgentTaskService } from './services/agent-task-service.js'
import { BackgroundFetchService } from './services/background-fetch-service.js'
import { BranchStateTracker } from './services/branch-state-tracker.js'
import { ConfigService } from './services/config-service.js'
import {
  DeferredServicesReady,
  DeferredServicesReadyLayer,
  makeRefDelegatingService,
  serviceInitializingError,
} from './services/deferred-service.js'
import { FileService } from './services/file-service.js'
import {
  FileWatcherClient,
  FileWatcherRpcPort,
} from './services/file-watcher-client.js'
import { LaborerStore, LaborerStoreLive } from './services/laborer-store.js'
import { PrTaskTransitions } from './services/pr-task-transitions.js'
import { PrWatcher } from './services/pr-watcher.js'
import { ProjectRegistry } from './services/project-registry.js'
import { RepositoryIdentity } from './services/repository-identity.js'
import { RepositoryWatchCoordinator } from './services/repository-watch-coordinator.js'
import { serverDiscoveryLayer } from './services/server-discovery.js'
import { serveSyncOnPort } from './services/sync-backend.js'
import {
  mcpOriginGuard,
  TaskMcpProtocolLayer,
  TaskMcpToolsLayer,
} from './services/task-mcp.js'
import { TerminalClient, TerminalRpcPort } from './services/terminal-client.js'
import { WorkspaceProvider } from './services/workspace-provider.js'
import { WorkspaceSyncService } from './services/workspace-sync-service.js'
import { WorktreeDetector } from './services/worktree-detector.js'
import { WorktreeReconciler } from './services/worktree-reconciler.js'

// ---------------------------------------------------------------------------
// Electron utility process types
// ---------------------------------------------------------------------------

/**
 * Electron's `process.parentPort` is only available inside utility processes.
 * Since the server package doesn't depend on Electron types, we define
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

interface PortResult {
  parentPort: ParentPort
  rpcPort: RpcMessagePort
}

/**
 * Wait for the parent process to transfer a MessagePort via
 * `process.parentPort`. Returns a promise that resolves with the port
 * and a reference to parentPort for continued message listening.
 *
 * The UtilityProcessManager sends `{ type: 'port' }` with the actual
 * `MessagePort` in the `ports` array after the utility process spawns.
 */
function waitForPort(): Promise<PortResult> {
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
        resolve({ rpcPort: port, parentPort })
      }
    })
  })
}

// ---------------------------------------------------------------------------
// Terminal RPC port — deferred resolution
// ---------------------------------------------------------------------------

/**
 * Deferred resolver for the terminal RPC MessagePort.
 *
 * The main process brokers a `MessageChannelMain` pair between the server
 * and terminal utility processes after both are healthy. The port arrives
 * via `process.parentPort` with `{ type: 'terminal-rpc-port' }`.
 *
 * The `TerminalRpcPortLayer` provides this port to the `TerminalClient`
 * service via the `TerminalRpcPort` tag. Since `TerminalClient` is a
 * deferred service (built in a background fiber), the port typically
 * arrives before the client tries to connect.
 *
 * @see Issue #13: Server-to-terminal MessagePort channel
 */
let resolveTerminalRpcPort: ((port: RpcMessagePort) => void) | null = null
const terminalRpcPortPromise = new Promise<RpcMessagePort>((resolve) => {
  resolveTerminalRpcPort = resolve
})

/**
 * Layer providing `TerminalRpcPort` that awaits the brokered port
 * from the main process. Used by `TerminalClient.layer` to create
 * a MessagePort RPC client instead of HTTP.
 *
 * This layer blocks until the main process sends a `terminal-rpc-port`
 * message with the brokered MessagePort. Since `TerminalClient` is a
 * deferred service (built in a background fiber), this blocking does
 * not affect the server's ability to serve health checks immediately.
 */
const TerminalRpcPortLive = Layer.succeed(TerminalRpcPort, {
  awaitPort: Effect.promise(() => terminalRpcPortPromise).pipe(
    Effect.tap(() =>
      Effect.log('Received terminal RPC port from main process').pipe(
        Effect.annotateLogs('module', 'ServerUtility')
      )
    )
  ),
})

// ---------------------------------------------------------------------------
// File-watcher RPC port — deferred resolution
// ---------------------------------------------------------------------------

/**
 * Deferred resolver for the file-watcher RPC MessagePort.
 *
 * The main process brokers a `MessageChannelMain` pair between the server
 * and file-watcher utility processes after both are healthy. The port arrives
 * via `process.parentPort` with `{ type: 'file-watcher-rpc-port' }`.
 *
 * The `FileWatcherRpcPortLive` provides this port to the `FileWatcherClient`
 * service via the `FileWatcherRpcPort` tag. Since `FileWatcherClient` is a
 * deferred service (built in a background fiber), the port typically
 * arrives before the client tries to connect.
 *
 * @see Issue #14: File-watcher as utility process
 */
let resolveFileWatcherRpcPort: ((port: RpcMessagePort) => void) | null = null
const fileWatcherRpcPortPromise = new Promise<RpcMessagePort>((resolve) => {
  resolveFileWatcherRpcPort = resolve
})

/**
 * Layer providing `FileWatcherRpcPort` that awaits the brokered port
 * from the main process. Used by `FileWatcherClient.layer` to create
 * a MessagePort RPC client instead of HTTP.
 *
 * This layer blocks until the main process sends a `file-watcher-rpc-port`
 * message with the brokered MessagePort. Since `FileWatcherClient` is a
 * deferred service (built in a background fiber), this blocking does
 * not affect the server's ability to serve health checks immediately.
 */
const FileWatcherRpcPortLive = Layer.succeed(FileWatcherRpcPort, {
  awaitPort: Effect.promise(() => fileWatcherRpcPortPromise).pipe(
    Effect.tap(() =>
      Effect.log('Received file-watcher RPC port from main process').pipe(
        Effect.annotateLogs('module', 'ServerUtility')
      )
    )
  ),
})

const isUtilityProcess = Boolean(
  (process as unknown as { parentPort?: unknown }).parentPort
)

const provideUtilityPortLayers = <RIn, E, ROut>(
  layer: Layer.Layer<ROut, E, RIn>
) => {
  if (!isUtilityProcess) {
    return layer
  }

  return layer.pipe(
    Layer.provide(FileWatcherRpcPortLive),
    Layer.provide(TerminalRpcPortLive)
  )
}

// ---------------------------------------------------------------------------
// Deferred Layers — Real implementations built in background fibers
// ---------------------------------------------------------------------------

/**
 * Leaf services have no inter-service dependencies, but some perform I/O or
 * establish lazy sidecar clients. Build them off the HTTP startup path.
 */
const DeferredLeafLayers = Layer.mergeAll(
  FileWatcherClient.layer,
  WorktreeDetector.layer
)

/**
 * Services depending on LaborerStore + leaf layers.
 */
const DeferredGroup1aLayers = Layer.mergeAll(
  BranchStateTracker.layer,
  FileService.layer,
  PrWatcher.layer.pipe(Layer.provide(PrTaskTransitions.layer))
)

/**
 * Builds WorktreeReconciler on top of Group 1a.
 */
const DeferredGroup1Layers = WorktreeReconciler.layer.pipe(
  Layer.provideMerge(DeferredGroup1aLayers)
)

const DeferredGroup1WithSync = WorkspaceSyncService.layer.pipe(
  Layer.provide(BackgroundFetchService.layer),
  Layer.provideMerge(DeferredGroup1Layers)
)

const DeferredGroup2Layers = Layer.mergeAll(RepositoryWatchCoordinator.layer)

const DeferredServiceStack = WorkspaceProvider.layer.pipe(
  Layer.provideMerge(ProjectRegistry.layer),
  Layer.provideMerge(DeferredGroup2Layers),
  Layer.provideMerge(DeferredGroup1WithSync)
)

/**
 * Provides cheap Ref-backed proxies immediately, then swaps each proxy to the
 * real implementation as the background service groups finish building.
 */
const DeferredServicesProxyLive = Layer.scopedContext(
  Effect.gen(function* () {
    const fileService = yield* makeRefDelegatingService(FileService, {
      watcherSubscribe: () =>
        Stream.fail(serviceInitializingError('@laborer/FileService')),
    })
    const prWatcher = yield* makeRefDelegatingService(PrWatcher)
    const projectRegistry = yield* makeRefDelegatingService(ProjectRegistry)
    const terminalClient = yield* makeRefDelegatingService(TerminalClient)
    const workspaceProvider = yield* makeRefDelegatingService(WorkspaceProvider)
    const workspaceSyncService =
      yield* makeRefDelegatingService(WorkspaceSyncService)

    yield* Effect.gen(function* () {
      yield* Effect.logInfo(
        'Starting background initialization of deferred services...'
      )

      const store = yield* LaborerStore
      const config = yield* ConfigService
      const repoId = yield* RepositoryIdentity
      const ready = yield* DeferredServicesReady

      const CoreDeps = Layer.mergeAll(
        Layer.succeed(LaborerStore, store),
        Layer.succeed(ConfigService, config),
        Layer.succeed(RepositoryIdentity, repoId),
        Layer.succeed(DeferredServicesReady, ready)
      )

      yield* Effect.logInfo('[deferred-init] Building leaf layers...')
      const leafCtx = yield* Layer.build(
        provideUtilityPortLayers(DeferredLeafLayers).pipe(
          Layer.provide(CoreDeps)
        )
      )
      yield* Effect.logInfo('[deferred-init] Leaf layers built OK')

      const stackFiber = yield* Effect.gen(function* () {
        yield* Effect.logInfo('[deferred-init] Building service stack...')
        const stackCtx = yield* Layer.build(
          DeferredServiceStack.pipe(
            Layer.provide(Layer.succeedContext(leafCtx)),
            Layer.provide(CoreDeps),
            Layer.provide(Layer.succeed(TerminalClient, terminalClient.proxy))
          )
        )
        yield* Effect.logInfo(
          '[deferred-init] Service stack built OK — swapping Refs'
        )
        yield* Ref.set(fileService.ref, Context.get(stackCtx, FileService))
        yield* Ref.set(prWatcher.ref, Context.get(stackCtx, PrWatcher))
        yield* Ref.set(
          projectRegistry.ref,
          Context.get(stackCtx, ProjectRegistry)
        )
        yield* Ref.set(
          workspaceProvider.ref,
          Context.get(stackCtx, WorkspaceProvider)
        )
        yield* Ref.set(
          workspaceSyncService.ref,
          Context.get(stackCtx, WorkspaceSyncService)
        )
      }).pipe(
        Effect.catchAllCause((cause) =>
          Effect.logError('[deferred-init] Service stack init failed', cause)
        ),
        Effect.forkScoped
      )

      const terminalFiber = yield* Effect.gen(function* () {
        yield* Effect.logInfo('[deferred-init] Building TerminalClient...')
        const termCtx = yield* Layer.build(
          provideUtilityPortLayers(TerminalClient.layer).pipe(
            Layer.provide(CoreDeps),
            Layer.provide(
              Layer.succeed(WorkspaceProvider, workspaceProvider.proxy)
            )
          )
        )
        yield* Effect.logInfo(
          '[deferred-init] TerminalClient built OK — swapping Ref'
        )
        yield* Ref.set(terminalClient.ref, Context.get(termCtx, TerminalClient))
      }).pipe(
        Effect.catchAllCause((cause) =>
          Effect.logError('[deferred-init] TerminalClient init failed', cause)
        ),
        Effect.forkScoped
      )

      yield* Fiber.join(stackFiber)
      yield* Fiber.join(terminalFiber)
      yield* Ref.set(ready.ref, true)
      yield* Effect.logInfo(
        '[deferred-init] All groups complete — DeferredServicesReady set to true'
      )
    }).pipe(
      Effect.catchAllCause((cause) =>
        Effect.gen(function* () {
          yield* Effect.logError('Deferred services failed to initialize')
          yield* Effect.logError(cause)
        })
      ),
      Effect.forkScoped,
      Effect.withSpan('deferred.init.all')
    )

    return pipe(
      Context.empty(),
      Context.add(FileService, fileService.proxy),
      Context.add(PrWatcher, prWatcher.proxy),
      Context.add(ProjectRegistry, projectRegistry.proxy),
      Context.add(TerminalClient, terminalClient.proxy),
      Context.add(WorkspaceProvider, workspaceProvider.proxy),
      Context.add(WorkspaceSyncService, workspaceSyncService.proxy)
    )
  })
)

export const InfrastructureLayer = DeferredServicesProxyLive.pipe(
  Layer.provideMerge(DeferredServicesReadyLayer),
  Layer.provideMerge(ConfigService.layer),
  Layer.provideMerge(RepositoryIdentity.layer),
  Layer.provideMerge(LaborerStoreLive)
)

const configuredMcpPort = (): number => {
  const port = Number(process.env.LABORER_SERVER_PORT ?? '3773')
  if (!(Number.isSafeInteger(port) && port >= 1 && port <= 65_535)) {
    throw new Error(
      'LABORER_SERVER_PORT must be an integer between 1 and 65535'
    )
  }
  return port
}

const selectMcpPort = (preferred: number): Promise<number> => {
  if (process.env.LABORER_SERVER_PORT !== undefined) {
    return Promise.resolve(preferred)
  }
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        resolve(0)
      } else {
        reject(error)
      }
    })
    probe.listen(preferred, '127.0.0.1', () => {
      probe.close((error) => (error ? reject(error) : resolve(preferred)))
    })
  })
}

const makeMcpHttpLayer = (port: number) => {
  const config = { host: '127.0.0.1', port } as const
  return Layer.mergeAll(
    TaskMcpToolsLayer,
    HttpRouter.Default.serve(mcpOriginGuard),
    serverDiscoveryLayer(config)
  ).pipe(
    Layer.provide(TaskMcpProtocolLayer),
    Layer.provide(AgentTaskService.layer()),
    Layer.provide(NodeHttpServer.layer(createServer, config))
  )
}

// ---------------------------------------------------------------------------
// Service composition and launch
// ---------------------------------------------------------------------------

/**
 * Build and launch the server service layer with MessagePort RPC.
 *
 * This is the main entry point logic. It:
 * 1. Waits for the MessagePort from the parent process
 * 2. Builds the Effect layer stack with MessagePort transport
 * 3. Launches the layer (keeps running until interrupted)
 *
 * Layer composition:
 *   RpcServer.layer(LaborerRpcs)
 *     + layerProtocolMessagePort(port)     — MessagePort transport (no HTTP)
 *     + LaborerRpcsLive                    — RPC handler implementations
 *     + RealServicesLayer                  — real service implementations
 *     + ServicesReadyLayer                 — readiness stream
 *     + ConfigService.layer               — Configuration resolution
 *     + RepositoryIdentity.layer          — Git repo identification
 *     + LaborerStoreLive                  — LiveStore + SQLite persistence
 */
async function main(): Promise<void> {
  const { rpcPort, parentPort } = await waitForPort()
  const mcpPort = await selectMcpPort(configuredMcpPort())

  // Build the RPC layer with MessagePort transport.
  // Unlike the HTTP entry point, we don't need:
  // - NodeHttpServer / ServerLive (no HTTP server)
  // - RpcSerialization.layerJson (MessagePort uses structured clone)
  // - CustomRoutesLive (no HTTP health/init-status routes)
  // - HttpRouter / HttpMiddleware / CORS
  const RpcLive = RpcServer.layer(LaborerRpcs).pipe(
    Layer.provide(layerProtocolMessagePort(rpcPort)),
    Layer.provide(LaborerRpcsLive)
  )

  // Listen for additional port messages from the parent process.
  //
  // - `sync-port`: LiveStore sync channel for the renderer's worker.
  //   Each incoming sync port gets a standalone `RpcServer` serving
  //   `SyncWsRpc` handlers backed by a shared SQLite sync database.
  //   Multiple ports can be active simultaneously (one per window).
  //   @see Issue #11: LiveStore sync over MessagePort
  //
  // - `terminal-rpc-port`: Direct MessagePort to the terminal utility
  //   process, brokered by the main process. Resolves the deferred
  //   `TerminalRpcPortLive` layer so `TerminalClient` uses MessagePort
  //   RPC instead of HTTP.
  //   @see Issue #13: Server-to-terminal MessagePort channel
  parentPort.on('message', (event: { data: unknown; ports: unknown[] }) => {
    const data = event.data as { type?: string }
    if (data?.type === 'sync-port' && event.ports.length > 0) {
      const syncPort = event.ports[0] as RpcMessagePort
      console.log('[server-utility] Received sync-port from main process')
      // Do NOT call start() here — the RPC server transport will call
      // start() after attaching its message listener to avoid losing
      // messages (MessagePortMain doesn't buffer after start).
      serveSyncOnPort(syncPort, { source: 'renderer' })
    } else if (data?.type === 'terminal-rpc-port' && event.ports.length > 0) {
      const terminalPort = event.ports[0] as RpcMessagePort
      // Do NOT call start() here — the RPC client transport will call
      // start() after attaching its message listener to avoid losing
      // messages (MessagePortMain doesn't buffer after start).
      console.log(
        '[server-utility] Received terminal RPC port from main process'
      )
      resolveTerminalRpcPort?.(terminalPort)
    } else if (
      data?.type === 'file-watcher-rpc-port' &&
      event.ports.length > 0
    ) {
      const fileWatcherPort = event.ports[0] as RpcMessagePort
      // Do NOT call start() here — same reason as above.
      console.log(
        '[server-utility] Received file-watcher RPC port from main process'
      )
      // Smoke test: send a test message and listen for response
      fileWatcherPort.on?.('message', (msg: unknown) => {
        console.log(
          '[server-utility] RECEIVED from file-watcher port:',
          typeof msg,
          JSON.stringify(msg)?.slice(0, 200)
        )
      })
      fileWatcherPort.start?.()
      fileWatcherPort.postMessage?.({ type: 'ping', timestamp: Date.now() })
      console.log('[server-utility] Sent ping to file-watcher port')
      resolveFileWatcherRpcPort?.(fileWatcherPort)
    }
  })

  const program = Layer.merge(RpcLive, makeMcpHttpLayer(mcpPort)).pipe(
    Layer.provide(InfrastructureLayer),
    Layer.launch,
    Effect.scoped
  )

  // Use Effect.runPromise instead of NodeRuntime.runMain to avoid
  // installing duplicate signal handlers in the utility process.
  // The parent process manages the lifecycle (kill/restart).
  await Effect.runPromise(program)
}

if ((process as unknown as { parentPort?: unknown }).parentPort) {
  main().catch((error) => {
    console.error(`[server-utility] Fatal error: ${String(error)}`)
    if (error instanceof Error && error.stack) {
      console.error(error.stack)
    }
    process.exit(1)
  })
}
