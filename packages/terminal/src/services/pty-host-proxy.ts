import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ensure,
  type ProcessRegistration,
  readJsonRegistration,
} from '@laborer/ensure'
import { type TerminalAttachEvent, TerminalRpcError } from '@laborer/shared/rpc'
import { Effect, Layer, PubSub } from 'effect'
import {
  PTY_HOST_PROTOCOL_VERSION,
  resolvePtyHostPaths,
} from './pty-host-paths.js'
import type {
  PtyHostClientMessage,
  PtyHostMethod,
  PtyHostServerMessage,
} from './pty-host-protocol.js'
import {
  type TerminalLifecycleEvent,
  TerminalManager,
} from './terminal-manager.js'

interface PtyHostRegistration extends ProcessRegistration {
  readonly epoch: string
  readonly socketPath: string
}

const HEALTH_TIMEOUT_MS = 500
const REQUEST_TIMEOUT_MS = 5000
const MAX_PROTOCOL_FRAME_BYTES = 1024 * 1024

const isRegistration = (
  value: ProcessRegistration | null
): value is PtyHostRegistration =>
  value !== null &&
  Number.isInteger(value.pid) &&
  value.pid > 0 &&
  typeof value.epoch === 'string' &&
  typeof value.socketPath === 'string' &&
  typeof value.startedAt === 'string'

const openSocket = (socketPath: string): Promise<Socket> =>
  new Promise((resolveSocket, reject) => {
    const socket = connect(socketPath)
    socket.once('connect', () => resolveSocket(socket))
    socket.once('error', reject)
  })

