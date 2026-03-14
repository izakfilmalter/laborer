import type { SidecarManager, SidecarName } from './sidecar.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Interval between health check HTTP polls (ms). */
const HEALTH_CHECK_INTERVAL_MS = 50

/** Maximum time to wait for a sidecar to become healthy (ms). */
const HEALTH_CHECK_TIMEOUT_MS = 10_000

/** Per-request HTTP timeout (ms). */
const HTTP_TIMEOUT_MS = 2000

/** Base delay for exponential backoff on restart (ms). */
const BACKOFF_BASE_MS = 500

/** Maximum backoff delay (ms). */
const BACKOFF_CAP_MS = 10_000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Sidecar status reported to the renderer.
 *
 * - `starting` — sidecar spawned, waiting for health check
 * - `healthy`  — health check passed, service is reachable
 * - `crashed`  — process exited unexpectedly (includes stderr excerpt)
 * - `restarting` — automatic restart scheduled, waiting for backoff delay
 */
export type SidecarStatus =
  | { readonly state: 'starting'; readonly name: SidecarName }
  | { readonly state: 'healthy'; readonly name: SidecarName }
  | {
      readonly state: 'crashed'
      readonly name: SidecarName
      readonly error: string
    }
  | {
      readonly state: 'restarting'
      readonly name: SidecarName
      readonly delayMs: number
    }

/** Callback invoked when a sidecar's status changes. */
export type StatusListener = (status: SidecarStatus) => void

// ---------------------------------------------------------------------------
// Health checking
// ---------------------------------------------------------------------------

/**
 * Check if a sidecar's HTTP endpoint is responding with a 2xx status.
 *
 * Uses the native `fetch` API with an `AbortController` timeout.
 * Returns false on any error (connection refused, timeout, non-2xx, etc.).
 */
async function checkHealth(url: string): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)

    const response = await fetch(url, {
      signal: controller.signal,
      // Prevent following redirects to avoid false positives.
      redirect: 'error',
    })

    clearTimeout(timeoutId)
    return response.ok
  } catch {
    return false
  }
}

/**
 * Poll a sidecar's health endpoint until it responds or the timeout elapses.
 *
 * Uses an immediate first check followed by exponential backoff polling
 * to minimize latency when services start quickly while reducing CPU
 * usage during longer waits.
 *
 * @returns `true` if the service became healthy within the timeout, `false` otherwise.
 */
export async function waitForHealthy(
  url: string,
  timeoutMs = HEALTH_CHECK_TIMEOUT_MS,
  intervalMs = HEALTH_CHECK_INTERVAL_MS
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs

  // Immediate first check — no initial delay
  if (await checkHealth(url)) {
    return true
  }

  // Exponential backoff: start at intervalMs, cap at 200ms
  let currentInterval = intervalMs
  const maxInterval = 200

  while (Date.now() < deadline) {
    await delay(currentInterval)
    if (await checkHealth(url)) {
      return true
    }
    currentInterval = Math.min(currentInterval * 1.5, maxInterval)
  }

  return false
}

// ---------------------------------------------------------------------------
// Exponential backoff
// ---------------------------------------------------------------------------

/**
 * Calculate the backoff delay for a restart attempt.
 *
 * Uses exponential backoff: 500ms, 1s, 2s, 4s, 8s, 10s, 10s, ...
 */
export function backoffDelay(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS)
}

// ---------------------------------------------------------------------------
// Health Monitor
// ---------------------------------------------------------------------------

/**
 * Manages health checking, crash monitoring, and automatic restart
 * with exponential backoff for sidecar child processes.
 *
 * This module sits on top of `SidecarManager` and adds:
 * - HTTP health polling after spawn (blocks until healthy or timeout)
 * - Crash detection with exponential backoff restart
 * - Status events emitted to the renderer via a listener callback
 * - Manual restart support (resets backoff)
 */
export class HealthMonitor {
  private readonly sidecarManager: SidecarManager
  private readonly ports: {
    fileWatcherPort: number
    serverPort: number
    terminalPort: number
  }
  private listener: StatusListener | null = null

