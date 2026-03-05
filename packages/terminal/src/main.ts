/**
 * Laborer Terminal Service — Entry Point
 *
 * Standalone Bun server for terminal management. Runs as its own
 * long-lived process on TERMINAL_PORT (default 3002), separate from
 * the main laborer server. This architectural separation ensures
 * terminals survive server restarts during development.
 *
 * Architecture:
 * - BunRuntime.runMain handles graceful shutdown (SIGINT/SIGTERM)
 * - Layer.launch keeps the server running until interrupted
 * - HttpRouter.Default.serve() creates the HTTP handler
 * - GET / returns a health check response
 * - GET /terminal?id=... WebSocket endpoint for PTY I/O data channel
 * - POST /rpc serves TerminalRpcs via RpcServer.layerProtocolHttp
 * - PtyHostClient spawns and manages the PTY Host child process
 * - TerminalManager manages terminal instances in-memory
 *
 * The PTY Host (pty-host.ts) runs under Node.js as an isolated subprocess
 * that manages node-pty instances. PtyHostClient communicates with it via
 * newline-delimited JSON over stdin/stdout.
 *
 * Future issues will add:
 * - Terminal event stream (Issue #142)
 * - Grace period reconnection (Issue #146)
 *
 * @see PRD-terminal-extraction.md
 * @see Issue #135: Terminal package scaffold
 * @see Issue #136: Move PTY Host + PtyHostClient to terminal package
 * @see Issue #139: Terminal RPC handlers
 * @see Issue #140: Terminal WebSocket route
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
import { TerminalRpcs } from "@laborer/shared/rpc";
import { Effect, Layer } from "effect";
import { TerminalWsRouteLive } from "./routes/terminal-ws.js";
import { TerminalRpcsLive } from "./rpc/handlers.js";
import { PtyHostClient } from "./services/pty-host-client.js";
import { TerminalManager } from "./services/terminal-manager.js";

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
 * RPC Layer — Terminal RPCs over HTTP (POST /rpc)
 *
 * Creates the Effect RPC server from the TerminalRpcs group and wires
 * it to the handler implementations. Uses HTTP protocol (POST) matching
 * the same pattern as the main server's LaborerRpcs.
 *
 * @see Issue #139: Terminal RPC handlers
 */
const RpcLive = RpcServer.layer(TerminalRpcs).pipe(
	Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" })),
	Layer.provide(TerminalRpcsLive)
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
 * Layer composition:
 *   HttpRouter.Default.serve() — serves the Default router with logging
 *   + HealthRouteLive — adds GET / to the router
 *   + TerminalWsRouteLive — adds GET /terminal WebSocket endpoint
 *   + RpcLive — Terminal RPC handling (POST /rpc via layerProtocolHttp)
 *   + RpcSerialization.layerJson — wire format for RPC messages
 *   + TerminalManager — in-memory terminal lifecycle management
 *   + PtyHostClient — PTY Host child process management
 *   + ServerLive — Bun HTTP server
 *
 * @see Issue #139: Terminal RPC handlers
 * @see Issue #140: Terminal WebSocket route
 */
const HttpLive = HttpRouter.Default.serve(HttpMiddleware.logger).pipe(
	HttpServer.withLogAddress,
	// --- Route layers (consume services from below) ---
	Layer.provide(HealthRouteLive),
	Layer.provide(TerminalWsRouteLive),
	Layer.provide(RpcLive),
	// --- Service layers ---
	Layer.provide(TerminalManager.layer),
	Layer.provide(PtyHostClient.layer),
	// --- Infrastructure layers ---
	Layer.provide(RpcSerialization.layerJson),
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
