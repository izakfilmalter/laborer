import { resolve, sep } from 'node:path'
import type { DiscoveredLocalServer } from '@laborer/shared/rpc'
import {
  CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS,
  DiscoveredLocalServer as DiscoveredLocalServerSchema,
  PREVIEW_URL_MAX_LENGTH,
} from '@laborer/shared/rpc'
import {
  Array,
  Cause,
  Clock,
  Context,
  Duration,
  Effect,
  Layer,
  Ref,
  Schedule,
  Schema,
  type Scope,
  Semaphore,
} from 'effect'
import { execFile } from '../lib/spawn.js'

const LOCAL_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '[::1]',
])
const LSOF_LOCAL_HOSTS = new Set([...LOCAL_HOSTS, '*', '[::]', '[::1]'])
const POLL_INTERVAL = Duration.seconds(3)
const WEB_PROBE_CACHE_TTL_MS = Duration.toMillis(Duration.seconds(15))

const ProcessOutput = Schema.Struct({ stdout: Schema.String })

class PreviewDiscoveryProbeError extends Schema.TaggedError<PreviewDiscoveryProbeError>()(
  'PreviewDiscoveryProbeError',
  { cause: Schema.Defect() }
) {}

interface ListenerCandidate {
  readonly host: string
  readonly pid: number
  readonly port: number
  readonly processName: string | null
}

const ListenerCandidateSchema = Schema.Struct({
  host: Schema.String,
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
  port: Schema.Int.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(65_535)
  ),
  processName: Schema.NullOr(Schema.String),
})

const isLoopbackHost = (host: string): boolean => LOCAL_HOSTS.has(host)

const parseConfiguredUrl = (raw: string): URL | null => {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null
    }
    return isLoopbackHost(url.hostname) ? url : null
  } catch {
    return null
  }
}

export const normalizeConfiguredPreviewUrls = (
  urls: readonly string[]
): readonly string[] => {
  const normalized = new Set<string>()
  for (const raw of Array.take(urls, CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS)) {
    if (raw.length > PREVIEW_URL_MAX_LENGTH) {
      continue
    }
    const url = parseConfiguredUrl(raw)
    if (url === null) {
      continue
    }
    if (url.hostname === '0.0.0.0') {
      url.hostname = 'localhost'
    }
    if (url.href.length <= PREVIEW_URL_MAX_LENGTH) {
      normalized.add(url.href)
    }
  }
  return [...normalized]
}

const urlPort = (url: URL): number => {
  if (url.port.length > 0) {
    return Number.parseInt(url.port, 10)
  }
  return url.protocol === 'http:' ? 80 : 443
}

const serverKey = (host: string, port: number): string =>
  `${isLoopbackHost(host) ? 'loopback' : host.toLowerCase()}:${String(port)}`

const parseLsofEndpoint = (value: string): number | null => {
  const endpoint = value.split(' ', 1)[0]?.trim() ?? ''
  const separator = endpoint.lastIndexOf(':')
  if (separator < 0) {
    return null
  }
  const host = endpoint.slice(0, separator)
  const port = Number.parseInt(endpoint.slice(separator + 1), 10)
  if (
    !(LSOF_LOCAL_HOSTS.has(host) && Number.isInteger(port)) ||
    port <= 0 ||
    port > 65_535
  ) {
    return null
  }
  return port
}

export const parsePreviewLsofListeners = (
  raw: string
): readonly ListenerCandidate[] => {
  const listeners = new Map<string, ListenerCandidate>()
  let pid: number | null = null
  let processName: string | null = null

  for (const line of raw.split('\n')) {
    const tag = line.charAt(0)
    const value = line.slice(1)
    if (tag === 'p') {
      const parsed = Number.parseInt(value, 10)
      pid = Number.isInteger(parsed) && parsed > 0 ? parsed : null
      processName = null
      continue
    }
    if (tag === 'c') {
      processName = value.trim() || null
      continue
    }
    if (tag !== 'n' || pid === null) {
      continue
    }
    const port = parseLsofEndpoint(value)
    if (port === null) {
      continue
    }
    const candidate = Schema.decodeUnknownOption(ListenerCandidateSchema)({
      host: 'localhost',
      pid,
      port,
      processName,
    })
    if (candidate._tag === 'Some') {
      listeners.set(
        serverKey(candidate.value.host, candidate.value.port),
        candidate.value
      )
    }
  }
  return [...listeners.values()].toSorted(
    (left, right) => left.port - right.port
  )
}

const runFile = (
  command: string,
  args: readonly string[]
): Effect.Effect<{ readonly stdout: string }, PreviewDiscoveryProbeError> =>
  Effect.callback((resume) => {
    execFile(command, [...args], { timeout: 5000 }, (error, stdout) => {
      if (error !== null) {
        resume(Effect.fail(new PreviewDiscoveryProbeError({ cause: error })))
        return
      }
      Schema.decodeUnknownEffect(ProcessOutput)({ stdout }).pipe(
        Effect.mapError((cause) => new PreviewDiscoveryProbeError({ cause })),
        resume
      )
    })
  })

