/**
 * Terminal pane component — renders PTY output via xterm.js using a
 * dedicated data channel connection for terminal I/O.
 *
 * Data flow:
 * 1. Terminal service PTY emits output via node-pty `onData`
 * 2. TerminalManager writes to headless terminal + notifies subscribers
 * 3. The attach RPC stream forwards output to the renderer
 * 4. This component receives data via the terminal connection hook
 * 5. Output is written directly to xterm.js Terminal instance
 *
 * Transport: `terminal.attach` over the daemon's shared WebSocket RPC.
 *
 * Input flow:
 * - Keystrokes captured by xterm.js `onData` callback
 * - Sent via ordered `terminal.write` RPC calls
 * - Terminal service forwards to PTY via PtyHostClient.write()
 *
 * Terminal status:
 * Terminal status is derived from control messages sent by the terminal
 * service over the attach stream:
 * - `{"type":"status","status":"running"}` — on initial connection
 * - `{"type":"status","status":"stopped","exitCode":N}` — PTY process exited
 * - `{"type":"status","status":"restarted"}` — terminal was restarted
 *
 * Keyboard shortcut scope isolation (Issue #80):
 * - xterm.js greedily captures all keyboard events within its canvas.
 * - `attachCustomKeyEventHandler` intercepts keyboard events before
 *   xterm.js processes them. Keys matching app-level keybinds are
 *   returned as `false` so they bubble to TanStack Hotkeys on document.
 * - Terminal-native navigation keys are sent directly to the PTY.
 *
 * @see packages/terminal/src/services/terminal-manager.ts — headless terminal + subscribers
 * @see apps/web/src/hooks/use-terminal-rpc.ts — daemon WebSocket hook
 * @see apps/web/src/lib/terminal-screen.ts — canvas identity and lifetime
 * @see apps/web/src/lib/keybinds.ts — centralized keybind definitions
 */

import { useAtomSet } from '@effect/atom-react/Hooks'
import { FitAddon } from '@xterm/addon-fit'
import { ImageAddon } from '@xterm/addon-image'
import { type ISearchResultChangeEvent, SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
} from '@laborer/ui/components/input-group'
import { Spinner } from '@laborer/ui/components/spinner'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { TerminalServiceClient } from '@/atoms/terminal-service-client'
import { LifecyclePhase } from '@/components/lifecycle-phase-context'
import {
  TERMINAL_REVIVAL_ANNOUNCEMENT,
  TerminalRevivalMarker,
} from '@/components/terminal-revival-marker'
import { useTerminalRpc } from '@/hooks/use-terminal-rpc'
import { useWhenPhase } from '@/hooks/use-when-phase'
import {
  isTerminalFindNextShortcut,
  isTerminalFindPreviousShortcut,
  isTerminalFindShortcut,
  shouldBypassTerminal,
} from '@/lib/keybinds'
import { handleTerminalKeyEvent } from '@/lib/terminal-keyboard'
import { openTerminalLink, terminalOscLinkHandler } from '@/lib/terminal-links'
import {
  createTerminalScreen,
  type TerminalScreen,
  type TerminalScreenCanvas,
} from '@/lib/terminal-screen'
import {
  showTerminalRevivalMarker,
  terminalLoadingMessage,
} from './terminal-loading-state'

const resizeMutation = TerminalServiceClient.mutation('terminal.resize')
type ReplayStatus = 'idle' | 'replaying' | 'complete'
type TerminalStatus = 'running' | 'stopped' | 'restarted'

/** Search highlight limit. Matches VS Code's higher-than-default threshold. */
const TERMINAL_FIND_HIGHLIGHT_LIMIT = 20_000

const EMPTY_TERMINAL_FIND_RESULTS = {
  resultCount: 0,
  resultIndex: -1,
} as const satisfies ISearchResultChangeEvent

const TERMINAL_FIND_DECORATIONS = {
  activeMatchBackground: '#facc15',
  activeMatchBorder: '#fde047',
  activeMatchColorOverviewRuler: '#facc15',
  matchBackground: '#1d4ed8',
  matchBorder: '#60a5fa',
  matchOverviewRuler: '#60a5fa',
} as const

