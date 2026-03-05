/**
 * useTerminalWebSocket — manages a WebSocket connection to the dedicated
 * terminal output endpoint (`/terminal?id=<terminalId>`).
 *
 * Replaces the LiveStore event subscription for terminal output with a
 * direct WebSocket channel. This provides:
 * - Lower latency (no LiveStore event serialization/materialization overhead)
 * - No base64 encoding (raw UTF-8 text frames)
 * - Server-side ring buffer scrollback on reconnection
 * - Reduced LiveStore database writes (terminal output no longer persisted)
 *
 * The hook handles:
 * - WebSocket connection lifecycle (open, close, error)
 * - Exponential backoff reconnection on disconnect
 * - Scrollback replay from the server's ring buffer on connect
 * - Sending keyboard input as text frames (replaces terminal.write RPC)
 * - Connection status tracking for UI indicators
 * - Parsing JSON status control messages from the terminal service
 *
 * The `terminal.resize` RPC is NOT replaced — resize remains an RPC call
 * since it's low-frequency and needs to reach the TerminalManager service.
 *
 * Character-count flow control:
 * The hook tracks total characters received from the WebSocket and sends
 * an ack frame (`{"type":"ack","chars":5000}`) every `CHAR_COUNT_ACK_SIZE`
 * characters. This allows the server-side PTY host to pause fast-running
 * commands when the client falls behind and resume when acks are received.
 * See PRD-terminal-perf.md "Character-Count Flow Control" for the full
 * protocol specification.
 *
 * Terminal status control messages (Issue #141):
 * The terminal service sends JSON control messages to inform the client
 * about terminal lifecycle events. These are parsed and separated from
 * raw PTY output data:
 * - `{"type":"status","status":"running"}` — sent on initial connection
 * - `{"type":"status","status":"stopped","exitCode":N}` — PTY process exited
 * - `{"type":"status","status":"restarted"}` — terminal was restarted
 *
 * The hook exposes `terminalStatus` so consumers can derive UI state from
 * the WebSocket control messages instead of polling LiveStore.
 *
 * @see packages/terminal/src/routes/terminal-ws.ts — WebSocket endpoint
 * @see packages/terminal/src/pty-host.ts — PTY host flow control
 * @see PRD-terminal-perf.md — "Web Client Terminal Pane Update"
 * @see PRD-terminal-extraction.md — "WebSocket Control Messages"
 * @see Issue #140, Issue #141, Issue #142
 */

import { useCallback, useEffect, useRef, useState } from "react";

/** WebSocket connection state for UI indicators. */
type ConnectionStatus = "connecting" | "connected" | "disconnected";

/**
 * Terminal process status derived from WebSocket control messages.
 * Replaces LiveStore `queryDb(terminals)` for determining terminal state.
 *
 * - "running" — PTY process is alive (received on connect or after restart)
 * - "stopped" — PTY process has exited (includes exit code)
 * - "restarted" — terminal was restarted (transient, immediately transitions to "running")
 */
type TerminalStatus = "running" | "stopped" | "restarted";

/** Configuration for exponential backoff reconnection. */
const INITIAL_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 30_000;
const RECONNECT_BACKOFF_FACTOR = 2;

/**
 * Number of characters between ack frames sent to the server.
 * Matches the server-side LOW_WATERMARK_CHARS / CharCountAckSize (5,000).
 * @see PRD-terminal-perf.md "Character-Count Flow Control"
 */
const CHAR_COUNT_ACK_SIZE = 5000;

/** Shape of a parsed status control message from the terminal service. */
interface StatusControlMessage {
	readonly exitCode?: number | undefined;
	readonly status: string;
	readonly type: "status";
}

/**
 * Attempt to parse a WebSocket text frame as a JSON status control message.
 * Returns the parsed message if valid, or undefined if the frame is raw
 * PTY output data.
 *
 * Detection heuristic: text frames starting with `{` that contain
 * `"type":"status"` are control messages. All others are PTY data.
 * This matches the server-side sendStatusMessage format.
 */
function parseStatusMessage(data: string): StatusControlMessage | undefined {
	if (data.length === 0 || data[0] !== "{") {
		return undefined;
	}
	try {
		const parsed = JSON.parse(data) as Record<string, unknown>;
		if (parsed.type === "status" && typeof parsed.status === "string") {
			return {
				type: "status",
				status: parsed.status,
				exitCode:
					typeof parsed.exitCode === "number" ? parsed.exitCode : undefined,
			};
		}
	} catch {
		// Not valid JSON — treat as terminal output
	}
	return undefined;
}

interface UseTerminalWebSocketOptions {
	/** Callback invoked with terminal output data (raw UTF-8). */
	readonly onData: (data: string) => void;

	/**
	 * Callback invoked when a status control message is received.
	 * Used by terminal-pane.tsx to handle restart (clear buffer) and
	 * stopped (show exit banner) events.
	 */
	readonly onStatus?: (
		status: TerminalStatus,
		exitCode: number | undefined
	) => void;

	/** The terminal ID to connect to. */
	readonly terminalId: string;
}

interface UseTerminalWebSocketResult {
	/** Send input data to the PTY via WebSocket text frame. */
	readonly send: (data: string) => void;

	/** Current WebSocket connection status. */
	readonly status: ConnectionStatus;

	/**
	 * Terminal process status derived from WebSocket control messages.
	 * Replaces LiveStore-based terminal status for UI decisions.
	 */
	readonly terminalStatus: TerminalStatus;
}

