/**
 * useTerminalMessagePort — manages a MessagePort data channel to a terminal
 * utility process for PTY I/O streaming.
 *
 * Replaces `useTerminalWebSocket` when running inside Electron with the
 * utility process architecture. Acquires a dedicated per-terminal
 * `MessagePort` via `desktopBridge.acquireTerminalDataPort(terminalId)`.
 *
 * The MessagePort data channel uses the same message format as the
 * WebSocket route for protocol compatibility:
 * - Output (utility -> renderer): UTF-8 strings or ArrayBuffer (zero-copy)
 * - Control messages: JSON status/screenState messages as strings
 * - Input (renderer -> utility): raw keystroke strings
 * - Flow control: `{"type":"ack","chars":N}` ack messages
 *
 * Key differences from WebSocket:
 * - No reconnection needed — MessagePort lifecycle is tied to the utility
 *   process, not a network connection. When the utility process restarts,
 *   the renderer must acquire a new port.
 * - No URL resolution — port is acquired from the DesktopBridge.
 * - Supports ArrayBuffer transfer for zero-copy large output.
 *
 * @see packages/terminal/src/services/terminal-data-channel.ts — server side
 * @see use-terminal-websocket.ts — WebSocket equivalent (browser dev mode)
 * @see Issue #9: Renderer terminal UI wired to MessagePort
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { acquireTerminalDataPort } from '@/lib/desktop'

/** Connection state for UI indicators — same shape as WebSocket hook. */
type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'

/**
 * Terminal process status derived from control messages.
 * Same as the WebSocket hook — protocol is identical.
 */
type TerminalStatus = 'running' | 'stopped' | 'restarted'

type ReplayStatus = 'idle' | 'replaying' | 'complete'

interface ReplayEventFrame {
  readonly cols: number
  readonly data: string
  readonly rows: number
}

interface SerializedPromptInputModel {
  readonly cursorIndex: number
  readonly value: string
}

interface SerializedMarkProperties {
  readonly disableCommandStorage?: boolean | undefined
  readonly hidden?: boolean | undefined
  readonly hoverMessage?: string | undefined
  readonly id?: string | undefined
}

interface SerializedTerminalCommand {
  readonly command: string
  readonly commandLineConfidence: 'low' | 'medium' | 'high'
  readonly commandStartLineContent?: string | undefined
  readonly cwd?: string | undefined
  readonly duration: number
  readonly endLine?: number | undefined
  readonly executedLine?: number | undefined
  readonly executedX?: number | undefined
  readonly exitCode?: number | undefined
  readonly id?: string | undefined
  readonly isTrusted: boolean
  readonly markProperties?: SerializedMarkProperties | undefined
  readonly promptStartLine?: number | undefined
  readonly startLine?: number | undefined
  readonly startX?: number | undefined
  readonly timestamp: number
}

interface SerializedCommandDetectionCapability {
  readonly commands: readonly SerializedTerminalCommand[]
  readonly hasRichCommandDetection: boolean
  readonly isWindowsPty: boolean
  readonly promptInputModel?: SerializedPromptInputModel | undefined
}

interface SerializedCwdDetectionEntry {
  readonly cwd: string
  readonly line?: number | undefined
}

interface SerializedCwdDetection {
  readonly cwd: string
  readonly history: readonly SerializedCwdDetectionEntry[]
}

interface SerializedCapabilityStore {
  readonly cwdDetection?: SerializedCwdDetection | undefined
}

interface ReplayControlMessage {
  readonly capabilities?: SerializedCapabilityStore | undefined
  readonly commands?: SerializedCommandDetectionCapability | undefined
  readonly events: readonly [ReplayEventFrame, ...ReplayEventFrame[]]
  readonly type: 'replay'
}

interface ReplayCompleteControlMessage {
  readonly type: 'replayComplete'
}

/**
 * Number of characters between ack frames sent to the utility process.
 * Matches the server-side LOW_WATERMARK_CHARS / CharCountAckSize (5,000).
 */
