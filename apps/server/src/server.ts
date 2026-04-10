import { createServer } from 'node:http'

import { HttpLayerRouter } from '@effect/platform'
import { NodeHttpServer } from '@effect/platform-node'
import { Effect, Layer } from 'effect'

import { ServerRuntimeConfig } from './config'
import { EditorOpener } from './open-in-editor'
import { ProjectStore } from './project-store'
import { ServerLifecycleEvents } from './server-lifecycle-events'
import { TerminalManager } from './terminal-manager'
import { healthRouteLayer, websocketRpcRouteLayer } from './ws'

const HttpServerLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const config = yield* ServerRuntimeConfig

    return NodeHttpServer.layer(() => createServer(), {
      host: config.host,
      port: config.port,
    })
  })
)

const RoutesLayer = Layer.mergeAll(healthRouteLayer, websocketRpcRouteLayer)

export const ServerLive = HttpLayerRouter.serve(RoutesLayer, {
  disableLogger: true,
}).pipe(
  Layer.provideMerge(HttpServerLive),
  Layer.provideMerge(EditorOpener.layer),
  Layer.provideMerge(ProjectStore.layer),
  Layer.provideMerge(ServerLifecycleEvents.layer),
  Layer.provideMerge(TerminalManager.layer),
  Layer.provideMerge(ServerRuntimeConfig.layer)
)

export const runServer = Layer.launch(ServerLive)
