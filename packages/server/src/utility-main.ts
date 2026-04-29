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
import { Context, Effect, Fiber, Layer, pipe, Queue, Ref, Stream } from 'effect'

import { LaborerRpcsLive } from './rpc/handlers.js'
import { BackgroundFetchService } from './services/background-fetch-service.js'
import { BranchStateTracker } from './services/branch-state-tracker.js'
import { ConfigService } from './services/config-service.js'
import { ContainerService } from './services/container-service.js'
import { handleDaytonaTerminalDataPort } from './services/daytona-terminal-data-channel.js'
import {
  DeferredServicesReady,
  DeferredServicesReadyLayer,
  makeRefDelegatingService,
  serviceInitializingError,
} from './services/deferred-service.js'
import { DepsImageService } from './services/deps-image-service.js'
import { DockerDetection } from './services/docker-detection.js'
import { FileService } from './services/file-service.js'
import {
  FileWatcherClient,
  FileWatcherRpcPort,
} from './services/file-watcher-client.js'
import { GithubTaskImporter } from './services/github-task-importer.js'
import { LaborerStore, LaborerStoreLive } from './services/laborer-store.js'
import { LinearTaskImporter } from './services/linear-task-importer.js'
import { PrWatcher } from './services/pr-watcher.js'
import { PrdStorageService } from './services/prd-storage-service.js'
import { ProjectRegistry } from './services/project-registry.js'
import { RepositoryIdentity } from './services/repository-identity.js'
import { RepositoryWatchCoordinator } from './services/repository-watch-coordinator.js'
import { ReviewCommentFetcher } from './services/review-comment-fetcher.js'
import { SandboxProvider } from './services/sandbox-provider.js'
import { SandboxProviderRoutedLayer } from './services/sandbox-provider-router.js'
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
 * Deferred Group 1a — services depending on LaborerStore + leaf layers.
 * Does NOT include WorktreeReconciler because it needs SandboxProvider,
 * which is built in Group 1b after ContainerService is available.
 */
const DeferredGroup1aLayers = Layer.mergeAll(
  TaskManager.layer,
  BranchStateTracker.layer,
  ContainerService.layer,
  PrdStorageService.layer,
  FileService.layer,
  PrWatcher.layer
)

/**
 * Deferred Group 1b — adds SandboxProvider (routed between Docker and
 * Daytona) on top of Group 1a, then builds WorktreeReconciler which
 * needs SandboxProvider for sandbox cleanup when removing stale
 * workspaces.
 */
