import {
  type BeforeQuitPayload,
  type ContextMenuItem,
  type DesktopUpdateActionResult,
  type DesktopUpdateState,
  decodeWorkspaceActivationIntent,
  type WorkspaceActivationIntent,
} from '@laborer/shared/desktop-bridge'
import {
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  type OpenDialogOptions,
  shell,
} from 'electron'
import { WindowWorkspacePresenceRegistry } from './window-workspace-presence.js'

// ---------------------------------------------------------------------------
// IPC channel constants (must match preload.ts)
// ---------------------------------------------------------------------------

export const PICK_FOLDER_CHANNEL = 'desktop:pick-folder'
export const CONFIRM_CHANNEL = 'desktop:confirm'
export const CONTEXT_MENU_CHANNEL = 'desktop:context-menu'
export const OPEN_EXTERNAL_CHANNEL = 'desktop:open-external'
export const MENU_ACTION_CHANNEL = 'desktop:menu-action'
export const UPDATE_TRAY_COUNT_CHANNEL = 'desktop:update-tray-count'
export const REPORT_VISIBLE_WORKSPACES_CHANNEL =
  'desktop:report-visible-workspaces'
export const FOCUS_WINDOW_FOR_WORKSPACE_CHANNEL =
  'desktop:focus-window-for-workspace'
export const ACTIVATE_WORKSPACE_CHANNEL = 'desktop:activate-workspace'
export const UPDATE_STATE_CHANNEL = 'desktop:update-state'
export const UPDATE_GET_STATE_CHANNEL = 'desktop:update-get-state'
export const UPDATE_DOWNLOAD_CHANNEL = 'desktop:update-download'
export const UPDATE_INSTALL_CHANNEL = 'desktop:update-install'
export const GITHUB_OAUTH_CALLBACK_CHANNEL = 'desktop:github-oauth-callback'
export const START_GITHUB_OAUTH_CHANNEL = 'desktop:start-github-oauth'
export const BEFORE_QUIT_CHANNEL = 'desktop:before-quit'
export const QUIT_REPLY_CHANNEL = 'desktop:quit-reply'
export const QUIT_CONFIRMED_CHANNEL = 'desktop:quit-confirmed'

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

