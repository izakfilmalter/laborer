/**
 * TerminalSessionRouter — centralized WebSocket stream manager for terminal sessions.
 *
 * Eliminates entire classes of bugs by enforcing:
 * 1. Exactly one WebSocket connection per terminalId (no duplicate connections)
 * 2. Explicit routing via Map lookup (no closure captures of stale WebSockets)
 * 3. Synchronous subscribe/unsubscribe (no timing races)
 * 4. Cached screenState for late subscribers (no server round-trip)
 *
 * This replaces the per-component `useTerminalWebSocket` hook with a shared router
 * that manages WebSocket lifecycle centrally. Multiple React components can subscribe
 * to the same terminal session and share a single WebSocket connection.
 *
 * Message protocol (preserved from existing WebSocket endpoint):
 * - Server → Client: JSON control messages (`{"type":"status",...}`, `{"type":"screenState",...}`)
 * - Server → Client: Raw PTY output as text frames
 * - Client → Server: Raw terminal input as text frames
 * - Client → Server: Flow control acks (`{"type":"ack","chars":N}`)
 *
 * @see packages/terminal/src/routes/terminal-ws.ts — WebSocket endpoint
 * @see apps/web/src/hooks/use-terminal-websocket.ts — original per-component hook (replaced by this)
 * @see .reference/mux/src/browser/terminal/TerminalSessionRouter.ts — reference pattern
 */

import { terminalWsUrl } from '@/lib/desktop'

/** Terminal process status derived from WebSocket control messages. */
type TerminalStatus = 'running' | 'stopped' | 'restarted'

/** Callbacks provided by each subscriber to receive terminal events. */
interface TerminalSubscriberCallbacks {
  /** Called with raw PTY output data (UTF-8 text). */
  readonly onOutput: (data: string) => void
  /** Called when screen state snapshot arrives (compact VT escape sequences ~4KB). */
  readonly onScreenState: (state: string) => void
  /** Called when the terminal process status changes (running/stopped/restarted). */
  readonly onStatus: (
    status: TerminalStatus,
    exitCode: number | undefined
  ) => void
}

/** WebSocket connection state for a terminal session. */
type SessionConnectionStatus = 'connecting' | 'connected' | 'disconnected'

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

/** Union of all control message types from the terminal service. */
type ControlMessage = StatusControlMessage | ScreenStateControlMessage

/** Configuration for exponential backoff reconnection. */
const INITIAL_RECONNECT_DELAY_MS = 500
const MAX_RECONNECT_DELAY_MS = 30_000
const RECONNECT_BACKOFF_FACTOR = 2

/**
 * Max consecutive connection failures (never reached onopen) before
 * giving up. Prevents infinite reconnection loops when the terminal
 * no longer exists on the server.
 */
const MAX_CONSECUTIVE_FAILURES = 3

/**
 * Number of characters between ack frames sent to the server.
 * Matches the server-side LOW_WATERMARK_CHARS / CharCountAckSize (5,000).
 */
const CHAR_COUNT_ACK_SIZE = 5000

/** Internal state for a single terminal session. */
interface SessionState {
  /** Current connection status. */
  connectionStatus: SessionConnectionStatus
  /** Consecutive connection failures (never reached onopen). */
  consecutiveFailures: number
  /** Whether the current WebSocket reached onopen. */
  didOpen: boolean
  /** Exit code if exited. */
  exitCode: number | undefined
  /** Whether the terminal has exited. */
  exited: boolean
  /** Current reconnection delay (exponential backoff). */
  reconnectDelay: number
  /** Reconnection timer ID. */
  reconnectTimer: ReturnType<typeof setTimeout> | null
  /** Cached screen state (sent to late subscribers immediately). */
  screenState: string | null
  /** Unique subscriber ID → callbacks. */
  readonly subscribers: Map<number, TerminalSubscriberCallbacks>
  /** Terminal process status (last known). */
  terminalStatus: TerminalStatus
  /** Characters received since last ack (flow control). */
  unackedChars: number
  /** Current WebSocket instance (null when disconnected). */
  ws: WebSocket | null
}

let nextSubscriberId = 1

