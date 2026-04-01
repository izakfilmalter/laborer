/**
 * Terminal Data Channel — Per-terminal MessagePort I/O
 *
 * Manages dedicated MessagePort connections for streaming terminal I/O
 * between the renderer and the terminal utility process. Each terminal
 * gets its own MessagePort for bidirectional data:
 *
 * - **Output** (utility process -> renderer): Raw PTY output as strings
 * - **Input** (renderer -> utility process): Keystroke data and flow
 *   control ack messages
 * - **Control messages**: Screen state snapshots and lifecycle status
 *
 * This replaces the WebSocket data channel (`terminal-ws.ts`) for the
 * utility process architecture. The protocol is intentionally compatible:
 * same control message format, same flow control ack mechanism.
 *
 * Protocol:
 * - Utility -> Renderer: Raw UTF-8 strings (PTY output data)
 * - Utility -> Renderer: JSON control messages:
 *   - `{"type":"status","status":"running"}` — sent on connect
 *   - `{"type":"status","status":"stopped","exitCode":N}` — PTY exited
 *   - `{"type":"status","status":"restarted"}` — terminal restarted
 *   - `{"type":"replay","events":[...]}` — persisted revive payload
 *   - `{"type":"replayComplete"}` — revive replay finished
 *   - `{"type":"screenState","data":"<VT sequences>"}` — screen snapshot
 * - Renderer -> Utility: Raw terminal input strings (keystrokes)
 * - Renderer -> Utility: `{"type":"ack","chars":N}` — flow control ack
 *
 * @see terminal-ws.ts — WebSocket-based equivalent (to be removed)
 * @see Issue #8: Terminal PTY I/O data channel over MessagePort
 */

import type { TerminalRpcError } from '@laborer/shared/rpc'
import type { RpcMessagePort } from '@laborer/shared/rpc-transport-messageport'
import { Effect, PubSub, Runtime, type Scope } from 'effect'
import { PtyHostClient } from './pty-host-client.js'
import {
  type TerminalLifecycleEvent,
  TerminalManager,
} from './terminal-manager.js'
import type { SerializedReplayEvent } from './terminal-session-persistence.js'

// ---------------------------------------------------------------------------
// Control message helpers (matches terminal-ws.ts format)
// ---------------------------------------------------------------------------

/**
 * Build a JSON status control message string.
 */
const encodeStatus = (status: string, exitCode?: number): string => {
  const message: Record<string, unknown> = { type: 'status', status }
  if (exitCode !== undefined) {
    message.exitCode = exitCode
  }
  return JSON.stringify(message)
}

/**
 * Build a JSON error control message string.
 */
const encodeError = (message: string): string =>
  JSON.stringify({ type: 'error', message })

/** Build a JSON screen-state control message string. */
const encodeScreenState = (data: string): string =>
  JSON.stringify({ type: 'screenState', data })

const encodeReplay = (replayEvent: SerializedReplayEvent): string =>
  JSON.stringify({
    type: 'replay',
    events: replayEvent.events,
    commands: replayEvent.commands,
    capabilities: replayEvent.capabilities,
  })

const encodeReplayComplete = (): string =>
  JSON.stringify({ type: 'replayComplete' })

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
// High watermark for flow control reset on disconnect (matches terminal-ws.ts)
// ---------------------------------------------------------------------------

const DISCONNECT_ACK_CHARS = 100_000

// ---------------------------------------------------------------------------
// Data channel attachment
// ---------------------------------------------------------------------------

/**
 * Attach a MessagePort as a data channel for a specific terminal.
 *
 * This is the MessagePort equivalent of the WebSocket handler in
 * `terminal-ws.ts`. It implements the same subscribe-before-serialize
 * pattern for race-free attachment.
 *
 * The port is used for the lifetime of the connection — it is closed
 * when the terminal exits, the renderer disconnects, or the scope is
 * finalized.
 *
 * @param port - The MessagePort connected to the renderer
 * @param terminalId - The terminal to stream I/O for
 */
const attachDataChannel = (
  port: RpcMessagePort,
  terminalId: string
): Effect.Effect<
  void,
  TerminalRpcError,
  TerminalManager | PtyHostClient | Scope.Scope
