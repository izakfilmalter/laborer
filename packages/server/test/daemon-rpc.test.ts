import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
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
    const stateHome = await mkdtemp(join(tmpdir(), 'laborer-daemon-test-'))
    const daemonPath = resolve(import.meta.dirname, '../dist/daemon-main.mjs')
    let diagnostics = ''
    const daemonEnvironment = {
      HOME: stateHome,
      LABORER_DAEMON_PORT: String(port),
      LABORER_FILE_WATCHER_BACKEND: 'fs',
      LABORER_PTY_HOST_ENTRY: resolve(
        import.meta.dirname,
        '../../terminal/dist/pty-host-main.mjs'
      ),
      NODE_ENV: 'test',
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      SHELL: '/bin/sh',
      TMPDIR: tmpdir(),
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

      await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* RpcClient.make(DaemonRpcs)
          const [health, terminals, watchers] = yield* Effect.all([
            client['health.check'](),
            client['terminal.list'](),
            client['watcher.list'](),
          ])

          assert.strictEqual(health.status, 'ok')
          assert.deepStrictEqual(terminals, [])
          assert.deepStrictEqual(watchers, [])

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
      await stopChild(child)
      child = spawnDaemon()
      child.stdout?.on('data', (chunk) => appendDiagnostics(chunk))
      child.stderr?.on('data', (chunk) => appendDiagnostics(chunk))
      await waitForReady(url, child)
      assert.strictEqual(
        await readHostPid(stateHome),
        originalHostPid,
        'daemon restart should adopt the detached PTY host'
      )
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
