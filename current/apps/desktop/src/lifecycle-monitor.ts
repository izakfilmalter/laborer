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
 * - Heartbeat monitoring in awake time (process-time countdowns; OS sleep
 *   never advances a heartbeat timeout — ADR 0003)
 * - Status events forwarded to renderer windows
 * - Max restart limit (default 5, matching VS Code's `MaxRestarts`)
 * - Manual restart support (resets backoff counter)
 * - Graceful shutdown: cancels all pending restart timers
 *
 * **Heartbeat consequences are per-service (ADR 0003):**
 * - The terminal service holds irreplaceable state (live PTYs running
 *   agents), so heartbeat silence is *advisory only* — it emits an
 *   `unresponsive` status (status pill + manual restart affordance) and
 *   self-heals on the next beat. It is never killed by the watchdog;
 *   restarts happen only on actual process exit or user request. This
 *   matches VS Code's pty host, whose missed heartbeats only ever fire
 *   `onPtyHostUnresponsive`.
 * - The stateless file-watcher sidecar keeps kill + restart on
 *   heartbeat timeout.
 *
 * Follows VS Code's patterns:
 * @see .reference/vscode/src/vs/platform/terminal/node/heartbeatService.ts
 * @see .reference/vscode/src/vs/platform/terminal/node/ptyHostService.ts
 * @see docs/adr/0003-advisory-liveness-explicit-terminal-lifecycle.md
 */

import {
  type ProcessTimeTimeout,
  scheduleProcessTimeTimeout,
} from '@laborer/shared/process-time-scheduler'
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
 * Awake time to wait before logging a heartbeat warning (ms).
 * Mirrors VS Code's first-stage timeout (`FirstWaitMultiplier`), which
 * exists to surface jitter without taking any action.
 */
export const HEARTBEAT_WARN_MS = 6000

/**
 * Awake time to wait for a heartbeat before declaring the process
 * unresponsive (ms). 3x the heartbeat interval to tolerate missed beats.
 *
 * Measured in process-alive time via {@link scheduleProcessTimeTimeout}:
 * OS sleep (including macOS DarkWake, which emits no `suspend`/`resume`)
 * never advances the countdown, so a wake can never produce a
 * false-positive timeout. No clock-jump tolerance is needed.
 */
export const HEARTBEAT_TIMEOUT_MS = 15_000

/**
 * Services whose heartbeat is advisory only (ADR 0003). On timeout they
 * are declared `unresponsive` (status pill + manual restart affordance)
 * instead of being killed, and self-heal on the next beat. The terminal
 * service is listed because it holds irreplaceable live PTY state.
 */
export const STATUS_ONLY_HEARTBEAT_SERVICES: ReadonlySet<ServiceName> = new Set(
  ['terminal']
)

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
      /**
       * Advisory: the process is alive but heartbeats have stopped for
       * {@link HEARTBEAT_TIMEOUT_MS} of awake time. Emitted only for
       * {@link STATUS_ONLY_HEARTBEAT_SERVICES}; self-heals to `healthy`
       * on the next beat. No ports are closed and nothing is killed.
       */
      readonly state: 'unresponsive'
      readonly name: ServiceName
    }
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
  /** Second-stage heartbeat countdown (awake time) — declares/acts. */
  heartbeatActionTimer: ProcessTimeTimeout | null
  /** First-stage heartbeat countdown (awake time) — warns only. */
  heartbeatWarnTimer: ProcessTimeTimeout | null
  /** Whether the service has sent its `ready` message. */
  isReady: boolean
  /**
   * Whether a status-only service is currently declared unresponsive.
   * Cleared (with a `healthy` status emit) on the next heartbeat.
   */
  isUnresponsive: boolean
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
    state.isUnresponsive = false
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
      if (state.isReady && state.isUnresponsive) {
        statuses.push({ state: 'unresponsive', name })
      } else if (state.isReady) {
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
      this.clearHeartbeatTimer(name)
    }
  }

  /**
   * Handle a heartbeat message from a utility process.
   * Resets the heartbeat countdown, and self-heals a status-only service
   * that was previously declared unresponsive.
   *
   * Called by the UtilityProcessManager when it receives a
   * `{ type: 'heartbeat' }` message from a utility process.
   */
  handleHeartbeat(name: ServiceName): void {
    const state = this.services.get(name)
    if (!state?.isReady) {
      return
    }

    if (state.isUnresponsive) {
      state.isUnresponsive = false
      console.info(
        `[lifecycle:${name}] Heartbeat received — service responsive again`
      )
      this.emitStatus({ state: 'healthy', name })
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
    state.isUnresponsive = false
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
    state.isUnresponsive = false

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
   * Reset the heartbeat countdowns for a service.
   *
   * Both stages count *awake* time (process-time countdowns): OS sleep
   * never advances them, so a wake can never fire a false timeout.
   * Stage one ({@link HEARTBEAT_WARN_MS}) only logs; stage two
   * ({@link HEARTBEAT_TIMEOUT_MS}) declares the service unresponsive
   * (status-only services) or kills it (stateless sidecars).
   */
  private resetHeartbeatTimer(name: ServiceName): void {
    const state = this.services.get(name)
    if (!state) {
      return
    }

    state.heartbeatWarnTimer?.cancel()
    state.heartbeatActionTimer?.cancel()

    state.heartbeatWarnTimer = scheduleProcessTimeTimeout(
      () => {
        state.heartbeatWarnTimer = null
        console.warn(
          `[lifecycle:${name}] No heartbeat for ${HEARTBEAT_WARN_MS}ms of awake time`
        )
      },
      HEARTBEAT_WARN_MS,
      { unref: true }
    )

    state.heartbeatActionTimer = scheduleProcessTimeTimeout(
      () => {
        state.heartbeatActionTimer = null
        this.handleHeartbeatTimeout(name)
      },
      HEARTBEAT_TIMEOUT_MS,
      { unref: true }
    )
  }

  /**
   * Handle heartbeat timeout: the process has been silent for a full
   * awake-time window.
   *
   * Per ADR 0003 the consequence depends on the service:
   * - Status-only services (terminal): emit `unresponsive` and wait —
   *   the next heartbeat self-heals back to `healthy`. Never killed.
   * - Stateless sidecars: kill + restart.
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

    if (STATUS_ONLY_HEARTBEAT_SERVICES.has(name)) {
      if (!state.isUnresponsive) {
        state.isUnresponsive = true
        console.warn(
          `[lifecycle:${name}] No heartbeat within ${HEARTBEAT_TIMEOUT_MS}ms of awake time — ` +
            'declaring unresponsive (advisory only; will self-heal on next beat)'
        )
        this.emitStatus({ state: 'unresponsive', name })
      }
      // Stay armed so a genuinely hung service keeps reporting, and so
      // recovery is detected by handleHeartbeat when beats resume.
      return
    }

    state.isReady = false

    // Close renderer-side ports before killing so RPC clients detect
    // the dead channel immediately.
    this.onProcessExit?.(name)

    const error = `Process unresponsive — no heartbeat received within ${HEARTBEAT_TIMEOUT_MS}ms of awake time.`
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
   * Clear the heartbeat countdowns for a service.
   */
  private clearHeartbeatTimer(name: ServiceName): void {
    const state = this.services.get(name)
    if (!state) {
      return
    }

    state.heartbeatWarnTimer?.cancel()
    state.heartbeatWarnTimer = null
    state.heartbeatActionTimer?.cancel()
    state.heartbeatActionTimer = null
  }

  /**
   * Get or create the state tracking object for a service.
   */
  private getOrCreateState(name: ServiceName): ServiceState {
    let state = this.services.get(name)
    if (!state) {
      state = {
        heartbeatActionTimer: null,
        heartbeatWarnTimer: null,
        isReady: false,
        isUnresponsive: false,
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
