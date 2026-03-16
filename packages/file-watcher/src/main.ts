/**
 * Laborer File Watcher Service — Entry Point
 *
 * Standalone Node.js server for filesystem watching. Runs as its own
 * long-lived process on FILE_WATCHER_PORT (default 2104), separate from
 * the main laborer server. This architectural separation ensures
 * filesystem watchers survive server restarts during development.
 *
 * Architecture:
 * - NodeRuntime.runMain handles graceful shutdown (SIGINT/SIGTERM)
 * - Layer.launch keeps the server running until interrupted
 * - HttpRouter.Default.serve() creates the HTTP handler
 * - GET / returns a health check response
 * - POST /rpc serves FileWatcherRpcs via RpcServer.layerProtocolHttp
 * - WatcherManager manages watch subscriptions in-memory
 * - FileWatcher provides the low-level fs.watch / @parcel/watcher abstraction
 *
 * @see PRD-file-watcher-extraction.md
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
import { FileWatcherRpcs } from '@laborer/shared/rpc'
import { Effect, Layer } from 'effect'
import { FileWatcherRpcsLive } from './rpc/handlers.js'
import { FileWatcher } from './services/file-watcher.js'
import { WatcherManager } from './services/watcher-manager.js'

/**
 * Health Check Route
 *
 * Returns the service identity and status. Used by the main server
 * to verify the file-watcher service is reachable, and by turbo dev
 * to confirm the process started successfully.
 */
const HealthRouteLive = HttpRouter.Default.use((router) =>
  router.addRoute(
    HttpRouter.makeRoute(
      'GET',
      '/',
      HttpServerResponse.json({
        status: 'ok',
        name: 'laborer-file-watcher',
        port: env.FILE_WATCHER_PORT,
      })
    )
  )
)

/**
 * RPC Layer — File Watcher RPCs over HTTP (POST /rpc)
 *
 * Creates the Effect RPC server from the FileWatcherRpcs group and wires
 * it to the handler implementations. Uses HTTP protocol (POST) matching
 * the same pattern as the main server's LaborerRpcs.
 */
const RpcLive = RpcServer.layer(FileWatcherRpcs).pipe(
  Layer.provide(RpcServer.layerProtocolHttp({ path: '/rpc' })),
  Layer.provide(FileWatcherRpcsLive)
)

/**
 * Server Layer
 *
 * Provides the Node.js HTTP server on FILE_WATCHER_PORT.
 * Port is sourced from env validation (@laborer/env/server).
 */
const ServerLive = NodeHttpServer.layer(createServer, {
  port: env.FILE_WATCHER_PORT,
})

/**
 * Application Layer
 *
 * Composes all layers into the file-watcher service application.
 * Layer composition:
 *   HttpRouter.Default.serve() — serves the Default router with logging
 *   + HealthRouteLive — adds GET / to the router
 *   + RpcLive — File Watcher RPC handling (POST /rpc via layerProtocolHttp)
 *   + RpcSerialization.layerJson — wire format for RPC messages
 *   + WatcherManager — in-memory subscription lifecycle management
 *   + FileWatcher — low-level filesystem watcher abstraction
 *   + ServerLive — Node.js HTTP server
 */
const HttpLive = HttpRouter.Default.serve((httpApp) =>
  HttpMiddleware.logger(HttpMiddleware.cors()(httpApp))
).pipe(
  HttpServer.withLogAddress,
  // --- Route layers (consume services from below) ---
  Layer.provide(HealthRouteLive),
  Layer.provide(RpcLive),
  // --- Service layers ---
  Layer.provide(WatcherManager.layer),
  Layer.provide(FileWatcher.layer),
  // --- Infrastructure layers ---
  Layer.provide(RpcSerialization.layerJson),
  Layer.provide(ServerLive)
)

/**
 * Main program
 *
 * Layer.launch converts the layer into an Effect that:
 * 1. Builds all layers (starting the HTTP server + watchers)
 * 2. Keeps running until interrupted
 * 3. On SIGINT/SIGTERM, tears down all layer scopes (closes watchers)
 */
const main = HttpLive.pipe(Layer.launch, Effect.scoped)

NodeRuntime.runMain(main)