  /** Per-sidecar restart attempt counter for exponential backoff. */
  private readonly restartAttempts = new Map<SidecarName, number>()

  /** Per-sidecar pending restart timer. */
  private readonly restartTimers = new Map<
    SidecarName,
    ReturnType<typeof setTimeout>
  >()

  /** Set of sidecars that have been marked healthy at least once. */
  private readonly healthySet = new Set<SidecarName>()

  /** Whether the app is quitting (suppresses restart attempts). */
  private isQuitting = false

  constructor(
    sidecarManager: SidecarManager,
    ports: {
      fileWatcherPort: number
      serverPort: number
      terminalPort: number
    }
  ) {
    this.sidecarManager = sidecarManager
    this.ports = ports

    // Wire up the unexpected exit handler from SidecarManager.
    this.sidecarManager.setExitHandler((name, code, signal, lastStderr) => {
      this.handleUnexpectedExit(name, code, signal, lastStderr)
    })
  }

  /**
   * Register a listener for sidecar status changes.
   * The listener is called with every state transition (starting, healthy,
   * crashed, restarting). Only one listener is supported (the main process
   * forwards events to the renderer via IPC).
   */
  setStatusListener(listener: StatusListener): void {
    this.listener = listener
  }

  /**
   * Build the health check URL for a sidecar.
   * Only server and terminal have HTTP endpoints; MCP uses stdio.
   */
  private healthUrl(name: SidecarName): string | null {
    switch (name) {
      case 'server':
        return `http://127.0.0.1:${this.ports.serverPort}`
      case 'terminal':
        return `http://127.0.0.1:${this.ports.terminalPort}`
      case 'file-watcher':
        return `http://127.0.0.1:${this.ports.fileWatcherPort}`
      default:
        // MCP communicates over stdio — no HTTP health check.
        return null
    }
  }

  /**
   * Spawn a sidecar and wait for it to become healthy.
   *
   * Emits `starting` status, then polls the health endpoint.
   * On success, emits `healthy`; on timeout, emits `crashed` with a
   * timeout error message.
   *
   * @returns `true` if healthy, `false` if timed out.
   */
  async spawnAndWaitHealthy(name: SidecarName): Promise<boolean> {
    this.emitStatus({ state: 'starting', name })

    this.sidecarManager.spawn(name)

    const url = this.healthUrl(name)
    if (!url) {
      // MCP has no health endpoint — assume healthy after spawn.
      this.healthySet.add(name)
      this.restartAttempts.delete(name)
      this.emitStatus({ state: 'healthy', name })
      return true
    }

    const healthy = await waitForHealthy(url)

    if (healthy) {
      this.healthySet.add(name)
      this.restartAttempts.delete(name)
      this.emitStatus({ state: 'healthy', name })
      return true
    }

    // Timed out waiting for health.
    const lastStderr = this.sidecarManager.getLastStderr(name)
    const error = lastStderr
      ? `Health check timed out after ${HEALTH_CHECK_TIMEOUT_MS}ms.\n${lastStderr}`
      : `Health check timed out after ${HEALTH_CHECK_TIMEOUT_MS}ms.`

    this.emitStatus({ state: 'crashed', name, error })
    return false
  }

  /**
   * Spawn the terminal, file-watcher, and server services, waiting for
   * each to become healthy before proceeding. Terminal and file-watcher
   * start first (in parallel) because the server connects to both on
   * startup.
   *
   * Replaces the delay-based `SidecarManager.spawnServices()`.
   *
   * @returns `true` if all services are healthy.
   */
  async spawnServices(): Promise<boolean> {
    // Terminal and file-watcher can start in parallel — the server
    // depends on both but they are independent of each other.
    const [terminalOk, fileWatcherOk] = await Promise.all([
      this.spawnAndWaitHealthy('terminal'),
      this.spawnAndWaitHealthy('file-watcher'),
    ])

    if (!terminalOk) {
      console.error('[health] Terminal failed to become healthy')
      return false
    }

    if (!fileWatcherOk) {
      console.error('[health] File-watcher failed to become healthy')
      return false
    }

    const serverOk = await this.spawnAndWaitHealthy('server')
    if (!serverOk) {
      console.error('[health] Server failed to become healthy')
      return false
    }

    return true
  }

