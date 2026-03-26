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

interface UseTerminalMessagePortOptions {
  /** Callback invoked with terminal output data (raw UTF-8). */
  readonly onData: (data: string) => void

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
}: UseTerminalMessagePortOptions): UseTerminalMessagePortResult {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>('connecting')
  const [terminalStatus, setTerminalStatus] =
    useState<TerminalStatus>('running')
  const portRef = useRef<MessagePort | null>(null)
  const mountedRef = useRef(true)

  /** Characters received since the last ack was sent (flow control). */
  const unackedCharsRef = useRef(0)

  // Refs for latest callback/state to avoid stale closures
  const onDataRef = useRef(onData)
  onDataRef.current = onData
  const onStatusRef = useRef(onStatus)
  onStatusRef.current = onStatus

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
    if (msg.type === 'error') {
      // Terminal not found or other server-side error.
      // Treat as disconnected — the terminal may have been removed.
      setConnectionStatus('disconnected')
    }
  }, [])

  /**
   * Send a flow control ack if the character threshold is reached.
   */
  const maybeAck = useCallback((charCount: number) => {
    unackedCharsRef.current += charCount
    if (unackedCharsRef.current >= CHAR_COUNT_ACK_SIZE) {
      const chars = unackedCharsRef.current
      unackedCharsRef.current = 0
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

  const send = useCallback((data: string) => {
    const port = portRef.current
    if (port) {
      port.postMessage(data)
    }
  }, [])

  return { send, status: connectionStatus, terminalStatus }
}

export { useTerminalMessagePort }
export type { ConnectionStatus, TerminalStatus, UseTerminalMessagePortResult }
