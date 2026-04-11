/** biome-ignore-all lint: terminal process orchestration is intentionally stateful and imperative. */
import { spawn } from 'node:child_process'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type TerminalClearInput,
  type TerminalCloseInput,
  TerminalCwdError,
  type TerminalEvent,
  TerminalNotRunningError,
  type TerminalOpenInput,
  type TerminalResizeInput,
  type TerminalRestartInput,
  TerminalSessionLookupError,
  type TerminalSessionSnapshot,
  type TerminalWriteInput,
} from '@laborer/contracts/terminal'
import { Context, Effect, Layer, Match, Stream } from 'effect'
import { type IPty, spawn as spawnPty } from 'node-pty'

const DEFAULT_TERMINAL_HISTORY_DIRECTORY = fileURLToPath(
  new URL('../.terminal-history', import.meta.url)
)
const TERMINAL_HISTORY_DIRECTORY =
  process.env.LABORER_TERMINAL_HISTORY_DIRECTORY?.trim() ||
  DEFAULT_TERMINAL_HISTORY_DIRECTORY

const DEFAULT_HISTORY_LINE_LIMIT = 5000
const DEFAULT_PERSIST_DEBOUNCE_MS = 40
const DEFAULT_SUBPROCESS_POLL_INTERVAL_MS = 1000
const DEFAULT_TERMINAL_COLS = 120
const DEFAULT_TERMINAL_ROWS = 30
const TERMINAL_ENV_BLOCKLIST = new Set([
  'PORT',
  'ELECTRON_RENDERER_PORT',
  'ELECTRON_RUN_AS_NODE',
])

interface TerminalManagerShape {
  readonly clear: (input: TerminalClearInput) => Effect.Effect<void, unknown>
  readonly close: (input: TerminalCloseInput) => Effect.Effect<void, unknown>
  readonly events: Stream.Stream<TerminalEvent>
  readonly open: (
    input: TerminalOpenInput
  ) => Effect.Effect<TerminalSessionSnapshot, unknown>
  readonly resize: (input: TerminalResizeInput) => Effect.Effect<void, unknown>
  readonly restart: (
    input: TerminalRestartInput
  ) => Effect.Effect<TerminalSessionSnapshot, unknown>
  readonly write: (input: TerminalWriteInput) => Effect.Effect<void, unknown>
}

interface TerminalSessionState {
  cols: number
  cwd: TerminalSessionSnapshot['cwd']
  exitCode: number | null
  exitSignal: number | null
  hasRunningSubprocess: boolean
  history: string
  pendingHistoryControlSequence: string
  persistTimeout: NodeJS.Timeout | null
  process: IPty | null
  rows: number
  status: TerminalSessionSnapshot['status']
  readonly terminalId: TerminalSessionSnapshot['terminalId']
  unsubscribeData: (() => void) | null
  unsubscribeExit: (() => void) | null
  updatedAt: string
  readonly workspaceId: TerminalSessionSnapshot['workspaceId']
}

type TerminalEventListener = (event: TerminalEvent) => void

export class TerminalManager extends Context.Tag(
  '@laborer/server/TerminalManager'
)<TerminalManager, TerminalManagerShape>() {
  static readonly layer = Layer.scoped(this, makeTerminalManager())
}

