/**
 * Manages lifecycle monitoring for Electron utility processes.
 *
 * Replaces the HTTP-polling `HealthMonitor` with native utility process
 * events and a heartbeat MessagePort protocol. No HTTP health checks —
 * startup detection uses the bootstrap `ready` message, crash detection
 * uses the `exit` event, and liveness uses periodic heartbeats.
 *
 * Key responsibilities:
 * - Startup detection via `{ type: 'ready' }` bootstrap message
 * - Crash detection via utility process `exit` events
 * - Auto-restart with exponential backoff on unexpected exit
 * - Heartbeat monitoring: kill + restart unresponsive processes
 * - Status events forwarded to renderer windows
 * - Max restart limit (default 5, matching VS Code's `MaxRestarts`)
 * - Manual restart support (resets backoff counter)
 * - Graceful shutdown: cancels all pending restart timers
 *
 * Follows VS Code's patterns:
 * @see .reference/vscode/src/vs/platform/terminal/node/heartbeatService.ts
 * @see .reference/vscode/src/vs/platform/terminal/node/ptyHostService.ts
 */

import { BrowserWindow } from 'electron'

import type {
  ServiceName,
  UtilityProcessManager,
} from './utility-process-manager.js'

/**
 * IPC channel for sidecar status events.
 * Matches `SIDECAR_STATUS_CHANNEL` in `ipc.ts`.
 * Duplicated here to avoid importing the full IPC module which pulls in
 * many Electron dependencies that complicate unit testing.
 */
const SIDECAR_STATUS_CHANNEL = 'sidecar:status'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Base delay for exponential backoff on restart (ms). */
const BACKOFF_BASE_MS = 500

/** Maximum backoff delay (ms). */
const BACKOFF_CAP_MS = 10_000

/**
 * Maximum number of automatic restart attempts before giving up.
 * Matches VS Code's `MaxRestarts = 5`.
 * @see .reference/vscode/src/vs/platform/terminal/node/ptyHostService.ts line 26
 */
const MAX_RESTARTS = 5

/**
 * Interval between heartbeat messages from utility processes (ms).
 * Matches VS Code's `HeartbeatConstants.BeatInterval = 5000`.
 * @see .reference/vscode/src/vs/platform/terminal/common/terminal.ts
 */
export const HEARTBEAT_INTERVAL_MS = 5000

/**
 * Maximum time to wait for a heartbeat before considering the process
 * unresponsive (ms). 3x the heartbeat interval to tolerate missed beats.
 */
export const HEARTBEAT_TIMEOUT_MS = 15_000

/**
 * Tolerance for late-firing heartbeat timeout timers (ms).
 *
 * When the system sleeps mid-window (especially macOS DarkWake, which
 * does not reliably emit `suspend`/`resume` events), the pending
 * heartbeat timer fires shortly after wake with far more wall-clock
 * time elapsed than the scheduled 15s — while the utility process was
 * frozen, not hung. If the timeout handler observes elapsed time beyond
 * `HEARTBEAT_TIMEOUT_MS + HEARTBEAT_CLOCK_JUMP_TOLERANCE_MS`, it treats
 * the firing as a sleep artifact and re-arms a fresh window instead of
 * killing the process.
 */
export const HEARTBEAT_CLOCK_JUMP_TOLERANCE_MS = HEARTBEAT_INTERVAL_MS

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Sidecar status reported to the renderer.
 *
 * Uses the same shape as `SidecarStatusEvent` from `desktop-bridge.ts`
 * so existing renderer code works without changes.
 */
export type LifecycleStatus =
  | { readonly state: 'starting'; readonly name: ServiceName }
  | { readonly state: 'healthy'; readonly name: ServiceName }
  | {
      readonly state: 'crashed'
      readonly name: ServiceName
      readonly error: string
    }
  | {
      readonly state: 'restarting'
      readonly name: ServiceName
      readonly delayMs: number
    }

/** Callback invoked when a service's status changes. */
export type StatusListener = (status: LifecycleStatus) => void

