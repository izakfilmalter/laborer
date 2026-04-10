import { HttpLayerRouter, HttpServerResponse } from '@effect/platform'
import { RpcSerialization, RpcServer } from '@effect/rpc'
import type { ProjectsEvent } from '@laborer/contracts/projects'
import { WS_METHODS, WsRpcGroup } from '@laborer/contracts/rpc'
import type {
  ServerConfigStreamEvent,
  ServerLifecycleStreamEvent,
} from '@laborer/contracts/server'
import { Effect, Layer, Stream } from 'effect'

import { ServerRuntimeConfig } from './config'
import { ProjectStore } from './project-store'
import { ServerLifecycleEvents } from './server-lifecycle-events'

const WsRpcLayer = WsRpcGroup.toLayer(
  Effect.gen(function* () {
    const config = yield* ServerRuntimeConfig
    const projects = yield* ProjectStore
    const lifecycle = yield* ServerLifecycleEvents

    return WsRpcGroup.of({
      [WS_METHODS.projectsList]: () => projects.list,
      [WS_METHODS.projectsAdd]: (input) => projects.add(input),
      [WS_METHODS.projectsCreateThread]: (input) =>
        projects.createThread(input),
      [WS_METHODS.serverGetConfig]: () => Effect.succeed(config),
      [WS_METHODS.subscribeProjects]: () =>
        Stream.unwrap(
          projects.list.pipe(
            Effect.map((snapshot) =>
              Stream.concat(
                Stream.fromIterable([
                  {
                    version: 1,
                    type: 'snapshot',
                    snapshot,
                  } satisfies ProjectsEvent,
                ]),
                projects.stream
              )
            )
          )
        ),
      [WS_METHODS.subscribeServerConfig]: () =>
        Stream.concat(
          Stream.fromIterable([
            {
              version: 1,
              type: 'snapshot',
              config,
            } satisfies ServerConfigStreamEvent,
          ]),
          Stream.never
        ),
      [WS_METHODS.subscribeServerLifecycle]: () =>
        Stream.unwrap(
          lifecycle.snapshot.pipe(
            Effect.map((snapshot) =>
              Stream.concat(
                Stream.fromIterable<ServerLifecycleStreamEvent>(
                  snapshot.events
                ),
                lifecycle.stream
              )
            )
          )
        ),
    })
  })
)

export const healthRouteLayer = HttpLayerRouter.add(
  'GET',
  '/health',
  Effect.succeed(HttpServerResponse.unsafeJson({ status: 'ok' }))
)

export const websocketRpcRouteLayer = RpcServer.layerHttpRouter({
  group: WsRpcGroup,
  path: '/ws',
  protocol: 'websocket',
}).pipe(Layer.provide(WsRpcLayer), Layer.provide(RpcSerialization.layerJson))
