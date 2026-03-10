import { join } from 'node:path'

import { app, BrowserWindow } from 'electron'

import { fixPath } from './fix-path.js'
import { HealthMonitor } from './health.js'
import { registerIpcHandlers, setRestartSidecarHandler } from './ipc.js'
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

/** Get the health monitor (null in dev mode). */
export function getHealthMonitor(): HealthMonitor | null {
  return healthMonitor
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
      additionalArguments: buildPreloadArgs(),
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

  // Register IPC handlers for the DesktopBridge contract.
  registerIpcHandlers(mainWindow)

  // Wire sidecar restart requests from the renderer to the health monitor.
  setRestartSidecarHandler(async (name) => {
    const validNames = ['server', 'terminal', 'mcp'] as const
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
function buildPreloadArgs(): string[] {
  if (!servicePorts) {
    return []
  }

  const serverUrl = `http://127.0.0.1:${servicePorts.serverPort}`
  const terminalUrl = `http://127.0.0.1:${servicePorts.terminalPort}`

  return [
    `--laborer-server-url=${serverUrl}`,
    `--laborer-terminal-url=${terminalUrl}`,
  ]
}

app
  .whenReady()
  .then(async () => {
    // Reserve ephemeral ports for services and generate auth token.
    servicePorts = await reserveServicePorts()

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

        // Forward to renderer window if available.
        if (mainWindow?.webContents) {
          mainWindow.webContents.send('sidecar:status', status)
        }
      })

      // Spawn terminal first (server depends on it), then server.
      // Health monitor polls HTTP endpoints and blocks until healthy.
      const servicesOk = await healthMonitor.spawnServices()

      if (!servicesOk) {
        console.error(
          '[main] One or more services failed to become healthy on startup'
        )
        // Continue anyway — the health monitor will keep retrying via
        // the crash handler's exponential backoff.
      }
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
 * Shutdown handler: cancel pending restarts, then kill all sidecar
 * child processes before the app exits.
 */
function shutdown(): void {
  if (isQuitting) {
    return
  }
  isQuitting = true

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
