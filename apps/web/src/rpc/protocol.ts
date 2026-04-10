import { BrowserSocket } from '@effect/platform-browser'
import { RpcClient, RpcSerialization } from '@effect/rpc'
import { WsRpcGroup } from '@laborer/contracts/rpc'
import { Layer, Match } from 'effect'
import type * as Effect from 'effect/Effect'

import { resolveServerUrl } from '@/lib/server-url'

export const makeWsRpcProtocolClient = RpcClient.make(WsRpcGroup)

export interface WsRpcProtocolClient
  extends Effect.Effect.Success<typeof makeWsRpcProtocolClient> {}

export function createWsRpcProtocolLayer(url?: string) {
  const protocol = Match.value(window.location.protocol).pipe(
    Match.when('https:', (): 'wss' => 'wss'),
    Match.orElse((): 'ws' => 'ws')
  )
  const resolvedUrl = resolveServerUrl({
    url,
    protocol,
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
