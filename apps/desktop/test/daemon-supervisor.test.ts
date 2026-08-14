import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  findAvailableDaemonPort,
  resolveDaemonRegistrationPath,
} from '../src/daemon-supervisor.js'

describe('desktop daemon supervisor', () => {
  it('uses the isolated state root for discovery', () => {
    const state = mkdtempSync(join(tmpdir(), 'laborer-desktop-state-'))
    expect(resolveDaemonRegistrationPath({ XDG_STATE_HOME: state })).toBe(
      join(state, 'laborer', 'daemon.json')
    )
  })

  it('selects a loopback port from the production scan range', async () => {
    const port = await findAvailableDaemonPort(41_000)
    expect(port).toBeGreaterThanOrEqual(41_000)
    expect(port).toBeLessThan(41_100)
  })
})
