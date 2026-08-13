import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { NodeHttpServer } from '@effect/platform-node'
import { LaborerRpcs } from '@laborer/shared/rpc'
import { Context, Effect, Layer, Option, Schema, type Scope } from 'effect'
import {
  HttpMiddleware,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from 'effect/unstable/http'
import { RpcSerialization, RpcServer } from 'effect/unstable/rpc'
import { LaborerRpcsLive } from './rpc/handlers.js'
import { InfrastructureLayer } from './utility-main.js'

const PortSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 65_535 })
)

export interface ServerRuntimeConfigShape {
  readonly authToken: string | undefined
  readonly host: string
  readonly port: number
}

export class ServerRuntimeConfig extends Context.Service<
  ServerRuntimeConfig,
  ServerRuntimeConfigShape
>()('@laborer/server/ServerRuntimeConfig') {}

const BootstrapEnvelope = Schema.Struct({
  authToken: Schema.optional(Schema.String),
  host: Schema.optional(Schema.String),
  port: Schema.optional(PortSchema),
})

export function readBootstrapConfig(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env
): ServerRuntimeConfigShape {
  const fdIndex = argv.indexOf('--bootstrap-fd')
  const fd = fdIndex >= 0 ? Number(argv[fdIndex + 1]) : undefined
  if (fd !== undefined && Number.isInteger(fd)) {
    const raw = readFileSync(fd, 'utf8')
    const parsed = Schema.decodeUnknownSync(BootstrapEnvelope)(JSON.parse(raw))
    return {
      authToken: parsed.authToken,
      host: parsed.host ?? '127.0.0.1',
      port: parsed.port ?? 3773,
    }
  }

  return {
    authToken: env.LABORER_SERVER_AUTH_TOKEN,
    host: env.LABORER_SERVER_HOST ?? '127.0.0.1',
    port: Number(env.LABORER_SERVER_PORT ?? env.PORT ?? '3773'),
  }
}

export const ServerRuntimeConfigLive = (config: ServerRuntimeConfigShape) =>
  Layer.succeed(ServerRuntimeConfig, config)

export function isAuthorizedWebSocketUrl(
  url: URL,
  authToken: string | undefined
): boolean {
  return !authToken || url.searchParams.get('token') === authToken
}

const authorizeWebSocketRequest = (authToken: string | undefined) =>
  Effect.gen(function* () {
    if (!authToken) {
      return undefined
    }

    const request = yield* HttpServerRequest.HttpServerRequest
    const url = HttpServerRequest.toURL(request)
    if (Option.isNone(url)) {
      return HttpServerResponse.text('Invalid WebSocket URL', {
        status: 400,
      })
    }

    if (!isAuthorizedWebSocketUrl(url.value, authToken)) {
      return HttpServerResponse.text('Unauthorized WebSocket connection', {
        status: 401,
      })
    }

    return undefined
  })

const authedWebSocketRoute = (
  path: `/${string}`,
  authToken: string | undefined,
  websocketApp: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    never,
    HttpServerRequest.HttpServerRequest | Scope.Scope
  >
) =>
  HttpRouter.add(
    'GET',
    path,
    Effect.gen(function* () {
      const unauthorized = yield* authorizeWebSocketRequest(authToken)
      if (unauthorized) {
        return unauthorized
      }
      return yield* websocketApp
    })
  )

const makeRoutesLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerRuntimeConfig
    const rpcWebSocketApp = yield* RpcServer.toHttpEffectWebsocket(
      LaborerRpcs
    ).pipe(
      Effect.provide(
        Layer.mergeAll(LaborerRpcsLive, RpcSerialization.layerJson)
      )
    )

    return Layer.mergeAll(
      HttpRouter.add('GET', '/', HttpServerResponse.empty({ status: 204 })),
      authedWebSocketRoute('/rpc', config.authToken, rpcWebSocketApp)
    )
  })
)

export const makeServerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerRuntimeConfig
    const listeningLogLayer = Layer.effectDiscard(
      Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer
        const address = server.address
        const host =
          address._tag === 'TcpAddress' ? address.hostname : config.host
        const port = address._tag === 'TcpAddress' ? address.port : config.port
        yield* Effect.logInfo(
          `[server-main] Listening on http://${host}:${String(port)}`
        )
      })
    )

    return Layer.mergeAll(
      HttpRouter.serve(makeRoutesLayer, {
        middleware: HttpMiddleware.cors(),
      }),
      listeningLogLayer
    ).pipe(
      Layer.provide(InfrastructureLayer),
      Layer.provide(
        NodeHttpServer.layer(createServer, {
          host: config.host,
          port: config.port,
        })
      )
    )
  })
)

export const runServer = Layer.launch(makeServerLayer) satisfies Effect.Effect<
  never,
  unknown,
  ServerRuntimeConfig
>