/** Per-service lifecycle tracking state. */
interface ServiceState {
  /**
   * Wall-clock timestamp (`Date.now()`) when the heartbeat timer was
   * last armed. Used to detect timers that fired late because the
   * system slept mid-window.
   */
  heartbeatArmedAt: number
  /** Current heartbeat timeout timer. */
  heartbeatTimer: ReturnType<typeof setTimeout> | null
  /** Whether the service has sent its `ready` message. */
  isReady: boolean
  /** Number of automatic restart attempts (resets on manual restart or healthy). */
  restartAttempts: number
  /** Pending restart timer. */
  restartTimer: ReturnType<typeof setTimeout> | null
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Calculate the backoff delay for a restart attempt.
 *
 * Uses exponential backoff: 500ms, 1s, 2s, 4s, 8s, 10s, 10s, ...
 * Exported for testing.
 */
export function backoffDelay(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS)
}

// ---------------------------------------------------------------------------
// LifecycleMonitor
// ---------------------------------------------------------------------------

/**
 * Monitors utility process lifecycle: startup, heartbeat, crash detection,
 * and automatic restart with exponential backoff.
 *
 * Sits on top of `UtilityProcessManager` and replaces the HTTP-polling
 * `HealthMonitor`.
 *
 * @see .reference/vscode/src/vs/platform/terminal/node/ptyHostService.ts
 */
export class LifecycleMonitor {
  private readonly manager: UtilityProcessManager
  private readonly services = new Map<ServiceName, ServiceState>()
  private listener: StatusListener | null = null
  private isQuitting = false
  private readonly maxRestarts: number
  private readonly onProcessExit: ((name: ServiceName) => void) | undefined

  constructor(
    manager: UtilityProcessManager,
    options?: {
      maxRestarts?: number
      /**
       * Called when a utility process exits (crash or intentional restart).
       * Used by main.ts to close renderer-side MessagePorts so the
       * renderer's `onclose` handler fires and RPC clients detect the
       * dead channel.
       */
      onProcessExit?: (name: ServiceName) => void
    }
  ) {
    this.manager = manager
    this.maxRestarts = options?.maxRestarts ?? MAX_RESTARTS
    this.onProcessExit = options?.onProcessExit

    // Wire up the unexpected exit handler from UtilityProcessManager.
    this.manager.setExitHandler((name, code, lastStderr) => {
      this.handleUnexpectedExit(name, code, lastStderr)
    })
  }

  /**
   * Register a listener for service status changes.
   * Only one listener is supported (the main process forwards events to
   * all renderer windows via IPC).
   */
  setStatusListener(listener: StatusListener): void {
    this.listener = listener
  }

  /**
   * Fork a utility process and begin monitoring it.
   *
   * Emits `starting` status immediately, then waits for the `ready`
   * bootstrap message to emit `healthy`.
   */
  forkAndMonitor(name: ServiceName): void {
    // Initialize service state.
    const state = this.getOrCreateState(name)
    state.isReady = false
    state.restartAttempts = 0

    this.emitStatus({ state: 'starting', name })

    // Fork the utility process via the manager.
    this.manager.fork(name)

    // Listen for the `ready` bootstrap message.
    this.listenForReady(name)
  }

  /**
   * Fork all specified services and begin monitoring them.
   * Services are forked in parallel (non-blocking).
   */
  forkAllAndMonitor(names: readonly ServiceName[]): void {
    for (const name of names) {
      this.forkAndMonitor(name)
    }
  }

  /**
   * Manually restart a service. Resets the backoff counter.
   * Called from the renderer via IPC (`restartSidecar(name)`).
   */
  async manualRestart(name: ServiceName): Promise<void> {
    console.info(`[lifecycle:${name}] Manual restart requested`)

    // Cancel any pending automatic restart.
    this.cancelPendingRestart(name)

    // Reset state for fresh start.
    const state = this.getOrCreateState(name)
    state.restartAttempts = 0
    state.isReady = false
    this.clearHeartbeatTimer(name)

    // Close renderer-side ports before killing — the old port channels
    // become invalid once the process is restarted.
    this.onProcessExit?.(name)

    this.emitStatus({ state: 'starting', name })

    // Restart via the manager (kills old, forks new).
    await this.manager.restart(name)

    // Listen for the `ready` message from the new process.
    this.listenForReady(name)
  }

