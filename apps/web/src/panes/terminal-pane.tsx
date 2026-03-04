/**
 * Terminal pane component — renders PTY output via xterm.js.
 *
 * Subscribes to `v1.TerminalOutput` events from LiveStore's event log
 * for the given terminal ID. Output is piped directly to the xterm.js
 * Terminal instance for full ANSI/xterm-256color rendering.
 *
 * Architecture:
 * - Server spawns a PTY via node-pty (TerminalManager service)
 * - PTY stdout emits `v1.TerminalOutput` events to LiveStore
 * - Events sync to the client via WebSocket (LiveStore sync)
 * - This component reads events from the event log and writes to xterm.js
 *
 * @see packages/server/src/services/terminal-manager.ts
 * @see packages/shared/src/schema.ts (terminalOutput event)
 * @see Issue #60: xterm.js terminal pane — render output
 */

import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useCallback, useEffect, useRef } from "react";
import { useLaborerStore } from "@/livestore/store";

interface TerminalPaneProps {
	/** The terminal ID to subscribe to for output events. */
	readonly terminalId: string;
}

/**
 * TerminalPane renders a live terminal view for a given terminal ID.
 *
 * It initializes an xterm.js Terminal, subscribes to the LiveStore
 * event log for `v1.TerminalOutput` events matching the terminal ID,
 * and writes output data to xterm.js as it arrives.
 *
 * The component also handles:
 * - Responsive sizing via the xterm.js fit addon
 * - WebGL rendering for performance (falls back to canvas if unavailable)
 * - Cleanup on unmount (disposes xterm.js instance, stops event stream)
 */
function TerminalPane({ terminalId }: TerminalPaneProps) {
	const store = useLaborerStore();
	const containerRef = useRef<HTMLDivElement>(null);
	const terminalRef = useRef<Terminal | null>(null);
	const fitAddonRef = useRef<FitAddon | null>(null);
	const abortRef = useRef<AbortController | null>(null);

	/**
	 * Initialize xterm.js and subscribe to terminal output events.
	 *
	 * We use a single effect that:
	 * 1. Creates the xterm.js Terminal instance
	 * 2. Attaches the fit and WebGL addons
	 * 3. Opens the terminal in the container div
	 * 4. Starts streaming v1.TerminalOutput events from LiveStore
	 * 5. Cleans up on unmount
	 */
	useEffect(() => {
		const container = containerRef.current;
		if (!container) {
			return;
		}

		// Create xterm.js Terminal instance
		const terminal = new Terminal({
			cursorBlink: true,
			fontFamily:
				'"JetBrains Mono", "Fira Code", "Cascadia Code", Menlo, Monaco, "Courier New", monospace',
			fontSize: 13,
			lineHeight: 1.2,
			theme: {
				background: "#09090b", // zinc-950 — matches dark theme
				foreground: "#fafafa", // zinc-50
				cursor: "#fafafa",
				cursorAccent: "#09090b",
				selectionBackground: "#27272a80", // zinc-800 with alpha
				black: "#09090b",
				red: "#ef4444",
				green: "#22c55e",
				yellow: "#eab308",
				blue: "#3b82f6",
				magenta: "#a855f7",
				cyan: "#06b6d4",
				white: "#fafafa",
				brightBlack: "#52525b",
				brightRed: "#f87171",
				brightGreen: "#4ade80",
				brightYellow: "#facc15",
				brightBlue: "#60a5fa",
				brightMagenta: "#c084fc",
				brightCyan: "#22d3ee",
				brightWhite: "#ffffff",
			},
			scrollback: 10_000,
			convertEol: false,
			allowProposedApi: true,
		});

		terminalRef.current = terminal;

		// Attach fit addon for responsive sizing
		const fitAddon = new FitAddon();
		terminal.loadAddon(fitAddon);
		fitAddonRef.current = fitAddon;

		// Open terminal in the container
		terminal.open(container);

		// Attempt WebGL rendering for better performance
		try {
			const webglAddon = new WebglAddon();
			webglAddon.onContextLoss(() => {
				webglAddon.dispose();
			});
			terminal.loadAddon(webglAddon);
		} catch {
			// WebGL not available — fall back to canvas renderer (default)
		}

		// Initial fit
		try {
			fitAddon.fit();
		} catch {
			// Container may not have dimensions yet
		}

		// Subscribe to terminal output events from LiveStore event log
		const abortController = new AbortController();
		abortRef.current = abortController;

		const streamEvents = async () => {
			try {
				for await (const event of store.events({
					filter: ["v1.TerminalOutput"],
				})) {
					if (abortController.signal.aborted) {
						break;
					}

					// Filter to only this terminal's output
					const args = event.args as { id: string; data: string };
					if (args.id === terminalId) {
						terminal.write(args.data);
					}
				}
			} catch {
				// Stream ended or aborted — expected on unmount
			}
		};

		streamEvents();

		// Cleanup on unmount
		return () => {
			abortController.abort();
			abortRef.current = null;
			terminal.dispose();
			terminalRef.current = null;
			fitAddonRef.current = null;
		};
	}, [terminalId, store]);

	/**
	 * Handle container resize — re-fit the terminal when the
	 * pane dimensions change.
	 */
	const handleResize = useCallback(() => {
		const fitAddon = fitAddonRef.current;
		if (fitAddon) {
			try {
				fitAddon.fit();
			} catch {
				// Ignore errors during resize (container may have 0 dimensions)
			}
		}
	}, []);

	/**
	 * Observe the container element for size changes using ResizeObserver.
	 * This handles allotment pane resizing, window resizing, etc.
	 */
	useEffect(() => {
		const container = containerRef.current;
		if (!container) {
			return;
		}

		const resizeObserver = new ResizeObserver(() => {
			handleResize();
		});

		resizeObserver.observe(container);

		return () => {
			resizeObserver.disconnect();
		};
	}, [handleResize]);

	return (
		<div
			className="h-full w-full overflow-hidden"
			data-terminal-id={terminalId}
			ref={containerRef}
		/>
	);
}

export { TerminalPane };