/**
 * Debounce delay for horizontal (column) resize (ms).
 *
 * VS Code's TerminalResizeDebouncer applies row changes immediately
 * (cheap — just show more/fewer rows) but debounces column changes at
 * 100ms because horizontal resizes trigger expensive text reflow across
 * the entire scrollback buffer. We follow the same pattern.
 *
 * @see .reference/vscode/src/vs/workbench/contrib/terminal/browser/terminalResizeDebouncer.ts
 */
const RESIZE_COLS_DEBOUNCE_MS = 100

/**
 * Normal buffer length threshold at which resize debouncing activates.
 *
 * When the terminal's normal buffer has fewer than this many lines,
 * resizes are applied immediately (both cols and rows) because reflow
 * is fast with small buffers. Above this threshold, column resizes
 * are debounced to avoid janky reflow during drag-resize operations.
 *
 * Matches VS Code's `StartDebouncingThreshold` constant.
 *
 * @see .reference/vscode/src/vs/workbench/contrib/terminal/browser/terminalResizeDebouncer.ts
 */
const START_DEBOUNCING_THRESHOLD = 200

const normalizeTerminalDimension = (value: number): number => {
  if (!Number.isFinite(value)) {
    return 0
  }

  return Math.max(0, Math.floor(value))
}

const normalizeTerminalDimensions = ({
  cols,
  rows,
}: {
  cols: number
  rows: number
}): { cols: number; rows: number } => ({
  cols: normalizeTerminalDimension(cols),
  rows: normalizeTerminalDimension(rows),
})

const hasTerminalDimensions = ({
  cols,
  rows,
}: {
  cols: number
  rows: number
}): boolean => cols > 0 && rows > 0

const getProposedTerminalDimensions = (
  fitAddon: FitAddon
): { cols: number; rows: number } | undefined => {
  try {
    const proposedDimensions = fitAddon.proposeDimensions()
    if (!proposedDimensions) {
      return undefined
    }

    const dims = normalizeTerminalDimensions(proposedDimensions)
    return hasTerminalDimensions(dims) ? dims : undefined
  } catch {
    // Container may have 0 dimensions during layout transitions.
    return undefined
  }
}

/**
 * Terminal resize debouncer — applies VS Code's independent X/Y resize
 * strategy to prevent ghost/duplicate rendering during resize operations.
 *
 * Small buffers resize immediately. Large buffers coalesce the whole resize
 * because fullscreen TUIs repaint aggressively on every SIGWINCH, including
 * row-only updates.
 *
 * @see .reference/vscode/src/vs/workbench/contrib/terminal/browser/terminalResizeDebouncer.ts
 */