const CHAR_COUNT_ACK_SIZE = 5000

/** Shape of a parsed status control message from the terminal service. */
interface StatusControlMessage {
  readonly exitCode?: number | undefined
  readonly status: string
  readonly type: 'status'
}

/** Shape of a parsed screen state control message from the terminal service. */
interface ScreenStateControlMessage {
  readonly data: string
  readonly type: 'screenState'
}

/** Shape of an error control message from the terminal service. */
interface ErrorControlMessage {
  readonly message: string
  readonly type: 'error'
}

/** Union of all control message types from the terminal service. */
type ControlMessage =
  | ErrorControlMessage
  | ReplayCompleteControlMessage
  | ReplayControlMessage
  | ScreenStateControlMessage
  | StatusControlMessage

/**
 * Attempt to parse a message as a JSON control message.
 * Returns the parsed message if valid, or undefined if the data is raw
 * PTY output.
 */
function parseControlMessage(data: string): ControlMessage | undefined {
  if (data.length === 0 || data[0] !== '{') {
    return undefined
  }
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>
    if (parsed.type === 'status' && typeof parsed.status === 'string') {
      return {
        type: 'status',
        status: parsed.status,
        exitCode:
          typeof parsed.exitCode === 'number' ? parsed.exitCode : undefined,
      }
    }
    if (parsed.type === 'screenState' && typeof parsed.data === 'string') {
      return {
        type: 'screenState',
        data: parsed.data,
      }
    }
    if (
      parsed.type === 'replay' &&
      Array.isArray(parsed.events) &&
      parsed.events.length > 0 &&
      parsed.events.every(
        (event) =>
          typeof event === 'object' &&
          event !== null &&
          typeof event.cols === 'number' &&
          typeof event.rows === 'number' &&
          typeof event.data === 'string'
      )
    ) {
      return {
        type: 'replay',
        capabilities: isSerializedCapabilityStore(parsed.capabilities)
          ? parsed.capabilities
          : undefined,
        commands: isSerializedCommandDetectionCapability(parsed.commands)
          ? parsed.commands
          : undefined,
        events: parsed.events as unknown as ReplayControlMessage['events'],
      }
    }
    if (parsed.type === 'replayComplete') {
      return { type: 'replayComplete' }
    }
    if (parsed.type === 'error' && typeof parsed.message === 'string') {
      return {
        type: 'error',
        message: parsed.message,
      }
    }
  } catch {
    // Not valid JSON — treat as terminal output
  }
  return undefined
}

function isSerializedCommandDetectionCapability(
  value: unknown
): value is SerializedCommandDetectionCapability {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.isWindowsPty === 'boolean' &&
    typeof candidate.hasRichCommandDetection === 'boolean' &&
    Array.isArray(candidate.commands) &&
    candidate.commands.every(isSerializedTerminalCommand) &&
    (candidate.promptInputModel === undefined ||
      isSerializedPromptInputModel(candidate.promptInputModel))
  )
}

function isSerializedPromptInputModel(
  value: unknown
): value is SerializedPromptInputModel {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.cursorIndex === 'number' &&
    typeof candidate.value === 'string'
  )
}

function isSerializedTerminalCommand(
  value: unknown
): value is SerializedTerminalCommand {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.command === 'string' &&
    (candidate.commandLineConfidence === 'low' ||
      candidate.commandLineConfidence === 'medium' ||
      candidate.commandLineConfidence === 'high') &&
    typeof candidate.isTrusted === 'boolean' &&
    typeof candidate.timestamp === 'number' &&
    typeof candidate.duration === 'number'
  )
}