const processCwd = (pid: number): Effect.Effect<string | null> =>
  runFile('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']).pipe(
    Effect.map(({ stdout }) => {
      for (const line of stdout.split('\n')) {
        if (line.startsWith('n') && line.length > 1) {
          return line.slice(1)
        }
      }
      return null
    }),
    Effect.orElseSucceed(() => null)
  )

const isInsideWorkspace = (cwd: string, workspaceRoot: string): boolean => {
  const root = resolve(workspaceRoot)
  const candidate = resolve(cwd)
  return candidate === root || candidate.startsWith(`${root}${sep}`)
}

export class PreviewDiscoveryPlatform extends Context.Service<
  PreviewDiscoveryPlatform,
  {
    readonly listeners: (
      workspaceRoot: string
    ) => Effect.Effect<readonly ListenerCandidate[]>
    readonly probeWebDocument: (url: string) => Effect.Effect<boolean>
  }
>()('@laborer/server/PreviewDiscoveryPlatform') {
  static readonly live = Layer.succeed(PreviewDiscoveryPlatform, {
    listeners: (workspaceRoot) =>
      runFile('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n', '-F', 'pcn']).pipe(
        Effect.flatMap(({ stdout }) =>
          Effect.filter(
            parsePreviewLsofListeners(stdout),
            (candidate) =>
              processCwd(candidate.pid).pipe(
                Effect.map(
                  (cwd) => cwd !== null && isInsideWorkspace(cwd, workspaceRoot)
                )
              ),
            { concurrency: 16 }
          )
        ),
        // Without a process/cwd signal, returning no automatic candidates is
        // safer than leaking another workspace's listener into this one.
        Effect.orElseSucceed(() => [])
      ),
    probeWebDocument: (url) =>
      Effect.tryPromise({
        try: () =>
          fetch(url, {
            redirect: 'manual',
            signal: AbortSignal.timeout(1000),
          }),
        catch: (cause) => new PreviewDiscoveryProbeError({ cause }),
      }).pipe(
        Effect.map((response) => {
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            return response.headers.get('location')?.trim().length !== 0
          }
          if (
            response.status < 200 ||
            response.status >= 300 ||
            response.status === 204 ||
            response.status === 205
          ) {
            return false
          }
          const contentType = response.headers
            .get('content-type')
            ?.split(';', 1)[0]
            ?.trim()
            .toLowerCase()
          return (
            contentType === 'text/html' ||
            contentType === 'application/xhtml+xml'
          )
        }),
        Effect.orElseSucceed(() => false)
      ),
  })
}

interface ProbeCacheEntry {
  readonly expiresAt: number
  readonly isWeb: boolean
  readonly pid: number | null
}

interface Subscription {
  readonly configuredUrls: readonly string[]
  lastSnapshot: readonly DiscoveredLocalServer[]
  readonly listener: (
    servers: readonly DiscoveredLocalServer[]
  ) => Effect.Effect<void>
  readonly workspaceRoot: string
}

interface DiscoveryState {
  readonly retainCount: number
  readonly subscriptions: ReadonlySet<Subscription>
}

const serversEqual = (
  left: readonly DiscoveredLocalServer[],
  right: readonly DiscoveredLocalServer[]
): boolean => JSON.stringify(left) === JSON.stringify(right)

export class PreviewPortDiscovery extends Context.Service<
  PreviewPortDiscovery,
  {
    readonly retain: Effect.Effect<void, never, Scope.Scope>
    readonly scan: (
      workspaceRoot: string,
      configuredUrls?: readonly string[]
    ) => Effect.Effect<readonly DiscoveredLocalServer[]>
    readonly subscribe: (
      input: {
        readonly configuredUrls: readonly string[]
        readonly initialSnapshot: readonly DiscoveredLocalServer[]
        readonly workspaceRoot: string
      },
      listener: (
        servers: readonly DiscoveredLocalServer[]
      ) => Effect.Effect<void>
    ) => Effect.Effect<void, never, Scope.Scope>
  }
