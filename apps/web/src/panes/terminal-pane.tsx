/**
 * Terminal pane component — renders PTY output via xterm.js and sends
 * keyboard input to the server PTY via AtomRpc mutations.
 *
 * Subscribes to `v1.TerminalOutput` events from LiveStore's event log
 * for the given terminal ID. Output is piped directly to the xterm.js
 * Terminal instance for full ANSI/xterm-256color rendering.
 *
 * Keyboard input is captured via xterm.js's `onData` callback and sent
 * to the server PTY using the `terminal.write` RPC mutation. This enables
 * full human-in-the-loop interaction with agents and regular terminal usage.
 *
 * Session reconnection (Issue #64):
 * - On page reload, LiveStore's `store.events()` replays all historical
 *   `v1.TerminalOutput` events from the persisted eventlog (OPFS/SQLite).
 *   This means terminal output is fully restored on reconnect — the user
 *   sees all previous output in the scrollback buffer.
 * - The component checks the terminal's status from the `terminals` table.
 *   If the terminal is "stopped", keyboard input is disabled and a visual
 *   banner is shown. If still "running", input is re-enabled and a resize
 *   is sent to re-sync PTY dimensions.
 * - The panel layout persistence (Issue #73) stores terminal-to-pane
 *   assignments in LiveStore, so the layout is restored on reload with
 *   the correct terminal IDs.
 *
 * Architecture:
 * - Server spawns a PTY via node-pty (TerminalManager service)
 * - PTY stdout emits `v1.TerminalOutput` events to LiveStore
 * - Events sync to the client via WebSocket (LiveStore sync)
 * - This component reads events from the event log and writes to xterm.js
 * - Keyboard input is sent via `terminal.write` RPC to the server PTY
 *
 * @see packages/server/src/services/terminal-manager.ts
 * @see packages/shared/src/schema.ts (terminalOutput event)
 * @see Issue #60: xterm.js terminal pane — render output
 * @see Issue #61: xterm.js terminal pane — send keyboard input
 * @see Issue #62: xterm.js terminal pane — handle resize
 * @see Issue #64: Terminal session reconnection
 */

import { useAtomSet } from "@effect-atom/atom-react/Hooks";
import { terminals } from "@laborer/shared/schema";
import { queryDb } from "@livestore/livestore";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { LaborerClient } from "@/atoms/laborer-client";
import { useLaborerStore } from "@/livestore/store";

/** Module-level mutation atom for terminal.write — shared across all TerminalPane instances. */
const terminalWriteMutation = LaborerClient.mutation("terminal.write");

/** Module-level mutation atom for terminal.resize — shared across all TerminalPane instances. */
const terminalResizeMutation = LaborerClient.mutation("terminal.resize");

/** Query all terminals from LiveStore for status checking. */
const allTerminals$ = queryDb(terminals, { label: "terminalPaneStatus" });

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
 * On reconnection (page reload), `store.events()` replays all historical
 * `v1.TerminalOutput` events from the persisted eventlog, restoring the
 * terminal's scrollback buffer. The component also checks the terminal's
 * current status and disables input if the terminal has stopped.
 *
 * Keyboard input is captured via xterm.js's `onData` callback and
 * sent to the server PTY using the `terminal.write` RPC mutation.
 * This enables human-in-the-loop interaction: the user types in the
 * terminal pane and the input reaches the server-side PTY process.
 * Special keys (enter, backspace, ctrl-c, arrows) are handled natively
 * by xterm.js which encodes them as the correct ANSI escape sequences.
 *
 * When the container is resized (by panel splits, window resize, etc.),
 * the fit addon recalculates cols/rows and the new dimensions are sent
 * to the server PTY via the `terminal.resize` RPC mutation. This ensures
 * the PTY sends SIGWINCH to the running process so it can reflow output.
 *
 * The component also handles:
 * - Responsive sizing via the xterm.js fit addon
 * - WebGL rendering for performance (falls back to canvas if unavailable)
 * - Terminal status tracking (running/stopped) from LiveStore
 * - Cleanup on unmount (disposes xterm.js instance, stops event stream)
 */
