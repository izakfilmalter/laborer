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

      // Attach listeners based on the port's API style.
      if (typeof port.on === 'function') {
        // Node.js / Electron MessagePortMain style
        port.on('message', messageHandler)
      } else {
        // Web MessagePort style
        port.onmessage = (event: { data: unknown }) => {
          messageHandler(event.data)
        }
      }

      // Web MessagePorts require .start() to begin receiving messages.
      port.start?.()

      // Clean up listeners when the scope is finalized.
      yield* Scope.addFinalizer(
        scope,
        Effect.sync(() => {
          if (typeof port.off === 'function') {
            port.off('message', messageHandler)
          } else if (typeof port.removeListener === 'function') {
            port.removeListener('message', messageHandler)
          } else {
            port.onmessage = null
          }
          port.close?.()
        })
      )

      return {
        send(request, transferables) {
          return Effect.try({
            try: () => {
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
