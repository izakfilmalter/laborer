/**
 * LaborerClient — AtomRpc client for the server's LaborerRpcs.
 *
 * Communicates via a direct MessagePort connection to the server utility
 * process (no HTTP, no JSON serialization). The port is acquired lazily
 * via `acquireServicePort('server')` when the first RPC is made.
 *
 * Uses `AtomRpc.Tag` to provide typed `query` and `mutation` atoms that
 * integrate with React components via `@effect-atom/atom`.
 *
 * @see Issue #4: Renderer RPC client wired to MessagePort
 * @see packages/server/src/utility-main.ts — Server utility process entry
 */

import { RpcClient } from '@effect/rpc'
import { AtomRpc } from '@effect-atom/atom'
import { LaborerRpcs } from '@laborer/shared/rpc'
import type { RpcMessagePort } from '@laborer/shared/rpc-transport-messageport'
import { makeClientProtocolMessagePort } from '@laborer/shared/rpc-transport-messageport-client'
import { Effect, Layer } from 'effect'

import { acquireServicePort } from '@/lib/desktop'

/**
 * Build the RPC client protocol layer.
 *
 * MessagePort acquired via `acquireServicePort('server')` which follows
 * VS Code's `acquirePort()` pattern to transfer the port across the
 * context isolation boundary.
 */
const serverProtocol: Layer.Layer<RpcClient.Protocol> = Layer.scoped(
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
 * Uses MessagePort to the server utility process.
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
