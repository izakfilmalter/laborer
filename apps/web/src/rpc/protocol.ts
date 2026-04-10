import { BrowserSocket } from '@effect/platform-browser'
import { RpcClient, RpcSerialization } from '@effect/rpc'
import { WsRpcGroup } from '@laborer/contracts/rpc'
import { Layer } from 'effect'
import type * as Effect from 'effect/Effect'

import { resolveServerUrl } from '@/lib/server-url'

export const makeWsRpcProtocolClient = RpcClient.make(WsRpcGroup)

type RpcClientFactory = typeof makeWsRpcProtocolClient

export type WsRpcProtocolClient =
  RpcClientFactory extends Effect.Effect<infer Client, never, unknown>
    ? Client
    : never

export function createWsRpcProtocolLayer(url?: string) {
  const resolvedUrl = resolveServerUrl({
    url,
    protocol: window.location.protocol === 'https:' ? 'wss' : 'ws',
    pathname: '/ws',
  })
  return RpcClient.layerProtocolSocket({ retryTransientErrors: true }).pipe(
    Layer.provide(
      Layer.mergeAll(
        BrowserSocket.layerWebSocket(resolvedUrl),
        RpcSerialization.layerJson
      )
    )
  )
}
