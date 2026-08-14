import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { NodeSocket } from '@effect/platform-node'
import { assert, describe, it } from '@effect/vitest'
import { DaemonRpcs } from '@laborer/shared/rpc'
import { Effect, Layer } from 'effect'
import { RpcClient, RpcSerialization } from 'effect/unstable/rpc'

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
      const response = await fetch(`${url}/health`)
      if (response.ok) {
        const body = (await response.json()) as {
          readonly ready?: unknown
          readonly status?: unknown
        }
        assert.strictEqual(body.ready, true)
        assert.strictEqual(body.status, 'ok')
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
  child.kill('SIGTERM')
  await new Promise<void>((resolveExit) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
    }, 5000)
    child.once('exit', () => {
      clearTimeout(timeout)
      resolveExit()
    })
  })
}

describe('standalone daemon', () => {
  it('serves all three RPC groups over one WebSocket', async () => {
    const port = await allocatePort()
    const stateHome = await mkdtemp(join(tmpdir(), 'laborer-daemon-test-'))
    const daemonPath = resolve(import.meta.dirname, '../dist/daemon-main.mjs')
    let diagnostics = ''
    const child = spawn(process.execPath, [daemonPath], {
      env: {
        ...process.env,
        LABORER_DAEMON_PORT: String(port),
        NODE_ENV: 'test',
        XDG_STATE_HOME: stateHome,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.on('data', (chunk) => {
      diagnostics += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      diagnostics += String(chunk)
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
    } catch (error) {
      throw new Error(
        `Daemon RPC round-trip failed: ${String(error)}\n${diagnostics}`
      )
    } finally {
      await stopChild(child)
      await rm(stateHome, { recursive: true, force: true })
    }
  }, 30_000)
})