function makeTerminalManager() {
  return Effect.gen(function* () {
    yield* Effect.tryPromise(() =>
      mkdir(TERMINAL_HISTORY_DIRECTORY, { recursive: true })
    )

    const listeners = new Set<TerminalEventListener>()
    const sessions = new Map<string, TerminalSessionState>()

    const emitEvent = (event: TerminalEvent) => {
      for (const listener of listeners) {
        listener(event)
      }
    }

    const events = Stream.asyncPush<TerminalEvent>((emit) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const listener: TerminalEventListener = (event) => {
            emit.single(event)
          }
          listeners.add(listener)
          return listener
        }),
        (listener) =>
          Effect.sync(() => {
            listeners.delete(listener)
          })
      )
    )

    const stopAllSessions = async () => {
      for (const session of sessions.values()) {
        await persistHistory(session)
        clearPersistTimeout(session)
        stopProcess(session)
      }
      sessions.clear()
    }

    const activityInterval = setInterval(() => {
      void pollSubprocessActivity(sessions, emitEvent)
    }, DEFAULT_SUBPROCESS_POLL_INTERVAL_MS)
    activityInterval.unref?.()

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        clearInterval(activityInterval)
        await stopAllSessions()
      })
    )

    const open = Effect.fn('TerminalManager.open')(function* (
      input: TerminalOpenInput
    ) {
      yield* ensureDirectory(input.cwd)

      const key = toSessionKey(input.workspaceId, input.terminalId)
      const existing = sessions.get(key)

      if (existing) {
        existing.cols = input.cols ?? existing.cols
        existing.rows = input.rows ?? existing.rows
        existing.updatedAt = new Date().toISOString()

        if (existing.cwd !== input.cwd) {
          existing.cwd = input.cwd
          existing.history = ''
          existing.pendingHistoryControlSequence = ''
          yield* Effect.tryPromise(() => persistHistory(existing))
          stopProcess(existing)
          existing.process = null
          existing.unsubscribeData = null
          existing.unsubscribeExit = null
        }

        existing.status = existing.process ? existing.status : 'starting'
        existing.exitCode = existing.process ? existing.exitCode : null
        existing.exitSignal = existing.process ? existing.exitSignal : null
      }

      const session =
        existing ??
        createSession({
          cwd: input.cwd,
          terminalId: input.terminalId,
          workspaceId: input.workspaceId,
          cols: input.cols ?? DEFAULT_TERMINAL_COLS,
          rows: input.rows ?? DEFAULT_TERMINAL_ROWS,
          history: yield* Effect.tryPromise(() =>
            readHistory(input.workspaceId, input.terminalId)
          ),
        })

      session.cwd = input.cwd
      session.cols = input.cols ?? session.cols
      session.rows = input.rows ?? session.rows
      session.updatedAt = new Date().toISOString()
      sessions.set(key, session)

      if (!session.process) {
        yield* Effect.tryPromise({
          try: async () => {
            await startSession(session, emitEvent)
          },
          catch: (cause) =>
            TerminalCwdError.make({
              cwd: input.cwd,
              message: buildSpawnFailureMessage(input.cwd, cause),
              cause,
            }),
        })
      }

      return snapshot(session)
    })

    const write = Effect.fn('TerminalManager.write')(function* (
      input: TerminalWriteInput
    ) {
      const session = yield* lookupRunningSession(
        input.workspaceId,
        input.terminalId
      )

      yield* Effect.sync(() => {
        session.process?.write(input.data)
      })
    })

    const resize = Effect.fn('TerminalManager.resize')(function* (
      input: TerminalResizeInput
    ) {
      const session = yield* lookupRunningSession(
        input.workspaceId,
        input.terminalId
      )

      yield* Effect.sync(() => {
        session.cols = input.cols
        session.rows = input.rows
        session.process?.resize(input.cols, input.rows)
      })
    })

    const clear = Effect.fn('TerminalManager.clear')(function* (
      input: TerminalClearInput
    ) {
      const session = yield* lookupSession(input.workspaceId, input.terminalId)

      yield* Effect.tryPromise(() => {
        session.history = ''
        session.pendingHistoryControlSequence = ''
        session.updatedAt = new Date().toISOString()
        emitEvent(
          makeTerminalEvent(input.workspaceId, input.terminalId, {
            type: 'cleared',
          })
        )
        return persistHistory(session)
      })
    })

    const restart = Effect.fn('TerminalManager.restart')(function* (
      input: TerminalRestartInput
    ) {
      yield* ensureDirectory(input.cwd)

      const session = yield* lookupSession(input.workspaceId, input.terminalId)

      yield* Effect.tryPromise({
        try: async () => {
          session.cwd = input.cwd
          session.cols = input.cols
          session.history = ''
          session.pendingHistoryControlSequence = ''
          session.hasRunningSubprocess = false
          session.exitCode = null
          session.exitSignal = null
          session.updatedAt = new Date().toISOString()
          await persistHistory(session)
          stopProcess(session)
          await startSession(session, emitEvent, 'restarted')
        },
        catch: (cause) =>
          TerminalCwdError.make({
            cwd: input.cwd,
            message: buildSpawnFailureMessage(input.cwd, cause),
            cause,
          }),
      })

      return snapshot(session)
    })

    const close = Effect.fn('TerminalManager.close')(function* (
      input: TerminalCloseInput
    ) {
      const key = toSessionKey(input.workspaceId, input.terminalId)
      const session = sessions.get(key)

      if (!session) {
        return
      }

      yield* Effect.tryPromise(async () => {
        await persistHistory(session)
        clearPersistTimeout(session)
        stopProcess(session)
        sessions.delete(key)
      })
    })

    const lookupSession = Effect.fn('TerminalManager.lookupSession')(function* (
      workspaceId: TerminalSessionSnapshot['workspaceId'],
      terminalId: TerminalSessionSnapshot['terminalId']
    ) {
      const session = sessions.get(toSessionKey(workspaceId, terminalId))

      return yield* Effect.fromNullable(session).pipe(
        Effect.orElseFail(() =>
          TerminalSessionLookupError.make({
            workspaceId,
            terminalId,
            message: `Unknown terminal ${terminalId} for workspace ${workspaceId}.`,
          })
        )
      )
    })

    const lookupRunningSession = Effect.fn(
      'TerminalManager.lookupRunningSession'
    )(function* (
      workspaceId: TerminalSessionSnapshot['workspaceId'],
      terminalId: TerminalSessionSnapshot['terminalId']
    ) {
      const session = yield* lookupSession(workspaceId, terminalId)

      if (session.status !== 'running' || session.process === null) {
        yield* TerminalNotRunningError.make({
          workspaceId,
          terminalId,
          message: `Terminal ${terminalId} is not running for workspace ${workspaceId}.`,
        })
      }

      return session
    })

    return TerminalManager.of({
      events,
      clear,
      close,
      open,
      resize,
      restart,
      write,
    })
  })
}

