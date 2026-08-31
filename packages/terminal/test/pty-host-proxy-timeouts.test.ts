/**
 * Per-class PTY host request timeouts.
 *
 * Control-plane calls (liveness and shutdown) fail fast so the proxy can tell
 * whether the host answers at all. Data-plane calls are patient: a
 * busy-but-healthy host queues them behind bulk terminal output, and a short
 * deadline turns load into a false pane disconnect. Slowness is reported by the
 * advisory heartbeat instead (ADR 0003).
 *
 * Env vars are read when the proxy module loads, so this file sets them before
 * importing it dynamically. Vitest isolates modules per file.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { resolvePtyHostVersion } from '../src/services/pty-host-paths.js'
import type { PtyHostMethod } from '../src/services/pty-host-protocol.js'
import { TerminalManager } from '../src/services/terminal-manager.js'

const CONTROL_TIMEOUT_MS = 40
const DATA_TIMEOUT_MS = 300
/** Longer than the control deadline, shorter than the data deadline. */
const SLOW_RESPONSE_MS = 120
const HOST_EPOCH = 'epoch-under-load'
const SLOW_TERMINAL_ID = 'terminal-slow'
const SILENT_TERMINAL_ID = 'terminal-silent'

type ProxyModule = typeof import('../src/services/pty-host-proxy.js')

interface HostRequest {
  readonly args: readonly unknown[]
  readonly method: PtyHostMethod
  readonly requestId: string
}

let stateRoot: string
let server: Server
let proxy: ProxyModule
const connections = new Set<Socket>()
const timers = new Set<ReturnType<typeof setTimeout>>()

/**
 * Minimal in-process stand-in for the pty-host: newline-delimited JSON over a
 * unix socket, with a configurable stall on the data plane.
 */
const startFakeHost = (socketPath: string, version: string): Promise<Server> =>
  new Promise((resolveServer, reject) => {
    const fake = createServer((socket) => {
      connections.add(socket)
      socket.setEncoding('utf8')
      socket.on('error', () => undefined)
      socket.on('close', () => connections.delete(socket))
      let buffer = ''
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
          const request = JSON.parse(line) as HostRequest
          const respond = (result: unknown): void => {
            if (socket.writable) {
              socket.write(
                `${JSON.stringify({ type: 'response', requestId: request.requestId, result })}\n`
              )
            }
          }
          if (request.method === 'health') {
            respond({ epoch: HOST_EPOCH, version })
            continue
          }
          if (request.method === 'write') {
            const terminalId = request.args[0]
            if (terminalId === SILENT_TERMINAL_ID) {
              // Never answers: proves the data-plane deadline still exists.
              continue
            }
            const timer = setTimeout(() => {
              timers.delete(timer)
              respond(undefined)
            }, SLOW_RESPONSE_MS)
            timers.add(timer)
            continue
          }
          respond(request.method === 'listTerminals' ? [] : undefined)
        }
      })
    })
    fake.once('error', reject)
    fake.listen(socketPath, () => resolveServer(fake))
  })

beforeAll(async () => {
  stateRoot = mkdtempSync(join(tmpdir(), 'lab-pty-timeouts-'))
  const entryPath = join(stateRoot, 'pty-host-entry.mjs')
  writeFileSync(entryPath, 'export const fake = true\n')
  const version = resolvePtyHostVersion(entryPath)
  const socketPath = join(stateRoot, 'host.sock')

  process.env.XDG_STATE_HOME = stateRoot
  process.env.LABORER_PTY_HOST_ENTRY = entryPath
  process.env.LABORER_PTY_HOST_CONTROL_TIMEOUT_MS = String(CONTROL_TIMEOUT_MS)
  process.env.LABORER_PTY_HOST_REQUEST_TIMEOUT_MS = String(DATA_TIMEOUT_MS)
  // Keep the advisory heartbeat out of this test's way.
  process.env.LABORER_PTY_HOST_HEARTBEAT_INTERVAL_MS = '600000'
  process.env.LABORER_DEV_WATCH = '0'

  const registrationDir = join(stateRoot, 'laborer', 'pty-host')
  mkdirSync(registrationDir, { mode: 0o700, recursive: true })
  writeFileSync(
    join(registrationDir, 'pty-host.json'),
    `${JSON.stringify({
      epoch: HOST_EPOCH,
      pid: process.pid,
      socketPath,
      startedAt: new Date().toISOString(),
      version,
    })}\n`,
    { flag: 'w' }
  )

  server = await startFakeHost(socketPath, version)
  proxy = await import('../src/services/pty-host-proxy.js')
})

afterAll(async () => {
  for (const timer of timers) {
    clearTimeout(timer)
  }
  timers.clear()
  for (const socket of connections) {
    socket.destroy()
  }
  await new Promise<void>((done) => server.close(() => done()))
  rmSync(stateRoot, { force: true, recursive: true })
})

describe('PTY host request timeout classes', () => {
  it('fails fast only on liveness and shutdown calls', () => {
    const controlPlane: readonly PtyHostMethod[] = [
      'health',
      'shutdown',
      'shutdownIfEmpty',
    ]
    const dataPlane: readonly PtyHostMethod[] = [
      'acknowledge',
      'attach',
      'kill',
      'killAllForWorkspace',
      'listTerminals',
      'remove',
      'reportWorkspacePresence',
      'resize',
      'restart',
      'setAgentStatusFromHook',
      'setObservedWorkspaces',
      'setOutputCoalesceWindow',
      'spawn',
      'terminalExists',
      'transportMetrics',
      'unsubscribe',
      'write',
    ]

    for (const method of controlPlane) {
      expect(proxy.ptyHostRequestClass(method)).toBe('control')
      expect(proxy.ptyHostRequestTimeoutMs(method)).toBe(CONTROL_TIMEOUT_MS)
    }
    for (const method of dataPlane) {
      expect(proxy.ptyHostRequestClass(method)).toBe('data')
      expect(proxy.ptyHostRequestTimeoutMs(method)).toBe(DATA_TIMEOUT_MS)
    }
  })

  it('keeps the documented defaults', () => {
    expect(proxy.PTY_HOST_CONTROL_TIMEOUT_MS_DEFAULT).toBe(5000)
    expect(proxy.PTY_HOST_REQUEST_TIMEOUT_MS_DEFAULT).toBe(30_000)
  })
})

describe('PTY host proxy under a slow host', () => {
  it('still resolves a write that outlives the control-plane deadline', async () => {
    const elapsed = await Effect.runPromise(
      Effect.gen(function* () {
        const manager = yield* TerminalManager
        const started = Date.now()
        yield* manager.write(SLOW_TERMINAL_ID, 'ls\n')
        return Date.now() - started
      }).pipe(Effect.provide(proxy.ptyHostProxyLayer))
    )

    expect(elapsed).toBeGreaterThanOrEqual(CONTROL_TIMEOUT_MS)
  })

  it('still times out a write that outlives the data-plane deadline', async () => {
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const manager = yield* TerminalManager
        return yield* manager.write(SILENT_TERMINAL_ID, 'ls\n').pipe(
          Effect.map(() => 'resolved'),
          Effect.catch((error) => Effect.succeed(error.message))
        )
      }).pipe(Effect.provide(proxy.ptyHostProxyLayer))
    )

    expect(failure).toBe('PTY host request timed out: write')
  })
})