function TerminalPane({ terminalId }: TerminalPaneProps) {
	const store = useLaborerStore();
	const writeTerminal = useAtomSet(terminalWriteMutation);
	const resizeTerminal = useAtomSet(terminalResizeMutation);
	const containerRef = useRef<HTMLDivElement>(null);
	const terminalRef = useRef<Terminal | null>(null);
	const fitAddonRef = useRef<FitAddon | null>(null);
	const abortRef = useRef<AbortController | null>(null);

	// Track the terminal's current status from LiveStore reactively.
	// When the terminal stops (process exits), the status changes to "stopped"
	// and we disable keyboard input + show a status banner.
	const allTerminalRows = store.useQuery(allTerminals$);
	const terminalStatus = useMemo(() => {
		const row = allTerminalRows.find((t) => t.id === terminalId);
		return row?.status ?? "stopped";
	}, [allTerminalRows, terminalId]);

	const isRunning = terminalStatus === "running";

	/**
	 * Ref to hold the latest writeTerminal function so the xterm.js
	 * `onData` callback always has access to the current mutation
	 * function without needing to re-register the callback on every render.
	 */
	const writeTerminalRef = useRef(writeTerminal);
	writeTerminalRef.current = writeTerminal;

	/**
	 * Ref to hold the latest resizeTerminal function so the ResizeObserver
	 * callback always has access to the current mutation function.
	 */
	const resizeTerminalRef = useRef(resizeTerminal);
	resizeTerminalRef.current = resizeTerminal;

	/** Ref for isRunning so the xterm.js onData callback can check it. */
	const isRunningRef = useRef(isRunning);
	isRunningRef.current = isRunning;

	/**
	 * Initialize xterm.js and subscribe to terminal output events.
	 *
	 * We use a single effect that:
	 * 1. Creates the xterm.js Terminal instance
	 * 2. Attaches the fit and WebGL addons
	 * 3. Opens the terminal in the container div
	 * 4. Starts streaming v1.TerminalOutput events from LiveStore
	 *    (replays historical events on reconnection, then streams live)
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

		// Initial fit — also send dimensions to server PTY so it starts
		// with the correct size (or re-syncs on reconnection). This is
		// important for reconnection: the PTY may have different dimensions
		// than the last session, so we always send the current container size.
		try {
			fitAddon.fit();
			const { cols, rows } = terminal;
			if (cols > 0 && rows > 0) {
				resizeTerminalRef.current({
					payload: { terminalId, cols, rows },
				});
			}
		} catch {
			// Container may not have dimensions yet
		}

		// Wire keyboard input to server PTY via terminal.write RPC mutation.
		// xterm.js's onData fires for every keystroke (including special keys
		// like enter, backspace, ctrl-c, arrows) with the data already encoded
		// as the correct ANSI escape sequences. We send this data directly
		// to the server PTY.
		//
		// Uses fire-and-forget mode (no await) for low-latency input —
		// each keystroke is sent immediately without waiting for a response.
		// The character echoes back from the PTY via LiveStore TerminalOutput
		// events, completing the input → output loop.
		//
		// Keyboard input is only sent when the terminal is running.
		// When the terminal has stopped, keystrokes are silently dropped
		// to prevent sending data to a dead PTY.
		const onDataDisposable = terminal.onData((data: string) => {
			if (!isRunningRef.current) {
				return;
			}
			writeTerminalRef.current({
				payload: { terminalId, data },
			});
		});

		// Subscribe to terminal output events from LiveStore event log.
		//
		// store.events() replays ALL historical events from the persisted
		// eventlog (starting from ROOT) before streaming new live events.
		// This means on page reload / reconnection, the terminal's entire
		// output history is replayed into xterm.js, restoring the scrollback
		// buffer so the user sees all previous output.
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

		// Subscribe to terminal restart events (Issue #133).
		// When a TerminalRestarted event is committed for this terminal,
		// clear the xterm.js scrollback buffer so old output from the
		// previous process doesn't mix with the new process output.
		const streamRestartEvents = async () => {
			try {
				for await (const event of store.events({
					filter: ["v1.TerminalRestarted"],
				})) {
					if (abortController.signal.aborted) {
						break;
					}

					const args = event.args as { id: string };
					if (args.id === terminalId) {
						terminal.clear();
					}
				}
			} catch {
				// Stream ended or aborted — expected on unmount
			}
		};

		streamRestartEvents();

		// Cleanup on unmount
		return () => {
			onDataDisposable.dispose();
			abortController.abort();
			abortRef.current = null;
			terminal.dispose();
			terminalRef.current = null;
			fitAddonRef.current = null;
		};
	}, [terminalId, store]);

	/**
	 * Handle container resize — re-fit the terminal when the
	 * pane dimensions change, then send new dimensions to the
	 * server PTY via `terminal.resize` RPC mutation.
	 *
	 * The fit addon recalculates cols/rows based on the container
	 * size and font metrics. After fitting, we read the new dimensions
	 * from the xterm.js Terminal instance and dispatch a resize mutation.
	 * The server PTY sends SIGWINCH so the process can reflow output.
	 *
	 * Uses fire-and-forget mode (no await) for low-latency resize —
	 * the PTY resize is best-effort and doesn't need acknowledgment.
	 */
	const handleResize = useCallback(() => {
		const fitAddon = fitAddonRef.current;
		const terminal = terminalRef.current;
		if (!(fitAddon && terminal)) {
			return;
		}

		try {
			fitAddon.fit();
		} catch {
			// Ignore errors during resize (container may have 0 dimensions)
			return;
		}

		// Send new dimensions to the server PTY
		const { cols, rows } = terminal;
		if (cols > 0 && rows > 0) {
			resizeTerminalRef.current({
				payload: { terminalId, cols, rows },
			});
		}
	}, [terminalId]);

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
			className="relative h-full w-full overflow-hidden"
			data-terminal-id={terminalId}
		>
			{/* xterm.js container */}
			<div className="h-full w-full" ref={containerRef} />

			{/* Status banner — shown when terminal process has exited */}
			{!isRunning && (
				<div className="absolute inset-x-0 bottom-0 border-border/50 border-t bg-muted/90 px-3 py-1.5 text-center text-muted-foreground text-xs backdrop-blur-sm">
					Process exited — terminal output preserved (read-only)
				</div>
			)}
		</div>
	);
}

export { TerminalPane };
