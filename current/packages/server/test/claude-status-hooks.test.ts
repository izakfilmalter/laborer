import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildClaudeStatusHooksSettings,
  type ClaudeStatusHooksSettings,
  type ClaudeStatusReport,
  runClaudeStatusHook,
  writeClaudeStatusHooks,
} from '../src/services/claude-status-hooks.js'

const commandStatus = (
  settings: ClaudeStatusHooksSettings,
  event: keyof ClaudeStatusHooksSettings['hooks']
): string => {
  const command = settings.hooks[event]?.[0]?.hooks[0]?.command
  return command?.split(' ').at(-1) ?? ''
}

describe('Claude status hook adapter', () => {
  it('maps the persistent interactive CLI lifecycle to semantic statuses', () => {
    const settings = buildClaudeStatusHooksSettings('/tmp/laborer hook.mjs')
    const lifecycleEvents = [
      'SessionStart',
      'Stop',
      'UserPromptSubmit',
      'Stop',
    ] as const

    expect(
      lifecycleEvents.map((event) => commandStatus(settings, event))
    ).toEqual(['working', 'idle', 'working', 'idle'])
    expect(commandStatus(settings, 'Notification')).toBe('needs_input')
    expect(settings.hooks.Notification?.[0]?.matcher).toBe(
      '^(permission_prompt|idle_prompt)$'
    )
  })

  it('allocates monotonic reports across separate hook invocations', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'laborer-claude-hooks-'))
    const reports: ClaudeStatusReport[] = []
    const fakeFetch = ((_input, init) => {
      reports.push(
        JSON.parse(String(init?.body)) as ClaudeStatusReport & {
          terminalId: string
        }
      )
      return Promise.resolve(new Response(null, { status: 200 }))
    }) satisfies typeof fetch
    const options = {
      environment: {
        LABORER_HOOK_URL: 'http://127.0.0.1/hook/agent-status',
        LABORER_TERMINAL_ID: 'terminal-1',
      },
      fetch: fakeFetch,
      now: () => 100,
      stateDirectory: directory,
    }

    try {
      await runClaudeStatusHook('working', options)
      await runClaudeStatusHook('needs_input', options)
      await runClaudeStatusHook('idle', options)

      expect(reports.map(({ status }) => status)).toEqual([
        'working',
        'needs_input',
        'idle',
      ])
      expect(reports.map(({ sequence }) => sequence)).toEqual([
        100_000, 100_001, 100_002,
      ])
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  it('recovers sequence allocation after a killed invocation leaves a lock', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'laborer-claude-hooks-'))
    const terminalId = 'terminal-with-stale-lock'
    const identity = createHash('sha256').update(terminalId).digest('hex')
    symlinkSync('99999999', join(directory, `${identity}.sequence.lock`))

    try {
      const report = await runClaudeStatusHook('working', {
        environment: {
          LABORER_HOOK_URL: 'http://127.0.0.1/hook/agent-status',
          LABORER_TERMINAL_ID: terminalId,
        },
        fetch: () => Promise.resolve(new Response(null, { status: 200 })),
        lockTimeoutMs: 0,
        stateDirectory: directory,
      })

      expect(report?.status).toBe('working')
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  it('does not displace a lock held by a live hook invocation', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'laborer-claude-hooks-'))
    const terminalId = 'terminal-with-live-lock'
    const identity = createHash('sha256').update(terminalId).digest('hex')
    const lockPath = join(directory, `${identity}.sequence.lock`)
    symlinkSync(String(process.pid), lockPath)

    try {
      const report = await runClaudeStatusHook('idle', {
        environment: {
          LABORER_HOOK_URL: 'http://127.0.0.1/hook/agent-status',
          LABORER_TERMINAL_ID: terminalId,
        },
        lockTimeoutMs: 0,
        stateDirectory: directory,
      })

      expect(report).toBeNull()
      expect(readlinkSync(lockPath)).toBe(String(process.pid))
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  it('writes a self-contained runtime and settings file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'laborer-claude-hooks-'))
    try {
      const settingsPath = writeClaudeStatusHooks('terminal-1', { directory })
      const settingsText = readFileSync(settingsPath, 'utf8')
      const command = buildClaudeStatusHooksSettings(
        join(directory, 'claude-agent-status.mjs')
      ).hooks.SessionStart[0]?.hooks[0]?.command

      expect(command).toContain("claude-agent-status.mjs'")
      expect(command?.endsWith(' working')).toBe(true)
      expect(JSON.parse(settingsText)).toEqual(
        buildClaudeStatusHooksSettings(
          join(directory, 'claude-agent-status.mjs')
        )
      )
      const scriptPath = join(directory, 'claude-agent-status.mjs')
      expect(readFileSync(scriptPath, 'utf8')).toContain(
        'await runClaudeStatusHook(process.argv[2])'
      )
      execFileSync(process.execPath, ['--check', scriptPath])
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })
})