function isSerializedCapabilityStore(
  value: unknown
): value is SerializedCapabilityStore {
  if (value === undefined || value === null) {
    return false
  }
  if (typeof value !== 'object') {
    return false
  }
  // The capability store is a bag of optional fields — any object is valid.
  // Validate cwdDetection shape if present.
  const candidate = value as Record<string, unknown>
  if (candidate.cwdDetection !== undefined) {
    if (
      typeof candidate.cwdDetection !== 'object' ||
      candidate.cwdDetection === null
    ) {
      return false
    }
    const cwd = candidate.cwdDetection as Record<string, unknown>
    if (typeof cwd.cwd !== 'string' || !Array.isArray(cwd.history)) {
      return false
    }
  }
  return true
}

interface UseTerminalMessagePortOptions {
  /** Callback invoked with terminal output data (raw UTF-8). */
  readonly onData: (data: string) => void

  /** Callback invoked after the terminal service completes replay. */
  readonly onReplayComplete?: () => void

  /** Callback invoked when a replay payload arrives for renderer rehydration. */
  readonly onReplayStart?: (replayEvent: ReplayControlMessage) => void

  /**
   * Callback invoked when a status control message is received.
   * Used by terminal-pane.tsx to handle restart (clear buffer) and
   * stopped (show exit banner) events.
   */
  readonly onStatus?: (
    status: TerminalStatus,
    exitCode: number | undefined
  ) => void

  /** The terminal ID to connect to. */
  readonly terminalId: string
}

interface UseTerminalMessagePortResult {
  /** Current restore/replay state for revived terminals. */
  readonly replayStatus: ReplayStatus
  /** Send input data to the PTY via MessagePort. */
  readonly send: (data: string) => void

  /** Current connection status. */
  readonly status: ConnectionStatus

  /**
   * Terminal process status derived from control messages.
   * Same as the WebSocket hook for UI compatibility.
   */
  readonly terminalStatus: TerminalStatus
}

/**
 * React hook that manages a MessagePort data channel to a terminal
 * utility process. Output data is delivered via the `onData` callback.
 * Input is sent via the returned `send` function.
 *
 * The hook acquires a MessagePort from the DesktopBridge on mount and
 * listens for messages. Unlike the WebSocket hook, there is no reconnection
 * logic — if the port closes (utility process restart), the hook transitions
 * to 'disconnected' status and the terminal pane can respond accordingly.
 */
