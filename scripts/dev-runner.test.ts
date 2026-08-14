import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BASE_DAEMON_PORT,
  BASE_WEB_PORT,
  devChildDefinitions,
  findAvailableDevPorts,
  linkedWorktreeStateHome,
  parseDevRunnerArguments,
  resolveDevStateHome,
  superviseDevChildren,
  worktreePortOffset,
} from './dev-runner'

describe('dev runner', () => {
  it('uses a stable bounded hash allocation seed per worktree', () => {
    const first = worktreePortOffset('/tmp/one')
    expect(first).toBe(worktreePortOffset('/tmp/one'))
    expect(first).toBeGreaterThanOrEqual(1)
    expect(first).toBeLessThanOrEqual(3000)
    expect(first).not.toBe(worktreePortOffset('/tmp/two'))
  })

  it('scans forward until both ports in a pair are available', async () => {
    const checked: number[] = []
    const ports = await findAvailableDevPorts(10, (port) => {
      checked.push(port)
      return Promise.resolve(port !== BASE_WEB_PORT + 10)
    })

    expect(ports).toEqual({
      daemonPort: BASE_DAEMON_PORT + 12,
      webPort: BASE_WEB_PORT + 12,
    })
    expect(checked).toEqual([
      BASE_DAEMON_PORT + 10,
      BASE_WEB_PORT + 10,
      BASE_DAEMON_PORT + 11,
      BASE_WEB_PORT + 11,
      BASE_DAEMON_PORT + 12,
      BASE_WEB_PORT + 12,
    ])
  })

  it('resolves state as flag before worktree before ambient', () => {
    expect(
      resolveDevStateHome({
        explicitStateHome: '/flag',
        worktreeStateHome: '/worktree',
        ambientStateHome: '/ambient',
      })
    ).toBe('/flag')
    expect(
      resolveDevStateHome({
        worktreeStateHome: '/worktree',
        ambientStateHome: '/ambient',
      })
    ).toBe('/worktree')
    expect(resolveDevStateHome({ ambientStateHome: '/ambient' })).toBe(
      '/ambient'
    )
  })

  it('isolates a linked worktree in its own state home', () => {
    const worktree = mkdtempSync(join(tmpdir(), 'laborer-dev-runner-'))
    try {
      writeFileSync(
        join(worktree, '.git'),
        'gitdir: /repo/.git/worktrees/feature\n'
      )
      expect(linkedWorktreeStateHome(worktree)).toBe(
        join(worktree, '.laborer-state')
      )
    } finally {
      rmSync(worktree, { force: true, recursive: true })
    }
  })

  it('offers an explicit opt-in to ambient real state', () => {
    expect(parseDevRunnerArguments(['--use-real-state'])).toEqual({
      stateHome: undefined,
      useRealState: true,
      dryRun: false,
    })
  })

  it('runs the built daemon under Bun watch as a direct runner child', () => {
    const root = '/repo'
    const children = devChildDefinitions(root)
    expect(children.find(({ label }) => label === 'daemon')).toEqual({
      label: 'daemon',
      command: [
        'bun',
        '--watch',
        join(root, 'packages/server/dist/daemon-main.mjs'),
      ],
      cwd: root,
    })
    expect(children.find(({ label }) => label === 'web')?.command).toContain(
      '--open'
    )
  })

  it('stops sibling watchers when any required child exits', async () => {
    const signals: string[] = []
    let stopSibling: ((exitCode: number) => void) | undefined
    const siblingExited = new Promise<number>((complete) => {
      stopSibling = complete
    })
    const result = await superviseDevChildren(
      [
        {
          definition: { label: 'web', command: ['vite'], cwd: '/repo' },
          process: {
            exited: Promise.resolve(1),
            kill: (signal) => signals.push(`web:${String(signal)}`),
          },
        },
        {
          definition: { label: 'daemon', command: ['bun'], cwd: '/repo' },
          process: {
            exited: siblingExited,
            kill: (signal) => {
              signals.push(`daemon:${String(signal)}`)
              stopSibling?.(0)
            },
          },
        },
      ],
      100
    )

    expect(result.firstExit).toEqual({
      definition: { label: 'web', command: ['vite'], cwd: '/repo' },
      exitCode: 1,
    })
    expect(signals).toContain('daemon:SIGTERM')
  })
})
