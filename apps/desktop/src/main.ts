import { join } from 'node:path'

import { app, BrowserWindow } from 'electron'

import { fixPath } from './fix-path.js'
import { reserveServicePorts, type ServicePorts } from './ports.js'

// Fix PATH before anything else — must happen synchronously before
// any child processes are spawned. On macOS, apps launched from
// Finder/Dock inherit a minimal PATH from launchd.
fixPath()

/**
 * Vite dev server URL, set by the dev-electron script.
 * When present, the renderer loads from the dev server instead of a custom protocol.
 */
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

/** Traffic light button inset for the hidden title bar. */
const TRAFFIC_LIGHT_POSITION = { x: 16, y: 12 } as const

let mainWindow: BrowserWindow | null = null

/**
 * Reserved ports and auth token for child process communication.
 * Populated during bootstrap before the window is created.
 * Used by child process spawning (Issue 8) and preload bridge (Issue 10).
 */
let servicePorts: ServicePorts | null = null

/** Get the reserved service ports. Throws if called before bootstrap. */
export function getServicePorts(): ServicePorts {
  if (!servicePorts) {
    throw new Error('Service ports not yet initialized')
  }
  return servicePorts
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
    // These will be passed to child processes via env (Issue 8)
    // and exposed to the renderer via the preload bridge (Issue 10).
    servicePorts = await reserveServicePorts()

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
