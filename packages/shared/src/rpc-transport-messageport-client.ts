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
 * **Port close detection:** Unlike the original implementation, this version
 * listens for `close` events on the MessagePort. When the port closes (e.g.,
 * the utility process crashes or restarts), a synthetic `Defect` message is
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

      // Drain the queue in a fiber, calling writeResponse for each message.
      yield* Queue.take(messageQueue).pipe(
        Effect.flatMap((data) => writeResponse(data)),
        Effect.forever,
        Effect.forkScoped
      )

      // Sync event handlers push to the queue.
      const messageHandler = (data: unknown): void => {
        Queue.unsafeOffer(messageQueue, data as FromServerEncoded)
      }

      // When the port closes, synthesize a Defect response to unblock
      // all pending RPC requests. The Effect RPC client treats "Defect"
      // messages by clearing all entries, which resolves (with failure)
      // any in-flight Effect.async calls.
      const closeHandler = (): void => {
        console.warn(
          '[rpc-client-transport] Port closed by remote end — synthesizing Defect to unblock pending requests'
        )
        portState.closed = true
        Queue.unsafeOffer(messageQueue, {
          _tag: 'Defect',
          defect: 'MessagePort closed unexpectedly',
        } as unknown as FromServerEncoded)
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

      // Clean up listeners when the scope is finalized.
      yield* Scope.addFinalizer(
        scope,
        Effect.sync(() => {
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
