import { join } from 'node:path'

import { app, BrowserWindow } from 'electron'

import {
  broadcastUpdateStateToWindow,
  configureAutoUpdater,
  getUpdateState,
  shutdownAutoUpdater,
  triggerDownloadUpdate,
  triggerInstallUpdate,
} from './auto-updater.js'
import { fixPath } from './fix-path.js'
import { HealthMonitor } from './health.js'
import {
  getWorkspaceWindowRegistry,
  registerIpcHandlers,
  setDownloadUpdateHandler,
  setGetUpdateStateHandler,
  setInstallUpdateHandler,
  setRestartSidecarHandler,
  setTrayCountHandler,
} from './ipc.js'
import { configureApplicationMenu } from './menu.js'
import { reserveServicePorts, type ServicePorts } from './ports.js'
import {
  DESKTOP_SCHEME,
  registerDesktopProtocol,
  registerSchemeAsPrivileged,
  resolveStaticRoot,
} from './protocol.js'
import { SidecarManager } from './sidecar.js'
import { registerGlobalShortcut, TrayManager } from './tray.js'
import { buildWindowBootstrapArgs, createWindowId } from './window-identity.js'
import { type WindowRecord, WindowStateManager } from './window-state.js'

// Fix PATH before anything else — must happen synchronously before
// any child processes are spawned. On macOS, apps launched from
// Finder/Dock inherit a minimal PATH from launchd.
fixPath()

// Register the custom laborer:// protocol scheme as privileged.
// MUST happen synchronously before app.whenReady().
registerSchemeAsPrivileged()

// ---------------------------------------------------------------------------
// GitHub OAuth protocol handler
// ---------------------------------------------------------------------------
// Register x-github-desktop-dev-auth:// so the OS routes the OAuth callback
// back to this app after the user authorizes in the browser.

const GITHUB_OAUTH_PROTOCOL = 'x-github-desktop-dev-auth'

/** Pending OAuth URL received before a window was ready. */
let pendingOAuthUrl: string | null = null

/**
 * Broadcast a GitHub OAuth callback URL to all renderer windows.
 */
function handleGithubOAuthUrl(url: string): void {
  const windows = BrowserWindow.getAllWindows()
  if (windows.length === 0) {
    // Window not ready yet — store for later delivery.
    pendingOAuthUrl = url
    return
  }

  for (const window of windows) {
    window.webContents.send('desktop:github-oauth-callback', url)
  }
}

// macOS: the OS delivers custom-protocol URLs via the open-url event.
// This MUST be registered before app.whenReady() to catch URLs that
// triggered the app launch.
app.on('open-url', (event, url) => {
  if (url.startsWith(`${GITHUB_OAUTH_PROTOCOL}://`)) {
    event.preventDefault()
    handleGithubOAuthUrl(url)
  }
})

/**
 * Vite dev server URL, set by the dev-electron script.
 * When present, the renderer loads from the dev server instead of a custom protocol.
 */
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

/**
 * Whether we are in development mode.
 * In dev mode, services are run separately via `turbo dev` and the
 * Electron shell does NOT spawn them as child processes.
 */
const isDev = Boolean(VITE_DEV_SERVER_URL)

/** Traffic light button inset for the hidden title bar. */
const TRAFFIC_LIGHT_POSITION = { x: 16, y: 12 } as const

const openWindows = new Set<BrowserWindow>()
let mainWindow: BrowserWindow | null = null

/**
 * Reserved ports and auth token for child process communication.
 * Populated during bootstrap before the window is created.
 * Used by child process spawning and preload bridge.
 */
let servicePorts: ServicePorts | null = null

/**
 * Sidecar manager for child process lifecycle.
 * Only created in production mode (when services need to be spawned).
 */
let sidecarManager: SidecarManager | null = null

/**
 * Health monitor for sidecar health checking, crash detection, and
 * automatic restart with exponential backoff.
 * Only created in production mode.
 */
let healthMonitor: HealthMonitor | null = null

/** System tray icon manager. */
const trayManager = new TrayManager()

/** Window state manager — persists and restores window bounds across restarts. */
const windowStateManager = new WindowStateManager()

/** Cleanup function for the global shortcut. */
let unregisterShortcut: (() => void) | null = null

/**
 * Whether the app is in the process of quitting.
 * Used by close-to-tray to distinguish between "hide" (click X) and
 * "actually quit" (Cmd+Q, tray Quit, or `app.quit()`).
 */
let isQuitting = false

/** Get the reserved service ports. Throws if called before bootstrap. */
export function getServicePorts(): ServicePorts {
  if (!servicePorts) {
    throw new Error('Service ports not yet initialized')
  }
  return servicePorts
}

