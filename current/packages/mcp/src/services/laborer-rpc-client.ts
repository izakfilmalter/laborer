import { NodeSocket } from '@effect/platform-node'
import { RpcClient, RpcSerialization } from '@effect/rpc'
import { RpcClientError } from '@effect/rpc/RpcClientError'
import {
  LaborerRpcs,
  type ProjectResponse,
  RpcError,
} from '@laborer/shared/rpc'
import { Context, Effect, Layer } from 'effect'

// Standalone MCP mode uses WebSocket RPC to connect to the server. The PORT env
// var defaults to 2100 for backwards compatibility with external MCP
// clients. Utility process mode uses the same layer with an inherited PORT.
const serverPort = Number(process.env.PORT ?? '2100')
const serverRpcUrl = `ws://localhost:${serverPort}/rpc`

class LaborerRpcClient extends Context.Tag('@laborer/mcp/LaborerRpcClient')<
  LaborerRpcClient,
  {
    readonly listProjects: () => Effect.Effect<
      readonly ProjectResponse[],
      RpcError
    >
  }
>() {
  /**
   * WebSocket-based layer for standalone MCP server mode (stdio entry point).
   * Uses socket RPC + JSON serialization to connect to the server's `/rpc`
   * endpoint.
   */
  static readonly layer = Layer.scoped(
    LaborerRpcClient,
    Effect.gen(function* () {
      const rpcClient = yield* RpcClient.make(LaborerRpcs).pipe(
        Effect.provide(
          RpcClient.layerProtocolSocket({ retryTransientErrors: true }).pipe(
            Layer.provide(
              Layer.mergeAll(
                NodeSocket.layerWebSocket(serverRpcUrl),
                RpcSerialization.layerJson
              )
            )
          )
        )
      )

      return wrapRpcClient(rpcClient)
    })
  )
}

/**
 * Infer the RPC client type from `RpcClient.make(LaborerRpcs)`.
 */
const MakeLaborerClient = RpcClient.make(LaborerRpcs)
type LaborerRpc = Effect.Effect.Success<typeof MakeLaborerClient>

/**
 * Wrap an RPC client instance into the LaborerRpcClient service interface.
 * Shared by standalone and utility-process MCP modes.
 */
function wrapRpcClient(rpcClient: LaborerRpc): LaborerRpcClient['Type'] {
  const listProjects = Effect.fn('LaborerRpcClient.listProjects')(function* () {
    return yield* rpcClient.project.list().pipe(Effect.mapError(toRpcError))
  })

  return LaborerRpcClient.of({
    listProjects,
  })
}

const toRpcError = (error: unknown) =>
  new RpcError({
    code: 'RPC_CLIENT_ERROR',
    message: error instanceof RpcClientError ? error.message : String(error),
  })

export { LaborerRpcClient }
