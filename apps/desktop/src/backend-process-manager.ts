import { type ChildProcess, spawn } from 'node:child_process'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  type WriteStream,
} from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { waitForHttpReady } from './backend-readiness.js'
import { waitForBackendStartupReady } from './backend-startup-readiness.js'
import { ServerListeningDetector } from './server-listening-detector.js'

export interface BackendEndpoint {
  readonly wsUrl: string
}

export interface BackendProcessManagerOptions {
  readonly authToken: string
  readonly port: number
}

const KILL_GRACE_MS = 2000
const READY_TIMEOUT_MS = 60_000
const RESTART_BASE_DELAY_MS = 500
const RESTART_MAX_DELAY_MS = 10_000

/**
 * Minimum time between attempts to reopen backend.log after the write
 * stream errors (ms). The stream has no automatic recovery — a single
 * write error (EPIPE/EIO after sleep, ENOSPC, ...) would otherwise
 * silently kill log capture for the rest of the session while the
 * backend keeps running. Throttled so a persistent failure (e.g. disk
 * full) doesn't attempt a reopen for every log chunk.
 */
export const BACKEND_LOG_REOPEN_MIN_INTERVAL_MS = 5000

function resolveAppRoot(): string {
  if (!app.isPackaged) {
    return join(import.meta.dirname, '..', '..', '..')
  }
  return app.getAppPath()
}

function resolveBackendEntry(): string {
  return join(resolveAppRoot(), 'packages/server/dist/main.mjs')
}

function resolveBackendCwd(): string {
  if (!app.isPackaged) {
    return resolveAppRoot()
  }
  return app.getPath('home')
}

function openBackendLogStream(): WriteStream | null {
  if (!app.isPackaged) {
    return null
  }

  const logDirectory = join(app.getPath('userData'), 'logs')
  mkdirSync(logDirectory, { recursive: true })
  return createWriteStream(join(logDirectory, 'backend.log'), { flags: 'a' })
}

export class BackendProcessManager {
  readonly #authToken: string
  #backendLogStream: WriteStream | null = null
  /**
   * Wall-clock timestamp of the last log stream failure or reopen
   * attempt. `null` when the stream is healthy or log capture is
   * disabled (dev mode). Gates reopen attempts in #writeBackendLog.
   */
  #backendLogStreamFailedAt: number | null = null
  #backendReadinessAbortController: AbortController | null = null
  #backendListeningDetector: ServerListeningDetector | null = null
  #backendStartupReadyPromise: Promise<void> | null = null
  #intentionallyStopped = false
  #process: ChildProcess | null = null
  readonly #port: number
  #restartAttempt = 0
  #restartTimer: ReturnType<typeof setTimeout> | null = null

  constructor(options: BackendProcessManagerOptions) {
    this.#authToken = options.authToken
    this.#port = options.port
  }

  start(): BackendEndpoint {
    if (!this.#process) {
      this.#spawnBackend()
    }

    if (!this.#process) {
      throw new Error('Server backend process failed to start')
    }

    this.#observeBackendStartupReadiness()

    return {
      wsUrl: `ws://127.0.0.1:${String(this.#port)}/?token=${encodeURIComponent(this.#authToken)}`,
    }
  }

  waitUntilReady(): Promise<void> {
    if (!this.#process) {
      this.#spawnBackend()
    }

    if (!this.#process) {
      return Promise.reject(new Error('Server backend process failed to start'))
    }

    return this.#observeBackendStartupReadiness()
  }

