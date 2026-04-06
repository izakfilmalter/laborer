/**
 * MessagePort RPC Client Transport for Effect RPC
 *
 * Provides an `RpcClient.Protocol` implementation that sends RPC requests
 * over a `MessagePort` instead of HTTP. Designed to run inside the Electron
 * renderer process.
 *
 * Messages are transferred using structured clone — no JSON serialization
 * layer is needed (unlike the HTTP transport which requires
 * `RpcSerialization.layerJson`).
 *
 * Supports `ArrayBuffer` transfer for zero-copy terminal I/O.
 *
 * Pairs with the server-side transport in `rpc-transport-messageport.ts`.
 *
 * Usage in the renderer:
 * ```ts
 * const TerminalClient = RpcClient.make(TerminalRpcs).pipe(
 *   Layer.provide(layerClientProtocolMessagePort(port))
 * )
 * ```
 *
 * @see ./rpc-transport-messageport.ts (server side)
 * @see .reference/effect/packages/rpc/src/RpcClient.ts (Protocol interface)
 * @see .reference/vscode/src/vs/base/parts/ipc/electron-browser/ipc.mp.ts
 */

import { RpcClient } from '@effect/rpc'
import { RpcClientError } from '@effect/rpc/RpcClientError'
import type { FromServerEncoded } from '@effect/rpc/RpcMessage'
import { Effect, Layer, Queue, Scope } from 'effect'

import type { RpcMessagePort } from './rpc-transport-messageport.js'
import { PING_MESSAGE, PONG_MESSAGE } from './rpc-transport-messageport.js'

// ---------------------------------------------------------------------------
// Heartbeat constants
// ---------------------------------------------------------------------------

/**
 * How often the client sends a ping to the server (ms).
 * Follows the VS Code KeepAlive pattern — frequent enough to detect
 * dead channels within a reasonable window.
 */
const HEARTBEAT_INTERVAL_MS = 5000

/**
 * How long to wait for a pong before declaring the port dead (ms).
 * Set to 6× the ping interval so heavy synchronous work on the
 * server (e.g. SQLite sync changesets, LiveStore rematerialization)
 * doesn't cause false-positive dead port detections.
 *
 * With a 5 s ping interval the client gets six pings (at 5, 10, 15,
 * 20, 25, 30 s) before declaring the channel dead — generous enough
 * to survive temporary event-loop stalls while still catching truly
 * dead ports within 35 s.
 *
 * @see .reference/vscode/src/vs/base/parts/ipc/common/ipc.net.ts —
 *      VS Code uses `ProtocolConstants.TimeoutTime = 20_000` with
 *      additional heuristics (unacked messages, last timeout time).
 */
const HEARTBEAT_TIMEOUT_MS = 30_000

/**
 * Custom DOM event name dispatched when a MessagePort is detected as dead
 * (close event, heartbeat timeout, or send failure). The renderer's
 * `SidecarRuntimeBoundary` listens for this to trigger a generation bump
 * and rebuild all RPC clients with fresh ports.
 *
 * This bridges the gap between the transport layer (which detects dead
 * channels) and the React tree (which needs to remount to acquire new ports).
 */
export const RPC_PORT_DEAD_EVENT = 'laborer:rpc-port-dead'

// ---------------------------------------------------------------------------
// Protocol factory
// ---------------------------------------------------------------------------

