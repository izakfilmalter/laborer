/**
 * LaborerClient — AtomRpc Client Tag
 *
 * Wraps the LaborerRpcs group from @laborer/shared/rpc into an AtomRpc
 * client for React components. Provides typed `mutation` and `query`
 * helpers that can be used with `useAtomSet` and `useAtomValue` hooks.
 *
 * Usage in components:
 *   const destroyWorkspace = useAtomSet(LaborerClient.mutation("workspace.destroy"))
 *   // onClick={() => destroyWorkspace({ payload: { workspaceId } })}
 *
 *   const health = useAtomValue(LaborerClient.query("health.check", {}))
 *
 * @see Issue #20: AtomRpc client setup
 */

import { FetchHttpClient } from '@effect/platform'
import { RpcClient, RpcSerialization } from '@effect/rpc'
import { AtomRpc } from '@effect-atom/atom'
import { LaborerRpcs } from '@laborer/shared/rpc'
import { Layer } from 'effect'

import { serverRpcUrl } from '@/lib/tauri'

/**
 * Derive the server RPC URL based on the runtime context.
 *
 * - Dev mode: `/rpc` (Vite proxy routes to backend server on port 2100)
 * - Tauri production: `http://localhost:4100/rpc` (direct to sidecar)
 *
 * @see lib/tauri.ts for runtime context detection
 */
const RPC_URL = serverRpcUrl()

/**
 * LaborerClient — typed AtomRpc client for React components.
 *
 * Creates an RPC client that connects to the server's /rpc endpoint
 * over HTTP with JSON serialization. The protocol uses
 * RpcClient.layerProtocolHttp to match the server's
 * RpcServer.layerProtocolHttp({ path: "/rpc" }).
 */
export class LaborerClient extends AtomRpc.Tag<LaborerClient>()(
  'LaborerClient',
  {
    group: LaborerRpcs,
    protocol: RpcClient.layerProtocolHttp({ url: RPC_URL }).pipe(
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(RpcSerialization.layerJson)
    ),
  }
) {}