>()('@laborer/server/PreviewPortDiscovery') {
  static readonly layer = Layer.effect(
    PreviewPortDiscovery,
    Effect.gen(function* () {
      const platform = yield* PreviewDiscoveryPlatform
      const stateRef = yield* Ref.make<DiscoveryState>({
        retainCount: 0,
        subscriptions: new Set(),
      })
      const cacheRef = yield* Ref.make<ReadonlyMap<string, ProbeCacheEntry>>(
        new Map()
      )
      const scanSemaphore = yield* Semaphore.make(1)

      const probe = Effect.fn('PreviewPortDiscovery.probe')(function* (
        rawUrl: string,
        pid: number | null
      ) {
        const cacheKeyUrl = new URL(rawUrl)
        cacheKeyUrl.hash = ''
        const key = cacheKeyUrl.href
        const now = yield* Clock.currentTimeMillis
        const cached = (yield* Ref.get(cacheRef)).get(key)
        if (
          cached !== undefined &&
          cached.pid === pid &&
          cached.expiresAt > now
        ) {
          return cached.isWeb
        }
        const isWeb = yield* platform.probeWebDocument(rawUrl)
        const completedAt = yield* Clock.currentTimeMillis
        yield* Ref.update(cacheRef, (current) => {
          const next = new Map(current)
          next.set(key, {
            expiresAt: completedAt + WEB_PROBE_CACHE_TTL_MS,
            isWeb,
            pid,
          })
          return next
        })
        return isWeb
      })

      const scanUnlocked = Effect.fn('PreviewPortDiscovery.scanUnlocked')(
        function* (workspaceRoot: string, configuredInput: readonly string[]) {
          const configuredUrls = normalizeConfiguredPreviewUrls(configuredInput)
          const listeners = yield* platform.listeners(workspaceRoot)
          const visible = new Map<string, DiscoveredLocalServer>()

          for (const raw of configuredUrls) {
            const url = new URL(raw)
            if (!(yield* probe(raw, null))) {
              continue
            }
            const server = Schema.decodeUnknownOption(
              DiscoveredLocalServerSchema
            )({
              host: url.hostname,
              pid: null,
              port: urlPort(url),
              processName: null,
              terminal: null,
              url: raw,
            })
            if (server._tag === 'Some') {
              visible.set(
                serverKey(server.value.host, server.value.port),
                server.value
              )
            }
          }

          const discoverListener = Effect.fn(
            'PreviewPortDiscovery.discoverListener'
          )(function* (listener: ListenerCandidate) {
            const urls = [
              `http://localhost:${String(listener.port)}`,
              `https://localhost:${String(listener.port)}`,
            ]
            let selected: string | null = null
            for (const url of urls) {
              if (yield* probe(url, listener.pid)) {
                selected = url
                break
              }
            }
            if (selected === null) {
              return
            }
            const server = Schema.decodeUnknownOption(
              DiscoveredLocalServerSchema
            )({
              host: 'localhost',
              pid: listener.pid,
              port: listener.port,
              processName: listener.processName,
              terminal: null,
              url: selected,
            })
            if (server._tag === 'Some') {
              const key = serverKey(server.value.host, server.value.port)
              if (!visible.has(key)) {
                visible.set(key, server.value)
              }
            }
          })

          yield* Effect.forEach(listeners, discoverListener, {
            concurrency: 16,
            discard: true,
          })
          return [...visible.values()].toSorted(
            (left, right) => left.port - right.port
          )
        }
      )

      const scan = (
        workspaceRoot: string,
        configuredUrls: readonly string[] = []
      ) =>
        scanSemaphore.withPermits(1)(
          scanUnlocked(workspaceRoot, configuredUrls)
        )

      const poll = Effect.fn('PreviewPortDiscovery.poll')(
        function* () {
          const state = yield* Ref.get(stateRef)
          if (state.retainCount === 0) {
            return
          }
          yield* Effect.forEach(
            state.subscriptions,
            (subscription) =>
              Effect.gen(function* () {
                const next = yield* scan(
                  subscription.workspaceRoot,
                  subscription.configuredUrls
                )
                if (!serversEqual(subscription.lastSnapshot, next)) {
                  yield* subscription.listener(next)
                  yield* Effect.sync(() => {
                    subscription.lastSnapshot = next
                  })
                }
              }),
            { discard: true }
          )
        },
        Effect.catchCause((cause: Cause.Cause<never>) =>
          Effect.logWarning('preview port scan failed', Cause.pretty(cause))
        )
      )

      yield* poll().pipe(
        Effect.repeat(Schedule.spaced(POLL_INTERVAL)),
        Effect.forkScoped
      )

      const retain = Effect.acquireRelease(
        Effect.gen(function* () {
          const wasIdle = yield* Ref.modify(stateRef, (state) => [
            state.retainCount === 0,
            { ...state, retainCount: state.retainCount + 1 },
          ])
          if (wasIdle) {
            yield* poll()
          }
        }),
        () =>
          Ref.update(stateRef, (state) => ({
            ...state,
            retainCount: Math.max(0, state.retainCount - 1),
          }))
      )

      const subscribe: PreviewPortDiscovery['Service']['subscribe'] = (
        input,
        listener
      ) => {
        const subscription: Subscription = {
          configuredUrls: normalizeConfiguredPreviewUrls(input.configuredUrls),
          lastSnapshot: input.initialSnapshot,
          listener,
          workspaceRoot: input.workspaceRoot,
        }
        return Effect.acquireRelease(
          Ref.update(stateRef, (state) => ({
            ...state,
            subscriptions: new Set(state.subscriptions).add(subscription),
          })),
          () =>
            Ref.update(stateRef, (state) => {
              const subscriptions = new Set(state.subscriptions)
              subscriptions.delete(subscription)
              return { ...state, subscriptions }
            })
        )
      }

      return PreviewPortDiscovery.of({ retain, scan, subscribe })
    })
  )

  static readonly live = PreviewPortDiscovery.layer.pipe(
    Layer.provide(PreviewDiscoveryPlatform.live)
  )
}
