/**
 * useTerminalList — reactive terminal list from the terminal service.
 *
 * Polls the terminal service's `terminal.list` RPC endpoint at a
 * configurable interval (default 2 seconds) to provide a reactive list
 * of all terminals. Replaces the LiveStore `queryDb(terminals)` pattern
 * for terminal state queries.
 *
 * Uses direct fetch to the `/terminal-rpc` endpoint (proxied by Vite
 * to the terminal service's `/rpc` at TERMINAL_PORT). The Effect RPC
 * JSON protocol sends requests as `[requestId, { _tag, ...payload }]`
 * and receives responses as newline-delimited JSON.
 *
 * @see Issue #144: Web app LiveStore terminal query replacement
 * @see packages/terminal/src/rpc/handlers.ts — terminal.list handler
 */

import { useCallback, useEffect, useRef, useState } from "react";

/** Shape of a terminal from the terminal service's terminal.list RPC. */
interface TerminalInfo {
	readonly args: readonly string[];
	readonly command: string;
	readonly cwd: string;
	readonly id: string;
	readonly status: "running" | "stopped";
	readonly workspaceId: string;
}

/** Default polling interval in milliseconds. */
const DEFAULT_POLL_INTERVAL_MS = 2000;

/**
 * Fetch the terminal list from the terminal service via Effect RPC JSON protocol.
 *
 * The Effect RPC JSON protocol:
 * - Request: newline-delimited JSON, each line is `[requestId, { _tag: "rpc-name" }]`
 * - Response: newline-delimited JSON, each line is `[requestId, responsePayload]`
 *
 * For terminal.list with no payload, the request body is:
 * `[0, { "_tag": "terminal.list" }]\n`
 *
 * The response will be:
 * `[0, { "_tag": "Success", "value": [...terminals] }]\n` or similar.
 */
async function fetchTerminalList(): Promise<readonly TerminalInfo[]> {
	const response = await fetch("/terminal-rpc", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: '[0,{"_tag":"terminal.list"}]\n',
	});

	if (!response.ok) {
		throw new Error(`Terminal service responded with ${response.status}`);
	}

	const text = await response.text();
	const lines = text.trim().split("\n");

	for (const line of lines) {
		if (!line) {
			continue;
		}
		const parsed = JSON.parse(line);
		// Effect RPC response format: [requestId, responseEnvelope]
		if (Array.isArray(parsed) && parsed.length === 2) {
			const envelope = parsed[1];
			// Success response: { _tag: "Success", value: [...] }
			if (envelope && typeof envelope === "object" && "_tag" in envelope) {
				if (envelope._tag === "Success" && Array.isArray(envelope.value)) {
					return envelope.value as readonly TerminalInfo[];
				}
				// Exit response wrapping Success
				if (envelope._tag === "Exit") {
					const exit = envelope;
					if (
						exit.value &&
						typeof exit.value === "object" &&
						"_tag" in exit.value &&
						exit.value._tag === "Success" &&
						Array.isArray(exit.value.value)
					) {
						return exit.value.value as readonly TerminalInfo[];
					}
				}
			}
			// Direct array response (no envelope)
			if (Array.isArray(envelope)) {
				return envelope as readonly TerminalInfo[];
			}
		}
	}

	return [];
}

/**
 * Hook that provides a polled terminal list from the terminal service.
 *
 * Calls `terminal.list` on mount and at each poll interval to keep
 * the terminal list in sync with the terminal service state.
 *
 * @param pollIntervalMs - Polling interval in ms (default 2000).
 * @returns Object with `terminals` array and `isLoading` flag.
 */
function useTerminalList(pollIntervalMs = DEFAULT_POLL_INTERVAL_MS): {
	readonly terminals: readonly TerminalInfo[];
	readonly isLoading: boolean;
} {
	const [terminals, setTerminals] = useState<readonly TerminalInfo[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const mountedRef = useRef(true);

	const fetchAndUpdate = useCallback(async () => {
		try {
			const result = await fetchTerminalList();
			if (mountedRef.current) {
				setTerminals(result);
				setIsLoading(false);
			}
		} catch {
			// Silently ignore errors — terminal service may be restarting.
			// Keep the last known terminal list.
			if (mountedRef.current) {
				setIsLoading(false);
			}
		}
	}, []);

	useEffect(() => {
		mountedRef.current = true;
		fetchAndUpdate();

		if (pollIntervalMs > 0) {
			const timer = setInterval(fetchAndUpdate, pollIntervalMs);
			return () => {
				mountedRef.current = false;
				clearInterval(timer);
			};
		}

		return () => {
			mountedRef.current = false;
		};
	}, [fetchAndUpdate, pollIntervalMs]);

	return { terminals, isLoading };
}

export { useTerminalList };
export type { TerminalInfo };
