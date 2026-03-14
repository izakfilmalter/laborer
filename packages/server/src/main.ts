/**
 * Laborer Server — Entry Point
 *
 * Node.js server running Effect TS services. Manages all side effects:
 * git operations, file system access, port allocation, and delegates
 * terminal operations to the standalone terminal service.
 *
 * Architecture:
 * - NodeRuntime.runMain handles graceful shutdown (SIGINT/SIGTERM)
 * - Layer.launch keeps the server running until interrupted
 * - All services compose via Effect Layers
 * - HttpRouter.Default.serve() creates the HTTP handler from the Default router tag
 * - LaborerRpcs uses layerProtocolHttp (POST /rpc) for HTTP RPC
 * - SyncWsRpc uses layerProtocolWebsocket (GET /rpc) for WebSocket sync
 * - Terminal operations delegated to standalone terminal service via TerminalClient (Issue #143)
 * - Environment variables validated at import time via @laborer/env/server
 *
 * Layer composition is organized into core and deferred groups
 * (Phased Service Lifecycle — Issue #13):
 *
 *   Core layers: HTTP server, health endpoint, LiveStore sync, RPC
 *   handler registration, ConfigService, RepositoryIdentity. These
 *   are stateless or fast-building layers needed for the health
 *   endpoint to respond.
 *
 *   Deferred layers: Docker detection, sidecar connections, PR watchers,
 *   task importers, workspace management, and other services that
 *   involve I/O, external connections, or heavy initialization.
 *
 *   Both groups are composed into a single layer graph because
 *   LaborerRpcsLive captures handler service requirements at the
 *   type level. The separation is structural — making it clear which
 *   layers are core vs deferred for future optimization (Issue #14:
 *   background initialization, Issue #16: lazy sidecar connections).
 */

import { createServer } from 'node:http'
import {
  HttpMiddleware,
  HttpRouter,
  HttpServer,
  HttpServerResponse,
} from '@effect/platform'
import { NodeHttpServer, NodeRuntime } from '@effect/platform-node'
import { RpcSerialization, RpcServer } from '@effect/rpc'
import { env } from '@laborer/env/server'
import { LaborerRpcs } from '@laborer/shared/rpc'
import { Cause, Effect, Exit, Layer } from 'effect'
import { LaborerRpcsLive } from './rpc/handlers.js'
import { BackgroundFetchService } from './services/background-fetch-service.js'
import { BranchStateTracker } from './services/branch-state-tracker.js'
import { ConfigService } from './services/config-service.js'
import { ContainerService } from './services/container-service.js'
import { DepsImageService } from './services/deps-image-service.js'
import { DiffService } from './services/diff-service.js'
import { DockerDetection } from './services/docker-detection.js'
import { FileWatcherClient } from './services/file-watcher-client.js'
import { GithubTaskImporter } from './services/github-task-importer.js'
import { LaborerStoreLive } from './services/laborer-store.js'
import { LinearTaskImporter } from './services/linear-task-importer.js'
import { McpRegistrar } from './services/mcp-registrar.js'
import { PortAllocator } from './services/port-allocator.js'
import { PrWatcher } from './services/pr-watcher.js'
import { PrdStorageService } from './services/prd-storage-service.js'
import { ProjectRegistry } from './services/project-registry.js'
import { RepositoryIdentity } from './services/repository-identity.js'
import { RepositoryWatchCoordinator } from './services/repository-watch-coordinator.js'
import { ReviewCommentFetcher } from './services/review-comment-fetcher.js'
import { SyncRpcLive } from './services/sync-backend.js'
import { TaskManager } from './services/task-manager.js'
import { TerminalClient } from './services/terminal-client.js'
import { WorkspaceProvider } from './services/workspace-provider.js'
import { WorkspaceSyncService } from './services/workspace-sync-service.js'
import { WorktreeDetector } from './services/worktree-detector.js'
import { WorktreeReconciler } from './services/worktree-reconciler.js'

// ---------------------------------------------------------------------------
// Custom HTTP Routes
// ---------------------------------------------------------------------------

/**
 * Adds non-RPC HTTP routes to the Default router.
 * The root endpoint returns a basic server identity response used as
 * the health check by sidecar status polling.
 */
const CustomRoutesLive = HttpRouter.Default.use((router) =>
  router.addRoute(
    HttpRouter.makeRoute(
      'GET',
      '/',
      HttpServerResponse.json({
        status: 'ok',
        name: 'laborer-server',
      })
    )
  )
)

/**
 * RPC Layer — Business RPCs over HTTP (POST /rpc)
 *
 * Creates the Effect RPC server from the LaborerRpcs group and wires
 * it to the handler implementations. Uses HTTP protocol (POST) which
 * matches the client's RpcClient.layerProtocolHttp.
 *
 * Note: LaborerRpcsLive captures all handler service dependencies at
 * the type level (via `yield* ServiceTag` in handlers). All services
 * must be provided in the layer graph, even though they're only
 * resolved at handler invocation time.
 */
const RpcLive = RpcServer.layer(LaborerRpcs).pipe(
  Layer.provide(RpcServer.layerProtocolHttp({ path: '/rpc' })),
  Layer.provide(LaborerRpcsLive)
)

/**
 * Server Layer — Node.js HTTP server on the configured port.
 */