const createResizeDebouncer = (
  terminalRef: React.RefObject<Terminal | null>,
  fitAddonRef: React.RefObject<FitAddon | null>,
  resizeTerminalRef: React.RefObject<
    (args: { payload: { id: string; cols: number; rows: number } }) => void
  >,
  terminalId: string
) => {
  let resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null
  let serverResizeTimer: ReturnType<typeof setTimeout> | null = null
  /** Latest desired dimensions — updated on each observation, applied when debounce fires. */
  let latestDimensions: { cols: number; rows: number } | null = null
  let latestServerDimensions: { cols: number; rows: number } | null = null
  let lastSentServerDimensions: { cols: number; rows: number } | null = null

  const flushServerResize = () => {
    serverResizeTimer = null
    const dimensions = latestServerDimensions
    if (!dimensions) {
      return
    }
    if (
      lastSentServerDimensions?.cols === dimensions.cols &&
      lastSentServerDimensions.rows === dimensions.rows
    ) {
      return
    }

    lastSentServerDimensions = dimensions
    resizeTerminalRef.current({
      payload: { id: terminalId, ...dimensions },
    })
  }

  const scheduleServerResize = (dimensions: { cols: number; rows: number }) => {
    latestServerDimensions = dimensions
    if (serverResizeTimer !== null) {
      return
    }

    serverResizeTimer = setTimeout(flushServerResize, RESIZE_COLS_DEBOUNCE_MS)
  }

  /**
   * Apply new dimensions to the xterm.js terminal and send a resize
   * RPC to the server PTY.
   */
  const applyResize = (cols: number, rows: number) => {
    const terminal = terminalRef.current
    const dimensions = normalizeTerminalDimensions({ cols, rows })
    if (!(terminal && hasTerminalDimensions(dimensions))) {
      return
    }

    terminal.resize(dimensions.cols, dimensions.rows)
    scheduleServerResize(dimensions)
  }

  /** Schedule a debounced resize for expensive large-buffer reflows/TUI repaints. */
  const debounceResize = () => {
    if (resizeDebounceTimer !== null) {
      clearTimeout(resizeDebounceTimer)
    }
    resizeDebounceTimer = setTimeout(() => {
      resizeDebounceTimer = null
      const t = terminalRef.current
      const dimensions = latestDimensions
      if (
        t &&
        dimensions &&
        (dimensions.cols !== t.cols || dimensions.rows !== t.rows)
      ) {
        applyResize(dimensions.cols, dimensions.rows)
      }
    }, RESIZE_COLS_DEBOUNCE_MS)
  }

  const handleResize = () => {
    const fitAddon = fitAddonRef.current
    const terminal = terminalRef.current
    if (!(fitAddon && terminal)) {
      return
    }

    const dims = getProposedTerminalDimensions(fitAddon)
    if (!dims) {
      return
    }

    // No change — skip
    if (dims.cols === terminal.cols && dims.rows === terminal.rows) {
      return
    }

    latestDimensions = dims

    // Small buffer optimization: reflow is fast with small buffers,
    // so apply both dimensions immediately without debouncing.
    if (terminal.buffer.normal.length < START_DEBOUNCING_THRESHOLD) {
      if (resizeDebounceTimer !== null) {
        clearTimeout(resizeDebounceTimer)
        resizeDebounceTimer = null
      }
      applyResize(dims.cols, dims.rows)
      return
    }

    debounceResize()
  }

  const dispose = () => {
    if (resizeDebounceTimer !== null) {
      clearTimeout(resizeDebounceTimer)
      resizeDebounceTimer = null
    }
    if (serverResizeTimer !== null) {
      clearTimeout(serverResizeTimer)
      flushServerResize()
    }
  }

  return { handleResize, dispose }
}

