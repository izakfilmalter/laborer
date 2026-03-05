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
 * - LaborerRpcs uses layerProtocolHttp (POST /rpc) for HTTP RPC
 * - SyncWsRpc uses layerProtocolWebsocket (GET /rpc) for WebSocket sync
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
import { TerminalWsRouteLive } from "./routes/terminal-ws.js";
import { LaborerRpcsLive } from "./rpc/handlers.js";
// biome-ignore lint/style/useImportType: Value imports needed for Layer.provide
import { DiffService } from "./services/diff-service.js";
import { LaborerStoreLive } from "./services/laborer-store.js";
// biome-ignore lint/style/useImportType: Value imports needed for Layer.provide
import { PortAllocator } from "./services/port-allocator.js";
// biome-ignore lint/style/useImportType: Value imports needed for Layer.provide
import { ProjectRegistry } from "./services/project-registry.js";
// biome-ignore lint/style/useImportType: Value imports needed for Layer.provide
import { PtyHostClient } from "./services/pty-host-client.js";
import { SyncRpcLive } from "./services/sync-backend.js";
// biome-ignore lint/style/useImportType: Value imports needed for Layer.provide
import { TaskManager } from "./services/task-manager.js";
// biome-ignore lint/style/useImportType: Value imports needed for Layer.provide
import { TerminalManager } from "./services/terminal-manager.js";
// biome-ignore lint/style/useImportType: Value imports needed for Layer.provide
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
 * RPC Layer — Business RPCs over HTTP (POST /rpc)
 *
 * Creates the Effect RPC server from the LaborerRpcs group and wires
 * it to the handler implementations. Uses HTTP protocol (POST) which
 * matches the client's RpcClient.layerProtocolHttp.
 *
 * Each RPC group gets its own Protocol layer because Protocol is a
 * singleton Context.Tag — the HTTP protocol registers POST /rpc and
 * the WebSocket protocol (for sync) registers GET /rpc on the same path.
 *
 * Services required by RPC handlers are provided externally via
 * SharedServicesLive in HttpLive so that TerminalManager and PtyHostClient
 * are shared with TerminalWsRouteLive (Issue #139).
 */
const RpcLive = RpcServer.layer(LaborerRpcs).pipe(
	Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" })),
	Layer.provide(LaborerRpcsLive)
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
 * endpoints mounted at /rpc.
 *
 * Layer composition:
 *   HttpRouter.Default.serve() — serves the Default router with logging middleware
 *   + CustomRoutesLive — adds GET / to the router
 *   + TerminalWsRouteLive — adds GET /terminal WebSocket endpoint (Issue #139)
 *   + RpcLive — Laborer RPC handling (POST /rpc via layerProtocolHttp)
 *   + SyncRpcLive — LiveStore sync RPC handler (GET /rpc via layerProtocolWebsocket)
 *   + RpcSerialization.layerJson — wire format for RPC messages (JSON for sync compat)
 *   + LaborerStoreLive — LiveStore with SQLite persistence (Issue #16)
 *   + ServerLive — Bun HTTP server
 *
 * Each RPC group has its own Protocol layer: LaborerRpcs uses HTTP (POST)
 * and SyncWsRpc uses WebSocket (GET). Both register on /rpc but with
 * different HTTP methods, so they coexist on the Default router.
 *
 * TerminalWsRouteLive registers GET /terminal for WebSocket terminal I/O.
 * It shares TerminalManager and PtyHostClient with RpcLive.
 */
const HttpLive = HttpRouter.Default.serve(HttpMiddleware.logger).pipe(
	HttpServer.withLogAddress,
	// --- Route layers (consume services from below) ---
	Layer.provide(CustomRoutesLive),
	Layer.provide(TerminalWsRouteLive),
	Layer.provide(RpcLive),
	Layer.provide(SyncRpcLive),
	// --- Shared service layers (available to all route layers) ---
	// Order matters: later provides feed dependencies to earlier provides.
	Layer.provide(TaskManager.layer),
	Layer.provide(DiffService.layer),
	Layer.provide(TerminalManager.layer),
	Layer.provide(WorkspaceProvider.layer),
	Layer.provide(PtyHostClient.layer),
	Layer.provide(ProjectRegistry.layer),
	Layer.provide(PortAllocator.layer),
	// --- Infrastructure layers ---
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