const ServerLive = NodeHttpServer.layer(createServer, { port: env.PORT })

// ---------------------------------------------------------------------------
// Core Layers (fast-building, needed for health endpoint)
// ---------------------------------------------------------------------------

/**
 * Core layers build before the health endpoint responds.
 *
 * These are stateless or fast-initializing services:
 *   - ServerLive — Node.js HTTP server binding
 *   - LaborerStoreLive — LiveStore with SQLite persistence
 *   - SyncRpcLive — LiveStore WebSocket sync endpoint (GET /rpc)
 *   - RpcLive — Business RPC endpoint (POST /rpc, handlers defined)
 *   - RpcSerialization.layerJson — JSON wire format
 *   - CustomRoutesLive — Health check endpoint (GET /)
 *   - ConfigService — Configuration resolution (Layer.succeed, pure)
 *   - RepositoryIdentity — Git repository identification (leaf)
 *
 * @see PRD section: "Server Layer Graph Splitting" (core layers list)
 */

// ---------------------------------------------------------------------------
// Deferred Layers (heavy I/O, external connections, background services)
// ---------------------------------------------------------------------------

/**
 * Deferred Leaf Layers — no inter-service dependencies but run I/O
 * that can block (Docker CLI, sidecar connections, git commands, ports).
 */
const DeferredLeafLayers = Layer.mergeAll(
  FileWatcherClient.layer,
  WorktreeDetector.layer,
  DepsImageService.layer,
  DockerDetection.layer,
  PortAllocator.layer
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
 * @see PRD section: "Server Layer Graph Splitting" (deferred layers list)
 */
const DeferredServicesLive = DeferredTopLayers.pipe(
  Layer.provideMerge(DeferredServiceStack),
  Layer.provideMerge(DeferredLeafLayers)
)

// ---------------------------------------------------------------------------
// Application Layer — Core + Deferred composed
// ---------------------------------------------------------------------------

/**
 * Application Layer
 *
 * Composes route layers with all service layers. The layer graph is
 * organized into core and deferred groups for clarity, but built as
 * a single composition because LaborerRpcsLive captures handler
 * service requirements at the type level.
 *
 * Core layers (fast-building):
 *   CustomRoutesLive, RpcLive, SyncRpcLive, ConfigService,
 *   RepositoryIdentity, RpcSerialization, LaborerStoreLive, ServerLive
 *
 * Deferred layers (heavy I/O, external connections):
 *   All remaining ~20 services (see DeferredServicesLive)
 *
 * Future optimization (Issue #14): Deferred services will be wrapped
 * in background-initializing layers that return placeholder
 * implementations immediately, allowing the health endpoint to
 * respond before all services finish building.
 */
const HttpLive = HttpRouter.Default.serve((httpApp) =>
  HttpMiddleware.logger(HttpMiddleware.cors()(httpApp))
).pipe(
  HttpServer.withLogAddress,
  // --- Route layers (consume services from below) ---
  Layer.provide(CustomRoutesLive),
  Layer.provide(RpcLive),
  Layer.provide(SyncRpcLive),
  // --- Deferred service layers (heavy I/O, external connections) ---
  Layer.provide(DeferredServicesLive),
  // --- Core infrastructure layers (fast-building) ---
  Layer.provide(ConfigService.layer),
  Layer.provide(RepositoryIdentity.layer),
  Layer.provide(RpcSerialization.layerJson),
  Layer.provide(LaborerStoreLive),
  Layer.provide(ServerLive)
)

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

/**
 * Shutdown Timeout Teardown
 *
 * During dev restarts (tsx --watch sends SIGTERM), the graceful shutdown
 * can hang due to circular WebSocket connections (LaborerStore connects
 * to its own sync backend via makeWsSync). When the HTTP server begins
 * closing, the WebSocket drops and the sync client retries indefinitely,
 * creating a deadlock where scope teardown never completes.
 *
 * This custom teardown forces process.exit after a timeout if graceful
 * shutdown doesn't complete, ensuring tsx --watch can restart cleanly.
 */
const SHUTDOWN_TIMEOUT_MS = 3000

const exitCode = <E, A>(exit: Exit.Exit<A, E>): number =>
  Exit.isFailure(exit) && !Cause.isInterruptedOnly(exit.cause) ? 1 : 0

const teardownWithTimeout = <E, A>(
  exit: Exit.Exit<A, E>,
  onExit: (code: number) => void
): void => {
  const timer = setTimeout(() => {
    process.exit(exitCode(exit))
  }, SHUTDOWN_TIMEOUT_MS)
  timer.unref()
  onExit(exitCode(exit))
}

// ---------------------------------------------------------------------------
// Main Program
// ---------------------------------------------------------------------------

/**
 * Main program
 *
 * Layer.launch converts the layer into an Effect that:
 * 1. Builds all layers (starting the HTTP server + RPC)
 * 2. Keeps running until interrupted
 * 3. On SIGINT/SIGTERM, tears down all layer scopes
 *
 * The layer composition clearly separates core from deferred layers
 * (see HttpLive). Issue #14 will add background initialization for
 * deferred layers so the health endpoint responds before they finish.
 */
const main = HttpLive.pipe(Layer.launch, Effect.scoped)

NodeRuntime.runMain(main, { teardown: teardownWithTimeout })