const health = async (registration: PtyHostRegistration): Promise<boolean> => {
  try {
    const socket = await openSocket(registration.socketPath)
    const healthy = await new Promise<boolean>((resolveHealth) => {
      const timeout = setTimeout(() => {
        socket.destroy()
        resolveHealth(false)
      }, HEALTH_TIMEOUT_MS)
      let buffer = ''
      socket.setEncoding('utf8')
      socket.on('data', (chunk: string) => {
        buffer += chunk
        if (Buffer.byteLength(buffer, 'utf8') > MAX_PROTOCOL_FRAME_BYTES) {
          clearTimeout(timeout)
          socket.destroy()
          resolveHealth(false)
          return
        }
        const newline = buffer.indexOf('\n')
        if (newline < 0) {
          return
        }
        clearTimeout(timeout)
        try {
          const response = JSON.parse(buffer.slice(0, newline)) as {
            readonly result?: {
              readonly epoch?: string
              readonly version?: string
            }
          }
          socket.destroy()
          resolveHealth(
            response.result?.epoch === registration.epoch &&
              response.result.version === registration.version
          )
        } catch {
          socket.destroy()
          resolveHealth(false)
        }
      })
      socket.write(
        `${JSON.stringify({ type: 'request', requestId: 'health', method: 'health', args: [] })}\n`
      )
    })
    return healthy
  } catch {
    return false
  }
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

const ensurePtyHost = async (): Promise<PtyHostRegistration> => {
  const paths = resolvePtyHostPaths()
  const incumbent = readJsonRegistration<ProcessRegistration>(
    paths.registrationPath
  )
  if (
    isRegistration(incumbent) &&
    (await health(incumbent)) &&
    incumbent.version !== PTY_HOST_PROTOCOL_VERSION
  ) {
    throw new Error(
      `Terminal host outdated (running ${incumbent.version}, expected ${PTY_HOST_PROTOCOL_VERSION}); restart it explicitly`
    )
  }
  return ensure({
    policy: 'adopt',
    readRegistration: () => {
      const registration = readJsonRegistration<ProcessRegistration>(
        paths.registrationPath
      )
      return isRegistration(registration) &&
        registration.version === PTY_HOST_PROTOCOL_VERSION
        ? registration
        : null
    },
    health,
    spawn: () => {
      const child = spawn(process.execPath, [resolveHostEntry()], {
        detached: true,
        env: { ...process.env },
        stdio: 'ignore',
      })
      child.unref()
    },
  })
}

interface PendingRequest {
  readonly reject: (error: Error) => void
  readonly resolve: (value: unknown) => void
  readonly timeout: ReturnType<typeof setTimeout>
}

/** Daemon-side PtyHostService: an adoption-first, terminal-data-stateless proxy. */
export const ptyHostProxyLayer = Layer.effect(
  TerminalManager,
  Effect.acquireRelease(
    Effect.tryPromise(async () => {
      const registration = await ensurePtyHost()
      const socket = await openSocket(registration.socketPath)
      socket.setEncoding('utf8')
      const lifecycleEvents = Effect.runSync(
        PubSub.unbounded<TerminalLifecycleEvent>()
      )
      const pending = new Map<string, PendingRequest>()
      const attachSubscribers = new Map<
        string,
        (event: TerminalAttachEvent) => boolean
      >()
      const hostSubscriberIds = new Map<string, string>()
      let buffer = ''

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
          attachSubscribers.get(message.subscriberId)?.(message.event)
          return
        }
        PubSub.publishUnsafe(lifecycleEvents, message.event)
      }

      socket.on('data', (chunk: string) => {
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
            socket.destroy(new Error('PTY host sent invalid JSON'))
            return
          }
        }
        if (Buffer.byteLength(buffer, 'utf8') > MAX_PROTOCOL_FRAME_BYTES) {
          socket.destroy(new Error('PTY host protocol frame exceeded limit'))
        }
      })
      socket.on('error', () => undefined)
      socket.on('close', () => {
        for (const waiter of pending.values()) {
          clearTimeout(waiter.timeout)
          waiter.reject(new Error('PTY host connection closed'))
        }
        pending.clear()
      })

      const request = <A>(method: PtyHostMethod, args: readonly unknown[]) =>
        new Promise<A>((resolveRequest, reject) => {
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
          }, REQUEST_TIMEOUT_MS)
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
          if (!socket.write(`${JSON.stringify(message)}\n`)) {
            // Backpressure is handled by the socket. The request timeout keeps
            // a permanently stalled local transport bounded.
          }
        })

      // Boot barrier: ensure -> list before the public daemon can start.
      try {
        await request('listTerminals', [])
      } catch (error) {
        socket.destroy()
        throw error
      }

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
            attachSubscribers.set(localId, subscriber)
            const result = yield* remote<{ readonly subscriberId: string }>(
              'attach',
              [id, options, localId]
            ).pipe(
              Effect.tapError(() =>
                Effect.sync(() => attachSubscribers.delete(localId))
              )
            )
            hostSubscriberIds.set(`${id}:${localId}`, result.subscriberId)
            return { subscriberId: localId }
          }),
        acknowledge: (id, leaseId, cursor) =>
          remote('acknowledge', [id, leaseId, cursor]),
        transportMetrics: (id) => remote('transportMetrics', [id]),
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
        subscribe: (id, callback) =>
          service.attach(id, {}, (event) => {
            if (event._tag === 'Delta' || event._tag === 'Snapshot') {
              callback(event.data)
            }
            return true
          }),
        unsubscribe: (id, localId) =>
          Effect.gen(function* () {
            attachSubscribers.delete(localId)
            const key = `${id}:${localId}`
            const hostId = hostSubscriberIds.get(key)
            hostSubscriberIds.delete(key)
            if (hostId !== undefined) {
              yield* remote('unsubscribe', [id, hostId]).pipe(
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
        getTerminals: () => Effect.succeed([]),
        setRevivedReplayEvent: () => Effect.void,
        takeRevivedReplayEvent: () => Effect.succeed<undefined>(undefined),
        lifecycleEvents,
      })
      return { service, socket }
    }),
    ({ socket }) => Effect.sync(() => socket.destroy())
  ).pipe(Effect.map(({ service }) => service))
)
