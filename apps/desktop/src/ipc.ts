import type { ContextMenuItem } from '@laborer/shared/desktop-bridge'
import {
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  shell,
} from 'electron'

// ---------------------------------------------------------------------------
// IPC channel constants (must match preload.ts)
// ---------------------------------------------------------------------------

export const PICK_FOLDER_CHANNEL = 'desktop:pick-folder'
export const CONFIRM_CHANNEL = 'desktop:confirm'
export const CONTEXT_MENU_CHANNEL = 'desktop:context-menu'
export const OPEN_EXTERNAL_CHANNEL = 'desktop:open-external'
export const MENU_ACTION_CHANNEL = 'desktop:menu-action'
export const UPDATE_TRAY_COUNT_CHANNEL = 'desktop:update-tray-count'
export const RESTART_SIDECAR_CHANNEL = 'desktop:restart-sidecar'
export const SIDECAR_STATUS_CHANNEL = 'sidecar:status'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validates and normalizes a URL for `shell.openExternal()`.
 * Only allows http: and https: protocols to prevent `javascript:` injection.
 */
function getSafeExternalUrl(rawUrl: unknown): string | null {
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

const CONFIRM_BUTTON_INDEX = 1

/**
 * Shows a native confirmation dialog with "No" and "Yes" buttons.
 * Returns true if the user clicked "Yes".
 */
async function showConfirmDialog(
  message: string,
  ownerWindow: BrowserWindow | null
): Promise<boolean> {
  const normalizedMessage = message.trim()
  if (normalizedMessage.length === 0) {
    return false
  }

  const options = {
    type: 'question' as const,
    buttons: ['No', 'Yes'],
    defaultId: CONFIRM_BUTTON_INDEX,
    cancelId: 0,
    noLink: true,
    message: normalizedMessage,
  }

  const result = ownerWindow
    ? await dialog.showMessageBox(ownerWindow, options)
    : await dialog.showMessageBox(options)

  return result.response === CONFIRM_BUTTON_INDEX
}

// ---------------------------------------------------------------------------
// Callbacks — set by main.ts to wire IPC handlers to the app's state
// ---------------------------------------------------------------------------

type TrayCountCallback = (count: number) => void
type RestartSidecarCallback = (name: string) => Promise<void>

let trayCountCallback: TrayCountCallback | null = null
let restartSidecarCallback: RestartSidecarCallback | null = null

/** Set the callback invoked when the renderer updates the tray workspace count. */
export function setTrayCountHandler(cb: TrayCountCallback): void {
  trayCountCallback = cb
}

/** Set the callback invoked when the renderer requests a sidecar restart. */
export function setRestartSidecarHandler(cb: RestartSidecarCallback): void {
  restartSidecarCallback = cb
}

// ---------------------------------------------------------------------------
// Register IPC handlers
// ---------------------------------------------------------------------------

/**
 * Registers all `ipcMain.handle()` handlers for the DesktopBridge IPC.
 * Should be called once during app bootstrap (after `app.whenReady()`).
 *
 * Each handler mirrors a method on the `DesktopBridge` interface.
 */
export function registerIpcHandlers(mainWindow: BrowserWindow): void {
  // -- Folder picker -------------------------------------------------------
  ipcMain.removeHandler(PICK_FOLDER_CHANNEL)
  ipcMain.handle(PICK_FOLDER_CHANNEL, async () => {
    const owner = BrowserWindow.getFocusedWindow() ?? mainWindow
    const result = await dialog.showOpenDialog(owner, {
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled) {
      return null
    }
    return result.filePaths[0] ?? null
  })

  // -- Confirm dialog ------------------------------------------------------
  ipcMain.removeHandler(CONFIRM_CHANNEL)
  ipcMain.handle(CONFIRM_CHANNEL, async (_event, message: unknown) => {
    if (typeof message !== 'string') {
      return false
    }
    const owner = BrowserWindow.getFocusedWindow() ?? mainWindow
    return await showConfirmDialog(message, owner)
  })

  // -- Context menu --------------------------------------------------------
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
          ? { x: Math.floor(position.x), y: Math.floor(position.y) }
          : null

      const window = BrowserWindow.getFocusedWindow() ?? mainWindow
      if (!window) {
        return null
      }

      return new Promise<string | null>((resolve) => {
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
            click: () => resolve(item.id),
          })
        }

        const menu = Menu.buildFromTemplate(template)
        menu.popup({
          window,
          ...popupPosition,
          callback: () => resolve(null),
        })
      })
    }
  )

  // -- Open external URL ---------------------------------------------------
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

  // -- Update tray workspace count -----------------------------------------
  ipcMain.removeHandler(UPDATE_TRAY_COUNT_CHANNEL)
  ipcMain.handle(UPDATE_TRAY_COUNT_CHANNEL, (_event, count: unknown) => {
    if (typeof count !== 'number' || !Number.isFinite(count)) {
      return
    }
    trayCountCallback?.(Math.max(0, Math.floor(count)))
  })

  // -- Restart sidecar -----------------------------------------------------
  ipcMain.removeHandler(RESTART_SIDECAR_CHANNEL)
  ipcMain.handle(RESTART_SIDECAR_CHANNEL, async (_event, name: unknown) => {
    if (typeof name !== 'string') {
      return
    }
    if (name !== 'server' && name !== 'terminal' && name !== 'mcp') {
      return
    }
    await restartSidecarCallback?.(name)
  })
}
