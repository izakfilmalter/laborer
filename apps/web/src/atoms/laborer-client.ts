/**
 * LaborerClient — AtomRpc client for the server's LaborerRpcs.
 *
 * Communicates directly with the desktop-managed server utility process over
 * MessagePort.
 *
 * Uses `AtomRpc.Service` to provide typed `query` and `mutation` atoms that
 * integrate with React components via `@effect/atom-react`.
 *
 * @see Issue #4: Renderer RPC client wired to MessagePort
 * @see packages/server/src/utility-main.ts — Server utility process entry
 */

import { LaborerRpcs } from '@laborer/shared/rpc'
import type { RpcMessagePort } from '@laborer/shared/rpc-transport-messageport'
import { makeClientProtocolMessagePort } from '@laborer/shared/rpc-transport-messageport-client'
import { Effect, Layer } from 'effect'
import { AtomRpc } from 'effect/unstable/reactivity'
import { RpcClient } from 'effect/unstable/rpc'

import { acquireServicePort } from '@/lib/desktop'

const serverProtocol: Layer.Layer<RpcClient.Protocol> = Layer.effect(
  RpcClient.Protocol,
  Effect.gen(function* () {
    const port = yield* Effect.promise(() => acquireServicePort('server'))
    if (!port) {
      return yield* Effect.die(
        'Server utility process is not running — could not acquire MessagePort'
      )
    }
    return yield* makeClientProtocolMessagePort(
      port as unknown as RpcMessagePort
    )
  })
)

/**
 * LaborerClient — typed AtomRpc client for React components.
 *
 * Uses MessagePort RPC to the desktop-managed server utility process.
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
