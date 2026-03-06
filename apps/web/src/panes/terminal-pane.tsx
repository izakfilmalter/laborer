/**
 * Terminal pane component — renders PTY output via xterm.js using a
 * dedicated WebSocket connection for terminal data.
 *
 * Data flow (Issue #140 — WebSocket data path):
 * 1. Terminal service PTY emits output via node-pty `onData`
 * 2. TerminalManager writes to per-terminal ring buffer + notifies subscribers
 * 3. Terminal WebSocket route forwards data as text frames to connected clients
 * 4. This component receives text frames via `useTerminalWebSocket` hook
 * 5. Output is written directly to xterm.js Terminal instance
 *
 * Input flow:
 * - Keystrokes captured by xterm.js `onData` callback
 * - Sent as raw WebSocket text frames (NOT via terminal.write RPC)
 * - Terminal service WebSocket route forwards to PTY via PtyHostClient.write()
 *
 * Terminal status (Issue #141 — WebSocket-derived status):
 * Terminal status is now derived from WebSocket control messages sent by
 * the terminal service, NOT from LiveStore `queryDb(terminals)`. The
 * terminal service sends JSON control messages:
 * - `{"type":"status","status":"running"}` — on initial connection
 * - `{"type":"status","status":"stopped","exitCode":N}` — PTY process exited
 * - `{"type":"status","status":"restarted"}` — terminal was restarted
 *
 * The `useTerminalWebSocket` hook parses these messages and exposes
 * `terminalStatus` for UI decisions (isRunning, exit banner, restart
 * buffer clear). The LiveStore `terminals` query is no longer used.
 *
 * Terminal restart handling (Issue #141):
 * Previously subscribed to LiveStore `v1.TerminalRestarted` events.
 * Now handled via the WebSocket `{"type":"status","status":"restarted"}`
 * control message. The `onStatus` callback clears the xterm.js buffer
 * when a restart is detected.
 *
 * Keyboard shortcut scope isolation (Issue #80):
 * - xterm.js greedily captures all keyboard events within its canvas.
 * - Panel shortcuts (Ctrl+B prefix sequences) must still work when a
 *   terminal has focus.
 * - `attachCustomKeyEventHandler` intercepts keyboard events before
 *   xterm.js processes them. When Ctrl+B is pressed, the handler
 *   returns `false` (letting the event bubble to `document` where
 *   TanStack Hotkeys catches it) and enters "prefix mode".
 * - Cmd+W (Meta+W) is also returned `false` so the global close-pane
 *   shortcut can run even when the terminal has focus.
 * - In prefix mode, the next keydown is also returned `false` so the
 *   action key (H, V, X, O, P, D) reaches TanStack Hotkeys.
 * - After the action key (or a 1500ms timeout matching SEQUENCE_TIMEOUT),
 *   prefix mode exits and all keys go to the terminal again.
 * - This gives the same UX as tmux: Ctrl+B escapes the terminal to the
 *   panel shortcut layer, then the next key is the panel action.
 *
 * Reconnection:
 * - On page reload or network disruption, the WebSocket reconnects with
 *   exponential backoff
 * - Server sends ring buffer scrollback (5MB) as initial text frames
 * - New live output continues streaming after scrollback
 *
 * What stays on LiveStore (lifecycle events):
 * - Panel layout persistence — terminal-to-pane assignments
 *
 * What moved to WebSocket (Issues #140, #141):
 * - Terminal output data — was LiveStore `v1.TerminalOutput` events
 * - Terminal keyboard input — was `terminal.write` RPC mutation
 * - Terminal status — was LiveStore `queryDb(terminals)` for running/stopped
 * - Terminal restart detection — was LiveStore `v1.TerminalRestarted` events
 *
 * What remains as RPC:
 * - `terminal.resize` — low-frequency, needs TerminalManager service
 *
 * @see packages/terminal/src/routes/terminal-ws.ts — WebSocket endpoint
 * @see packages/terminal/src/services/terminal-manager.ts — ring buffer + subscribers
 * @see apps/web/src/hooks/use-terminal-websocket.ts — WebSocket hook
 * @see PRD-terminal-perf.md — "Web Client Terminal Pane Update"
 * @see PRD-terminal-extraction.md — "WebSocket Control Messages"
 * Loading state (Issue #122):
 * When a terminal pane first mounts, xterm.js is initialized but no output
 * has arrived yet. A loading overlay (spinner + "Starting terminal...")
 * covers the blank terminal canvas until the first data arrives via
 * WebSocket. This provides visual feedback that the PTY is being spawned
 * and connected. The overlay fades out on first data receipt. For stopped
 * terminals (reconnection), the overlay is skipped since scrollback data
 * arrives immediately on WebSocket connect.
 *
 * @see Issue #60: xterm.js terminal pane — render output
 * @see Issue #61: xterm.js terminal pane — send keyboard input
 * @see Issue #62: xterm.js terminal pane — handle resize
 * @see Issue #64: Terminal session reconnection
 * @see Issue #80: Keyboard shortcut scope isolation
 * @see Issue #122: Loading state — terminal spawning
 * @see Issue #140: Web client terminal pane — WebSocket data path
 * @see Issue #141: Update Vite proxy + web app WebSocket hook
 *
 * Scroll performance (Issue #127):
 * - Scrollback buffer set to 100,000 lines to handle long-running agent sessions
 * - WebGL renderer (GPU-accelerated) used by default, canvas fallback on context loss
 * - Unicode11 addon loaded for correct Unicode character width calculation
 * - xterm.js virtualizes the viewport (only visible rows are in the DOM) so
 *   large scrollback doesn't impact rendering performance
 * - Fast scroll sensitivity increased for quicker navigation through large buffers
 * - Alt+scroll modifier enables accelerated scrolling (5x speed)
 *
 * Terminal fidelity — Claude Code TUI (Issue #125):
 * Verified and enhanced xterm.js rendering for Claude Code's TUI output:
 * - TERM=xterm-256color set at PTY spawn (supports 256-color + true color)
 * - 16-color palette mapped to Tailwind zinc scale for dark theme consistency
 * - WebGL renderer handles rapid full-screen redraws from agent tool output
 * - Unicode11 addon ensures correct width for box-drawing chars, emoji, spinners
 * - Web Links addon (@xterm/addon-web-links) enables clickable URLs in agent
 *   output (PRs, docs, file paths) — Cmd+Click opens in default browser
 * - convertEol: false preserves raw escape sequences for cursor positioning
 * - allowProposedApi: true enables advanced features agents may use
 * - 100K line scrollback handles long agent sessions with extensive tool output
 * - Data coalescing (5ms) smooths rapid output bursts from agent tool calls
 * - Flow control prevents output buffer overflow during fast code generation
 *
 * Terminal fidelity — Codex CLI TUI (Issue #126):
 * Verified xterm.js rendering for OpenAI's Codex CLI (Rust-based TUI using
 * ratatui + crossterm). Codex uses a hybrid inline viewport + alternate screen
 * model: primary view renders inline with scrolling regions (DECSTBM), while
 * overlay views (diff, pager, agent picker) use the alternate screen buffer.
 * - TERM=xterm-256color + COLORTERM=truecolor set at PTY spawn — Codex's
 *   `supports-color` crate detects true color support from these env vars.
 *   Without COLORTERM, shimmer animations and RGB blending fall back to
 *   256-color approximation via CIE76 color distance in Lab space.
 * - Focus events (CSI ? 1004 h) supported natively by xterm.js — Codex
 *   enables FocusChange tracking to re-query terminal palette colors on
 *   focus gain and to gate desktop notifications (only notify when unfocused).
 * - Synchronized output (CSI ? 2026 h) supported natively by xterm.js —
 *   Codex wraps draw calls in SynchronizedUpdate to prevent tearing. xterm.js
 *   buffers output when this mode is enabled and renders atomically.
 * - OSC 10/11 color queries: Codex's custom crossterm fork queries the
 *   terminal's actual foreground/background colors for adaptive light/dark
 *   theming. xterm.js does not respond to OSC 10/11 — Codex gracefully
 *   handles the case where no response arrives (falls back to default theme).
 * - Keyboard enhancement (CSI u / kitty protocol): Codex uses crossterm's
 *   PushKeyboardEnhancementFlags for modifier disambiguation. xterm.js does
 *   not support the kitty keyboard protocol — Codex gracefully degrades via
 *   `supports_keyboard_enhancement()` detection.
 * - Bracketed paste (CSI ? 2004 h) supported natively by xterm.js — Codex
 *   enables this for paste detection.
 * - Scrolling regions (DECSTBM) supported natively by xterm.js — used by
 *   Codex's inline viewport to scroll content without affecting terminal
 *   scrollback above.
 * - Cursor position report (CPR / DSR 6) supported by xterm.js — Codex
 *   uses this for inline viewport positioning.
 * - Mouse events NOT used by Codex — no mouse capture configuration needed.
 * - Inline images NOT used by Codex — ImageAddon already loaded for opencode.
 * - No specific cursor style set by Codex — current "bar" style is fine.
 * - Unicode box-drawing characters (e.g., "▌" for gutter prefix) handled
 *   correctly by the Unicode11 addon.
 * - WebGL renderer handles Codex's shimmer text animations (per-character
 *   RGB blending with time-based sweep) efficiently.
 * - All pre-existing features (WebGL, Unicode11, WebLinks, ImageAddon, flow
 *   control, 100K scrollback, 5ms coalescing) fully apply to Codex as well.
 *
 * Terminal fidelity — opencode TUI (Issue #124):
 * Verified and enhanced xterm.js rendering for opencode's full-screen TUI:
 * - COLORTERM=truecolor injected at PTY spawn — opencode checks this env
 *   var to decide whether to use 24-bit RGB colors. Without it, colors
 *   fall back to the nearest 256-color approximation.
 * - Image addon (@xterm/addon-image) loaded for inline image rendering.
 *   opencode supports drag-and-drop of images into the terminal prompt
 *   and may render inline image previews via iTerm2/Sixel protocols.
 * - Alternate screen buffer (smcup/rmcup) supported natively by xterm.js
 *   — opencode is a full-screen TUI that uses cursor positioning,
 *   alternate screen, and direct cursor movement for layout rendering.
 * - Mouse event passthrough to xterm.js — opencode uses scroll events
 *   and configurable scroll acceleration. xterm.js handles mouse
 *   tracking protocols (SGR, URXVT, etc.) transparently.
 * - cursorStyle "bar" matches opencode's default cursor appearance
 * - All pre-existing features (WebGL, Unicode11, WebLinks, flow control,
 *   100K scrollback, 5ms coalescing) fully apply to opencode as well.
 */

