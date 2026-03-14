/**
 * Terminal pane component — renders PTY output via ghostty-web using a
 * dedicated WebSocket connection for terminal data.
 *
 * Data flow:
 * 1. Terminal service PTY emits output via node-pty `onData`
 * 2. TerminalManager writes to headless terminal + notifies subscribers
 * 3. Terminal WebSocket route forwards data as text frames to connected clients
 * 4. This component receives text frames via `useTerminalWebSocket` hook
 * 5. Output is written directly to ghostty-web Terminal instance
 *
 * Input flow:
 * - Keystrokes captured by ghostty-web `onData` callback
 * - Sent as raw WebSocket text frames (NOT via terminal.write RPC)
 * - Terminal service WebSocket route forwards to PTY via PtyHostClient.write()
 *
 * Terminal status:
 * Terminal status is derived from WebSocket control messages sent by
 * the terminal service. The `useTerminalWebSocket` hook parses these
 * messages and exposes `terminalStatus` for UI decisions.
 *
 * Keyboard shortcut scope isolation (Issue #80):
 * - ghostty-web greedily captures all keyboard events within its container.
 * - `attachCustomKeyEventHandler` intercepts keyboard events before
 *   ghostty-web processes them, with the same bypass logic as before.
 * - Cmd+W, Cmd+Shift+Enter, and Ctrl+B prefix mode all work identically.
 *
 * Reconnection:
 * - On page reload or network disruption, the WebSocket reconnects with
 *   exponential backoff
 * - Server sends compact screen state snapshot (~4KB) on connect
 * - New live output continues streaming after screen state
 *
 * Rendering:
 * - ghostty-web uses Ghostty's WASM-compiled VT100 parser with a
 *   60fps canvas renderer (~400KB bundle)
 * - Handles Unicode 15.1, link detection, and keyboard input natively
 *   without separate addons
 * - No WebGL dependency — canvas-based rendering is the default
 *
 * @see packages/terminal/src/routes/terminal-ws.ts — WebSocket endpoint
 * @see packages/terminal/src/services/terminal-manager.ts — headless terminal + subscribers
 * @see apps/web/src/hooks/use-terminal-websocket.ts — WebSocket hook
 */

import { useAtomSet } from '@effect-atom/atom-react/Hooks'
import { FitAddon, init, Terminal } from 'ghostty-web'
import { useCallback, useEffect, useRef, useState } from 'react'
import { TerminalServiceClient } from '@/atoms/terminal-service-client'
import { Spinner } from '@/components/ui/spinner'
import {
  type TerminalStatus,
  useTerminalWebSocket,
} from '@/hooks/use-terminal-websocket'

/**
 * Module-level WASM initialization promise.
 * ghostty-web's init() is idempotent — safe to call multiple times.
 * This ensures the WASM module is loaded before any terminal is created.
 */
const wasmReady = init()

/** Module-level mutation atom for terminal.resize — shared across all TerminalPane instances. */
const terminalResizeMutation = TerminalServiceClient.mutation('terminal.resize')

/**
 * Timeout for prefix mode (ms). Matches the SEQUENCE_TIMEOUT in panel-hotkeys.tsx
 * so that if the user presses Ctrl+B but doesn't follow up with an action key
 * within this window, prefix mode exits and the terminal resumes normal input.
 */
const PREFIX_MODE_TIMEOUT = 1500

/**
 * Debounce delay for ResizeObserver callbacks (ms).
 *
 * During panel drag-resizing, the ResizeObserver fires at up to 60fps.
 * Without debouncing, each observation triggers `fitAddon.fit()` (which
 * measures the DOM) and a `terminal.resize` RPC call (which sends a
 * command through: RPC → terminal service → PTY Host → pty.resize() →
 * SIGWINCH). This floods the event loop and network with unnecessary
 * resize operations.
 *
 * VS Code uses a 100ms debounce for horizontal resizes (which trigger
 * text reflow) and applies vertical resizes immediately (cheap). We use
 * a simpler 100ms debounce for all resizes since the fit addon handles
 * both dimensions together.
 */
const RESIZE_DEBOUNCE_MS = 100

import { isExactCtrlB, shouldBypassTerminal } from '@/panes/terminal-keys'

interface TerminalPaneProps {
  /**
   * Callback invoked when the terminal process exits (status becomes "stopped").
   * Used by the panel system to auto-close the pane when a terminal is closed.
   */
  readonly onTerminalExit?: (() => void) | undefined
  /** The terminal ID to subscribe to for output events. */
  readonly terminalId: string
}

