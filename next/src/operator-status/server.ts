import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, unlink } from 'node:fs/promises'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { resolve } from 'node:path'
import {
  decodeOperatorSubscribe,
  MAX_OPERATOR_RECORD_BYTES,
  OPERATOR_PROTOCOL_VERSION,
  type OperatorSnapshot,
  OperatorSnapshotSchema,
  type OperatorSubscribe,
  type OperatorWorkspaceBinding,
} from './protocol.ts'

const MAX_OPERATOR_CLIENTS = 16
const AUTHENTICATION_TIMEOUT_MS = 3000
const STALE_SOCKET_PROBE_TIMEOUT_MS = 1000
const AUTHENTICATION_TOKEN_PATTERN = /^[a-f0-9]{64}$/

export interface OperatorStatusPaths {
  readonly directory: string
  readonly runtimeRoot: string
  readonly socket: string
  readonly token: string
}

export const operatorStatusPaths = (
  runtimeRoot: string
): OperatorStatusPaths => {
  const resolvedRuntimeRoot = resolve(runtimeRoot)
  const directory = resolve(resolvedRuntimeRoot, 'operator-status')
  const preferredSocket = resolve(directory, 'daemon.sock')
  const socket =
    Buffer.byteLength(preferredSocket, 'utf8') <= 96
      ? preferredSocket
      : resolve(
          '/tmp',
          `laborer-operator-${createHash('sha256')
            .update(resolvedRuntimeRoot, 'utf8')
            .digest('hex')
            .slice(0, 32)}.sock`
        )
  return {
    directory,
    runtimeRoot: resolvedRuntimeRoot,
    socket,
    token: resolve(directory, 'authentication-token'),
  }
}

const currentUserId = (): number | null =>
  typeof process.getuid === 'function' ? process.getuid() : null

const assertOwner = (uid: number): void => {
  const expected = currentUserId()
  if (expected !== null && uid !== expected) {
    throw new Error('operator status path is not owned by the current user')
  }
}

const prepareDirectory = async (
  runtimeRoot: string,
  path: string
): Promise<void> => {
  const rootMetadata = await lstat(runtimeRoot)
  assertOwner(rootMetadata.uid)
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error('operator status runtime root is unsafe')
  }
  // biome-ignore lint/suspicious/noBitwiseOperators: POSIX mode masks are bit fields.
  if ((rootMetadata.mode & 0o077) !== 0) {
    throw new Error('operator status runtime root is not owner-only')
  }
  try {
    await mkdir(path, { mode: 0o700 })
  } catch (error) {
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      error.code !== 'EEXIST'
    ) {
      throw error
    }
  }
  const metadata = await lstat(path)
  assertOwner(metadata.uid)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('operator status directory is unsafe')
  }
  // biome-ignore lint/suspicious/noBitwiseOperators: POSIX mode masks are bit fields.
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error('operator status directory is not owner-only')
  }
}

const readOrCreateToken = async (path: string): Promise<string> => {
  try {
    const handle = await open(
      path,
      // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags are masks.
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600
    )
    const token = randomBytes(32).toString('hex')
    try {
      await handle.writeFile(token, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    return token
  } catch (error) {
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      error.code !== 'EEXIST'
    ) {
      throw error
    }
  }

  const handle = await open(
    path,
    // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags are masks.
    constants.O_RDONLY | constants.O_NOFOLLOW
  )
  try {
    const metadata = await handle.stat()
    assertOwner(metadata.uid)
    if (
      !metadata.isFile() ||
      // biome-ignore lint/suspicious/noBitwiseOperators: POSIX mode masks are bit fields.
      (metadata.mode & 0o077) !== 0 ||
      metadata.size !== 64
    ) {
      throw new Error('operator status token is unsafe')
    }
    const token = await handle.readFile('utf8')
    if (!AUTHENTICATION_TOKEN_PATTERN.test(token)) {
      throw new Error('operator status token is malformed')
    }
    return token
  } finally {
    await handle.close()
  }
}

const removeStaleSocket = async (path: string): Promise<void> => {
  try {
    const metadata = await lstat(path)
    assertOwner(metadata.uid)
    if (!metadata.isSocket()) {
      throw new Error('operator status socket path is unsafe')
    }
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return
    }
    throw error
  }

  const isOccupied = await new Promise<boolean>((resolveOccupied) => {
    const probe = connect(path)
    let settled = false
    const finish = (occupied: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      probe.destroy()
      resolveOccupied(occupied)
    }
    probe.setTimeout(STALE_SOCKET_PROBE_TIMEOUT_MS, () => finish(true))
    probe.once('connect', () => finish(true))
    probe.once('error', () => finish(false))
  })
  if (isOccupied) {
    throw new Error('another Laborer daemon owns the operator status endpoint')
  }
  await unlink(path)
}

const listen = (server: Server, path: string): Promise<void> =>
  new Promise((resolveListen, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(path, () => {
      server.off('error', onError)
      resolveListen()
    })
  })

export interface OperatorStatusServer {
  readonly close: () => Promise<void>
  readonly paths: OperatorStatusPaths
}

interface SocketIdentity {
  readonly device: number
  readonly inode: number
}

const closeListeningServer = async (server: Server): Promise<void> => {
  if (!server.listening) {
    return
  }
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()))
  })
}

