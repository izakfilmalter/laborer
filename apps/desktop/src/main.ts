import { writeFileSync } from 'node:fs'
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
import { DaemonAgentStatusSubscription } from './daemon-agent-status.js'
import { DesktopDaemonSupervisor } from './daemon-supervisor.js'
import { fixPath } from './fix-path.js'
import {
  ACTIVATE_WORKSPACE_CHANNEL,
  askRenderersBeforeQuit,
  getWorkspaceWindowRegistry,
  QUIT_CONFIRMED_CHANNEL,
  registerIpcHandlers,
  removeWindowPresence,
  setDownloadUpdateHandler,
  setGetUpdateStateHandler,
  setInstallUpdateHandler,
  setTrayCountHandler,
} from './ipc.js'
import {
  laborerMcpBundleScriptPath,
  refreshLaborerMcpSymlink,
} from './laborer-mcp-symlink.js'
import { configureApplicationMenu } from './menu.js'
import { registerGlobalShortcut, TrayManager } from './tray.js'
import { buildWindowBootstrapArgs, createWindowId } from './window-identity.js'
import { type WindowRecord, WindowStateManager } from './window-state.js'

// Fix PATH before anything else — must happen synchronously before
// any child processes are spawned. On macOS, apps launched from
// Finder/Dock inherit a minimal PATH from launchd.
fixPath()

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

/** Pending OAuth URL received before a window was ready. */
let pendingOAuthUrl: string | null = null
let pendingLaborerUrl: string | null = null

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
  } else if (url.startsWith('laborer://')) {
    event.preventDefault()
    const parsed = new URL(url)
    const target = `${parsed.pathname}${parsed.search}${parsed.hash}` || '/'
    const window = BrowserWindow.getAllWindows()[0]
    if (window && daemonOrigin) {
      window.loadURL(new URL(target, daemonOrigin).href).catch(console.error)
    } else {
      pendingLaborerUrl = target
    }
  }
})

/**
 * Vite dev server URL, set by the dev-electron script.
 * When present, the renderer loads from the Vite development origin.
 */
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

/**
 * Whether we are in development mode.
 * In dev mode, the renderer loads from the Vite dev server.
 * Production instead ensures the detached daemon and loads its HTTP origin.
 */
const isDev = Boolean(VITE_DEV_SERVER_URL)
const desktopSmokeTestFile = process.env.LABORER_DESKTOP_SMOKE_TEST_FILE
let daemonOrigin: string | null = VITE_DEV_SERVER_URL ?? null
let daemonSupervisor: DesktopDaemonSupervisor | null = null

/**
 * Headless-style mode for E2E tests: keep windows hidden so Playwright can
 * drive the app via CDP without a visible window stealing focus. Electron
 * has no true headless mode, so "hidden window + no dock icon" is the
 * closest equivalent (same pattern the smoke test uses).
 */
const hideWindowsForTests =
  Boolean(desktopSmokeTestFile) || process.env.LABORER_HIDE_WINDOWS === '1'

const desktopAppName = resolveDesktopAppName({
  isDevelopment: isDev,
  version: app.getVersion(),
})

app.setName(desktopAppName)
process.title = desktopAppName

// Isolate the Electron user data profile when requested (E2E tests).
// Without this, test runs share localStorage, window state, and caches
// with the developer's real profile — persisted panel layouts accumulate
// across runs and tests corrupt the developer's actual workspace layout.
// MUST happen before app.whenReady() so all storage uses the override.
const userDataDirOverride = process.env.LABORER_USER_DATA_DIR
if (userDataDirOverride) {
  app.setPath('userData', userDataDirOverride)
}

/** Traffic light button inset for the hidden title bar. */
const TRAFFIC_LIGHT_POSITION = { x: 12, y: 10 } as const

const openWindows = new Set<BrowserWindow>()
let mainWindow: BrowserWindow | null = null

/**
 * Utility process manager for MessagePort-based service lifecycle.
 * Created on `app.whenReady()` in both dev and production modes.
 */
/** Sole app-wide owner of native agent-attention notification policy. */
let agentNotificationCoordinator: AgentNotificationCoordinator<
  ReturnType<typeof setTimeout>
