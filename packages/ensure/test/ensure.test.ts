import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  EnsureConflictError,
  ensure,
  readJsonRegistration,
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
})
