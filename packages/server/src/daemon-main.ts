import { createServer } from 'node:http'
import { NodeHttpServer, NodeRuntime } from '@effect/platform-node'
import { FileWatcherRpcsLive } from '@laborer/file-watcher/rpc/handlers'
import { FileWatcher } from '@laborer/file-watcher/services/file-watcher'
import { WatcherManager } from '@laborer/file-watcher/services/watcher-manager'
import { DaemonRpcs } from '@laborer/shared/rpc'
import { TerminalRpcsLive } from '@laborer/terminal/rpc/handlers'
import { directLayer as PtyDirectLayer } from '@laborer/terminal/services/pty-direct'
import { TerminalManager } from '@laborer/terminal/services/terminal-manager'
import { Effect, Layer, SubscriptionRef } from 'effect'
import { HttpRouter, HttpServerResponse } from 'effect/unstable/http'
import { RpcSerialization, RpcServer } from 'effect/unstable/rpc'
import { LaborerRpcsLive } from './rpc/handlers.js'
import { DeferredServicesReady } from './services/deferred-service.js'
import { FileWatcherClient } from './services/file-watcher-client.js'
import { TerminalClient } from './services/terminal-client.js'
import { makeInfrastructureLayer } from './utility-main.js'

export const DAEMON_HOST = '127.0.0.1'
export const DAEMON_PORT_ENV = 'LABORER_DAEMON_PORT'
export const DEFAULT_DAEMON_PORT = 2100

const parsePort = (value: string | undefined): number => {
  if (value === undefined || value.trim() === '') {
    return DEFAULT_DAEMON_PORT
  }
  const port = Number(value)
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`${DAEMON_PORT_ENV} must be an integer from 0 to 65535`)
  }
  return port
}

const TerminalServices = Layer.merge(
  TerminalManager.layer,
  PtyDirectLayer
).pipe(Layer.provide(PtyDirectLayer))

const FileWatcherServices = Layer.merge(
  WatcherManager.layer,
  FileWatcher.layer
).pipe(Layer.provide(FileWatcher.layer))

const NativeServices = Layer.merge(TerminalServices, FileWatcherServices)

const Infrastructure = makeInfrastructureLayer({
  fileWatcherClientLayer: FileWatcherClient.inProcessLayer,
  terminalClientLayer: TerminalClient.inProcessLayer,
})

// Retain the exact native service instances supplied to the infrastructure.
// Building and merging a second NativeServices layer would split public RPC
// state from the in-process clients used by the Laborer handlers.
const ApplicationServices = Infrastructure.pipe(
  Layer.provideMerge(NativeServices)
)

const RpcHandlers = Layer.mergeAll(
  TerminalRpcsLive,
  FileWatcherRpcsLive,
  // Laborer owns the public terminal.spawn handler when the legacy groups
  // overlap. It resolves workspaces before calling the in-process client.
  LaborerRpcsLive
)

const RpcRoute = RpcServer.layer(DaemonRpcs).pipe(
  Layer.provide(RpcServer.layerProtocolWebsocket({ path: '/ws' })),
  Layer.provide(RpcHandlers),
  Layer.provide(ApplicationServices)
)

const daemonStartedAt = Date.now()

const healthResponse = Effect.gen(function* () {
  const readyService = yield* DeferredServicesReady
  const ready = yield* SubscriptionRef.get(readyService.ref)
  return yield* HttpServerResponse.json(
    {
      ready,
      status: ready ? 'ok' : 'starting',
      uptime: Math.max(0, (Date.now() - daemonStartedAt) / 1000),
    },
    { status: ready ? 200 : 503 }
  )
})

const HealthRoutes = HttpRouter.addAll([
  HttpRouter.route('GET', '/health', healthResponse),
  HttpRouter.route('GET', '/server-health', healthResponse),
])

export const makeDaemonServerLayer = (port: number) =>
  HttpRouter.serve(Layer.merge(RpcRoute, HealthRoutes)).pipe(
    Layer.provide(ApplicationServices),
    Layer.provide(RpcSerialization.layerJson),
    Layer.provide(
      NodeHttpServer.layer(createServer, { host: DAEMON_HOST, port })
    )
  )

const port = parsePort(process.env[DAEMON_PORT_ENV])

NodeRuntime.runMain(
  Layer.launch(makeDaemonServerLayer(port)).pipe(Effect.scoped)
)
