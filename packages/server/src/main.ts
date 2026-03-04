/**
 * Laborer Server — Entry Point
 *
 * Bun server running Effect TS services. Manages all side effects:
 * process spawning, PTY management, git operations, file system access,
 * and port allocation. Exposes an Effect RPC API and serves as the
 * LiveStore sync backend.
 *
 * Architecture:
 * - BunRuntime.runMain handles graceful shutdown (SIGINT/SIGTERM)
 * - Layer.launch keeps the server running until interrupted
 * - All services compose via Effect Layers
 * - HttpServer.serve creates the HTTP handler from the router
 *
 * Future issues will add:
 * - Health check RPC endpoint (Issue #12)
 * - Environment validation (Issue #15)
 * - LiveStore server adapter (Issue #16)
 * - Effect RPC router (Issue #19)
 * - Effect services (WorkspaceProvider, TerminalManager, DiffService, etc.)
 */

import {
	HttpMiddleware,
	HttpRouter,
	HttpServer,
	HttpServerResponse,
} from "@effect/platform";
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { Effect, Layer } from "effect";

/**
 * HTTP Router
 *
 * Defines all HTTP routes for the server. Currently serves a basic
 * status endpoint. Future issues will add the RPC router (Issue #19),
 * LiveStore sync WebSocket (Issue #18), and health check (Issue #12).
 */
const HttpRouterLive = HttpRouter.empty.pipe(
	HttpRouter.get(
		"/",
		HttpServerResponse.json({ status: "ok", name: "laborer-server" })
	)
);

/**
 * Server Layer
 *
 * Provides the Bun HTTP server on the configured port.
 * Port will be sourced from env validation in Issue #15.
 */
const PORT = 3000;
const ServerLive = BunHttpServer.layer({ port: PORT });

/**
 * Application Layer
 *
 * Composes all service layers into a single application layer.
 * Future services (ProjectRegistry, WorkspaceProvider, TerminalManager,
 * DiffService, PortAllocator) will be merged here as they are implemented.
 *
 * The composition pattern:
 *   AppLayer = ServiceLayers + HttpLive
 *   HttpLive = Router + Middleware + Server
 */
const HttpLive = HttpRouterLive.pipe(
	HttpServer.serve(HttpMiddleware.logger),
	HttpServer.withLogAddress,
	Layer.provide(ServerLive)
);

/**
 * Main program
 *
 * Layer.launch converts the layer into an Effect that:
 * 1. Builds all layers (starting the HTTP server)
 * 2. Keeps running until interrupted
 * 3. On SIGINT/SIGTERM, tears down all layer scopes (stopping the server)
 *
 * BunRuntime.runMain provides:
 * - SIGINT/SIGTERM signal handling → fiber interruption
 * - Automatic finalizer execution on shutdown
 * - Pretty logging
 * - Process exit code management
 */
const main = HttpLive.pipe(Layer.launch, Effect.scoped);

BunRuntime.runMain(main);
