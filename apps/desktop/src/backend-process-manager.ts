import { type ChildProcess, spawn } from 'node:child_process'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  type WriteStream,
} from 'node:fs'
import { Socket } from 'node:net'
import { join } from 'node:path'
import { app } from 'electron'

export interface BackendEndpoint {
  readonly wsUrl: string
}

export interface BackendProcessManagerOptions {
  readonly authToken: string
  readonly port: number
}

const KILL_GRACE_MS = 2000
const READY_CHECK_INTERVAL_MS = 100
const READY_TIMEOUT_MS = 10_000
const RESTART_BASE_DELAY_MS = 500
const RESTART_MAX_DELAY_MS = 10_000

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
  #intentionallyStopped = false
  #process: ChildProcess | null = null
  readonly #port: number
  #restartAttempt = 0
  #restartTimer: ReturnType<typeof setTimeout> | null = null

  constructor(options: BackendProcessManagerOptions) {
    this.#authToken = options.authToken
    this.#port = options.port
  }

  async start(): Promise<BackendEndpoint> {
    if (!this.#process) {
      this.#spawnBackend()
    }

    await waitForTcpPort(this.#port)

    return {
      wsUrl: `ws://127.0.0.1:${String(this.#port)}/?token=${encodeURIComponent(this.#authToken)}`,
    }
  }

  stop(): void {
    this.#intentionallyStopped = true
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

    this.#process = child
    child.stdout?.on('data', (chunk: Buffer) => {
      this.#writeBackendLog(chunk)
      if (!captureBackendLogs) {
        console.log(`[backend] ${chunk.toString().trimEnd()}`)
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      this.#writeBackendLog(chunk)
      if (!captureBackendLogs) {
        console.error(`[backend] ${chunk.toString().trimEnd()}`)
      }
    })
    child.once('spawn', () => {
      this.#restartAttempt = 0
    })
    child.on('error', (error) => {
      if (this.#process === child) {
        this.#process = null
      }
      this.#closeBackendLogStream()
      this.#scheduleRestart(error.message)
    })
    child.on('exit', (code, signal) => {
      console.error(
        `[backend] exited code=${String(code)} signal=${String(signal)}`
      )
      if (this.#process === child) {
        this.#process = null
      }
      this.#closeBackendLogStream()
      if (!this.#intentionallyStopped) {
        this.#scheduleRestart(`code=${String(code)} signal=${String(signal)}`)
      }
    })
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

  #writeBackendLog(chunk: Buffer): void {
    this.#backendLogStream?.write(chunk)
  }

  #closeBackendLogStream(): void {
    this.#backendLogStream?.end()
    this.#backendLogStream = null
  }
}

function waitForTcpPort(port: number): Promise<void> {
  const startedAt = Date.now()

  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      const socket = new Socket()
      let settled = false

      const finish = (error?: Error) => {
        if (settled) {
          return
        }
        settled = true
        socket.destroy()

        if (!error) {
          resolve()
          return
        }

        if (Date.now() - startedAt >= READY_TIMEOUT_MS) {
          reject(error)
          return
        }

        setTimeout(tryConnect, READY_CHECK_INTERVAL_MS)
      }

      socket.once('connect', () => finish())
      socket.once('error', (error) => finish(error))
      socket.setTimeout(READY_CHECK_INTERVAL_MS, () =>
        finish(new Error(`Timed out connecting to backend port ${String(port)}`))
      )
      socket.connect(port, '127.0.0.1')
    }

    tryConnect()
  })
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
