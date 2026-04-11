import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { extname, join, posix, resolve, sep } from 'node:path'
import type {
  ContextMenuItem,
  DesktopTheme,
  DesktopUpdateActionResult,
  DesktopUpdateCheckResult,
  DesktopUpdateState,
} from '@laborer/contracts/desktop'
import { findAvailablePort } from '@laborer/shared/net'
import {
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
  resolveServerWsUrl,
} from '@laborer/shared/server'
import type { MenuItemConstructorOptions } from 'electron'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  protocol,
  shell,
} from 'electron'

const PICK_FOLDER_CHANNEL = 'desktop:pick-folder'
const CONFIRM_CHANNEL = 'desktop:confirm'
const SET_THEME_CHANNEL = 'desktop:set-theme'
const CONTEXT_MENU_CHANNEL = 'desktop:context-menu'
const OPEN_EXTERNAL_CHANNEL = 'desktop:open-external'
const MENU_ACTION_CHANNEL = 'desktop:menu-action'
const UPDATE_STATE_CHANNEL = 'desktop:update-state'
const UPDATE_GET_STATE_CHANNEL = 'desktop:update-get-state'
const UPDATE_DOWNLOAD_CHANNEL = 'desktop:update-download'
const UPDATE_INSTALL_CHANNEL = 'desktop:update-install'
const UPDATE_CHECK_CHANNEL = 'desktop:update-check'
const GET_WS_URL_CHANNEL = 'desktop:get-ws-url'
const DESKTOP_SCHEME = 'laborer'
const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL)
const APP_DISPLAY_NAME = isDevelopment ? 'Laborer (Dev)' : 'Laborer'
const APP_USER_MODEL_ID = 'com.izakfilmalter.laborer'
const USER_DATA_DIR_NAME = isDevelopment ? 'laborer-dev' : 'laborer'
const LEADING_SLASHES = /^\/+/
const BACKEND_STOP_TIMEOUT_MS = 2000
const BACKEND_RESTART_DELAY_MS = 500

let mainWindow: BrowserWindow | null = null
let desktopProtocolRegistered = false
let backendProcess: ChildProcess | null = null
let backendPort = 0
let backendRestartTimer: ReturnType<typeof setTimeout> | null = null
let backendWsUrl: string | null = null
let isQuitting = false

const resolveRuntimeArch = (): DesktopUpdateState['hostArch'] => {
  if (process.arch === 'arm64') {
    return 'arm64'
  }

  if (process.arch === 'x64') {
    return 'x64'
  }

  return 'other'
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: DESKTOP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
])

const createDisabledUpdateState = (
  currentVersion: string
): DesktopUpdateState => {
  const runtimeArch = resolveRuntimeArch()

  return {
    enabled: false,
    status: 'disabled',
    currentVersion,
    hostArch: runtimeArch,
    appArch: runtimeArch,
    runningUnderArm64Translation: false,
    availableVersion: null,
    downloadedVersion: null,
    downloadPercent: null,
    checkedAt: null,
    message: 'Automatic updates are not configured for this app yet.',
    errorContext: null,
    canRetry: false,
  }
}

let updateState = createDisabledUpdateState(app.getVersion())

const emitUpdateState = (): void => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return
  }

  mainWindow.webContents.send(UPDATE_STATE_CHANNEL, updateState)
}

const formatErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

const resolveServerEntry = (): string => {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'server', 'index.js')
  }

  return resolve(app.getAppPath(), '../server/dist/index.js')
}

const resolveServerProcessCwd = (): string => {
  if (app.isPackaged) {
    return app.getPath('home')
  }

  return resolve(app.getAppPath(), '../..')
}

const scheduleBackendRestart = (): void => {
  if (isDevelopment || isQuitting || backendRestartTimer !== null) {
    return
  }

  backendRestartTimer = setTimeout(() => {
    backendRestartTimer = null
    startBackend().catch(() => undefined)
  }, BACKEND_RESTART_DELAY_MS)
  backendRestartTimer.unref()
}