/**
 * Create an `RpcClient.Protocol` that sends RPC requests over a MessagePort.
 *
 * Follows the `withRun` pattern from Effect RPC internals:
 * - `Protocol.make` wraps a factory that receives a `writeResponse` callback
 * - Before `run()` is called on the protocol, incoming messages are buffered
 *   by the `withRun` mechanism
 * - Once `run()` starts, buffered messages are replayed and new messages
 *   flow directly to the RPC client pipeline
 *
 * Port messages are pushed to an unbounded queue from the synchronous event
 * listener. A forked fiber drains the queue and calls `writeResponse` for
 * each message, bridging the sync event world to the Effect runtime.
 *
 * **Port close detection:** This version uses three mechanisms to detect a
 * dead channel:
 * 1. Listens for `close` events on the MessagePort (unreliable in Web API).
 * 2. Application-level heartbeat: pings the server every 5s and expects a
 *    pong within 15s. If no pong arrives, the port is considered dead.
 * 3. Main process port tracking: proactively closes renderer ports when
 *    the utility process exits (handled externally by ipc.ts).
 *
 * When any mechanism detects a dead port, a synthetic `Defect` message is
 * injected into the response queue. The Effect RPC client treats `Defect`
 * messages by clearing all pending entries, which resolves (with failure)
 * any in-flight `Effect.async` calls — preventing modals and other UI
 * elements from getting permanently stuck in a loading state.
 *
 * @param port - The MessagePort to send RPC requests over
 */
