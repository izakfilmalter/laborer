import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  EnsureConflictError,
  ensure,
  isDaemonRegistration,
  readJsonRegistration,
  stopWithEscalation,
  watchRegistrationOwnership,
  writeJsonRegistration,
} from '../src/index.js'

const registration = {
  pid: process.pid,
  socketPath: '/tmp/example.sock',
  startedAt: new Date(0).toISOString(),
  version: '1',
}

describe('ensure', () => {
  it('adopts a healthy incumbent without spawning', async () => {
    let spawned = false
    const result = await ensure({
      policy: 'adopt',
      readRegistration: () => registration,
      health: async () => true,
      spawn: () => {
        spawned = true
      },
    })
    expect(result).toEqual(registration)
    expect(spawned).toBe(false)
  })

  it('fails an exclusive edge with incumbent identity', async () => {
    await expect(
      ensure({
        policy: 'exclusive-fail',
        readRegistration: () => registration,
        health: async () => true,
        spawn: () => undefined,
      })
    ).rejects.toMatchObject({
      name: EnsureConflictError.name,
      registration,
    })
  })

  it('writes an atomic owner-only registration', () => {
    const directory = mkdtempSync(join(tmpdir(), 'laborer-ensure-'))
    const path = join(directory, 'nested', 'service.json')
    writeJsonRegistration(path, registration)
    expect(readJsonRegistration(path)).toEqual(registration)
    // biome-ignore lint/suspicious/noBitwiseOperators: POSIX mode mask
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('shares strict daemon and host registration schema primitives', () => {
    expect(
      isDaemonRegistration({
        id: 'daemon-1',
        pid: 42,
        startedAt: new Date(0).toISOString(),
        url: 'http://127.0.0.1:2100',
        version: '1',
      })
    ).toBe(true)
    expect(isDaemonRegistration({ ...registration, id: 'daemon-1' })).toBe(
      false
    )
    expect(
      isDaemonRegistration({
        id: 'daemon-1',
        password: 'deferred',
        pid: 42,
        startedAt: new Date(0).toISOString(),
        url: 'http://127.0.0.1:2100',
        version: '1',
      })
    ).toBe(false)
  })

  it('detects deterministic self-eviction without waiting for the interval', () => {
    let current = { ...registration, id: 'first' }
    let evictions = 0
    const ownership = watchRegistrationOwnership({
      intervalMs: 60_000,
      readRegistration: () => current,
      isOwner: ({ id }) => id === 'first',
      onEvicted: () => {
        evictions += 1
      },
    })

    expect(ownership.check()).toBe(true)
    current = { ...registration, id: 'replacement' }
    expect(ownership.check()).toBe(false)
    expect(evictions).toBe(1)
    ownership.dispose()
  })

  it('escalates stop RPC to SIGTERM and SIGKILL in order', async () => {
    const events: string[] = []
    const waits = [false, false]
    await stopWithEscalation(registration, {
      requestStop: () => {
        events.push('rpc')
        return Promise.resolve()
      },
      kill: (_pid, signal) => events.push(signal),
      waitUntilGone: () => Promise.resolve(waits.shift() ?? true),
    })

    expect(events).toEqual(['rpc', 'SIGTERM', 'SIGKILL'])
  })

  it('recognizes the incumbent after a contender spawn race', async () => {
    const incumbent = { ...registration, pid: process.pid }
    let spawned = false
    await expect(
      ensure({
        policy: 'exclusive-fail',
        readRegistration: () => (spawned ? incumbent : null),
        health: async () => true,
        spawn: () => {
          spawned = true
          return process.pid + 1
        },
      })
    ).rejects.toBeInstanceOf(EnsureConflictError)
  })

  it('replaces a healthy incumbent on an exclusive replace edge', async () => {
    const incumbent = { ...registration, pid: process.pid }
    const replacement = {
      ...registration,
      startedAt: new Date(1).toISOString(),
    }
    let current = incumbent
    const events: string[] = []
    const result = await ensure({
      policy: 'exclusive-replace',
      readRegistration: () => current,
      health: async () => true,
      stop: () => {
        events.push('stop')
        return Promise.resolve()
      },
      spawn: () => {
        events.push('spawn')
        current = replacement
        return replacement.pid
      },
    })

    expect(events).toEqual(['stop', 'spawn'])
    expect(result).toBe(replacement)
  })
})
