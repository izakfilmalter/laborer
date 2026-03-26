import { join } from 'node:path'

import { app, BrowserWindow, shell } from 'electron'

import {
  broadcastUpdateStateToWindow,
  configureAutoUpdater,
  getUpdateState,
  shutdownAutoUpdater,
  triggerDownloadUpdate,
  triggerInstallUpdate,
} from './auto-updater.js'
import { fixPath } from './fix-path.js'
import {
  getWorkspaceWindowRegistry,
  registerIpcHandlers,
  setDownloadUpdateHandler,
  setGetUpdateStateHandler,
  setInstallUpdateHandler,
  setRestartSidecarHandler,
  setTrayCountHandler,
  setUtilityProcessManager,
} from './ipc.js'
import { LifecycleMonitor } from './lifecycle-monitor.js'
import { configureApplicationMenu } from './menu.js'
import {
  DESKTOP_SCHEME,
  registerDesktopProtocol,
  registerSchemeAsPrivileged,
  resolveStaticRoot,
} from './protocol.js'
import { registerGlobalShortcut, TrayManager } from './tray.js'
import { UtilityProcessManager } from './utility-process-manager.js'
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
 * In dev mode, the renderer loads from the Vite dev server.
 * Utility processes are forked in both dev and production modes.
 */
const isDev = Boolean(VITE_DEV_SERVER_URL)

/** Traffic light button inset for the hidden title bar. */
const TRAFFIC_LIGHT_POSITION = { x: 12, y: 10 } as const

const openWindows = new Set<BrowserWindow>()
let mainWindow: BrowserWindow | null = null

/**
 * Utility process manager for MessagePort-based service lifecycle.
 * Created on `app.whenReady()` in both dev and production modes.
 */
let utilityProcessManager: UtilityProcessManager | null = null

/**
 * Lifecycle monitor for utility process health, crash detection, and
 * automatic restart with exponential backoff and heartbeat monitoring.
 */
let lifecycleMonitor: LifecycleMonitor | null = null

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

/** Get the utility process manager (null before app.whenReady). */
export function getUtilityProcessManager(): UtilityProcessManager | null {
  return utilityProcessManager
}

/** Get the lifecycle monitor (null before app.whenReady). */
export function getLifecycleMonitor(): LifecycleMonitor | null {
  return lifecycleMonitor
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
      additionalArguments: buildWindowBootstrapArgs({ windowId }),
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

  // Intercept window.open() calls from the renderer (e.g., xterm.js
  // link clicks) and redirect them to the OS default browser via
  // shell.openExternal(). Without this, window.open() in a sandboxed
  // renderer would create a new BrowserWindow instead of opening the
  // user's browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:') || url.startsWith('http:')) {
      shell.openExternal(url).catch(console.error)
    }
    return { action: 'deny' }
  })

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
 * Broker direct MessagePort channels between utility processes that
 * need to communicate with each other.
 *
 * Called whenever a utility process becomes ready. Checks which pairs
 * of services are both healthy and creates brokered connections for
 * those that are. Each pair is re-brokered after every restart of
 * either service, since old ports die with old processes.
 */
function brokerInterProcessPorts(): void {
  // Server <-> Terminal: server's TerminalClient calls TerminalRpcs
  // @see Issue #13: Server-to-terminal MessagePort channel
  if (
    lifecycleMonitor?.isHealthy('terminal') &&
    lifecycleMonitor?.isHealthy('server')
  ) {
    utilityProcessManager?.brokerInterProcessPort(
      'server',
      { type: 'terminal-rpc-port' },
      'terminal',
      { type: 'port' }
    )
  }

  // Server <-> File-watcher: server's FileWatcherClient calls FileWatcherRpcs
  // @see Issue #14: File-watcher as utility process
  if (
    lifecycleMonitor?.isHealthy('file-watcher') &&
    lifecycleMonitor?.isHealthy('server')
  ) {
    utilityProcessManager?.brokerInterProcessPort(
      'server',
      { type: 'file-watcher-rpc-port' },
      'file-watcher',
      { type: 'port' }
    )
  }

  // MCP <-> Server: MCP's LaborerRpcClient calls LaborerRpcs
  // The MCP utility process receives the port as 'server-rpc-port',
  // the server receives it as 'port' (additional RPC port).
  // @see Issue #15: MCP as utility process
  if (
    lifecycleMonitor?.isHealthy('mcp') &&
    lifecycleMonitor?.isHealthy('server')
  ) {
    utilityProcessManager?.brokerInterProcessPort(
      'mcp',
      { type: 'server-rpc-port' },
      'server',
      { type: 'port' }
    )
  }
}

app
  .whenReady()
  .then(() => {
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

    // Create the utility process manager for MessagePort-based services.
    // All services run as utility processes in both dev and production.
    utilityProcessManager = new UtilityProcessManager()

    // Create the lifecycle monitor for utility process health monitoring.
    // Uses native process events and heartbeat messages instead of HTTP
    // health polling.
    lifecycleMonitor = new LifecycleMonitor(utilityProcessManager)

    // Wire bootstrap messages (ready, heartbeat) from utility processes
    // to the lifecycle monitor for startup detection and liveness.
    utilityProcessManager.setMessageHandler((name, message) => {
      if (message.type === 'ready') {
        lifecycleMonitor?.handleReady(name)
        brokerInterProcessPorts()
      } else if (message.type === 'heartbeat') {
        lifecycleMonitor?.handleHeartbeat(name)
      }
    })

    // Share the utility process manager with the IPC module so the
    // renderer can acquire direct MessagePort connections to services.
    setUtilityProcessManager(utilityProcessManager)

    // Fork utility processes via the lifecycle monitor, which handles
    // startup detection, crash recovery, and status events.
    lifecycleMonitor.forkAllAndMonitor([
      'terminal',
      'server',
      'file-watcher',
      'mcp',
    ])

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

    // Wire sidecar restart requests from the renderer to the lifecycle
    // monitor or utility process manager.
    setRestartSidecarHandler(async (name) => {
      const validNames = ['server', 'terminal', 'file-watcher', 'mcp'] as const
      type ValidName = (typeof validNames)[number]
      if (!validNames.includes(name as ValidName)) {
        return
      }
      // Try the lifecycle monitor first (proper health tracking),
      // then fall back to direct restart via the utility process manager.
      if (
        lifecycleMonitor &&
        utilityProcessManager?.isRunning(name as ValidName)
      ) {
        await lifecycleMonitor.manualRestart(name as ValidName)
      } else if (utilityProcessManager?.isRunning(name as ValidName)) {
        await utilityProcessManager.restart(name as ValidName)
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
 * destroy the tray, then kill all utility processes before the app exits.
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

  // Stop the lifecycle monitor first — cancels pending restart timers and
  // heartbeat timers so killed processes aren't immediately re-spawned.
  if (lifecycleMonitor) {
    lifecycleMonitor.shutdown()
  }

  // Kill all utility processes (MessagePort-based services).
  if (utilityProcessManager) {
    utilityProcessManager.killAll()
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
