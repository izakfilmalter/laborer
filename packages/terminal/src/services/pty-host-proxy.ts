import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ensure,
  type PtyHostRegistration,
  readPtyHostRegistration,
  stopWithEscalation,
} from '@laborer/ensure'
import {
  type ProcessTimeTimeout,
  scheduleProcessTimeTimeout,
} from '@laborer/shared/process-time-scheduler'
import {
  type TerminalAttachEvent,
  type TerminalHostStatus,
  TerminalRpcError,
} from '@laborer/shared/rpc'
import { Effect, Layer, PubSub } from 'effect'
import { resolvePtyHostPaths, resolvePtyHostVersion } from './pty-host-paths.js'
import type {
  PtyHostClientMessage,
  PtyHostMethod,
  PtyHostServerMessage,
} from './pty-host-protocol.js'
import {
  type TerminalLifecycleEvent,
  TerminalManager,
} from './terminal-manager.js'

interface PendingRequest {
  readonly reject: (error: Error) => void
  readonly resolve: (value: unknown) => void
  readonly timeout: ReturnType<typeof setTimeout>
}

interface AttachRecord {
  cursor?: number
  epoch?: string
  hostSubscriberId?: string
  readonly leaseId: string
  readonly localId: string
  readonly subscriber: (event: TerminalAttachEvent) => boolean
  readonly terminalId: string
}

/** Named, configurable defaults from the browser-first mission-control spec. */
export const PTY_HOST_HEARTBEAT_INTERVAL_MS_DEFAULT = 5000
export const PTY_HOST_HEARTBEAT_WARN_MS_DEFAULT = 6000
export const PTY_HOST_HEARTBEAT_UNRESPONSIVE_MS_DEFAULT = 15_000
export const PTY_HOST_MAX_RESTARTS_DEFAULT = 5
/**
 * Control-plane calls (liveness and shutdown) must fail fast: they exist to
 * decide whether the host is answering at all.
 */
export const PTY_HOST_CONTROL_TIMEOUT_MS_DEFAULT = 5000
/**
 * Data-plane calls are patient. A busy-but-healthy host queues them behind bulk
 * terminal output on the same socket and behind its serialized request lane, so
 * a short deadline turns load into a false pane disconnect. Slowness is
 * surfaced by the advisory heartbeat instead (ADR 0003).
 */
export const PTY_HOST_REQUEST_TIMEOUT_MS_DEFAULT = 30_000

const MAX_PROTOCOL_FRAME_BYTES = 1024 * 1024
let explicitHostShutdown = false

