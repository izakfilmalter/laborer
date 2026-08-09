import { watch } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, Notification, shell } from 'electron'
import {
  AgentNotificationCoordinator,
  nativeNotificationScheduler,
} from './agent-notification-coordinator.js'
import { resolveDesktopAppName } from './app-name.js'
import {
  broadcastUpdateStateToWindow,
  configureAutoUpdater,
  getUpdateState,
  shutdownAutoUpdater,
  triggerDownloadUpdate,
  triggerInstallUpdate,
} from './auto-updater.js'
import {
  DEFAULT_DESKTOP_BACKEND_PORT,
  resolveDesktopBackendPort,
} from './backend-port.js'
import { BackendProcessManager } from './backend-process-manager.js'
import { DevWatcher } from './dev-watcher.js'
import { fixPath } from './fix-path.js'
import {
  ACTIVATE_WORKSPACE_CHANNEL,
  askRenderersBeforeQuit,
  closeRendererPortsForService,
  getWorkspaceWindowRegistry,
  publishWorkspacePresence,
  QUIT_CONFIRMED_CHANNEL,
  registerIpcHandlers,
  removeWindowPresence,
  setDownloadUpdateHandler,
  setGetBackendWsUrlHandler,
  setGetSidecarStatusesHandler,
  setGetUpdateStateHandler,
  setInstallUpdateHandler,
  setRestartSidecarHandler,
  setTrayCountHandler,
  setUtilityProcessManager,
  setWorkspacePresenceHandler,
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

if (process.env.LABORER_BACKEND_CHILD === '1') {
  console.error(
    '[main] Refusing to launch desktop app from backend child process environment'
  )
  process.exit(1)
}

// Fix PATH before anything else — must happen synchronously before
// any child processes are spawned. On macOS, apps launched from
// Finder/Dock inherit a minimal PATH from launchd.
fixPath()

// Register the custom laborer:// protocol scheme as privileged.
// MUST happen synchronously before app.whenReady().
registerSchemeAsPrivileged()

// ---------------------------------------------------------------------------
// Guard against write-to-broken-pipe errors during shutdown
// ---------------------------------------------------------------------------
// When the parent dev process is killed (Ctrl+C), stdio streams may be
// destroyed before the main process finishes cleanup. Any `console.*` call
// then throws `Error: write EIO` (or EPIPE), which Electron surfaces as an
// uncaught-exception dialog. Following VS Code's pattern, we silently ignore
// these specific errors and install a SIGPIPE handler to prevent the default
// signal behavior from terminating the process.
//
// @see https://github.com/microsoft/vscode/blob/main/src/bootstrap-node.ts
// @see https://github.com/microsoft/vscode/blob/main/src/vs/base/common/errors.ts

/**
 * Returns true if the error is a write-to-broken-pipe error (EPIPE or EIO).
 * These occur when writing to stdout/stderr after the stream has been destroyed.
 */
function isWritePipeError(e: unknown): boolean {
  if (!e || typeof e !== 'object') {
    return false
  }
  const err = e as { code?: string; syscall?: string }
  return (
    (err.code === 'EPIPE' || err.code === 'EIO') &&
    err.syscall?.toUpperCase() === 'WRITE'
  )
}

process.on('uncaughtException', (err: Error) => {
  if (isWritePipeError(err)) {
    // Silently ignore — the stream is already gone. Logging here would
    // trigger another write-to-broken-pipe error, creating an infinite loop.
    return
  }
  // Re-throw non-pipe errors so Electron's default handler can report them.
  throw err
})

// Electron doesn't install a SIGPIPE handler by default (unlike Node.js).
// Without one, a SIGPIPE signal terminates the process immediately.
let didLogSigpipe = false
process.on('SIGPIPE', () => {
  // Log at most once — further logging may itself trigger SIGPIPE.
  if (!didLogSigpipe) {
    didLogSigpipe = true
    try {
      console.error('[main] Received SIGPIPE')
    } catch {
      // Stream already broken — nothing we can do.
    }
  }
})

// ---------------------------------------------------------------------------
// GitHub OAuth protocol handler
// ---------------------------------------------------------------------------
// Register x-github-desktop-dev-auth:// so the OS routes the OAuth callback
// back to this app after the user authorizes in the browser.

const GITHUB_OAUTH_PROTOCOL = 'x-github-desktop-dev-auth'
const DESKTOP_LOOPBACK_HOST = '127.0.0.1'
const DESKTOP_REQUIRED_PORT_PROBE_HOSTS = ['0.0.0.0', '::'] as const

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

const desktopAppName = resolveDesktopAppName({
  isDevelopment: isDev,
  version: app.getVersion(),
})

app.setName(desktopAppName)
process.title = desktopAppName

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

/**
 * Dev mode file watcher for hot reload. Watches sidecar dist directories
 * and triggers utility process restarts when files change.
 * Only created in dev mode, unless `LABORER_SKIP_WATCH=1` is set.
 */
let devWatcher: DevWatcher | null = null

/** Server backend child process manager. */
let backendProcessManager: BackendProcessManager | null = null

/** Current server backend WebSocket URL exposed to renderer clients. */
let backendWsUrl: string | null = null

/** Sole app-wide owner of native agent-attention notification policy. */
let agentNotificationCoordinator: AgentNotificationCoordinator<
  ReturnType<typeof setTimeout>
> | null = null

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
    // Let the first click into an inactive Labor window reach the clicked
    // terminal pane instead of only activating the window.
    acceptFirstMouse: true,
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
    removeWindowPresence(window)

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

function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address === 'object' && address !== null) {
        const { port } = address
        server.close(() => resolve(port))
        return
      }
      server.close(() => reject(new Error('Failed to reserve backend port')))
    })
  })
}