function resolveWorkspaceActivationIntent(
  workspaceId: string,
  activation: unknown
): string | WorkspaceActivationIntent {
  if (
    typeof activation !== 'object' ||
    activation === null ||
    !('action' in activation)
  ) {
    return workspaceId
  }
  const decoded = decodeWorkspaceActivationIntent({
    ...activation,
    workspaceId,
  })
  return decoded ?? workspaceId
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
 * Updated by renderer window-routing metadata. Semantic workspace presence is
 * reported directly to the daemon over RPC.
 * Used by the notification click handler to route clicks to the correct window.
 */
const workspaceRegistry = new WindowWorkspacePresenceRegistry<BrowserWindow>()

/** Access the workspace-to-window registry for external wiring (e.g., cleanup). */
export function getWorkspaceWindowRegistry(): WindowWorkspacePresenceRegistry<BrowserWindow> {
  return workspaceRegistry
}

// ---------------------------------------------------------------------------
// Callbacks — set by main.ts to wire IPC handlers to the app's state
// ---------------------------------------------------------------------------

type TrayCountCallback = (count: number) => void
type GetUpdateStateCallback = () => DesktopUpdateState
type DownloadUpdateCallback = () => Promise<DesktopUpdateActionResult>
type InstallUpdateCallback = () => Promise<DesktopUpdateActionResult>

let trayCountCallback: TrayCountCallback | null = null
let getUpdateStateCallback: GetUpdateStateCallback | null = null
let downloadUpdateCallback: DownloadUpdateCallback | null = null
let installUpdateCallback: InstallUpdateCallback | null = null
export function removeWindowPresence(window: BrowserWindow): void {
  workspaceRegistry.remove(window)
}

/** Set the callback invoked when the renderer updates the tray workspace count. */
export function setTrayCountHandler(cb: TrayCountCallback): void {
  trayCountCallback = cb
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
// Quit orchestration — veto-based quit flow (VS Code pattern)
// ---------------------------------------------------------------------------

/**
 * Ask renderer windows whether they're ready to quit.
 *
 * For app quits, only the focused window participates in the veto flow so we
 * show at most one confirmation dialog. If no window is focused, we fall back
 * to the first eligible window. Non-quit reasons still broadcast to all
 * windows.
 *
 * Returns `true` if the quit was vetoed (i.e., the app should NOT exit).
 */
export async function askRenderersBeforeQuit(
  reason: BeforeQuitPayload['reason'],
  timeoutMs = 5000
): Promise<boolean> {
  const windows = BrowserWindow.getAllWindows().filter(
    (w) => !w.isDestroyed() && w.webContents && !w.webContents.isDestroyed()
  )

  let targetWindows = windows

  if (reason === 'quit') {
    const focusedWindow = BrowserWindow.getFocusedWindow()
    targetWindows =
      focusedWindow !== null && windows.includes(focusedWindow)
        ? [focusedWindow]
        : windows.slice(0, 1)
  }

  if (targetWindows.length === 0) {
    return false
  }

  const quitId = crypto.randomUUID()
  const payload: BeforeQuitPayload = { id: quitId, reason }

  // Collect replies from all windows.
  const replyPromise = new Promise<boolean>((resolve) => {
    let repliesReceived = 0
    let vetoed = false

    const onReply = (
      _event: Electron.IpcMainEvent,
      replyPayload: unknown
    ): void => {
      if (
        typeof replyPayload !== 'object' ||
        replyPayload === null ||
        !('id' in replyPayload) ||
        (replyPayload as { id: unknown }).id !== quitId
      ) {
        return
      }

      const reply = replyPayload as { id: string; veto: unknown }
      if (reply.veto === true) {
        vetoed = true
      }

      repliesReceived++
      if (repliesReceived >= targetWindows.length) {
        ipcMain.removeListener(QUIT_REPLY_CHANNEL, onReply)
        resolve(vetoed)
      }
    }

    ipcMain.on(QUIT_REPLY_CHANNEL, onReply)

    // Safety timeout — if windows don't respond in time, proceed with quit.
    setTimeout(() => {
      ipcMain.removeListener(QUIT_REPLY_CHANNEL, onReply)
      resolve(vetoed)
    }, timeoutMs).unref()
  })

  // Broadcast the before-quit payload to the selected renderer windows.
  for (const window of targetWindows) {
    window.webContents.send(BEFORE_QUIT_CHANNEL, payload)
  }

  return await replyPromise
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

  // -- Get backend WebSocket URL ---------------------------------------------
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
    (event, payload: unknown) => {
      let workspaceIds: unknown = null
      if (Array.isArray(payload)) {
        workspaceIds = payload
      } else if (
        typeof payload === 'object' &&
        payload !== null &&
        'workspaceIds' in payload
      ) {
        workspaceIds = payload.workspaceIds
      }
      const contexts =
        typeof payload === 'object' &&
        payload !== null &&
        'contexts' in payload &&
        Array.isArray(payload.contexts)
          ? payload.contexts
              .filter(
                (
                  context
                ): context is {
                  branchName: string
                  workspaceId: string
                } =>
                  typeof context === 'object' &&
                  context !== null &&
                  'branchName' in context &&
                  typeof context.branchName === 'string' &&
                  context.branchName.length <= 1000 &&
                  'workspaceId' in context &&
                  typeof context.workspaceId === 'string' &&
                  context.workspaceId.length > 0 &&
                  context.workspaceId.length <= 1000
              )
              .slice(0, 1000)
          : []
      if (!Array.isArray(workspaceIds)) {
        return
      }

      const validIds = workspaceIds.filter(
        (id): id is string =>
          typeof id === 'string' && id.length > 0 && id.length <= 1000
      )

      const senderWindow = BrowserWindow.fromWebContents(event.sender)
      if (!senderWindow) {
        return
      }

      workspaceRegistry.update(senderWindow, {
        contexts,
        // Window focus is a main-process fact. Do not let a renderer-supplied
        // boolean bypass app-wide notification suppression.
        focused: senderWindow.isFocused(),
        workspaceIds: validIds.slice(0, 1000),
      })
    }
  )

  // -- Focus window for workspace ------------------------------------------
  ipcMain.removeHandler(FOCUS_WINDOW_FOR_WORKSPACE_CHANNEL)
  ipcMain.handle(
    FOCUS_WINDOW_FOR_WORKSPACE_CHANNEL,
    (event, workspaceId: unknown, activation: unknown) => {
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
      const intent = resolveWorkspaceActivationIntent(workspaceId, activation)
      targetWindow.webContents.send(ACTIVATE_WORKSPACE_CHANNEL, intent)
      return true
    }
  )

  // -- Start GitHub OAuth --------------------------------------------------
  ipcMain.removeHandler(START_GITHUB_OAUTH_CHANNEL)
  ipcMain.handle(START_GITHUB_OAUTH_CHANNEL, async (_event, state: unknown) => {
    if (typeof state !== 'string') {
      return
    }
    const scope = encodeURIComponent('repo user workflow')
    const clientId = '3a723b10ac5575cc5bb9'
    const url =
      'https://github.com/login/oauth/authorize' +
      `?client_id=${clientId}` +
      `&scope=${scope}` +
      `&state=${state}`
    await shell.openExternal(url)
  })
}
