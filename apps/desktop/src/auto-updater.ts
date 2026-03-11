import type {
  DesktopRuntimeInfo,
  DesktopUpdateActionResult,
  DesktopUpdateState,
} from '@laborer/shared/desktop-bridge'
import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'

import {
  isArm64HostRunningIntelBuild,
  resolveDesktopRuntimeInfo,
} from './runtime-arch.js'
import {
  createInitialUpdateState,
  reduceOnCheckFailure,
  reduceOnCheckStart,
  reduceOnDownloadComplete,
  reduceOnDownloadFailure,
  reduceOnDownloadProgress,
  reduceOnDownloadStart,
  reduceOnInstallFailure,
  reduceOnNoUpdate,
  reduceOnUpdateAvailable,
} from './update-machine.js'
import {
  getAutoUpdateDisabledReason,
  shouldBroadcastDownloadProgress,
} from './update-state.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Delay before the first update check after app launch. */
const AUTO_UPDATE_STARTUP_DELAY_MS = 15_000

/** Interval between periodic update checks. */
const AUTO_UPDATE_POLL_INTERVAL_MS = 4 * 60 * 60 * 1000 // 4 hours

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let updateState: DesktopUpdateState
let runtimeInfo: DesktopRuntimeInfo

/** True while a `checkForUpdates()` call is in flight. */
let updateCheckInFlight = false

/** True while a `downloadUpdate()` call is in flight. */
let updateDownloadInFlight = false

/** Reference to the periodic check timer (so it can be cancelled). */
let pollTimer: ReturnType<typeof setInterval> | null = null

/** Reference to the startup delay timer. */
let startupTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Callback to invoke when the app should quit during install.
 * Set by `configureAutoUpdater()` so the main module can control quitting.
 */
let onQuitForInstall: (() => void) | null = null

// ---------------------------------------------------------------------------
// State broadcasting
// ---------------------------------------------------------------------------

/** Broadcasts the current update state to all BrowserWindow instances. */
function emitUpdateState(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    try {
      window.webContents.send('desktop:update-state', updateState)
    } catch {
      // Window may have been destroyed between iteration and send.
    }
  }
}

/** Update the state and broadcast. */
function setState(nextState: DesktopUpdateState): void {
  updateState = nextState
  emitUpdateState()
}

// ---------------------------------------------------------------------------
// Update actions
// ---------------------------------------------------------------------------

function nowISO(): string {
  return new Date().toISOString()
}

/**
 * Check for available updates. Guards against re-entry and skips if
 * already downloading or downloaded.
 */
async function checkForUpdates(reason: string): Promise<void> {
  if (updateCheckInFlight) {
    return
  }
  if (
    updateState.status === 'downloading' ||
    updateState.status === 'downloaded'
  ) {
    return
  }

  updateCheckInFlight = true
  setState(reduceOnCheckStart(updateState, nowISO()))

  try {
    console.log(`[auto-updater] Checking for updates (${reason})`)
    await autoUpdater.checkForUpdates()
  } catch (error) {
    setState(
      reduceOnCheckFailure(
        updateState,
        error instanceof Error ? error.message : String(error),
        nowISO()
      )
    )
  } finally {
    updateCheckInFlight = false
  }
}

/**
 * Download an available update. Guards against re-entry.
 * Returns an action result indicating whether the action was accepted.
 */
async function downloadAvailableUpdate(): Promise<DesktopUpdateActionResult> {
  if (updateState.status !== 'available') {
    return { accepted: false, completed: false, state: updateState }
  }
  if (updateDownloadInFlight) {
    return { accepted: false, completed: false, state: updateState }
  }

  updateDownloadInFlight = true
  setState(reduceOnDownloadStart(updateState))

  try {
    console.log('[auto-updater] Downloading update')
    await autoUpdater.downloadUpdate()
    return { accepted: true, completed: true, state: updateState }
  } catch (error) {
    setState(
      reduceOnDownloadFailure(
        updateState,
        error instanceof Error ? error.message : String(error)
      )
    )
    return { accepted: true, completed: false, state: updateState }
  } finally {
    updateDownloadInFlight = false
  }
}

/**
 * Quit and install a downloaded update. On success this never returns
 * (the process restarts). On failure, returns an action result.
 */