> | null = null
let agentStatusSubscription: DaemonAgentStatusSubscription | null = null

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
      // Hidden windows throttle timers and requestAnimationFrame by
      // default, which stalls xterm.js rendering during hidden E2E runs.
      ...(hideWindowsForTests ? { backgroundThrottling: false } : {}),
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
  window.webContents.on('will-navigate', (event, url) => {
    if (daemonOrigin && new URL(url).origin === new URL(daemonOrigin).origin) {
      return
    }
    event.preventDefault()
    if (url.startsWith('https:') || url.startsWith('http:')) {
      shell.openExternal(url).catch(console.error)
    }
  })

  window.once('ready-to-show', () => {
    if (!hideWindowsForTests) {
      window.show()
    }
  })

  if (!daemonOrigin) {
    throw new Error('Cannot create a desktop window before the daemon is ready')
  }
  window.loadURL(daemonOrigin).catch(console.error)

  window.webContents.on('did-finish-load', () => {
    broadcastUpdateStateToWindow(window)
    if (desktopSmokeTestFile) {
      try {
        writeFileSync(
          desktopSmokeTestFile,
          `${JSON.stringify({ url: window.webContents.getURL() })}\n`,
          'utf8'
        )
      } catch (error) {
        console.error('[main] Could not write desktop smoke marker', error)
        app.exit(1)
      }
    }
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

app
  .whenReady()
  .then(async () => {
    // In hidden test mode, drop the dock icon so launching the app does
    // not steal focus or bounce the dock on macOS.
    if (hideWindowsForTests) {
      app.dock?.hide()
    }

    if (app.isPackaged) {
      refreshLaborerMcpSymlink({
        scriptPath: laborerMcpBundleScriptPath(process.resourcesPath),
      })
    }

    if (!isDev) {
      const appRoot = join(import.meta.dirname, '..', '..', '..')
      daemonSupervisor = new DesktopDaemonSupervisor({
        daemonEntry: join(
          appRoot,
          'packages',
          'server',
          'dist',
          'daemon-main.mjs'
        ),
        webDist: join(appRoot, 'apps', 'web', 'dist'),
      })
      daemonOrigin = await daemonSupervisor.launch()
    }

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
    agentStatusSubscription = new DaemonAgentStatusSubscription((fact) => {
      agentNotificationCoordinator?.observe(fact)
    })
    if (daemonOrigin) {
      agentStatusSubscription.start(daemonOrigin)
    }

    // Register x-github-desktop-dev-auth:// as a protocol handler so
    // the OAuth callback from GitHub lands back in this app.
    app.setAsDefaultProtocolClient(GITHUB_OAUTH_PROTOCOL)
    app.setAsDefaultProtocolClient('laborer')

    // Deliver any pending OAuth URL that arrived before windows were ready.
    if (pendingOAuthUrl) {
      handleGithubOAuthUrl(pendingOAuthUrl)
      pendingOAuthUrl = null
    }

    // Register IPC handlers once for the DesktopBridge contract.
    // Handlers use event.sender to resolve the requesting window,
    // so they work correctly regardless of which window invokes them.
    registerIpcHandlers(() => getMainWindow())
    ipcMain.handle('desktop:ensure-daemon', async () => {
      await daemonSupervisor?.reconnect()
    })

    // Wire tray workspace count updates from the renderer to the tray manager.
    setTrayCountHandler((count) => {
      trayManager.updateWorkspaceCount(count)
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

    if (pendingLaborerUrl && daemonOrigin) {
      const target = new URL(pendingLaborerUrl, daemonOrigin).href
      pendingLaborerUrl = null
      mainWindow?.loadURL(target).catch(console.error)
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
//                     - Stop the daemon with shutdown semantics
//                     - Wait for the daemon and pty-host to exit
//                     Then re-call app.quit() to actually exit.
//
// Force-quit safety: a timeout ensures the app always exits even if
// cleanup hangs.
// ---------------------------------------------------------------------------

/** Maximum time to wait for renderer veto replies. */
const RENDERER_QUIT_TIMEOUT_MS = 5000

/** Maximum time reserved for daemon and pty-host shutdown. */
const DAEMON_QUIT_TIMEOUT_MS = 5000

/** Absolute upper bound for app shutdown once quit is accepted. */
const FORCE_EXIT_TIMEOUT_MS = DAEMON_QUIT_TIMEOUT_MS + 1000

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

/** Stop the daemon with the explicit flavor that also stops the pty-host. */
async function shutdownDaemon(): Promise<void> {
  await daemonSupervisor?.shutdown()
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

// Phase 3: `will-quit` — async daemon cleanup.
// We preventDefault() and re-quit after cleanup completes.
app.once('will-quit', (event) => {
  event.preventDefault()
  agentNotificationCoordinator?.dispose()
  agentNotificationCoordinator = null
  agentStatusSubscription?.stop()
  agentStatusSubscription = null

  shutdownDaemon()
    .then(() => {
      app.exit(0)
    })
    .catch((error: unknown) => {
      console.error('[main] Error during daemon shutdown:', error)
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

    shutdownDaemon()
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
