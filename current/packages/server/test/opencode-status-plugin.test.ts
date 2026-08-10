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

/** A located v2 event: fields under `data`, envelope carries the directory. */
const located = (
  type: string,
  data: Record<string, unknown>,
  directory = '/workspace/repo'
) => ({
  type,
  data,
  location: { directory },
})

/**
 * An unlocated v2 event. `session.execution.*` and `session.retry.scheduled`
 * arrive with no envelope location on real daemons.
 */
const unlocated = (type: string, data: Record<string, unknown>) => ({
  type,
  data,
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
  it('derives working and idle from the execution lifecycle with per-session attribution', async () => {
    const reports: OpenCodeStatusReport[] = []
    const runtime = createOpenCodeStatusPluginRuntime((report) => {
      reports.push(report)
      return Promise.resolve()
    })

    runtime.handleEvent(located('session.step.started', { sessionID: 'root' }))
    await flush()
    // Repeat steps of the same run must not spam duplicate reports.
    runtime.handleEvent(located('session.step.started', { sessionID: 'root' }))
    await flush()
    // Execution events arrive without a location on real daemons.
    runtime.handleEvent(
      unlocated('session.execution.succeeded', { sessionID: 'root' })
    )
    await flush()

    expect(reports.map(({ status }) => status)).toEqual(['working', 'idle'])
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

  it('buffers unlocated busy sessions until a located event reveals their directory', async () => {
    const reports: OpenCodeStatusReport[] = []
    const runtime = createOpenCodeStatusPluginRuntime((report) => {
      reports.push(report)
      return Promise.resolve()
    })

    runtime.handleEvent(
      unlocated('session.execution.started', { sessionID: 'root' })
    )
    await flush()
    expect(reports).toEqual([])

    runtime.handleEvent(
      located('session.step.started', { sessionID: 'root' }, '/workspace/known')
    )
    await flush()

    expect(reports).toHaveLength(1)
    expect(reports[0]?.status).toBe('working')
    expect(reports[0]?.directory).toBe('/workspace/known')
  })

  it('keeps the terminal working while subagent sessions in the directory finish', async () => {
    const reports: OpenCodeStatusReport[] = []
    const runtime = createOpenCodeStatusPluginRuntime((report) => {
      reports.push(report)
      return Promise.resolve()
    })

    runtime.handleEvent(located('session.step.started', { sessionID: 'root' }))
    await flush()
    runtime.handleEvent(located('session.step.started', { sessionID: 'child' }))
    await flush()
    // The child finishing must not flip the still-working terminal to idle.
    runtime.handleEvent(
      unlocated('session.execution.succeeded', { sessionID: 'child' })
    )
    await flush()
    expect(reports.map(({ status }) => status)).toEqual(['working'])

    runtime.handleEvent(
      unlocated('session.execution.succeeded', { sessionID: 'root' })
    )
    await flush()
    expect(reports.map(({ status }) => status)).toEqual(['working', 'idle'])
  })

  it('attributes the daemon-wide firehose across directories independently', async () => {
    const reports: OpenCodeStatusReport[] = []
    const runtime = createOpenCodeStatusPluginRuntime((report) => {
      reports.push(report)
      return Promise.resolve()
    })

    runtime.handleEvent(
      located('session.step.started', { sessionID: 'a' }, '/workspace/alpha')
    )
    await flush()
    runtime.handleEvent(
      located('session.step.started', { sessionID: 'b' }, '/workspace/beta')
    )
    await flush()
    runtime.handleEvent(
      unlocated('session.execution.succeeded', { sessionID: 'a' })
    )
    await flush()

    expect(
      reports.map(({ directory, status }) => ({ directory, status }))
    ).toEqual([
      { directory: '/workspace/alpha', status: 'working' },
      { directory: '/workspace/beta', status: 'working' },
      { directory: '/workspace/alpha', status: 'idle' },
    ])
  })

  it('flags blocked agents as needs_input and resumes working after replies', async () => {
    const reports: OpenCodeStatusReport[] = []
    const runtime = createOpenCodeStatusPluginRuntime((report) => {
      reports.push(report)
      return Promise.resolve()
    })

    runtime.handleEvent(located('session.step.started', { sessionID: 'root' }))
    await flush()
    runtime.handleEvent(unlocated('permission.asked', { sessionID: 'root' }))
    await flush()
    runtime.handleEvent(unlocated('permission.replied', { sessionID: 'root' }))
    await flush()
    runtime.handleEvent(unlocated('question.asked', { sessionID: 'root' }))
    await flush()
    runtime.handleEvent(unlocated('question.rejected', { sessionID: 'root' }))
    await flush()

    expect(reports.map(({ status }) => status)).toEqual([
      'working',
      'needs_input',
      'working',
      'needs_input',
      'working',
    ])
  })

  it('reports needs_input when the last session in a directory fails', async () => {
    const reports: OpenCodeStatusReport[] = []
    const runtime = createOpenCodeStatusPluginRuntime((report) => {
      reports.push(report)
      return Promise.resolve()
    })

    runtime.handleEvent(located('session.step.started', { sessionID: 'root' }))
    await flush()
    runtime.handleEvent(
      unlocated('session.execution.failed', { sessionID: 'root' })
    )
    await flush()

    expect(reports.map(({ status }) => status)).toEqual([
      'working',
      'needs_input',
    ])
  })

  it('maps session.status if a future daemon emits it', async () => {
    const reports: OpenCodeStatusReport[] = []
    const runtime = createOpenCodeStatusPluginRuntime((report) => {
      reports.push(report)
      return Promise.resolve()
    })

    runtime.handleEvent(
      located('session.status', {
        sessionID: 'root',
        status: { type: 'busy' },
      })
    )
    await flush()
    runtime.handleEvent(
      located('session.status', {
        sessionID: 'root',
        status: { type: 'idle' },
      })
    )
    await flush()

    expect(reports.map(({ status }) => status)).toEqual(['working', 'idle'])
  })

  it('serializes delivery and coalesces queued reports to the newest fact per directory', async () => {
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

    runtime.handleEvent(located('session.step.started', { sessionID: 'root' }))
    runtime.handleEvent(unlocated('permission.asked', { sessionID: 'root' }))
    runtime.handleEvent(
      unlocated('session.execution.succeeded', { sessionID: 'root' })
    )

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

    queue.push(located('session.step.started', { sessionID: 'root' }))
    await flush()
    expect(reports.map(({ status }) => status)).toEqual(['working'])

    cleanup()
    queue.push(unlocated('session.execution.succeeded', { sessionID: 'root' }))
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
