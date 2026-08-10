import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import {
  HttpMiddleware,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from '@effect/platform'
import { NodeHttpServer } from '@effect/platform-node'
import { RpcSerialization, RpcServer } from '@effect/rpc'
import { LaborerRpcs } from '@laborer/shared/rpc'
import { Context, Effect, Layer, Option, Schema, type Scope } from 'effect'
import { LaborerRpcsLive } from './rpc/handlers.js'
import { AgentTaskService } from './services/agent-task-service.js'
import { serverDiscoveryLayer } from './services/server-discovery.js'
import {
  SharedSyncBackendServiceLive,
  SyncRpcHandlersLive,
  SyncWsRpc,
} from './services/sync-backend.js'
import {
  mcpOriginGuard,
  TaskMcpProtocolLayer,
  TaskMcpToolsLayer,
} from './services/task-mcp.js'
import { InfrastructureLayer } from './utility-main.js'

const PortSchema = Schema.Number.pipe(Schema.int(), Schema.between(1, 65_535))
const SYNC_TOKEN_PATH_PATTERN = /^\/sync\/([^/]+)$/

export interface ServerRuntimeConfigShape {
  readonly authToken: string | undefined
  readonly host: string
  readonly port: number
}

export class ServerRuntimeConfig extends Context.Tag(
  '@laborer/server/ServerRuntimeConfig'
)<ServerRuntimeConfig, ServerRuntimeConfigShape>() {}

class McpLoopbackRequiredError extends Schema.TaggedError<McpLoopbackRequiredError>()(
  'McpLoopbackRequiredError',
  { message: Schema.String }
) {}

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

export function isAuthorizedSyncWebSocketUrl(
  url: URL,
  authToken: string | undefined
): boolean {
  if (!authToken) {
    return true
  }

  const pathToken = url.pathname.match(SYNC_TOKEN_PATH_PATTERN)?.[1]
  return (
    url.searchParams.get('token') === authToken ||
    (pathToken !== undefined && decodeURIComponent(pathToken) === authToken)
  )
}

const authorizeWebSocketRequest = (authToken: string | undefined) =>
  Effect.gen(function* () {
    if (!authToken) {
      return undefined
    }

    const request = yield* HttpServerRequest.HttpServerRequest
    const url = HttpServerRequest.toURL(request)
    if (Option.isNone(url)) {
      return yield* HttpServerResponse.text('Invalid WebSocket URL', {
        status: 400,
      })
    }

    if (!isAuthorizedWebSocketUrl(url.value, authToken)) {
      return yield* HttpServerResponse.text(
        'Unauthorized WebSocket connection',
        {
          status: 401,
        }
      )
    }

    return undefined
  })

const authorizeSyncWebSocketRequest = (authToken: string | undefined) =>
  Effect.gen(function* () {
    if (!authToken) {
      return undefined
    }

    const request = yield* HttpServerRequest.HttpServerRequest
    const url = HttpServerRequest.toURL(request)
    if (Option.isNone(url)) {
      return yield* HttpServerResponse.text('Invalid WebSocket URL', {
        status: 400,
      })
    }

    if (!isAuthorizedSyncWebSocketUrl(url.value, authToken)) {
      return yield* HttpServerResponse.text(
        'Unauthorized WebSocket connection',
        {
          status: 401,
        }
      )
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
  HttpRouter.Default.use((router) =>
    router.get(
      path,
      Effect.gen(function* () {
        const unauthorized = yield* authorizeWebSocketRequest(authToken)
        if (unauthorized) {
          return unauthorized
        }
        return yield* websocketApp
      })
    )
  )

const authedSyncWebSocketRoute = (
  path: `/${string}`,
  authToken: string | undefined,
  websocketApp: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    never,
    HttpServerRequest.HttpServerRequest | Scope.Scope
  >
) =>
  HttpRouter.Default.use((router) =>
    router.get(
      path,
      Effect.gen(function* () {
        const unauthorized = yield* authorizeSyncWebSocketRequest(authToken)
        if (unauthorized) {
          return unauthorized
        }
        return yield* websocketApp
      })
    )
  )

const makeRoutesLayer = Layer.unwrapScoped(
  Effect.gen(function* () {
    const config = yield* ServerRuntimeConfig
    const rpcWebSocketApp = yield* RpcServer.toHttpAppWebsocket(
      LaborerRpcs
    ).pipe(
      Effect.provide(
        Layer.mergeAll(LaborerRpcsLive, RpcSerialization.layerJson)
      )
    )

    const syncWebSocketApp = yield* RpcServer.toHttpAppWebsocket(
      SyncWsRpc
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          SyncRpcHandlersLive.pipe(Layer.provide(SharedSyncBackendServiceLive)),
          RpcSerialization.layerJson
        )
      )
    )

    // Connection lifecycle logging for sync clients. The handler effect
    // runs for the duration of the WebSocket connection, so completion
    // (or interruption) marks the disconnect. This is the primary
    // diagnostic for silently dropped renderer sync subscriptions.
    const loggedSyncWebSocketApp = Effect.sync(() => {
      console.log('[server-runtime] Sync WebSocket client connected')
    }).pipe(
      Effect.zipRight(syncWebSocketApp),
      Effect.ensuring(
        Effect.sync(() => {
          console.log('[server-runtime] Sync WebSocket client disconnected')
        })
      )
    )

    const mcpLayer = TaskMcpToolsLayer.pipe(
      Layer.provide(TaskMcpProtocolLayer),
      Layer.provide(AgentTaskService.layer())
    )

    return Layer.mergeAll(
      HttpRouter.Default.use((router) =>
        router.get('/', HttpServerResponse.empty({ status: 204 }))
      ),
      authedWebSocketRoute('/rpc', config.authToken, rpcWebSocketApp),
      authedWebSocketRoute('/sync', config.authToken, loggedSyncWebSocketApp),
      authedSyncWebSocketRoute(
        `/sync/${encodeURIComponent(config.authToken ?? '')}`,
        config.authToken,
        loggedSyncWebSocketApp
      ),
      mcpLayer
    )
  })
)

export const makeServerLayer = Layer.unwrapEffect(
  Effect.gen(function* () {
    const config = yield* ServerRuntimeConfig
    if (!['127.0.0.1', '::1', 'localhost'].includes(config.host)) {
      return yield* new McpLoopbackRequiredError({
        message: 'The token-free MCP endpoint requires a loopback server host',
      })
    }
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
      HttpRouter.Default.serve((app) =>
        mcpOriginGuard(HttpMiddleware.cors()(app))
      ).pipe(Layer.provide(makeRoutesLayer)),
      listeningLogLayer,
      serverDiscoveryLayer(config)
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