  /**
   * Check if a service has been marked as ready (healthy).
   */
  isHealthy(name: ServiceName): boolean {
    return this.services.get(name)?.isReady ?? false
  }

  /**
   * Check if all specified services are healthy.
   */
  areServicesHealthy(names: readonly ServiceName[]): boolean {
    return names.every((name) => this.isHealthy(name))
  }

  /**
   * Get the current status of all monitored services.
   * Used to replay status to windows that missed the initial broadcast
   * (e.g., windows created after services were already healthy).
   */
  getCurrentStatuses(): LifecycleStatus[] {
    const statuses: LifecycleStatus[] = []
    for (const [name, state] of this.services) {
      if (state.isReady) {
        statuses.push({ state: 'healthy', name })
      } else if (state.restartTimer) {
        statuses.push({
          state: 'restarting',
          name,
          delayMs: 0,
        })
      } else {
        statuses.push({ state: 'starting', name })
      }
    }
    return statuses
  }

  /**
   * Pause all heartbeat timers. Called when the system is about to
   * suspend (sleep / lid close). Without this, heartbeat timeouts
   * fire immediately after resume because wall-clock time advanced
   * while the process was frozen, causing false-positive crash
   * detections and unnecessary utility process restarts.
   *
   * @see handleResume — restarts the heartbeat timers after wake.
   */
  handleSuspend(): void {
    console.info('[lifecycle] System suspending — pausing all heartbeat timers')
    for (const [name, state] of this.services) {
      if (state.heartbeatTimer) {
        clearTimeout(state.heartbeatTimer)
        state.heartbeatTimer = null
        console.info(`[lifecycle:${name}] Paused heartbeat timer`)
      }
    }
  }

  /**
   * Restart heartbeat timers after system resume. Gives each healthy
   * service a fresh timeout window to send its next heartbeat.
   *
   * @see handleSuspend — pauses timers before sleep.
   */
  handleResume(): void {
    console.info(
      '[lifecycle] System resumed — restarting heartbeat timers for healthy services'
    )
    for (const [name, state] of this.services) {
      if (state.isReady) {
        this.resetHeartbeatTimer(name)
        console.info(`[lifecycle:${name}] Restarted heartbeat timer`)
      }
    }
  }

  /**
   * Signal that the app is shutting down. Cancels all pending restarts
   * and heartbeat timers, suppresses future restart attempts.
   */
  shutdown(): void {
    this.isQuitting = true

    for (const [name, state] of this.services) {
      if (state.restartTimer) {
        clearTimeout(state.restartTimer)
        state.restartTimer = null
        console.info(
          `[lifecycle:${name}] Cancelled pending restart (shutting down)`
        )
      }
      if (state.heartbeatTimer) {
        clearTimeout(state.heartbeatTimer)
        state.heartbeatTimer = null
      }
    }
  }

  /**
   * Handle a heartbeat message from a utility process.
   * Resets the heartbeat timeout timer.
   *
   * Called by the UtilityProcessManager when it receives a
   * `{ type: 'heartbeat' }` message from a utility process.
   */
  handleHeartbeat(name: ServiceName): void {
    const state = this.services.get(name)
    if (!state?.isReady) {
      return
    }

    this.resetHeartbeatTimer(name)
  }

