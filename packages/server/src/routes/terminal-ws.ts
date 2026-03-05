/**
 * Terminal WebSocket Route — Dedicated terminal data channel
 *
 * Provides a `GET /terminal?id=<terminalId>` endpoint that upgrades to
 * a WebSocket connection for streaming terminal I/O. This bypasses the
 * LiveStore event path for terminal output data, providing a direct,
 * low-latency WebSocket channel.
 *
 * Protocol:
 * - Server → Client: Raw UTF-8 terminal output as text frames
 * - Client → Server: Raw terminal input (keystrokes) as text frames,
 *   or JSON control messages (e.g., `{"type":"ack","chars":5000}` for
 *   flow control — Issue #141)
 *
 * Connection lifecycle:
 * 1. Client connects with `?id=<terminalId>`
 * 2. Server validates terminal exists
 * 3. Server sends ring buffer scrollback as initial text frame(s)
 * 4. Server subscribes to live output and forwards as text frames
 * 5. Client text frames are forwarded to PTY as input
 * 6. On disconnect: server unsubscribes, cleans up
 *
 * @see PRD-terminal-perf.md — "Dedicated Terminal WebSocket Endpoint"
 * @see Issue #139
 */

import {
	HttpRouter,
	HttpServerRequest,
	HttpServerResponse,
	type Socket,
} from "@effect/platform";
import { Effect, Exit, type Layer, Runtime, Scope } from "effect";
import { PtyHostClient } from "../services/pty-host-client.js";
import { TerminalManager } from "../services/terminal-manager.js";

/**
 * Maximum size (in characters) for a single scrollback text frame.
 * Large scrollback buffers are split into chunks to avoid overwhelming
 * the WebSocket send buffer.
 */
const SCROLLBACK_CHUNK_SIZE = 64_000;

/**
 * Handle incoming WebSocket messages from the client.
 * Text frames are forwarded to the PTY as input, except for
 * JSON control messages (ack — Issue #141).
 */
const handleClientMessage = (
	ptyWrite: (id: string, data: string) => void,
	ptyAck: (id: string, chars: number) => void,
	terminalId: string,
	data: string | Uint8Array
): void => {
	if (typeof data !== "string") {
		return;
	}

	// Detect JSON control messages (ack for flow control — Issue #141)
	if (data.length > 0 && data[0] === "{" && data.endsWith("}")) {
		try {
			const parsed = JSON.parse(data) as { chars?: number; type?: string };
			if (parsed.type === "ack" && typeof parsed.chars === "number") {
				// Forward flow control ack to PTY host (Issue #141)
				ptyAck(terminalId, parsed.chars);
				return;
			}
		} catch {
			// Not valid JSON — treat as terminal input
		}
	}

	ptyWrite(terminalId, data);
};

/**
 * Send scrollback data to the client via the write function.
 * Large buffers are split into chunks to avoid overwhelming the
 * WebSocket send buffer.
 */
const sendScrollback = (
	writeFn: (chunk: string) => Effect.Effect<void, Socket.SocketError>,
	scrollback: string
): Effect.Effect<void, Socket.SocketError> =>
	Effect.gen(function* () {
		if (scrollback.length === 0) {
			return;
		}
		if (scrollback.length <= SCROLLBACK_CHUNK_SIZE) {
			yield* writeFn(scrollback);
			return;
		}
		for (
			let offset = 0;
			offset < scrollback.length;
			offset += SCROLLBACK_CHUNK_SIZE
		) {
			yield* writeFn(scrollback.slice(offset, offset + SCROLLBACK_CHUNK_SIZE));
		}
	});

/**
 * Terminal WebSocket route layer.
 *
 * Adds `GET /terminal` to the Default HTTP router. The route upgrades
 * to a WebSocket when the `id` query parameter specifies a valid terminal.
 */
const TerminalWsRouteLive = HttpRouter.Default.use((router) =>
	Effect.gen(function* () {
		const terminalManager = yield* TerminalManager;
		const ptyHostClient = yield* PtyHostClient;

		return router.addRoute(
			HttpRouter.makeRoute(
				"GET",
				"/terminal",
				Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest;
					const url = new URL(request.url, "http://localhost");
					const terminalId = url.searchParams.get("id");

					if (terminalId === null || terminalId === "") {
						return yield* HttpServerResponse.json(
							{ error: "Missing terminal ID query parameter" },
							{ status: 400 }
						);
					}

					const exists = yield* terminalManager.terminalExists(terminalId);
					if (!exists) {
						return yield* HttpServerResponse.json(
							{ error: `Terminal not found: ${terminalId}` },
							{ status: 404 }
						);
					}

					// Upgrade to WebSocket via the Effect platform Bun adapter.
					const socket = yield* (
						request as unknown as {
							readonly upgrade: Effect.Effect<Socket.Socket, Error>;
						}
					).upgrade;

					// Create a scope for the writer resource and obtain the
					// write function for sending data over the WebSocket.
					const scope = yield* Scope.make();
					const writeFn = yield* Scope.extend(socket.writer, scope);

					// Create a synchronous send function for the subscriber
					// callback (runs outside Effect context in PTY data path).
					const runtime = yield* Effect.runtime<never>();
					const runSync = Runtime.runSync(runtime);
					const wsSend = (data: string): void => {
						try {
							runSync(writeFn(data));
						} catch {
							// WebSocket may already be closed
						}
					};

					// Subscribe to terminal output (ring buffer + live data)
					const { scrollback, subscriberId } = yield* terminalManager.subscribe(
						terminalId,
						wsSend
					);

					// Run the WebSocket connection lifecycle.
					// Socket close/error is caught — it indicates normal
					// disconnection or network issues.
					yield* socket
						.runRaw(
							(message) => {
								handleClientMessage(
									ptyHostClient.write,
									ptyHostClient.ack,
									terminalId,
									message
								);
							},
							{
								onOpen: sendScrollback(writeFn, scrollback).pipe(
									Effect.catchAll(() => Effect.void)
								),
							}
						)
						.pipe(
							Effect.catchAll(() => Effect.void),
							Effect.ensuring(
								Effect.gen(function* () {
									yield* terminalManager.unsubscribe(terminalId, subscriberId);

									// Reset flow control on disconnect (Issue #141):
									// Send a large ack to the PTY host to ensure the PTY is
									// resumed if it was paused due to this client falling behind.
									// The HIGH_WATERMARK_CHARS value (100,000) is sufficient to
									// clear any accumulated unacknowledged count and resume the PTY.
									ptyHostClient.ack(terminalId, 100_000);

									yield* Scope.close(scope, Exit.void);
								})
							)
						);

					return HttpServerResponse.empty();
				})
			)
		);
	})
) satisfies Layer.Layer<never, never, TerminalManager | PtyHostClient>;

export { TerminalWsRouteLive };
