import { Layer, Schedule } from 'effect'
import type { Atom } from 'effect/unstable/reactivity'
import { RpcClient, RpcSerialization } from 'effect/unstable/rpc'
import {
  layerWebSocket,
  layerWebSocketConstructorGlobal,
} from 'effect/unstable/socket/Socket'

import {
  rendererConnectionGenerationAtom,
  rendererConnectionSupervisor,
} from './renderer-connection'

/** Resolve the daemon socket from the page origin so dev and production share one contract. */
export function daemonWebSocketUrl(
  origin = globalThis.location.origin
): string {
  const url = new URL('/ws', origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.href
}

const browserProtocol = (): Layer.Layer<RpcClient.Protocol> => {
  const socket = layerWebSocket(daemonWebSocketUrl()).pipe(
    Layer.provide(layerWebSocketConstructorGlobal)
  )

  return Layer.effect(
    RpcClient.Protocol,
    RpcClient.makeProtocolSocket({
      retryTransientErrors: false,
      retryPolicy: Schedule.recurs(0),
    })
  ).pipe(Layer.provide(Layer.merge(socket, RpcSerialization.layerJson)))
}

/**
 * Renderer RPC transport boundary.
 *
 * Browser and Electron renderers use the daemon's same-origin `/ws`.
 */
export const rendererRpcProtocol = () => {
  rendererConnectionSupervisor.start()
  return (get: Atom.AtomContext) => {
    get(rendererConnectionGenerationAtom)
    return browserProtocol()
  }
}
