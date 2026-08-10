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
  writeAgentHookDiscovery,
} from '../src/services/opencode-status-plugin.js'

/** Build an OpenCode v2 event payload: fields under `data`, envelope location. */
const v2Event = (
  type: string,
  data: Record<string, unknown> = {},
  directory = '/workspace/repo'
) => ({
  type,
  data,
  location: { directory },
})

/** Let queued microtasks and the runtime's send drain settle. */
const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0))

/** Async iterable queue standing in for `context.event.subscribe()`. */
const eventQueue = () => {
  const buffered: unknown[] = []
  let waiter: ((next: IteratorResult<unknown>) => void) | undefined
  let closed = false
  return {
    push: (event: unknown) => {
      if (waiter !== undefined) {
        const resolve = waiter
        waiter = undefined
        resolve({ done: false, value: event })
        return
      }
      buffered.push(event)
    },
    iterable: {
      [Symbol.asyncIterator]: (): AsyncIterator<unknown> => ({
        next: () =>
          new Promise<IteratorResult<unknown>>((resolve) => {
            if (buffered.length > 0) {
              resolve({ done: false, value: buffered.shift() })
              return
            }
            if (closed) {
              resolve({ done: true, value: undefined })
              return
            }
            waiter = resolve
          }),
        return: () => {
          closed = true
          const pendingWaiter = waiter
          waiter = undefined
          pendingWaiter?.({ done: true, value: undefined })
          return Promise.resolve({ done: true, value: undefined })
        },
      }),
    } satisfies AsyncIterable<unknown>,
  }
}

