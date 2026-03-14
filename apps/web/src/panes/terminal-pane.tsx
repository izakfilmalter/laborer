/**
 * Terminal pane component — renders PTY output via ghostty-web using the
 * centralized TerminalSessionRouter for WebSocket stream management.
 *
 * Data flow:
 * 1. Terminal service PTY emits output via node-pty `onData`
 * 2. TerminalManager writes to headless terminal + notifies subscribers
 * 3. Terminal WebSocket route forwards data as text frames to connected clients
 * 4. TerminalSessionRouter receives frames and broadcasts to subscribers
 * 5. This component's subscriber callbacks write output to ghostty-web Terminal
 *
 * Input flow:
 * - Keystrokes captured by ghostty-web `onData` callback
 * - Sent via `router.sendInput()` as raw WebSocket text frames
 * - Terminal service WebSocket route forwards to PTY via PtyHostClient.write()
 *
 * Terminal status:
 * Terminal status is derived from WebSocket control messages parsed by
 * the TerminalSessionRouter. The `onStatus` subscriber callback updates
 * local state for UI decisions.
 *
 * Keyboard shortcut scope isolation (Issue #80):
 * - ghostty-web greedily captures all keyboard events within its container.
 * - `attachCustomKeyEventHandler` intercepts keyboard events before
 *   ghostty-web processes them, with the same bypass logic as before.
 * - Cmd+W, Cmd+Shift+Enter, and Ctrl+B prefix mode all work identically.
 *
 * Reconnection:
 * - TerminalSessionRouter manages WebSocket reconnection with exponential
 *   backoff (500ms initial, 30s max, 3 consecutive failure limit)
 * - Server sends compact screen state snapshot (~4KB) on connect
 * - Screen state is cached by the router for late subscribers
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
 * @see apps/web/src/lib/terminal-session-router.ts — TerminalSessionRouter class
 * @see apps/web/src/contexts/terminal-router-context.tsx — React context provider
 */

import { useAtomSet } from '@effect-atom/atom-react/Hooks'
import { FitAddon, init, Terminal } from 'ghostty-web'
import { useCallback, useEffect, useRef, useState } from 'react'
import { TerminalServiceClient } from '@/atoms/terminal-service-client'
import { Spinner } from '@/components/ui/spinner'
import { useTerminalRouter } from '@/contexts/terminal-router-context'
import type { TerminalStatus } from '@/lib/terminal-session-router'
import { isExactCtrlB, shouldBypassTerminal } from '@/panes/terminal-keys'

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
 * NOTE: The previous RESIZE_DEBOUNCE_MS (100ms setTimeout) has been replaced
 * by requestAnimationFrame batching in the PTY-first resize handler.
 * RAF naturally coalesces rapid resize events into single frames (~16ms)
 * while the in-flight/pending coalescing ensures at most one RPC call
 * is active at a time. This provides better responsiveness than a fixed
 * 100ms debounce during panel drag operations.
 */

/**
 * State for the PTY-first resize coalescing logic.
 *
 * Tracks in-flight resize requests and deduplication dimensions so that
 * at most one RPC call is active at a time, and rapid resize events
 * during panel drag are collapsed into at most two resizes.
 */
interface ResizeCoalesceState {
  /** Whether a resize RPC is currently in-flight. */
  inFlight: boolean
  /** Last cols sent to the backend (for deduplication). */
  lastCols: number
  /** Last rows sent to the backend (for deduplication). */
  lastRows: number
  /** Whether another resize was requested while one was in-flight. */
  pending: boolean
  /** ID of the pending requestAnimationFrame (for cancellation). */
  rafId: number | null
}

/**
 * Execute the PTY-first resize: proposeDimensions → RPC → terminal.resize.
 *
 * Calculates desired dimensions without applying them, sends to the backend
 * PTY via RPC (waits for confirmation), then resizes the frontend terminal
 * to match. This eliminates the race where shell output formatted for old
 * dimensions gets displayed in an already-resized frontend terminal.
 */