/** Connection result shape for the terminal attach RPC hook. */
interface TerminalConnection {
  readonly dismissRevival?: (() => void) | undefined
  readonly replayStatus: ReplayStatus
  readonly send: (data: string) => void
  readonly status: 'connecting' | 'connected' | 'disconnected'
  readonly terminalStatus: TerminalStatus
  readonly wasRevived?: boolean
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
 * Inner terminal pane component — connects via the terminal attach RPC stream
 * and renders the terminal.
 */
function TerminalPaneContent(props: TerminalPaneProps) {
  return <TerminalPaneRpc {...props} />
}

/** Browser terminal transport over terminal.attach on the daemon's single WS. */
function TerminalPaneRpc({
  terminalId,
  onTerminalExit,
  onTitleChange,
}: TerminalPaneProps) {
  const terminalRef = useRef<Terminal | null>(null)
  /**
   * The screen outlives each attach and each attach outlives nothing: the
   * daemon can reconnect under a mounted canvas, and React can rebuild the
   * canvas under a live attach. Owning it here, above both, is what lets the
   * two lifetimes be told apart.
   */
  const [screen] = useState(createTerminalScreen)

  const connection = useTerminalRpc({
    onStatus: (status) => {
      if (status === 'stopped') {
        onTerminalExit?.()
      }
    },
    screen,
    terminalId,
  })

  return (
    <TerminalPaneRenderer
      connection={connection}
      onTitleChange={onTitleChange}
      screen={screen}
      terminalId={terminalId}
      terminalRef={terminalRef}
    />
  )
}

/** Props for the shared terminal renderer component. */
interface TerminalPaneRendererProps {
  readonly connection: TerminalConnection
  readonly onTitleChange?: ((title: string) => void) | undefined
  readonly screen: TerminalScreen
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
  screen,
  terminalRef,
}: TerminalPaneRendererProps) {
  const {
    dismissRevival,
    send: connectionSend,
    status: connectionStatus,
    replayStatus,
    terminalStatus,
    wasRevived = false,
  } = connection
  const resizeTerminal = useAtomSet(resizeMutation)
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalElementRef = useRef<HTMLDivElement>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const findInputRef = useRef<HTMLInputElement>(null)

  const [isFindVisible, setIsFindVisible] = useState(false)
  const isFindVisibleRef = useRef(isFindVisible)
  isFindVisibleRef.current = isFindVisible

  const [findQuery, setFindQuery] = useState('')
  const findQueryRef = useRef(findQuery)
  findQueryRef.current = findQuery

  const [findResults, setFindResults] = useState<ISearchResultChangeEvent>(
    EMPTY_TERMINAL_FIND_RESULTS
  )
  const pendingFindInputFocusRef = useRef<'focus' | 'select' | null>(null)

  /**
   * Ref to hold the latest resizeTerminal function so the ResizeObserver
   * callback always has access to the current mutation function.
   */
  const resizeTerminalRef = useRef(resizeTerminal)
  resizeTerminalRef.current = resizeTerminal

  /**
   * Loading state tracking.
   *
   * When the terminal pane first mounts, no output has arrived yet.
   * `hasReceivedData` starts as `false` and flips to `true` on the
   * first parsed data frame. A loading overlay is shown while false.
   * Uses a ref for the hot-path check (every data frame) and state
   * for React rendering.
   *
   * The flag belongs to the canvas, not the pane. A daemon reconnect leaves
   * the canvas drawn, so it stays true and `replayStatus` — which waits for
   * xterm to parse the replayed chunks — owns the restore overlay. A rebuilt
   * canvas is blank, so it starts over with the pane's startup message.
   */
  const [hasReceivedData, setHasReceivedData] = useState(false)
  const hasReceivedDataRef = useRef(false)

  const isRunning = terminalStatus !== 'stopped'
  const loadingMessage = terminalLoadingMessage({
    hasReceivedData,
    isRunning,
    replayStatus,
  })
  /** Revival is only truthful once the restored history is fully on screen. */
  const showRevivalMarker = showTerminalRevivalMarker({
    replayStatus,
    wasRevived,
  })

  /** Ref for isRunning so the xterm.js onData callback can check it. */
  const isRunningRef = useRef(isRunning)
  isRunningRef.current = isRunning

  // Ref to hold latest connectionSend for the xterm.js onData callback
  const connectionSendRef = useRef(connectionSend)
  connectionSendRef.current = connectionSend

  /** Ref for onTitleChange to avoid stale closures in terminal event callbacks. */
  const onTitleChangeRef = useRef(onTitleChange)
  onTitleChangeRef.current = onTitleChange

  const requestTerminalFindInputFocus = useCallback((selectQuery: boolean) => {
    const input = findInputRef.current
    if (input) {
      input.focus()
      if (selectQuery) {
        input.select()
      }
      return
    }

    pendingFindInputFocusRef.current = selectQuery ? 'select' : 'focus'
  }, [])

  useEffect(() => {
    if (!isFindVisible) {
      pendingFindInputFocusRef.current = null
      return
    }

    const request = pendingFindInputFocusRef.current
    const input = findInputRef.current
    if (!(request && input)) {
      return
    }

    input.focus()
    if (request === 'select') {
      input.select()
    }
    pendingFindInputFocusRef.current = null
  }, [isFindVisible])

  const performTerminalFindSearch = useCallback(
    (
      direction: 'next' | 'previous',
      query: string,
      options: { readonly incremental?: boolean } = {}
    ) => {
      const searchAddon = searchAddonRef.current
      if (!searchAddon) {
        return false
      }

      if (query.length === 0) {
        searchAddon.clearDecorations()
        setFindResults(EMPTY_TERMINAL_FIND_RESULTS)
        return false
      }

      const didMatch =
        direction === 'previous'
          ? searchAddon.findPrevious(query, {
              decorations: TERMINAL_FIND_DECORATIONS,
            })
          : searchAddon.findNext(query, {
              decorations: TERMINAL_FIND_DECORATIONS,
              incremental: options.incremental ?? false,
            })

      if (!didMatch) {
        setFindResults(EMPTY_TERMINAL_FIND_RESULTS)
      }

      return didMatch
    },
    []
  )

  const closeTerminalFind = useCallback(
    (refocusTerminal: boolean) => {
      searchAddonRef.current?.clearDecorations()
      setIsFindVisible(false)

      if (refocusTerminal) {
        requestAnimationFrame(() => {
          terminalRef.current?.focus()
        })
      }
    },
    [terminalRef]
  )

  const getTerminalFindSeedQuery = useCallback(() => {
    const selection = terminalRef.current?.getSelection() ?? ''
    if (
      selection.length === 0 ||
      selection.includes('\n') ||
      selection.includes('\r')
    ) {
      return ''
    }
    return selection
  }, [terminalRef])

  const openTerminalFind = useCallback(
    (focusInput: boolean) => {
      const wasVisible = isFindVisibleRef.current
      const currentQuery = findQueryRef.current
      const nextQuery =
        currentQuery.length > 0 ? currentQuery : getTerminalFindSeedQuery()
      const queryChanged = nextQuery !== currentQuery

      setIsFindVisible(true)

      if (focusInput) {
        requestTerminalFindInputFocus(true)
      }

      if (wasVisible) {
        return
      }

      if (queryChanged) {
        setFindQuery(nextQuery)
        if (nextQuery.length === 0) {
          searchAddonRef.current?.clearDecorations()
          setFindResults(EMPTY_TERMINAL_FIND_RESULTS)
        }
        return
      }

      if (nextQuery.length === 0) {
        searchAddonRef.current?.clearDecorations()
        setFindResults(EMPTY_TERMINAL_FIND_RESULTS)
        return
      }

      performTerminalFindSearch('next', nextQuery, { incremental: true })
    },
    [
      getTerminalFindSeedQuery,
      performTerminalFindSearch,
      requestTerminalFindInputFocus,
    ]
  )

  const navigateTerminalFind = useCallback(
    (direction: 'next' | 'previous') => {
      const query = findQueryRef.current
      if (query.length === 0) {
        return
      }

      if (!isFindVisibleRef.current) {
        setIsFindVisible(true)
      }

      performTerminalFindSearch(direction, query)
    },
    [performTerminalFindSearch]
  )

  useEffect(() => {
    if (!isFindVisibleRef.current) {
      return
    }

    if (findQuery.length === 0) {
      searchAddonRef.current?.clearDecorations()
      setFindResults(EMPTY_TERMINAL_FIND_RESULTS)
      return
    }

    performTerminalFindSearch('next', findQuery, { incremental: true })
  }, [findQuery, performTerminalFindSearch])

  const openTerminalFindRef = useRef(openTerminalFind)
  openTerminalFindRef.current = openTerminalFind

  const navigateTerminalFindRef = useRef(navigateTerminalFind)
  navigateTerminalFindRef.current = navigateTerminalFind

  const handleTerminalFindBarKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLFormElement>) => {
      if (isTerminalFindShortcut(event.nativeEvent)) {
        event.preventDefault()
        event.stopPropagation()
        openTerminalFind(true)
        return
      }

      if (isTerminalFindPreviousShortcut(event.nativeEvent)) {
        event.preventDefault()
        event.stopPropagation()
        navigateTerminalFind('previous')
        return
      }

      if (isTerminalFindNextShortcut(event.nativeEvent)) {
        event.preventDefault()
        event.stopPropagation()
        navigateTerminalFind('next')
        return
      }

      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeTerminalFind(true)
      }
    },
    [closeTerminalFind, navigateTerminalFind, openTerminalFind]
  )

  const handleTerminalFindInputKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeTerminalFind(true)
        return
      }

      if (event.key === 'Enter') {
        event.preventDefault()
        event.stopPropagation()
        navigateTerminalFind(event.shiftKey ? 'previous' : 'next')
      }
    },
    [closeTerminalFind, navigateTerminalFind]
  )

  useEffect(() => {
    if (replayStatus !== 'complete') {
      return
    }

    const fitAddon = fitAddonRef.current
    const terminal = terminalRef.current
    if (!(fitAddon && terminal)) {
      return
    }

    try {
      fitAddon.fit()
      if (terminal.cols > 0 && terminal.rows > 0) {
        resizeTerminalRef.current({
          payload: { id: terminalId, cols: terminal.cols, rows: terminal.rows },
        })
      }
    } catch {
      // Ignore layout races during replay completion.
    }
  }, [replayStatus, terminalId, terminalRef])

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
      linkHandler: terminalOscLinkHandler,
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
    if (import.meta.env.DEV && terminalElementRef.current) {
      Reflect.set(terminalElementRef.current, 'xterm', terminal)
    }

    // Attach fit addon for responsive sizing
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    fitAddonRef.current = fitAddon

    const searchAddon = new SearchAddon({
      highlightLimit: TERMINAL_FIND_HIGHLIGHT_LIMIT,
    })
    terminal.loadAddon(searchAddon)
    searchAddonRef.current = searchAddon

    // Open terminal in the container
    terminal.open(container)

    const onDidChangeSearchResultsDisposable = searchAddon.onDidChangeResults(
      (event) => {
        setFindResults(event)
      }
    )

    // Track first data receipt to dismiss the loading overlay.
    // Must be registered here (after Terminal creation) rather than in a
    // separate useEffect, because a separate effect would run before the
    // Terminal exists and never re-run (terminalRef identity is stable).
    const onWriteParsedDisposable = terminal.onWriteParsed(() => {
      if (!hasReceivedDataRef.current) {
        hasReceivedDataRef.current = true
        setHasReceivedData(true)
      }
    })

    // This canvas is blank whatever the one it replaces had drawn, so the pane
    // is starting again rather than continuing. Carrying the flag forward
    // would lift the overlay off an empty screen.
    hasReceivedDataRef.current = false
    setHasReceivedData(false)

    // Publishing the canvas is what gives it an identity: the attach reads its
    // generation to decide whether it may resume a cursor or must ask for a
    // snapshot it can draw from scratch.
    const canvas: TerminalScreenCanvas = {
      reset: () => {
        terminal.reset()
      },
      write: (data, commit) => {
        terminal.write(data, commit)
      },
    }
    screen.mount(canvas)

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
    // Custom handler routes link clicks through localApi.openExternal() which
    // delegates to shell.openExternal via the Electron IPC bridge.
    try {
      const webLinksAddon = new WebLinksAddon((_event, url) => {
        openTerminalLink(url)
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
      // Ignore errors during initial fit (container may have 0 dimensions)
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
    const handleTerminalFindShortcut = (event: KeyboardEvent) => {
      if (isTerminalFindShortcut(event)) {
        event.preventDefault()
        event.stopPropagation()
        openTerminalFindRef.current(true)
        return true
      }

      if (isTerminalFindPreviousShortcut(event)) {
        event.preventDefault()
        event.stopPropagation()
        navigateTerminalFindRef.current('previous')
        return true
      }

      if (isTerminalFindNextShortcut(event)) {
        event.preventDefault()
        event.stopPropagation()
        navigateTerminalFindRef.current('next')
        return true
      }

      return false
    }

    terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      // Match native macOS terminals and VS Code: readline/Emacs navigation
      // belongs to the focused terminal. In particular, xterm's default
      // Option+Arrow CSI sequences are not understood by every shell/TUI.
      return handleTerminalKeyEvent(event, {
        handleTerminalLocalShortcut: handleTerminalFindShortcut,
        isRunning: isRunningRef.current,
        send: connectionSendRef.current,
        shouldBypass: shouldBypassTerminal,
      })
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
      // Retire the canvas before disposing it so no further output is handed
      // to a terminal that is being torn down.
      screen.unmount(canvas)
      onDidChangeSearchResultsDisposable.dispose()
      onWriteParsedDisposable.dispose()
      onDataDisposable.dispose()
      onTitleChangeDisposable.dispose()
      terminal.dispose()
      if (terminalElementRef.current) {
        Reflect.deleteProperty(terminalElementRef.current, 'xterm')
      }
      searchAddonRef.current = null
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [screen, terminalId, terminalRef])

  /**
   * Observe the container element for size changes using ResizeObserver.
   * This handles pane resizing, window resizing, fullscreen, etc.
   *
   * Adapts VS Code's TerminalResizeDebouncer pattern:
   * - Small buffers (<200 lines) resize immediately since reflow is fast
   * - Large buffers debounce the whole resize at 100ms to avoid hammering
   *   fullscreen TUIs with SIGWINCH while panels are actively dragging
   *
   * This prevents the flashing/duplicate-content artifacts that occur when
   * TUI applications receive rapid SIGWINCH signals during drag-resize
   * operations.
   *
   * @see .reference/vscode/src/vs/workbench/contrib/terminal/browser/terminalResizeDebouncer.ts
   */
  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }

    const debouncer = createResizeDebouncer(
      terminalRef,
      fitAddonRef,
      resizeTerminalRef,
      terminalId
    )

    const resizeObserver = new ResizeObserver(() => {
      debouncer.handleResize()
    })

    resizeObserver.observe(container)

    return () => {
      debouncer.dispose()
      resizeObserver.disconnect()
    }
  }, [terminalId, terminalRef])

  return (
    <div
      className="relative h-full w-full overflow-hidden"
      data-terminal-id={terminalId}
      data-testid="terminal-emulator"
      ref={terminalElementRef}
    >
      {/* xterm.js container */}
      <div className="h-full w-full" ref={containerRef} />

      {isFindVisible && (
        <TerminalFindOverlay
          inputRef={findInputRef}
          onClose={() => {
            closeTerminalFind(true)
          }}
          onFindNext={() => {
            navigateTerminalFind('next')
          }}
          onFindPrevious={() => {
            navigateTerminalFind('previous')
          }}
          onInputKeyDown={handleTerminalFindInputKeyDown}
          onKeyDown={handleTerminalFindBarKeyDown}
          onQueryChange={setFindQuery}
          query={findQuery}
          resultCount={findResults.resultCount}
          resultIndex={findResults.resultIndex}
        />
      )}

      {/* Loading overlay — shown while the PTY is spawning and no output has
          arrived yet, and again while a reconnect replays history. Covers the
          terminal canvas with a spinner and message, lifting once the first
          output parses or the replayed buffer is on screen. A stopped terminal
          skips startup but still replays, so it is covered while its final
          screen is restored. */}
      {loadingMessage !== undefined && (
        <TerminalLoadingOverlay message={loadingMessage} />
      )}

      {/* Data channel disconnection indicator */}
      {connectionStatus === 'disconnected' && isRunning && (
        <DisconnectedBanner />
      )}

      {/* Connecting indicator */}
      {connectionStatus === 'connecting' && isRunning && <ReconnectingBanner />}

      {/* Tier-iii revival marker — the shell is new, so the restored output
          is labelled rather than passed off as a surviving process. It waits
          for replay to finish and stays until acknowledged. The spoken form
          sits in an always-mounted region so it is not swallowed by the
          region appearing with its own content. */}
      <output aria-live="polite" className="sr-only">
        {showRevivalMarker ? TERMINAL_REVIVAL_ANNOUNCEMENT : ''}
      </output>
      {showRevivalMarker && (
        <TerminalRevivalMarker
          belowBanner={isRunning && connectionStatus !== 'connected'}
          onDismiss={dismissRevival}
        />
      )}

      {/* Status banner — shown when terminal process has exited */}
      {!isRunning && (
        <div className="absolute inset-x-0 bottom-0 border-border/50 border-t bg-muted/90 px-3 py-1.5 text-center text-muted-foreground text-xs backdrop-blur-sm">
          Process exited — terminal output preserved (read-only)
        </div>
      )}
    </div>
  )
}