const positiveIntegerFromEnv = (name: string, fallback: number): number => {
  const parsed = Number(process.env[name])
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

const heartbeatIntervalMs = positiveIntegerFromEnv(
  'LABORER_PTY_HOST_HEARTBEAT_INTERVAL_MS',
  PTY_HOST_HEARTBEAT_INTERVAL_MS_DEFAULT
)
const heartbeatWarnMs = positiveIntegerFromEnv(
  'LABORER_PTY_HOST_HEARTBEAT_WARN_MS',
  PTY_HOST_HEARTBEAT_WARN_MS_DEFAULT
)
const heartbeatUnresponsiveMs = positiveIntegerFromEnv(
  'LABORER_PTY_HOST_HEARTBEAT_UNRESPONSIVE_MS',
  PTY_HOST_HEARTBEAT_UNRESPONSIVE_MS_DEFAULT
)
const maxRestarts = positiveIntegerFromEnv(
  'LABORER_PTY_HOST_MAX_RESTARTS',
  PTY_HOST_MAX_RESTARTS_DEFAULT
)
const controlTimeoutMs = positiveIntegerFromEnv(
  'LABORER_PTY_HOST_CONTROL_TIMEOUT_MS',
  PTY_HOST_CONTROL_TIMEOUT_MS_DEFAULT
)
const dataTimeoutMs = positiveIntegerFromEnv(
  'LABORER_PTY_HOST_REQUEST_TIMEOUT_MS',
  PTY_HOST_REQUEST_TIMEOUT_MS_DEFAULT
)

export type PtyHostRequestClass = 'control' | 'data'

const CONTROL_PLANE_METHODS: ReadonlySet<PtyHostMethod> = new Set([
  'health',
  'shutdown',
  'shutdownIfEmpty',
])

/** Liveness and shutdown are control plane; every terminal operation is data. */
export const ptyHostRequestClass = (
  method: PtyHostMethod
): PtyHostRequestClass =>
  CONTROL_PLANE_METHODS.has(method) ? 'control' : 'data'

export const ptyHostRequestTimeoutMs = (method: PtyHostMethod): number =>
  ptyHostRequestClass(method) === 'control' ? controlTimeoutMs : dataTimeoutMs

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const delay = (milliseconds: number) =>
  new Promise<void>((resume) => setTimeout(resume, milliseconds))

const openSocket = (socketPath: string): Promise<Socket> =>
  new Promise((resolveSocket, reject) => {
    const socket = connect(socketPath)
    socket.once('connect', () => resolveSocket(socket))
    socket.once('error', reject)
  })

interface PtyHostHealth {
  readonly epoch: string
  readonly execPath?: string
  readonly version: string
}

export const shouldReplaceDevHostRuntime = ({
  devWatch,
  expectedExecPath,
  hostExecPath,
}: {
  readonly devWatch: boolean
  readonly expectedExecPath: string
  readonly hostExecPath?: string | undefined
}): boolean => devWatch && hostExecPath !== expectedExecPath

const readHostHealth = async (
  registration: PtyHostRegistration
): Promise<PtyHostHealth | undefined> => {
  let socket: Socket | undefined
  try {
    socket = await openSocket(registration.socketPath)
    const activeSocket = socket
    return await new Promise<PtyHostHealth | undefined>((resolveHealth) => {
      const timeout = setTimeout(() => {
        activeSocket.destroy()
        resolveHealth(undefined)
      }, controlTimeoutMs)
      let buffer = ''
      activeSocket.setEncoding('utf8')
      activeSocket.on('data', (chunk: string) => {
        buffer += chunk
        if (Buffer.byteLength(buffer, 'utf8') > MAX_PROTOCOL_FRAME_BYTES) {
          clearTimeout(timeout)
          activeSocket.destroy()
          resolveHealth(undefined)
          return
        }
        const newline = buffer.indexOf('\n')
        if (newline < 0) {
          return
        }
        clearTimeout(timeout)
        try {
          const response = JSON.parse(buffer.slice(0, newline)) as {
            readonly result?: PtyHostHealth
          }
          const result = response.result
          resolveHealth(
            result?.epoch === registration.epoch &&
              result.version === registration.version
              ? result
              : undefined
          )
        } catch {
          resolveHealth(undefined)
        } finally {
          activeSocket.destroy()
        }
      })
      activeSocket.write(
        `${JSON.stringify({ type: 'request', requestId: 'health', method: 'health', args: [] })}\n`
      )
    })
  } catch {
    socket?.destroy()
    return undefined
  }
}

const probeHealth = async (
  registration: PtyHostRegistration
): Promise<boolean> => (await readHostHealth(registration)) !== undefined

const requestHostShutdown = async (
  registration: PtyHostRegistration
): Promise<void> => {
  const socket = await openSocket(registration.socketPath)
  await new Promise<void>((resolveShutdown, reject) => {
    const timeout = setTimeout(() => {
      socket.destroy()
      reject(new Error('Timed out waiting for PTY host shutdown response'))
    }, controlTimeoutMs)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.includes('\n')) {
        clearTimeout(timeout)
        socket.destroy()
        resolveShutdown()
      }
    })
    socket.write(
      `${JSON.stringify({ type: 'request', requestId: 'shutdown', method: 'shutdown', args: [] })}\n`
    )
  })
}

