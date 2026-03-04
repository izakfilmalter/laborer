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
 * - HttpRouter.Default.serve() creates the HTTP handler from the Default router tag
 * - RpcServer.layerProtocolHttp mounts RPC at /rpc on the Default router
 * - Environment variables validated at import time via @laborer/env/server
 *
 * Future issues will add:
 * - Full RPC router with real service implementations (Issue #19+)
 */

import {
	HttpMiddleware,
	HttpRouter,
	HttpServer,
	HttpServerResponse,
} from "@effect/platform";
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { RpcSerialization, RpcServer } from "@effect/rpc";
import { env } from "@laborer/env/server";
import { LaborerRpcs } from "@laborer/shared/rpc";
import { Effect, Layer } from "effect";
import { LaborerRpcsLive } from "./rpc/handlers.js";
import { LaborerStoreLive } from "./services/laborer-store.js";
import { PortAllocator } from "./services/port-allocator.js";
import { ProjectRegistry } from "./services/project-registry.js";
import { SyncRpcLive } from "./services/sync-backend.js";
import { TerminalManager } from "./services/terminal-manager.js";
import { WorkspaceProvider } from "./services/workspace-provider.js";

/**
 * Custom HTTP Routes
 *
 * Adds non-RPC HTTP routes to the Default router.
 * The root endpoint returns a basic server identity response.
 */
const CustomRoutesLive = HttpRouter.Default.use((router) =>
	router.addRoute(
		HttpRouter.makeRoute(
			"GET",
			"/",
			HttpServerResponse.json({
				status: "ok",
				name: "laborer-server",
			})
		)
	)
);

/**
 * RPC Layer
 *
 * Creates the Effect RPC server from the LaborerRpcs group and wires
 * it to the handler implementations. RpcServer.layer creates a fiber
 * that processes incoming RPC requests and dispatches them to handlers.
 *
 * Services required by RPC handlers are provided here:
 * - ProjectRegistry (Issue #21)
 * - PortAllocator (Issue #29)
 * - WorkspaceProvider (Issue #33)
 * - TerminalManager (Issue #50)
 */
const RpcLive = RpcServer.layer(LaborerRpcs).pipe(
	Layer.provide(LaborerRpcsLive),
	Layer.provide(TerminalManager.layer),
	Layer.provide(WorkspaceProvider.layer),
	Layer.provide(ProjectRegistry.layer),
	Layer.provide(PortAllocator.layer)
);

/**
 * Server Layer
 *
 * Provides the Bun HTTP server on the configured port.
 * Port is sourced from env validation (@laborer/env/server).
 * If the PORT env var is invalid, the server fails to start
 * at import time with a descriptive error.
 */
const ServerLive = BunHttpServer.layer({ port: env.PORT });

/**
 * Application Layer
 *
 * Composes all service layers into a single application layer.
 * The HTTP server serves both the plain HTTP routes and the RPC
 * endpoint mounted at /rpc.
 *
 * Layer composition:
 *   HttpRouter.Default.serve() — serves the Default router with logging middleware
 *   + CustomRoutesLive — adds GET / to the router
 *   + RpcLive — Laborer RPC request handling
 *   + SyncRpcLive — LiveStore sync RPC handler (Issue #18)
 *   + RpcServer.layerProtocolHttp — mounts both RPC groups on the Default router
 *   + RpcSerialization.layerJson — wire format for RPC messages (JSON for sync compat)
 *   + LaborerStoreLive — LiveStore with SQLite persistence (Issue #16)
 *   + ServerLive — Bun HTTP server
 *
 * Note: Both LaborerRpcs and SyncWsRpc share a single protocol layer at /rpc.
 * The sync client from @livestore/sync-cf/client connects via WebSocket to /rpc.
 * Effect RPC routes each request to the correct handler based on the RPC tag name.
 */
const HttpLive = HttpRouter.Default.serve(HttpMiddleware.logger).pipe(
	HttpServer.withLogAddress,
	Layer.provide(CustomRoutesLive),
	Layer.provide(RpcLive),
	Layer.provide(SyncRpcLive),
	Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" })),
	Layer.provide(RpcSerialization.layerJson),
	Layer.provide(LaborerStoreLive),
	Layer.provide(ServerLive)
);

/**
 * Main program
 *
 * Layer.launch converts the layer into an Effect that:
 * 1. Builds all layers (starting the HTTP server + RPC)
 * 2. Keeps running until interrupted
 * 3. On SIGINT/SIGTERM, tears down all layer scopes
 *
 * BunRuntime.runMain provides:
 * - SIGINT/SIGTERM signal handling → fiber interruption
 * - Automatic finalizer execution on shutdown
 * - Pretty logging
 * - Process exit code management
 */
const main = HttpLive.pipe(Layer.launch, Effect.scoped);

BunRuntime.runMain(main);
