import { randomUUID } from 'node:crypto'
import { chmodSync, rmSync } from 'node:fs'
import { connect, createServer, type Socket } from 'node:net'
import { fileURLToPath } from 'node:url'
import { writeJsonRegistration } from '@laborer/ensure'
import { Effect, Fiber, Layer, ManagedRuntime, Stream } from 'effect'
import { directLayer } from './services/pty-direct.js'
import { makePtyHostLifecycleGate } from './services/pty-host-lifecycle-gate.js'
import {
  preparePtyHostSocketPath,
  resolvePtyHostPaths,
  resolvePtyHostVersion,
} from './services/pty-host-paths.js'
import type {
  PtyHostRequest,
  PtyHostServerMessage,
} from './services/pty-host-protocol.js'
import { TerminalManager } from './services/terminal-manager.js'
import { TerminalSessionPersistenceLayer } from './services/terminal-session-persistence-layer.js'

const epoch = randomUUID()
const version = resolvePtyHostVersion(fileURLToPath(import.meta.url))
process.env.LABORER_PTY_HOST_EPOCH = epoch

const TerminalCore = Layer.merge(TerminalManager.layer, directLayer).pipe(
  Layer.provide(directLayer)
)
const HostLayer = TerminalSessionPersistenceLayer.pipe(
  Layer.provideMerge(TerminalCore)
)
const runtime = ManagedRuntime.make(HostLayer)
const manager = await runtime.runPromise(TerminalManager)
const paths = resolvePtyHostPaths()

preparePtyHostSocketPath(paths)

const send = (socket: Socket, message: PtyHostServerMessage): boolean => {
  if (!socket.writable) {
    return false
  }
  // `write()` returning false is normal stream backpressure, not delivery
  // failure. The terminal's committed-cursor lane bounds live output while
  // Node drains this local socket buffer.
  socket.write(`${JSON.stringify(message)}\n`)
  return true
}

const connections = new Set<Socket>()
const MAX_PROTOCOL_FRAME_BYTES = 1024 * 1024
const lifecycleGate = makePtyHostLifecycleGate()
const isAcceptedShutdownResult = (outcome: unknown): boolean =>
  typeof outcome === 'object' &&
  outcome !== null &&
  Reflect.get(outcome, '_tag') === 'Success' &&
  Reflect.get(outcome, 'success') === true

const invoke = (socket: Socket, request: PtyHostRequest) => {
  const [first, second, third] = request.args
  switch (request.method) {
    case 'health':
      return Effect.succeed({ epoch, execPath: process.execPath, version })
    case 'spawn':
      return manager.spawn(first as Parameters<typeof manager.spawn>[0])
    case 'write':
      return manager.write(first as string, second as string)
    case 'attach':
      return manager.attach(
        first as string,
        second as Parameters<typeof manager.attach>[1],
        (event) =>
          send(socket, {
            type: 'attach-event',
            subscriberId: third as string,
            event,
          })
      )
    case 'acknowledge':
      return manager.acknowledge(
        first as string,
        second as string,
        third as number
      )
    case 'transportMetrics':
      return manager.transportMetrics(first as string)
    case 'resize':
      return manager.resize(first as string, second as number, third as number)
    case 'kill':
      return manager.kill(first as string)
    case 'remove':
      return manager.remove(first as string)
    case 'restart':
      return manager.restart(first as string)
    case 'shutdown':
      // The response is flushed before requestStop disposes the runtime. Its
      // persistence finalizer checkpoints every terminal for revival.
      return Effect.void
    case 'shutdownIfEmpty':
      return manager
        .listTerminals()
        .pipe(Effect.map((terminals) => terminals.length === 0))
    case 'listTerminals':
      return manager.listTerminals(first as string | undefined)
    case 'killAllForWorkspace':
      return manager.killAllForWorkspace(first as string)
    case 'terminalExists':
      return manager.terminalExists(first as string)
    case 'setAgentStatusFromHook':
      return manager.setAgentStatusFromHook(
        first as string,
        second as Parameters<typeof manager.setAgentStatusFromHook>[1]
      )
    case 'setObservedWorkspaces':
      return manager.setObservedWorkspaces(new Set(first as string[]))
    case 'reportWorkspacePresence':
      return manager.reportWorkspacePresence(
        first as string,
        second as number,
        new Set(third as string[])
      )
    case 'unsubscribe':
      return manager.unsubscribe(first as string, second as string)
    default:
      throw new Error(
        `Unsupported pty-host method: ${request.method as string}`
      )
  }
}