export const makeClientProtocolMessagePort = (
  port: RpcMessagePort
): Effect.Effect<RpcClient.Protocol['Type'], never, Scope.Scope> =>
  RpcClient.Protocol.make(
    Effect.fnUntraced(function* (writeResponse) {
      const scope = yield* Effect.scope

      // Unbounded queue bridges sync event listeners to the Effect runtime.
      const messageQueue = yield* Queue.unbounded<FromServerEncoded>()

      // Mutable flag tracking whether the port has been closed by the remote
      // end. Used in `send()` to fail fast instead of posting into a dead port.
      const portState = { closed: false }

      // Heartbeat tracking — timestamp of last pong (or message) received.
      let lastPongTimestamp = Date.now()
      let heartbeatInterval: ReturnType<typeof setInterval> | null = null

      // Drain the queue in a fiber, calling writeResponse for each message.
      yield* Queue.take(messageQueue).pipe(
        Effect.flatMap((data) => writeResponse(data)),
        Effect.forever,
        Effect.forkScoped
      )

      // Sync event handlers push to the queue.
      const messageHandler = (data: unknown): void => {
        // Intercept pong messages from the heartbeat echo.
        if (data === PONG_MESSAGE) {
          lastPongTimestamp = Date.now()
          return
        }
        // Any real message also counts as proof of liveness (like
        // Mux's "inbound frame tracking" pattern).
        lastPongTimestamp = Date.now()
        console.log(
          '[rpc-client-transport] recv:',
          typeof data,
          JSON.stringify(data as object)?.slice(0, 200)
        )
        Queue.unsafeOffer(messageQueue, data as FromServerEncoded)
      }

      // When the port closes (or is detected as dead), synthesize a
      // Defect response to unblock all pending RPC requests.
      const closeHandler = (): void => {
        if (portState.closed) {
          return
        }
        console.warn(
          '[rpc-client-transport] Port closed by remote end — synthesizing Defect to unblock pending requests'
        )
        portState.closed = true

        // Stop heartbeat timer.
        if (heartbeatInterval !== null) {
          clearInterval(heartbeatInterval)
          heartbeatInterval = null
        }

        Queue.unsafeOffer(messageQueue, {
          _tag: 'Defect',
          defect: 'MessagePort closed unexpectedly',
        } as unknown as FromServerEncoded)

        // Notify the renderer's SidecarRuntimeBoundary that a port died
        // so it can trigger a generation bump and rebuild all RPC clients.
        // This handles the case where the sidecar is still healthy but
        // the individual MessagePort channel is dead (e.g., heartbeat
        // timeout, half-open connection).
        //
        // Guard for browser environment — the shared package tsconfig
        // does not include the `dom` lib.
        try {
          const win = globalThis as unknown as
            | { dispatchEvent?: (event: Event) => boolean }
            | undefined
          if (typeof win?.dispatchEvent === 'function') {
            const EventCtor = globalThis.Event as
              | (new (
                  type: string
                ) => Event)
              | undefined
            if (EventCtor) {
              win.dispatchEvent(new EventCtor(RPC_PORT_DEAD_EVENT))
            }
          }
        } catch {
          // Not in a browser environment — ignore.
        }
      }

      // Attach listeners based on the port's API style.
      if (typeof port.on === 'function') {
        // Node.js / Electron MessagePortMain style.
        // MessagePortMain's 'message' event passes a MessageEvent-like
        // object { data, ports } — unwrap .data to get the raw payload.
        port.on('message', (event: unknown) => {
          const data =
            typeof event === 'object' && event !== null && 'data' in event
              ? (event as { data: unknown }).data
              : event
          messageHandler(data)
        })
        port.on('close', closeHandler)
      } else {
        // Web MessagePort style
        port.onmessage = (event: { data: unknown }) => {
          messageHandler(event.data)
        }
        port.onclose = closeHandler
      }

      // Web MessagePorts require .start() to begin receiving messages.
      console.log(
        '[rpc-client-transport] Calling port.start(), hasOn:',
        typeof port.on === 'function'
      )
      port.start?.()
      console.log('[rpc-client-transport] port.start() called successfully')

      // Start the application-level heartbeat timer.
      // Sends a ping every HEARTBEAT_INTERVAL_MS and checks whether a pong
      // (or any message) was received within HEARTBEAT_TIMEOUT_MS.
      heartbeatInterval = setInterval(() => {
        if (portState.closed) {
          return
        }

        const elapsed = Date.now() - lastPongTimestamp
        if (elapsed > HEARTBEAT_TIMEOUT_MS) {
          console.warn(
            `[rpc-client-transport] No pong received in ${elapsed}ms — declaring port dead`
          )
          closeHandler()
          return
        }

        // Send ping. If the port is dead, postMessage will throw —
        // catch and trigger close.
        try {
          port.postMessage(PING_MESSAGE)
        } catch {
          closeHandler()
        }
      }, HEARTBEAT_INTERVAL_MS)

      // Clean up listeners when the scope is finalized.
      yield* Scope.addFinalizer(
        scope,
        Effect.sync(() => {
          if (heartbeatInterval !== null) {
            clearInterval(heartbeatInterval)
            heartbeatInterval = null
          }
          if (typeof port.off === 'function') {
            port.off('message', messageHandler)
            port.off('close', closeHandler)
          } else if (typeof port.removeListener === 'function') {
            port.removeListener('message', messageHandler)
            port.removeListener('close', closeHandler)
          } else {
            port.onmessage = null
            port.onclose = null
          }
          port.close?.()
        })
      )

      return {
        send(request, transferables) {
          // Check if the port has been closed before attempting to send.
          // This provides a fast failure path instead of silently posting
          // the message into a dead port.
          if (portState.closed) {
            return Effect.fail(
              new RpcClientError({
                reason: 'Protocol',
                message:
                  'MessagePort is closed — cannot send request. The server utility process may have restarted.',
              })
            )
          }
          return Effect.try({
            try: () => {
              console.log(
                '[rpc-client-transport] send:',
                typeof request,
                JSON.stringify(request)?.slice(0, 200)
              )
              port.postMessage(request, transferables as readonly unknown[])
            },
            catch: (cause) =>
              new RpcClientError({
                reason: 'Protocol',
                message: 'Failed to send MessagePort request',
                cause,
              }),
          })
        },
        supportsAck: false,
        supportsTransferables: true,
      }
    })
  )

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

/**
 * Layer that provides `RpcClient.Protocol` backed by a MessagePort.
 *
 * Replaces `RpcClient.layerProtocolHttp({ url })` in the renderer.
 *
 * Unlike the HTTP protocol, this does NOT require `RpcSerialization.layerJson`
 * or `FetchHttpClient.layer` since MessagePort uses structured clone natively.
 *
 * @param port - The MessagePort to send RPC requests over
 */
export const layerClientProtocolMessagePort = (
  port: RpcMessagePort
): Layer.Layer<RpcClient.Protocol> =>
  Layer.scoped(RpcClient.Protocol, makeClientProtocolMessagePort(port))
