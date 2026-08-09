import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createOpenCodeStatusPluginRuntime,
  installOpenCodeStatusPlugin,
  type OpenCodeStatusReport,
} from '../src/services/opencode-status-plugin.js'

const nativeEvent = (
  type: string,
  sessionID: string,
  extra: Record<string, unknown> = {}
) => ({ event: { type, properties: { sessionID, ...extra } } })

describe('OpenCode status plugin adapter', () => {
  it('maps native root lifecycle events to semantic agent statuses', async () => {
    const reports: OpenCodeStatusReport[] = []
    const plugin = createOpenCodeStatusPluginRuntime((report) => {
      reports.push(report)
      return Promise.resolve()
    })

    await plugin.event(
      nativeEvent('session.status', 'root', { status: { type: 'busy' } })
    )
    await plugin.event(
      nativeEvent('session.status', 'root', { status: 'streaming' })
    )
    await plugin.event(nativeEvent('permission.asked', 'root'))
    await plugin.event(nativeEvent('session.error', 'root'))
    await plugin.event(nativeEvent('session.idle', 'root'))

    expect(reports.map(({ status }) => status)).toEqual([
      'working',
      'working',
      'needs_input',
      'needs_input',
      'idle',
    ])
    expect(reports.map(({ sequence }) => sequence)).toEqual(
      reports.map(({ sequence }) => sequence).toSorted((a, b) => a - b)
    )
    expect(new Set(reports.map(({ sequence }) => sequence)).size).toBe(5)
  })

  it('ignores child completion, errors, and permission events', async () => {
    const reports: OpenCodeStatusReport[] = []
    const plugin = createOpenCodeStatusPluginRuntime((report) => {
      reports.push(report)
      return Promise.resolve()
    })

    await plugin.event(
      nativeEvent('session.status', 'root', { status: { type: 'busy' } })
    )
    await plugin.event(
      nativeEvent('session.created', 'child', {
        info: { id: 'child', parentID: 'root' },
      })
    )
    await plugin.event(nativeEvent('permission.asked', 'child'))
    await plugin.event(nativeEvent('session.error', 'child'))
    await plugin.event(nativeEvent('session.idle', 'child'))

    expect(reports.map(({ status }) => status)).toEqual(['working'])
  })

  it('follows an explicitly created replacement root session', async () => {
    const reports: OpenCodeStatusReport[] = []
    const plugin = createOpenCodeStatusPluginRuntime((report) => {
      reports.push(report)
      return Promise.resolve()
    })

    await plugin.event(
      nativeEvent('session.status', 'first-root', { status: 'busy' })
    )
    await plugin.event(
      nativeEvent('session.created', 'second-root', {
        info: { id: 'second-root' },
      })
    )
    await plugin.event(nativeEvent('session.idle', 'first-root'))
    await plugin.event(nativeEvent('session.idle', 'second-root'))

    expect(reports.map(({ status }) => status)).toEqual(['working', 'idle'])
  })

  it('serializes delivery and coalesces queued reports to the newest fact', async () => {
    const reports: OpenCodeStatusReport[] = []
    let releaseFirst: (() => void) | undefined
    const plugin = createOpenCodeStatusPluginRuntime(
      (report) =>
        new Promise((resolve) => {
          reports.push(report)
          if (reports.length === 1) {
            releaseFirst = resolve
          } else {
            resolve()
          }
        })
    )

    const working = plugin.event(
      nativeEvent('session.status', 'root', { status: 'busy' })
    )
    const blocked = plugin.event(nativeEvent('permission.asked', 'root'))
    const idle = plugin.event(nativeEvent('session.idle', 'root'))

    await Promise.resolve()
    expect(reports.map(({ status }) => status)).toEqual(['working'])
    releaseFirst?.()
    await Promise.all([working, blocked, idle])

    expect(reports.map(({ status }) => status)).toEqual(['working', 'idle'])
    expect(reports[1]?.sequence).toBe((reports[0]?.sequence ?? 0) + 1)
  })
})

describe('OpenCode status plugin installer', () => {
  it('installs the managed plugin in an existing user config at startup', () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), 'laborer-opencode-'))
    try {
      const configDirectory = join(homeDirectory, '.config', 'opencode')
      mkdirSync(configDirectory, { recursive: true })

      const pluginPath = installOpenCodeStatusPlugin({ homeDirectory })

      expect(pluginPath).toBe(
        join(configDirectory, 'plugins', 'laborer-agent-status.js')
      )
      expect(pluginPath === null ? false : existsSync(pluginPath)).toBe(true)
      expect(readFileSync(pluginPath ?? '', 'utf8')).toContain(
        'export const LaborerAgentStatusPlugin'
      )
    } finally {
      rmSync(homeDirectory, { force: true, recursive: true })
    }
  })

  it('does not create OpenCode config for users who have none', () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), 'laborer-opencode-'))
    try {
      expect(installOpenCodeStatusPlugin({ homeDirectory })).toBeNull()
      expect(existsSync(join(homeDirectory, '.config', 'opencode'))).toBe(false)
    } finally {
      rmSync(homeDirectory, { force: true, recursive: true })
    }
  })
})
