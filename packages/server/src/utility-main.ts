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
 * - Deferred service initialization pattern preserved intact
 * - LiveStore setup preserved (sync channel migrated separately in #11)
 * - Server-to-terminal and server-to-file-watcher connections left as
 *   HTTP-based stubs temporarily (migrated in #13, #14)
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
 * - Full deferred service stack (all ~20 services)
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

import { RpcServer } from '@effect/rpc'
import { LaborerRpcs } from '@laborer/shared/rpc'
import type { RpcMessagePort } from '@laborer/shared/rpc-transport-messageport'
import { layerProtocolMessagePort } from '@laborer/shared/rpc-transport-messageport'
import { Context, Effect, Layer, pipe, Ref } from 'effect'

import { LaborerRpcsLive } from './rpc/handlers.js'
import { BackgroundFetchService } from './services/background-fetch-service.js'
import { BranchStateTracker } from './services/branch-state-tracker.js'
import { ConfigService } from './services/config-service.js'
import { ContainerService } from './services/container-service.js'
import {
  DeferredServicesReady,
  DeferredServicesReadyLayer,
  makeRefDelegatingService,
} from './services/deferred-service.js'
import { DepsImageService } from './services/deps-image-service.js'
import { DiffService } from './services/diff-service.js'
import { DockerDetection } from './services/docker-detection.js'
import {
  FileWatcherClient,
  FileWatcherRpcPort,
} from './services/file-watcher-client.js'
import { GithubTaskImporter } from './services/github-task-importer.js'
import { LaborerStoreLive } from './services/laborer-store.js'
import { LinearTaskImporter } from './services/linear-task-importer.js'
import { McpRegistrar } from './services/mcp-registrar.js'
import { PrWatcher } from './services/pr-watcher.js'
import { PrdStorageService } from './services/prd-storage-service.js'
import { ProjectRegistry } from './services/project-registry.js'
import { RepositoryIdentity } from './services/repository-identity.js'
import { RepositoryWatchCoordinator } from './services/repository-watch-coordinator.js'
import { ReviewCommentFetcher } from './services/review-comment-fetcher.js'
import { serveSyncOnPort } from './services/sync-backend.js'
import { TaskManager } from './services/task-manager.js'
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
const TerminalRpcPortLive = Layer.effect(
  TerminalRpcPort,
  Effect.gen(function* () {
    const port = yield* Effect.promise(() => terminalRpcPortPromise)
    yield* Effect.log('Received terminal RPC port from main process').pipe(
      Effect.annotateLogs('module', 'ServerUtility')
    )
    return { port }
  })
)

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
const FileWatcherRpcPortLive = Layer.effect(
  FileWatcherRpcPort,
  Effect.gen(function* () {
    const port = yield* Effect.promise(() => fileWatcherRpcPortPromise)
    yield* Effect.log('Received file-watcher RPC port from main process').pipe(
      Effect.annotateLogs('module', 'ServerUtility')
    )
    return { port }
  })
)

// ---------------------------------------------------------------------------
// Deferred Layers — Real implementations (built in background fiber)
// ---------------------------------------------------------------------------

/**
 * Deferred Leaf Layers — no inter-service dependencies but run I/O
 * that can block (Docker CLI, sidecar connections, git commands).
 *
 * Identical to main.ts DeferredLeafLayers.
 */
const DeferredLeafLayers = Layer.mergeAll(
  FileWatcherClient.layer,
  WorktreeDetector.layer,
  DepsImageService.layer,
  DockerDetection.layer
)

/**
 * Deferred Group 1 — services depending on LaborerStore + leaf layers.
 */
const DeferredGroup1Layers = Layer.mergeAll(
  TaskManager.layer,
  BranchStateTracker.layer,
  ContainerService.layer,
  PrdStorageService.layer,
  DiffService.layer,
  PrWatcher.layer,
  WorktreeReconciler.layer
)

/**
 * Deferred Group 1 with WorkspaceSyncService (depends on PrWatcher +
 * BackgroundFetchService in addition to Group 1).
 */
const DeferredGroup1WithSync = WorkspaceSyncService.layer.pipe(
  Layer.provide(BackgroundFetchService.layer),
  Layer.provideMerge(DeferredGroup1Layers)
)

/**
 * Deferred Group 2 — services depending on Group 1.
 */
const DeferredGroup2Layers = Layer.mergeAll(
  GithubTaskImporter.layer,
  LinearTaskImporter.layer,
  ReviewCommentFetcher.layer,
  RepositoryWatchCoordinator.layer
)

/**
 * Full deferred service stack built bottom-up.
 * Each group uses provideMerge so all services remain available
 * as outputs for higher layers to consume.
 */
const DeferredServiceStack = WorkspaceProvider.layer.pipe(
  Layer.provideMerge(ProjectRegistry.layer),
  Layer.provideMerge(DeferredGroup2Layers),
  Layer.provideMerge(DeferredGroup1WithSync)
)

/**
 * Top-level deferred services that depend on the full stack.
 */
const DeferredTopLayers = Layer.mergeAll(
  TerminalClient.layer,
  McpRegistrar.layer
)

/**
 * All deferred services composed into a single layer.
 *
 * External requirements after composition: LaborerStore, ConfigService,
 * RepositoryIdentity (provided by core infrastructure layers).
 *
 * `TerminalRpcPortLive` provides the brokered MessagePort to the terminal
 * utility process. `TerminalClient.layer` uses `Effect.serviceOption` to
 * detect this and uses MessagePort RPC instead of HTTP.
 *
 * `FileWatcherRpcPortLive` provides the brokered MessagePort to the
 * file-watcher utility process. `FileWatcherClient.layer` uses
 * `Effect.serviceOption` to detect this and uses MessagePort RPC instead
 * of HTTP.
 *
 * @see Issue #13: Server-to-terminal MessagePort channel
 * @see Issue #14: File-watcher as utility process
 */
const DeferredServicesLive = DeferredTopLayers.pipe(
  Layer.provide(TerminalRpcPortLive),
  Layer.provideMerge(DeferredServiceStack),
  Layer.provideMerge(
    DeferredLeafLayers.pipe(Layer.provide(FileWatcherRpcPortLive))
  )
)

// ---------------------------------------------------------------------------
// Deferred Services — Placeholder proxies with background initialization
// ---------------------------------------------------------------------------

/**
 * Creates a Layer that provides all 14 deferred service Tags with
 * Ref-backed delegating proxies, AND forks a background fiber to
 * build the real implementations.
 *
 * Identical to the DeferredServicesProxyLive in main.ts.
 */
const DeferredServicesProxyLive = Layer.scopedContext(
  Effect.gen(function* () {
    // --- Create Ref-backed delegating proxies for each deferred service ---

    const containerService = yield* makeRefDelegatingService(ContainerService)
    const diffService = yield* makeRefDelegatingService(DiffService)
    const dockerDetection = yield* makeRefDelegatingService(DockerDetection, {
      // DockerDetection.check() has no error channel — return valid data
      check: () => Effect.succeed({ available: false }),
    })
    const githubTaskImporter =
      yield* makeRefDelegatingService(GithubTaskImporter)
    const linearTaskImporter =
      yield* makeRefDelegatingService(LinearTaskImporter)
    const prWatcher = yield* makeRefDelegatingService(PrWatcher)
    const prdStorageService = yield* makeRefDelegatingService(PrdStorageService)
    const projectRegistry = yield* makeRefDelegatingService(ProjectRegistry)
    const reviewCommentFetcher =
      yield* makeRefDelegatingService(ReviewCommentFetcher)
    const taskManager = yield* makeRefDelegatingService(TaskManager)
    const terminalClient = yield* makeRefDelegatingService(TerminalClient)
    const workspaceProvider = yield* makeRefDelegatingService(WorkspaceProvider)
    const workspaceSyncService =
      yield* makeRefDelegatingService(WorkspaceSyncService)
    const depsImageService = yield* makeRefDelegatingService(DepsImageService)

    // --- Fork background fiber to build real services ---

    yield* Effect.gen(function* () {
      yield* Effect.logInfo(
        'Starting background initialization of deferred services...'
      )

      const ctx = yield* Layer.build(DeferredServicesLive)

      // Swap each Ref to the real implementation
      yield* Ref.set(containerService.ref, Context.get(ctx, ContainerService))
      yield* Ref.set(diffService.ref, Context.get(ctx, DiffService))
      yield* Ref.set(dockerDetection.ref, Context.get(ctx, DockerDetection))
      yield* Ref.set(
        githubTaskImporter.ref,
        Context.get(ctx, GithubTaskImporter)
      )
      yield* Ref.set(
        linearTaskImporter.ref,
        Context.get(ctx, LinearTaskImporter)
      )
      yield* Ref.set(prWatcher.ref, Context.get(ctx, PrWatcher))
      yield* Ref.set(prdStorageService.ref, Context.get(ctx, PrdStorageService))
      yield* Ref.set(projectRegistry.ref, Context.get(ctx, ProjectRegistry))
      yield* Ref.set(
        reviewCommentFetcher.ref,
        Context.get(ctx, ReviewCommentFetcher)
      )
      yield* Ref.set(taskManager.ref, Context.get(ctx, TaskManager))
      yield* Ref.set(terminalClient.ref, Context.get(ctx, TerminalClient))
      yield* Ref.set(workspaceProvider.ref, Context.get(ctx, WorkspaceProvider))
      yield* Ref.set(
        workspaceSyncService.ref,
        Context.get(ctx, WorkspaceSyncService)
      )
      yield* Ref.set(depsImageService.ref, Context.get(ctx, DepsImageService))

      // Signal that all deferred services are ready
      const { ref: readyRef } = yield* DeferredServicesReady
      yield* Ref.set(readyRef, true)

      yield* Effect.logInfo('All deferred services initialized successfully')
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

    // Return context with all 14 proxies
    return pipe(
      Context.empty(),
      Context.add(ContainerService, containerService.proxy),
      Context.add(DiffService, diffService.proxy),
      Context.add(DockerDetection, dockerDetection.proxy),
      Context.add(GithubTaskImporter, githubTaskImporter.proxy),
      Context.add(LinearTaskImporter, linearTaskImporter.proxy),
      Context.add(PrWatcher, prWatcher.proxy),
      Context.add(PrdStorageService, prdStorageService.proxy),
      Context.add(ProjectRegistry, projectRegistry.proxy),
      Context.add(ReviewCommentFetcher, reviewCommentFetcher.proxy),
      Context.add(TaskManager, taskManager.proxy),
      Context.add(TerminalClient, terminalClient.proxy),
      Context.add(WorkspaceProvider, workspaceProvider.proxy),
      Context.add(WorkspaceSyncService, workspaceSyncService.proxy),
      Context.add(DepsImageService, depsImageService.proxy)
    )
  })
)

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
 *     + DeferredServicesProxyLive          — Ref-backed proxies + background init
 *     + DeferredServicesReadyLayer         — Deferred readiness tracking
 *     + ConfigService.layer               — Configuration resolution
 *     + RepositoryIdentity.layer          — Git repo identification
 *     + LaborerStoreLive                  — LiveStore + SQLite persistence
 */
async function main(): Promise<void> {
  const { rpcPort, parentPort } = await waitForPort()

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

  // Full service layer stack.
  // The deferred services proxy layer is placed between the RPC layer
  // and core infrastructure, same as in main.ts's HttpLive.
  const ServiceLayer = RpcLive.pipe(
    // --- Deferred service layers (Ref-backed proxies + background init) ---
    Layer.provide(DeferredServicesProxyLive),
    Layer.provide(DeferredServicesReadyLayer),
    // --- Core infrastructure layers (fast-building) ---
    Layer.provide(ConfigService.layer),
    Layer.provide(RepositoryIdentity.layer),
    Layer.provide(LaborerStoreLive)
  )

  // Launch the main service layer — keeps running until killed.
  const program = ServiceLayer.pipe(Layer.launch, Effect.scoped)

  // Use Effect.runPromise instead of NodeRuntime.runMain to avoid
  // installing duplicate signal handlers in the utility process.
  // The parent process manages the lifecycle (kill/restart).
  const runningPromise = Effect.runPromise(program)

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
      syncPort.start?.()
      serveSyncOnPort(syncPort)
    } else if (data?.type === 'terminal-rpc-port' && event.ports.length > 0) {
      const terminalPort = event.ports[0] as RpcMessagePort
      terminalPort.start?.()
      console.log(
        '[server-utility] Received terminal RPC port from main process'
      )
      resolveTerminalRpcPort?.(terminalPort)
    } else if (
      data?.type === 'file-watcher-rpc-port' &&
      event.ports.length > 0
    ) {
      const fileWatcherPort = event.ports[0] as RpcMessagePort
      fileWatcherPort.start?.()
      console.log(
        '[server-utility] Received file-watcher RPC port from main process'
      )
      resolveFileWatcherRpcPort?.(fileWatcherPort)
    }
  })

  await runningPromise
}

main().catch((error) => {
  console.error(`[server-utility] Fatal error: ${String(error)}`)
  if (error instanceof Error && error.stack) {
    console.error(error.stack)
  }
  process.exit(1)
})
