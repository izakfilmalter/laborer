import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import {
  type DaemonRegistration,
  ensure,
  findHealthyRegistration,
  processExists,
  readDaemonRegistration,
  stopWithEscalation,
} from '@laborer/ensure'

export const PROD_DAEMON_BASE_PORT = 2100
export const PROD_DAEMON_PORT_SCAN_LIMIT = 100
export const PROD_DAEMON_ENSURE_TIMEOUT_MS = 10_000

export const resolveDaemonRegistrationPath = (
  environment: NodeJS.ProcessEnv = process.env
): string => {
  const configured = environment.XDG_STATE_HOME?.trim()
  const stateHome =
    configured && isAbsolute(configured)
      ? configured
      : join(homedir(), '.local', 'state')
  return resolve(stateHome, 'laborer', 'daemon.json')
}

const isHealthy = async (registration: DaemonRegistration): Promise<boolean> =>
  fetch(`${registration.url}/health`, {
    signal: AbortSignal.timeout(2000),
  }).then(
    (response) => response.ok,
    () => false
  )

const requestStop = async (
  registration: DaemonRegistration,
  mode: 'restart' | 'shutdown'
): Promise<void> => {
  await fetch(`${registration.url}/daemon/stop`, {
    body: JSON.stringify({ mode }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
    signal: AbortSignal.timeout(2000),
  })
}

const requestRestart = (registration: DaemonRegistration) =>
  requestStop(registration, 'restart')
const requestShutdown = (registration: DaemonRegistration) =>
  requestStop(registration, 'shutdown')

const canBind = (port: number): Promise<boolean> =>
  new Promise((done) => {
    const server = createServer()
    server.once('error', () => done(false))
    server.listen(port, '127.0.0.1', () => server.close(() => done(true)))
  })

export const findAvailableDaemonPort = async (
  base = PROD_DAEMON_BASE_PORT
): Promise<number> => {
  for (let offset = 0; offset < PROD_DAEMON_PORT_SCAN_LIMIT; offset += 1) {
    const port = base + offset
    if (await canBind(port)) {
      return port
    }
  }
  throw new Error('No loopback port is available for the Laborer daemon')
}

export interface DaemonSupervisorOptions {
  readonly daemonEntry: string
  readonly environment?: NodeJS.ProcessEnv
  readonly executable?: string
  readonly registrationPath?: string
  readonly webDist: string
}

export class DesktopDaemonSupervisor {
  private readonly environment: NodeJS.ProcessEnv
  private readonly options: DaemonSupervisorOptions
  private readonly registrationPath: string
  private registration: DaemonRegistration | null = null
  private ensureInFlight: Promise<DaemonRegistration> | null = null

  constructor(options: DaemonSupervisorOptions) {
    this.options = options
    this.environment = options.environment ?? process.env
    this.registrationPath =
      options.registrationPath ??
      resolveDaemonRegistrationPath(this.environment)
  }

  async launch(): Promise<string> {
    this.registration = await this.coordinatedEnsure(true)
    return this.registration.url
  }

  async reconnect(): Promise<void> {
    this.registration = await this.coordinatedEnsure(false)
  }

  async shutdown(): Promise<void> {
    const registration =
      this.registration ?? readDaemonRegistration(this.registrationPath)
    if (registration) {
      await stopWithEscalation(registration, { requestStop: requestShutdown })
    }
    this.registration = null
  }

  private async ensureDaemon(
    replaceHealthy: boolean
  ): Promise<DaemonRegistration> {
    if (!replaceHealthy) {
      const healthy = await findHealthyRegistration(
        () => readDaemonRegistration(this.registrationPath),
        isHealthy
      )
      if (healthy) {
        return healthy
      }
    }

    const incumbent = readDaemonRegistration(this.registrationPath)
    if (incumbent && processExists(incumbent.pid)) {
      await stopWithEscalation(incumbent, { requestStop: requestRestart })
    }

    let selectedPort = PROD_DAEMON_BASE_PORT
    return await ensure({
      health: isHealthy,
      policy: 'exclusive-replace',
      readRegistration: () => readDaemonRegistration(this.registrationPath),
      spawn: async () => {
        selectedPort = await findAvailableDaemonPort()
        const child = spawn(
          this.options.executable ?? process.execPath,
          [this.options.daemonEntry],
          {
            detached: true,
            env: {
              ...this.environment,
              ELECTRON_RUN_AS_NODE: '1',
              LABORER_DAEMON_PORT: String(selectedPort),
              LABORER_WEB_DIST: this.options.webDist,
            },
            stdio: 'ignore',
          }
        )
        child.unref()
        return child.pid
      },
      stop: (registration) =>
        stopWithEscalation(registration, { requestStop: requestRestart }),
      timeoutMs: PROD_DAEMON_ENSURE_TIMEOUT_MS,
    })
  }

  private coordinatedEnsure(
    replaceHealthy: boolean
  ): Promise<DaemonRegistration> {
    if (this.ensureInFlight) {
      return this.ensureInFlight
    }
    const operation = this.ensureDaemon(replaceHealthy)
    this.ensureInFlight = operation
    const clear = () => {
      if (this.ensureInFlight === operation) {
        this.ensureInFlight = null
      }
    }
    operation.then(clear, clear)
    return operation
  }
}