> =>
  Effect.gen(function* () {
    const terminalManager = yield* TerminalManager
    const ptyHostClient = yield* PtyHostClient

    // Verify the terminal exists before attaching.
    const exists = yield* terminalManager.terminalExists(terminalId)
    if (!exists) {
      port.postMessage(encodeError(`Terminal not found: ${terminalId}`))
      port.close?.()
      return
    }

    /**
     * Send data to the renderer via the MessagePort.
     *
     * Always sends as a string. Electron's `MessagePortMain.postMessage()`
     * only accepts `MessagePortMain[]` as the transfer list — NOT
     * `Transferable[]` like the Web `MessagePort` API — so ArrayBuffer
     * zero-copy transfer is not available in this context.
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

    // Subscribe before serializing screen state so output that arrives during
    // the snapshot window is queued and flushed after the renderer restores.
    const queuedOutput: string[] = []
    let isRestoringSnapshot = true

    /**
     * Replay input guard — drops incoming renderer messages (input, ack)
     * during the replay window to prevent state corruption. Set to `true`
     * when the replay payload is sent, cleared when `replayComplete` is sent.
     *
     * @see Issue #10: Replay input guard
     */
    let isReplayingToRenderer = false

    const sendOutput = (data: string): void => {
      if (isRestoringSnapshot) {
        queuedOutput.push(data)
        return
      }

      portSend(data)
    }

    const { subscriberId } = yield* terminalManager.subscribe(
      terminalId,
      (data: string) => {
        sendOutput(data)
      },
      // The headless terminal snapshot is now the primary restore path.
      // We only want live output after subscribe, not the raw initial buffer.
      { replay: false }
    )

    const revivedReplayEvent =
      yield* terminalManager.takeRevivedReplayEvent(terminalId)

    if (revivedReplayEvent !== undefined) {
      isReplayingToRenderer = true
      portSend(encodeReplay(revivedReplayEvent))
      // Transition to 'replay-only' — the raw revive buffer remains
      // available for re-serialization but the terminal is now attached
      // to a renderer.
      terminalManager.markReplayed(terminalId)
    } else {
      const screenState = terminalManager.getScreenState(terminalId)
      if (screenState.length > 0) {
        portSend(encodeScreenState(screenState))
      }
    }

    isRestoringSnapshot = false
    for (const data of queuedOutput) {
      portSend(data)
    }

    if (revivedReplayEvent !== undefined) {
      portSend(encodeReplayComplete())
      isReplayingToRenderer = false
    }

    // Prompt TUI applications to repaint against the restored viewport.
    yield* terminalManager.forceRedraw(terminalId)

    // Subscribe to lifecycle events for status control messages.
    const lifecycleQueue = yield* PubSub.subscribe(
      terminalManager.lifecycleEvents
    )

    yield* Effect.forkScoped(
      Effect.gen(function* () {
        while (true) {
          const event: TerminalLifecycleEvent = yield* lifecycleQueue.take
          if (event._tag === 'Exited' && event.id === terminalId) {
            portSend(encodeStatus('stopped', event.exitCode))
          } else if (
            event._tag === 'Restarted' &&
            event.terminal.id === terminalId
          ) {
            portSend(encodeStatus('restarted'))
          }
        }
      })
    )

    // Listen for incoming messages from the renderer (input + ack).
    // During replay, all incoming messages are dropped to prevent state
    // corruption — the renderer should not send input, resize, or ack
    // messages until replay is complete.
    const messageHandler = (data: unknown): void => {
      if (isReplayingToRenderer) {
        return
      }
      if (typeof data === 'string') {
        const ack = parseClientMessage(data)
        if (ack !== null) {
          ptyHostClient.ack(terminalId, ack.chars)
        } else {
          ptyHostClient.write(terminalId, data)
        }
      }
    }

    // Attach message listener based on port API style.
    // Electron's MessagePortMain.on('message') delivers a MessageEvent-like
    // object {data, ports}, NOT raw data. We must unwrap .data for both paths.
    const unwrapData = (value: unknown): unknown => {
      if (typeof value === 'object' && value !== null && 'data' in value) {
        return (value as { data: unknown }).data
      }
      return value
    }

    // Node/Electron EventEmitter path: value is a MessageEvent-like {data, ports}
    const nodeListener = (value: unknown): void => {
      messageHandler(unwrapData(value))
    }

    if (typeof port.on === 'function') {
      port.on('message', nodeListener)
    } else {
      // Web MessagePort path: onmessage handler receives a MessageEvent
      port.onmessage = (event: { data: unknown }) => {
        messageHandler(event.data)
      }
    }

    // Start receiving messages (required for Web MessagePorts).
    port.start?.()

    // Cleanup on scope finalization (disconnect / terminal exit / shutdown).
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* terminalManager.unsubscribe(terminalId, subscriberId)

        // Reset flow control on disconnect.
        ptyHostClient.ack(terminalId, DISCONNECT_ACK_CHARS)

        // Remove message listener.
        if (typeof port.off === 'function') {
          port.off('message', nodeListener)
        } else if (typeof port.removeListener === 'function') {
          port.removeListener('message', nodeListener)
        } else {
          port.onmessage = null
        }

        port.close?.()
      })
    )

    // Keep the data channel alive until the scope is closed.
    // The scope is closed when:
    // - The renderer disconnects (port close event)
    // - The utility process shuts down (service layer finalization)
    return yield* Effect.never
  })

/**
 * Handle an incoming terminal data port in a utility process.
 *
 * Called when the parent process sends a `{ type: 'terminal-data-port' }`
 * message with a MessagePort in the `ports` array. This creates a
 * scoped fiber that runs the data channel for the specified terminal
 * until the port is closed or the terminal exits.
 *
 * @param port - The MessagePort from the renderer
 * @param terminalId - The terminal to attach to
 * @param runtime - The Effect runtime for forking the data channel fiber
 */
const handleTerminalDataPort = (
  port: RpcMessagePort,
  terminalId: string,
  runtime: Runtime.Runtime<TerminalManager | PtyHostClient>
): void => {
  const program = attachDataChannel(port, terminalId).pipe(Effect.scoped)
  Runtime.runFork(runtime)(program)
}

export { attachDataChannel, handleTerminalDataPort, parseClientMessage }
