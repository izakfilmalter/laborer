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

import {
  layerWebSocket,
  layerWebSocketConstructorGlobal,
} from '@effect/platform/Socket'
import { RpcClient, RpcSerialization } from '@effect/rpc'
import { AtomRpc } from '@effect-atom/atom'
import { LaborerRpcs } from '@laborer/shared/rpc'
import { Context, Duration, Effect, Layer, Schedule } from 'effect'

import { getBackendRpcWsUrl } from '@/lib/desktop'

const WS_RECONNECT_INITIAL_DELAY_MS = 1000
const WS_RECONNECT_BACKOFF_FACTOR = 2
const WS_RECONNECT_MAX_DELAY_MS = 64_000
const WS_RECONNECT_MAX_RETRIES = 7

function getWsReconnectDelayMsForRetry(retryIndex: number): number | null {
  if (
    !Number.isInteger(retryIndex) ||
    retryIndex < 0 ||
    retryIndex >= WS_RECONNECT_MAX_RETRIES
  ) {
    return null
  }

  return Math.min(
    Math.round(
      WS_RECONNECT_INITIAL_DELAY_MS * WS_RECONNECT_BACKOFF_FACTOR ** retryIndex
    ),
    WS_RECONNECT_MAX_DELAY_MS
  )
}

const retryPolicy = Schedule.addDelay(
  Schedule.recurs(WS_RECONNECT_MAX_RETRIES),
  (retryCount) => Duration.millis(getWsReconnectDelayMsForRetry(retryCount) ?? 0)
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
      Layer.provide(layerWebSocketConstructorGlobal)
    )
    const protocol = yield* RpcClient.layerProtocolSocket({
      retrySchedule: retryPolicy,
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
