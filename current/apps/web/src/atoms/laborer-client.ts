/**
 * LaborerClient — AtomRpc client for the server's LaborerRpcs.
 *
 * Communicates with the desktop-managed server backend over loopback WebSocket.
 *
 * Uses `AtomRpc.Tag` to provide typed `query` and `mutation` atoms that
 * integrate with React components via `@effect-atom/atom`.
 *
 * @see Issue #4: Renderer RPC client wired to MessagePort
 * @see packages/server/src/utility-main.ts — Server utility process entry
 */

import { layerWebSocket, WebSocketConstructor } from '@effect/platform/Socket'
import { RpcClient, RpcSerialization } from '@effect/rpc'
import { AtomRpc } from '@effect-atom/atom'
import { LaborerRpcs } from '@laborer/shared/rpc'
import { Context, Duration, Effect, Layer, Schedule } from 'effect'

import { getBackendRpcWsUrl } from '@/lib/desktop'
import {
  recordWsConnectionAttempt,
  recordWsConnectionClosed,
  recordWsConnectionErrored,
  recordWsConnectionOpened,
  WS_RECONNECT_BACKOFF_FACTOR,
  WS_RECONNECT_INITIAL_DELAY_MS,
  WS_RECONNECT_MAX_DELAY_MS,
  WS_RECONNECT_RESET_AFTER_MS,
} from './ws-connection-state'

function createTrackingWebSocket(
  socketUrl: string,
  protocols?: string | string[]
): WebSocket {
  recordWsConnectionAttempt(socketUrl)
  const socket = new globalThis.WebSocket(socketUrl, protocols)

  socket.addEventListener(
    'open',
    () => {
      recordWsConnectionOpened()
    },
    { once: true }
  )
  socket.addEventListener(
    'error',
    () => {
      recordWsConnectionErrored(
        'Unable to connect to the Laborer server WebSocket.'
      )
    },
    { once: true }
  )
  socket.addEventListener(
    'close',
    (event) => {
      recordWsConnectionClosed({
        code: event.code,
        reason: event.reason,
      })
    },
    { once: true }
  )

  return socket
}

/**
 * Reconnection policy for the loopback RPC WebSocket.
 *
 * `RpcClient.makeProtocolSocket` drives ONE schedule instance for the whole
 * client lifetime: every disconnect — including a clean close after hours of
 * stable connection — steps the same schedule, and its state is never reset
 * on a successful reconnect. A terminating schedule (the old
 * `Schedule.recurs(7)`) therefore budgeted 7 reconnects per app session
 * TOTAL; once spent (a few OS sleep/wake cycles was enough), the protocol
 * fiber died, the error was cached, and every later RPC failed permanently
 * with `RpcClientError: Error in socket` until the app restarted.
 *
 * So the schedule must never terminate. Delays back off exponentially and
 * are capped at {@link WS_RECONNECT_MAX_DELAY_MS} by the union with the
 * spaced schedule (union takes the smaller delay and continues while either
 * schedule continues). `Schedule.resetAfter` rewinds the backoff to the
 * initial delay once {@link WS_RECONNECT_RESET_AFTER_MS} has elapsed since
 * the retry sequence began, so an outage after a long stable connection
 * starts back at the fast initial delay instead of the cap.
 *
 * Exported for regression tests only.
 */
export const wsReconnectRetrySchedule = Schedule.union(
  Schedule.exponential(
    WS_RECONNECT_INITIAL_DELAY_MS,
    WS_RECONNECT_BACKOFF_FACTOR
  ),
  Schedule.spaced(WS_RECONNECT_MAX_DELAY_MS)
).pipe(Schedule.resetAfter(Duration.millis(WS_RECONNECT_RESET_AFTER_MS)))

const trackingWebSocketConstructorLayer = Layer.succeed(
  WebSocketConstructor,
  createTrackingWebSocket
)

const serverProtocol: Layer.Layer<RpcClient.Protocol> = Layer.scoped(
  RpcClient.Protocol,
  Effect.gen(function* () {
    const rpcUrl = getBackendRpcWsUrl()
    if (!rpcUrl) {
      return yield* Effect.die(
        'Server backend is not running — could not resolve WebSocket URL'
      )
    }
    const socketLayer = layerWebSocket(rpcUrl).pipe(
      Layer.provide(trackingWebSocketConstructorLayer)
    )
    const protocol = yield* RpcClient.layerProtocolSocket({
      retrySchedule: wsReconnectRetrySchedule,
      retryTransientErrors: true,
    }).pipe(
      Layer.provide(Layer.mergeAll(socketLayer, RpcSerialization.layerJson)),
      Layer.build,
      Effect.map((context) => Context.get(context, RpcClient.Protocol))
    )
    return protocol
  })
)

/**
 * LaborerClient — typed AtomRpc client for React components.
 *
 * Uses WebSocket RPC to the desktop-managed server backend.
 * Provides `mutation` and `query` helpers for all LaborerRpcs endpoints.
 */
export const ConfigReactivityKeys = ['config'] as const

export class LaborerClient extends AtomRpc.Tag<LaborerClient>()(
  'LaborerClient',
  {
    group: LaborerRpcs,
    protocol: serverProtocol,
  }
) {}