const server = createServer((socket) => {
  connections.add(socket)
  let buffer = ''
  const attachLeases = new Map<string, string>()
  let requestLane = Promise.resolve()
  const lifecycleFiber = runtime.runFork(
    Stream.runForEach(Stream.fromPubSub(manager.lifecycleEvents), (event) =>
      Effect.sync(() => {
        send(socket, { type: 'lifecycle-event', event })
      })
    )
  )

  socket.setEncoding('utf8')
  // A daemon can disappear between writable-check and the kernel write.
  // Connection loss releases leases below; it must never crash the host.
  socket.on('error', () => undefined)
  socket.on('data', (chunk) => {
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
      let request: PtyHostRequest
      try {
        request = JSON.parse(line) as PtyHostRequest
      } catch {
        socket.destroy()
        return
      }
      requestLane = requestLane
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: serialized protocol dispatch keeps request ordering and shutdown response atomic
        .then(async () => {
          const result = await lifecycleGate.run(
            request.method,
            () => runtime.runPromise(Effect.result(invoke(socket, request))),
            isAcceptedShutdownResult
          )
          if (result._tag === 'Success') {
            if (request.method === 'attach') {
              const subscriberId = (
                result.success as unknown as { subscriberId: string }
              ).subscriberId
              attachLeases.set(subscriberId, request.args[0] as string)
            } else if (request.method === 'unsubscribe') {
              attachLeases.delete(request.args[1] as string)
            }
            send(socket, {
              type: 'response',
              requestId: request.requestId,
              result: result.success,
            })
            if (
              request.method === 'shutdown' ||
              (request.method === 'shutdownIfEmpty' &&
                (result.success as unknown) === true)
            ) {
              setImmediate(requestStop)
            }
            return
          }
          send(socket, {
            type: 'response',
            requestId: request.requestId,
            error: {
              ...(result.failure?.code === undefined
                ? {}
                : { code: result.failure.code }),
              message: result.failure?.message ?? String(result.failure),
            },
          })
        })
        .catch((error: unknown) => {
          send(socket, {
            type: 'response',
            requestId: request.requestId,
            error: {
              message: error instanceof Error ? error.message : String(error),
            },
          })
        })
    }
    if (Buffer.byteLength(buffer, 'utf8') > MAX_PROTOCOL_FRAME_BYTES) {
      socket.destroy()
    }
  })
  socket.on('close', () => {
    connections.delete(socket)
    runtime.runFork(Fiber.interrupt(lifecycleFiber))
    for (const [subscriberId, terminalId] of attachLeases) {
      runtime.runFork(manager.unsubscribe(terminalId, subscriberId))
    }
    attachLeases.clear()
  })
})

const listen = (): Promise<'incumbent' | 'listening'> =>
  new Promise((resolveListen, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EADDRINUSE') {
        reject(error)
        return
      }
      const incumbent = connect(paths.socketPath)
      incumbent.once('connect', () => {
        incumbent.destroy()
        resolveListen('incumbent')
      })
      incumbent.once('error', () => {
        // A dead process can leave its UDS inode behind. Only remove it after
        // a failed connection, then retry the bind-as-contender-lock.
        rmSync(paths.socketPath, { force: true })
        server.once('error', reject)
        server.listen(paths.socketPath, () => resolveListen('listening'))
      })
    }
    server.once('error', onError)
    server.listen(paths.socketPath, () => resolveListen('listening'))
  })

if ((await listen()) === 'incumbent') {
  await runtime.dispose()
  process.exit(0)
}
chmodSync(paths.socketPath, 0o600)
writeJsonRegistration(paths.registrationPath, {
  epoch,
  pid: process.pid,
  socketPath: paths.socketPath,
  startedAt: new Date().toISOString(),
  version,
})

let stopPromise: Promise<void> | undefined
const stop = async () => {
  rmSync(paths.registrationPath, { force: true })
  for (const socket of connections) {
    socket.destroy()
  }
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await runtime.dispose()
  rmSync(paths.socketPath, { force: true })
  if ('socketAliasPath' in paths) {
    rmSync(paths.socketAliasPath, { force: true })
  }
  process.exit(0)
}

const requestStop = () => {
  stopPromise ??= stop()
  stopPromise.catch((error: unknown) => console.error(error))
}
process.on('SIGINT', requestStop)
process.on('SIGTERM', requestStop)
