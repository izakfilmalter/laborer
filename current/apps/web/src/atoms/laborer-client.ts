/**
 * LaborerClient — AtomRpc client for the server's LaborerRpcs.
 *
 * Communicates with the desktop-managed server backend over loopback WebSocket.
 *
 * Uses `AtomRpc.Service` to provide typed `query` and `mutation` atoms that
 * integrate with React components via `@effect/atom-react`.
 *
 * @see Issue #4: Renderer RPC client wired to MessagePort
 * @see packages/server/src/utility-main.ts — Server utility process entry
 */

import { LaborerRpcs } from '@laborer/shared/rpc'
import { Duration, Effect, Layer, Schedule } from 'effect'
import { AtomRpc } from 'effect/unstable/reactivity'
import { RpcClient, RpcSerialization } from 'effect/unstable/rpc'
import { Socket } from 'effect/unstable/socket'

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
export const wsReconnectRetrySchedule = Schedule.fromStepWithMetadata(
  Effect.sync(() => {
    let sequenceStartedAt: number | undefined
    let attempt = 0

    return (metadata: Schedule.InputMetadata<unknown>) => {
      if (
        sequenceStartedAt === undefined ||
        metadata.now - sequenceStartedAt >= WS_RECONNECT_RESET_AFTER_MS
      ) {
        sequenceStartedAt = metadata.now
        attempt = 0
      }
      const delay = Math.min(
        WS_RECONNECT_INITIAL_DELAY_MS * WS_RECONNECT_BACKOFF_FACTOR ** attempt,
        WS_RECONNECT_MAX_DELAY_MS
      )
      attempt += 1
      return Effect.succeed([delay, Duration.millis(delay)] as [
        number,
        Duration.Duration,
      ])
    }
  })
)

const trackingWebSocketConstructorLayer = Layer.succeed(
  Socket.WebSocketConstructor,
  createTrackingWebSocket
)

const serverProtocol: Layer.Layer<RpcClient.Protocol> = Layer.effect(
  RpcClient.Protocol,
  Effect.gen(function* () {
    const rpcUrl = getBackendRpcWsUrl()
    if (!rpcUrl) {
      return yield* Effect.die(
        'Server backend is not running — could not resolve WebSocket URL'
      )
    }
    const socketLayer = Socket.layerWebSocket(rpcUrl).pipe(
      Layer.provide(trackingWebSocketConstructorLayer)
    )
    const protocol = yield* RpcClient.makeProtocolSocket({
      retryPolicy: wsReconnectRetrySchedule,
      retryTransientErrors: true,
    }).pipe(
      Effect.provide(Layer.mergeAll(socketLayer, RpcSerialization.layerJson))
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

export class LaborerClient extends AtomRpc.Service<LaborerClient>()(
  'LaborerClient',
  {
    group: LaborerRpcs,
    protocol: serverProtocol,
  }
) {}
