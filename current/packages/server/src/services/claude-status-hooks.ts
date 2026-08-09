import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentStatus } from '@laborer/shared/rpc'

interface ClaudeStatusReport {
  readonly sequence: number
  readonly status: AgentStatus
}

type ClaudeReportedStatus = Exclude<AgentStatus, 'unknown'>

interface ClaudeHookEnvironment {
  readonly LABORER_HOOK_URL?: string
  readonly LABORER_TERMINAL_ID?: string
}

interface RunClaudeStatusHookOptions {
  readonly environment?: ClaudeHookEnvironment
  readonly fetch?: typeof fetch
  readonly lockTimeoutMs?: number
  readonly now?: () => number
  readonly stateDirectory?: string
}

interface WriteClaudeStatusHooksOptions {
  readonly directory?: string
}

interface ClaudeHookCommand {
  readonly command: string
  readonly timeout: number
  readonly type: 'command'
}

interface ClaudeHookEntry {
  readonly hooks: readonly ClaudeHookCommand[]
  readonly matcher: string
}

interface ClaudeStatusHooksSettings {
  readonly hooks: Readonly<
    Record<
      'Notification' | 'SessionStart' | 'Stop' | 'UserPromptSubmit',
      readonly ClaudeHookEntry[]
    >
  >
}

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'\\''`)}'`

/**
 * One Claude hook invocation. The sequence allocator is filesystem-backed
 * because Claude starts a fresh command process for every hook event.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this function is embedded as a self-contained hook runtime.
async function runClaudeStatusHook(
  status: AgentStatus,
  options: RunClaudeStatusHookOptions = {}
): Promise<ClaudeStatusReport | null> {
  if (!['working', 'needs_input', 'idle'].includes(status)) {
    return null
  }

  const environment = options.environment ?? process.env
  const hookUrl = environment.LABORER_HOOK_URL
  const terminalId = environment.LABORER_TERMINAL_ID
  if (!(hookUrl && terminalId)) {
    return null
  }

  const [{ createHash }, fs, os, path] = await Promise.all([
    import('node:crypto'),
    import('node:fs'),
    import('node:os'),
    import('node:path'),
  ])
  const stateDirectory =
    options.stateDirectory ?? path.join(os.tmpdir(), 'laborer-agent-hooks')
  fs.mkdirSync(stateDirectory, { mode: 0o700, recursive: true })
  const identity = createHash('sha256').update(terminalId).digest('hex')
  const sequencePath = path.join(stateDirectory, `${identity}.sequence`)
  const lockPath = `${sequencePath}.lock`
  const lockOwner = String(process.pid)
  let lockStartedAt = Date.now()
  let recoveredStaleLock = false

  while (true) {
    try {
      // A symlink gives contenders an atomically-created lock together with
      // the owning PID, unlike a directory followed by a separate owner file.
      fs.symlinkSync(lockOwner, lockPath)
      break
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          'code' in error &&
          error.code === 'EEXIST'
        ) ||
        (Date.now() - lockStartedAt >= (options.lockTimeoutMs ?? 1000) &&
          recoveredStaleLock)
      ) {
        return null
      }
      if (Date.now() - lockStartedAt >= (options.lockTimeoutMs ?? 1000)) {
        let ownerPid: number | undefined
        try {
          const parsed = Number(fs.readlinkSync(lockPath))
          if (Number.isSafeInteger(parsed) && parsed > 0) {
            ownerPid = parsed
          }
        } catch {
          // Older generated hooks used a lock directory without owner data.
          // They held it only around synchronous sequence-file operations.
        }

        if (ownerPid !== undefined) {
          try {
            process.kill(ownerPid, 0)
            return null
          } catch (ownerError) {
            if (
              !(
                ownerError instanceof Error &&
                'code' in ownerError &&
                ownerError.code === 'ESRCH'
              )
            ) {
              return null
            }
          }
        }

        // Only a dead owner (or a legacy ownerless lock) may be displaced.
        fs.rmSync(lockPath, { force: true, recursive: true })
        recoveredStaleLock = true
        lockStartedAt = Date.now()
        continue
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
    }
  }

  let sequence: number
  try {
    let previous = -1
    try {
      const parsed = Number(fs.readFileSync(sequencePath, 'utf8'))
      if (Number.isSafeInteger(parsed)) {
        previous = parsed
      }
    } catch {
      // The first event has no sequence file yet.
    }
    sequence = Math.max((options.now ?? Date.now)() * 1000, previous + 1)
    const temporaryPath = `${sequencePath}.${String(process.pid)}.tmp`
    fs.writeFileSync(temporaryPath, String(sequence), 'utf8')
    fs.renameSync(temporaryPath, sequencePath)
  } finally {
    try {
      if (fs.readlinkSync(lockPath) === lockOwner) {
        fs.rmSync(lockPath, { force: true })
      }
    } catch {
      // The lock was already absent or no longer belongs to this invocation.
    }
  }

  const report = { sequence, status }
  try {
    await (options.fetch ?? fetch)(hookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ terminalId, ...report }),
      signal: AbortSignal.timeout(1000),
    })
  } catch {
    // Status is advisory. A later lifecycle event gets another attempt.
  }
  return report
}

const claudeStatusHookSource =
  (): string => `// generated and managed by Laborer