const removeOwnedSocket = async (
  path: string,
  identity: SocketIdentity | null
): Promise<void> => {
  if (identity === null) {
    return
  }
  try {
    const currentSocket = await lstat(path)
    if (
      currentSocket.isSocket() &&
      currentSocket.dev === identity.device &&
      currentSocket.ino === identity.inode
    ) {
      await unlink(path)
    }
  } catch (error) {
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      error.code !== 'ENOENT'
    ) {
      throw error
    }
  }
}

export const startOperatorStatusServer = async (options: {
  readonly now?: () => number
  readonly paths: OperatorStatusPaths
  readonly projection?: () => {
    readonly receiver: 'connected' | 'connecting'
    readonly workspaces: readonly OperatorWorkspaceBinding[]
  }
  readonly tickIntervalMs?: number
  readonly version: string
}): Promise<OperatorStatusServer> => {
  const now = options.now ?? Date.now
  const startedAtUnixMs = now()
  let sequence = 0
  let closed = false
  const connections = new Set<Socket>()
  const clients = new Set<Socket>()

  if (Buffer.byteLength(options.paths.socket, 'utf8') > 96) {
    throw new Error('operator status socket path is too long')
  }
  await prepareDirectory(options.paths.runtimeRoot, options.paths.directory)
  const token = await readOrCreateToken(options.paths.token)
  await removeStaleSocket(options.paths.socket)

  const snapshot = (): OperatorSnapshot => {
    sequence += 1
    const projection = options.projection?.() ?? {
      receiver: 'connecting' as const,
      workspaces: [],
    }
    return OperatorSnapshotSchema.parse({
      daemon: {
        receiver: projection.receiver,
        startedAtUnixMs,
        version: options.version,
      },
      kind: 'snapshot',
      observedAtUnixMs: Math.max(startedAtUnixMs, now()),
      protocolVersion: OPERATOR_PROTOCOL_VERSION,
      sequence,
      workspaces: [...projection.workspaces],
    })
  }
  const publish = (socket: Socket): void => {
    if (!socket.destroyed) {
      let record: string
      try {
        record = `${JSON.stringify(snapshot())}\n`
      } catch {
        // A projection is a local protocol boundary. Reject an invalid or
        // unavailable projection for this client without taking down the daemon.
        socket.destroy()
        return
      }
      if (
        Buffer.byteLength(record, 'utf8') > MAX_OPERATOR_RECORD_BYTES ||
        socket.writableLength + Buffer.byteLength(record, 'utf8') >
          MAX_OPERATOR_RECORD_BYTES * 2 ||
        !socket.write(record)
      ) {
        socket.destroy()
      }
    }
  }

  const server = createServer((socket) => {
    if (connections.size >= MAX_OPERATOR_CLIENTS) {
      socket.destroy()
      return
    }
    connections.add(socket)
    socket.once('close', () => {
      connections.delete(socket)
      clients.delete(socket)
    })
    let source = Buffer.alloc(0)
    socket.setTimeout(AUTHENTICATION_TIMEOUT_MS, () => socket.destroy())
    socket.on('data', (chunk: Buffer) => {
      if (source.byteLength + chunk.byteLength > MAX_OPERATOR_RECORD_BYTES) {
        socket.destroy()
        return
      }
      source = Buffer.concat([source, chunk])
      const newline = source.indexOf(0x0a)
      if (newline < 0) {
        return
      }
      socket.removeAllListeners('data')
      let request: OperatorSubscribe
      try {
        request = decodeOperatorSubscribe(
          source.subarray(0, newline).toString('utf8')
        )
      } catch {
        socket.destroy()
        return
      }
      const provided = Buffer.from(request.token, 'utf8')
      const expected = Buffer.from(token, 'utf8')
      if (
        provided.byteLength !== expected.byteLength ||
        !timingSafeEqual(provided, expected)
      ) {
        socket.destroy()
        return
      }
      socket.setTimeout(0)
      socket.pause()
      clients.add(socket)
      publish(socket)
    })
    socket.once('error', () => socket.destroy())
  })

  let socketIdentity: SocketIdentity | null = null
  try {
    await listen(server, options.paths.socket)
    const socketMetadata = await lstat(options.paths.socket)
    assertOwner(socketMetadata.uid)
    if (!socketMetadata.isSocket()) {
      throw new Error('operator status endpoint did not create a socket')
    }
    socketIdentity = {
      device: socketMetadata.dev,
      inode: socketMetadata.ino,
    }
    await chmod(options.paths.socket, 0o600)
  } catch (error) {
    for (const connection of connections) {
      connection.destroy()
    }
    await closeListeningServer(server)
    await removeOwnedSocket(options.paths.socket, socketIdentity)
    throw error
  }
  const interval = setInterval(() => {
    for (const client of clients) {
      publish(client)
    }
  }, options.tickIntervalMs ?? 1000)
  interval.unref()

  return {
    close: async () => {
      if (closed) {
        return
      }
      closed = true
      clearInterval(interval)
      for (const connection of connections) {
        connection.destroy()
      }
      await closeListeningServer(server)
      await removeOwnedSocket(options.paths.socket, socketIdentity)
    },
    paths: options.paths,
  }
}
