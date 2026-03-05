/**
 * Laborer Terminal Service — Entry Point
 *
 * Standalone Bun server for terminal management. Runs as its own
 * long-lived process on TERMINAL_PORT (default 3001), separate from
 * the main laborer server. This architectural separation ensures
 * terminals survive server restarts during development.
 *
 * Architecture:
 * - BunRuntime.runMain handles graceful shutdown (SIGINT/SIGTERM)
 * - Layer.launch keeps the server running until interrupted
 * - HttpRouter.Default.serve() creates the HTTP handler
 * - GET / returns a health check response
 *
 * Future issues will add:
 * - PTY Host + PtyHostClient (Issue #136)
 * - TerminalManager (Issue #138)
 * - Terminal RPC handlers at POST /rpc (Issue #139)
 * - Terminal WebSocket route at GET /terminal (Issue #140)
 * - Terminal event stream (Issue #142)
 * - Grace period reconnection (Issue #146)
 *
 * @see PRD-terminal-extraction.md
 * @see Issue #135: Terminal package scaffold
 */

import {
	HttpMiddleware,
	HttpRouter,
	HttpServer,
	HttpServerResponse,
} from "@effect/platform";
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { env } from "@laborer/env/server";
import { Effect, Layer } from "effect";

/**
 * Health Check Route
 *
 * Returns the service identity and status. Used by the main server
 * to verify the terminal service is reachable, and by turbo dev to
 * confirm the process started successfully.
 */
const HealthRouteLive = HttpRouter.Default.use((router) =>
	router.addRoute(
		HttpRouter.makeRoute(
			"GET",
			"/",
			HttpServerResponse.json({
				status: "ok",
				name: "laborer-terminal",
				port: env.TERMINAL_PORT,
			})
		)
	)
);

/**
 * Server Layer
 *
 * Provides the Bun HTTP server on TERMINAL_PORT.
 * Port is sourced from env validation (@laborer/env/server).
 */
const ServerLive = BunHttpServer.layer({ port: env.TERMINAL_PORT });

/**
 * Application Layer
 *
 * Composes all layers into the terminal service application.
 * Currently minimal — just the health check route and HTTP server.
 * Future issues add PTY management, RPC handlers, and WebSocket routes.
 */
const HttpLive = HttpRouter.Default.serve(HttpMiddleware.logger).pipe(
	HttpServer.withLogAddress,
	Layer.provide(HealthRouteLive),
	Layer.provide(ServerLive)
);

/**
 * Main program
 *
 * Layer.launch converts the layer into an Effect that:
 * 1. Builds all layers (starting the HTTP server)
 * 2. Keeps running until interrupted
 * 3. On SIGINT/SIGTERM, tears down all layer scopes
 */
const main = HttpLive.pipe(Layer.launch, Effect.scoped);

BunRuntime.runMain(main);
