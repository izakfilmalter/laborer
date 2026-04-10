import { layer as nodeHttpServerLayer } from '@effect/platform-node/NodeHttpServer'
import { layer as nodeServicesLayer } from '@effect/platform-node/NodeServices'
import { Effect, Layer } from 'effect'
import { HttpRouter } from 'effect/unstable/http'

import { ServerRuntimeConfig } from './config'
import { ProjectStore } from './project-store'
import { ServerLifecycleEvents } from './server-lifecycle-events'
import { healthRouteLayer, websocketRpcRouteLayer } from './ws'

const HttpServerLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerRuntimeConfig
    const NodeHttp = yield* Effect.promise(() => import('node:http'))

    return nodeHttpServerLayer(NodeHttp.createServer, {
      host: config.host,
      port: config.port,
    })
  })
)

const RoutesLayer = Layer.mergeAll(healthRouteLayer, websocketRpcRouteLayer)

export const ServerLive = HttpRouter.serve(RoutesLayer, {
  disableLogger: true,
}).pipe(
  Layer.provideMerge(HttpServerLive),
  Layer.provideMerge(ProjectStore.layer),
  Layer.provideMerge(ServerLifecycleEvents.layer),
  Layer.provideMerge(ServerRuntimeConfig.layer),
  Layer.provideMerge(nodeServicesLayer)
)

export const runServer = Layer.launch(ServerLive)