const requestHostShutdownIfEmpty = async (
  registration: PtyHostRegistration
): Promise<boolean> => {
  const socket = await openSocket(registration.socketPath)
  return await new Promise<boolean>((resolveShutdown, reject) => {
    const finish = (result: boolean | Error): void => {
      clearTimeout(timeout)
      socket.destroy()
      if (result instanceof Error) {
        reject(result)
      } else {
        resolveShutdown(result)
      }
    }
    const timeout = setTimeout(
      () =>
        finish(new Error('Timed out waiting for PTY host shutdown response')),
      controlTimeoutMs
    )
    let buffer = ''
    socket.setEncoding('utf8')
    socket.once('error', finish)
    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (Buffer.byteLength(buffer, 'utf8') > MAX_PROTOCOL_FRAME_BYTES) {
        finish(new Error('PTY host protocol frame exceeded limit'))
        return
      }
      const newline = buffer.indexOf('\n')
      if (newline < 0) {
        return
      }
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as {
          readonly error?: { readonly message?: string }
          readonly requestId?: string
          readonly result?: unknown
          readonly type?: string
        }
        if (
          response.type !== 'response' ||
          response.requestId !== 'shutdown-if-empty' ||
          response.error !== undefined ||
          typeof response.result !== 'boolean'
        ) {
          finish(
            new Error(
              response.error?.message ??
                'PTY host does not support conditional shutdown'
            )
          )
          return
        }
        finish(response.result)
      } catch {
        finish(new Error('PTY host sent an invalid shutdown response'))
      }
    })
    socket.write(
      `${JSON.stringify({ type: 'request', requestId: 'shutdown-if-empty', method: 'shutdownIfEmpty', args: [] })}\n`
    )
  })
}

/** Explicit daemon shutdown remains available and unconditional. */
export const shutdownPtyHost = async (): Promise<void> => {
  // Disable the proxy's crash-recovery path before asking the host to exit.
  // Otherwise the connection close can race daemon teardown and immediately
  // respawn the host that an explicit app quit just stopped.
  explicitHostShutdown = true
  const registration = readPtyHostRegistration(
    resolvePtyHostPaths().registrationPath
  )
  if (registration === null) {
    return
  }
  await stopWithEscalation(registration, { requestStop: requestHostShutdown })
}

const resolveHostEntry = (): string => {
  const configured = process.env.LABORER_PTY_HOST_ENTRY?.trim()
  if (configured) {
    return resolve(configured)
  }
  const moduleDirectory = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    resolve(moduleDirectory, '../../terminal/dist/pty-host-main.mjs'),
    resolve(moduleDirectory, '../../terminal/dist/pty-host-main.js'),
    resolve(process.cwd(), 'packages/terminal/dist/pty-host-main.mjs'),
    resolve(process.cwd(), 'packages/terminal/dist/pty-host-main.js'),
    resolve(process.cwd(), '../terminal/dist/pty-host-main.mjs'),
    resolve(process.cwd(), '../terminal/dist/pty-host-main.js'),
    resolve(process.cwd(), 'packages/terminal/src/pty-host-main.ts'),
    resolve(process.cwd(), '../terminal/src/pty-host-main.ts'),
  ]
  const entry = candidates.find(existsSync)
  if (entry === undefined) {
    throw new Error('Could not locate the pty-host entry point')
  }
  return entry
}

const spawnPtyHost = (): number | undefined => {
  const child = spawn(process.execPath, [resolveHostEntry()], {
    detached: true,
    env: { ...process.env },
    stdio: 'ignore',
  })
  child.unref()
  return child.pid
}

