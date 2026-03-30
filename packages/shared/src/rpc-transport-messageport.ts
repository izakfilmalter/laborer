/**
 * MessagePort RPC Server Transport for Effect RPC
 *
 * Provides an `RpcServer.Protocol` implementation that serves RPC handlers
 * over a `MessagePort` instead of HTTP. Designed to run inside Electron
 * utility processes.
 *
 * Messages are transferred using structured clone — no JSON serialization
 * layer is needed (unlike the HTTP transport which requires
 * `RpcSerialization.layerJson`).
 *
 * Supports `ArrayBuffer` transfer for zero-copy terminal I/O.
 *
 * Usage in a utility process entry point:
 * ```ts
 * const RpcLive = RpcServer.layer(TerminalRpcs).pipe(
 *   Layer.provide(layerProtocolMessagePort(port)),
 *   Layer.provide(TerminalRpcsLive)
 * )
 * ```
 *
 * @see .reference/vscode/src/vs/base/parts/ipc/node/ipc.mp.ts
 * @see .reference/effect/packages/rpc/src/RpcServer.ts (Protocol interface)
 */

import { RpcServer } from '@effect/rpc'
import type {
  FromClientEncoded,
  FromServerEncoded,
} from '@effect/rpc/RpcMessage'
import { Effect, Layer, Mailbox, Queue, Scope } from 'effect'

// ---------------------------------------------------------------------------
// MessagePort abstraction
// ---------------------------------------------------------------------------

/**
 * Minimal interface covering the subset of MessagePort APIs needed for RPC.
 *
 * Works with:
 * - Electron `MessagePortMain` (utility process side, uses `.on('message')`)
 * - Node.js `MessagePort` from `worker_threads` (uses `.on('message')`)
 * - Web `MessagePort` from `MessageChannel` (uses `.onmessage`)
 */
export interface RpcMessagePort {
  close?(): void
  off?(event: string, listener: (...args: unknown[]) => void): void
  on?(event: 'message', listener: (value: unknown) => void): void
  on?(event: 'close', listener: () => void): void
  onclose?: (() => void) | null
  onmessage?: ((event: { data: unknown }) => void) | null
  postMessage(value: unknown, transferList?: readonly unknown[]): void
  removeListener?(event: string, listener: (...args: unknown[]) => void): void
  start?(): void
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Single client ID for point-to-point MessagePort connections.
 * Unlike HTTP (multiple clients), MessagePort is always 1:1.
 */
const CLIENT_ID = 0

// ---------------------------------------------------------------------------
// Protocol factory
// ---------------------------------------------------------------------------

/**
 * Create an `RpcServer.Protocol` that serves RPC over a MessagePort.
 *
 * Follows the `withRun` pattern from Effect RPC internals:
 * - `Protocol.make` wraps a factory that receives a `writeRequest` callback
 * - Before `run()` is called on the protocol, incoming messages are buffered
 *   by the `withRun` mechanism
 * - Once `run()` starts, buffered messages are replayed and new messages
 *   flow directly to the RPC handler
 *
 * Port messages are pushed to an unbounded queue from the synchronous event
 * listener. A forked fiber drains the queue and calls `writeRequest` for
 * each message, bridging the sync event world to the Effect runtime.
 *
 * @param port - The MessagePort to serve RPC over
 */
export const makeProtocolMessagePort = (
  port: RpcMessagePort
): Effect.Effect<RpcServer.Protocol['Type'], never, Scope.Scope> =>
  RpcServer.Protocol.make(
    Effect.fnUntraced(function* (writeRequest) {
      const scope = yield* Effect.scope
      const disconnects = yield* Mailbox.make<number>()

      // Unbounded queue bridges sync event listeners to the Effect runtime.
      const messageQueue = yield* Queue.unbounded<FromClientEncoded>()

      // Drain the queue in a fiber, calling writeRequest for each message.
      yield* Queue.take(messageQueue).pipe(
        Effect.flatMap((data) => writeRequest(CLIENT_ID, data)),
        Effect.forever,
        Effect.forkScoped
      )

      // Sync event handlers push to the queue.
      const messageHandler = (data: unknown): void => {
        console.log(
          '[rpc-server-transport] message received:',
          typeof data,
          JSON.stringify(data)?.slice(0, 200)
        )
        Queue.unsafeOffer(messageQueue, data as FromClientEncoded)
      }

      const closeHandler = (): void => {
        disconnects.unsafeOffer(CLIENT_ID)
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
        '[rpc-server-transport] Calling port.start(), hasOn:',
        typeof port.on === 'function'
      )
      port.start?.()
      console.log(
        '[rpc-server-transport] port.start() called, listeners attached'
      )

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
        disconnects,
        send(_clientId: number, response: FromServerEncoded, transferables) {
          return Effect.sync(() => {
            console.log(
              '[rpc-server-transport] send:',
              typeof response,
              JSON.stringify(response)?.slice(0, 200)
            )
            port.postMessage(response, transferables as readonly unknown[])
          })
        },
        end(_clientId: number) {
          return Effect.void
        },
        clientIds: Effect.sync(() => new Set([CLIENT_ID])),
        initialMessage: Effect.succeedNone,
        supportsAck: false,
        supportsTransferables: true,
        supportsSpanPropagation: false,
      }
    })
  )

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

/**
 * Layer that provides `RpcServer.Protocol` backed by a MessagePort.
 *
 * Replaces `RpcServer.layerProtocolHttp({ path: '/rpc' })` in utility
 * process entry points.
 *
 * Unlike the HTTP protocol, this does NOT require `RpcSerialization.layerJson`
 * since MessagePort uses structured clone natively.
 *
 * @param port - The MessagePort to serve RPC over
 */
export const layerProtocolMessagePort = (
  port: RpcMessagePort
): Layer.Layer<RpcServer.Protocol> =>
  Layer.scoped(RpcServer.Protocol, makeProtocolMessagePort(port))
