/**
 * Bootstrap entry point for Electron utility processes.
 *
 * All utility processes are forked via `utilityProcess.fork()` with this file
 * as the module path. The actual service module is specified via the
 * `LABORER_ENTRYPOINT` environment variable and dynamically imported.
 *
 * Communication with the parent (main) process uses `process.parentPort`,
 * which is only available inside Electron utility processes.
 *
 * Protocol:
 * - On successful load: sends `{ type: 'ready' }` to the parent
 * - After ready: sends `{ type: 'heartbeat' }` every 5s for liveness monitoring
 * - On load failure: sends `{ type: 'error', message }` and exits with code 1
 *
 * Follows VS Code's bootstrap-fork pattern where the entry point is passed
 * via an environment variable (VS Code uses `VSCODE_ESM_ENTRYPOINT`).
 *
 * @see .reference/vscode/src/vs/platform/utilityProcess/electron-main/utilityProcess.ts
 * @see lifecycle-monitor.ts — HEARTBEAT_INTERVAL_MS / HEARTBEAT_TIMEOUT_MS
 */

import type { UtilityProcessBootstrapMessage } from './utility-process-types.js'

// ---------------------------------------------------------------------------
// Utility process detection
// ---------------------------------------------------------------------------

/**
 * Detect whether we are running inside an Electron utility process.
 *
 * Utility processes have `process.parentPort` available — regular Node.js
 * processes and the Electron main process do not.
 *
 * @see .reference/vscode/src/vs/base/parts/sandbox/node/electronTypes.ts (isUtilityProcess)
 */
function isUtilityProcess(): boolean {
  return (
    typeof process !== 'undefined' &&
    'parentPort' in process &&
    process.parentPort !== undefined
  )
}

/**
 * Send a typed message to the parent process.
 *
 * Asserts that we are in a utility process context (parentPort is available).
 */
function sendToParent(message: UtilityProcessBootstrapMessage): void {
  process.parentPort.postMessage(message)
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function bootstrap(): Promise<void> {
  if (!isUtilityProcess()) {
    console.error(
      '[utility-bootstrap] Not running in a utility process context ' +
        '(process.parentPort is not available). ' +
        'This script must be launched via utilityProcess.fork().'
    )
    process.exit(1)
    return
  }

  const entrypoint = process.env.LABORER_ENTRYPOINT
  if (!entrypoint) {
    const message =
      'LABORER_ENTRYPOINT environment variable is not set. ' +
      'Cannot determine which service module to load.'
    console.error(`[utility-bootstrap] ${message}`)
    sendToParent({ type: 'error', message })
    process.exit(1)
    return
  }

  try {
    // Dynamically import the service module.
    // The entrypoint is an absolute path to the service's built entry
    // (e.g., packages/terminal/dist/main.mjs).
    await import(entrypoint)

    // Signal readiness to the parent process.
    sendToParent({ type: 'ready' })

    // Start periodic heartbeat messages so the LifecycleMonitor knows
    // this process is alive. The interval (5s) must be shorter than
    // the monitor's timeout (15s = 3x interval). The timer is unref'd
    // so it doesn't prevent the process from exiting naturally.
    const heartbeatTimer = setInterval(() => {
      sendToParent({ type: 'heartbeat' })
    }, 5000)
    heartbeatTimer.unref()
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? `Failed to load entrypoint "${entrypoint}": ${error.message}`
        : `Failed to load entrypoint "${entrypoint}": ${String(error)}`
    console.error(`[utility-bootstrap] ${message}`)

    if (error instanceof Error && error.stack) {
      console.error(`[utility-bootstrap] ${error.stack}`)
    }

    sendToParent({ type: 'error', message })
    process.exit(1)
  }
}

bootstrap()