function useTerminalMessagePort({
  terminalId,
  onData,
  onStatus,
  onReplayStart,
  onReplayComplete,
}: UseTerminalMessagePortOptions): UseTerminalMessagePortResult {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>('connecting')
  const [terminalStatus, setTerminalStatus] =
    useState<TerminalStatus>('running')
  const [replayStatus, setReplayStatus] = useState<ReplayStatus>('idle')
  /**
   * Ref tracking the current replay status for the `send()` guard.
   * The `send` callback is memoized (no deps) so it cannot read the
   * React state directly — it uses this ref instead.
   *
   * @see Issue #10: Replay input guard
   */
  const replayStatusRef = useRef<ReplayStatus>('idle')
  const portRef = useRef<MessagePort | null>(null)
  const mountedRef = useRef(true)

  /** Characters received since the last ack was sent (flow control). */
  const unackedCharsRef = useRef(0)

  // Refs for latest callback/state to avoid stale closures
  const onDataRef = useRef(onData)
  onDataRef.current = onData
  const onStatusRef = useRef(onStatus)
  onStatusRef.current = onStatus
  const onReplayStartRef = useRef(onReplayStart)
  onReplayStartRef.current = onReplayStart
  const onReplayCompleteRef = useRef(onReplayComplete)
  onReplayCompleteRef.current = onReplayComplete

  /** Decode ArrayBuffer to string for zero-copy output data. */
  const textDecoder = useRef(new TextDecoder())

  /**
   * Handle a parsed control message from the terminal service.
   */
  const handleControlMessage = useCallback((msg: ControlMessage): void => {
    if (msg.type === 'status') {
      const newStatus = msg.status as TerminalStatus
      setTerminalStatus(newStatus)
      onStatusRef.current?.(newStatus, msg.exitCode)
      return
    }
    if (msg.type === 'screenState') {
      onDataRef.current(msg.data)
      return
    }
    if (msg.type === 'replay') {
      replayStatusRef.current = 'replaying'
      setReplayStatus('replaying')
      onReplayStartRef.current?.(msg)
      return
    }
    if (msg.type === 'replayComplete') {
      replayStatusRef.current = 'complete'
      setReplayStatus('complete')
      onReplayCompleteRef.current?.()
      return
    }
    if (msg.type === 'error') {
      // Terminal not found or other server-side error.
      // Treat as disconnected — the terminal may have been removed.
      setConnectionStatus('disconnected')
    }
  }, [])

  /**
   * Send a flow control ack if the character threshold is reached.
   * Acks are suppressed during replay — the server drops them anyway,
   * and sending them could interfere with flow control state.
   *
   * @see Issue #10: Replay input guard
   */
  const maybeAck = useCallback((charCount: number) => {
    unackedCharsRef.current += charCount
    if (unackedCharsRef.current >= CHAR_COUNT_ACK_SIZE) {
      const chars = unackedCharsRef.current
      unackedCharsRef.current = 0
      if (replayStatusRef.current === 'replaying') {
        return
      }
      const port = portRef.current
      if (port) {
        port.postMessage(JSON.stringify({ type: 'ack', chars }))
      }
    }
  }, [])

  /**
   * Handle an incoming MessagePort message. Dispatches to the appropriate
   * handler based on message type (ArrayBuffer for zero-copy output,
   * string for PTY data or control messages).
   */
  const handleMessage = useCallback(
    (event: MessageEvent) => {
      if (!mountedRef.current) {
        return
      }

      const { data } = event

      // Handle ArrayBuffer (zero-copy large output from utility process)
      if (data instanceof ArrayBuffer) {
        const text = textDecoder.current.decode(data)
        onDataRef.current(text)
        maybeAck(text.length)
        return
      }

      // Handle string messages (PTY output or JSON control messages)
      if (typeof data === 'string') {
        const controlMsg = parseControlMessage(data)
        if (controlMsg !== undefined) {
          handleControlMessage(controlMsg)
          return
        }

        // Raw PTY output data
        onDataRef.current(data)
        maybeAck(data.length)
      }
    },
    [handleControlMessage, maybeAck]
  )

  // Acquire the MessagePort on mount
  useEffect(() => {
    mountedRef.current = true
    let port: MessagePort | null = null
    replayStatusRef.current = 'idle'
    setReplayStatus('idle')

    const acquire = async (): Promise<MessagePort | null> => {
      try {
        return await acquireTerminalDataPort(terminalId)
      } catch {
        return null
      }
    }

    const connect = async () => {
      port = await acquire()

      if (!(port && mountedRef.current)) {
        if (mountedRef.current) {
          setConnectionStatus('disconnected')
        }
        return
      }

      portRef.current = port
      setConnectionStatus('connected')
      unackedCharsRef.current = 0
      port.onmessage = handleMessage
    }

    connect()

    return () => {
      mountedRef.current = false
      if (port) {
        port.onmessage = null
        port.close()
        portRef.current = null
      }
    }
  }, [terminalId, handleMessage])

  /**
   * Send input to the PTY. No-ops during replay to prevent user
   * keystrokes from corrupting the replayed terminal state.
   *
   * @see Issue #10: Replay input guard
   */
  const send = useCallback((data: string) => {
    if (replayStatusRef.current === 'replaying') {
      return
    }
    portRef.current?.postMessage(data)
  }, [])

  return {
    send,
    status: connectionStatus,
    replayStatus,
    terminalStatus,
  }
}

export { useTerminalMessagePort }
export type {
  ConnectionStatus,
  ReplayControlMessage,
  ReplayEventFrame,
  ReplayStatus,
  SerializedCapabilityStore,
  SerializedCommandDetectionCapability,
  TerminalStatus,
  UseTerminalMessagePortResult,
}