import { useAtomSet } from "@effect-atom/atom-react/Hooks";
import { FitAddon } from "@xterm/addon-fit";
import { ImageAddon } from "@xterm/addon-image";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { TerminalServiceClient } from "@/atoms/terminal-service-client";
import { Spinner } from "@/components/ui/spinner";
import {
	type TerminalStatus,
	useTerminalWebSocket,
} from "@/hooks/use-terminal-websocket";

/** Module-level mutation atom for terminal.resize — shared across all TerminalPane instances. */
const terminalResizeMutation =
	TerminalServiceClient.mutation("terminal.resize");

/**
 * Timeout for prefix mode (ms). Matches the SEQUENCE_TIMEOUT in panel-hotkeys.tsx
 * so that if the user presses Ctrl+B but doesn't follow up with an action key
 * within this window, prefix mode exits and the terminal resumes normal input.
 */
const PREFIX_MODE_TIMEOUT = 1500;

const isExactMetaW = (event: KeyboardEvent): boolean =>
	event.key === "w" &&
	event.metaKey &&
	!event.ctrlKey &&
	!event.shiftKey &&
	!event.altKey;

const isExactCtrlB = (event: KeyboardEvent): boolean =>
	event.key === "b" &&
	event.ctrlKey &&
	!event.shiftKey &&
	!event.altKey &&
	!event.metaKey;