const startBackend = async (): Promise<void> => {
  if (isDevelopment) {
    backendWsUrl =
      process.env.LABORER_SERVER_URL?.trim() ||
      resolveServerWsUrl({
        host: DEFAULT_SERVER_HOST,
        port: DEFAULT_SERVER_PORT,
      })
    return
  }

  if (backendProcess !== null) {
    return
  }

  const serverEntry = resolveServerEntry()
  if (!existsSync(serverEntry)) {
    throw new Error(`Laborer server entry not found at ${serverEntry}`)
  }

  backendPort =
    backendPort > 0 ? backendPort : await findAvailablePort(DEFAULT_SERVER_PORT)
  backendWsUrl = resolveServerWsUrl({
    host: DEFAULT_SERVER_HOST,
    port: backendPort,
  })

  const child = spawn(process.execPath, [serverEntry], {
    cwd: resolveServerProcessCwd(),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      LABORER_SERVER_HOST: DEFAULT_SERVER_HOST,
      LABORER_SERVER_MODE: 'desktop',
      LABORER_SERVER_PORT: String(backendPort),
    },
    stdio: 'inherit',
  })

  backendProcess = child

  child.once('error', () => {
    if (backendProcess === child) {
      backendProcess = null
    }

    scheduleBackendRestart()
  })

  child.once('exit', () => {
    if (backendProcess === child) {
      backendProcess = null
    }

    scheduleBackendRestart()
  })
}

const stopBackend = (): void => {
  if (backendRestartTimer !== null) {
    clearTimeout(backendRestartTimer)
    backendRestartTimer = null
  }

  const child = backendProcess
  backendProcess = null

  if (!child) {
    return
  }

  child.kill('SIGTERM')

  const forceKillTimeout = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
  }, BACKEND_STOP_TIMEOUT_MS)
  forceKillTimeout.unref()
}

const getSafeExternalUrl = (rawUrl: unknown): string | null => {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    return null
  }

  let parsedUrl: URL
  try {
    parsedUrl = new URL(rawUrl)
  } catch {
    return null
  }

  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    return null
  }

  return parsedUrl.toString()
}

const getSafeTheme = (rawTheme: unknown): DesktopTheme | null => {
  if (rawTheme === 'light' || rawTheme === 'dark' || rawTheme === 'system') {
    return rawTheme
  }

  return null
}

const resolveDesktopStaticDir = (): string | null => {
  const repoRoot = resolve(app.getAppPath(), '../..')
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'web')]
    : [join(repoRoot, 'apps/web/dist')]

  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'index.html'))) {
      return candidate
    }
  }

  return null
}

const resolveDesktopStaticPath = (
  staticRoot: string,
  requestUrl: string
): string => {
  const url = new URL(requestUrl)
  const rawPath = decodeURIComponent(url.pathname)
  const normalizedPath = posix.normalize(rawPath).replace(LEADING_SLASHES, '')

  if (normalizedPath.includes('..')) {
    return join(staticRoot, 'index.html')
  }

  const requestedPath =
    normalizedPath.length > 0 ? normalizedPath : 'index.html'
  const resolvedPath = join(staticRoot, requestedPath)

  if (extname(resolvedPath)) {
    return resolvedPath
  }

  const nestedIndex = join(resolvedPath, 'index.html')
  if (existsSync(nestedIndex)) {
    return nestedIndex
  }

  return join(staticRoot, 'index.html')
}

const isStaticAssetRequest = (requestUrl: string): boolean => {
  try {
    const url = new URL(requestUrl)
    return extname(url.pathname).length > 0
  } catch {
    return false
  }
}

const registerDesktopProtocol = (): void => {
  if (isDevelopment || desktopProtocolRegistered) {
    return
  }

  const staticRoot = resolveDesktopStaticDir()
  if (!staticRoot) {
    throw new Error(
      'Desktop static bundle missing. Build apps/web before starting Electron.'
    )
  }

  const staticRootResolved = resolve(staticRoot)
  const staticRootPrefix = `${staticRootResolved}${sep}`
  const fallbackIndex = join(staticRootResolved, 'index.html')

  protocol.registerFileProtocol(DESKTOP_SCHEME, (request, callback) => {
    try {
      const candidate = resolveDesktopStaticPath(
        staticRootResolved,
        request.url
      )
      const resolvedCandidate = resolve(candidate)
      const isInRoot =
        resolvedCandidate === fallbackIndex ||
        resolvedCandidate.startsWith(staticRootPrefix)
      const isAsset = isStaticAssetRequest(request.url)
      const candidateExists = existsSync(resolvedCandidate)
      const shouldServeStaticFile = isInRoot && candidateExists

      if (!shouldServeStaticFile) {
        if (isAsset) {
          callback({ error: -6 })
          return
        }

        callback({ path: fallbackIndex })
        return
      }

      callback({ path: resolvedCandidate })
    } catch {
      callback({ path: fallbackIndex })
    }
  })

  desktopProtocolRegistered = true
}