const DeferredGroup1Layers = WorktreeReconciler.layer.pipe(
  Layer.provideMerge(SandboxProviderRoutedLayer),
  Layer.provideMerge(DeferredGroup1aLayers)
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
 *
 * `SandboxProvider` is already in the stack from Group 1b
 * (via `SandboxProviderRoutedLayer`), so `WorkspaceProvider.layer`
 * can consume it directly.
 */
const DeferredServiceStack = WorkspaceProvider.layer.pipe(
  Layer.provideMerge(ProjectRegistry.layer),
  Layer.provideMerge(DeferredGroup2Layers),
  Layer.provideMerge(DeferredGroup1WithSync)
)

/**
 * Top-level deferred services that depend on the full stack.
 */
// TerminalClient is built independently (doesn't depend on the service stack).
// McpRegistrar is built inside the service stack fiber (depends on
// ProjectRegistry + WorkspaceProvider from the stack).

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
// NOTE: DeferredServicesLive is built in separate groups inside the
// deferred init fiber (see DeferredServicesProxyLive) to isolate which
// layer hangs during initialization. The groups are:
// 1. DeferredLeafLayers + FileWatcherRpcPortLive
// 2. DeferredServiceStack (depends on leaf layers)
// 3. DeferredTopLayers + TerminalRpcPortLive (depends on stack)

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
    const fileService = yield* makeRefDelegatingService(FileService, {
      // FileService.watcherSubscribe returns a Stream, not an Effect.
      watcherSubscribe: () =>
        Stream.fail(serviceInitializingError('@laborer/FileService')),
    })
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
    const sandboxProvider = yield* makeRefDelegatingService(SandboxProvider, {
      // sandbox.providerStatus has no error channel — return valid placeholder
      checkAvailability: () => Effect.succeed({ available: false }),
    })

    // --- Fork background fiber to build real services ---

    yield* Effect.gen(function* () {
      yield* Effect.logInfo(
        'Starting background initialization of deferred services...'
      )

      // Capture current service instances and provide them explicitly
      // to DeferredServicesLive. When running inside a memoized layer,
      // the forked fiber may not have all dependencies in its inherited
      // context (Layer.memoize isolates the build scope).
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

      // Build each layer group separately to identify hangs.
      yield* Effect.logInfo('[deferred-init] Building leaf layers...')
      const leafCtx = yield* Layer.build(
        provideUtilityPortLayers(DeferredLeafLayers).pipe(
          Layer.provide(CoreDeps)
        )
      )
      yield* Effect.logInfo('[deferred-init] Leaf layers built OK')

      // Build service stack and top layers as independent fibers.
      // Each group swaps its Refs immediately upon completion, so a
      // hang in one group (e.g., FileWatcherClient in the service stack)
      // doesn't block other groups (e.g., TerminalClient in top layers).

      // Fork: Service stack (may hang on FileWatcherClient)
      const stackFiber = yield* Effect.gen(function* () {
        yield* Effect.logInfo('[deferred-init] Building service stack...')
        const stackCtx = yield* Layer.build(
          DeferredServiceStack.pipe(
            Layer.provide(Layer.succeedContext(leafCtx)),
            Layer.provide(CoreDeps),
            // SandboxProviderRoutedLayer needs TerminalClient — provide
            // the deferred proxy so the real implementation is swapped in
            // when the terminal fiber completes.
            Layer.provide(Layer.succeed(TerminalClient, terminalClient.proxy))
          )
        )
        yield* Effect.logInfo(
          '[deferred-init] Service stack built OK — swapping Refs'
        )
        yield* Ref.set(
          containerService.ref,
          Context.get(stackCtx, ContainerService)
        )
        yield* Ref.set(fileService.ref, Context.get(stackCtx, FileService))
        yield* Ref.set(
          githubTaskImporter.ref,
          Context.get(stackCtx, GithubTaskImporter)
        )
        yield* Ref.set(
          linearTaskImporter.ref,
          Context.get(stackCtx, LinearTaskImporter)
        )
        yield* Ref.set(prWatcher.ref, Context.get(stackCtx, PrWatcher))
        yield* Ref.set(
          prdStorageService.ref,
          Context.get(stackCtx, PrdStorageService)
        )
        yield* Ref.set(
          projectRegistry.ref,
          Context.get(stackCtx, ProjectRegistry)
        )
        yield* Ref.set(
          reviewCommentFetcher.ref,
          Context.get(stackCtx, ReviewCommentFetcher)
        )
        yield* Ref.set(taskManager.ref, Context.get(stackCtx, TaskManager))
        yield* Ref.set(
          workspaceProvider.ref,
          Context.get(stackCtx, WorkspaceProvider)
        )
        yield* Ref.set(
          workspaceSyncService.ref,
          Context.get(stackCtx, WorkspaceSyncService)
        )
        yield* Ref.set(
          sandboxProvider.ref,
          Context.get(stackCtx, SandboxProvider)
        )

        // TODO: Build McpRegistrar after stack is ready (needs
        // ProjectRegistry + WorkspaceProvider from the stack context)
      }).pipe(
        Effect.catchAllCause((cause) =>
          Effect.logError('[deferred-init] Service stack init failed', cause)
        ),
        Effect.forkScoped
      )

      // Fork: TerminalClient — built independently so it's available even
      // if the FileWatcherClient (in the service stack) hangs.
      // TerminalClient.layer needs WorkspaceProvider + ProjectRegistry at
      // construction time, so we provide the deferred proxies here. When
      // spawnInWorkspace is actually called, the real implementations
      // should be swapped in from the service stack fiber.
      const terminalFiber = yield* Effect.gen(function* () {
        yield* Effect.logInfo('[deferred-init] Building TerminalClient...')
        const termCtx = yield* Layer.build(
          provideUtilityPortLayers(TerminalClient.layer).pipe(
            Layer.provide(CoreDeps),
            Layer.provide(
              Layer.succeed(WorkspaceProvider, workspaceProvider.proxy)
            ),
            Layer.provide(
              Layer.succeed(ProjectRegistry, projectRegistry.proxy)
            ),
            Layer.provide(Layer.succeed(SandboxProvider, sandboxProvider.proxy))
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

      // Leaf-layer Refs are swapped immediately (they're already built)
      yield* Ref.set(dockerDetection.ref, Context.get(leafCtx, DockerDetection))
      yield* Ref.set(
        depsImageService.ref,
        Context.get(leafCtx, DepsImageService)
      )

      // Wait for both forked groups to complete, then mark all deferred
      // services as ready. This unblocks `lifecycle.initStatus` which
      // returns `{ ready: true }`, allowing the client to advance to
      // LifecyclePhase.Eventually and show the file tree, review pane,
      // and other gated features.
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

    // Return context with all 15 proxies
    return pipe(
      Context.empty(),
      Context.add(ContainerService, containerService.proxy),
      Context.add(FileService, fileService.proxy),
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
      Context.add(DepsImageService, depsImageService.proxy),
      Context.add(SandboxProvider, sandboxProvider.proxy)
    )
  })
)

export const InfrastructureLayer = DeferredServicesProxyLive.pipe(
  Layer.provideMerge(DeferredServicesReadyLayer),
  Layer.provideMerge(ConfigService.layer),
  Layer.provideMerge(RepositoryIdentity.layer),
  Layer.provideMerge(LaborerStoreLive)
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

  // Infrastructure layer: deferred services + core services.
  // Built once and shared between the primary RPC server and any
  // additional RPC servers spawned for inter-process communication.
  // This avoids creating duplicate LaborerStoreLive instances against
  // the same SQLite database, which would cause UNIQUE constraint
  // failures in the eventlog.
  //
  // Uses `provideMerge` so core infrastructure services (LaborerStore,
  // ConfigService, DeferredServicesReady) remain in the output context.
  // LaborerRpcsLive requires these services directly in its handlers.
  // Queue for additional RPC ports arriving from the parent process.
  // Ports are pushed from the synchronous event listener and consumed
  // inside the Effect scope where the shared infrastructure is live.
  const additionalPortQueue: RpcMessagePort[] = []
  let additionalPortHandler: ((port: RpcMessagePort) => void) | null = null

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
  //
  // - `port`: Additional RPC port for inter-process communication.
  //   Serves `LaborerRpcs` on the shared context (same LaborerStore,
  //   same deferred services) via a new MessagePort. Used by MCP
  //   utility process to call server RPCs via MessagePort.
  //   @see Issue #15: MCP as utility process
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
    } else if (
      data?.type === 'daytona-terminal-data-port' &&
      typeof (data as { terminalId?: string }).terminalId === 'string' &&
      event.ports.length > 0
    ) {
      // Daytona terminal data port — bridge MessagePort to Daytona PTY.
      // The server process manages Daytona PTY WebSocket connections
      // (via DaytonaSandboxProvider), so data ports for Daytona terminals
      // are routed here instead of to the terminal utility process.
      //
      // @see Issue #17: Daytona PTY — bridge to xterm.js terminal component
      const dataPort = event.ports[0] as RpcMessagePort
      const { terminalId } = data as { terminalId: string }
      dataPort.start?.()
      console.log(
        `[server-utility] Received Daytona terminal data port for terminal "${terminalId}"`
      )
      handleDaytonaTerminalDataPort(dataPort, terminalId)
    } else if (data?.type === 'port' && event.ports.length > 0) {
      // Additional RPC port — serve LaborerRpcs on it.
      // This enables other utility processes (e.g., MCP) to call
      // server RPCs via a direct MessagePort instead of HTTP.
      const additionalRpcPort = event.ports[0] as RpcMessagePort
      additionalRpcPort.start?.()
      console.log(
        '[server-utility] Serving LaborerRpcs on additional port (inter-process)'
      )
      // Dispatch to the Effect runtime where shared infrastructure is
      // live, or buffer if the runtime isn't ready yet.
      if (additionalPortHandler) {
        additionalPortHandler(additionalRpcPort)
      } else {
        additionalPortQueue.push(additionalRpcPort)
      }
    }
  })

  // Launch the primary RPC server and handle additional ports within
  // a single Effect scope. The infrastructure layer (LaborerStore,
  // deferred services, config) is memoized by Effect, so the primary
  // server and all additional RPC servers share the same instances.
  const program = Effect.gen(function* () {
    // Memoize the infrastructure layer so it's built once and shared.
    const MemoizedInfra = yield* Layer.memoize(InfrastructureLayer)

    // Launch the primary RPC server.
    yield* RpcLive.pipe(
      Layer.provide(MemoizedInfra),
      Layer.launch,
      Effect.forkScoped
    )

    // Process additional RPC ports — build an RPC server on each port
    // backed by the SAME shared infrastructure (single LaborerStore,
    // same deferred services, no duplicate SQLite connections).
    const queue = yield* Queue.unbounded<RpcMessagePort>()

    // Wire the sync event handler to the Effect queue.
    additionalPortHandler = (port) => {
      Queue.unsafeOffer(queue, port)
    }
    // Drain any ports that arrived before the runtime was ready.
    for (const buffered of additionalPortQueue) {
      yield* Queue.offer(queue, buffered)
    }

    // Process additional ports as they arrive.
    return yield* Queue.take(queue).pipe(
      Effect.flatMap((additionalRpcPort) => {
        const AdditionalRpcLive = RpcServer.layer(LaborerRpcs).pipe(
          Layer.provide(layerProtocolMessagePort(additionalRpcPort)),
          Layer.provide(LaborerRpcsLive),
          Layer.provide(MemoizedInfra)
        )
        return AdditionalRpcLive.pipe(Layer.launch, Effect.forkScoped)
      }),
      Effect.forever
    )
  }).pipe(Effect.scoped)

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
