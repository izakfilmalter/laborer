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
 * - PtyHostClient spawns and manages the PTY Host child process
 *
 * The PTY Host (pty-host.ts) runs under Node.js as an isolated subprocess
 * that manages node-pty instances. PtyHostClient communicates with it via
 * newline-delimited JSON over stdin/stdout.
 *
 * Future issues will add:
 * - TerminalManager (Issue #138)
 * - Terminal RPC handlers at POST /rpc (Issue #139)
 * - Terminal WebSocket route at GET /terminal (Issue #140)
 * - Terminal event stream (Issue #142)
 * - Grace period reconnection (Issue #146)
 *
 * @see PRD-terminal-extraction.md
 * @see Issue #135: Terminal package scaffold
 * @see Issue #136: Move PTY Host + PtyHostClient to terminal package
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
import { PtyHostClient } from "./services/pty-host-client.js";

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
 * PtyHostClient is wired into the layer tree so it spawns the PTY Host
 * child process on startup and kills it on shutdown.
 *
 * Future issues add TerminalManager, RPC handlers, and WebSocket routes
 * that depend on PtyHostClient.
 */
const HttpLive = HttpRouter.Default.serve(HttpMiddleware.logger).pipe(
	HttpServer.withLogAddress,
	Layer.provide(HealthRouteLive),
	// --- Service layers ---
	Layer.provide(PtyHostClient.layer),
	// --- Infrastructure layers ---
	Layer.provide(ServerLive)
);

/**
 * Main program
 *
 * Layer.launch converts the layer into an Effect that:
 * 1. Builds all layers (starting the HTTP server + PTY Host)
 * 2. Keeps running until interrupted
 * 3. On SIGINT/SIGTERM, tears down all layer scopes (kills PTY Host)
 */
const main = HttpLive.pipe(Layer.launch, Effect.scoped);

BunRuntime.runMain(main);
