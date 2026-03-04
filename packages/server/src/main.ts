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
 *
 * Future issues will add:
 * - Environment validation (Issue #15)
 * - LiveStore server adapter (Issue #16)
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
import { LaborerRpcs } from "@laborer/shared/rpc";
import { Effect, Layer } from "effect";
import { LaborerRpcsLive } from "./rpc/handlers.js";

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
 */
const RpcLive = RpcServer.layer(LaborerRpcs).pipe(
	Layer.provide(LaborerRpcsLive)
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
 * The HTTP server serves both the plain HTTP routes and the RPC
 * endpoint mounted at /rpc.
 *
 * Layer composition:
 *   HttpRouter.Default.serve() — serves the Default router with logging middleware
 *   + CustomRoutesLive — adds GET / to the router
 *   + RpcLive — RPC request handling
 *   + RpcServer.layerProtocolHttp — mounts RPC at /rpc on the Default router
 *   + RpcSerialization.layerNdjson — wire format for RPC messages
 *   + ServerLive — Bun HTTP server
 */
const HttpLive = HttpRouter.Default.serve(HttpMiddleware.logger).pipe(
	HttpServer.withLogAddress,
	Layer.provide(CustomRoutesLive),
	Layer.provide(RpcLive),
	Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" })),
	Layer.provide(RpcSerialization.layerNdjson),
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