const dispatchMenuAction = (action: string): void => {
  const window =
    BrowserWindow.getFocusedWindow() ??
    mainWindow ??
    BrowserWindow.getAllWindows()[0]
  if (!window || window.isDestroyed()) {
    return
  }

  window.webContents.send(MENU_ACTION_CHANNEL, action)
}

const buildAppMenu = (): Menu => {
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = []

  if (isMac) {
    template.push({
      label: APP_DISPLAY_NAME,
      submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }],
    })
  }

  const closeWindowMenu: MenuItemConstructorOptions = isMac
    ? { role: 'close' }
    : { role: 'quit' }

  template.push({
    label: 'File',
    submenu: [
      {
        label: 'New Workspace',
        accelerator: 'CmdOrCtrl+N',
        click: () => dispatchMenuAction('workspace:new'),
      },
      { type: 'separator' },
      closeWindowMenu,
    ],
  })

  const windowSubmenu: MenuItemConstructorOptions[] = isMac
    ? [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }]
    : [{ role: 'minimize' }]

  template.push({
    label: 'View',
    submenu: [
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  })

  template.push({
    label: 'Window',
    submenu: windowSubmenu,
  })

  return Menu.buildFromTemplate(template)
}

const registerIpcHandlers = (): void => {
  ipcMain.removeAllListeners(GET_WS_URL_CHANNEL)
  ipcMain.on(GET_WS_URL_CHANNEL, (event) => {
    event.returnValue = backendWsUrl
  })

  ipcMain.removeHandler(PICK_FOLDER_CHANNEL)
  ipcMain.handle(PICK_FOLDER_CHANNEL, async () => {
    const owner = BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined
    const result = owner
      ? await dialog.showOpenDialog(owner, {
          properties: ['openDirectory', 'createDirectory'],
        })
      : await dialog.showOpenDialog({
          properties: ['openDirectory', 'createDirectory'],
        })

    if (result.canceled) {
      return null
    }

    return result.filePaths[0] ?? null
  })

  ipcMain.removeHandler(CONFIRM_CHANNEL)
  ipcMain.handle(CONFIRM_CHANNEL, async (_event, message: unknown) => {
    if (typeof message !== 'string' || message.length === 0) {
      return false
    }

    const owner = BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined
    const result = owner
      ? await dialog.showMessageBox(owner, {
          type: 'question',
          buttons: ['Cancel', 'OK'],
          defaultId: 1,
          cancelId: 0,
          message,
        })
      : await dialog.showMessageBox({
          type: 'question',
          buttons: ['Cancel', 'OK'],
          defaultId: 1,
          cancelId: 0,
          message,
        })

    return result.response === 1
  })

  ipcMain.removeHandler(SET_THEME_CHANNEL)
  ipcMain.handle(SET_THEME_CHANNEL, (_event, rawTheme: unknown) => {
    const theme = getSafeTheme(rawTheme)
    if (!theme) {
      return
    }

    nativeTheme.themeSource = theme
  })

  ipcMain.removeHandler(CONTEXT_MENU_CHANNEL)
  ipcMain.handle(
    CONTEXT_MENU_CHANNEL,
    (_event, items: ContextMenuItem[], position?: { x: number; y: number }) => {
      const normalizedItems = items
        .filter(
          (item) =>
            typeof item.id === 'string' && typeof item.label === 'string'
        )
        .map((item) => ({
          id: item.id,
          label: item.label,
          destructive: item.destructive === true,
          disabled: item.disabled === true,
        }))

      if (normalizedItems.length === 0) {
        return null
      }

      const popupPosition =
        position &&
        Number.isFinite(position.x) &&
        Number.isFinite(position.y) &&
        position.x >= 0 &&
        position.y >= 0
          ? {
              x: Math.floor(position.x),
              y: Math.floor(position.y),
            }
          : null

      const window = BrowserWindow.getFocusedWindow() ?? mainWindow
      if (!window) {
        return null
      }

      return new Promise<string | null>((resolve) => {
        let settled = false
        const finish = (value: string | null) => {
          if (settled) {
            return
          }

          settled = true
          resolve(value)
        }

        const template: MenuItemConstructorOptions[] = []
        let hasInsertedDestructiveSeparator = false

        for (const item of normalizedItems) {
          if (
            item.destructive &&
            !hasInsertedDestructiveSeparator &&
            template.length > 0
          ) {
            template.push({ type: 'separator' })
            hasInsertedDestructiveSeparator = true
          }

          template.push({
            label: item.label,
            enabled: !item.disabled,
            click: () => finish(item.id),
          })
        }

        const menu = Menu.buildFromTemplate(template)
        menu.popup({
          window,
          ...popupPosition,
          callback: () => finish(null),
        })
      })
    }
  )

  ipcMain.removeHandler(OPEN_EXTERNAL_CHANNEL)
  ipcMain.handle(OPEN_EXTERNAL_CHANNEL, async (_event, rawUrl: unknown) => {
    const externalUrl = getSafeExternalUrl(rawUrl)
    if (!externalUrl) {
      return false
    }

    try {
      await shell.openExternal(externalUrl)
      return true
    } catch {
      return false
    }
  })

  ipcMain.removeHandler(UPDATE_GET_STATE_CHANNEL)
  ipcMain.handle(UPDATE_GET_STATE_CHANNEL, () => updateState)

  ipcMain.removeHandler(UPDATE_DOWNLOAD_CHANNEL)
  ipcMain.handle(UPDATE_DOWNLOAD_CHANNEL, () => {
    updateState = { ...updateState, checkedAt: new Date().toISOString() }
    emitUpdateState()

    return {
      accepted: false,
      completed: false,
      state: updateState,
    } satisfies DesktopUpdateActionResult
  })

  ipcMain.removeHandler(UPDATE_INSTALL_CHANNEL)
  ipcMain.handle(
    UPDATE_INSTALL_CHANNEL,
    () =>
      ({
        accepted: false,
        completed: false,
        state: updateState,
      }) satisfies DesktopUpdateActionResult
  )

  ipcMain.removeHandler(UPDATE_CHECK_CHANNEL)
  ipcMain.handle(UPDATE_CHECK_CHANNEL, () => {
    updateState = {
      ...updateState,
      checkedAt: new Date().toISOString(),
    }
    emitUpdateState()

    return {
      checked: false,
      state: updateState,
    } satisfies DesktopUpdateCheckResult
  })
}