/**
 * React hook that manages a WebSocket connection to the terminal output
 * endpoint. Output data is delivered via the `onData` callback. Input
 * is sent via the returned `send` function.
 *
 * Status control messages from the terminal service are parsed and
 * exposed via `terminalStatus`. The optional `onStatus` callback
 * notifies consumers of status transitions for side effects (e.g.,
 * clearing xterm.js buffer on restart).
 *
 * Reconnects with exponential backoff on disconnect. Stops reconnecting
 * when the terminal process has stopped (status = "stopped").
 */
function useTerminalWebSocket({
	terminalId,
	onData,
	onStatus,
}: UseTerminalWebSocketOptions): UseTerminalWebSocketResult {
	const [connectionStatus, setConnectionStatus] =
		useState<ConnectionStatus>("connecting");
	const [terminalStatus, setTerminalStatus] =
		useState<TerminalStatus>("running");
	const wsRef = useRef<WebSocket | null>(null);
	const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const reconnectDelayRef = useRef(INITIAL_RECONNECT_DELAY_MS);
	const mountedRef = useRef(true);

	/** Characters received since the last ack was sent (flow control). */
	const unackedCharsRef = useRef(0);

	// Refs for latest callback/state to avoid stale closures in WebSocket handlers
	const onDataRef = useRef(onData);
	onDataRef.current = onData;
	const onStatusRef = useRef(onStatus);
	onStatusRef.current = onStatus;
	const terminalStatusRef = useRef(terminalStatus);
	terminalStatusRef.current = terminalStatus;

	const clearReconnectTimer = useCallback(() => {
		if (reconnectTimerRef.current !== null) {
			clearTimeout(reconnectTimerRef.current);
			reconnectTimerRef.current = null;
		}
	}, []);

	const connect = useCallback(() => {
		if (!mountedRef.current) {
			return;
		}

		// Build WebSocket URL relative to current origin
		const protocol = globalThis.location.protocol === "https:" ? "wss:" : "ws:";
		const wsUrl = `${protocol}//${globalThis.location.host}/terminal?id=${encodeURIComponent(terminalId)}`;

		setConnectionStatus("connecting");

		const ws = new WebSocket(wsUrl);
		wsRef.current = ws;

		ws.onopen = () => {
			if (!mountedRef.current) {
				ws.close();
				return;
			}
			setConnectionStatus("connected");
			// Reset backoff on successful connection
			reconnectDelayRef.current = INITIAL_RECONNECT_DELAY_MS;
			// Reset flow control counter on new/reconnected WebSocket
			unackedCharsRef.current = 0;
		};

		ws.onmessage = (event: MessageEvent) => {
			if (typeof event.data !== "string") {
				return;
			}

			// Check if this is a status control message from the terminal service
			const statusMsg = parseStatusMessage(event.data);
			if (statusMsg !== undefined) {
				const newStatus = statusMsg.status as TerminalStatus;
				setTerminalStatus(newStatus);
				onStatusRef.current?.(newStatus, statusMsg.exitCode);
				return;
			}

			// Raw PTY output data
			onDataRef.current(event.data);

			// Flow control: count received characters and send ack frames
			unackedCharsRef.current += event.data.length;
			if (unackedCharsRef.current >= CHAR_COUNT_ACK_SIZE) {
				const chars = unackedCharsRef.current;
				unackedCharsRef.current = 0;
				if (ws.readyState === WebSocket.OPEN) {
					ws.send(JSON.stringify({ type: "ack", chars }));
				}
			}
		};

		ws.onclose = () => {
			if (!mountedRef.current) {
				return;
			}
			wsRef.current = null;
			setConnectionStatus("disconnected");

			// Only reconnect if the terminal is still running
			if (terminalStatusRef.current !== "stopped") {
				const delay = reconnectDelayRef.current;
				reconnectDelayRef.current = Math.min(
					delay * RECONNECT_BACKOFF_FACTOR,
					MAX_RECONNECT_DELAY_MS
				);
				reconnectTimerRef.current = setTimeout(() => {
					reconnectTimerRef.current = null;
					connect();
				}, delay);
			}
		};

		ws.onerror = () => {
			// onerror is always followed by onclose — let onclose handle cleanup
		};
	}, [terminalId]);

	// Connect on mount, reconnect when terminalId changes
	useEffect(() => {
		mountedRef.current = true;
		connect();

		return () => {
			mountedRef.current = false;
			clearReconnectTimer();
			const ws = wsRef.current;
			if (ws) {
				ws.onclose = null; // Prevent reconnection on intentional close
				ws.close();
				wsRef.current = null;
			}
		};
	}, [connect, clearReconnectTimer]);

	// When the terminal restarts (status transitions to "running" or "restarted"),
	// and the WebSocket is disconnected, reconnect.
	useEffect(() => {
		if (
			terminalStatus !== "stopped" &&
			wsRef.current === null &&
			connectionStatus === "disconnected"
		) {
			// Terminal restarted — reconnect
			reconnectDelayRef.current = INITIAL_RECONNECT_DELAY_MS;
			connect();
		}
	}, [terminalStatus, connectionStatus, connect]);

	const send = useCallback((data: string) => {
		const ws = wsRef.current;
		if (ws?.readyState === WebSocket.OPEN) {
			ws.send(data);
		}
	}, []);

	return { send, status: connectionStatus, terminalStatus };
}

export { useTerminalWebSocket };
export type { ConnectionStatus, TerminalStatus, UseTerminalWebSocketResult };