describe('OpenCode v2 status plugin runtime', () => {
  it('maps v2 lifecycle events to semantic agent statuses with directory attribution', async () => {
    const reports: OpenCodeStatusReport[] = []
    const runtime = createOpenCodeStatusPluginRuntime((report) => {
      reports.push(report)
      return Promise.resolve()
    })

    runtime.handleEvent(
      v2Event('session.status', { sessionID: 'root', status: { type: 'busy' } })
    )
    await flush()
    runtime.handleEvent(
      v2Event('session.status', {
        sessionID: 'root',
        status: { type: 'retry', attempt: 1 },
      })
    )
    await flush()
    runtime.handleEvent(v2Event('permission.asked', { sessionID: 'root' }))
    await flush()
    runtime.handleEvent(v2Event('question.asked', { sessionID: 'root' }))
    await flush()
    runtime.handleEvent(
      v2Event('session.status', { sessionID: 'root', status: { type: 'idle' } })
    )
    await flush()
    runtime.handleEvent(v2Event('session.idle', { sessionID: 'root' }))
    await flush()

    expect(reports.map(({ status }) => status)).toEqual([
      'working',
      'working',
      'needs_input',
      'needs_input',
      'idle',
      'idle',
    ])
    expect(
      reports.every(({ directory }) => directory === '/workspace/repo')
    ).toBe(true)
    expect(reports.map(({ sequence }) => sequence)).toEqual(
      reports.map(({ sequence }) => sequence).toSorted((a, b) => a - b)
    )
    expect(new Set(reports.map(({ sequence }) => sequence)).size).toBe(
      reports.length
    )
  })

  it('ignores child (subagent) session lifecycle events', async () => {
    const reports: OpenCodeStatusReport[] = []
    const runtime = createOpenCodeStatusPluginRuntime((report) => {
      reports.push(report)
      return Promise.resolve()
    })

    runtime.handleEvent(
      v2Event('session.status', { sessionID: 'root', status: { type: 'busy' } })
    )
    await flush()
    runtime.handleEvent(
      v2Event('session.created', { sessionID: 'child', parentID: 'root' })
    )
    runtime.handleEvent(v2Event('permission.asked', { sessionID: 'child' }))
    runtime.handleEvent(
      v2Event('session.status', {
        sessionID: 'child',
        status: { type: 'idle' },
      })
    )
    await flush()

    expect(reports.map(({ status }) => status)).toEqual(['working'])
  })

  it('drops reports until a directory is known, then attributes to it', async () => {
    const reports: OpenCodeStatusReport[] = []
    const runtime = createOpenCodeStatusPluginRuntime((report) => {
      reports.push(report)
      return Promise.resolve()
    })

    runtime.handleEvent({
      type: 'session.status',
      data: { sessionID: 'root', status: { type: 'busy' } },
    })
    await flush()
    expect(reports).toEqual([])

    runtime.handleEvent(
      v2Event(
        'session.status',
        { sessionID: 'root', status: { type: 'busy' } },
        '/workspace/known'
      )
    )
    await flush()

    expect(reports.map(({ directory }) => directory)).toEqual([
      '/workspace/known',
    ])
  })

  it('serializes delivery and coalesces queued reports to the newest fact', async () => {
    const reports: OpenCodeStatusReport[] = []
    let releaseFirst: (() => void) | undefined
    const runtime = createOpenCodeStatusPluginRuntime(
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

    runtime.handleEvent(
      v2Event('session.status', { sessionID: 'root', status: { type: 'busy' } })
    )
    runtime.handleEvent(v2Event('permission.asked', { sessionID: 'root' }))
    runtime.handleEvent(v2Event('session.idle', { sessionID: 'root' }))

    await flush()
    expect(reports.map(({ status }) => status)).toEqual(['working'])
    releaseFirst?.()
    await flush()

    expect(reports.map(({ status }) => status)).toEqual(['working', 'idle'])
    expect(reports[1]?.sequence).toBe((reports[0]?.sequence ?? 0) + 1)
  })

  it('consumes the event stream from setup and stops on cleanup', async () => {
    const reports: OpenCodeStatusReport[] = []
    const runtime = createOpenCodeStatusPluginRuntime(
      (report) => {
        reports.push(report)
        return Promise.resolve()
      },
      { resubscribeDelayMs: 1 }
    )
    const queue = eventQueue()
    const cleanup = runtime.setup({
      event: { subscribe: () => queue.iterable },
    })

    queue.push(
      v2Event('session.status', { sessionID: 'root', status: { type: 'busy' } })
    )
    await flush()
    expect(reports.map(({ status }) => status)).toEqual(['working'])

    cleanup()
    queue.push(v2Event('session.idle', { sessionID: 'root' }))
    await flush()
    expect(reports.map(({ status }) => status)).toEqual(['working'])
  })
})

describe('OpenCode status plugin installer', () => {
  it('installs a v2 default-export plugin in an existing user config', () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), 'laborer-opencode-'))
    try {
      const configDirectory = join(homeDirectory, '.config', 'opencode')
      mkdirSync(configDirectory, { recursive: true })

      const pluginPath = installOpenCodeStatusPlugin({ homeDirectory })

      expect(pluginPath).toBe(
        join(configDirectory, 'plugins', 'laborer-agent-status.js')
      )
      expect(pluginPath === null ? false : existsSync(pluginPath)).toBe(true)
      const source = readFileSync(pluginPath ?? '', 'utf8')
      expect(source).toContain('export default')
      expect(source).toContain('laborer-agent-status')
      expect(source).toContain('agent-hook.json')
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

describe('agent hook discovery file', () => {
  it('writes the hook URL where the OpenCode daemon plugin can find it', () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), 'laborer-discovery-'))
    try {
      const discoveryPath = writeAgentHookDiscovery(
        'http://127.0.0.1:53185/hook/agent-status',
        { homeDirectory }
      )

      expect(discoveryPath).toBe(
        join(homeDirectory, '.config', 'laborer', 'agent-hook.json')
      )
      const contents = JSON.parse(readFileSync(discoveryPath, 'utf8'))
      expect(contents.url).toBe('http://127.0.0.1:53185/hook/agent-status')
    } finally {
      rmSync(homeDirectory, { force: true, recursive: true })
    }
  })
})
