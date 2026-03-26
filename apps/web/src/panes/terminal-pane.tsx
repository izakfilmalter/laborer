/**
 * Terminal pane component — renders PTY output via xterm.js using a
 * dedicated data channel connection for terminal I/O.
 *
 * Data flow:
 * 1. Terminal service PTY emits output via node-pty `onData`
 * 2. TerminalManager writes to headless terminal + notifies subscribers
 * 3. Data channel forwards output to the renderer
 * 4. This component receives data via the terminal connection hook
 * 5. Output is written directly to xterm.js Terminal instance
 *
 * Transport: MessagePort data channel via `desktopBridge.acquireTerminalDataPort()`
 * (zero-copy ArrayBuffer transfer, no HTTP/WebSocket overhead)
 *
 * Input flow:
 * - Keystrokes captured by xterm.js `onData` callback
 * - Sent as data channel messages (NOT via terminal.write RPC)
 * - Terminal service forwards to PTY via PtyHostClient.write()
 *
 * Terminal status:
 * Terminal status is derived from control messages sent by the terminal
 * service over the MessagePort data channel:
 * - `{"type":"status","status":"running"}` — on initial connection
 * - `{"type":"status","status":"stopped","exitCode":N}` — PTY process exited
 * - `{"type":"status","status":"restarted"}` — terminal was restarted
 *
 * Keyboard shortcut scope isolation (Issue #80):
 * - xterm.js greedily captures all keyboard events within its canvas.
 * - `attachCustomKeyEventHandler` intercepts keyboard events before
 *   xterm.js processes them. Keys matching app-level keybinds are
 *   returned as `false` so they bubble to TanStack Hotkeys on document.
 * - Ctrl+B enters prefix mode for tmux-style sequences.
 *
 * @see packages/terminal/src/services/terminal-data-channel.ts — MessagePort endpoint
 * @see packages/terminal/src/services/terminal-manager.ts — headless terminal + subscribers
 * @see apps/web/src/hooks/use-terminal-messageport.ts — MessagePort hook
 * @see apps/web/src/lib/keybinds.ts — centralized keybind definitions
 * @see Issue #9: Renderer terminal UI wired to MessagePort
 */

import { useAtomSet } from '@effect-atom/atom-react/Hooks'
import { FitAddon } from '@xterm/addon-fit'
import { ImageAddon } from '@xterm/addon-image'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useCallback, useEffect, useRef, useState } from 'react'
import { TerminalServiceClient } from '@/atoms/terminal-service-client'
import { LifecyclePhase } from '@/components/lifecycle-phase-context'
import { Kbd } from '@/components/ui/kbd'
import { Spinner } from '@/components/ui/spinner'
import type { TerminalStatus } from '@/hooks/use-terminal-messageport'
import { useTerminalMessagePort } from '@/hooks/use-terminal-messageport'
import { useWhenPhase } from '@/hooks/use-when-phase'
import { openExternalUrl } from '@/lib/desktop'
import { isPrefixKey, shouldBypassTerminal } from '@/lib/keybinds'

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
 * measures the DOM) and a `terminal.resize` RPC call. This floods the
 * event loop and network with unnecessary resize operations.
 *
 * VS Code uses a 100ms debounce for horizontal resizes (which trigger
 * text reflow) and applies vertical resizes immediately (cheap). We use
 * a simpler 100ms debounce for all resizes since the fit addon handles
 * both dimensions together.
 */
const RESIZE_DEBOUNCE_MS = 100

/** Connection result shape for the MessagePort data channel hook. */
interface TerminalConnection {
  readonly send: (data: string) => void
  readonly status: 'connecting' | 'connected' | 'disconnected'
  readonly terminalStatus: TerminalStatus
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
 * Waits for the lifecycle phase to reach Restored (terminal sidecar
 * available) before rendering the terminal. Shows a connecting placeholder
 * in the meantime.
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
 * Phase 3 / Restored).
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
 * Inner terminal pane component — connects via MessagePort data channel
 * and renders the terminal.
 */
function TerminalPaneContent(props: TerminalPaneProps) {
  return <TerminalPaneMessagePort {...props} />
}

/** Connects via MessagePort and renders the terminal. */
function TerminalPaneMessagePort({
  terminalId,
  onTerminalExit,
  onTitleChange,
}: TerminalPaneProps) {
  const terminalRef = useRef<Terminal | null>(null)

  const handleTerminalData = useCallback((data: string) => {
    terminalRef.current?.write(data)
  }, [])

  const handleTerminalStatus = useCallback(
    (status: TerminalStatus, _exitCode: number | undefined) => {
      if (status === 'restarted') {
        terminalRef.current?.clear()
      }
      if (status === 'stopped') {
        onTerminalExit?.()
      }
    },
    [onTerminalExit]
  )

  const connection = useTerminalMessagePort({
    terminalId,
    onData: handleTerminalData,
    onStatus: handleTerminalStatus,
  })

  return (
    <TerminalPaneRenderer
      connection={connection}
      onTitleChange={onTitleChange}
      terminalId={terminalId}
      terminalRef={terminalRef}
    />
  )
}

