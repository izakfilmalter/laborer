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
import { type ISearchResultChangeEvent, SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { LaborerClient } from '@/atoms/laborer-client'
import { TerminalServiceClient } from '@/atoms/terminal-service-client'
import { LifecyclePhase } from '@/components/lifecycle-phase-context'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
} from '@/components/ui/input-group'
import { Kbd } from '@/components/ui/kbd'
import { Spinner } from '@/components/ui/spinner'
import type {
  ReplayControlMessage,
  ReplayStatus,
  TerminalStatus,
} from '@/hooks/use-terminal-messageport'
import { useTerminalMessagePort } from '@/hooks/use-terminal-messageport'
import { useWhenPhase } from '@/hooks/use-when-phase'
import { openExternalUrl } from '@/lib/desktop'
import {
  isPrefixKey,
  isTerminalFindNextShortcut,
  isTerminalFindPreviousShortcut,
  isTerminalFindShortcut,
  shouldBypassTerminal,
} from '@/lib/keybinds'

/**
 * Daytona terminal IDs are prefixed with `daytona:` so the correct
 * RPC endpoint (server vs terminal utility process) can be selected.
 * Mirrors the routing logic in the Electron main process (ipc.ts)
 * and the server's SandboxProviderRouter.
 */
const DAYTONA_TERMINAL_PREFIX = 'daytona:'

/** Mutation atom for resizing local (Docker/host) terminals via the terminal utility process. */
const localResizeMutation = TerminalServiceClient.mutation('terminal.resize')

/** Mutation atom for resizing Daytona terminals via the server (LaborerRpcs). */
const daytonaResizeMutation = LaborerClient.mutation('terminal.resize')

/**
 * Timeout for prefix mode (ms). Matches the SEQUENCE_TIMEOUT in panel-hotkeys.tsx
 * so that if the user presses Ctrl+B but doesn't follow up with an action key
 * within this window, prefix mode exits and the terminal resumes normal input.
 */