/**
 * Attempt to parse a WebSocket text frame as a JSON control message.
 * Returns the parsed message if valid, or undefined if the frame is raw
 * PTY output data.
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
  } catch {
    // Not valid JSON — treat as terminal output
  }
  return undefined
}

/**
 * TerminalSessionRouter manages WebSocket connections to terminal sessions.
 *
 * Key invariants:
 * - Exactly one WebSocket per terminal ID (shared across all subscribers)
 * - Screen state is cached and delivered to late subscribers via setTimeout(0)
 * - Last subscriber unsubscribing closes the WebSocket and cleans up
 * - Reconnection with exponential backoff is managed per-session
 * - Flow control acks are sent per-session
 */
class TerminalSessionRouter {
  private readonly sessions = new Map<string, SessionState>()
  private disposed = false

  /**
   * Subscribe to a terminal session's output.
   *
   * If this is the first subscriber for the session, opens a WebSocket.
   * If screenState is already cached (from a previous subscriber), delivers
   * it immediately via setTimeout(0).
   *
   * @returns Unsubscribe function (call to stop receiving data)
   */
  subscribe(
    terminalId: string,
    callbacks: TerminalSubscriberCallbacks
  ): () => void {
    if (this.disposed) {
      return () => {
        // No-op: router is disposed, subscription is rejected
      }
    }

    const subscriberId = nextSubscriberId++

    let session = this.sessions.get(terminalId)
    if (!session) {
      // First subscriber — create session state and connect
      session = {
        subscribers: new Map(),
        screenState: null,
        ws: null,
        connectionStatus: 'connecting',
        terminalStatus: 'running',
        exited: false,
        exitCode: undefined,
        reconnectTimer: null,
        reconnectDelay: INITIAL_RECONNECT_DELAY_MS,
        consecutiveFailures: 0,
        unackedChars: 0,
        didOpen: false,
      }
      this.sessions.set(terminalId, session)
      this.connectSession(terminalId, session)
    }

    // Add subscriber
    session.subscribers.set(subscriberId, callbacks)

    // Deliver cached screenState to late subscribers (after caller finishes setup)
    if (session.screenState !== null) {
      setTimeout(() => {
        const currentSession = this.sessions.get(terminalId)
        const currentCallbacks = currentSession?.subscribers.get(subscriberId)
        if (
          currentCallbacks &&
          currentSession &&
          currentSession.screenState !== null
        ) {
          currentCallbacks.onScreenState(currentSession.screenState)
        }
      }, 0)
    }

    // Deliver cached exit state to late subscribers
    if (session.exited) {
      setTimeout(() => {
        const currentSession = this.sessions.get(terminalId)
        const currentCallbacks = currentSession?.subscribers.get(subscriberId)
        if (currentCallbacks && currentSession?.exited) {
          currentCallbacks.onStatus('stopped', currentSession.exitCode)
        }
      }, 0)
    }

    // Return unsubscribe function
    return () => {
      const currentSession = this.sessions.get(terminalId)
      if (!currentSession) {
        return
      }

      currentSession.subscribers.delete(subscriberId)

      // If no more subscribers, tear down the session
      if (currentSession.subscribers.size === 0) {
        this.teardownSession(terminalId, currentSession)
      }
    }
  }

  /**
   * Send terminal input data to the PTY via WebSocket text frame.
   * No-op if the terminal has no active WebSocket connection.
   */
  sendInput(terminalId: string, data: string): void {
    const session = this.sessions.get(terminalId)
    if (session?.ws?.readyState === WebSocket.OPEN) {
      session.ws.send(data)
    }
  }

  /**
   * Get the current connection status for a terminal session.
   * Returns 'disconnected' if the session does not exist.
   */
  getConnectionStatus(terminalId: string): SessionConnectionStatus {
    return this.sessions.get(terminalId)?.connectionStatus ?? 'disconnected'
  }

  /**
   * Get the current terminal process status for a session.
   * Returns 'running' if the session does not exist (default assumption).
   */
  getTerminalStatus(terminalId: string): TerminalStatus {
    return this.sessions.get(terminalId)?.terminalStatus ?? 'running'
  }

  /**
   * Check if a session has any active subscribers.
   */
  hasSubscribers(terminalId: string): boolean {
    const session = this.sessions.get(terminalId)
    return session ? session.subscribers.size > 0 : false
  }

  /**
   * Get the number of active sessions (for testing/debugging).
   */
  getSessionCount(): number {
    return this.sessions.size
  }

  /**
   * Dispose all sessions — closes all WebSockets and clears all state.
   * After disposal, no new subscriptions are accepted.
   */
  dispose(): void {
    this.disposed = true
    for (const [terminalId, session] of this.sessions) {
      this.teardownSession(terminalId, session)
    }
  }

