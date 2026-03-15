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
import { LifecyclePhase } from '@/components/lifecycle-phase-context'
import { Spinner } from '@/components/ui/spinner'
import { useTerminalRouter } from '@/contexts/terminal-router-context'
import { useWhenPhase } from '@/hooks/use-when-phase'
import { subscribeWindowResize } from '@/hooks/use-window-resize'
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
 * State for resize deduplication and RAF batching.
 */
interface ResizeState {
  /** Last cols sent to the backend (for deduplication). */
  lastCols: number
  /** Last rows sent to the backend (for deduplication). */
  lastRows: number
  /** ID of the pending requestAnimationFrame (for cancellation). */
  rafId: number | null
}

/**
 * Execute a fit-first resize: fit terminal to container, then notify PTY.
 *
 * Fits the terminal to its container (calculating cols/rows from the
 * container's dimensions), then sends the new dimensions to the backend
 * PTY as a fire-and-forget RPC. The PTY sends SIGWINCH so the shell
 * process can reflow its output.
 */
function executeResize(
  fitAddon: FitAddon,
  terminal: Terminal,
  terminalId: string,
  resizeFn: (arg: {
    payload: { id: string; cols: number; rows: number }
  }) => void,
  state: ResizeState
): void {
  try {
    fitAddon.fit()
  } catch {
    return
  }

  const { cols, rows } = terminal
  if (cols <= 0 || rows <= 0) {
    return
  }

  if (cols === state.lastCols && rows === state.lastRows) {
    return
  }

  state.lastCols = cols
  state.lastRows = rows

  resizeFn({ payload: { id: terminalId, cols, rows } })
}

interface TerminalPaneProps {
  /**
   * Callback invoked when the terminal process exits (status becomes "stopped").
   * Used by the panel system to auto-close the pane when a terminal is closed.
   */
  readonly onTerminalExit?: (() => void) | undefined
  /**
   * Callback invoked when the terminal's title changes via OSC 0 or OSC 2
   * escape sequences (e.g., shell prompt sets window title). The title string
   * is the parsed value from the escape sequence.
   */
  readonly onTitleChange?: ((title: string) => void) | undefined
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
 * Resize flow:
 * When the container is resized (by panel splits, window resize, etc.),
 * `fitAddon.fit()` calculates cols/rows from the container dimensions
 * and resizes the terminal canvas in one step. The new dimensions are
 * then sent to the backend PTY as a fire-and-forget RPC (no awaiting).
 * The PTY sends SIGWINCH so the shell process can reflow its output.
 * Rapid resize events are coalesced via requestAnimationFrame.
 */
function TerminalPane({
  terminalId,
  onTerminalExit,
  onTitleChange,
}: TerminalPaneProps) {
  const isRestored = useWhenPhase(LifecyclePhase.Restored)

  if (!isRestored) {
    return <TerminalConnectingPlaceholder />
  }

  return (
    <TerminalPaneContent
      onTerminalExit={onTerminalExit}
      onTitleChange={onTitleChange}
      terminalId={terminalId}
    />
  )
}

/**
 * Placeholder shown when the terminal service is still connecting (before
 * Phase 3 / Restored). Shows a spinner and message explaining the state.
 *
 * @see Issue #12: Progressive feature enablement for Phases 3-4
 */
function TerminalConnectingPlaceholder() {
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-3 bg-background"
      data-testid="terminal-connecting-placeholder"
    >
      <Spinner className="size-6 text-muted-foreground" />
      <p className="text-muted-foreground text-sm">
        Terminal service connecting...
      </p>
    </div>
  )
}

/**
 * Inner terminal pane component — only rendered after Phase 3 (Restored)
 * when the terminal sidecar is available.
 */
