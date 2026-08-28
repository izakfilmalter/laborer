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
import { TerminalManager } from '@laborer/terminal/services/terminal-manager'
import { Effect, Layer, Schema, SubscriptionRef } from 'effect'
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from 'effect/unstable/http'
import { RpcSerialization, RpcServer } from 'effect/unstable/rpc'
import {
  resolveDaemonRegistrationPath,
  resolveDaemonVersion,
} from './daemon-registration.js'
import {
  DaemonWebSocketPolicy,
  isDaemonWebSocketRequestAllowed,
  makeDaemonWebSocketPolicy,
} from './daemon-websocket-auth.js'
import { DEV_INITIAL_PROJECT_PATH_ENV } from './dev-environment.js'
import { makeInfrastructureLayer } from './infrastructure.js'
import { LaborerRpcsLive } from './rpc/handlers.js'
import { SlackDaemonRpcsLive } from './rpc/slack-daemon-handlers.js'
import { DeferredServicesReady } from './services/deferred-service.js'
import { FileWatcherClient } from './services/file-watcher-client.js'
import {
  coalesceWindowMsForProfile,
  PowerProfileService,
  PowerStatePayload,
} from './services/power-profile.js'
import { ProcessInspector } from './services/process-inspector.js'
import { ProcessLauncher } from './services/process-launcher.js'
import { SlackDaemonProcessControl } from './services/slack-daemon-process-control.js'
import { TerminalClient } from './services/terminal-client.js'
import { staticAssetResponse, WEB_DIST_ENV } from './static-assets.js'
import {
  makeWorkspaceAssetServerLayer,
  parseWorkspaceAssetPort,
  WORKSPACE_ASSET_PORT_ENV,
} from './workspace-asset-server.js'

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
  initialProjectPath: process.env[DEV_INITIAL_PROJECT_PATH_ENV],
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

const AuthorizedWebSocketProtocol = Layer.effect(
  RpcServer.Protocol,
  Effect.gen(function* () {
    const { httpEffect, protocol } =
      yield* RpcServer.makeProtocolWithHttpEffectWebsocket
    const router = yield* HttpRouter.HttpRouter
    const policy = yield* DaemonWebSocketPolicy
    yield* router.add(
      'GET',
      '/ws',
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        if (!isDaemonWebSocketRequestAllowed(policy, request.headers.origin)) {
          return HttpServerResponse.text('Forbidden', { status: 403 })
        }
        return yield* httpEffect
      })
    )
    return protocol
  })
)

const RpcRoute = RpcServer.layer(DaemonRpcs).pipe(
  Layer.provide(AuthorizedWebSocketProtocol),
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

/**
 * Power-state signal from the desktop app (Electron `powerMonitor`).
 *
 * The desktop pushes on app start, on every on-ac/on-battery transition,
 * and after every daemon ensure (launch/reconnect/version swap), so a
 * restarted daemon never sits on the default battery-saver profile while
 * the machine is on AC. The coalesce window is pushed to the pty-host on
 * every accepted signal — not only on profile changes — so those
 * re-pushes also refresh a pty-host that restarted since the last change.
 */
const powerStateResponse = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const body = yield* request.json.pipe(Effect.orElseSucceed(() => null))
  const decoded = yield* Schema.decodeUnknownEffect(PowerStatePayload)(
    body
  ).pipe(Effect.result)
  if (decoded._tag === 'Failure') {
    return yield* HttpServerResponse.json(
      { error: 'Expected powerState of ac or battery' },
      { status: 400 }
    )
  }
  const powerProfile = yield* PowerProfileService
  const profile = yield* powerProfile.setPowerState(decoded.success.powerState)
  const terminalManager = yield* TerminalManager
  yield* terminalManager
    .setOutputCoalesceWindowMs(coalesceWindowMsForProfile(profile))
    .pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          `[daemon] Could not push coalesce window to pty-host: ${error.message}`
        )
      )
    )
  return yield* HttpServerResponse.json({ profile })
})

const ControlRoutes = HttpRouter.addAll([
  HttpRouter.route('POST', '/daemon/stop', stopResponse),
  HttpRouter.route('POST', '/daemon/power-state', powerStateResponse),
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
  options: {
    readonly assetPort?: number
    readonly register?: boolean
    readonly vitePort?: string | undefined
  } = {}
) => {
  const DaemonHttpServer = NodeHttpServer.layer(
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
  const WebSocketPolicyLive = Layer.effect(
    DaemonWebSocketPolicy,
    Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer
      if (server.address._tag !== 'TcpAddress') {
        throw new Error('Daemon did not bind a TCP address')
      }
      return makeDaemonWebSocketPolicy(
        `http://${DAEMON_HOST}:${String(server.address.port)}`,
        options.vitePort
      )
    })
  )
  const WorkspaceAssetServerLive = makeWorkspaceAssetServerLayer(
    options.assetPort ?? 0
  ).pipe(Layer.provide(ApplicationServices))

  return HttpRouter.serve(
    Layer.mergeAll(RpcRoute, HealthRoutes, ControlRoutes, StaticRoutes)
  ).pipe(
    Layer.provide(ApplicationServices),
    Layer.provide(RpcSerialization.layerJson),
    Layer.provide(WebSocketPolicyLive),
    Layer.provideMerge(WorkspaceAssetServerLive),
    Layer.provide(DaemonHttpServer)
  )
}

const port = parsePort(process.env[DAEMON_PORT_ENV])
const assetPort = parseWorkspaceAssetPort(process.env[WORKSPACE_ASSET_PORT_ENV])

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
  makeDaemonServerLayer(port, {
    assetPort,
    register: true,
    vitePort: process.env.VITE_PORT,
  })
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