async function executePtyFirstResize(
  fitAddon: FitAddon,
  terminal: Terminal,
  terminalId: string,
  resizeFn: (arg: {
    payload: { id: string; cols: number; rows: number }
  }) => Promise<unknown>,
  state: ResizeCoalesceState,
  disposed: { current: boolean }
): Promise<void> {
  // Step 1: Calculate what size we want without applying it yet.
  let proposed: { cols: number; rows: number } | undefined
  try {
    proposed = fitAddon.proposeDimensions()
  } catch {
    return
  }
  if (!proposed || proposed.cols <= 0 || proposed.rows <= 0) {
    return
  }

  const { cols, rows } = proposed

  // Deduplicate — skip if dimensions haven't changed
  if (cols === state.lastCols && rows === state.lastRows) {
    return
  }

  // Record the requested dimensions for deduplication
  state.lastCols = cols
  state.lastRows = rows

  try {
    // Step 2: Resize PTY first — wait for backend to confirm.
    await resizeFn({ payload: { id: terminalId, cols, rows } })

    if (disposed.current) {
      return
    }

    // Step 3: Resize frontend to match the PTY exactly.
    terminal.resize(cols, rows)
  } catch {
    // Allow future retries if the resize call failed.
    state.lastCols = 0
    state.lastRows = 0
  }
}

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
 * canvas renderer), subscribes to the TerminalSessionRouter for WebSocket
 * stream management, and pipes output directly to ghostty-web. Keyboard
 * input is sent via `router.sendInput()`.
 *
 * On reconnection (page reload), the router delivers a cached screen state
 * snapshot (~4KB) immediately to late subscribers without a server round-trip.
 *
 * Terminal status is derived from router subscriber callbacks. When the
 * terminal process exits, keyboard input is disabled. When the terminal
 * is restarted, the buffer is cleared.
 *
 * PTY-first resize flow:
 * When the container is resized (by panel splits, window resize, etc.),
 * the fit addon's `proposeDimensions()` calculates desired cols/rows
 * WITHOUT applying them. The new dimensions are sent to the backend PTY
 * via RPC, and only after the backend confirms does the frontend terminal
 * resize to match. This prevents output clobbering where shell output
 * formatted for old dimensions gets displayed in an already-resized
 * frontend terminal. Rapid resize events during panel drag are coalesced
 * (one in-flight RPC at a time, pending flag for the next).
 */
