import { createServer } from 'node:http'
import { NodeHttpServer } from '@effect/platform-node'
import { Context, Effect, Layer, Schema } from 'effect'
import { HttpRouter, HttpServer } from 'effect/unstable/http'
import { workspaceAssetResponse } from './workspace-assets.js'

export const WORKSPACE_ASSET_PORT_ENV = 'LABORER_WORKSPACE_ASSET_PORT'

export class WorkspaceAssetServerConfigError extends Schema.TaggedError<WorkspaceAssetServerConfigError>()(
  'WorkspaceAssetServerConfigError',
  { message: Schema.String }
) {}

export class WorkspaceAssetServer extends Context.Service<
  WorkspaceAssetServer,
  { readonly origin: string }
>()('@laborer/server/WorkspaceAssetServer') {
  static readonly testLayer = Layer.succeed(
    WorkspaceAssetServer,
    WorkspaceAssetServer.of({ origin: 'http://127.0.0.1:43210' })
  )
}

const WorkspaceAssetRoutes = HttpRouter.addAll([
  HttpRouter.route('GET', '/api/workspace-assets/*', workspaceAssetResponse),
  HttpRouter.route('HEAD', '/api/workspace-assets/*', workspaceAssetResponse),
])

const Port = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(65_535)
)

export const parseWorkspaceAssetPort = (value: string | undefined): number => {
  if (value === undefined || value.trim() === '') {
    return 0
  }
  try {
    return Schema.decodeUnknownSync(Port)(value)
  } catch {
    throw new WorkspaceAssetServerConfigError({
      message: `${WORKSPACE_ASSET_PORT_ENV} must be an integer from 0 to 65535`,
    })
  }
}

export const makeWorkspaceAssetServerLayer = (port: number) => {
  const HttpServerLive = NodeHttpServer.layer(createServer, {
    gracefulShutdownTimeout: 0,
    host: '127.0.0.1',
    port,
  })
  const OriginLive = Layer.effect(
    WorkspaceAssetServer,
    Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer
      if (server.address._tag !== 'TcpAddress') {
        return yield* WorkspaceAssetServerConfigError.make({
          message: 'Workspace asset server did not bind a TCP address',
        })
      }
      return WorkspaceAssetServer.of({
        origin: `http://127.0.0.1:${String(server.address.port)}`,
      })
    })
  )
  const RoutesLive = HttpRouter.serve(WorkspaceAssetRoutes)

  return Layer.merge(OriginLive, RoutesLive).pipe(Layer.provide(HttpServerLive))
}