  /**
   * Handle unexpected sidecar exit: emit crashed status and schedule
   * an automatic restart with exponential backoff.
   */
  private handleUnexpectedExit(
    name: SidecarName,
    code: number | null,
    signal: string | null,
    lastStderr: string
  ): void {
    if (this.isQuitting) {
      return
    }

    const error = lastStderr
      ? `Process exited unexpectedly (code=${code}, signal=${signal}).\n${lastStderr}`
      : `Process exited unexpectedly (code=${code}, signal=${signal}).`

    console.error(`[health:${name}] ${error}`)
    this.emitStatus({ state: 'crashed', name, error })

    // Schedule automatic restart with backoff.
    this.scheduleRestart(name)
  }

  /**
   * Schedule a restart with exponential backoff.
   * If a restart is already pending for this sidecar, the new request
   * is ignored to prevent stacking.
   */
  private scheduleRestart(name: SidecarName): void {
    if (this.isQuitting) {
      return
    }

    // Don't stack multiple restart timers.
    if (this.restartTimers.has(name)) {
      return
    }

    const attempt = this.restartAttempts.get(name) ?? 0
    const delayMs = backoffDelay(attempt)
    this.restartAttempts.set(name, attempt + 1)

    console.info(
      `[health:${name}] Scheduling restart in ${delayMs}ms (attempt ${attempt + 1})`
    )
    this.emitStatus({ state: 'restarting', name, delayMs })

    const timer = setTimeout(() => {
      this.restartTimers.delete(name)
      this.spawnAndWaitHealthy(name).catch((err: unknown) => {
        console.error(`[health:${name}] Restart failed:`, err)
      })
    }, delayMs)

    // Don't let the timer prevent app exit.
    timer.unref()

    this.restartTimers.set(name, timer)
  }

  /**
   * Manually restart a sidecar. Resets the backoff counter.
   * Called from the renderer via IPC (`restartSidecar(name)`).
   */
  manualRestart(name: SidecarName): Promise<boolean> {
    console.info(`[health:${name}] Manual restart requested`)

    // Cancel any pending automatic restart.
    this.cancelPendingRestart(name)

    // Reset backoff counter for manual restarts.
    this.restartAttempts.delete(name)

    // Kill the existing process (if running).
    this.sidecarManager.killOne(name)

    // Spawn and wait for health.
    return this.spawnAndWaitHealthy(name)
  }

  /**
   * Cancel a pending restart timer for a sidecar.
   */
  private cancelPendingRestart(name: SidecarName): void {
    const timer = this.restartTimers.get(name)
    if (timer) {
      clearTimeout(timer)
      this.restartTimers.delete(name)
    }
  }

  /**
   * Check if a sidecar is currently marked as healthy.
   */
  isHealthy(name: SidecarName): boolean {
    return this.healthySet.has(name)
  }

  /**
   * Check if all core services (server, terminal, file-watcher) are healthy.
   */
  areServicesHealthy(): boolean {
    return (
      this.healthySet.has('server') &&
      this.healthySet.has('terminal') &&
      this.healthySet.has('file-watcher')
    )
  }

  /**
   * Signal that the app is shutting down. Cancels all pending restarts
   * and suppresses future restart attempts.
   */
  shutdown(): void {
    this.isQuitting = true

    // Cancel all pending restart timers.
    for (const [name, timer] of this.restartTimers) {
      clearTimeout(timer)
      this.restartTimers.delete(name)
      console.info(`[health:${name}] Cancelled pending restart (shutting down)`)
    }
  }

  private emitStatus(status: SidecarStatus): void {
    console.info(`[health:${status.name}] ${status.state}`)
    this.listener?.(status)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