/** Props for the shared terminal renderer component. */
interface TerminalPaneRendererProps {
  readonly connection: TerminalConnection
  readonly onTitleChange?: ((title: string) => void) | undefined
  readonly terminalId: string
  readonly terminalRef: React.RefObject<Terminal | null>
}

/**
 * Shared terminal renderer — handles xterm.js initialization, keyboard
 * input, resize, and UI overlays. Transport-agnostic: receives connection
 * state and send function via props.
 *
 * On reconnection, the server sends a compact screen state snapshot (~4KB)
 * as initial data frames, restoring the terminal's state.
 *
 * When the container is resized (by panel splits, window resize, etc.),
 * the fit addon recalculates cols/rows and the new dimensions are sent
 * to the server PTY via the `terminal.resize` RPC mutation.
 */
function TerminalPaneRenderer({
  terminalId,
  onTitleChange,
  connection,
  terminalRef,
}: TerminalPaneRendererProps) {
  const {
    send: connectionSend,
    status: connectionStatus,
    terminalStatus,
  } = connection
  const resizeTerminal = useAtomSet(terminalResizeMutation)
  const containerRef = useRef<HTMLDivElement>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)

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
   * Loading state tracking.
   *
   * When the terminal pane first mounts, no output has arrived yet.
   * `hasReceivedData` starts as `false` and flips to `true` on the
   * first data frame. A loading overlay is shown while false.
   * Uses a ref for the hot-path check (every data frame) and state
   * for React rendering.
   */
  const [hasReceivedData, setHasReceivedData] = useState(false)
  const hasReceivedDataRef = useRef(false)

  const isRunning = terminalStatus !== 'stopped'

  /** Ref for isRunning so the xterm.js onData callback can check it. */
  const isRunningRef = useRef(isRunning)
  isRunningRef.current = isRunning

  // Ref to hold latest connectionSend for the xterm.js onData callback
  const connectionSendRef = useRef(connectionSend)
  connectionSendRef.current = connectionSend

  /** Ref for onTitleChange to avoid stale closures in terminal event callbacks. */
  const onTitleChangeRef = useRef(onTitleChange)
  onTitleChangeRef.current = onTitleChange

  /**
   * Track first data receipt to dismiss loading overlay.
   * Uses xterm.js onWriteParsed event to detect when data has been written.
   */
  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) {
      return
    }
    const disposable = terminal.onWriteParsed(() => {
      if (!hasReceivedDataRef.current) {
        hasReceivedDataRef.current = true
        setHasReceivedData(true)
      }
    })
    return () => disposable.dispose()
  }, [terminalRef])

  /**
   * Initialize xterm.js instance.
   *
   * Creates the Terminal, attaches addons (fit, WebGL, Image, Unicode11,
   * WebLinks), opens in the container, and wires keyboard input to the
   * data channel.
   */
  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }

    // Create xterm.js Terminal instance
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily:
        '"JetBrains Mono", "Fira Code", "Cascadia Code", Menlo, Monaco, "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.2,
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
      allowProposedApi: true,
      fastScrollSensitivity: 5,
      scrollSensitivity: 3,
    })

    terminalRef.current = terminal

    // Attach fit addon for responsive sizing
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    fitAddonRef.current = fitAddon

    // Open terminal in the container
    terminal.open(container)

    // Attempt WebGL rendering for better performance (GPU-accelerated).
    // Critical for scroll performance with 100k+ lines — WebGL renders
    // only visible rows via the GPU, avoiding DOM reflow on scroll.
    try {
      const webglAddon = new WebglAddon()
      webglAddon.onContextLoss(() => {
        webglAddon.dispose()
      })
      terminal.loadAddon(webglAddon)
    } catch {
      // WebGL not available — fall back to canvas renderer (default)
    }

    // Load Image addon for inline image rendering.
    // Supports iTerm2 inline image protocol (OSC 1337) and Sixel graphics.
    try {
      const imageAddon = new ImageAddon()
      terminal.loadAddon(imageAddon)
    } catch {
      // Image addon failed to load — inline images not supported
    }

    // Load Unicode 11 addon for correct character width calculation.
    // Without this, CJK characters, emoji, and other wide Unicode
    // characters may be measured incorrectly, causing cursor misalignment.
    try {
      const unicode11Addon = new Unicode11Addon()
      terminal.loadAddon(unicode11Addon)
      terminal.unicode.activeVersion = '11'
    } catch {
      // Unicode11 addon failed to load — default width calculation used
    }

    // Load Web Links addon for clickable URL detection.
    // Agent TUIs frequently output URLs — file paths, PR URLs, docs links.
    // Custom handler routes link clicks through openExternalUrl() which
    // delegates to shell.openExternal via the Electron IPC bridge.
    try {
      const webLinksAddon = new WebLinksAddon((_event, url) => {
        openExternalUrl(url).catch(() => {
          // Silently ignore — link open failures are non-critical
        })
      })
      terminal.loadAddon(webLinksAddon)
    } catch {
      // Web Links addon failed to load — URLs remain plain text
    }

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
    // xterm.js `attachCustomKeyEventHandler` intercepts KeyboardEvent
    // objects before xterm.js processes them:
    // - Return `true` → xterm.js handles the key (normal terminal input)
    // - Return `false` → xterm.js ignores the key (it bubbles to document)
    //
    // Uses the centralized keybind definitions from `@/lib/keybinds` to
    // determine which keys should bypass the terminal.
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

      // Let app-level shortcuts bubble to TanStack Hotkeys on document.
      // xterm.js convention: return `false` to bypass (let event bubble).
      if (shouldBypassTerminal(event)) {
        // Ctrl+B additionally enters prefix mode for tmux-style sequences.
        if (isPrefixKey(event)) {
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

      // Normal key — let xterm.js handle it
      return true
    })

    // Wire keyboard input to server PTY via the data channel.
    // xterm.js's onData fires for every keystroke (including special keys
    // like enter, backspace, ctrl-c, arrows) with the data already encoded
    // as the correct ANSI escape sequences.
    //
    // Keyboard input is only sent when the terminal is running.
    // When the terminal has stopped, keystrokes are silently dropped.
    const onDataDisposable = terminal.onData((data: string) => {
      if (!isRunningRef.current) {
        return
      }
      connectionSendRef.current(data)
    })

    // Subscribe to OSC title changes (OSC 0 and OSC 2 escape sequences).
    // xterm.js parses these sequences during write() and fires onTitleChange
    // with the title string. This allows the parent component to update tab
    // labels, window titles, or other UI based on the running process's title.
    const onTitleChangeDisposable = terminal.onTitleChange((title: string) => {
      onTitleChangeRef.current?.(title)
    })

    // Cleanup on unmount
    return () => {
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
  }, [terminalId, terminalRef])

  /**
   * Handle container resize — re-fit the terminal when the
   * pane dimensions change, then send new dimensions to the
   * server PTY via `terminal.resize` RPC mutation.
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
  }, [terminalId, terminalRef])

  /**
   * Observe the container element for size changes using ResizeObserver.
   * This handles allotment pane resizing, window resizing, etc.
   *
   * Debounced at 100ms to avoid flooding the resize RPC during drag
   * operations.
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
      {/* xterm.js container */}
      <div className="h-full w-full" ref={containerRef} />

      {/* Loading overlay — shown while the PTY is spawning
          and no output has arrived yet. Covers the blank terminal canvas
          with a spinner and message. Disappears on first data frame.
          Only shown for running terminals (stopped terminals get immediate
          screen state on reconnection). */}
      {!hasReceivedData && isRunning && <TerminalLoadingOverlay />}

      {/* Prefix mode indicator (Issue #80) — shown when Ctrl+B was pressed
          and the terminal is waiting for the next key to complete a panel
          shortcut sequence. */}
      {prefixMode && (
        <div className="absolute top-1 left-1 z-20 flex items-center gap-1 rounded bg-primary/90 px-2 py-0.5 text-primary-foreground text-xs backdrop-blur-sm">
          <span>Prefix</span>
          <Kbd className="h-4 min-w-0 bg-primary-foreground/15 px-1 text-[10px] text-primary-foreground">
            Ctrl
          </Kbd>
          <Kbd className="h-4 min-w-0 bg-primary-foreground/15 px-1 text-[10px] text-primary-foreground">
            B
          </Kbd>
        </div>
      )}

      {/* Data channel disconnection indicator */}
      {connectionStatus === 'disconnected' && isRunning && (
        <DisconnectedBanner />
      )}

      {/* Connecting indicator */}
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
 */
function TerminalLoadingOverlay() {
  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background">
      <Spinner className="size-6 text-muted-foreground" />
      <p className="text-muted-foreground text-sm">Starting terminal...</p>
    </div>
  )
}

/** Banner shown when the data channel is disconnected but the terminal is still running. */
function DisconnectedBanner() {
  return (
    <div className="absolute inset-x-0 top-0 border-destructive/50 border-b bg-destructive/10 px-3 py-1 text-center text-destructive text-xs backdrop-blur-sm">
      Disconnected — reconnecting...
    </div>
  )
}

/** Banner shown while the data channel is connecting. */
function ReconnectingBanner() {
  return (
    <div className="absolute inset-x-0 top-0 border-warning/50 border-b bg-warning/10 px-3 py-1 text-center text-warning text-xs backdrop-blur-sm">
      Connecting...
    </div>
  )
}

export { TerminalPane }