const buildSpawnFailureMessage = (cwd: string, cause: unknown) => {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return `Unable to start a terminal in ${cwd}: ${cause.message}`
  }

  return `Unable to start a terminal in ${cwd}.`
}

const createSession = (input: {
  cwd: TerminalSessionSnapshot['cwd']
  terminalId: TerminalSessionSnapshot['terminalId']
  workspaceId: TerminalSessionSnapshot['workspaceId']
  cols: number
  rows: number
  history: string
}): TerminalSessionState => ({
  cwd: input.cwd,
  terminalId: input.terminalId,
  workspaceId: input.workspaceId,
  cols: input.cols,
  exitCode: null,
  exitSignal: null,
  hasRunningSubprocess: false,
  history: input.history,
  pendingHistoryControlSequence: '',
  persistTimeout: null,
  process: null,
  rows: input.rows,
  status: 'starting',
  unsubscribeData: null,
  unsubscribeExit: null,
  updatedAt: new Date().toISOString(),
})

const clearPersistTimeout = (session: TerminalSessionState) => {
  if (session.persistTimeout === null) {
    return
  }

  clearTimeout(session.persistTimeout)
  session.persistTimeout = null
}

const schedulePersist = (session: TerminalSessionState) => {
  clearPersistTimeout(session)
  session.persistTimeout = setTimeout(() => {
    session.persistTimeout = null
    void persistHistory(session)
  }, DEFAULT_PERSIST_DEBOUNCE_MS)
  session.persistTimeout.unref?.()
}