  /**
   * Handle a `ready` message from a utility process.
   * Transitions the service to `healthy` status and starts heartbeat
   * monitoring.
   *
   * Called by the UtilityProcessManager when it receives a
   * `{ type: 'ready' }` message from a utility process.
   */
  handleReady(name: ServiceName): void {
    const state = this.services.get(name)
    if (!state) {
      return
    }

    if (state.isReady) {
      // Already marked as ready — ignore duplicate.
      return
    }

    state.isReady = true
    state.restartAttempts = 0

    console.info(`[lifecycle:${name}] Service ready — marking healthy`)
    this.emitStatus({ state: 'healthy', name })

    // Start heartbeat monitoring.
    this.resetHeartbeatTimer(name)
  }

  // -------------------------------------------------------------------------
  // Private methods
  // -------------------------------------------------------------------------

  /**
   * Listen for the `ready` bootstrap message from a utility process.
   * The UtilityProcessManager already logs these messages — we hook
   * into them via the message event on the child process.
   *
   * Note: The bootstrap `ready` message is handled via
   * `handleReady()` which is called from the UtilityProcessManager's
   * message event listener (wired up in main.ts).
   */
  private listenForReady(_name: ServiceName): void {
    // The ready message handling is done via handleReady() which
    // is called from the UtilityProcessManager's message listener.
    // This method is a placeholder for clarity — the actual wiring
    // happens in main.ts where messages from utility processes are
    // forwarded to the LifecycleMonitor.
  }

  /**
   * Handle unexpected process exit: emit crashed status and schedule
   * an automatic restart with exponential backoff.
   */
  private handleUnexpectedExit(
    name: ServiceName,
    code: number,
    lastStderr: string
  ): void {
    if (this.isQuitting) {
      return
    }

    // Clear heartbeat timer since the process is gone.
    this.clearHeartbeatTimer(name)

    // Close all renderer-side MessagePorts for this service so the
    // renderer's `onclose` handler fires and RPC clients detect the
    // dead channel immediately (instead of relying on the unreliable
    // Web MessagePort close event from GC).
    this.onProcessExit?.(name)

    // Mark as not ready.
    const state = this.getOrCreateState(name)
    state.isReady = false

    const error = lastStderr
      ? `Process exited unexpectedly (code=${code}).\n${lastStderr}`
      : `Process exited unexpectedly (code=${code}).`

    console.error(`[lifecycle:${name}] ${error}`)
    this.emitStatus({ state: 'crashed', name, error })

    // Schedule automatic restart with backoff.
    this.scheduleRestart(name)
  }

  /**
   * Schedule a restart with exponential backoff.
   * If a restart is already pending or the max restart limit is reached,
   * the request is ignored.
   */
  private scheduleRestart(name: ServiceName): void {
    if (this.isQuitting) {
      return
    }

    const state = this.getOrCreateState(name)

    // Don't stack multiple restart timers.
    if (state.restartTimer) {
      return
    }

    // Check max restart limit.
    if (state.restartAttempts >= this.maxRestarts) {
      console.error(
        `[lifecycle:${name}] Max restart attempts (${this.maxRestarts}) reached — giving up`
      )
      this.emitStatus({
        state: 'crashed',
        name,
        error: `Service failed to restart after ${this.maxRestarts} attempts.`,
      })
      return
    }

    const attempt = state.restartAttempts
    const delayMs = backoffDelay(attempt)
    state.restartAttempts = attempt + 1

    console.info(
      `[lifecycle:${name}] Scheduling restart in ${delayMs}ms (attempt ${attempt + 1}/${this.maxRestarts})`
    )
    this.emitStatus({ state: 'restarting', name, delayMs })

    const timer = setTimeout(() => {
      state.restartTimer = null
      this.executeRestart(name)
    }, delayMs)

    // Don't let the timer prevent app exit.
    timer.unref()

    state.restartTimer = timer
  }

  /**
   * Execute a restart: fork a new process and begin monitoring it.
   */
  private executeRestart(name: ServiceName): void {
    if (this.isQuitting) {
      return
    }

    const state = this.getOrCreateState(name)
    state.isReady = false

    this.emitStatus({ state: 'starting', name })

    try {
      this.manager.fork(name)
      this.listenForReady(name)
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Unknown error during restart'
      console.error(`[lifecycle:${name}] Restart failed: ${message}`)
      this.emitStatus({ state: 'crashed', name, error: message })
    }
  }