  stop(): void {
    this.#intentionallyStopped = true
    this.#cancelBackendReadinessWait()
    this.#backendListeningDetector = null
    this.#backendStartupReadyPromise = null
    if (this.#restartTimer) {
      clearTimeout(this.#restartTimer)
      this.#restartTimer = null
    }

    const child = this.#process
    this.#process = null
    this.#closeBackendLogStream()
    if (!child) {
      return
    }

    child.kill('SIGTERM')
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
      }
    }, KILL_GRACE_MS).unref()
  }

  #spawnBackend(): void {
    this.#intentionallyStopped = false
    const backendEntry = resolveBackendEntry()
    if (!existsSync(backendEntry)) {
      this.#scheduleRestart(`missing server entry at ${backendEntry}`)
      return
    }

    this.#closeBackendLogStream()
    this.#backendLogStream = openBackendLogStream()
    if (this.#backendLogStream) {
      this.#attachLogStreamErrorHandler(this.#backendLogStream)
    }
    const captureBackendLogs = this.#backendLogStream !== null
    const child = spawn(
      process.execPath,
      [backendEntry, '--bootstrap-fd', '3'],
      {
        cwd: resolveBackendCwd(),
        env: backendChildEnv(),
        stdio: captureBackendLogs
          ? ['ignore', 'pipe', 'pipe', 'pipe']
          : ['ignore', 'inherit', 'inherit', 'pipe'],
      }
    )

    const bootstrapStream = child.stdio[3]
    if (bootstrapStream && 'write' in bootstrapStream) {
      bootstrapStream.write(
        `${JSON.stringify({
          authToken: this.#authToken,
          host: '127.0.0.1',
          port: this.#port,
        })}\n`
      )
      bootstrapStream.end()
    } else {
      child.kill('SIGTERM')
      this.#scheduleRestart('missing bootstrap pipe')
      return
    }

    const listeningDetector = new ServerListeningDetector()
    this.#backendListeningDetector = listeningDetector
    this.#process = child
    child.stdout?.on('data', (chunk: Buffer) => {
      this.#writeBackendLog(chunk)
      listeningDetector.push(chunk)
      if (!captureBackendLogs) {
        console.log(`[backend] ${chunk.toString().trimEnd()}`)
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      this.#writeBackendLog(chunk)
      listeningDetector.push(chunk)
      if (!captureBackendLogs) {
        console.error(`[backend] ${chunk.toString().trimEnd()}`)
      }
    })
    // Without listeners, a pipe read error becomes an uncaughtException
    // in the main process. Log-only: if the pipes are truly gone the
    // child's exit handler drives recovery.
    child.stdout?.on('error', (error) => {
      console.error('[backend] stdout pipe error', error)
    })
    child.stderr?.on('error', (error) => {
      console.error('[backend] stderr pipe error', error)
    })
    child.once('spawn', () => {
      this.#restartAttempt = 0
    })
    child.on('error', (error) => {
      if (this.#backendListeningDetector === listeningDetector) {
        listeningDetector.fail(error)
        this.#backendListeningDetector = null
      }
      if (this.#process === child) {
        this.#process = null
      }
      this.#backendStartupReadyPromise = null
      this.#closeBackendLogStream()
      this.#scheduleRestart(error.message)
    })
    child.on('exit', (code, signal) => {
      if (this.#backendListeningDetector === listeningDetector) {
        listeningDetector.fail(
          new Error(
            `backend exited before logging readiness (code=${String(code)} signal=${String(signal)})`
          )
        )
        this.#backendListeningDetector = null
      }
      console.error(
        `[backend] exited code=${String(code)} signal=${String(signal)}`
      )
      if (this.#process === child) {
        this.#process = null
      }
      this.#backendStartupReadyPromise = null
      this.#closeBackendLogStream()
      if (!this.#intentionallyStopped) {
        this.#scheduleRestart(`code=${String(code)} signal=${String(signal)}`)
      }
    })
  }

  #observeBackendStartupReadiness(): Promise<void> {
    if (this.#backendStartupReadyPromise) {
      return this.#backendStartupReadyPromise
    }

    const readinessPromise = waitForBackendStartupReady({
      cancelHttpWait: () => this.#cancelBackendReadinessWait(),
      listeningPromise: this.#backendListeningDetector?.promise ?? null,
      waitForHttpReady: () => this.#waitForBackendHttpReady(),
    })
      .then(() => undefined)
      .catch((error: unknown) => {
        if (!this.#intentionallyStopped) {
          console.error('[backend] startup readiness check failed', error)
        }
        throw error
      })

    this.#backendStartupReadyPromise = readinessPromise
    readinessPromise.catch(() => {
      if (this.#backendStartupReadyPromise === readinessPromise) {
        this.#backendStartupReadyPromise = null
      }
    })
    return readinessPromise
  }

  #scheduleRestart(reason: string): void {
    if (this.#intentionallyStopped || this.#restartTimer) {
      return
    }

    const delayMs = Math.min(
      RESTART_BASE_DELAY_MS * 2 ** this.#restartAttempt,
      RESTART_MAX_DELAY_MS
    )
    this.#restartAttempt += 1
    console.error(
      `[backend] exited unexpectedly (${reason}); restarting in ${String(delayMs)}ms`
    )
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null
      this.#spawnBackend()
    }, delayMs)
  }

  async #waitForBackendHttpReady(): Promise<void> {
    this.#cancelBackendReadinessWait()
    const controller = new AbortController()
    this.#backendReadinessAbortController = controller

    try {
      await waitForHttpReady(`http://127.0.0.1:${String(this.#port)}`, {
        signal: controller.signal,
        timeoutMs: READY_TIMEOUT_MS,
      })
    } finally {
      if (this.#backendReadinessAbortController === controller) {
        this.#backendReadinessAbortController = null
      }
    }
  }

  #cancelBackendReadinessWait(): void {
    this.#backendReadinessAbortController?.abort()
    this.#backendReadinessAbortController = null
  }

  #writeBackendLog(chunk: Buffer): void {
    if (this.#backendLogStream) {
      this.#backendLogStream.write(chunk)
      return
    }

    // No stream and no recorded failure means log capture is disabled
    // (dev mode) — nothing to recover.
    if (this.#backendLogStreamFailedAt === null) {
      return
    }

    // The stream died earlier. Try to reopen backend.log, throttled so
    // a persistent failure doesn't retry on every chunk.
    const sinceFailureMs = Date.now() - this.#backendLogStreamFailedAt
    if (sinceFailureMs < BACKEND_LOG_REOPEN_MIN_INTERVAL_MS) {
      return
    }
    this.#backendLogStreamFailedAt = Date.now()

    try {
      const stream = openBackendLogStream()
      if (!stream) {
        return
      }
      this.#attachLogStreamErrorHandler(stream)
      this.#backendLogStream = stream
      console.info('[backend] reopened backend.log after log stream error')
      stream.write(chunk)
    } catch (error) {
      console.error('[backend] failed to reopen backend.log', error)
    }
  }

  /**
   * Watch for write errors on the backend.log stream. Without a
   * listener a single EPIPE/EIO/ENOSPC write error becomes an
   * uncaughtException and log capture silently dies for the rest of
   * the session. Instead: drop the dead stream and let
   * #writeBackendLog reopen it on a later chunk.
   */
  #attachLogStreamErrorHandler(stream: WriteStream): void {
    stream.on('error', (error) => {
      console.error(
        '[backend] backend.log stream error — will reopen on next log chunk',
        error
      )
      if (this.#backendLogStream === stream) {
        this.#backendLogStream = null
        this.#backendLogStreamFailedAt = Date.now()
      }
    })
  }

  #closeBackendLogStream(): void {
    this.#backendLogStream?.end()
    this.#backendLogStream = null
    this.#backendLogStreamFailedAt = null
  }
}

function backendChildEnv(): NodeJS.ProcessEnv {
  const {
    LABORER_SERVER_AUTH_TOKEN: _authToken,
    LABORER_SERVER_HOST: _host,
    LABORER_SERVER_PORT: _serverPort,
    PORT: _port,
    ...env
  } = process.env
  return {
    ...env,
    ELECTRON_RUN_AS_NODE: '1',
    LABORER_BACKEND_CHILD: '1',
  }
}
