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
  getWsReconnectDelayMsForRetry,
  recordWsConnectionAttempt,
  recordWsConnectionClosed,
  recordWsConnectionErrored,
  recordWsConnectionOpened,
  WS_RECONNECT_MAX_RETRIES,
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

const retrySchedule = Schedule.addDelay(
  Schedule.recurs(WS_RECONNECT_MAX_RETRIES),
  (retryCount) =>
    Duration.millis(getWsReconnectDelayMsForRetry(retryCount) ?? 0)
)

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
      retrySchedule,
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