const persistHistory = async (session: TerminalSessionState): Promise<void> => {
  await mkdir(TERMINAL_HISTORY_DIRECTORY, { recursive: true })
  await writeFile(
    historyPath(session.workspaceId, session.terminalId),
    session.history,
    'utf8'
  )
}

const readHistory = async (
  workspaceId: string,
  terminalId: string
): Promise<string> => {
  try {
    return await readFile(historyPath(workspaceId, terminalId), 'utf8')
  } catch {
    return ''
  }
}

const historyPath = (workspaceId: string, terminalId: string) =>
  path.join(
    TERMINAL_HISTORY_DIRECTORY,
    `${encodeURIComponent(workspaceId)}_${encodeURIComponent(terminalId)}.log`
  )

const toSessionKey = (workspaceId: string, terminalId: string) =>
  `${workspaceId}:${terminalId}`

const ensureDirectory = Effect.fn('TerminalManager.ensureDirectory')(function* (
  cwd: string
) {
  const cwdStat = yield* Effect.tryPromise({
    try: () => stat(cwd),
    catch: (cause) =>
      TerminalCwdError.make({
        cwd,
        message: `Terminal cwd does not exist: ${cwd}`,
        cause,
      }),
  })

  if (!cwdStat.isDirectory()) {
    return yield* TerminalCwdError.make({
      cwd,
      message: `Terminal cwd is not a directory: ${cwd}`,
    })
  }
})

const defaultShellResolver = (): string => {
  if (process.platform === 'win32') {
    return process.env.ComSpec ?? 'cmd.exe'
  }

  return process.env.SHELL ?? '/bin/zsh'
}

