/**
 * Daytona Terminal Data Channel — Per-terminal MessagePort I/O bridge
 *
 * Bridges a MessagePort data channel from the renderer (xterm.js) to a
 * Daytona PTY WebSocket session. This is the server-side counterpart
 * of the terminal utility process's `terminal-data-channel.ts`, but for
 * Daytona PTY sessions instead of local node-pty sessions.
 *
 * Protocol is intentionally identical to the Docker terminal path so
 * the renderer's `useTerminalMessagePort` hook works unchanged:
 *
 * - Server -> Renderer: Raw UTF-8 strings (PTY output data)
 * - Server -> Renderer: JSON control messages:
 *   - `{"type":"status","status":"running"}` — sent on connect
 *   - `{"type":"status","status":"stopped"}` — PTY exited
 * - Renderer -> Server: Raw terminal input strings (keystrokes)
 *
 * Flow control ack messages are parsed but currently no-op for Daytona
 * PTY sessions since the WebSocket backpressure is managed by the SDK.
 *
 * @see packages/terminal/src/services/terminal-data-channel.ts — Docker equivalent
 * @see packages/server/src/services/daytona-sandbox-provider.ts — PtyHandle registry
 * @see Issue #17: Daytona PTY — bridge to xterm.js terminal component
 */

import type { PtyHandle } from '@daytonaio/sdk'
import type { RpcMessagePort } from '@laborer/shared/rpc-transport-messageport'

import {
  getDaytonaPtyHandle,
  removeDaytonaPtyHandle,
} from './daytona-sandbox-provider.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Prefix applied to Daytona terminal session IDs so the main process
 * can route data port requests to the server utility process (which
 * holds the PtyHandle) instead of the terminal utility process.
 */
const DAYTONA_TERMINAL_ID_PREFIX = 'daytona:'

/**
 * Check whether a terminal ID belongs to a Daytona PTY session.
 * Used by the Electron main process IPC handler to route data port
 * requests to the correct utility process.
 */
const isDaytonaTerminalId = (terminalId: string): boolean =>
  terminalId.startsWith(DAYTONA_TERMINAL_ID_PREFIX)

/**
 * Strip the `daytona:` prefix from a terminal ID to get the raw
 * Daytona PTY session ID used as the key in the PtyHandle registry.
 */
const stripDaytonaPrefix = (terminalId: string): string =>
  terminalId.slice(DAYTONA_TERMINAL_ID_PREFIX.length)

// ---------------------------------------------------------------------------
// Control message helpers (matches terminal-data-channel.ts format)
// ---------------------------------------------------------------------------

const encodeStatus = (status: string, exitCode?: number): string => {
  const message: Record<string, unknown> = { type: 'status', status }
  if (exitCode !== undefined) {
    message.exitCode = exitCode
  }
  return JSON.stringify(message)
}

const encodeError = (message: string): string =>
  JSON.stringify({ type: 'error', message })

// ---------------------------------------------------------------------------
// Client message parsing
// ---------------------------------------------------------------------------

/**
 * Parse an incoming message from the renderer. Returns the type and
 * payload for flow control ack messages, or null for raw terminal input.
 */
