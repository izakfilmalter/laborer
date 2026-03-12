import type {
  AgentNotificationPayload,
  ContextMenuItem,
  DesktopUpdateActionResult,
  DesktopUpdateState,
} from '@laborer/shared/desktop-bridge'
import {
  BrowserWindow,
  dialog,
  Notification as ElectronNotification,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  type OpenDialogOptions,
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
export const SEND_NOTIFICATION_CHANNEL = 'desktop:send-notification'
export const NOTIFICATION_CLICKED_CHANNEL = 'desktop:notification-clicked'
export const REPORT_VISIBLE_WORKSPACES_CHANNEL =
  'desktop:report-visible-workspaces'
export const FOCUS_WINDOW_FOR_WORKSPACE_CHANNEL =
  'desktop:focus-window-for-workspace'
export const ACTIVATE_WORKSPACE_CHANNEL = 'desktop:activate-workspace'
export const UPDATE_STATE_CHANNEL = 'desktop:update-state'
export const UPDATE_GET_STATE_CHANNEL = 'desktop:update-get-state'
export const UPDATE_DOWNLOAD_CHANNEL = 'desktop:update-download'
export const UPDATE_INSTALL_CHANNEL = 'desktop:update-install'

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
// Workspace-to-window registry
// ---------------------------------------------------------------------------

/**
 * Tracks which workspace IDs are visible in which BrowserWindow.
 * Updated by the renderer via the `reportVisibleWorkspaces` IPC channel.
 * Used by the notification click handler to route clicks to the correct window.
 */
class WorkspaceWindowRegistry {
  /** Map from BrowserWindow to the set of workspace IDs visible in it. */
  readonly #windowWorkspaces = new Map<BrowserWindow, Set<string>>()

  /** Update the visible workspace set for a window. */
  update(window: BrowserWindow, workspaceIds: readonly string[]): void {
    if (window.isDestroyed()) {
      this.#windowWorkspaces.delete(window)
      return
    }
    this.#windowWorkspaces.set(window, new Set(workspaceIds))
  }

  /** Remove a window's entry (e.g., when it closes). */
  remove(window: BrowserWindow): void {
    this.#windowWorkspaces.delete(window)
  }

  /**
   * Find the BrowserWindow that has the given workspace visible.
   * Returns null if no window currently shows that workspace.
   */
  findWindowForWorkspace(workspaceId: string): BrowserWindow | null {
    for (const [window, workspaces] of this.#windowWorkspaces) {
      if (window.isDestroyed()) {
        this.#windowWorkspaces.delete(window)
        continue
      }
      if (workspaces.has(workspaceId)) {
        return window
      }
    }
    return null
  }
}

const workspaceRegistry = new WorkspaceWindowRegistry()

/** Access the workspace-to-window registry for external wiring (e.g., cleanup). */
export function getWorkspaceWindowRegistry(): WorkspaceWindowRegistry {
  return workspaceRegistry
}

// ---------------------------------------------------------------------------
// Callbacks — set by main.ts to wire IPC handlers to the app's state
// ---------------------------------------------------------------------------

type TrayCountCallback = (count: number) => void
type RestartSidecarCallback = (name: string) => Promise<void>
type GetUpdateStateCallback = () => DesktopUpdateState
type DownloadUpdateCallback = () => Promise<DesktopUpdateActionResult>
type InstallUpdateCallback = () => Promise<DesktopUpdateActionResult>

let trayCountCallback: TrayCountCallback | null = null
let restartSidecarCallback: RestartSidecarCallback | null = null
let getUpdateStateCallback: GetUpdateStateCallback | null = null
let downloadUpdateCallback: DownloadUpdateCallback | null = null
let installUpdateCallback: InstallUpdateCallback | null = null

/** Set the callback invoked when the renderer updates the tray workspace count. */
export function setTrayCountHandler(cb: TrayCountCallback): void {
  trayCountCallback = cb
}

/** Set the callback invoked when the renderer requests a sidecar restart. */
export function setRestartSidecarHandler(cb: RestartSidecarCallback): void {
  restartSidecarCallback = cb
}

/** Set the callback for getting current update state. */
export function setGetUpdateStateHandler(cb: GetUpdateStateCallback): void {
  getUpdateStateCallback = cb
}

/** Set the callback for downloading an available update. */
export function setDownloadUpdateHandler(cb: DownloadUpdateCallback): void {
  downloadUpdateCallback = cb
}

/** Set the callback for installing a downloaded update. */
export function setInstallUpdateHandler(cb: InstallUpdateCallback): void {
  installUpdateCallback = cb
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
export function registerIpcHandlers(
  getFallbackWindow: () => BrowserWindow | null
): void {
  // -- Folder picker -------------------------------------------------------
  ipcMain.removeHandler(PICK_FOLDER_CHANNEL)
  ipcMain.handle(PICK_FOLDER_CHANNEL, async (event) => {
    const owner =
      BrowserWindow.fromWebContents(event.sender) ?? getFallbackWindow()
    const options: OpenDialogOptions = {
      properties: ['openDirectory', 'createDirectory'],
    }
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled) {
      return null
    }
    return result.filePaths[0] ?? null
  })

  // -- Confirm dialog ------------------------------------------------------
  ipcMain.removeHandler(CONFIRM_CHANNEL)
  ipcMain.handle(CONFIRM_CHANNEL, async (event, message: unknown) => {
    if (typeof message !== 'string') {
      return false
    }
    const owner =
      BrowserWindow.fromWebContents(event.sender) ?? getFallbackWindow()
    return await showConfirmDialog(message, owner)
  })

  // -- Context menu --------------------------------------------------------
  ipcMain.removeHandler(CONTEXT_MENU_CHANNEL)
  ipcMain.handle(
    CONTEXT_MENU_CHANNEL,
    (event, items: ContextMenuItem[], position?: { x: number; y: number }) => {
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

      const window =
        BrowserWindow.fromWebContents(event.sender) ?? getFallbackWindow()
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
    if (
      name !== 'server' &&
      name !== 'terminal' &&
      name !== 'file-watcher' &&
      name !== 'mcp'
    ) {
      return
    }
    await restartSidecarCallback?.(name)
  })

  // -- Auto-update: get state -----------------------------------------------
  ipcMain.removeHandler(UPDATE_GET_STATE_CHANNEL)
  ipcMain.handle(UPDATE_GET_STATE_CHANNEL, () => {
    return getUpdateStateCallback?.() ?? null
  })

  // -- Auto-update: download ------------------------------------------------
  ipcMain.removeHandler(UPDATE_DOWNLOAD_CHANNEL)
  ipcMain.handle(UPDATE_DOWNLOAD_CHANNEL, async () => {
    return (await downloadUpdateCallback?.()) ?? null
  })

  // -- Auto-update: install -------------------------------------------------
  ipcMain.removeHandler(UPDATE_INSTALL_CHANNEL)
  ipcMain.handle(UPDATE_INSTALL_CHANNEL, async () => {
    return (await installUpdateCallback?.()) ?? null
  })

  // -- Report visible workspaces -------------------------------------------
  ipcMain.removeHandler(REPORT_VISIBLE_WORKSPACES_CHANNEL)
  ipcMain.handle(
    REPORT_VISIBLE_WORKSPACES_CHANNEL,
    (event, workspaceIds: unknown) => {
      if (!Array.isArray(workspaceIds)) {
        return
      }

      const validIds = workspaceIds.filter(
        (id): id is string => typeof id === 'string' && id.length > 0
      )

      const senderWindow = BrowserWindow.fromWebContents(event.sender)
      if (!senderWindow) {
        return
      }

      workspaceRegistry.update(senderWindow, validIds)
    }
  )

  // -- Agent notification ---------------------------------------------------
  ipcMain.removeHandler(SEND_NOTIFICATION_CHANNEL)
  ipcMain.handle(SEND_NOTIFICATION_CHANNEL, (_event, payload: unknown) => {
    if (
      typeof payload !== 'object' ||
      payload === null ||
      !('title' in payload) ||
      !('body' in payload) ||
      !('workspaceId' in payload)
    ) {
      return
    }

    const { title, body, workspaceId } = payload as AgentNotificationPayload

    if (
      typeof title !== 'string' ||
      typeof body !== 'string' ||
      typeof workspaceId !== 'string'
    ) {
      return
    }

    if (!ElectronNotification.isSupported()) {
      return
    }

    const notification = new ElectronNotification({ title, body })

    notification.on('click', () => {
      // Prefer the window that already has this workspace visible.
      // Fall back to the general fallback window if no match is found.
      const targetWindow =
        workspaceRegistry.findWindowForWorkspace(workspaceId) ??
        getFallbackWindow()
      if (!targetWindow) {
        return
      }

      // Focus the selected window and tell the renderer which workspace was clicked.
      targetWindow.show()
      targetWindow.focus()
      targetWindow.webContents.send(NOTIFICATION_CLICKED_CHANNEL, workspaceId)
    })

    notification.show()
  })

  // -- Focus window for workspace ------------------------------------------
  ipcMain.removeHandler(FOCUS_WINDOW_FOR_WORKSPACE_CHANNEL)
  ipcMain.handle(
    FOCUS_WINDOW_FOR_WORKSPACE_CHANNEL,
    (event, workspaceId: unknown) => {
      if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
        return false
      }

      const targetWindow = workspaceRegistry.findWindowForWorkspace(workspaceId)
      if (!targetWindow) {
        return false
      }

      // Don't focus if the requesting window IS the target window —
      // the workspace is already open in the caller's own window.
      const senderWindow = BrowserWindow.fromWebContents(event.sender)
      if (senderWindow === targetWindow) {
        return false
      }

      targetWindow.show()
      targetWindow.focus()
      targetWindow.webContents.send(ACTIVATE_WORKSPACE_CHANNEL, workspaceId)
      return true
    }
  )
}
