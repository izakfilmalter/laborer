import { join } from 'node:path'

import { app, BrowserWindow } from 'electron'

import { fixPath } from './fix-path.js'
import { reserveServicePorts, type ServicePorts } from './ports.js'
import { SidecarManager } from './sidecar.js'

// Fix PATH before anything else — must happen synchronously before
// any child processes are spawned. On macOS, apps launched from
// Finder/Dock inherit a minimal PATH from launchd.
fixPath()

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

let mainWindow: BrowserWindow | null = null

/**
 * Reserved ports and auth token for child process communication.
 * Populated during bootstrap before the window is created.
 * Used by child process spawning and preload bridge (Issue 10).
 */
let servicePorts: ServicePorts | null = null

/**
 * Sidecar manager for child process lifecycle.
 * Only created in production mode (when services need to be spawned).
 */
let sidecarManager: SidecarManager | null = null

/** Whether the app is in the process of quitting. */
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

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 840,
    minHeight: 620,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: TRAFFIC_LIGHT_POSITION,
    webPreferences: {
      preload: join(import.meta.dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  if (VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(VITE_DEV_SERVER_URL).catch(console.error)
  } else {
    // Production: custom protocol will be set up in a later issue.
    // For now, load a placeholder.
    mainWindow.loadURL('about:blank').catch(console.error)
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app
  .whenReady()
  .then(async () => {
    // Reserve ephemeral ports for services and generate auth token.
    servicePorts = await reserveServicePorts()

    // In production, spawn sidecar services as child processes.
    // In dev mode, services are run separately via `turbo dev`.
    if (!isDev) {
      sidecarManager = new SidecarManager(servicePorts)

      // Log unexpected exits (Issue 9 will emit these to the renderer).
      sidecarManager.setExitHandler((name, code, signal, lastStderr) => {
        console.error(
          `[sidecar:${name}] Unexpected exit: code=${code} signal=${signal}`
        )
        if (lastStderr) {
          console.error(`[sidecar:${name}] Last stderr:\n${lastStderr}`)
        }
      })

      // Spawn terminal first (server depends on it), then server.
      // This blocks until both have had time to start.
      // Issue 9 will replace the delay-based approach with health checking.
      await sidecarManager.spawnServices()
    }

    createWindow()

    app.on('activate', () => {
      // macOS: re-create window when dock icon is clicked and no windows exist.
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
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
 * Shutdown handler: kill all sidecar child processes before the app exits.
 * Uses SIGTERM first, escalates to SIGKILL after a timeout.
 */
function shutdown(): void {
  if (isQuitting) {
    return
  }
  isQuitting = true

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