function TerminalPaneContent({
  terminalId,
  onTerminalExit,
  onTitleChange,
}: TerminalPaneProps) {
  const router = useTerminalRouter()
  const resizeTerminal = useAtomSet(terminalResizeMutation)
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const cleanupRef = useRef<(() => void) | null>(null)

  /**
   * Ref to hold the resize handler so it can be called from the terminal
   * setup effect after initialization completes. The resize observer
   * effect creates the handler and stores it here; the setup effect
   * calls it after fit() to ensure the initial dimensions are sent.
   */
  const handleResizeRef = useRef<(() => void) | null>(null)

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
   *
   * The spinner display is delayed by 200ms (`showSpinner`) so that
   * fast-loading terminals don't flash the loading overlay.
   */
  const [hasReceivedData, setHasReceivedData] = useState(false)
  const hasReceivedDataRef = useRef(false)
  const [showSpinner, setShowSpinner] = useState(false)

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

  /** Ref for onTitleChange to avoid stale closures in terminal event callbacks. */
  const onTitleChangeRef = useRef(onTitleChange)
  onTitleChangeRef.current = onTitleChange

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
   * Delay showing the loading spinner by 200ms so that fast-loading
   * terminals (e.g., reconnections with cached screen state) never
   * flash the overlay. If data arrives within the delay, the spinner
   * is never shown.
   */
  useEffect(() => {
    if (hasReceivedData) {
      setShowSpinner(false)
      return
    }
    const timer = setTimeout(() => {
      setShowSpinner(true)
    }, 200)
    return () => {
      clearTimeout(timer)
    }
  }, [hasReceivedData])

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
          try {
            terminal.write(data)
          } catch (err) {
            // ghostty-web WASM can throw RangeError intermittently
            console.warn('[TerminalPane] Error writing output:', err)
          }
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
          try {
            terminal.clear()
          } catch (err) {
            console.warn('[TerminalPane] Error clearing terminal:', err)
          }
          try {
            terminal.write(state)
          } catch (err) {
            // ghostty-web WASM can throw RangeError intermittently
            console.warn('[TerminalPane] Error writing screenState:', err)
          }
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
            try {
              terminal.clear()
            } catch (err) {
              console.warn('[TerminalPane] Error clearing terminal:', err)
            }
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
   *
   * Link detection:
   * ghostty-web automatically registers OSC8LinkProvider (explicit
   * hyperlinks) and UrlRegexProvider (auto-detected URLs) during
   * terminal.open(). Cmd+Click on a detected link opens it via
   * window.open(). In Electron, setWindowOpenHandler in the main
   * process redirects window.open() calls to shell.openExternal()
   * so links open in the OS default browser.
   *
   * OSC title changes:
   * ghostty-web fires onTitleChange when OSC 0 or OSC 2 escape
   * sequences set the window title. This event is forwarded to the
   * parent component via the onTitleChange prop.
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

      // Explicitly focus the terminal so keyboard input works immediately.
      // ghostty-web calls focus() at the end of open(), but because this
      // runs inside an async setup function (after WASM init), the browser
      // may have shifted focus elsewhere by the time open() completes.
      terminal.focus()

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
      // - Return `true` → custom handler CONSUMED the event, ghostty-web
      //   calls preventDefault() and stops processing (key bubbles to document)
      // - Return `false` → custom handler did NOT consume, ghostty-web
      //   continues normal key processing (terminal input)
      //
      // NOTE: This is the OPPOSITE convention from xterm.js, where
      // `true` means "let xterm handle it" and `false` means "ignore it".
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
          return false
        }

        // Let global shortcuts (Cmd+W, Cmd+Shift+Enter) bubble to
        // TanStack Hotkeys on document — consume the event so ghostty-web
        // does not process it as terminal input.
        if (shouldBypassTerminal(event)) {
          // Ctrl+B additionally enters prefix mode for tmux-style sequences.
          if (isExactCtrlB(event)) {
            enterPrefixMode()
          }
          return true
        }

        // In prefix mode: consume the action key so it bubbles to
        // TanStack Hotkeys. This is the second key in the Ctrl+B -> action sequence.
        if (prefixModeRef.current) {
          exitPrefixMode()
          return true
        }

        // Normal key — let ghostty-web handle it as terminal input
        return false
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

      // Subscribe to OSC title changes (OSC 0 and OSC 2 escape sequences).
      // ghostty-web parses these sequences during write() and fires onTitleChange
      // with the title string. This allows the parent component to update tab
      // labels, window titles, or other UI based on the running process's title.
      const onTitleChangeDisposable = terminal.onTitleChange(
        (title: string) => {
          onTitleChangeRef.current?.(title)
        }
      )

      // Trigger an initial resize now that refs are populated. The
      // ResizeObserver's initial observation already fired (and was
      // skipped because refs were null at that point), so we need
      // this explicit call to sync dimensions.
      handleResizeRef.current?.()

      // Store cleanup function for disposal
      cleanupRef.current = () => {
        onDataDisposable.dispose()
        onTitleChangeDisposable.dispose()
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
   * Resize handler — fit terminal then notify backend (fire-and-forget).
   *
   * Two resize sources feed the same handler:
   * 1. A `ResizeObserver` on the container div — panel splits, drags
   * 2. The module-level `subscribeWindowResize` signal — window resize
   *
   * The handler reads `fitAddonRef` and `terminalRef` on each invocation.
   * If the terminal hasn't finished async init yet, it returns early.
   * Once the setup effect completes, it calls `handleResizeRef.current()`
   * to trigger the first resize explicitly.
   *
   * Uses RAF to batch rapid events. No async, no in-flight tracking —
   * just fit + fire-and-forget RPC, matching the pre-migration xterm.js
   * approach. The previous PTY-first async flow caused deadlocks when
   * the RPC promise hung (e.g. during server reconnects).
   */
  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }

    const state: ResizeState = {
      lastCols: 0,
      lastRows: 0,
      rafId: null,
    }
    let disposed = false

    const handleResize = () => {
      if (disposed) {
        return
      }

      const fitAddon = fitAddonRef.current
      const terminal = terminalRef.current
      if (!(fitAddon && terminal)) {
        return
      }

      // Cancel any pending RAF to coalesce rapid events
      if (state.rafId !== null) {
        cancelAnimationFrame(state.rafId)
      }

      state.rafId = requestAnimationFrame(() => {
        state.rafId = null
        if (disposed) {
          return
        }

        const fitAddonNow = fitAddonRef.current
        const terminalNow = terminalRef.current
        if (!(fitAddonNow && terminalNow)) {
          return
        }

        executeResize(
          fitAddonNow,
          terminalNow,
          terminalId,
          resizeTerminalRef.current,
          state
        )
      })
    }

    // Store the handler so the terminal setup effect can trigger
    // an initial resize after the terminal is created.
    handleResizeRef.current = handleResize

    // Observe container for panel resizes (splits, drags)
    const resizeObserver = new ResizeObserver(handleResize)
    resizeObserver.observe(container)

    // Subscribe to the module-level window resize signal.
    const unsubWindow = subscribeWindowResize(handleResize)

    return () => {
      disposed = true
      handleResizeRef.current = null
      if (state.rafId !== null) {
        cancelAnimationFrame(state.rafId)
      }
      resizeObserver.disconnect()
      unsubWindow()
    }
  }, [terminalId])

  return (
    <div
      className="relative h-full w-full overflow-hidden"
      data-terminal-id={terminalId}
    >
      {/* ghostty-web terminal container — uses the same layout structure
          as the Mux reference: flex column parent with flex:1 + min-h-0
          child. The overflow:hidden prevents the canvas from pushing the
          container larger than the available space. */}
      <div className="h-full w-full overflow-hidden" ref={containerRef} />

      {/* Loading overlay (Issue #122) — shown while the PTY is spawning
			    and no output has arrived yet. Covers the blank terminal canvas
			    with a spinner and message. Disappears on first data (output or
			    screenState). Only shown for running terminals (stopped terminals
			    get immediate screen state on reconnection). */}
      {!hasReceivedData && isRunning && showSpinner && (
        <TerminalLoadingOverlay />
      )}

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
