/**
 * Tests for TerminalSessionRouter (Issue 9).
 *
 * Verifies the centralized WebSocket stream management:
 * 1. Exactly one WebSocket per terminal ID (no duplicate connections)
 * 2. Multiple subscribers share a single WebSocket
 * 3. Cached screenState delivered to late subscribers
 * 4. Last subscriber unsubscribing closes the WebSocket
 * 5. Input routing via sendInput
 * 6. Dispose cleans up all sessions
 * 7. Flow control ack messages
 * 8. Reconnection after close
 *
 * WebSocket is mocked to avoid network dependencies in unit tests.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from 'vitest'
import type { TerminalSubscriberCallbacks } from '@/lib/terminal-session-router'
import { TerminalSessionRouter } from '@/lib/terminal-session-router'

// Mock the desktop module to control WebSocket URL generation
vi.mock('@/lib/desktop', () => ({
  terminalWsUrl: (terminalId: string) =>
    `ws://localhost:2101/terminal?id=${terminalId}`,
}))

const MAX_RECONNECT_DELAY = 30_000

// ============================================================================
// Mock WebSocket
// ============================================================================

/** Tracks all MockWebSocket instances created during a test. */
const mockWebSockets: MockWebSocket[] = []

/**
 * Minimal WebSocket mock that captures lifecycle events and sent data.
 * Allows tests to simulate server messages and connection state transitions.
 */
class MockWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3

  url: string
  readyState: number = MockWebSocket.CONNECTING
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null

  /** All data sent via ws.send() — captured for assertions. */
  sentData: string[] = []

  /** Whether close() was called. */
  closed = false

  constructor(url: string) {
    this.url = url
    mockWebSockets.push(this)
  }

  send(data: string): void {
    this.sentData.push(data)
  }

  close(): void {
    this.closed = true
    this.readyState = MockWebSocket.CLOSED
  }

  // ---- Test helpers ----

  /** Simulate the server accepting the connection. */
  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.(new Event('open'))
  }

  /** Simulate the server sending a text message. */
  simulateMessage(data: string): void {
    this.onmessage?.(new MessageEvent('message', { data }))
  }

  /** Simulate the connection closing. */
  simulateClose(): void {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.(new CloseEvent('close'))
  }
}

/**
 * Get a MockWebSocket by index, throwing if not found.
 * Satisfies TypeScript's strict null checks on array access.
 */
function getWs(index: number): MockWebSocket {
  const ws = mockWebSockets[index]
  if (!ws) {
    throw new Error(`Expected MockWebSocket at index ${index}, but none found`)
  }
  return ws
}

/** Get the last created MockWebSocket. */
function getLastWs(): MockWebSocket {
  return getWs(mockWebSockets.length - 1)
}