const PREFIX_MODE_TIMEOUT = 1500

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
 * Row changes are applied immediately (cheap — no reflow), while column
 * changes are debounced because they trigger expensive text reflow across
 * the entire scrollback buffer.
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
  let colsDebounceTimer: ReturnType<typeof setTimeout> | null = null
  let serverResizeTimer: ReturnType<typeof setTimeout> | null = null
  /** Latest desired cols — updated on each observation, applied when debounce fires. */
  let latestCols = 0
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

  /** Schedule a debounced column resize. */
  const debounceCols = () => {
    if (colsDebounceTimer !== null) {
      clearTimeout(colsDebounceTimer)
    }
    colsDebounceTimer = setTimeout(() => {
      colsDebounceTimer = null
      const t = terminalRef.current
      if (t && latestCols > 0 && latestCols !== t.cols) {
        applyResize(latestCols, t.rows)
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

    latestCols = dims.cols
    const colsChanged = dims.cols !== terminal.cols
    const rowsChanged = dims.rows !== terminal.rows

    // Small buffer optimization: reflow is fast with small buffers,
    // so apply both dimensions immediately without debouncing.
    if (terminal.buffer.normal.length < START_DEBOUNCING_THRESHOLD) {
      if (colsDebounceTimer !== null) {
        clearTimeout(colsDebounceTimer)
        colsDebounceTimer = null
      }
      applyResize(dims.cols, dims.rows)
      return
    }

    // Apply row change immediately (cheap — no reflow)
    if (rowsChanged) {
      applyResize(terminal.cols, dims.rows)
    }

    // Debounce column change (expensive — triggers text reflow)
    if (colsChanged) {
      debounceCols()
    }
  }

  const dispose = () => {
    if (colsDebounceTimer !== null) {
      clearTimeout(colsDebounceTimer)
      colsDebounceTimer = null
    }
    if (serverResizeTimer !== null) {
      clearTimeout(serverResizeTimer)
      flushServerResize()
    }
  }

  return { handleResize, dispose }
}

/** Connection result shape for the MessagePort data channel hook. */
interface TerminalConnection {
  readonly replayStatus: ReplayStatus
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
  const pendingDataRef = useRef<string[]>([])
  const [replayEpoch, setReplayEpoch] = useState(0)

  const handleTerminalData = useCallback((data: string) => {
    const terminal = terminalRef.current
    if (!terminal) {
      pendingDataRef.current.push(data)
      return
    }

    terminal.write(data)
  }, [])

  const flushPendingTerminalData = useCallback(() => {
    const terminal = terminalRef.current
    if (!terminal || pendingDataRef.current.length === 0) {
      return
    }

    const pendingData = pendingDataRef.current
    pendingDataRef.current = []
    for (const data of pendingData) {
      terminal.write(data)
    }
  }, [])

  const handleReplayStart = useCallback((replayEvent: ReplayControlMessage) => {
    const terminal = terminalRef.current
    if (!terminal) {
      return
    }

    terminal.reset()
    setReplayEpoch((current) => current + 1)

    queueMicrotask(() => {
      const activeTerminal = terminalRef.current
      if (!activeTerminal) {
        return
      }

      for (const frame of replayEvent.events) {
        const dimensions = normalizeTerminalDimensions(frame)
        if (!hasTerminalDimensions(dimensions)) {
          continue
        }
        if (
          activeTerminal.cols !== dimensions.cols ||
          activeTerminal.rows !== dimensions.rows
        ) {
          activeTerminal.resize(dimensions.cols, dimensions.rows)
        }
        if (frame.data.length > 0) {
          activeTerminal.write(frame.data)
        }
      }
    })
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
    onReplayStart: handleReplayStart,
    onStatus: handleTerminalStatus,
  })

  return (
    <TerminalPaneRenderer
      connection={connection}
      onTerminalReady={flushPendingTerminalData}
      onTitleChange={onTitleChange}
      replayEpoch={replayEpoch}
      terminalId={terminalId}
      terminalRef={terminalRef}
    />
  )
}

/** Props for the shared terminal renderer component. */
interface TerminalPaneRendererProps {
  readonly connection: TerminalConnection
  readonly onTerminalReady: () => void
  readonly onTitleChange?: ((title: string) => void) | undefined
  readonly replayEpoch: number
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
  onTerminalReady,
  connection,
  replayEpoch,
  terminalRef,
}: TerminalPaneRendererProps) {
  const {
    send: connectionSend,
    status: connectionStatus,
    replayStatus,
    terminalStatus,
  } = connection
  const resizeLocal = useAtomSet(localResizeMutation)
  const resizeDaytona = useAtomSet(daytonaResizeMutation)
  const resizeTerminal = terminalId.startsWith(DAYTONA_TERMINAL_PREFIX)
    ? resizeDaytona
    : resizeLocal
  const containerRef = useRef<HTMLDivElement>(null)
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

  useEffect(() => {
    if (replayEpoch === 0) {
      return
    }

    hasReceivedDataRef.current = false
    setHasReceivedData(false)
  }, [replayEpoch])

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

    onTerminalReady()

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

      if (handleTerminalFindShortcut(event)) {
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
      onDidChangeSearchResultsDisposable.dispose()
      onWriteParsedDisposable.dispose()
      onDataDisposable.dispose()
      onTitleChangeDisposable.dispose()
      terminal.dispose()
      searchAddonRef.current = null
      terminalRef.current = null
      fitAddonRef.current = null
      // Clear prefix mode timeout to prevent stale state updates
      if (prefixTimeoutRef.current !== null) {
        clearTimeout(prefixTimeoutRef.current)
        prefixTimeoutRef.current = null
      }
      prefixModeRef.current = false
    }
  }, [terminalId, terminalRef, onTerminalReady])

  /**
   * Observe the container element for size changes using ResizeObserver.
   * This handles pane resizing, window resizing, fullscreen, etc.
   *
   * Follows VS Code's TerminalResizeDebouncer pattern:
   * - Row changes are applied immediately (cheap — no reflow)
   * - Column changes are debounced at 100ms (expensive — triggers
   *   text reflow across the entire scrollback buffer)
   * - Small buffers (<200 lines) resize immediately since reflow is fast
   *
   * This prevents the "ghost/duplicate content" rendering artifacts
   * that occur when TUI applications receive rapid SIGWINCH signals
   * during drag-resize operations.
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

      {/* Loading overlay — shown while the PTY is spawning
          and no output has arrived yet. Covers the blank terminal canvas
          with a spinner and message. Disappears on first data frame.
          Only shown for running terminals (stopped terminals get immediate
          screen state on reconnection). */}
      {(!hasReceivedData || replayStatus === 'replaying') && isRunning && (
        <TerminalLoadingOverlay
          message={
            replayStatus === 'replaying'
              ? 'Restoring terminal...'
              : 'Starting terminal...'
          }
        />
      )}

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