const runClaudeStatusHook = ${runClaudeStatusHook.toString()};
await runClaudeStatusHook(process.argv[2]);
`

const hookEntry = (
  scriptPath: string,
  status: ClaudeReportedStatus
): ClaudeHookEntry => ({
  matcher: '',
  hooks: [
    {
      type: 'command',
      command: `node ${shellQuote(scriptPath)} ${status}`,
      timeout: 10,
    },
  ],
})

/** Map Claude's native lifecycle events to Laborer's semantic status model. */
const buildClaudeStatusHooksSettings = (
  scriptPath: string
): ClaudeStatusHooksSettings => ({
  hooks: {
    SessionStart: [hookEntry(scriptPath, 'working')],
    UserPromptSubmit: [hookEntry(scriptPath, 'working')],
    Notification: [
      {
        ...hookEntry(scriptPath, 'needs_input'),
        matcher: '^(permission_prompt|idle_prompt)$',
      },
    ],
    Stop: [hookEntry(scriptPath, 'idle')],
  },
})

/** Write the managed hook runtime and per-terminal Claude settings. */
const writeClaudeStatusHooks = (
  terminalId: string,
  options: WriteClaudeStatusHooksOptions = {}
): string => {
  const directory = options.directory ?? join(tmpdir(), 'laborer-agent-hooks')
  mkdirSync(directory, { mode: 0o700, recursive: true })

  const scriptPath = join(directory, 'claude-agent-status.mjs')
  const temporaryScriptPath = `${scriptPath}.${String(process.pid)}.tmp`
  try {
    writeFileSync(temporaryScriptPath, claudeStatusHookSource(), 'utf8')
    renameSync(temporaryScriptPath, scriptPath)
  } finally {
    rmSync(temporaryScriptPath, { force: true })
  }

  const settingsPath = join(directory, `${terminalId}.json`)
  const temporarySettingsPath = `${settingsPath}.${String(process.pid)}.tmp`
  try {
    writeFileSync(
      temporarySettingsPath,
      JSON.stringify(buildClaudeStatusHooksSettings(scriptPath)),
      { encoding: 'utf8', mode: 0o600 }
    )
    renameSync(temporarySettingsPath, settingsPath)
  } finally {
    rmSync(temporarySettingsPath, { force: true })
  }
  return settingsPath
}

export {
  buildClaudeStatusHooksSettings,
  type ClaudeStatusHooksSettings,
  type ClaudeStatusReport,
  claudeStatusHookSource,
  runClaudeStatusHook,
  type RunClaudeStatusHookOptions,
  writeClaudeStatusHooks,
  type WriteClaudeStatusHooksOptions,
}