/** Get the sidecar manager (null in dev mode). */
export function getSidecarManager(): SidecarManager | null {
  return sidecarManager
}

/** Get the health monitor (null in dev mode). */
export function getHealthMonitor(): HealthMonitor | null {
  return healthMonitor
}

function getMainWindow(): BrowserWindow | null {
  const focusedWindow = BrowserWindow.getFocusedWindow()

  if (focusedWindow && !focusedWindow.isDestroyed()) {
    return focusedWindow
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow
  }

  return BrowserWindow.getAllWindows()[0] ?? null
}

function shouldHideOnClose(window: BrowserWindow): boolean {
  if (isQuitting) {
    return false
  }

  const otherVisibleWindows = BrowserWindow.getAllWindows().filter(
    (candidate) =>
      candidate !== window && !candidate.isDestroyed() && candidate.isVisible()
  )

  return otherVisibleWindows.length === 0
}

function createWindow(record?: WindowRecord): BrowserWindow {
  const savedState = record ?? windowStateManager.load()
  const windowId = record?.windowId ?? createWindowId()

  const window = new BrowserWindow({
    ...savedState.bounds,
    minWidth: 840,
    minHeight: 620,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: TRAFFIC_LIGHT_POSITION,
    webPreferences: {
      preload: join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: buildPreloadArgs(windowId),
    },
  })

  openWindows.add(window)
  mainWindow ??= window

  // Restore maximized state after window creation.
  if (savedState.isMaximized) {
    window.maximize()
  }

  // Track window bounds for persistence — saves on move/resize/close.
  windowStateManager.track(window, windowId)

  window.once('ready-to-show', () => {
    window.show()
  })

  if (VITE_DEV_SERVER_URL) {
    window.loadURL(VITE_DEV_SERVER_URL).catch(console.error)
  } else {
    // Production: serve the frontend via the custom laborer:// protocol.
    // Load the root path (not /index.html) so TanStack Router matches "/".
    window.loadURL(`${DESKTOP_SCHEME}://app/`).catch(console.error)
  }

  window.webContents.on('did-finish-load', () => {
    broadcastUpdateStateToWindow(window)
  })

  // Preserve the last visible window's existing close-to-tray behavior, but
  // let non-last windows close normally so their sessions stay restorable.
  let hiddenToTray = false

  window.on('close', (event) => {
    if (shouldHideOnClose(window)) {
      hiddenToTray = true
      event.preventDefault()
      window.hide()
    }
  })

  window.on('closed', () => {
    openWindows.delete(window)
    getWorkspaceWindowRegistry().remove(window)

    // Remove the persisted record for windows the user intentionally closed.
    // During app quit, only windows that were previously hidden to tray
    // (i.e. the user already closed them) get their records removed.
    // Windows that were still open at quit time keep their records for restore.
    if (!isQuitting || hiddenToTray) {
      windowStateManager.removeWindowRecord(windowId)
    }

    if (mainWindow === window) {
      mainWindow = openWindows.values().next().value ?? null
    }
  })

  return window
}

/**
 * Build the `additionalArguments` array for the preload script.
 *
 * Electron's sandbox mode blocks access to `process.env` in the preload,
 * so we pass service URLs as command-line arguments that the preload
 * can read from `process.argv`.
 *
 * Format: `--laborer-<key>=<value>` (prefixed to avoid collisions).
 */
function buildPreloadArgs(windowId: string): string[] {
  if (!servicePorts) {
    return []
  }

  return buildWindowBootstrapArgs({
    serverUrl: `http://127.0.0.1:${servicePorts.serverPort}`,
    terminalUrl: `http://127.0.0.1:${servicePorts.terminalPort}`,
    windowId,
  })
}