const normalizeShellCommand = (value: string | undefined): string | null => {
  if (!value) {
    return null
  }

  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return null
  }

  if (process.platform === 'win32') {
    return trimmed
  }

  const firstToken = trimmed.split(/\s+/g)[0]?.trim()
  if (!firstToken) {
    return null
  }

  return firstToken.replace(/^['"]|['"]$/g, '')
}

const resolveShellCandidates = (): Array<{ shell: string; args: string[] }> => {
  const candidates = [
    normalizeShellCommand(defaultShellResolver()),
    normalizeShellCommand(process.env.SHELL),
    '/bin/zsh',
    '/bin/bash',
    '/bin/sh',
    'zsh',
    'bash',
    'sh',
  ].filter(
    (candidate): candidate is string =>
      typeof candidate === 'string' && candidate.length > 0
  )

  const seen = new Set<string>()

  return candidates.flatMap((shell) => {
    if (seen.has(shell)) {
      return []
    }

    seen.add(shell)
    const shellName = path.basename(shell).toLowerCase()

    return [
      {
        shell,
        args:
          process.platform !== 'win32' && shellName === 'zsh'
            ? ['-o', 'nopromptsp']
            : [],
      },
    ]
  })
}

const startSession = async (
  session: TerminalSessionState,
  emitEvent: (event: TerminalEvent) => void,
  eventType: 'started' | 'restarted' = 'started'
) => {
  stopProcess(session)

  const env = buildTerminalEnvironment()
  let lastError: unknown = null

  for (const candidate of resolveShellCandidates()) {
    try {
      const process = spawnPty(candidate.shell, candidate.args, {
        cols: session.cols,
        cwd: session.cwd,
        env,
        name:
          globalThis.process.platform === 'win32'
            ? 'xterm-color'
            : 'xterm-256color',
        rows: session.rows,
      })

      session.process = process
      session.status = 'running'
      session.exitCode = null
      session.exitSignal = null
      session.hasRunningSubprocess = false
      session.updatedAt = new Date().toISOString()

      const onDataDisposable = process.onData((data) => {
        const sanitized = sanitizeTerminalHistoryChunk(
          session.pendingHistoryControlSequence,
          data
        )
        session.pendingHistoryControlSequence = sanitized.pendingControlSequence
        if (sanitized.visibleText.length > 0) {
          session.history = capHistory(
            `${session.history}${sanitized.visibleText}`,
            DEFAULT_HISTORY_LINE_LIMIT
          )
          schedulePersist(session)
        }
        session.updatedAt = new Date().toISOString()
        emitEvent(
          makeTerminalEvent(session.workspaceId, session.terminalId, {
            type: 'output',
            data,
          })
        )
      })

      const onExitDisposable = process.onExit((event) => {
        session.process = null
        session.unsubscribeData?.()
        session.unsubscribeData = null
        session.unsubscribeExit?.()
        session.unsubscribeExit = null
        session.status = 'exited'
        session.exitCode =
          typeof event.exitCode === 'number' ? event.exitCode : null
        session.exitSignal =
          typeof event.signal === 'number' ? event.signal : null
        session.hasRunningSubprocess = false
        session.updatedAt = new Date().toISOString()
        session.pendingHistoryControlSequence = ''
        schedulePersist(session)
        emitEvent(
          makeTerminalEvent(session.workspaceId, session.terminalId, {
            type: 'exited',
            exitCode: session.exitCode,
            exitSignal: session.exitSignal,
          })
        )
      })

      session.unsubscribeData = () => {
        onDataDisposable.dispose()
      }
      session.unsubscribeExit = () => {
        onExitDisposable.dispose()
      }

      emitEvent(
        makeTerminalEvent(session.workspaceId, session.terminalId, {
          type: eventType,
          snapshot: snapshot(session),
        })
      )
      return
    } catch (error) {
      lastError = error
    }
  }

  session.status = 'error'
  session.updatedAt = new Date().toISOString()
  emitEvent(
    makeTerminalEvent(session.workspaceId, session.terminalId, {
      type: 'error',
      message: buildSpawnFailureMessage(session.cwd, lastError),
    })
  )

  throw lastError instanceof Error
    ? lastError
    : new Error('Unable to spawn terminal')
}

const buildTerminalEnvironment = () => {
  const nextEnv = { ...process.env }

  for (const key of TERMINAL_ENV_BLOCKLIST) {
    delete nextEnv[key]
  }

  return nextEnv
}

const stopProcess = (session: TerminalSessionState) => {
  session.unsubscribeData?.()
  session.unsubscribeData = null
  session.unsubscribeExit?.()
  session.unsubscribeExit = null

  if (session.process) {
    try {
      session.process.kill()
    } catch {
      // Ignore process cleanup failures during teardown.
    }
  }

  session.process = null
}

const snapshot = (session: TerminalSessionState): TerminalSessionSnapshot => ({
  cwd: session.cwd,
  terminalId: session.terminalId,
  workspaceId: session.workspaceId,
  status: session.status,
  pid: session.process?.pid ?? null,
  history: session.history,
  exitCode: session.exitCode,
  exitSignal: session.exitSignal,
  hasRunningSubprocess: session.hasRunningSubprocess,
  updatedAt: session.updatedAt,
})

const makeTerminalEvent = (
  workspaceId: TerminalSessionSnapshot['workspaceId'],
  terminalId: TerminalSessionSnapshot['terminalId'],
  event:
    | { type: 'activity'; hasRunningSubprocess: boolean }
    | { type: 'cleared' }
    | { type: 'error'; message: string }
    | { type: 'exited'; exitCode: number | null; exitSignal: number | null }
    | { type: 'output'; data: string }
    | { type: 'restarted'; snapshot: TerminalSessionSnapshot }
    | { type: 'started'; snapshot: TerminalSessionSnapshot }
): TerminalEvent => ({
  ...event,
  createdAt: new Date().toISOString(),
  terminalId,
  workspaceId,
})

const pollSubprocessActivity = async (
  sessions: ReadonlyMap<string, TerminalSessionState>,
  emitEvent: (event: TerminalEvent) => void
) => {
  for (const session of sessions.values()) {
    const terminalPid = session.process?.pid
    if (!terminalPid || session.status !== 'running') {
      continue
    }

    try {
      const hasRunningSubprocess = await hasChildProcess(terminalPid)
      if (hasRunningSubprocess === session.hasRunningSubprocess) {
        continue
      }

      session.hasRunningSubprocess = hasRunningSubprocess
      session.updatedAt = new Date().toISOString()
      emitEvent(
        makeTerminalEvent(session.workspaceId, session.terminalId, {
          type: 'activity',
          hasRunningSubprocess,
        })
      )
    } catch {
      // Ignore background activity probe failures.
    }
  }
}

const hasChildProcess = async (terminalPid: number): Promise<boolean> =>
  Match.value(process.platform).pipe(
    Match.when('win32', () => hasChildProcessWindows(terminalPid)),
    Match.orElse(() => hasChildProcessUnix(terminalPid))
  )

const hasChildProcessUnix = async (terminalPid: number): Promise<boolean> => {
  const output = await execCapture('pgrep', ['-P', String(terminalPid)])
  return output.trim().length > 0
}

const hasChildProcessWindows = async (
  terminalPid: number
): Promise<boolean> => {
  const output = await execCapture('powershell.exe', [
    '-NoProfile',
    '-Command',
    `Get-CimInstance Win32_Process -Filter "ParentProcessId = ${terminalPid}" | Select-Object -ExpandProperty ProcessId`,
  ])
  return output.trim().length > 0
}

const execCapture = (command: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0 || command === 'pgrep') {
        resolve(stdout)
        return
      }

      reject(new Error(stderr.trim() || `${command} exited with code ${code}`))
    })
  })

