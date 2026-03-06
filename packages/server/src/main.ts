/**
 * Laborer Server — Entry Point
 *
 * Bun server running Effect TS services. Manages all side effects:
 * git operations, file system access, port allocation, and delegates
 * terminal operations to the standalone terminal service.
 *
 * Architecture:
 * - BunRuntime.runMain handles graceful shutdown (SIGINT/SIGTERM)
 * - Layer.launch keeps the server running until interrupted
 * - All services compose via Effect Layers
 * - HttpRouter.Default.serve() creates the HTTP handler from the Default router tag
 * - LaborerRpcs uses layerProtocolHttp (POST /rpc) for HTTP RPC
 * - SyncWsRpc uses layerProtocolWebsocket (GET /rpc) for WebSocket sync
 * - Terminal operations delegated to standalone terminal service via TerminalClient (Issue #143)
 * - Environment variables validated at import time via @laborer/env/server
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
import { ConfigService } from "./services/config-service.js";
import { DiffService } from "./services/diff-service.js";
import { GithubTaskImporter } from "./services/github-task-importer.js";
import { LaborerStoreLive } from "./services/laborer-store.js";
import { LinearTaskImporter } from "./services/linear-task-importer.js";
import { McpRegistrar } from "./services/mcp-registrar.js";
import { PortAllocator } from "./services/port-allocator.js";
import { PrdStorageService } from "./services/prd-storage-service.js";
import { PrdTaskImporter } from "./services/prd-task-importer.js";
import { ProjectRegistry } from "./services/project-registry.js";
import { SyncRpcLive } from "./services/sync-backend.js";
import { TaskManager } from "./services/task-manager.js";
import { TerminalClient } from "./services/terminal-client.js";
import { WorkspaceProvider } from "./services/workspace-provider.js";
import { WorktreeDetector } from "./services/worktree-detector.js";
import { WorktreeReconciler } from "./services/worktree-reconciler.js";
import { WorktreeWatcher } from "./services/worktree-watcher.js";

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
 */
const RpcLive = RpcServer.layer(LaborerRpcs).pipe(
	Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" })),
	Layer.provide(LaborerRpcsLive)
);

/**
 * Server Layer
 *
 * Provides the Bun HTTP server on the configured port.
 */
const ServerLive = BunHttpServer.layer({ port: env.PORT });

/**
 * Application Layer
 *
 * Composes all service layers into a single application layer.
 *
 * Layer composition:
 *   HttpRouter.Default.serve() — serves the Default router with logging middleware
 *   + CustomRoutesLive — adds GET / to the router
 *   + RpcLive — Laborer RPC handling (POST /rpc via layerProtocolHttp)
 *   + SyncRpcLive — LiveStore sync RPC handler (GET /rpc via layerProtocolWebsocket)
 *   + RpcSerialization.layerJson — wire format for RPC messages
 *   + LaborerStoreLive — LiveStore with SQLite persistence
 *   + ServerLive — Bun HTTP server
 *
 * Issue #143: TerminalManager, PtyHostClient, and TerminalWsRouteLive removed.
 * Terminal operations are delegated to the standalone terminal service via
 * TerminalClient, which connects over Effect RPC HTTP.
 */
const HttpLiveBase = HttpRouter.Default.serve(HttpMiddleware.logger).pipe(
	HttpServer.withLogAddress,
	// --- Route layers (consume services from below) ---
	Layer.provide(CustomRoutesLive),
	Layer.provide(RpcLive),
	Layer.provide(SyncRpcLive),
	// --- Shared service layers (available to all route layers) ---
	Layer.provide(PrdTaskImporter.layer),
	Layer.provide(LinearTaskImporter.layer),
	Layer.provide(GithubTaskImporter.layer),
	Layer.provide(TaskManager.layer),
	Layer.provide(PrdStorageService.layer),
	Layer.provide(DiffService.layer),
	Layer.provide(TerminalClient.layer),
	Layer.provide(WorkspaceProvider.layer),
	Layer.provide(ConfigService.layer),
	Layer.provide(McpRegistrar.layer),
	Layer.provide(ProjectRegistry.layer)
);

const HttpLive = HttpLiveBase.pipe(
	Layer.provide(WorktreeWatcher.layer),
	Layer.provide(WorktreeReconciler.layer),
	Layer.provide(WorktreeDetector.layer),
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
 */
const main = HttpLive.pipe(Layer.launch, Effect.scoped);

BunRuntime.runMain(main);