/** Adopt a live host even when outdated so the user, not a watcher, decides when it dies. */
const ensurePtyHost = async (
  expectedVersion: string
): Promise<PtyHostRegistration> => {
  const paths = resolvePtyHostPaths()
  const incumbent = readPtyHostRegistration(paths.registrationPath)
  if (incumbent !== null && processExists(incumbent.pid)) {
    const health = await readHostHealth(incumbent)
    if (health !== undefined) {
      const staleDevRuntime = shouldReplaceDevHostRuntime({
        devWatch: process.env.LABORER_DEV_WATCH === '1',
        expectedExecPath: process.execPath,
        hostExecPath: health.execPath,
      })
      if (!staleDevRuntime) {
        return incumbent
      }
      const shutdownAccepted = await requestHostShutdownIfEmpty(
        incumbent
      ).catch(() => false)
      if (!shutdownAccepted) {
        return incumbent
      }
      console.info(
        `[pty-host] Replacing development host runtime ${health.execPath ?? 'unknown'} with ${process.execPath}`
      )
      await stopWithEscalation(incumbent, {
        requestStop: async () => undefined,
      })
    }
  }
  return ensure({
    policy: 'adopt',
    readRegistration: () => {
      const registration = readPtyHostRegistration(paths.registrationPath)
      return registration !== null && registration.version === expectedVersion
        ? registration
        : null
    },
    health: probeHealth,
    spawn: spawnPtyHost,
  })
}

const statusFor = (
  registration: PtyHostRegistration,
  expectedVersion: string
): TerminalHostStatus => ({
  expectedVersion,
  runningVersion: registration.version,
  state: registration.version === expectedVersion ? 'healthy' : 'outdated',
})