  /**
   * Reset the heartbeat timeout timer for a service.
   * If no heartbeat is received within HEARTBEAT_TIMEOUT_MS, the
   * process is considered unresponsive and is killed + restarted.
   */
  private resetHeartbeatTimer(name: ServiceName): void {
    const state = this.services.get(name)
    if (!state) {
      return
    }

    // Clear existing timer.
    if (state.heartbeatTimer) {
      clearTimeout(state.heartbeatTimer)
    }

    state.heartbeatArmedAt = Date.now()

    const timer = setTimeout(() => {
      state.heartbeatTimer = null
      this.handleHeartbeatTimeout(name)
    }, HEARTBEAT_TIMEOUT_MS)

    // Don't let the timer prevent app exit.
    timer.unref()

    state.heartbeatTimer = timer
  }

  /**
   * Handle heartbeat timeout: the process is unresponsive.
   * Kill and restart it.
   */
  private handleHeartbeatTimeout(name: ServiceName): void {
    if (this.isQuitting) {
      return
    }

    const state = this.services.get(name)
    if (!state?.isReady) {
      // Already marked as not ready (e.g., already crashed).
      return
    }

    // Late-fire detection: if far more wall-clock time elapsed than the
    // scheduled window, the system slept mid-window (e.g. a macOS
    // DarkWake that never emitted suspend/resume). The utility process
    // was frozen, not hung — give it a fresh window instead of killing.
    const elapsedMs = Date.now() - state.heartbeatArmedAt
    if (elapsedMs > HEARTBEAT_TIMEOUT_MS + HEARTBEAT_CLOCK_JUMP_TOLERANCE_MS) {
      console.info(
        `[lifecycle:${name}] Heartbeat timeout fired ${elapsedMs}ms after arming ` +
          `(expected ~${HEARTBEAT_TIMEOUT_MS}ms) — system likely slept. ` +
          'Re-arming instead of killing.'
      )
      this.resetHeartbeatTimer(name)
      return
    }

    state.isReady = false

    // Close renderer-side ports before killing so RPC clients detect
    // the dead channel immediately.
    this.onProcessExit?.(name)

    const error = `Process unresponsive — no heartbeat received within ${HEARTBEAT_TIMEOUT_MS}ms.`
    console.error(`[lifecycle:${name}] ${error}`)
    this.emitStatus({ state: 'crashed', name, error })

    // Kill the unresponsive process.
    this.manager.kill(name)

    // Schedule restart with backoff.
    this.scheduleRestart(name)
  }

  /**
   * Cancel a pending restart timer for a service.
   */
  private cancelPendingRestart(name: ServiceName): void {
    const state = this.services.get(name)
    if (!state?.restartTimer) {
      return
    }

    clearTimeout(state.restartTimer)
    state.restartTimer = null
  }

  /**
   * Clear the heartbeat timer for a service.
   */
  private clearHeartbeatTimer(name: ServiceName): void {
    const state = this.services.get(name)
    if (!state?.heartbeatTimer) {
      return
    }

    clearTimeout(state.heartbeatTimer)
    state.heartbeatTimer = null
  }

  /**
   * Get or create the state tracking object for a service.
   */
  private getOrCreateState(name: ServiceName): ServiceState {
    let state = this.services.get(name)
    if (!state) {
      state = {
        heartbeatArmedAt: 0,
        heartbeatTimer: null,
        isReady: false,
        restartTimer: null,
        restartAttempts: 0,
      }
      this.services.set(name, state)
    }
    return state
  }

  /**
   * Emit a status event to the listener and forward to all renderer windows.
   */
  private emitStatus(status: LifecycleStatus): void {
    console.info(`[lifecycle:${status.name}] ${status.state}`)
    this.listener?.(status)

    // Forward to all renderer windows via IPC.
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(SIDECAR_STATUS_CHANNEL, status)
      }
    }
  }
}