interface TerminalFindOverlayProps {
  readonly inputRef: React.RefObject<HTMLInputElement | null>
  readonly onClose: () => void
  readonly onFindNext: () => void
  readonly onFindPrevious: () => void
  readonly onInputKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLFormElement>) => void
  readonly onQueryChange: (query: string) => void
  readonly query: string
  readonly resultCount: number
  readonly resultIndex: number
}

function formatTerminalFindResults(
  query: string,
  resultCount: number,
  resultIndex: number
): string {
  if (query.length === 0) {
    return ''
  }
  if (resultCount === 0) {
    return '0/0'
  }
  if (resultIndex < 0) {
    return `?/${resultCount}`
  }
  return `${resultIndex + 1}/${resultCount}`
}

function TerminalFindOverlay({
  inputRef,
  onClose,
  onFindNext,
  onFindPrevious,
  onInputKeyDown,
  onKeyDown,
  onQueryChange,
  query,
  resultCount,
  resultIndex,
}: TerminalFindOverlayProps) {
  const resultLabel = formatTerminalFindResults(query, resultCount, resultIndex)

  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: The wrapper owns shared find shortcuts while focus moves between its descendants.
    <form
      className="absolute top-1 right-1 z-30 w-80 max-w-[calc(100%-0.5rem)]"
      data-testid="terminal-find-overlay"
      onKeyDown={onKeyDown}
      onSubmit={(event) => {
        event.preventDefault()
      }}
    >
      <InputGroup className="h-7 border-border/70 bg-background/90 shadow-sm backdrop-blur-sm dark:bg-background/90">
        <InputGroupAddon align="inline-start" className="gap-1.5">
          <Search className="size-3.5" />
        </InputGroupAddon>
        <InputGroupInput
          aria-label="Find in terminal"
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          onChange={(event) => {
            onQueryChange(event.target.value)
          }}
          onKeyDown={onInputKeyDown}
          placeholder="Find"
          ref={inputRef}
          spellCheck={false}
          type="search"
          value={query}
        />
        <InputGroupAddon align="inline-end" className="gap-0.5">
          {resultLabel.length > 0 && (
            <InputGroupText className="min-w-9 justify-end tabular-nums">
              {resultLabel}
            </InputGroupText>
          )}
          <InputGroupButton
            aria-label="Previous match"
            onClick={onFindPrevious}
            onMouseDown={(event) => {
              event.preventDefault()
            }}
            size="icon-xs"
          >
            <ChevronUp className="size-3.5" />
          </InputGroupButton>
          <InputGroupButton
            aria-label="Next match"
            onClick={onFindNext}
            onMouseDown={(event) => {
              event.preventDefault()
            }}
            size="icon-xs"
          >
            <ChevronDown className="size-3.5" />
          </InputGroupButton>
          <InputGroupButton
            aria-label="Close find"
            onClick={onClose}
            onMouseDown={(event) => {
              event.preventDefault()
            }}
            size="icon-xs"
          >
            <X className="size-3.5" />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </form>
  )
}

/**
 * Loading overlay shown while waiting for the first terminal output data.
 * Covers the blank terminal canvas with a centered spinner and status message.
 * Uses the terminal's background color (zinc-950) to blend seamlessly.
 */
function TerminalLoadingOverlay({ message }: { readonly message: string }) {
  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background">
      <Spinner className="size-6 text-muted-foreground" />
      <p className="text-muted-foreground text-sm">{message}</p>
    </div>
  )
}

/** Banner shown when the data channel is disconnected but the terminal is still running. */
function DisconnectedBanner() {
  return (
    <div
      className="absolute inset-x-0 top-0 border-destructive/50 border-b bg-destructive/10 px-3 py-1 text-center text-destructive text-xs backdrop-blur-sm"
      data-testid="terminal-connection-status"
    >
      Disconnected — reconnecting...
    </div>
  )
}

/** Banner shown while the data channel is connecting. */
function ReconnectingBanner() {
  return (
    <div
      className="absolute inset-x-0 top-0 border-warning/50 border-b bg-warning/10 px-3 py-1 text-center text-warning text-xs backdrop-blur-sm"
      data-testid="terminal-connection-status"
    >
      Connecting...
    </div>
  )
}

export { TerminalPane }