/** Daemon-side PtyHostService: adoption-first and terminal-data-stateless. */
export const ptyHostProxyLayer = Layer.effect(
  TerminalManager,
  Effect.acquireRelease(
    Effect.tryPromise(async () => {
      const lifecycleEvents = Effect.runSync(
        PubSub.unbounded<TerminalLifecycleEvent>()
      )
      const pending = new Map<string, PendingRequest>()
      const attachments = new Map<string, AttachRecord>()
      const expectedVersion = resolvePtyHostVersion(resolveHostEntry())
      let registration = await ensurePtyHost(expectedVersion)
      let hostStatus: TerminalHostStatus = statusFor(
        registration,
        expectedVersion
      )
      let socket: Socket | undefined
      let heartbeatInterval: ReturnType<typeof setInterval> | undefined
      let heartbeatWarnTimer: ProcessTimeTimeout | undefined
      let heartbeatUnresponsiveTimer: ProcessTimeTimeout | undefined
      let recoveryPromise: Promise<void> | undefined
      let disposed = false
      /**
       * Last runtime coalesce window pushed through this proxy. A freshly
       * respawned host starts from its env/default window, so recovery
       * re-pushes the daemon's power-profile choice after reattaching.
       */
      let lastCoalesceWindowMs: number | undefined

      const cancelHeartbeatTimers = (): void => {
        heartbeatWarnTimer?.cancel()
        heartbeatUnresponsiveTimer?.cancel()
        heartbeatWarnTimer = undefined
        heartbeatUnresponsiveTimer = undefined
      }

      const rejectPending = (message: string): void => {
        for (const waiter of pending.values()) {
          clearTimeout(waiter.timeout)
          waiter.reject(new Error(message))
        }
        pending.clear()
      }

      const request = <A>(
        method: PtyHostMethod,
        args: readonly unknown[]
      ): Promise<A> =>
        new Promise<A>((resolveRequest, reject) => {
          const activeSocket = socket
          if (activeSocket === undefined || !activeSocket.writable) {
            reject(new Error('PTY host connection is unavailable'))
            return
          }
          const requestId = randomUUID()
          const timeout = setTimeout(() => {
            const waiter = pending.get(requestId)
            if (waiter === undefined) {
              return
            }
            pending.delete(requestId)
            waiter.reject(
              new Error(`PTY host request timed out: ${String(method)}`)
            )
          }, ptyHostRequestTimeoutMs(method))
          pending.set(requestId, {
            resolve: resolveRequest as (value: unknown) => void,
            reject,
            timeout,
          })
          const message: PtyHostClientMessage = {
            type: 'request',
            requestId,
            method,
            args,
          }
          activeSocket.write(`${JSON.stringify(message)}\n`)
        })

      const armHeartbeatTimers = (): void => {
        cancelHeartbeatTimers()
        heartbeatWarnTimer = scheduleProcessTimeTimeout(
          () => {
            if (hostStatus.state === 'healthy') {
              hostStatus = { ...hostStatus, state: 'warning' }
            }
          },
          heartbeatWarnMs,
          { unref: true }
        )
        heartbeatUnresponsiveTimer = scheduleProcessTimeTimeout(
          () => {
            if (
              hostStatus.state !== 'outdated' &&
              hostStatus.state !== 'restarting'
            ) {
              // Advisory only (ADR 0003): do not close or kill the host.
              hostStatus = { ...hostStatus, state: 'unresponsive' }
            }
          },
          heartbeatUnresponsiveMs,
          { unref: true }
        )
      }

      const markHeartbeat = (result: {
        readonly epoch: string
        readonly version: string
      }): void => {
        if (result.epoch !== registration.epoch) {
          return
        }
        hostStatus = statusFor(
          { ...registration, version: result.version },
          expectedVersion
        )
        armHeartbeatTimers()
      }

      const handleMessage = (message: PtyHostServerMessage): void => {
        if (message.type === 'response') {
          const waiter = pending.get(message.requestId)
          if (waiter === undefined) {
            return
          }
          pending.delete(message.requestId)
          clearTimeout(waiter.timeout)
          if (message.error !== undefined) {
            waiter.reject(
              new TerminalRpcError({
                code: message.error.code ?? 'PTY_HOST_ERROR',
                message: message.error.message,
              })
            )
          } else {
            waiter.resolve(message.result)
          }
          return
        }
        if (message.type === 'attach-event') {
          attachments.get(message.subscriberId)?.subscriber(message.event)
          return
        }
        PubSub.publishUnsafe(lifecycleEvents, message.event)
      }

      const attachSocket = async (nextRegistration: PtyHostRegistration) => {
        const nextSocket = await openSocket(nextRegistration.socketPath)
        let buffer = ''
        socket = nextSocket
        registration = nextRegistration
        nextSocket.setEncoding('utf8')
        nextSocket.on('data', (chunk: string) => {
          buffer += chunk
          while (true) {
            const newline = buffer.indexOf('\n')
            if (newline < 0) {
              break
            }
            const line = buffer.slice(0, newline)
            buffer = buffer.slice(newline + 1)
            if (line === '') {
              continue
            }
            try {
              handleMessage(JSON.parse(line) as PtyHostServerMessage)
            } catch {
              nextSocket.destroy(new Error('PTY host sent invalid JSON'))
              return
            }
          }
          if (Buffer.byteLength(buffer, 'utf8') > MAX_PROTOCOL_FRAME_BYTES) {
            nextSocket.destroy(
              new Error('PTY host protocol frame exceeded limit')
            )
          }
        })
        nextSocket.on('error', () => undefined)
        nextSocket.on('close', () => {
          if (socket !== nextSocket) {
            return
          }
          socket = undefined
          cancelHeartbeatTimers()
          rejectPending('PTY host connection closed')
          if (!(disposed || recoveryPromise || explicitHostShutdown)) {
            recover(false).catch(() => undefined)
          }
        })
        await request('listTerminals', [])
        hostStatus = statusFor(registration, expectedVersion)
        armHeartbeatTimers()
      }

      const reattach = async (): Promise<void> => {
        for (const record of attachments.values()) {
          try {
            const result = await request<{ readonly subscriberId: string }>(
              'attach',
              [
                record.terminalId,
                {
                  leaseId: record.leaseId,
                  ...(record.cursor === undefined
                    ? {}
                    : { cursor: record.cursor }),
                  ...(record.epoch === undefined
                    ? {}
                    : { epoch: record.epoch }),
                },
                record.localId,
              ]
            )
            record.hostSubscriberId = result.subscriberId
            record.epoch = registration.epoch
          } catch {
            // Never disguise a host epoch change as a seamless gap, even when
            // a particular terminal could not be revived from its checkpoint.
            record.subscriber({
              _tag: 'Reset',
              epoch: registration.epoch,
              reason: 'epoch_changed',
            })
          }
        }
      }

      const waitForExit = async (pid: number): Promise<void> => {
        const deadline = Date.now() + controlTimeoutMs
        while (processExists(pid) && Date.now() < deadline) {
          await delay(25)
        }
        if (processExists(pid)) {
          // This path is reachable only after an explicit operator action.
          process.kill(pid, 'SIGTERM')
          const escalationDeadline = Date.now() + controlTimeoutMs
          while (processExists(pid) && Date.now() < escalationDeadline) {
            await delay(25)
          }
        }
        if (processExists(pid)) {
          process.kill(pid, 'SIGKILL')
        }
      }

      function recover(manual: boolean): Promise<void> {
        if (recoveryPromise !== undefined) {
          return recoveryPromise
        }
        const run = async () => {
          hostStatus = {
            expectedVersion,
            runningVersion: registration.version,
            state: 'restarting',
          }
          cancelHeartbeatTimers()
          if (manual) {
            const previousPid = registration.pid
            await request('shutdown', []).catch(() => undefined)
            await waitForExit(previousPid)
          }
          const previousSocket = socket
          socket = undefined
          previousSocket?.destroy()
          rejectPending('PTY host is restarting')

          let lastError: unknown
          for (let attempt = 0; attempt < maxRestarts; attempt += 1) {
            try {
              const ensured = await ensurePtyHost(expectedVersion)
              await attachSocket(ensured)
              await reattach()
              if (lastCoalesceWindowMs !== undefined) {
                await request('setOutputCoalesceWindow', [
                  lastCoalesceWindowMs,
                ]).catch(() => undefined)
              }
              return
            } catch (error) {
              lastError = error
              if (attempt + 1 < maxRestarts) {
                await delay(Math.min(500 * 2 ** attempt, 10_000))
              }
            }
          }
          hostStatus = {
            expectedVersion,
            runningVersion: registration.version,
            state: 'unavailable',
          }
          throw lastError
        }
        recoveryPromise = run().finally(() => {
          recoveryPromise = undefined
        })
        return recoveryPromise
      }

      await attachSocket(registration)
      heartbeatInterval = setInterval(() => {
        if (socket === undefined || recoveryPromise !== undefined) {
          return
        }
        request<{ readonly epoch: string; readonly version: string }>(
          'health',
          []
        )
          .then(markHeartbeat)
          .catch(() => undefined)
      }, heartbeatIntervalMs)
      ;(heartbeatInterval as unknown as { unref?: () => void }).unref?.()

      const remote = <A>(method: PtyHostMethod, args: readonly unknown[]) =>
        Effect.tryPromise({
          try: () => request<A>(method, args),
          catch: (error) =>
            error instanceof TerminalRpcError
              ? error
              : new TerminalRpcError({
                  code: 'PTY_HOST_UNAVAILABLE',
                  message:
                    error instanceof Error ? error.message : String(error),
                }),
        })

      const service = TerminalManager.of({
        spawn: (payload) => remote('spawn', [payload]),
        write: (id, data) => remote('write', [id, data]),
        attach: (id, options, subscriber) =>
          Effect.gen(function* () {
            const localId = randomUUID()
            const leaseId = options.leaseId ?? localId
            const record: AttachRecord = {
              ...(options.cursor === undefined
                ? {}
                : { cursor: options.cursor }),
              ...(options.epoch === undefined ? {} : { epoch: options.epoch }),
              leaseId,
              localId,
              subscriber,
              terminalId: id,
            }
            attachments.set(localId, record)
            const result = yield* remote<{ readonly subscriberId: string }>(
              'attach',
              [id, { ...options, leaseId }, localId]
            ).pipe(
              Effect.tapError(() =>
                Effect.sync(() => attachments.delete(localId))
              )
            )
            record.hostSubscriberId = result.subscriberId
            record.epoch = registration.epoch
            return { subscriberId: localId }
          }),
        acknowledge: (id, leaseId, cursor) => {
          for (const record of attachments.values()) {
            if (record.terminalId === id && record.leaseId === leaseId) {
              record.cursor = cursor
            }
          }
          return remote('acknowledge', [id, leaseId, cursor])
        },
        transportMetrics: (id) => remote('transportMetrics', [id]),
        hostStatus: () => Effect.succeed(hostStatus),
        restartHost: () =>
          Effect.tryPromise({
            try: async () => {
              await recover(true)
              return hostStatus
            },
            catch: (error) =>
              new TerminalRpcError({
                code: 'PTY_HOST_RESTART_FAILED',
                message: error instanceof Error ? error.message : String(error),
              }),
          }),
        resize: (id, cols, rows) => remote('resize', [id, cols, rows]),
        kill: (id) => remote('kill', [id]),
        listTerminals: (workspaceId) =>
          remote(
            'listTerminals',
            workspaceId === undefined ? [] : [workspaceId]
          ),
        remove: (id) => remote('remove', [id]),
        restart: (id) => remote('restart', [id]),
        killAllForWorkspace: (workspaceId) =>
          remote<number>('killAllForWorkspace', [workspaceId]).pipe(
            Effect.orElseSucceed(() => 0)
          ),
        getScreenState: () => '',
        getCommandDetectionState: () => undefined,
        unsubscribe: (id, localId) =>
          Effect.gen(function* () {
            const record = attachments.get(localId)
            attachments.delete(localId)
            if (record?.hostSubscriberId !== undefined) {
              yield* remote('unsubscribe', [id, record.hostSubscriberId]).pipe(
                Effect.orElseSucceed(() => undefined)
              )
            }
          }),
        forceRedraw: (id) => remote('terminalExists', [id]).pipe(Effect.asVoid),
        terminalExists: (id) =>
          remote<boolean>('terminalExists', [id]).pipe(
            Effect.orElseSucceed(() => false)
          ),
        setAgentStatusFromHook: (id, report) =>
          remote('setAgentStatusFromHook', [id, report]),
        setObservedWorkspaces: (workspaceIds) =>
          remote('setObservedWorkspaces', [[...workspaceIds]]).pipe(
            Effect.orElseSucceed(() => undefined)
          ),
        setOutputCoalesceWindowMs: (windowMs) =>
          Effect.suspend(() => {
            lastCoalesceWindowMs = windowMs
            return remote<void>('setOutputCoalesceWindow', [windowMs])
          }),
        reportWorkspacePresence: (clientId, sequence, workspaceIds) =>
          remote('reportWorkspacePresence', [
            clientId,
            sequence,
            [...workspaceIds],
          ]).pipe(Effect.orElseSucceed(() => undefined)),
        getTerminals: () => Effect.succeed([]),
        setRevivedReplayEvent: () => Effect.void,
        takeRevivedReplayEvent: () => Effect.sync(() => undefined),
        lifecycleEvents,
      })
      return {
        dispose: () => {
          disposed = true
          cancelHeartbeatTimers()
          if (heartbeatInterval !== undefined) {
            clearInterval(heartbeatInterval)
          }
          socket?.destroy()
          rejectPending('PTY host proxy disposed')
        },
        service,
      }
    }),
    ({ dispose }) => Effect.sync(dispose)
  ).pipe(Effect.map(({ service }) => service))
)
