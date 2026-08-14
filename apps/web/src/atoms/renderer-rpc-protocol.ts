import type { SidecarName } from '@laborer/shared/desktop-bridge'
import type { RpcMessagePort } from '@laborer/shared/rpc-transport-messageport'
import { makeClientProtocolMessagePort } from '@laborer/shared/rpc-transport-messageport-client'
import { Effect, Layer, Schedule } from 'effect'
import type { Atom } from 'effect/unstable/reactivity'
import { RpcClient, RpcSerialization } from 'effect/unstable/rpc'
import {
  layerWebSocket,
  layerWebSocketConstructorGlobal,
} from 'effect/unstable/socket/Socket'

import { acquireServicePort, localApi } from '@/lib/local-api'
import {
  rendererConnectionGenerationAtom,
  rendererConnectionSupervisor,
} from './renderer-connection'

type RpcSidecarName = Extract<SidecarName, 'server' | 'terminal'>

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

const messagePortProtocol = (
  service: RpcSidecarName
): Layer.Layer<RpcClient.Protocol> =>
  Layer.effect(
    RpcClient.Protocol,
    Effect.gen(function* () {
      const port = yield* Effect.promise(() => acquireServicePort(service))
      if (!port) {
        return yield* Effect.die(
          `${service} utility process is not running — could not acquire MessagePort`
        )
      }
      return yield* makeClientProtocolMessagePort(
        port as unknown as RpcMessagePort
      )
    })
  )

/**
 * Renderer RPC transport boundary.
 *
 * Plain browsers always use the daemon's same-origin `/ws`. Electron retains
 * its legacy MessagePort path until the desktop switch-and-delete phase.
 */
export const rendererRpcProtocol = (legacyService: RpcSidecarName) => {
  if (localApi.isDesktop) {
    return messagePortProtocol(legacyService)
  }
  rendererConnectionSupervisor.start()
  return (get: Atom.AtomContext) => {
    get(rendererConnectionGenerationAtom)
    return browserProtocol()
  }
}