async function installDownloadedUpdate(): Promise<DesktopUpdateActionResult> {
  if (updateState.status !== 'downloaded') {
    return { accepted: false, completed: false, state: updateState }
  }

  try {
    console.log('[auto-updater] Installing update and restarting')

    // Signal the main module to begin its quit sequence.
    onQuitForInstall?.()

    // Small delay to let cleanup happen before restart.
    await new Promise((resolve) => setTimeout(resolve, 200))

    autoUpdater.quitAndInstall()
    return { accepted: true, completed: true, state: updateState }
  } catch (error) {
    setState(
      reduceOnInstallFailure(
        updateState,
        error instanceof Error ? error.message : String(error)
      )
    )
    return { accepted: true, completed: false, state: updateState }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the current update state. Called by IPC handlers.
 */
export function getUpdateState(): DesktopUpdateState {
  return updateState
}

/**
 * Triggers download of an available update. Called by IPC handlers.
 */
export async function triggerDownloadUpdate(): Promise<DesktopUpdateActionResult> {
  return await downloadAvailableUpdate()
}

/**
 * Triggers quit-and-install of a downloaded update. Called by IPC handlers.
 */
export async function triggerInstallUpdate(): Promise<DesktopUpdateActionResult> {
  return await installDownloadedUpdate()
}

/**
 * Broadcasts the current update state to a newly loaded window.
 * Call this from `did-finish-load` so new pages get the current state.
 */
export function broadcastUpdateStateToWindow(window: BrowserWindow): void {
  try {
    window.webContents.send('desktop:update-state', updateState)
  } catch {
    // Window may have been destroyed.
  }
}

/**
 * Configure and start the auto-updater.
 *
 * Call this once during app bootstrap (after `app.whenReady()`).
 * In development or unpackaged builds, auto-updates are disabled and
 * the state machine stays in the `disabled` status.
 *
 * @param quitCallback - Called when the updater needs the app to quit for install.
 */
export function configureAutoUpdater(quitCallback: () => void): void {
  onQuitForInstall = quitCallback

  // Resolve architecture information.
  runtimeInfo = resolveDesktopRuntimeInfo({
    platform: process.platform,
    processArch: process.arch,
    runningUnderArm64Translation: app.runningUnderARM64Translation ?? false,
  })

  // Create initial state.
  updateState = createInitialUpdateState(app.getVersion(), runtimeInfo)

  // Check if auto-updates should be disabled.
  const disabledReason = getAutoUpdateDisabledReason({
    isDevelopment: !app.isPackaged,
    isPackaged: app.isPackaged,
    platform: process.platform,
    disabledByEnv: process.env.LABORER_DISABLE_AUTO_UPDATE === '1',
  })

  if (disabledReason) {
    console.log(`[auto-updater] Disabled: ${disabledReason}`)
    setState({
      ...updateState,
      message: disabledReason,
    })
    return
  }

  // Enable auto-updates.
  console.log('[auto-updater] Auto-updates enabled')

  if (isArm64HostRunningIntelBuild(runtimeInfo)) {
    console.warn(
      '[auto-updater] This Mac has Apple Silicon but the app is running the Intel build under Rosetta. ' +
        'Differential downloads will be disabled.'
    )
  }

  // Configure electron-updater.
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = false
  autoUpdater.disableDifferentialDownload =
    isArm64HostRunningIntelBuild(runtimeInfo)

  // Transition to idle.
  setState({
    ...updateState,
    enabled: true,
    status: 'idle',
  })

  // Wire electron-updater events to the state machine.
  autoUpdater.on('update-available', (info: { version: string }) => {
    const version = info.version ?? 'unknown'
    setState(reduceOnUpdateAvailable(updateState, version, nowISO()))
  })

  autoUpdater.on('update-not-available', () => {
    setState(reduceOnNoUpdate(updateState, nowISO()))
  })

  autoUpdater.on('error', (error: Error) => {
    // Determine whether this error occurred during check or download.
    if (updateDownloadInFlight) {
      setState(reduceOnDownloadFailure(updateState, error.message))
    } else {
      setState(reduceOnCheckFailure(updateState, error.message, nowISO()))
    }
  })

  autoUpdater.on('download-progress', (progress: { percent: number }) => {
    const percent = Math.round(progress.percent * 10) / 10
    if (shouldBroadcastDownloadProgress(updateState, percent)) {
      setState(reduceOnDownloadProgress(updateState, percent))
    } else {
      // Still update internal state, just don't broadcast.
      updateState = reduceOnDownloadProgress(updateState, percent)
    }
  })

  autoUpdater.on('update-downloaded', (info: { version: string }) => {
    const version = info.version ?? updateState.availableVersion ?? 'unknown'
    setState(reduceOnDownloadComplete(updateState, version))
  })

  // Schedule first check after startup delay.
  startupTimer = setTimeout(() => {
    startupTimer = null
    checkForUpdates('startup').catch(console.error)
  }, AUTO_UPDATE_STARTUP_DELAY_MS)
  startupTimer.unref()

  // Schedule periodic checks.
  pollTimer = setInterval(() => {
    checkForUpdates('poll').catch(console.error)
  }, AUTO_UPDATE_POLL_INTERVAL_MS)
  pollTimer.unref()
}

/**
 * Stop all timers and clean up. Call during app shutdown.
 */
export function shutdownAutoUpdater(): void {
  if (startupTimer) {
    clearTimeout(startupTimer)
    startupTimer = null
  }
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}
