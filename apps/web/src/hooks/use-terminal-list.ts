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

type TerminalServiceStatus = "checking" | "available" | "unavailable";

/** Default polling interval in milliseconds. */
const DEFAULT_POLL_INTERVAL_MS = 2000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const tryExtractTerminalList = (
	envelope: unknown
): readonly TerminalInfo[] | undefined => {
	if (Array.isArray(envelope)) {
		return envelope as readonly TerminalInfo[];
	}

	if (!isRecord(envelope)) {
		return undefined;
	}

	if (envelope._tag === "Success" && Array.isArray(envelope.value)) {
		return envelope.value as readonly TerminalInfo[];
	}

	if (envelope._tag !== "Exit" || !isRecord(envelope.value)) {
		return undefined;
	}

	const nested = envelope.value;
	if (nested._tag === "Success" && Array.isArray(nested.value)) {
		return nested.value as readonly TerminalInfo[];
	}

	return undefined;
};

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
		if (!Array.isArray(parsed) || parsed.length !== 2) {
			continue;
		}

		const terminals = tryExtractTerminalList(parsed[1]);
		if (terminals) {
			return terminals;
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
	readonly errorMessage: string | null;
	readonly isServiceAvailable: boolean;
	readonly terminals: readonly TerminalInfo[];
	readonly isLoading: boolean;
	readonly serviceStatus: TerminalServiceStatus;
} {
	const [terminals, setTerminals] = useState<readonly TerminalInfo[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const [serviceStatus, setServiceStatus] =
		useState<TerminalServiceStatus>("checking");
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const mountedRef = useRef(true);

	const fetchAndUpdate = useCallback(async () => {
		try {
			const result = await fetchTerminalList();
			if (mountedRef.current) {
				setTerminals(result);
				setIsLoading(false);
				setServiceStatus("available");
				setErrorMessage(null);
			}
		} catch (error) {
			// Keep the last known terminal list, but surface service availability
			// so the UI can show a clear "Terminal service unavailable" warning.
			if (mountedRef.current) {
				setIsLoading(false);
				setServiceStatus("unavailable");
				const message =
					error instanceof Error
						? error.message
						: "Unknown terminal service error";
				setErrorMessage(message);
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

	return {
		errorMessage,
		isServiceAvailable: serviceStatus === "available",
		terminals,
		isLoading,
		serviceStatus,
	};
}

export { useTerminalList };
export type { TerminalInfo, TerminalServiceStatus };