const createWindow = (): BrowserWindow => {
  const window = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 840,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    title: APP_DISPLAY_NAME,
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 16, y: 18 },
        }
      : {}),
    webPreferences: {
      preload: join(app.getAppPath(), 'dist-electron/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  window.webContents.on('context-menu', (event, params) => {
    event.preventDefault()

    const menuTemplate: MenuItemConstructorOptions[] = [
      { role: 'cut', enabled: params.editFlags.canCut },
      { role: 'copy', enabled: params.editFlags.canCopy },
      { role: 'paste', enabled: params.editFlags.canPaste },
      { role: 'selectAll', enabled: params.editFlags.canSelectAll },
    ]

    Menu.buildFromTemplate(menuTemplate).popup({ window })
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    const externalUrl = getSafeExternalUrl(url)
    if (externalUrl) {
      shell.openExternal(externalUrl).catch(() => undefined)
    }

    return { action: 'deny' }
  })

  window.on('page-title-updated', (event) => {
    event.preventDefault()
    window.setTitle(APP_DISPLAY_NAME)
  })

  window.webContents.on('did-finish-load', () => {
    window.setTitle(APP_DISPLAY_NAME)
    emitUpdateState()
  })

  window.once('ready-to-show', () => {
    window.show()
  })

  if (isDevelopment) {
    window
      .loadURL(process.env.VITE_DEV_SERVER_URL as string)
      .catch((error: unknown) => {
        dialog.showErrorBox('Laborer failed to load', formatErrorMessage(error))
      })
    window.webContents.openDevTools({ mode: 'detach' })
  } else {
    window
      .loadURL(`${DESKTOP_SCHEME}://app/index.html`)
      .catch((error: unknown) => {
        dialog.showErrorBox('Laborer failed to load', formatErrorMessage(error))
      })
  }

  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null
    }
  })

  return window
}

const bootstrap = async (): Promise<void> => {
  registerDesktopProtocol()
  await startBackend()
  registerIpcHandlers()
  Menu.setApplicationMenu(buildAppMenu())
  mainWindow = createWindow()
}

app.setAppUserModelId(APP_USER_MODEL_ID)
app.setPath('userData', join(app.getPath('appData'), USER_DATA_DIR_NAME))

app.on('before-quit', () => {
  isQuitting = true
  stopBackend()
})

app
  .whenReady()
  .then(bootstrap)
  .catch((error: unknown) => {
    const message = formatErrorMessage(error)
    dialog.showErrorBox('Laborer failed to start', message)
    app.quit()
  })

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createWindow()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