// Install the mock WebSocket globally
beforeEach(() => {
  mockWebSockets.length = 0
  vi.stubGlobal('WebSocket', MockWebSocket)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

/** Helper: create a set of spy callbacks for subscribing. */
function createSpyCallbacks(): TerminalSubscriberCallbacks & {
  onOutput: Mock
  onScreenState: Mock
  onStatus: Mock
} {
  return {
    onOutput: vi.fn(),
    onScreenState: vi.fn(),
    onStatus: vi.fn(),
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('TerminalSessionRouter', () => {
  describe('subscribe and WebSocket lifecycle', () => {
    it('subscribe returns an unsubscribe function', () => {
      const router = new TerminalSessionRouter()
      const callbacks = createSpyCallbacks()
      const unsubscribe = router.subscribe('term-1', callbacks)

      expect(typeof unsubscribe).toBe('function')

      unsubscribe()
      router.dispose()
    })

    it('first subscriber opens exactly one WebSocket', () => {
      const router = new TerminalSessionRouter()
      const callbacks = createSpyCallbacks()
      router.subscribe('term-1', callbacks)

      expect(mockWebSockets).toHaveLength(1)
      expect(getWs(0).url).toBe('ws://localhost:2101/terminal?id=term-1')

      router.dispose()
    })

    it('two subscribers to the same terminal share one WebSocket', () => {
      const router = new TerminalSessionRouter()
      const callbacks1 = createSpyCallbacks()
      const callbacks2 = createSpyCallbacks()

      router.subscribe('term-1', callbacks1)
      router.subscribe('term-1', callbacks2)

      // Only one WebSocket should have been created
      expect(mockWebSockets).toHaveLength(1)
      expect(router.hasSubscribers('term-1')).toBe(true)

      router.dispose()
    })

    it('different terminal IDs get separate WebSockets', () => {
      const router = new TerminalSessionRouter()
      const callbacks1 = createSpyCallbacks()
      const callbacks2 = createSpyCallbacks()

      router.subscribe('term-1', callbacks1)
      router.subscribe('term-2', callbacks2)

      expect(mockWebSockets).toHaveLength(2)
      expect(getWs(0).url).toContain('term-1')
      expect(getWs(1).url).toContain('term-2')

      router.dispose()
    })

    it('last subscriber unsubscribing closes the WebSocket', () => {
      const router = new TerminalSessionRouter()
      const callbacks = createSpyCallbacks()
      const unsubscribe = router.subscribe('term-1', callbacks)

      const ws = getWs(0)
      ws.simulateOpen()

      unsubscribe()

      expect(ws.closed).toBe(true)
      expect(router.hasSubscribers('term-1')).toBe(false)
      expect(router.getSessionCount()).toBe(0)

      router.dispose()
    })

    it('unsubscribing one of two subscribers does not close the WebSocket', () => {
      const router = new TerminalSessionRouter()
      const callbacks1 = createSpyCallbacks()
      const callbacks2 = createSpyCallbacks()

      const unsub1 = router.subscribe('term-1', callbacks1)
      router.subscribe('term-1', callbacks2)

      const ws = getWs(0)
      ws.simulateOpen()

      unsub1()

      // WebSocket should still be open — one subscriber remains
      expect(ws.closed).toBe(false)
      expect(router.hasSubscribers('term-1')).toBe(true)

      router.dispose()
    })

    it('subscribing after full unsubscribe creates a new WebSocket', () => {
      const router = new TerminalSessionRouter()
      const callbacks1 = createSpyCallbacks()
      const unsub1 = router.subscribe('term-1', callbacks1)

      getWs(0).simulateOpen()
      unsub1()

      expect(mockWebSockets).toHaveLength(1)
      expect(getWs(0).closed).toBe(true)

      // New subscribe should create a new WebSocket
      const callbacks2 = createSpyCallbacks()
      router.subscribe('term-1', callbacks2)

      expect(mockWebSockets).toHaveLength(2)
      expect(getWs(1).closed).toBe(false)

      router.dispose()
    })
  })

  describe('output broadcasting', () => {
    it('broadcasts PTY output to all subscribers', () => {
      const router = new TerminalSessionRouter()
      const callbacks1 = createSpyCallbacks()
      const callbacks2 = createSpyCallbacks()

      router.subscribe('term-1', callbacks1)
      router.subscribe('term-1', callbacks2)

      const ws = getWs(0)
      ws.simulateOpen()
      ws.simulateMessage('hello world')

      expect(callbacks1.onOutput).toHaveBeenCalledWith('hello world')
      expect(callbacks2.onOutput).toHaveBeenCalledWith('hello world')

      router.dispose()
    })

    it('does not broadcast to unsubscribed callbacks', () => {
      const router = new TerminalSessionRouter()
      const callbacks1 = createSpyCallbacks()
      const callbacks2 = createSpyCallbacks()

      const unsub1 = router.subscribe('term-1', callbacks1)
      router.subscribe('term-1', callbacks2)

      const ws = getWs(0)
      ws.simulateOpen()
      unsub1()

      ws.simulateMessage('after unsubscribe')

      expect(callbacks1.onOutput).not.toHaveBeenCalled()
      expect(callbacks2.onOutput).toHaveBeenCalledWith('after unsubscribe')

      router.dispose()
    })
  })

  describe('screenState caching and late delivery', () => {
    it('caches screenState and delivers to late subscribers', async () => {
      vi.useFakeTimers()
      const router = new TerminalSessionRouter()
      const callbacks1 = createSpyCallbacks()

      router.subscribe('term-1', callbacks1)

      const ws = getWs(0)
      ws.simulateOpen()

      // Server sends screenState
      ws.simulateMessage(
        JSON.stringify({ type: 'screenState', data: '\x1b[Hscreen data' })
      )

      expect(callbacks1.onScreenState).toHaveBeenCalledWith('\x1b[Hscreen data')

      // Late subscriber should receive cached screenState via setTimeout(0)
      const callbacks2 = createSpyCallbacks()
      router.subscribe('term-1', callbacks2)

      // Not yet delivered (waiting for setTimeout(0))
      expect(callbacks2.onScreenState).not.toHaveBeenCalled()

      // Flush setTimeout(0)
      await vi.advanceTimersByTimeAsync(0)

      expect(callbacks2.onScreenState).toHaveBeenCalledWith('\x1b[Hscreen data')

      router.dispose()
      vi.useRealTimers()
    })

    it('does not deliver stale screenState after unsubscribe', async () => {
      vi.useFakeTimers()
      const router = new TerminalSessionRouter()
      const callbacks1 = createSpyCallbacks()

      router.subscribe('term-1', callbacks1)

      const ws = getWs(0)
      ws.simulateOpen()
      ws.simulateMessage(
        JSON.stringify({ type: 'screenState', data: 'screen' })
      )

      // Subscribe and immediately unsubscribe before setTimeout fires
      const callbacks2 = createSpyCallbacks()
      const unsub2 = router.subscribe('term-1', callbacks2)
      unsub2()

      await vi.advanceTimersByTimeAsync(0)

      // Should NOT have been delivered because subscriber was removed
      expect(callbacks2.onScreenState).not.toHaveBeenCalled()

      router.dispose()
      vi.useRealTimers()
    })
  })

  describe('status control messages', () => {
    it('broadcasts status control messages to subscribers', () => {
      const router = new TerminalSessionRouter()
      const callbacks = createSpyCallbacks()

      router.subscribe('term-1', callbacks)
      const ws = getWs(0)
      ws.simulateOpen()

      ws.simulateMessage(JSON.stringify({ type: 'status', status: 'running' }))

      expect(callbacks.onStatus).toHaveBeenCalledWith('running', undefined)

      router.dispose()
    })

    it('handles stopped status with exit code', () => {
      const router = new TerminalSessionRouter()
      const callbacks = createSpyCallbacks()

      router.subscribe('term-1', callbacks)
      const ws = getWs(0)
      ws.simulateOpen()

      ws.simulateMessage(
        JSON.stringify({
          type: 'status',
          status: 'stopped',
          exitCode: 0,
        })
      )

      expect(callbacks.onStatus).toHaveBeenCalledWith('stopped', 0)
      expect(router.getTerminalStatus('term-1')).toBe('stopped')

      router.dispose()
    })

    it('delivers cached exit state to late subscribers', async () => {
      vi.useFakeTimers()
      const router = new TerminalSessionRouter()
      const callbacks1 = createSpyCallbacks()

      router.subscribe('term-1', callbacks1)
      const ws = getWs(0)
      ws.simulateOpen()

      // Terminal exits
      ws.simulateMessage(
        JSON.stringify({
          type: 'status',
          status: 'stopped',
          exitCode: 1,
        })
      )

      // Late subscriber should get exit status
      const callbacks2 = createSpyCallbacks()
      router.subscribe('term-1', callbacks2)

      await vi.advanceTimersByTimeAsync(0)

      expect(callbacks2.onStatus).toHaveBeenCalledWith('stopped', 1)

      router.dispose()
      vi.useRealTimers()
    })

    it('clears cached screenState on restart', () => {
      const router = new TerminalSessionRouter()
      const callbacks = createSpyCallbacks()

      router.subscribe('term-1', callbacks)
      const ws = getWs(0)
      ws.simulateOpen()

      // Screen state arrives
      ws.simulateMessage(
        JSON.stringify({ type: 'screenState', data: 'old screen' })
      )

      // Terminal restarts
      ws.simulateMessage(
        JSON.stringify({ type: 'status', status: 'restarted' })
      )

      expect(callbacks.onStatus).toHaveBeenCalledWith('restarted', undefined)
      // After restart, exit state should be cleared
      expect(router.getTerminalStatus('term-1')).toBe('restarted')

      router.dispose()
    })
  })

  describe('sendInput', () => {
    it('sends data through the WebSocket for the correct terminal', () => {
      const router = new TerminalSessionRouter()
      const callbacks = createSpyCallbacks()

      router.subscribe('term-1', callbacks)
      const ws = getWs(0)
      ws.simulateOpen()

      router.sendInput('term-1', 'ls -la\r')

      expect(ws.sentData).toContain('ls -la\r')

      router.dispose()
    })

    it('does not send to non-existent terminal sessions', () => {
      const router = new TerminalSessionRouter()

      // Should not throw, just no-op
      router.sendInput('nonexistent', 'hello')

      router.dispose()
    })

    it('does not send when WebSocket is not open', () => {
      const router = new TerminalSessionRouter()
      const callbacks = createSpyCallbacks()

      router.subscribe('term-1', callbacks)
      // Don't simulate open — WebSocket is still CONNECTING

      router.sendInput('term-1', 'hello')

      expect(getWs(0).sentData).toHaveLength(0)

      router.dispose()
    })
  })

  describe('flow control', () => {
    it('sends ack frame after receiving CHAR_COUNT_ACK_SIZE characters', () => {
      const router = new TerminalSessionRouter()
      const callbacks = createSpyCallbacks()

      router.subscribe('term-1', callbacks)
      const ws = getWs(0)
      ws.simulateOpen()

      // Send enough data to trigger an ack (5000 chars)
      const data = 'x'.repeat(5000)
      ws.simulateMessage(data)

      // Find the ack message in sent data
      const ackMessages = ws.sentData.filter((d) => d.includes('"ack"'))
      expect(ackMessages).toHaveLength(1)

      const parsed = JSON.parse(ackMessages[0] ?? '{}')
      expect(parsed.type).toBe('ack')
      expect(parsed.chars).toBe(5000)

      router.dispose()
    })

    it('does not send ack for small messages', () => {
      const router = new TerminalSessionRouter()
      const callbacks = createSpyCallbacks()

      router.subscribe('term-1', callbacks)
      const ws = getWs(0)
      ws.simulateOpen()

      ws.simulateMessage('short')

      const ackMessages = ws.sentData.filter((d) => d.includes('"ack"'))
      expect(ackMessages).toHaveLength(0)

      router.dispose()
    })
  })

  describe('connection status', () => {
    it('tracks connection status through lifecycle', () => {
      const router = new TerminalSessionRouter()
      const callbacks = createSpyCallbacks()

      // Before subscribe
      expect(router.getConnectionStatus('term-1')).toBe('disconnected')

      router.subscribe('term-1', callbacks)
      expect(router.getConnectionStatus('term-1')).toBe('connecting')

      getWs(0).simulateOpen()
      expect(router.getConnectionStatus('term-1')).toBe('connected')

      router.dispose()
    })

    it('returns disconnected for non-existent sessions', () => {
      const router = new TerminalSessionRouter()
      expect(router.getConnectionStatus('nonexistent')).toBe('disconnected')
      router.dispose()
    })
  })

  describe('reconnection', () => {
    it('reconnects with exponential backoff after connection close', () => {
      vi.useFakeTimers()
      const router = new TerminalSessionRouter()
      const callbacks = createSpyCallbacks()

      router.subscribe('term-1', callbacks)
      const ws1 = getWs(0)
      ws1.simulateOpen()
      ws1.simulateClose()

      expect(router.getConnectionStatus('term-1')).toBe('disconnected')

      // Advance past initial reconnect delay (500ms)
      vi.advanceTimersByTime(500)

      // A new WebSocket should have been created
      expect(mockWebSockets).toHaveLength(2)

      router.dispose()
      vi.useRealTimers()
    })

    it('does not reconnect when terminal is stopped', () => {
      vi.useFakeTimers()
      const router = new TerminalSessionRouter()
      const callbacks = createSpyCallbacks()

      router.subscribe('term-1', callbacks)
      const ws = getWs(0)
      ws.simulateOpen()

      // Terminal stops
      ws.simulateMessage(
        JSON.stringify({ type: 'status', status: 'stopped', exitCode: 0 })
      )

      ws.simulateClose()

      // Advance time — should NOT reconnect
      vi.advanceTimersByTime(60_000)

      expect(mockWebSockets).toHaveLength(1)

      router.dispose()
      vi.useRealTimers()
    })

    it('stops reconnecting after MAX_CONSECUTIVE_FAILURES', () => {
      vi.useFakeTimers()
      const router = new TerminalSessionRouter()
      const callbacks = createSpyCallbacks()

      router.subscribe('term-1', callbacks)

      // Simulate 3 consecutive failures (never reaching onopen)
      for (let i = 0; i < 3; i++) {
        const ws = getLastWs()
        ws.simulateClose() // Close without ever opening
        vi.advanceTimersByTime(MAX_RECONNECT_DELAY + 1000) // Advance past any backoff
      }

      const countAfterFailures = mockWebSockets.length

      // No more reconnections should happen
      vi.advanceTimersByTime(60_000)
      expect(mockWebSockets.length).toBe(countAfterFailures)

      router.dispose()
      vi.useRealTimers()
    })
  })

  describe('dispose', () => {
    it('closes all WebSockets on dispose', () => {
      const router = new TerminalSessionRouter()
      const callbacks1 = createSpyCallbacks()
      const callbacks2 = createSpyCallbacks()

      router.subscribe('term-1', callbacks1)
      router.subscribe('term-2', callbacks2)

      getWs(0).simulateOpen()
      getWs(1).simulateOpen()

      router.dispose()

      expect(getWs(0).closed).toBe(true)
      expect(getWs(1).closed).toBe(true)
      expect(router.getSessionCount()).toBe(0)
    })

    it('rejects new subscriptions after dispose', () => {
      const router = new TerminalSessionRouter()
      router.dispose()

      const callbacks = createSpyCallbacks()
      const unsubscribe = router.subscribe('term-1', callbacks)

      // Should return a no-op unsubscribe and not create a WebSocket
      expect(typeof unsubscribe).toBe('function')
      expect(mockWebSockets).toHaveLength(0)

      unsubscribe() // Should not throw
    })
  })

  describe('message parsing', () => {
    it('treats non-JSON messages as PTY output', () => {
      const router = new TerminalSessionRouter()
      const callbacks = createSpyCallbacks()

      router.subscribe('term-1', callbacks)
      const ws = getWs(0)
      ws.simulateOpen()

      ws.simulateMessage('regular terminal output')

      expect(callbacks.onOutput).toHaveBeenCalledWith('regular terminal output')
      expect(callbacks.onStatus).not.toHaveBeenCalled()
      expect(callbacks.onScreenState).not.toHaveBeenCalled()

      router.dispose()
    })

    it('treats malformed JSON as PTY output', () => {
      const router = new TerminalSessionRouter()
      const callbacks = createSpyCallbacks()

      router.subscribe('term-1', callbacks)
      const ws = getWs(0)
      ws.simulateOpen()

      ws.simulateMessage('{invalid json}')

      expect(callbacks.onOutput).toHaveBeenCalledWith('{invalid json}')

      router.dispose()
    })

    it('treats JSON without recognized type as PTY output', () => {
      const router = new TerminalSessionRouter()
      const callbacks = createSpyCallbacks()

      router.subscribe('term-1', callbacks)
      const ws = getWs(0)
      ws.simulateOpen()

      ws.simulateMessage(JSON.stringify({ type: 'unknown', data: 'foo' }))

      expect(callbacks.onOutput).toHaveBeenCalledWith(
        JSON.stringify({ type: 'unknown', data: 'foo' })
      )

      router.dispose()
    })

    it('ignores non-string WebSocket messages', () => {
      const router = new TerminalSessionRouter()
      const callbacks = createSpyCallbacks()

      router.subscribe('term-1', callbacks)
      const ws = getWs(0)
      ws.simulateOpen()

      // Simulate a binary message (non-string data)
      ws.onmessage?.(new MessageEvent('message', { data: new ArrayBuffer(4) }))

      expect(callbacks.onOutput).not.toHaveBeenCalled()

      router.dispose()
    })
  })

  describe('getSessionCount', () => {
    it('tracks active session count', () => {
      const router = new TerminalSessionRouter()

      expect(router.getSessionCount()).toBe(0)

      const unsub1 = router.subscribe('term-1', createSpyCallbacks())
      expect(router.getSessionCount()).toBe(1)

      router.subscribe('term-2', createSpyCallbacks())
      expect(router.getSessionCount()).toBe(2)

      // Same terminal, different subscriber
      router.subscribe('term-1', createSpyCallbacks())
      expect(router.getSessionCount()).toBe(2)

      unsub1()
      // term-1 still has one subscriber
      expect(router.getSessionCount()).toBe(2)

      router.dispose()
    })
  })
})
