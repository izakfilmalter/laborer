import { WsRpcGroup } from '@laborer/contracts/rpc'
import type { Effect } from 'effect'
import { Layer } from 'effect'
import { RpcClient, RpcSerialization } from 'effect/unstable/rpc'
import {
  layerWebSocket,
  layerWebSocketConstructorGlobal,
} from 'effect/unstable/socket/Socket'

import { resolveServerUrl } from '@/lib/server-url'

export const makeWsRpcProtocolClient = RpcClient.make(WsRpcGroup)

type RpcClientFactory = typeof makeWsRpcProtocolClient

export type WsRpcProtocolClient =
  RpcClientFactory extends Effect.Effect<infer Client, unknown, unknown>
    ? Client
    : never

export function createWsRpcProtocolLayer(url?: string) {
  const resolvedUrl = resolveServerUrl({
    url,
    protocol: window.location.protocol === 'https:' ? 'wss' : 'ws',
    pathname: '/ws',
  })
  const socketLayer = layerWebSocket(resolvedUrl).pipe(
    Layer.provide(layerWebSocketConstructorGlobal)
  )

  return RpcClient.layerProtocolSocket({ retryTransientErrors: true }).pipe(
    Layer.provide(Layer.mergeAll(socketLayer, RpcSerialization.layerJson))
  )
}