interface TerminalPaneProps {
	/** The terminal ID to subscribe to for output events. */
	readonly terminalId: string;
}

/**
 * TerminalPane renders a live terminal view for a given terminal ID.
 *
 * It initializes an xterm.js Terminal, connects to the terminal service
 * via a dedicated WebSocket (`/terminal?id=<terminalId>`), and pipes
 * output directly to xterm.js. Keyboard input is sent as WebSocket text
 * frames.
 *
 * On reconnection (page reload), the server sends ring buffer scrollback
 * (up to 5MB) as initial text frames, restoring the terminal's recent
 * output history.
 *
 * Terminal status is derived from WebSocket control messages. When the
 * terminal process exits, a `{"type":"status","status":"stopped"}` message
 * is received and keyboard input is disabled. When the terminal is
 * restarted, a `{"type":"status","status":"restarted"}` message triggers
 * an xterm.js buffer clear.
 *
 * When the container is resized (by panel splits, window resize, etc.),
 * the fit addon recalculates cols/rows and the new dimensions are sent
 * to the server PTY via the `terminal.resize` RPC mutation. This ensures
 * the PTY sends SIGWINCH to the running process so it can reflow output.
 */
function TerminalPane({ terminalId }: TerminalPaneProps) {
	const resizeTerminal = useAtomSet(terminalResizeMutation);
	const containerRef = useRef<HTMLDivElement>(null);
	const terminalRef = useRef<Terminal | null>(null);
	const fitAddonRef = useRef<FitAddon | null>(null);

	/**
	 * Ref to hold the latest resizeTerminal function so the ResizeObserver
	 * callback always has access to the current mutation function.
	 */
	const resizeTerminalRef = useRef(resizeTerminal);
	resizeTerminalRef.current = resizeTerminal;

	/**
	 * Prefix mode state for keyboard shortcut scope isolation (Issue #80).
	 *
	 * When Ctrl+B is pressed inside the terminal, prefix mode activates.
	 * The next keypress is suppressed from the terminal and bubbles to
	 * document where TanStack Hotkeys catches it as the action key.
	 * Prefix mode auto-exits after PREFIX_MODE_TIMEOUT or after the
	 * action key is consumed.
	 */
	const [prefixMode, setPrefixMode] = useState(false);
	const prefixModeRef = useRef(false);
	const prefixTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	/**
	 * Loading state tracking (Issue #122).
	 *
	 * When the terminal pane first mounts, no output has arrived yet.
	 * `hasReceivedData` starts as `false` and flips to `true` on the
	 * first WebSocket data frame. A loading overlay is shown while false.
	 * Uses a ref for the hot-path check (every data frame) and state
	 * for React rendering.
	 */
	const [hasReceivedData, setHasReceivedData] = useState(false);
	const hasReceivedDataRef = useRef(false);

	/**
	 * Callback for terminal output data received via WebSocket.
	 * Writes raw UTF-8 data directly to xterm.js.
	 * On first data receipt, clears the loading overlay.
	 */
	const handleTerminalData = useCallback((data: string) => {
		const terminal = terminalRef.current;
		if (terminal) {
			terminal.write(data);
		}

		// Clear loading overlay on first data (Issue #122).
		// Ref check avoids calling setState on every subsequent data frame.
		if (!hasReceivedDataRef.current) {
			hasReceivedDataRef.current = true;
			setHasReceivedData(true);
		}
	}, []);

	/**
	 * Callback for terminal status control messages received via WebSocket.
	 * Handles "restarted" status by clearing the xterm.js buffer, replacing
	 * the previous LiveStore `v1.TerminalRestarted` event subscription.
	 *
	 * @see Issue #141: WebSocket-derived terminal status
	 */
	const handleTerminalStatus = useCallback(
		(status: TerminalStatus, _exitCode: number | undefined) => {
			if (status === "restarted") {
				const terminal = terminalRef.current;
				if (terminal) {
					terminal.clear();
				}
			}
		},
		[]
	);

	/**
	 * WebSocket connection to the terminal output endpoint.
	 * Provides: scrollback on connect, live output streaming, input via send(),
	 * terminal status via control messages.
	 *
	 * `terminalStatus` replaces the LiveStore `queryDb(terminals)` query
	 * for determining whether the terminal is running or stopped.
	 */
	const {
		send: wsSend,
		status: wsStatus,
		terminalStatus,
	} = useTerminalWebSocket({
		terminalId,
		onData: handleTerminalData,
		onStatus: handleTerminalStatus,
	});

	const isRunning = terminalStatus !== "stopped";

	/** Ref for isRunning so the xterm.js onData callback can check it. */
	const isRunningRef = useRef(isRunning);
	isRunningRef.current = isRunning;

	// Ref to hold latest wsSend for the xterm.js onData callback
	const wsSendRef = useRef(wsSend);
	wsSendRef.current = wsSend;

	/**
	 * Initialize xterm.js instance.
	 *
	 * Creates the Terminal, attaches addons (fit, WebGL), opens in the
	 * container, and wires keyboard input to WebSocket.
	 *
	 * Terminal restart is handled via WebSocket control messages (Issue #141)
	 * — no LiveStore event subscription needed.
	 */
	useEffect(() => {
		const container = containerRef.current;
		if (!container) {
			return;
		}

		// Create xterm.js Terminal instance
		const terminal = new Terminal({
			cursorBlink: true,
			cursorStyle: "bar",
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
			scrollback: 100_000,
			convertEol: false,
			allowProposedApi: true,
			fastScrollSensitivity: 5,
			scrollSensitivity: 3,
		});

		terminalRef.current = terminal;

		// Attach fit addon for responsive sizing
		const fitAddon = new FitAddon();
		terminal.loadAddon(fitAddon);
		fitAddonRef.current = fitAddon;

		// Open terminal in the container
		terminal.open(container);

		// Attempt WebGL rendering for better performance (GPU-accelerated).
		// Critical for scroll performance with 100k+ lines — WebGL renders
		// only visible rows via the GPU, avoiding DOM reflow on scroll.
		try {
			const webglAddon = new WebglAddon();
			webglAddon.onContextLoss(() => {
				webglAddon.dispose();
			});
			terminal.loadAddon(webglAddon);
		} catch {
			// WebGL not available — fall back to canvas renderer (default)
		}

		// Load Image addon for inline image rendering (Issue #124).
		// opencode supports drag-and-drop of images into the terminal and
		// may render inline image previews. The addon handles iTerm2 inline
		// image protocol (OSC 1337) and Sixel graphics. Images render
		// within the terminal cell grid. The addon requires WebGL or
		// canvas renderer — loaded after WebGL addon for best performance.
		try {
			const imageAddon = new ImageAddon();
			terminal.loadAddon(imageAddon);
		} catch {
			// Image addon failed to load — inline images not supported
		}

		// Load Unicode 11 addon for correct character width calculation.
		// Without this, CJK characters, emoji, and other wide Unicode
		// characters may be measured incorrectly, causing cursor misalignment
		// and rendering glitches — especially problematic in long terminal
		// output from AI agents that may include Unicode in their responses.
		try {
			const unicode11Addon = new Unicode11Addon();
			terminal.loadAddon(unicode11Addon);
			terminal.unicode.activeVersion = "11";
		} catch {
			// Unicode11 addon failed to load — default width calculation used
		}

		// Load Web Links addon for clickable URL detection (Issue #125).
		// Agent TUIs (Claude Code, opencode, codex) frequently output URLs
		// in their responses — file paths, documentation links, PR URLs.
		// Without this addon, URLs are plain text. With it, URLs are
		// auto-detected and rendered as clickable links that open in the
		// user's default browser. Uses Cmd+Click (macOS) / Ctrl+Click
		// (Linux/Windows) to avoid accidental activation during text selection.
		try {
			const webLinksAddon = new WebLinksAddon();
			terminal.loadAddon(webLinksAddon);
		} catch {
			// Web Links addon failed to load — URLs remain plain text
		}

		// Initial fit — also send dimensions to server PTY so it starts
		// with the correct size (or re-syncs on reconnection).
		try {
			fitAddon.fit();
			const { cols, rows } = terminal;
			if (cols > 0 && rows > 0) {
				resizeTerminalRef.current({
					payload: { id: terminalId, cols, rows },
				});
			}
		} catch {
			// Container may not have dimensions yet
		}

		// Keyboard shortcut scope isolation (Issue #80).
		//
		// xterm.js greedily captures all keyboard events within its canvas.
		// Panel shortcuts (Ctrl+B prefix sequences registered via TanStack
		// Hotkeys on `document`) would never fire because xterm.js consumes
		// the events before they bubble.
		//
		// `attachCustomKeyEventHandler` intercepts KeyboardEvent objects
		// before xterm.js processes them:
		// - Return `true` → xterm.js handles the key (normal terminal input)
		// - Return `false` → xterm.js ignores the key (it bubbles to document)
		//
		// When Ctrl+B is detected:
		// 1. Enter prefix mode (next key will also be passed through)
		// 2. Return `false` so Ctrl+B bubbles to TanStack Hotkeys as the
		//    first key of the sequence
		//
		// When in prefix mode and the next key arrives:
		// 1. Exit prefix mode
		// 2. Return `false` so the action key (H, V, X, O, P, D) bubbles
		//    to TanStack Hotkeys as the second key of the sequence
		//
		// After the action key (or PREFIX_MODE_TIMEOUT), all keys go to
		// the terminal again.
		terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
			// Only intercept keydown events — keyup should pass through
			// to avoid breaking key state tracking in the browser.
			if (event.type !== "keydown") {
				return true;
			}

			// Let Cmd+W bubble so the global close-pane hotkey can run.
			if (isExactMetaW(event)) {
				return false;
			}

			// Check for Ctrl+B (the panel prefix key).
			// Must be exactly Ctrl+B — not Ctrl+Shift+B, not Ctrl+Alt+B.
			if (isExactCtrlB(event)) {
				// Enter prefix mode: the next keydown will also be passed
				// through to TanStack Hotkeys.
				prefixModeRef.current = true;
				setPrefixMode(true);

				// Auto-exit prefix mode after timeout (matches SEQUENCE_TIMEOUT
				// in panel-hotkeys.tsx). If the user presses Ctrl+B but doesn't
				// follow up with an action key, the terminal resumes normal input.
				if (prefixTimeoutRef.current !== null) {
					clearTimeout(prefixTimeoutRef.current);
				}
				prefixTimeoutRef.current = setTimeout(() => {
					prefixModeRef.current = false;
					setPrefixMode(false);
					prefixTimeoutRef.current = null;
				}, PREFIX_MODE_TIMEOUT);

				// Let Ctrl+B bubble to document for TanStack Hotkeys
				return false;
			}

			// In prefix mode: pass the action key through to TanStack Hotkeys.
			// This is the second key in the Ctrl+B -> action sequence.
			if (prefixModeRef.current) {
				// Exit prefix mode — the action key has been consumed.
				prefixModeRef.current = false;
				setPrefixMode(false);
				if (prefixTimeoutRef.current !== null) {
					clearTimeout(prefixTimeoutRef.current);
					prefixTimeoutRef.current = null;
				}

				// Let the action key bubble to document
				return false;
			}

			// Normal key — let xterm.js handle it
			return true;
		});

		// Wire keyboard input to server PTY via WebSocket text frames.
		// xterm.js's onData fires for every keystroke (including special keys
		// like enter, backspace, ctrl-c, arrows) with the data already encoded
		// as the correct ANSI escape sequences. We send this data directly
		// to the server via WebSocket.
		//
		// Uses fire-and-forget mode — each keystroke is sent immediately as
		// a WebSocket text frame without waiting for a response.
		// The character echoes back from the PTY via WebSocket text frames,
		// completing the input -> output loop.
		//
		// Keyboard input is only sent when the terminal is running.
		// When the terminal has stopped, keystrokes are silently dropped.
		//
		// Note: Keys that were passed through to TanStack Hotkeys via the
		// custom key event handler (Ctrl+B and action keys) do NOT trigger
		// onData because xterm.js skips them when the handler returns false.
		const onDataDisposable = terminal.onData((data: string) => {
			if (!isRunningRef.current) {
				return;
			}
			wsSendRef.current(data);
		});

		// Cleanup on unmount
		return () => {
			onDataDisposable.dispose();
			terminal.dispose();
			terminalRef.current = null;
			fitAddonRef.current = null;
			// Clear prefix mode timeout to prevent stale state updates
			if (prefixTimeoutRef.current !== null) {
				clearTimeout(prefixTimeoutRef.current);
				prefixTimeoutRef.current = null;
			}
			prefixModeRef.current = false;
		};
	}, [terminalId]);

	/**
	 * Handle container resize — re-fit the terminal when the
	 * pane dimensions change, then send new dimensions to the
	 * server PTY via `terminal.resize` RPC mutation.
	 *
	 * The fit addon recalculates cols/rows based on the container
	 * size and font metrics. After fitting, we read the new dimensions
	 * from the xterm.js Terminal instance and dispatch a resize mutation.
	 * The server PTY sends SIGWINCH so the process can reflow output.
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
				payload: { id: terminalId, cols, rows },
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

			{/* Loading overlay (Issue #122) — shown while the PTY is spawning
			    and no output has arrived yet. Covers the blank terminal canvas
			    with a spinner and message. Disappears on first WebSocket data frame.
			    Only shown for running terminals (stopped terminals get immediate
			    scrollback on reconnection). */}
			{!hasReceivedData && isRunning && <TerminalLoadingOverlay />}

			{/* Prefix mode indicator (Issue #80) — shown when Ctrl+B was pressed
			    and the terminal is waiting for the next key to complete a panel
			    shortcut sequence. Positioned at top-left to avoid overlapping with
			    the PaneToolbar (top-right) and status banners (bottom). */}
			{prefixMode && (
				<div className="absolute top-1 left-1 z-20 rounded bg-primary/90 px-2 py-0.5 font-mono text-primary-foreground text-xs backdrop-blur-sm">
					Ctrl+B
				</div>
			)}

			{/* WebSocket disconnection indicator */}
			{wsStatus === "disconnected" && isRunning && <DisconnectedBanner />}

			{/* Reconnecting indicator */}
			{wsStatus === "connecting" && isRunning && <ReconnectingBanner />}

			{/* Status banner — shown when terminal process has exited */}
			{!isRunning && (
				<div className="absolute inset-x-0 bottom-0 border-border/50 border-t bg-muted/90 px-3 py-1.5 text-center text-muted-foreground text-xs backdrop-blur-sm">
					Process exited — terminal output preserved (read-only)
				</div>
			)}
		</div>
	);
}

/**
 * Loading overlay shown while waiting for the first terminal output data.
 * Covers the blank terminal canvas with a centered spinner and status message.
 * Uses the terminal's background color (zinc-950) to blend seamlessly.
 *
 * @see Issue #122: Loading state — terminal spawning
 */
function TerminalLoadingOverlay() {
	return (
		<div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background">
			<Spinner className="size-6 text-muted-foreground" />
			<p className="text-muted-foreground text-sm">Starting terminal...</p>
		</div>
	);
}

/** Banner shown when the WebSocket is disconnected but the terminal is still running. */
function DisconnectedBanner() {
	return (
		<div className="absolute inset-x-0 top-0 border-destructive/50 border-b bg-destructive/10 px-3 py-1 text-center text-destructive text-xs backdrop-blur-sm">
			Disconnected — reconnecting...
		</div>
	);
}

/** Banner shown while the WebSocket is reconnecting. */
function ReconnectingBanner() {
	return (
		<div className="absolute inset-x-0 top-0 border-warning/50 border-b bg-warning/10 px-3 py-1 text-center text-warning text-xs backdrop-blur-sm">
			Connecting...
		</div>
	);
}

export { TerminalPane };