/**
 * TerminalPane renders a live terminal view for a given terminal ID.
 *
 * It initializes a ghostty-web Terminal (WASM-based VT100 parser with
 * canvas renderer), connects to the terminal service via a dedicated
 * WebSocket (`/terminal?id=<terminalId>`), and pipes output directly
 * to ghostty-web. Keyboard input is sent as WebSocket text frames.
 *
 * On reconnection (page reload), the server sends a compact screen state
 * snapshot (~4KB) as the first data frame, restoring the terminal's
 * current screen near-instantaneously.
 *
 * Terminal status is derived from WebSocket control messages. When the
 * terminal process exits, keyboard input is disabled. When the terminal
 * is restarted, the buffer is cleared.
 *
 * When the container is resized (by panel splits, window resize, etc.),
 * the fit addon recalculates cols/rows and the new dimensions are sent
 * to the server PTY via the `terminal.resize` RPC mutation. This ensures
 * the PTY sends SIGWINCH to the running process so it can reflow output.
 */
function TerminalPane({ terminalId, onTerminalExit }: TerminalPaneProps) {
  const resizeTerminal = useAtomSet(terminalResizeMutation)
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const cleanupRef = useRef<(() => void) | null>(null)

  /**
   * Ref to hold the latest resizeTerminal function so the ResizeObserver
   * callback always has access to the current mutation function.
   */
  const resizeTerminalRef = useRef(resizeTerminal)
  resizeTerminalRef.current = resizeTerminal

  /**
   * Prefix mode state for keyboard shortcut scope isolation (Issue #80).
   *
   * When Ctrl+B is pressed inside the terminal, prefix mode activates.
   * The next keypress is suppressed from the terminal and bubbles to
   * document where TanStack Hotkeys catches it as the action key.
   * Prefix mode auto-exits after PREFIX_MODE_TIMEOUT or after the
   * action key is consumed.
   */
  const [prefixMode, setPrefixMode] = useState(false)
  const prefixModeRef = useRef(false)
  const prefixTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /**
   * Loading state tracking (Issue #122).
   *
   * When the terminal pane first mounts, no output has arrived yet.
   * `hasReceivedData` starts as `false` and flips to `true` on the
   * first WebSocket data frame. A loading overlay is shown while false.
   * Uses a ref for the hot-path check (every data frame) and state
   * for React rendering.
   */
  const [hasReceivedData, setHasReceivedData] = useState(false)
  const hasReceivedDataRef = useRef(false)

  /**
   * Callback for terminal output data received via WebSocket.
   * Writes raw UTF-8 data directly to ghostty-web.
   * On first data receipt, clears the loading overlay.
   */
  const handleTerminalData = useCallback((data: string) => {
    const terminal = terminalRef.current
    if (terminal) {
      terminal.write(data)
    }

    // Clear loading overlay on first data (Issue #122).
    // Ref check avoids calling setState on every subsequent data frame.
    if (!hasReceivedDataRef.current) {
      hasReceivedDataRef.current = true
      setHasReceivedData(true)
    }
  }, [])

  /**
   * Callback for terminal status control messages received via WebSocket.
   * Handles "restarted" status by clearing the ghostty-web buffer.
   * Handles "stopped" status by invoking onTerminalExit to auto-close the pane.
   */
  const handleTerminalStatus = useCallback(
    (status: TerminalStatus, _exitCode: number | undefined) => {
      if (status === 'restarted') {
        const terminal = terminalRef.current
        if (terminal) {
          terminal.clear()
        }
      }
      if (status === 'stopped') {
        onTerminalExit?.()
      }
    },
    [onTerminalExit]
  )

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
  })

  const isRunning = terminalStatus !== 'stopped'

  /** Ref for isRunning so the onData callback can check it. */
  const isRunningRef = useRef(isRunning)
  isRunningRef.current = isRunning

  // Ref to hold latest wsSend for the onData callback
  const wsSendRef = useRef(wsSend)
  wsSendRef.current = wsSend

  /**
   * Initialize ghostty-web terminal instance.
   *
   * Waits for WASM to load, creates the Terminal, loads the FitAddon,
   * opens in the container, and wires keyboard input to WebSocket.
   *
   * ghostty-web handles Unicode 15.1, link detection, and canvas
   * rendering natively — no separate addons needed for WebGL, Image,
   * Unicode, or WebLinks.
   */
  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }

    let disposed = false

    const setup = async () => {
      // Wait for WASM to be ready (idempotent — resolves immediately
      // if already initialized)
      await wasmReady

      if (disposed) {
        return
      }

      // Create ghostty-web Terminal instance with minimal config.
      // Theme, font, cursor, links, and other visual configuration
      // are applied in later issues (#3, #5).
      const terminal = new Terminal({
        cursorBlink: true,
        cursorStyle: 'bar',
        fontFamily:
          '"JetBrains Mono", "Fira Code", "Cascadia Code", Menlo, Monaco, "Courier New", monospace',
        fontSize: 13,
        theme: {
          background: '#09090b', // zinc-950 — matches dark theme
          foreground: '#fafafa', // zinc-50
          cursor: '#fafafa',
          cursorAccent: '#09090b',
          selectionBackground: '#27272a80', // zinc-800 with alpha
          black: '#09090b',
          red: '#ef4444',
          green: '#22c55e',
          yellow: '#eab308',
          blue: '#3b82f6',
          magenta: '#a855f7',
          cyan: '#06b6d4',
          white: '#fafafa',
          brightBlack: '#52525b',
          brightRed: '#f87171',
          brightGreen: '#4ade80',
          brightYellow: '#facc15',
          brightBlue: '#60a5fa',
          brightMagenta: '#c084fc',
          brightCyan: '#22d3ee',
          brightWhite: '#ffffff',
        },
        scrollback: 100_000,
        convertEol: false,
      })

      if (disposed) {
        terminal.dispose()
        return
      }

      terminalRef.current = terminal

      // Attach fit addon for responsive sizing
      const fitAddon = new FitAddon()
      terminal.loadAddon(fitAddon)
      fitAddonRef.current = fitAddon

      // Hide the browser's native contenteditable caret.
      // ghostty-web uses a contenteditable element for input capture,
      // but we render our own cursor via the canvas renderer.
      container.style.caretColor = 'transparent'

      // Open terminal in the container — mounts the canvas
      terminal.open(container)

      // Initial fit — also send dimensions to server PTY so it starts
      // with the correct size (or re-syncs on reconnection).
      try {
        fitAddon.fit()
        const { cols, rows } = terminal
        if (cols > 0 && rows > 0) {
          resizeTerminalRef.current({
            payload: { id: terminalId, cols, rows },
          })
        }
      } catch {
        // Container may not have dimensions yet
      }

      // Keyboard shortcut scope isolation (Issue #80).
      //
      // ghostty-web captures keyboard events within its container.
      // `attachCustomKeyEventHandler` intercepts KeyboardEvent objects
      // before ghostty-web processes them:
      // - Return `true` → ghostty-web handles the key (normal terminal input)
      // - Return `false` → ghostty-web ignores the key (it bubbles to document)
      const enterPrefixMode = () => {
        prefixModeRef.current = true
        setPrefixMode(true)
        if (prefixTimeoutRef.current !== null) {
          clearTimeout(prefixTimeoutRef.current)
        }
        prefixTimeoutRef.current = setTimeout(() => {
          prefixModeRef.current = false
          setPrefixMode(false)
          prefixTimeoutRef.current = null
        }, PREFIX_MODE_TIMEOUT)
      }

      const exitPrefixMode = () => {
        prefixModeRef.current = false
        setPrefixMode(false)
        if (prefixTimeoutRef.current !== null) {
          clearTimeout(prefixTimeoutRef.current)
          prefixTimeoutRef.current = null
        }
      }

      terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
        // Only intercept keydown events — keyup should pass through
        // to avoid breaking key state tracking in the browser.
        if (event.type !== 'keydown') {
          return true
        }

        // Let global shortcuts (Cmd+W, Cmd+Shift+Enter) bubble to
        // TanStack Hotkeys on document.
        if (shouldBypassTerminal(event)) {
          // Ctrl+B additionally enters prefix mode for tmux-style sequences.
          if (isExactCtrlB(event)) {
            enterPrefixMode()
          }
          return false
        }

        // In prefix mode: pass the action key through to TanStack Hotkeys.
        // This is the second key in the Ctrl+B -> action sequence.
        if (prefixModeRef.current) {
          exitPrefixMode()
          return false
        }

        // Normal key — let ghostty-web handle it
        return true
      })

      // Wire keyboard input to server PTY via WebSocket text frames.
      // ghostty-web's onData fires for every keystroke (including special
      // keys like enter, backspace, ctrl-c, arrows) with the data already
      // encoded as the correct ANSI escape sequences.
      //
      // Keyboard input is only sent when the terminal is running.
      // When the terminal has stopped, keystrokes are silently dropped.
      const onDataDisposable = terminal.onData((data: string) => {
        if (!isRunningRef.current) {
          return
        }
        wsSendRef.current(data)
      })

      // Store cleanup function for disposal
      cleanupRef.current = () => {
        onDataDisposable.dispose()
        terminal.dispose()
        terminalRef.current = null
        fitAddonRef.current = null
        // Clear prefix mode timeout to prevent stale state updates
        if (prefixTimeoutRef.current !== null) {
          clearTimeout(prefixTimeoutRef.current)
          prefixTimeoutRef.current = null
        }
        prefixModeRef.current = false
      }
    }

    setup()

    // Cleanup on unmount
    return () => {
      disposed = true
      cleanupRef.current?.()
      cleanupRef.current = null
    }
  }, [terminalId])

  /**
   * Handle container resize — re-fit the terminal when the
   * pane dimensions change, then send new dimensions to the
   * server PTY via `terminal.resize` RPC mutation.
   *
   * The fit addon recalculates cols/rows based on the container
   * size and font metrics. After fitting, we read the new dimensions
   * from the ghostty-web Terminal instance and dispatch a resize mutation.
   * The server PTY sends SIGWINCH so the process can reflow output.
   */
  const handleResize = useCallback(() => {
    const fitAddon = fitAddonRef.current
    const terminal = terminalRef.current
    if (!(fitAddon && terminal)) {
      return
    }

    try {
      fitAddon.fit()
    } catch {
      // Ignore errors during resize (container may have 0 dimensions)
      return
    }

    // Send new dimensions to the server PTY
    const { cols, rows } = terminal
    if (cols > 0 && rows > 0) {
      resizeTerminalRef.current({
        payload: { id: terminalId, cols, rows },
      })
    }
  }, [terminalId])

  /**
   * Observe the container element for size changes using ResizeObserver.
   * This handles allotment pane resizing, window resizing, etc.
   *
   * Debounced at 100ms to avoid flooding the resize RPC during drag
   * operations. Without debouncing, the ResizeObserver fires at up to
   * 60fps, each triggering fitAddon.fit() + an RPC round-trip.
   */
  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }

    let resizeTimer: ReturnType<typeof setTimeout> | null = null

    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimer !== null) {
        clearTimeout(resizeTimer)
      }
      resizeTimer = setTimeout(() => {
        resizeTimer = null
        handleResize()
      }, RESIZE_DEBOUNCE_MS)
    })

    resizeObserver.observe(container)

    return () => {
      if (resizeTimer !== null) {
        clearTimeout(resizeTimer)
      }
      resizeObserver.disconnect()
    }
  }, [handleResize])

  return (
    <div
      className="relative h-full w-full overflow-hidden"
      data-terminal-id={terminalId}
    >
      {/* ghostty-web terminal container */}
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
      {wsStatus === 'disconnected' && isRunning && <DisconnectedBanner />}

      {/* Reconnecting indicator */}
      {wsStatus === 'connecting' && isRunning && <ReconnectingBanner />}

      {/* Status banner — shown when terminal process has exited */}
      {!isRunning && (
        <div className="absolute inset-x-0 bottom-0 border-border/50 border-t bg-muted/90 px-3 py-1.5 text-center text-muted-foreground text-xs backdrop-blur-sm">
          Process exited — terminal output preserved (read-only)
        </div>
      )}
    </div>
  )
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
  )
}

/** Banner shown when the WebSocket is disconnected but the terminal is still running. */
function DisconnectedBanner() {
  return (
    <div className="absolute inset-x-0 top-0 border-destructive/50 border-b bg-destructive/10 px-3 py-1 text-center text-destructive text-xs backdrop-blur-sm">
      Disconnected — reconnecting...
    </div>
  )
}

/** Banner shown while the WebSocket is reconnecting. */
function ReconnectingBanner() {
  return (
    <div className="absolute inset-x-0 top-0 border-warning/50 border-b bg-warning/10 px-3 py-1 text-center text-warning text-xs backdrop-blur-sm">
      Connecting...
    </div>
  )
}

export { TerminalPane }
