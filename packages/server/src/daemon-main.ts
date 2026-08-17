import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import { NodeHttpServer, NodeRuntime } from '@effect/platform-node'
import {
  type DaemonRegistration,
  EnsureConflictError,
  processExists,
  readDaemonRegistration,
  removeRegistration,
  watchRegistrationOwnership,
  writeJsonRegistration,
} from '@laborer/ensure'
import { FileWatcherRpcsLive } from '@laborer/file-watcher/rpc/handlers'
import { FileWatcher } from '@laborer/file-watcher/services/file-watcher'
import { WatcherManager } from '@laborer/file-watcher/services/watcher-manager'
import { DaemonRpcs } from '@laborer/shared/rpc'
import { TerminalRpcsLive } from '@laborer/terminal/rpc/handlers'
import {
  ptyHostProxyLayer,
  shutdownPtyHost,
} from '@laborer/terminal/services/pty-host-proxy'
import { Effect, Layer, SubscriptionRef } from 'effect'
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from 'effect/unstable/http'
import { RpcSerialization, RpcServer } from 'effect/unstable/rpc'
import {
  resolveDaemonRegistrationPath,
  resolveDaemonVersion,
} from './daemon-registration.js'
import { makeInfrastructureLayer } from './infrastructure.js'
import { LaborerRpcsLive } from './rpc/handlers.js'
import { SlackDaemonRpcsLive } from './rpc/slack-daemon-handlers.js'
import { DeferredServicesReady } from './services/deferred-service.js'
import { FileWatcherClient } from './services/file-watcher-client.js'
import { ProcessInspector } from './services/process-inspector.js'
import { ProcessLauncher } from './services/process-launcher.js'
import { SlackDaemonProcessControl } from './services/slack-daemon-process-control.js'
import { TerminalClient } from './services/terminal-client.js'
import { staticAssetResponse, WEB_DIST_ENV } from './static-assets.js'

export const DAEMON_HOST = '127.0.0.1'
export const DAEMON_PORT_ENV = 'LABORER_DAEMON_PORT'
export const DEFAULT_DAEMON_PORT = 2100
export const DAEMON_SELF_EVICTION_INTERVAL_MS_DEFAULT = 5000

const positiveIntegerFromEnv = (name: string, fallback: number): number => {
  const value = Number(process.env[name])
  return Number.isInteger(value) && value > 0 ? value : fallback
}

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

// The detached host owns terminal state. The daemon only holds this proxy and
// cannot destroy PTYs when its watch process restarts.
const TerminalServices = ptyHostProxyLayer

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
  LaborerRpcsLive,
  SlackDaemonRpcsLive.pipe(
    Layer.provide(
      SlackDaemonProcessControl.layer.pipe(
        Layer.provide(
          Layer.merge(ProcessInspector.layer, ProcessLauncher.layer)
        )
      )
    )
  )
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
  // Mission control still presents capability-level status indicators. All
  // capabilities now share this daemon lifecycle, so their health aliases
  // intentionally report the same readiness rather than falling through to
  // the static SPA response.
  HttpRouter.route('GET', '/terminal-health', healthResponse),
  HttpRouter.route('GET', '/file-watcher-health', healthResponse),
])

const stopResponse = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const body = yield* request.json.pipe(Effect.orElseSucceed(() => null))
  if (
    typeof body !== 'object' ||
    body === null ||
    (Reflect.get(body, 'mode') !== 'shutdown' &&
      Reflect.get(body, 'mode') !== 'restart')
  ) {
    return yield* HttpServerResponse.json(
      { error: 'Expected shutdown or restart mode' },
      { status: 400 }
    )
  }
  if (Reflect.get(body, 'mode') === 'shutdown') {
    yield* Effect.tryPromise(() => shutdownPtyHost())
  }
  setImmediate(() => process.kill(process.pid, 'SIGTERM'))
  return yield* HttpServerResponse.json({ stopping: true }, { status: 202 })
})

const ControlRoutes = HttpRouter.addAll([
  HttpRouter.route('POST', '/daemon/stop', stopResponse),
])

const webDist = process.env[WEB_DIST_ENV]
const StaticRoutes =
  webDist === undefined
    ? Layer.empty
    : HttpRouter.addAll([
        HttpRouter.route('GET', '*', (request) =>
          staticAssetResponse(webDist, request.url)
        ),
      ])

const registerDaemon = (server: Server): (() => void) => {
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('Daemon did not bind a TCP address')
  }
  const registrationPath = resolveDaemonRegistrationPath()
  const registration: DaemonRegistration = {
    id: randomUUID(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
    url: `http://${DAEMON_HOST}:${String(address.port)}`,
    version: resolveDaemonVersion(fileURLToPath(import.meta.url)),
  }
  writeJsonRegistration(registrationPath, registration)
  const ownership = watchRegistrationOwnership({
    intervalMs: positiveIntegerFromEnv(
      'LABORER_DAEMON_SELF_EVICTION_INTERVAL_MS',
      DAEMON_SELF_EVICTION_INTERVAL_MS_DEFAULT
    ),
    readRegistration: () => readDaemonRegistration(registrationPath),
    isOwner: ({ id }) => id === registration.id,
    onEvicted: () => process.kill(process.pid, 'SIGTERM'),
  })
  return () => {
    ownership.dispose()
    if (readDaemonRegistration(registrationPath)?.id === registration.id) {
      removeRegistration(registrationPath)
    }
  }
}

const makeRegisteredServer = (): Server => {
  const server = createServer()
  let unregister: (() => void) | undefined
  server.once('listening', () => {
    unregister = registerDaemon(server)
  })
  server.once('close', () => unregister?.())
  return server
}

export const makeDaemonServerLayer = (
  port: number,
  options: { readonly register?: boolean } = {}
) =>
  HttpRouter.serve(
    Layer.mergeAll(RpcRoute, HealthRoutes, ControlRoutes, StaticRoutes)
  ).pipe(
    Layer.provide(ApplicationServices),
    Layer.provide(RpcSerialization.layerJson),
    Layer.provide(
      NodeHttpServer.layer(
        options.register === true ? makeRegisteredServer : createServer,
        {
          // A daemon restart must checkpoint native services even while browser
          // WebSockets remain open. Do not hold all layer finalizers behind the
          // HTTP server's default 20-second graceful-close budget.
          gracefulShutdownTimeout: 0,
          host: DAEMON_HOST,
          port,
        }
      )
    )
  )

const port = parsePort(process.env[DAEMON_PORT_ENV])

const isAddressInUse = (error: unknown): boolean => {
  let current: unknown = error
  while (typeof current === 'object' && current !== null) {
    if (Reflect.get(current, 'code') === 'EADDRINUSE') {
      return true
    }
    const next = Reflect.get(current, 'cause')
    if (next === current) {
      break
    }
    current = next
  }
  return false
}

const runDaemon = Layer.launch(
  makeDaemonServerLayer(port, { register: true })
).pipe(
  Effect.scoped,
  Effect.catch((error) =>
    Effect.tryPromise(async () => {
      const incumbent = readDaemonRegistration(resolveDaemonRegistrationPath())
      if (
        isAddressInUse(error) &&
        incumbent !== null &&
        processExists(incumbent.pid)
      ) {
        const healthy = await fetch(`${incumbent.url}/health`, {
          signal: AbortSignal.timeout(5000),
        }).then(
          () => true,
          () => false
        )
        if (healthy) {
          console.error(new EnsureConflictError(incumbent).message)
          return
        }
      }
      throw error
    })
  )
)

if (import.meta.main) {
  NodeRuntime.runMain(runDaemon)
}