app
  .whenReady()
  .then(async () => {
    // Reserve ephemeral ports for services and generate auth token.
    servicePorts = await reserveServicePorts()

    // In production, register the custom laborer:// protocol handler
    // that serves the built frontend from disk.
    if (!isDev) {
      const appRoot = join(import.meta.dirname, '..', '..', '..')
      const staticRoot = resolveStaticRoot(appRoot)

      if (staticRoot) {
        registerDesktopProtocol(staticRoot)
      } else {
        console.error(
          '[main] Could not find built frontend (apps/web/dist/). ' +
            'The laborer:// protocol will not be available.'
        )
      }
    }

    // In production, spawn sidecar services with health monitoring.
    // In dev mode, services are run separately via `turbo dev`.
    if (!isDev) {
      sidecarManager = new SidecarManager(servicePorts)
      healthMonitor = new HealthMonitor(sidecarManager, servicePorts)

      // Forward sidecar status events to the renderer.
      healthMonitor.setStatusListener((status) => {
        if (status.state === 'crashed') {
          console.error(
            `[main] Sidecar ${status.name} crashed: ${status.error}`
          )
        }

        for (const window of BrowserWindow.getAllWindows()) {
          window.webContents.send('sidecar:status', status)
        }
      })

      // Spawn services without blocking — the web app's ServerGate component
      // (apps/web/src/components/server-gate.tsx) blocks the main UI until
      // all core services are healthy, showing status and retry options.
      // This allows the window to render immediately with the header visible.
      healthMonitor.spawnServices().then((servicesOk) => {
        if (!servicesOk) {
          console.error(
            '[main] One or more services failed to become healthy on startup'
          )
        }
      })
    }

    // Register x-github-desktop-dev-auth:// as a protocol handler so
    // the OAuth callback from GitHub lands back in this app.
    app.setAsDefaultProtocolClient(GITHUB_OAUTH_PROTOCOL)

    // Deliver any pending OAuth URL that arrived before windows were ready.
    if (pendingOAuthUrl) {
      handleGithubOAuthUrl(pendingOAuthUrl)
      pendingOAuthUrl = null
    }

    // Register IPC handlers once for the DesktopBridge contract.
    // Handlers use event.sender to resolve the requesting window,
    // so they work correctly regardless of which window invokes them.
    registerIpcHandlers(() => getMainWindow())

    // Wire tray workspace count updates from the renderer to the tray manager.
    setTrayCountHandler((count) => {
      trayManager.updateWorkspaceCount(count)
    })

    // Wire sidecar restart requests from the renderer to the health monitor.
    setRestartSidecarHandler(async (name) => {
      const validNames = ['server', 'terminal', 'file-watcher', 'mcp'] as const
      type ValidName = (typeof validNames)[number]
      if (!validNames.includes(name as ValidName)) {
        return
      }
      if (healthMonitor) {
        await healthMonitor.manualRestart(name as ValidName)
      } else if (sidecarManager) {
        await sidecarManager.restart(name as ValidName)
      }
    })

    // Wire auto-update IPC handlers.
    setGetUpdateStateHandler(() => getUpdateState())
    setDownloadUpdateHandler(() => triggerDownloadUpdate())
    setInstallUpdateHandler(() => triggerInstallUpdate())

    const savedWindowRecords = windowStateManager.loadWindowRecords()

    if (savedWindowRecords.length > 0) {
      for (const savedWindowRecord of savedWindowRecords) {
        createWindow(savedWindowRecord)
      }
    } else {
      createWindow()
    }

    // Build the macOS-native application menu (About, Settings, Edit, View, Window).
    configureApplicationMenu(
      () => getMainWindow(),
      () => createWindow()
    )

    // Create the system tray icon with dynamic tooltip and context menu.
    trayManager.create(() => getMainWindow())

    // Register global shortcut: Cmd+Shift+L (macOS) / Ctrl+Shift+L (other).
    unregisterShortcut = registerGlobalShortcut(() => getMainWindow())

    // Configure and start the auto-updater.
    configureAutoUpdater(() => {
      isQuitting = true
    })

    app.on('activate', () => {
      // macOS: re-create window when dock icon is clicked and no windows exist.
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
      } else {
        const window = getMainWindow()

        // If the window was hidden by close-to-tray, show it again.
        if (window && !window.isVisible()) {
          window.show()
          window.focus()
        }
      }
    })
  })
  .catch(console.error)

app.on('window-all-closed', () => {
  // On macOS, apps typically stay active until the user quits explicitly.
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

/**
 * Shutdown handler: cancel pending restarts, unregister global shortcut,
 * destroy the tray, then kill all sidecar child processes before the app exits.
 */
function shutdown(): void {
  if (isQuitting) {
    return
  }
  isQuitting = true

  // Unregister the global shortcut.
  if (unregisterShortcut) {
    unregisterShortcut()
    unregisterShortcut = null
  }

  // Destroy the system tray.
  trayManager.destroy()

  // Stop auto-update timers.
  shutdownAutoUpdater()

  // Stop the health monitor first — cancels pending restart timers
  // so killed processes aren't immediately re-spawned.
  if (healthMonitor) {
    healthMonitor.shutdown()
  }

  if (sidecarManager) {
    sidecarManager.killAll()
  }
}

app.on('before-quit', () => {
  shutdown()
})

// Handle SIGINT and SIGTERM for clean shutdown when the main process
// is terminated externally (e.g., during development).
if (process.platform !== 'win32') {
  process.on('SIGINT', () => {
    shutdown()
    app.quit()
  })

  process.on('SIGTERM', () => {
    shutdown()
    app.quit()
  })
}
