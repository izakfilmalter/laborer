import { type ChildProcess, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { NodeSocket } from '@effect/platform-node'
import { assert, describe, it } from '@effect/vitest'
import { FileWatcher } from '@laborer/file-watcher/services/file-watcher'
import { WatcherManager } from '@laborer/file-watcher/services/watcher-manager'
import { DaemonRpcs, type WatchFileEvent } from '@laborer/shared/rpc'
import { Effect, Layer, PubSub } from 'effect'
import { RpcClient, RpcSerialization } from 'effect/unstable/rpc'
import { FileWatcherClient } from '../src/services/file-watcher-client.js'

const MAX_DIAGNOSTICS_LENGTH = 64 * 1024
const DAEMON_WEB_CLIENT_PATTERN = /daemon web client/
const HTTP_STATUS_PATTERN = /^HTTP\/1\.1 (\d{3})/

const allocatePort = (): Promise<number> =>
  new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address !== 'object' || address === null) {
        server.close()
        reject(new Error('Could not allocate daemon test port'))
        return
      }
      server.close((error) => {
        if (error) {
          reject(error)
        } else {
          resolvePort(address.port)
        }
      })
    })
  })

const waitForReady = async (
  url: string,
  child: ChildProcess
): Promise<void> => {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Daemon exited before readiness (${String(child.exitCode)})`
      )
    }
    try {
      const response = await fetch(`${url}/health`, {
        signal: AbortSignal.timeout(250),
      })
      if (response.ok) {
        const body: unknown = await response.json()
        if (typeof body !== 'object' || body === null) {
          throw new Error('Daemon health response was not an object')
        }
        assert.strictEqual(Reflect.get(body, 'ready'), true)
        assert.strictEqual(Reflect.get(body, 'status'), 'ok')
        return
      }
    } catch {
      // The daemon has not bound its loopback listener yet.
    }
    await new Promise((resume) => setTimeout(resume, 25))
  }
  throw new Error('Timed out waiting for daemon readiness')
}

const websocketHandshakeStatus = (
  port: number,
  origin?: string
): Promise<number> =>
  new Promise((resolveStatus, reject) => {
    const socket = connect(port, '127.0.0.1')
    const timeout = setTimeout(() => {
      socket.destroy(new Error('WebSocket handshake timed out'))
    }, 2000)
    let response = ''
    socket.setEncoding('utf8')
    socket.once('error', reject)
    socket.on('data', (chunk) => {
      response += chunk
      if (!response.includes('\r\n\r\n')) {
        return
      }
      clearTimeout(timeout)
      socket.destroy()
      const match = HTTP_STATUS_PATTERN.exec(response)
      if (match?.[1] === undefined) {
        reject(new Error(`Invalid WebSocket handshake response: ${response}`))
      } else {
        resolveStatus(Number(match[1]))
      }
    })
    socket.once('connect', () => {
      socket.write(
        [
          'GET /ws HTTP/1.1',
          `Host: 127.0.0.1:${String(port)}`,
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Version: 13',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          ...(origin === undefined ? [] : [`Origin: ${origin}`]),
          '',
          '',
        ].join('\r\n')
      )
    })
  })

const stopChild = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null) {
    return
  }
  await new Promise<void>((resolveExit) => {
    let settled = false
    const finish = () => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      resolveExit()
    }
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
    }, 5000)
    child.once('exit', finish)
    if (child.exitCode !== null) {
      finish()
      return
    }
    // Register before signalling: the detached-host proxy lets the daemon
    // finalize quickly enough that registering afterward can miss `exit`.
    child.kill('SIGTERM')
  })
}

const readHostPid = async (stateHome: string): Promise<number> => {
  const raw: unknown = JSON.parse(
    await readFile(
      join(stateHome, 'laborer', 'pty-host', 'pty-host.json'),
      'utf8'
    )
  )
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('PTY host registration was not an object')
  }
  const pid = Reflect.get(raw, 'pid')
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    throw new Error('PTY host registration did not contain a valid pid')
  }
  return pid
}

const stopHost = async (stateHome: string): Promise<void> => {
  let pid: number
  try {
    pid = await readHostPid(stateHome)
  } catch {
    return
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return
  }
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await new Promise((resume) => setTimeout(resume, 25))
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // The host exited between the final probe and fallback signal.
  }
}

const waitForHostReplacement = async (
  stateHome: string,
  previousPid: number
): Promise<number> => {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      const pid = await readHostPid(stateHome)
      if (pid !== previousPid) {
        return pid
      }
    } catch {
      // Registration is atomically replaced while the bounded ensure runs.
    }
    await new Promise((resume) => setTimeout(resume, 25))
  }
  throw new Error('Timed out waiting for daemon to re-ensure the pty host')
}

describe('standalone daemon', () => {
  it.effect('forwards in-process watcher events to server consumers', () => {
    const WatcherManagerLive = WatcherManager.layer.pipe(
      Layer.provide(FileWatcher.layer)
    )
    const TestLayer = FileWatcherClient.inProcessLayer.pipe(
      Layer.provideMerge(WatcherManagerLive)
    )

    return Effect.gen(function* () {
      const client = yield* FileWatcherClient
      const manager = yield* WatcherManager
      let receiveEvent: (event: WatchFileEvent) => void = () => undefined
      const received = new Promise<WatchFileEvent>((resolveEvent) => {
        receiveEvent = resolveEvent
      })
      const subscription = client.onFileEvent((event) => {
        receiveEvent(event)
      })

      yield* client.listSubscriptions()
      for (
        let attempts = 0;
        attempts < 100 && manager.fileEvents.subscribers.size === 0;
        attempts += 1
      ) {
        yield* Effect.yieldNow
      }
      assert.strictEqual(manager.fileEvents.subscribers.size, 1)

      const event: WatchFileEvent = {
        subscriptionId: 'subscription-1',
        type: 'change',
        fileName: 'src/index.ts',
        absolutePath: '/tmp/project/src/index.ts',
      }
      yield* PubSub.publish(manager.fileEvents, event)

      assert.deepStrictEqual(yield* Effect.promise(() => received), event)
      subscription.unsubscribe()
    }).pipe(Effect.provide(TestLayer), Effect.scoped)
  })

  it('serves all three RPC groups over one WebSocket', async () => {
    const port = await allocatePort()
    const assetPort = await allocatePort()
    const stateHome = await mkdtemp(join(tmpdir(), 'laborer-daemon-test-'))
    const webDist = join(stateHome, 'web-dist')
    await mkdir(join(webDist, 'assets'), { recursive: true })
    await writeFile(
      join(webDist, 'index.html'),
      '<main>daemon web client</main>'
    )
    await writeFile(join(webDist, 'assets', 'app.js'), 'export {}')
    const daemonPath = resolve(import.meta.dirname, '../dist/daemon-main.mjs')
    let diagnostics = ''
    const daemonEnvironment = {
      HOME: stateHome,
      LABORER_DAEMON_PORT: String(port),
      LABORER_WORKSPACE_ASSET_PORT: String(assetPort),
      LABORER_FILE_WATCHER_BACKEND: 'fs',
      LABORER_PTY_HOST_ENTRY: resolve(
        import.meta.dirname,
        '../../terminal/dist/pty-host-main.mjs'
      ),
      LABORER_WEB_DIST: webDist,
      NODE_ENV: 'test',
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      SHELL: '/bin/sh',
      TMPDIR: tmpdir(),
      VITE_PORT: '2101',
      XDG_CONFIG_HOME: join(stateHome, 'config'),
      XDG_STATE_HOME: stateHome,
    }
    const spawnDaemon = () =>
      spawn(process.execPath, [daemonPath], {
        env: daemonEnvironment,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    let child = spawnDaemon()
    const appendDiagnostics = (chunk: unknown) => {
      diagnostics = `${diagnostics}${String(chunk)}`.slice(
        -MAX_DIAGNOSTICS_LENGTH
      )
    }
    child.stdout?.on('data', (chunk) => {
      appendDiagnostics(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      appendDiagnostics(chunk)
    })

    const url = `http://127.0.0.1:${String(port)}`
    try {
      await waitForReady(url, child)
      assert.strictEqual(
        await websocketHandshakeStatus(port, url),
        101,
        'same-origin browser renderer must connect'
      )
      assert.strictEqual(
        await websocketHandshakeStatus(port, 'http://localhost:2101'),
        101,
        'Vite browser renderer must connect'
      )
      assert.strictEqual(
        await websocketHandshakeStatus(port),
        101,
        'native and CLI clients without Origin must connect'
      )
      assert.strictEqual(
        await websocketHandshakeStatus(
          port,
          `http://127.0.0.1:${String(assetPort)}`
        ),
        403,
        'JavaScript in hostile workspace HTML must not connect from the asset origin'
      )
      assert.strictEqual(
        await websocketHandshakeStatus(port, 'https://attacker.example'),
        403
      )
      assert.strictEqual(await websocketHandshakeStatus(port, 'null'), 403)
      assert.strictEqual(
        (
          await fetch(
            `http://127.0.0.1:${String(assetPort)}/api/workspace-assets/malformed`
          )
        ).status,
        404,
        'workspace asset routes must be reachable only on the dedicated listener'
      )
      assert.match(
        await fetch(url).then((response) => response.text()),
        DAEMON_WEB_CLIENT_PATTERN
      )
      assert.strictEqual((await fetch(`${url}/assets/app.js`)).status, 200)
      assert.strictEqual((await fetch(`${url}/assets/missing.js`)).status, 404)
      for (const path of [
        '/server-health',
        '/terminal-health',
        '/file-watcher-health',
      ]) {
        const response = await fetch(`${url}${path}`)
        assert.strictEqual(response.status, 200)
        assert.strictEqual(
          Reflect.get((await response.json()) as object, 'ready'),
          true
        )
      }

      await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* RpcClient.make(DaemonRpcs)
          const [health, hostStatus, terminals, watchers] = yield* Effect.all([
            client['health.check'](),
            client['terminal.hostStatus'](),
            client['terminal.list'](),
            client['watcher.list'](),
          ])

          assert.strictEqual(health.status, 'ok')
          assert.strictEqual(hostStatus.state, 'healthy')
          assert.deepStrictEqual(terminals, [])
          assert.deepStrictEqual(watchers, [])

          yield* client['terminal.reportWorkspacePresence']({
            clientId: 'daemon-rpc-test',
            sequence: 0,
            workspaceIds: ['workspace-a'],
          })
          yield* client['terminal.reportWorkspacePresence']({
            clientId: 'daemon-rpc-test',
            sequence: 1,
            workspaceIds: [],
          })

          const restarted = yield* client['terminal.restartHost']()
          assert.strictEqual(restarted.state, 'healthy')

          const spawnFailure = yield* Effect.flip(
            client['terminal.spawn']({ workspaceId: 'missing-workspace' })
          )
          assert.strictEqual(spawnFailure._tag, 'RpcError')
          if (spawnFailure._tag === 'RpcError') {
            assert.strictEqual(spawnFailure.code, 'NOT_FOUND')
          }
        }).pipe(
          Effect.provide(
            RpcClient.layerProtocolSocket({
              retryTransientErrors: false,
            }).pipe(
              Layer.provide(
                Layer.mergeAll(
                  NodeSocket.layerWebSocket(
                    `ws://127.0.0.1:${String(port)}/ws`
                  ),
                  RpcSerialization.layerJson
                )
              )
            )
          ),
          Effect.scoped
        )
      )
      const originalHostPid = await readHostPid(stateHome)
      const daemonExit = new Promise<void>((resolveExit) => {
        if (child.exitCode !== null) {
          resolveExit()
          return
        }
        child.once('exit', () => resolveExit())
      })
      const restartResponse = await fetch(`${url}/daemon/stop`, {
        body: JSON.stringify({ mode: 'restart' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
      assert.strictEqual(restartResponse.status, 202)
      await daemonExit
      child = spawnDaemon()
      child.stdout?.on('data', (chunk) => appendDiagnostics(chunk))
      child.stderr?.on('data', (chunk) => appendDiagnostics(chunk))
      await waitForReady(url, child)
      assert.strictEqual(
        await readHostPid(stateHome),
        originalHostPid,
        'daemon restart should adopt the detached PTY host'
      )
      process.kill(originalHostPid, 'SIGKILL')
      const replacementPid = await waitForHostReplacement(
        stateHome,
        originalHostPid
      )
      assert.notStrictEqual(replacementPid, originalHostPid)
      await waitForReady(url, child)
    } catch (error) {
      throw new Error(
        `Daemon RPC round-trip failed: ${String(error)}\n${diagnostics}`
      )
    } finally {
      await stopChild(child)
      await stopHost(stateHome)
      await rm(stateHome, { recursive: true, force: true })
    }
  }, 45_000)
})