async function startServerBackend(): Promise<void> {
  const port = await resolveDesktopBackendPort({
    host: DESKTOP_LOOPBACK_HOST,
    requiredHosts: DESKTOP_REQUIRED_PORT_PROBE_HOSTS,
    startPort: Number(
      process.env.LABORER_DESKTOP_BACKEND_PORT ?? DEFAULT_DESKTOP_BACKEND_PORT
    ),
  })
  const terminalPort = await reserveLoopbackPort()
  const fileWatcherPort = await reserveLoopbackPort()

  process.env.LABORER_TERMINAL_HTTP_PORT = String(terminalPort)
  process.env.LABORER_TERMINAL_RPC_URL = `ws://127.0.0.1:${String(terminalPort)}/rpc`
  process.env.LABORER_FILE_WATCHER_HTTP_PORT = String(fileWatcherPort)
  process.env.LABORER_FILE_WATCHER_RPC_URL = `ws://127.0.0.1:${String(fileWatcherPort)}/rpc`
  process.env.PORT = String(port)

  backendProcessManager = new BackendProcessManager({
    authToken: crypto.randomUUID(),
    port,
  })
  backendWsUrl = backendProcessManager.start().wsUrl
}

app
  .whenReady()
  .then(async () => {
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
    const workspaceRegistry = getWorkspaceWindowRegistry()
    agentNotificationCoordinator = new AgentNotificationCoordinator({
      contextForWorkspace: (workspaceId) =>
        workspaceRegistry.branchNameForWorkspace(workspaceId) ?? 'Workspace',
      hasFocusedWindow: () => workspaceRegistry.hasFocusedWindow(),
      route: (intent) => {
        workspaceRegistry.routeToOrOpenWorkspace(
          intent.workspaceId,
          getMainWindow,
          (targetWindow) => {
            targetWindow.show()
            targetWindow.focus()
            targetWindow.webContents.send(ACTIVATE_WORKSPACE_CHANNEL, intent)
          }
        )
      },
      scheduler: nativeNotificationScheduler,
      show: ({ body, onClick, title }) => {
        if (!Notification.isSupported()) {
          return
        }
        const notification = new Notification({ body, title })
        notification.on('click', onClick)
        notification.show()
      },
    })

    // Create the lifecycle monitor for utility process health monitoring.
    // Uses native process events and heartbeat messages instead of HTTP
    // health polling.
    lifecycleMonitor = new LifecycleMonitor(utilityProcessManager, {
      onProcessExit: (name) => {
        closeRendererPortsForService(name)
        if (name === 'terminal') {
          // A dead status source cannot satisfy delivery-time revalidation.
          // The restored service will hydrate fresh history after restart.
          agentNotificationCoordinator?.dispose()
        }
      },
    })

    // Wire bootstrap messages (ready, heartbeat) from utility processes
    // to the lifecycle monitor for startup detection and liveness.
    utilityProcessManager.setMessageHandler((name, message) => {
      if (message.type === 'ready') {
        lifecycleMonitor?.handleReady(name)
        if (name === 'terminal') {
          publishWorkspacePresence()
        }
      } else if (message.type === 'heartbeat') {
        lifecycleMonitor?.handleHeartbeat(name)
      } else if (
        name === 'terminal' &&
        message.type === 'terminal-agent-status'
      ) {
        agentNotificationCoordinator?.observe(message)
      }
    })

    // Share the utility process manager with the IPC module so the
    // renderer can acquire direct MessagePort connections to services.
    setUtilityProcessManager(utilityProcessManager)
    setWorkspacePresenceHandler((workspaceIds) => {
      utilityProcessManager
        ?.getProcess('terminal')
        ?.postMessage({ type: 'workspace-presence', workspaceIds })
    })

    await startServerBackend()

    // Fork utility processes via the lifecycle monitor, which handles
    // startup detection, crash recovery, and status events.
    lifecycleMonitor.forkAllAndMonitor(['terminal', 'file-watcher'])

    // No powerMonitor suspend/resume wiring is needed for heartbeats:
    // the lifecycle monitor counts awake time (process-time countdowns),
    // so OS sleep — including DarkWake, which emits no suspend/resume —
    // can never advance a heartbeat timeout (ADR 0003).

    // In dev mode, watch sidecar dist directories for changes and auto-restart
    // utility processes. `tsdown --watch` rebuilds dist/utility-main.mjs on
    // source changes; DevWatcher detects the rebuild and triggers a restart.
    // Disabled by setting LABORER_SKIP_WATCH=1 for debugging.
    if (isDev && process.env.LABORER_SKIP_WATCH !== '1') {
      const repoRoot = join(import.meta.dirname, '..', '..', '..')
      devWatcher = new DevWatcher({
        lifecycleMonitor,
        repoRoot,
        watchFn: watch,
      })
      devWatcher.startWatching()
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

    // Wire sidecar restart requests from the renderer to the lifecycle
    // monitor or utility process manager.
    setRestartSidecarHandler(async (name) => {
      const validNames = ['terminal', 'file-watcher'] as const
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

    // Wire sidecar status query so the renderer can get current statuses
    // on mount (avoids missing broadcast events due to timing).
    setGetSidecarStatusesHandler(() => {
      return lifecycleMonitor?.getCurrentStatuses() ?? []
    })

    setGetBackendWsUrlHandler(() => backendWsUrl)

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
// Graceful shutdown — VS Code-style multi-phase quit flow
//
// The quit sequence is:
//
// 1. `before-quit`  — we ask renderer windows if they're ready to quit.
//                     Any window can veto (e.g., unsaved work, running tasks).
//                     If vetoed, the quit is cancelled.
//
// 2. (windows close) — Electron closes each window. If all windows close,
//                      `window-all-closed` fires and re-triggers app.quit().
//
// 3. `will-quit`    — we preventDefault() to delay exit while we:
//                     - Stop lifecycle monitor (prevent restarts)
//                     - Kill utility processes with killAllAndWait()
//                     - Wait for them to serialize state (terminal sessions, etc.)
//                     Then re-call app.quit() to actually exit.
//
// Force-quit safety: a timeout ensures the app always exits even if
// cleanup hangs (e.g., a utility process ignores SIGTERM).
// ---------------------------------------------------------------------------

/** Maximum time to wait for renderer veto replies. */
const RENDERER_QUIT_TIMEOUT_MS = 5000

/** Maximum time to wait for utility processes to exit after SIGTERM. */
const UTILITY_QUIT_TIMEOUT_MS = 5000

/** Absolute upper bound for app shutdown once quit is accepted. */
const FORCE_EXIT_TIMEOUT_MS = UTILITY_QUIT_TIMEOUT_MS + 1000

let forceExitTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Synchronous cleanup of main-process resources.
 * Called once during shutdown — idempotent via `isQuitting`.
 */
function cleanupMainProcessResources(): void {
  // Unregister the global shortcut.
  if (unregisterShortcut) {
    unregisterShortcut()
    unregisterShortcut = null
  }

  // Destroy the system tray.
  trayManager.destroy()

  // Stop auto-update timers.
  shutdownAutoUpdater()

  // Stop the dev watcher first — prevents file changes from triggering
  // restarts during shutdown.
  if (devWatcher) {
    devWatcher.shutdown()
  }
}

function scheduleForceExit(): void {
  if (forceExitTimer) {
    return
  }

  forceExitTimer = setTimeout(() => {
    console.error('[main] Shutdown timed out — forcing app exit')
    app.exit(0)
  }, FORCE_EXIT_TIMEOUT_MS)
  forceExitTimer.unref()
}

function beginQuit(): void {
  isQuitting = true
  cleanupMainProcessResources()
  scheduleForceExit()
}

/**
 * Async shutdown: stop lifecycle monitor, then kill all utility processes
 * and WAIT for them to exit (so they can serialize state like terminal
 * sessions before the process dies).
 */
async function shutdownUtilityProcesses(): Promise<void> {
  // Stop the lifecycle monitor — cancels pending restart timers and
  // heartbeat timers so killed processes aren't immediately re-spawned.
  if (lifecycleMonitor) {
    lifecycleMonitor.shutdown()
  }

  // Kill all utility processes and wait for them to finish cleanup.
  // This is critical: the terminal utility process serializes session
  // state on SIGTERM. Using killAllAndWait ensures we don't exit before
  // that serialization completes.
  if (utilityProcessManager) {
    await utilityProcessManager.killAllAndWait(UTILITY_QUIT_TIMEOUT_MS)
  }

  backendProcessManager?.stop()
  backendProcessManager = null
  backendWsUrl = null
}

// Phase 1: `before-quit` — ask renderers for permission, with veto support.
app.on('before-quit', (event) => {
  if (isQuitting) {
    // Already in shutdown — let the quit proceed to the `will-quit` phase.
    return
  }

  // Prevent the quit while we ask renderers.
  event.preventDefault()

  // Ask renderer windows if they're OK with quitting.
  askRenderersBeforeQuit('quit', RENDERER_QUIT_TIMEOUT_MS)
    .then((vetoed: boolean) => {
      if (vetoed) {
        // A renderer vetoed — cancel the quit entirely.
        console.info('[main] Quit vetoed by renderer')
        return
      }

      // No veto — proceed with shutdown. Set the flag so the next
      // before-quit pass-through doesn't re-ask renderers.
      beginQuit()
      app.quit()
    })
    .catch((error: unknown) => {
      // On error, proceed with quit to avoid leaving the app in a stuck state.
      console.error('[main] Error during renderer quit negotiation:', error)
      beginQuit()
      app.quit()
    })
})

// Renderer confirmed quit after seeing the dialog — re-trigger app.quit().
// The `before-quit` handler will fire again, but this time the renderer's
// `forceAllowNextQuit` flag is set so it won't veto.
ipcMain.on(QUIT_CONFIRMED_CHANNEL, () => {
  console.info('[main] Renderer confirmed quit — re-triggering app.quit()')
  beginQuit()
  app.quit()
})

// Phase 3: `will-quit` — async cleanup of utility processes.
// We preventDefault() and re-quit after cleanup completes.
app.once('will-quit', (event) => {
  event.preventDefault()
  agentNotificationCoordinator?.dispose()
  agentNotificationCoordinator = null

  shutdownUtilityProcesses()
    .then(() => {
      app.exit(0)
    })
    .catch((error: unknown) => {
      console.error('[main] Error during utility process shutdown:', error)
      app.exit(0)
    })
})

// Handle SIGINT and SIGTERM for clean shutdown when the main process
// is terminated externally (e.g., during development).
if (process.platform !== 'win32') {
  const handleSignal = () => {
    if (isQuitting) {
      return
    }
    beginQuit()

    shutdownUtilityProcesses()
      .then(() => {
        app.exit(0)
      })
      .catch(() => {
        app.exit(0)
      })
  }

  process.on('SIGINT', handleSignal)
  process.on('SIGTERM', handleSignal)
}
