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
 *
 * The `terminal.resize` RPC is NOT replaced — resize remains an RPC call
 * since it's low-frequency and needs to reach the TerminalManager service.
 *
 * @see packages/server/src/routes/terminal-ws.ts — server endpoint
 * @see PRD-terminal-perf.md — "Web Client Terminal Pane Update"
 * @see Issue #140
 */

import { useCallback, useEffect, useRef, useState } from "react";

/** WebSocket connection state for UI indicators. */
type ConnectionStatus = "connecting" | "connected" | "disconnected";

/** Configuration for exponential backoff reconnection. */
const INITIAL_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 30_000;
const RECONNECT_BACKOFF_FACTOR = 2;

interface UseTerminalWebSocketOptions {
	/** Whether the terminal is running (controls reconnection behavior). */
	readonly isRunning: boolean;

	/** Callback invoked with terminal output data (raw UTF-8). */
	readonly onData: (data: string) => void;
	/** The terminal ID to connect to. */
	readonly terminalId: string;
}

interface UseTerminalWebSocketResult {
	/** Send input data to the PTY via WebSocket text frame. */
	readonly send: (data: string) => void;

	/** Current WebSocket connection status. */
	readonly status: ConnectionStatus;
}

/**
 * React hook that manages a WebSocket connection to the terminal output
 * endpoint. Output data is delivered via the `onData` callback. Input
 * is sent via the returned `send` function.
 *
 * Reconnects with exponential backoff on disconnect. Stops reconnecting
 * when the terminal is no longer running (process exited).
 */
function useTerminalWebSocket({
	terminalId,
	onData,
	isRunning,
}: UseTerminalWebSocketOptions): UseTerminalWebSocketResult {
	const [status, setStatus] = useState<ConnectionStatus>("connecting");
	const wsRef = useRef<WebSocket | null>(null);
	const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const reconnectDelayRef = useRef(INITIAL_RECONNECT_DELAY_MS);
	const mountedRef = useRef(true);

	// Refs for latest callback/state to avoid stale closures in WebSocket handlers
	const onDataRef = useRef(onData);
	onDataRef.current = onData;
	const isRunningRef = useRef(isRunning);
	isRunningRef.current = isRunning;

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

		setStatus("connecting");

		const ws = new WebSocket(wsUrl);
		wsRef.current = ws;

		ws.onopen = () => {
			if (!mountedRef.current) {
				ws.close();
				return;
			}
			setStatus("connected");
			// Reset backoff on successful connection
			reconnectDelayRef.current = INITIAL_RECONNECT_DELAY_MS;
		};

		ws.onmessage = (event: MessageEvent) => {
			if (typeof event.data === "string") {
				onDataRef.current(event.data);
			}
		};

		ws.onclose = () => {
			if (!mountedRef.current) {
				return;
			}
			wsRef.current = null;
			setStatus("disconnected");

			// Only reconnect if the terminal is still running
			if (isRunningRef.current) {
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

	// When the terminal stops running, close the WebSocket cleanly.
	// When it starts running again (e.g., after restart), reconnect.
	useEffect(() => {
		if (isRunning && wsRef.current === null && status === "disconnected") {
			// Terminal restarted — reconnect
			reconnectDelayRef.current = INITIAL_RECONNECT_DELAY_MS;
			connect();
		}
	}, [isRunning, status, connect]);

	const send = useCallback((data: string) => {
		const ws = wsRef.current;
		if (ws?.readyState === WebSocket.OPEN) {
			ws.send(data);
		}
	}, []);

	return { send, status };
}

export { useTerminalWebSocket };
export type { ConnectionStatus, UseTerminalWebSocketResult };
