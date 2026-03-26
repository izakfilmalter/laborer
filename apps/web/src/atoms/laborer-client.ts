/**
 * LaborerClient — AtomRpc Client Tag
 *
 * Wraps the LaborerRpcs group from @laborer/shared/rpc into an AtomRpc
 * client for React components. Provides typed `mutation` and `query`
 * helpers that can be used with `useAtomSet` and `useAtomValue` hooks.
 *
 * In Electron mode, communicates via a direct MessagePort connection to
 * the server utility process (no HTTP, no JSON serialization). The port
 * is acquired lazily via `desktopBridge.acquireServicePort('server')`
 * when the first RPC is made.
 *
 * In browser dev mode (Vite), falls back to HTTP at `/rpc`.
 *
 * Usage in components:
 *   const destroyWorkspace = useAtomSet(LaborerClient.mutation("workspace.destroy"))
 *   // onClick={() => destroyWorkspace({ payload: { workspaceId } })}
 *
 *   const health = useAtomValue(LaborerClient.query("health.check", {}))
 *
 * @see Issue #12: Renderer server UI wired to MessagePort
 * @see Issue #20: AtomRpc client setup
 */

import { FetchHttpClient } from '@effect/platform'
import { RpcClient, RpcSerialization } from '@effect/rpc'
import { AtomRpc } from '@effect-atom/atom'
import { LaborerRpcs } from '@laborer/shared/rpc'
import type { RpcMessagePort } from '@laborer/shared/rpc-transport-messageport'
import { makeClientProtocolMessagePort } from '@laborer/shared/rpc-transport-messageport-client'
import { Effect, Layer } from 'effect'

import { getDesktopBridge, isElectron, serverRpcUrl } from '@/lib/desktop'

/**
 * Build the RPC client protocol layer based on the runtime context.
 *
 * - Electron: MessagePort acquired from `desktopBridge.acquireServicePort('server')`.
 *   The port is acquired lazily inside `Layer.scoped` when the layer is first built
 *   (i.e., when a React component first subscribes to a query/mutation atom).
 *   No `RpcSerialization.layerJson` or `FetchHttpClient.layer` needed — MessagePort
 *   uses structured clone natively.
 *
 * - Browser dev: HTTP at `/rpc` (Vite proxy rewrites to server's /rpc).
 */
const serverProtocol: Layer.Layer<RpcClient.Protocol> = isElectron()
  ? Layer.scoped(
      RpcClient.Protocol,
      Effect.gen(function* () {
        const bridge = getDesktopBridge()
        if (!bridge) {
          return yield* Effect.die(
            'DesktopBridge unavailable in Electron context'
          )
        }
        const port = yield* Effect.promise(() =>
          bridge.acquireServicePort('server')
        )
        if (!port) {
          return yield* Effect.die(
            'Server utility process is not running — could not acquire MessagePort'
          )
        }
        // Cast Web MessagePort to RpcMessagePort — the runtime handles both
        // API styles (.onmessage setter vs .on('message') method) correctly.
        // The type mismatch is because Web's onmessage uses MessageEvent while
        // RpcMessagePort uses a simpler { data: unknown } shape.
        return yield* makeClientProtocolMessagePort(port as RpcMessagePort)
      })
    )
  : RpcClient.layerProtocolHttp({ url: serverRpcUrl() }).pipe(
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(RpcSerialization.layerJson)
    )

/**
 * LaborerClient — typed AtomRpc client for React components.
 *
 * In Electron, uses MessagePort to the server utility process.
 * In browser dev, uses HTTP at `/rpc` (Vite proxy).
 * All ~30 LaborerRpcs endpoints work over either transport.
 */
export class LaborerClient extends AtomRpc.Tag<LaborerClient>()(
  'LaborerClient',
  {
    group: LaborerRpcs,
    protocol: serverProtocol,
  }
) {}

/**
 * Reactivity keys for automatic cache invalidation.
 *
 * Pass these keys to both `LaborerClient.query` (via `options.reactivityKeys`)
 * and `LaborerClient.mutation` calls (via the `reactivityKeys` field in the
 * setter argument) so that a successful mutation automatically re-fetches
 * any subscribed query atoms.
 */
export const ConfigReactivityKeys = ['config'] as const