  // ============================================================================
  // Private methods
  // ============================================================================

  /**
   * Open a WebSocket connection for a terminal session.
   */
  private connectSession(terminalId: string, session: SessionState): void {
    if (this.disposed) {
      return
    }

    const wsUrl = terminalWsUrl(terminalId)
    session.connectionStatus = 'connecting'
    session.didOpen = false

    const ws = new WebSocket(wsUrl)
    session.ws = ws

    ws.onopen = () => {
      // Check that this WebSocket is still the active one for this session
      if (session.ws !== ws || this.disposed) {
        ws.close()
        return
      }

      session.didOpen = true
      session.consecutiveFailures = 0
      session.connectionStatus = 'connected'
      session.reconnectDelay = INITIAL_RECONNECT_DELAY_MS
      session.unackedChars = 0
    }

    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== 'string' || session.ws !== ws) {
        return
      }

      const controlMsg = parseControlMessage(event.data)
      if (controlMsg !== undefined) {
        this.handleControlMessage(session, controlMsg)
        return
      }

      // Raw PTY output — broadcast to all subscribers
      for (const callbacks of session.subscribers.values()) {
        callbacks.onOutput(event.data)
      }

      // Flow control: count received characters and send ack frames
      session.unackedChars += event.data.length
      if (session.unackedChars >= CHAR_COUNT_ACK_SIZE) {
        const chars = session.unackedChars
        session.unackedChars = 0
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ack', chars }))
        }
      }
    }

    ws.onclose = () => {
      if (session.ws !== ws) {
        return
      }

      session.ws = null
      session.connectionStatus = 'disconnected'

      // Track consecutive failures where the connection never opened
      if (!session.didOpen) {
        session.consecutiveFailures += 1
      }

      // Only reconnect if the terminal is still running AND we haven't
      // exceeded the max consecutive failure threshold AND there are
      // still subscribers AND the router isn't disposed
      if (
        session.terminalStatus !== 'stopped' &&
        session.consecutiveFailures < MAX_CONSECUTIVE_FAILURES &&
        session.subscribers.size > 0 &&
        !this.disposed
      ) {
        const delay = session.reconnectDelay
        session.reconnectDelay = Math.min(
          delay * RECONNECT_BACKOFF_FACTOR,
          MAX_RECONNECT_DELAY_MS
        )
        session.reconnectTimer = setTimeout(() => {
          session.reconnectTimer = null
          if (session.subscribers.size > 0 && !this.disposed) {
            this.connectSession(terminalId, session)
          }
        }, delay)
      }
    }

    ws.onerror = () => {
      // onerror is always followed by onclose — let onclose handle cleanup
    }
  }

  /**
   * Handle a parsed control message from the terminal service.
   */
  private handleControlMessage(
    session: SessionState,
    msg: ControlMessage
  ): void {
    if (msg.type === 'status') {
      const newStatus = msg.status as TerminalStatus
      session.terminalStatus = newStatus

      if (newStatus === 'stopped') {
        session.exited = true
        session.exitCode = msg.exitCode
      }

      // On restart, reset exit state and reconnect if disconnected
      if (newStatus === 'restarted') {
        session.exited = false
        session.exitCode = undefined
        // Clear cached screen state on restart (terminal was reset)
        session.screenState = null
      }

      // Broadcast to all subscribers
      for (const callbacks of session.subscribers.values()) {
        callbacks.onStatus(newStatus, msg.exitCode)
      }
      return
    }

    if (msg.type === 'screenState') {
      // Cache and broadcast screen state
      session.screenState = msg.data
      for (const callbacks of session.subscribers.values()) {
        callbacks.onScreenState(msg.data)
      }
    }
  }

  /**
   * Tear down a terminal session — close WebSocket, cancel timers, remove from map.
   */
  private teardownSession(terminalId: string, session: SessionState): void {
    // Cancel any pending reconnection
    if (session.reconnectTimer !== null) {
      clearTimeout(session.reconnectTimer)
      session.reconnectTimer = null
    }

    // Close WebSocket
    if (session.ws) {
      const ws = session.ws
      session.ws = null
      // Prevent reconnection on intentional close
      ws.onclose = null
      ws.close()
    }

    this.sessions.delete(terminalId)
  }
}

export { TerminalSessionRouter }
export type {
  SessionConnectionStatus,
  TerminalStatus,
  TerminalSubscriberCallbacks,
}