function capHistory(history: string, maxLines: number): string {
  if (history.length === 0) {
    return history
  }

  const hasTrailingNewline = history.endsWith('\n')
  const lines = history.split('\n')

  if (lines.length <= maxLines) {
    return history
  }

  const nextLines = lines.slice(lines.length - maxLines)
  const capped = nextLines.join('\n')

  return hasTrailingNewline && !capped.endsWith('\n') ? `${capped}\n` : capped
}

function sanitizeTerminalHistoryChunk(
  pendingControlSequence: string,
  input: string
): {
  visibleText: string
  pendingControlSequence: string
} {
  let visibleText = ''
  let index = 0
  const value = `${pendingControlSequence}${input}`

  while (index < value.length) {
    const character = value[index]

    if (character === undefined) {
      break
    }

    if (character === '\u001b') {
      const nextCharacter = value[index + 1]
      if (nextCharacter === undefined) {
        return { visibleText, pendingControlSequence: value.slice(index) }
      }

      if (nextCharacter === '[') {
        index += 2
        while (index < value.length) {
          const controlCharacter = value[index]
          if (controlCharacter === undefined) {
            return {
              visibleText,
              pendingControlSequence: value.slice(index - 2),
            }
          }

          if (/[A-Za-z]/.test(controlCharacter)) {
            index += 1
            break
          }

          index += 1
        }
        continue
      }

      if (nextCharacter === ']') {
        const bellIndex = value.indexOf('\u0007', index + 2)
        if (bellIndex < 0) {
          return { visibleText, pendingControlSequence: value.slice(index) }
        }

        index = bellIndex + 1
        continue
      }

      index += 2
      continue
    }

    if (character === '\r') {
      const newlineCharacter = value[index + 1]
      if (newlineCharacter === '\n') {
        visibleText += '\n'
        index += 2
        continue
      }

      visibleText += '\n'
      index += 1
      continue
    }

    if (character >= ' ' || character === '\n' || character === '\t') {
      visibleText += character
    }

    index += 1
  }

  return { visibleText, pendingControlSequence: '' }
}
