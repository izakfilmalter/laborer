import type { ProjectsEvent } from '@laborer/contracts/projects'
import { WS_METHODS, WsRpcGroup } from '@laborer/contracts/rpc'
import type {
  ServerConfigStreamEvent,
  ServerLifecycleStreamEvent,
} from '@laborer/contracts/server'
import { Effect, Layer, Stream } from 'effect'
import { HttpRouter, HttpServerResponse } from 'effect/unstable/http'
import { RpcSerialization, RpcServer } from 'effect/unstable/rpc'

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

export const healthRouteLayer = HttpRouter.add(
  'GET',
  '/health',
  HttpServerResponse.json({
    status: 'ok',
  })
)

export const websocketRpcRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const rpcWebSocketHttpEffect = yield* RpcServer.toHttpEffectWebsocket(
      WsRpcGroup
    ).pipe(
      Effect.provide(Layer.mergeAll(WsRpcLayer, RpcSerialization.layerJson))
    )

    return HttpRouter.add('GET', '/ws', rpcWebSocketHttpEffect)
  })
)