function parseClientMessage(
  data: string
): { type: 'ack'; chars: number } | null {
  if (data.length > 0 && data[0] === '{' && data.endsWith('}')) {
    try {
      const parsed = JSON.parse(data) as { chars?: number; type?: string }
      if (parsed.type === 'ack' && typeof parsed.chars === 'number') {
        return { type: 'ack', chars: parsed.chars }
      }
    } catch {
      // Not valid JSON — treat as terminal input
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Data channel attachment
// ---------------------------------------------------------------------------

/**
 * Attach a MessagePort as a data channel for a Daytona terminal.
 *
 * Bridges the MessagePort (connected to the renderer's xterm.js) to
 * a Daytona PtyHandle (connected to the sandbox via WebSocket).
 *
 * @param port - The MessagePort connected to the renderer
 * @param terminalId - The terminal ID (with `daytona:` prefix)
 */
const attachDaytonaDataChannel = (
  port: RpcMessagePort,
  terminalId: string
): void => {
  const sessionId = stripDaytonaPrefix(terminalId)
  const ptyHandle = getDaytonaPtyHandle(sessionId)

  if (!ptyHandle) {
    port.postMessage(encodeError(`Daytona terminal not found: ${sessionId}`))
    port.close?.()
    return
  }

  /**
   * Send data to the renderer via the MessagePort.
   */
  const portSend = (data: string): void => {
    try {
      port.postMessage(data)
    } catch {
      // Port may already be closed
    }
  }

  // Send initial status control message.
  portSend(encodeStatus('running'))

  // Bridge Daytona PTY output to the renderer.
  // The SDK's PtyHandle has an `onData` callback that was set as a no-op
  // during `spawnTerminal` (Issue 16). We now need to create a NEW PTY
  // connection with the `onData` callback wired to the MessagePort.
  //
  // However, the SDK doesn't support changing the onData callback after
  // creation. The PtyHandle internally manages the WebSocket connection.
  // Instead, we re-create the connection by listening for data on the
  // existing handle using the SDK's built-in callback mechanism.
  //
  // The Daytona SDK's PtyHandle provides `onData` only at creation time.
  // Since we can't add a new output listener to an existing handle, we
  // use the approach described in the PRD: the `onData` callback on the
  // PtyHandle was intentionally left as a no-op, and the bridge layer
  // reads output by overriding or intercepting the internal state.
  //
  // APPROACH: We use a wrapper that intercepts the PtyHandle's internal
  // WebSocket data events. The SDK internally pipes ws.onmessage to the
  // onData callback. We access the raw PtyHandle and redirect output.
  //
  // Since the SDK's PtyHandle doesn't expose a way to add listeners
  // after creation, we use the `_onData` property which is set during
  // createPty and can be replaced:
  setPtyOnData(ptyHandle, (data: Uint8Array) => {
    // Convert Uint8Array to string for the MessagePort protocol
    const text = new TextDecoder().decode(data)
    portSend(text)
  })

  // Bridge renderer input to the Daytona PTY.
  const messageHandler = (data: unknown): void => {
    if (typeof data === 'string') {
      const ack = parseClientMessage(data)
      if (ack !== null) {
        // Flow control ack — no-op for Daytona PTY (WebSocket handles backpressure)
        return
      }
      // Raw terminal input — send to the Daytona PTY
      ptyHandle.sendInput(data).catch(() => {
        // PTY may be disconnected
      })
    }
  }

  // Attach message listener based on port API style.
  const unwrapData = (value: unknown): unknown => {
    if (typeof value === 'object' && value !== null && 'data' in value) {
      return (value as { data: unknown }).data
    }
    return value
  }

  const nodeListener = (value: unknown): void => {
    messageHandler(unwrapData(value))
  }

  if (typeof port.on === 'function') {
    port.on('message', nodeListener)
  } else {
    port.onmessage = (event: { data: unknown }) => {
      messageHandler(event.data)
    }
  }

  // Start receiving messages (required for MessagePorts).
  port.start?.()

  // Handle PTY exit: when the PtyHandle's WebSocket closes, send
  // a 'stopped' status to the renderer and clean up.
  ptyHandle
    .wait()
    .then(() => {
      portSend(encodeStatus('stopped'))
      cleanup()
    })
    .catch(() => {
      portSend(encodeStatus('stopped'))
      cleanup()
    })

  function cleanup(): void {
    // Remove message listener
    if (typeof port.off === 'function') {
      port.off('message', nodeListener)
    } else if (typeof port.removeListener === 'function') {
      port.removeListener('message', nodeListener)
    } else {
      port.onmessage = null
    }

    port.close?.()
    removeDaytonaPtyHandle(sessionId)
  }
}

/**
 * Set the PTY output callback on a Daytona PtyHandle.
 *
 * The Daytona SDK's PtyHandle stores the output callback as a `private
 * readonly onPty` property (set during construction via `createPty`'s
 * `onData` option). The WebSocket message handler references `this.onPty`
 * at call time, so replacing it at runtime redirects all future output.
 *
 * TypeScript marks it `private readonly`, but at runtime there's no
 * enforcement — we override it via `as any` to redirect PTY output
 * to the MessagePort bridge.
 *
 * The `onData` callback passed to `createPty` was intentionally set as
 * a no-op during `spawnTerminal` (Issue 16), to be replaced here when
 * the data channel is attached.
 *
 * @see .reference/daytona/libs/sdk-typescript/src/PtyHandle.ts
 */
function setPtyOnData(
  ptyHandle: PtyHandle,
  callback: (data: Uint8Array) => void
): void {
  // biome-ignore lint/suspicious/noExplicitAny: SDK internal access for PTY bridge
  const handle = ptyHandle as any
  // The SDK's PtyHandle stores the callback as `onPty` (private readonly).
  // The WebSocket message handler calls `this.onPty(bytes)` on each
  // message, so replacing it redirects output immediately.
  handle.onPty = callback
}

/**
 * Handle an incoming Daytona terminal data port in the server utility process.
 *
 * Called when the parent process sends a `{ type: 'daytona-terminal-data-port' }`
 * message with a MessagePort in the `ports` array. This creates the data
 * channel for the specified Daytona terminal.
 *
 * @param port - The MessagePort from the renderer
 * @param terminalId - The terminal ID (with `daytona:` prefix)
 */
const handleDaytonaTerminalDataPort = (
  port: RpcMessagePort,
  terminalId: string
): void => {
  attachDaytonaDataChannel(port, terminalId)
}

export {
  DAYTONA_TERMINAL_ID_PREFIX,
  attachDaytonaDataChannel,
  handleDaytonaTerminalDataPort,
  isDaytonaTerminalId,
  parseClientMessage,
  stripDaytonaPrefix,
}
