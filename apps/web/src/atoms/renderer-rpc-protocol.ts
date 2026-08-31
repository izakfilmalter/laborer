import { Effect, Layer, Schedule } from 'effect'
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

/**
 * `onDisconnect` also fires when a protocol layer is torn down on purpose —
 * the socket run loop is interrupted and the hook runs from `Effect.ensuring`.
 * A layer built for an older generation is therefore never reporting a live
 * failure: the supervisor has already moved on and reporting would cycle the
 * fresh connection it just established.
 */
export const isLiveProtocolGeneration = (
  builtForGeneration: number,
  currentGeneration: number
): boolean => builtForGeneration === currentGeneration

const browserProtocol = (
  generation: number
): Layer.Layer<RpcClient.Protocol> => {
  const socket = layerWebSocket(daemonWebSocketUrl()).pipe(
    Layer.provide(layerWebSocketConstructorGlobal)
  )

  /**
   * A dead transport is the supervisor's business: its own idle socket usually
   * survives a daemon stall, so without this report nothing would rebuild the
   * runtime and every pane would stay stuck on "reconnecting".
   */
  const connectionHooks = Layer.succeed(RpcClient.ConnectionHooks, {
    onConnect: Effect.void,
    onDisconnect: Effect.sync(() => {
      if (
        isLiveProtocolGeneration(
          generation,
          rendererConnectionSupervisor.getSnapshot().generation
        )
      ) {
        rendererConnectionSupervisor.notifyTransportFailure()
      }
    }),
  })

  return Layer.effect(
    RpcClient.Protocol,
    RpcClient.makeProtocolSocket({
      retryTransientErrors: false,
      retryPolicy: Schedule.recurs(0),
    })
  ).pipe(
    Layer.provide(
      Layer.mergeAll(socket, RpcSerialization.layerJson, connectionHooks)
    )
  )
}

/**
 * Renderer RPC transport boundary.
 *
 * Browser and Electron renderers use the daemon's same-origin `/ws`.
 *
 * The transport never retries itself — `RpcClient` does not re-send in-flight
 * requests across an internal reconnect, so those requests would hang forever.
 * Its death is instead reported to `RendererConnectionSupervisor`, which
 * recycles the connection and advances the generation this layer keys on.
 */
export const rendererRpcProtocol = () => {
  rendererConnectionSupervisor.start()
  return (get: Atom.AtomContext) => {
    const generation = get(rendererConnectionGenerationAtom)
    return browserProtocol(generation)
  }
}