function TerminalPane({ terminalId, onTerminalExit }: TerminalPaneProps) {
  const router = useTerminalRouter()
  const resizeTerminal = useAtomSet(terminalResizeMutation, {
    mode: 'promise',
  })
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
   * first data (output or screenState). A loading overlay is shown while false.
   * Uses a ref for the hot-path check (every data frame) and state
   * for React rendering.
   */
  const [hasReceivedData, setHasReceivedData] = useState(false)
  const hasReceivedDataRef = useRef(false)

  /**
   * Connection and terminal status state.
   *
   * Updated by the router's subscriber callbacks. The connection status
   * is polled from the router on status changes (since the router manages
   * it per-session rather than broadcasting). The terminal status is
   * delivered via the onStatus callback.
   */
  const [connectionStatus, setConnectionStatus] = useState<
    'connecting' | 'connected' | 'disconnected'
  >('connecting')
  const [terminalStatus, setTerminalStatus] =
    useState<TerminalStatus>('running')

  const isRunning = terminalStatus !== 'stopped'

  /** Ref for isRunning so the onData callback can check it. */
  const isRunningRef = useRef(isRunning)
  isRunningRef.current = isRunning

  /** Ref for router so the onData callback can send input without stale closures. */
  const routerRef = useRef(router)
  routerRef.current = router

  /** Ref for onTerminalExit to avoid stale closures in subscriber callbacks. */
  const onTerminalExitRef = useRef(onTerminalExit)
  onTerminalExitRef.current = onTerminalExit

  /**
   * Mark data as received — clears the loading overlay.
   * Uses a ref for the hot-path check (every data frame) to avoid
   * calling setState on every subsequent frame.
   */
  const markDataReceived = useCallback(() => {
    if (!hasReceivedDataRef.current) {
      hasReceivedDataRef.current = true
      setHasReceivedData(true)
    }
  }, [])

  /**
   * Subscribe to the TerminalSessionRouter for this terminal's output.
   *
   * The router enforces one WebSocket per terminal ID. When the component
   * subscribes, the router either creates a new session (first subscriber)
   * or reuses an existing one. Cached screen state is delivered immediately
   * to late subscribers via setTimeout(0).
   *
   * On unmount, the unsubscribe function is called. If this is the last
   * subscriber, the router tears down the session (closes WebSocket).
   */
  useEffect(() => {
    if (!router) {
      // Router not available (server reconnecting). Update connection
      // status to reflect the disconnected state.
      setConnectionStatus('disconnected')
      return
    }

    // Update connection status from the router's current state for this terminal.
    // The router tracks connection status per-session.
    const updateConnectionStatus = () => {
      setConnectionStatus(router.getConnectionStatus(terminalId))
    }

    // Initial connection status
    updateConnectionStatus()

    const unsubscribe = router.subscribe(terminalId, {
      onOutput: (data: string) => {
        const terminal = terminalRef.current
        if (terminal) {
          terminal.write(data)
        }
        markDataReceived()
        // Update connection status — if we're getting output, we're connected
        setConnectionStatus('connected')
      },
      onScreenState: (state: string) => {
        const terminal = terminalRef.current
        if (terminal) {
          // Clear the terminal before writing screen state to avoid
          // duplicating content on reconnection.
          terminal.clear()
          terminal.write(state)
        }
        markDataReceived()
        setConnectionStatus('connected')
      },
      onStatus: (status: TerminalStatus, _exitCode: number | undefined) => {
        setTerminalStatus(status)
        updateConnectionStatus()

        if (status === 'restarted') {
          const terminal = terminalRef.current
          if (terminal) {
            terminal.clear()
          }
          // Reset loading state on restart — new output will arrive
          hasReceivedDataRef.current = false
          setHasReceivedData(false)
        }
        if (status === 'stopped') {
          onTerminalExitRef.current?.()
        }
      },
    })

    return unsubscribe
  }, [router, terminalId, markDataReceived])

  /**
   * Initialize ghostty-web terminal instance.
   *
   * Waits for WASM to load, creates the Terminal, loads the FitAddon,
   * opens in the container, and wires keyboard input to the router.
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

      // Create ghostty-web Terminal instance with full visual config.
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

      // Wire keyboard input to server PTY via the TerminalSessionRouter.
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
        routerRef.current?.sendInput(terminalId, data)
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
   * PTY-first resize with coalescing.
   *
   * Observes the container for size changes and implements a three-step
   * resize flow that prevents output clobbering:
   *
   * 1. `proposeDimensions()` — calculate desired cols/rows WITHOUT
   *    applying them to the terminal (read-only measurement)
   * 2. `await resizeTerminal()` — send dimensions to backend PTY via RPC
   *    and wait for confirmation (PTY sends SIGWINCH to the process)
   * 3. `terminal.resize(cols, rows)` — apply the confirmed dimensions
   *    to the frontend terminal
   *
   * Coalescing ensures at most one RPC call is in-flight at a time.
   * If a resize event arrives while one is in-flight, it sets a pending
   * flag. When the in-flight resize completes, the pending resize is
   * processed with fresh `proposeDimensions()` (not stale captured values).
   *
   * The initial fit on mount uses `fit()` directly (acceptable since
   * there is no PTY output race at initialization time).
   */
  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }

    const state: ResizeCoalesceState = {
      inFlight: false,
      lastCols: 0,
      lastRows: 0,
      pending: false,
      rafId: null,
    }
    const disposed = { current: false }

    /**
     * Coalescing resize handler.
     *
     * If a resize is already in-flight, sets a pending flag instead of
     * starting a new one. Uses requestAnimationFrame to batch rapid
     * resize events (e.g., during panel drag) into a single frame.
     */
    const handleResize = () => {
      if (disposed.current) {
        return
      }

      // If a resize is already in flight, mark that we need another one
      if (state.inFlight) {
        state.pending = true
        return
      }

      const fitAddon = fitAddonRef.current
      const terminal = terminalRef.current
      if (!(fitAddon && terminal)) {
        return
      }

      state.inFlight = true
      state.pending = false

      // Use RAF to batch rapid resize events
      if (state.rafId !== null) {
        cancelAnimationFrame(state.rafId)
      }

      state.rafId = requestAnimationFrame(() => {
        state.rafId = null

        executePtyFirstResize(
          fitAddon,
          terminal,
          terminalId,
          resizeTerminalRef.current,
          state,
          disposed
        ).finally(() => {
          state.inFlight = false
          // If another resize was requested while we were busy, handle it.
          // This re-calls proposeDimensions() for fresh dimensions.
          if (state.pending && !disposed.current) {
            handleResize()
          }
        })
      })
    }

    const resizeObserver = new ResizeObserver(handleResize)
    resizeObserver.observe(container)

    return () => {
      disposed.current = true
      if (state.rafId !== null) {
        cancelAnimationFrame(state.rafId)
      }
      resizeObserver.disconnect()
    }
  }, [terminalId])

  return (
    <div
      className="relative h-full w-full overflow-hidden"
      data-terminal-id={terminalId}
    >
      {/* ghostty-web terminal container */}
      <div className="h-full w-full" ref={containerRef} />

      {/* Loading overlay (Issue #122) — shown while the PTY is spawning
			    and no output has arrived yet. Covers the blank terminal canvas
			    with a spinner and message. Disappears on first data (output or
			    screenState). Only shown for running terminals (stopped terminals
			    get immediate screen state on reconnection). */}
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
      {connectionStatus === 'disconnected' && isRunning && (
        <DisconnectedBanner />
      )}

      {/* Reconnecting indicator */}
      {connectionStatus === 'connecting' && isRunning && <ReconnectingBanner />}

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
