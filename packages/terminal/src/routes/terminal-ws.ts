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
 * - Server → Client: JSON control messages for terminal status:
 *   - `{"type":"status","status":"running"}` — sent on initial connection
 *   - `{"type":"status","status":"stopped","exitCode":N}` — PTY exited
 *   - `{"type":"status","status":"restarted"}` — terminal restarted
 * - Client → Server: Raw terminal input (keystrokes) as text frames,
 *   or JSON control messages (e.g., `{"type":"ack","chars":5000}` for
 *   flow control)
 *
 * Connection lifecycle:
 * 1. Client connects with `?id=<terminalId>`
 * 2. Server validates terminal exists
 * 3. Server sends `{"type":"status","status":"running"}` control message
 * 4. Server sends ring buffer scrollback as initial text frame(s)
 * 5. Server subscribes to live output and forwards as text frames
 * 6. Server subscribes to lifecycle events for status control messages
 * 7. Client text frames are forwarded to PTY as input
 * 8. On disconnect: server unsubscribes, cleans up
 *
 * @see PRD-terminal-extraction.md — "WebSocket Control Messages"
 * @see Issue #140: Move terminal WebSocket route to terminal package
 */

import {
	HttpRouter,
	HttpServerRequest,
	HttpServerResponse,
	type Socket,
} from "@effect/platform";
import { Effect, Exit, type Layer, PubSub, Runtime, Scope } from "effect";
import { PtyHostClient } from "../services/pty-host-client.js";
import {
	type TerminalLifecycleEvent,
	TerminalManager,
} from "../services/terminal-manager.js";

/**
 * Maximum size (in characters) for a single scrollback text frame.
 * Large scrollback buffers are split into chunks to avoid overwhelming
 * the WebSocket send buffer.
 *
 * Increased from 64KB to 128KB to reduce the number of frames needed
 * when sending the 5MB ring buffer on reconnection (~40 frames vs ~80).
 *
 * @see Issue #127: Terminal scroll performance (100k+ lines)
 */
const SCROLLBACK_CHUNK_SIZE = 131_072;

/**
 * Handle incoming WebSocket messages from the client.
 * Text frames are forwarded to the PTY as input, except for
 * JSON control messages (ack for flow control).
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

	// Detect JSON control messages (ack for flow control)
	if (data.length > 0 && data[0] === "{" && data.endsWith("}")) {
		try {
			const parsed = JSON.parse(data) as { chars?: number; type?: string };
			if (parsed.type === "ack" && typeof parsed.chars === "number") {
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
 * Send a JSON status control message to the client.
 * These messages inform the client about terminal lifecycle events.
 */
const sendStatusMessage = (
	wsSend: (data: string) => void,
	status: string,
	exitCode?: number
): void => {
	const message: Record<string, unknown> = { type: "status", status };
	if (exitCode !== undefined) {
		message.exitCode = exitCode;
	}
	try {
		wsSend(JSON.stringify(message));
	} catch {
		// WebSocket may already be closed
	}
};

/**
 * Handle a lifecycle event for a specific terminal WebSocket connection.
 * Sends status control messages to the client when the terminal exits
 * or is restarted.
 */
const handleLifecycleEvent = (
	event: TerminalLifecycleEvent,
	terminalId: string,
	wsSend: (data: string) => void
): void => {
	switch (event._tag) {
		case "Exited": {
			if (event.id === terminalId) {
				sendStatusMessage(wsSend, "stopped", event.exitCode);
			}
			break;
		}
		case "Restarted": {
			if (event.terminal.id === terminalId) {
				sendStatusMessage(wsSend, "restarted");
			}
			break;
		}
		default:
			break;
	}
};

/**
 * Subscribe to lifecycle events in a scoped fiber.
 * The subscription is automatically cleaned up when the provided
 * scope is closed (on WebSocket disconnect).
 */
const subscribeToLifecycleEvents = (
	lifecycleEvents: PubSub.PubSub<TerminalLifecycleEvent>,
	terminalId: string,
	wsSend: (data: string) => void
): Effect.Effect<void, never, Scope.Scope> =>
	Effect.gen(function* () {
		const queue = yield* PubSub.subscribe(lifecycleEvents);

		// Run the event consumption loop in a daemon fiber so it
		// doesn't block the caller. The fiber is interrupted when
		// the scope is closed (WebSocket disconnect).
		yield* Effect.forkScoped(
			Effect.gen(function* () {
				while (true) {
					const event = yield* queue.take;
					handleLifecycleEvent(event, terminalId, wsSend);
				}
			}).pipe(Effect.catchAll(() => Effect.void))
		);
	});

/**
 * Terminal WebSocket route layer.
 *
 * Adds `GET /terminal` to the Default HTTP router. The route upgrades
 * to a WebSocket when the `id` query parameter specifies a valid terminal.
 *
 * @see Issue #140: Move terminal WebSocket route to terminal package
 */
const TerminalWsRouteLive = HttpRouter.Default.use((router) =>
	Effect.gen(function* () {
		const terminalManager = yield* TerminalManager;
		const ptyHostClient = yield* PtyHostClient;

		yield* router.addRoute(
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

					// Send initial status control message
					sendStatusMessage(wsSend, "running");

					// Subscribe to terminal output (ring buffer + live data)
					const { scrollback, subscriberId } = yield* terminalManager.subscribe(
						terminalId,
						wsSend
					);

					// Subscribe to lifecycle events for status control messages.
					// Uses a scoped fiber that is interrupted when the scope
					// is closed (on WebSocket disconnect).
					yield* Scope.extend(
						subscribeToLifecycleEvents(
							terminalManager.lifecycleEvents,
							terminalId,
							wsSend
						),
						scope
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

									// Reset flow control on disconnect:
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
