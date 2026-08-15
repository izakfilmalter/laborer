import { describe, expect, it } from 'vitest'

import { makePtyHostLifecycleGate } from '../src/services/pty-host-lifecycle-gate.js'
import { shouldReplaceDevHostRuntime } from '../src/services/pty-host-proxy.js'

describe('development PTY host runtime', () => {
  it('replaces a Bun host when the watched daemon runs under Node', () => {
    expect(
      shouldReplaceDevHostRuntime({
        devWatch: true,
        expectedExecPath: '/usr/local/bin/node',
        hostExecPath: '/Users/me/.bun/bin/bun',
      })
    ).toBe(true)
  })

  it('replaces an older host that does not report its runtime', () => {
    expect(
      shouldReplaceDevHostRuntime({
        devWatch: true,
        expectedExecPath: '/usr/local/bin/node',
      })
    ).toBe(true)
  })

  it('adopts the matching Node host across daemon hot reloads', () => {
    expect(
      shouldReplaceDevHostRuntime({
        devWatch: true,
        expectedExecPath: '/usr/local/bin/node',
        hostExecPath: '/usr/local/bin/node',
      })
    ).toBe(false)
  })

  it('does not replace durable production hosts based on runtime', () => {
    expect(
      shouldReplaceDevHostRuntime({
        devWatch: false,
        expectedExecPath: '/usr/local/bin/node',
        hostExecPath: '/Users/me/.bun/bin/bun',
      })
    ).toBe(false)
  })
})

describe('PTY host lifecycle gate', () => {
  it('waits for an in-flight spawn before deciding whether the host is empty', async () => {
    const gate = makePtyHostLifecycleGate()
    const terminals: string[] = []
    let finishSpawn: () => void = () => undefined
    const spawnCanFinish = new Promise<void>((resolve) => {
      finishSpawn = resolve
    })

    const spawn = gate.run('spawn', async () => {
      await spawnCanFinish
      terminals.push('terminal-1')
    })
    const shutdown = gate.run(
      'shutdownIfEmpty',
      async () => terminals.length === 0,
      (accepted) => accepted
    )

    finishSpawn()
    await spawn
    await expect(shutdown).resolves.toBe(false)
    expect(terminals).toEqual(['terminal-1'])
  })

  it('rejects queued and new spawns after empty shutdown is accepted', async () => {
    const gate = makePtyHostLifecycleGate()
    let spawnCalls = 0
    const shutdown = gate.run(
      'shutdownIfEmpty',
      () => Promise.resolve(true),
      Boolean
    )
    const queuedSpawn = gate.run('spawn', () => {
      spawnCalls += 1
      return Promise.resolve()
    })

    await expect(shutdown).resolves.toBe(true)
    await expect(queuedSpawn).rejects.toThrow(
      'shutdown has already been accepted'
    )
    await expect(
      gate.run('spawn', () => {
        spawnCalls += 1
        return Promise.resolve()
      })
    ).rejects.toThrow('shutdown has already been accepted')
    expect(spawnCalls).toBe(0)
  })

  it('rejects queued and new restarts when removal races empty shutdown', async () => {
    const gate = makePtyHostLifecycleGate()
    const terminals = new Set(['terminal-1'])
    let restartCalls = 0

    terminals.delete('terminal-1')
    const shutdown = gate.run(
      'shutdownIfEmpty',
      () => Promise.resolve(terminals.size === 0),
      Boolean
    )
    const queuedRestart = gate.run('restart', () => {
      restartCalls += 1
      terminals.add('terminal-1')
      return Promise.resolve()
    })

    await expect(shutdown).resolves.toBe(true)
    await expect(queuedRestart).rejects.toThrow(
      'shutdown has already been accepted'
    )
    await expect(
      gate.run('restart', () => {
        restartCalls += 1
        terminals.add('terminal-1')
        return Promise.resolve()
      })
    ).rejects.toThrow('shutdown has already been accepted')
    expect(restartCalls).toBe(0)
    expect(terminals.size).toBe(0)
  })

  it('does not commit shutdown when the host reports any terminal', async () => {
    const gate = makePtyHostLifecycleGate()

    await expect(
      gate.run('shutdownIfEmpty', () => Promise.resolve(false), Boolean)
    ).resolves.toBe(false)
    await expect(
      gate.run('spawn', () => Promise.resolve('spawned'))
    ).resolves.toBe('spawned')
  })
})
