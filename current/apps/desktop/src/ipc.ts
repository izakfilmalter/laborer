import type {
  BeforeQuitPayload,
  ContextMenuItem,
  DesktopUpdateActionResult,
  DesktopUpdateState,
  SidecarName,
  SidecarStatusEvent,
} from '@laborer/shared/desktop-bridge'
import {
  BrowserWindow,
  dialog,
  type IpcMainEvent,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  MessageChannelMain,
  type OpenDialogOptions,
  shell,
} from 'electron'
import type { UtilityProcessManager } from './utility-process-manager.js'
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
export const RESTART_SIDECAR_CHANNEL = 'desktop:restart-sidecar'
export const SIDECAR_STATUS_CHANNEL = 'sidecar:status'
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
export const GET_BACKEND_WS_URL_CHANNEL = 'desktop:get-backend-ws-url'
export const GET_SIDECAR_STATUSES_CHANNEL = 'desktop:get-sidecar-statuses'
export const BEFORE_QUIT_CHANNEL = 'desktop:before-quit'
export const QUIT_REPLY_CHANNEL = 'desktop:quit-reply'
export const QUIT_CONFIRMED_CHANNEL = 'desktop:quit-confirmed'
export const ACQUIRE_SERVICE_PORT_CHANNEL = 'laborer:acquire-service-port'
export const SERVICE_PORT_RESPONSE_CHANNEL = 'laborer:service-port-response'
export const ACQUIRE_TERMINAL_DATA_PORT_CHANNEL =
  'laborer:acquire-terminal-data-port'
export const TERMINAL_DATA_PORT_RESPONSE_CHANNEL =
  'laborer:terminal-data-port-response'
export const ACQUIRE_SYNC_PORT_CHANNEL = 'laborer:acquire-sync-port'
export const SYNC_PORT_RESPONSE_CHANNEL = 'laborer:sync-port-response'

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
const workspaceRegistry = new WindowWorkspacePresenceRegistry<BrowserWindow>()

/** Access the workspace-to-window registry for external wiring (e.g., cleanup). */
export function getWorkspaceWindowRegistry(): WindowWorkspacePresenceRegistry<BrowserWindow> {
  return workspaceRegistry
}

// ---------------------------------------------------------------------------
// Renderer port registry — tracks MessagePort pairs for proactive cleanup
// ---------------------------------------------------------------------------

/**
 * Tracks `MessagePortMain` objects created for renderer-to-utility connections.
 *
 * When a utility process exits (crash or intentional), the main process must
 * close the renderer-side ports so the renderer's `MessagePort.onclose` fires
 * and the RPC client transport can synthesize a Defect to unblock pending
 * requests. Without this, the renderer's port stays "alive" with no way to
 * detect the dead channel — the `onclose` event on Web `MessagePort` is
 * unreliable when the remote process dies.
 *
 * @see VS Code's `PersistentProtocol.beginAcceptReconnection` for similar
 *      port invalidation on disconnect.
 */
class RendererPortRegistry {
  /**
   * Map from service name to the set of renderer-side `MessagePortMain`
   * objects currently held by renderer windows.
   */
  readonly #ports = new Map<
    SidecarName,
    Set<import('electron').MessagePortMain>
  >()

  /** Register a renderer-side port for a service. */
  track(
    serviceName: SidecarName,
    port: import('electron').MessagePortMain
  ): void {
    let set = this.#ports.get(serviceName)
    if (!set) {
      set = new Set()
      this.#ports.set(serviceName, set)
    }
    set.add(port)

    // Auto-remove when the port is closed normally (e.g., renderer
    // navigates away or atom layer is disposed).
    port.on('close', () => {
      set?.delete(port)
    })
  }

  /**
   * Close and remove all renderer-side ports for a service.
   *
   * Called when the utility process exits — this triggers the renderer's
   * `MessagePort.onclose` event, which the RPC client transport uses to
   * synthesize a Defect and unblock all pending requests.
   */
  closeAll(serviceName: SidecarName): void {
    const set = this.#ports.get(serviceName)
    if (!set || set.size === 0) {
      return
    }

    console.log(`[ipc] Closing ${set.size} renderer port(s) for ${serviceName}`)
    for (const port of set) {
      try {
        port.close()
      } catch {
        // Port may already be closed — ignore.
      }
    }
    set.clear()
  }
}

const rendererPortRegistry = new RendererPortRegistry()

/**
 * Close all renderer-side ports for a service.
 *
 * Called by the lifecycle monitor or utility process manager when a sidecar
 * exits so that the renderer's `onclose` handler fires and RPC clients can
 * detect the dead channel.
 */
export function closeRendererPortsForService(serviceName: SidecarName): void {
  rendererPortRegistry.closeAll(serviceName)
}

// ---------------------------------------------------------------------------
// Callbacks — set by main.ts to wire IPC handlers to the app's state
// ---------------------------------------------------------------------------

type TrayCountCallback = (count: number) => void
type RestartSidecarCallback = (name: string) => Promise<void>
type GetSidecarStatusesCallback = () => SidecarStatusEvent[]
type GetUpdateStateCallback = () => DesktopUpdateState
type DownloadUpdateCallback = () => Promise<DesktopUpdateActionResult>
type InstallUpdateCallback = () => Promise<DesktopUpdateActionResult>
type GetBackendWsUrlCallback = () => string | null
type WorkspacePresenceCallback = (workspaceIds: readonly string[]) => void

let trayCountCallback: TrayCountCallback | null = null
let restartSidecarCallback: RestartSidecarCallback | null = null
let getSidecarStatusesCallback: GetSidecarStatusesCallback | null = null
let getUpdateStateCallback: GetUpdateStateCallback | null = null
let downloadUpdateCallback: DownloadUpdateCallback | null = null
let installUpdateCallback: InstallUpdateCallback | null = null
let getBackendWsUrlCallback: GetBackendWsUrlCallback | null = null
let utilityProcessManagerRef: UtilityProcessManager | null = null
let workspacePresenceCallback: WorkspacePresenceCallback | null = null

export function publishWorkspacePresence(): void {
  workspacePresenceCallback?.(workspaceRegistry.focusedWorkspaceIds())
}

export function setWorkspacePresenceHandler(
  cb: WorkspacePresenceCallback | null
): void {
  workspacePresenceCallback = cb
  publishWorkspacePresence()
}

export function removeWindowPresence(window: BrowserWindow): void {
  workspaceRegistry.remove(window)
  publishWorkspacePresence()
}

/** Set the callback invoked when the renderer updates the tray workspace count. */
export function setTrayCountHandler(cb: TrayCountCallback): void {
  trayCountCallback = cb
}

/** Set the callback invoked when the renderer requests a sidecar restart. */
export function setRestartSidecarHandler(cb: RestartSidecarCallback): void {
  restartSidecarCallback = cb
}

/** Set the callback for getting current sidecar statuses. */
export function setGetSidecarStatusesHandler(
  cb: GetSidecarStatusesCallback
): void {
  getSidecarStatusesCallback = cb
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

/** Set the callback for getting the server backend WebSocket URL. */
export function setGetBackendWsUrlHandler(cb: GetBackendWsUrlCallback): void {
  getBackendWsUrlCallback = cb
}

/** Set the utility process manager for MessagePort acquisition. */
export function setUtilityProcessManager(
  manager: UtilityProcessManager | null
): void {
  utilityProcessManagerRef = manager
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
 * Parse and validate the payload for a terminal data port acquire request.
 * Returns `null` if the payload is invalid.
 */
function parseTerminalDataPortPayload(
  payload: unknown
): { terminalId: string; nonce: string } | null {
  if (typeof payload !== 'object' || payload === null) {
    return null
  }
  const { terminalId, nonce } = payload as {
    terminalId: unknown
    nonce: unknown
  }
  if (typeof terminalId !== 'string' || typeof nonce !== 'string') {
    return null
  }
  return { terminalId, nonce }
}

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
    if (name !== 'server' && name !== 'terminal' && name !== 'file-watcher') {
      return
    }
    await restartSidecarCallback?.(name)
  })

  // -- Get sidecar statuses (initial query) ----------------------------------
  // Allows the renderer to request the current status of all services on
  // mount, avoiding the race where broadcast events are missed because
  // the window was created after services were already healthy.
  ipcMain.removeHandler(GET_SIDECAR_STATUSES_CHANNEL)
  ipcMain.handle(GET_SIDECAR_STATUSES_CHANNEL, () => {
    return getSidecarStatusesCallback?.() ?? []
  })

  // -- Get backend WebSocket URL ---------------------------------------------
  ipcMain.removeAllListeners(GET_BACKEND_WS_URL_CHANNEL)
  ipcMain.on(GET_BACKEND_WS_URL_CHANNEL, (event: IpcMainEvent) => {
    event.returnValue = getBackendWsUrlCallback?.() ?? null
  })
  ipcMain.removeHandler(GET_BACKEND_WS_URL_CHANNEL)
  ipcMain.handle(GET_BACKEND_WS_URL_CHANNEL, () => {
    return getBackendWsUrlCallback?.() ?? null
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
      const focused =
        typeof payload === 'object' && payload !== null && 'focused' in payload
          ? payload.focused === true
          : false
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
                  'workspaceId' in context &&
                  typeof context.workspaceId === 'string'
              )
              .slice(0, 1000)
          : []
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

      workspaceRegistry.update(senderWindow, {
        contexts,
        focused,
        workspaceIds: validIds.slice(0, 1000),
      })
      publishWorkspacePresence()
    }
  )

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

  // -- Acquire service port ------------------------------------------------
  // Creates a MessagePort pair: one end goes to the named utility process,
  // the other goes to the requesting renderer window.
  //
  // Protocol (matching VS Code's acquirePort pattern):
  // 1. Renderer calls `ipcSend(ACQUIRE_SERVICE_PORT_CHANNEL, { name, nonce })`
  // 2. Renderer has already installed a preload relay via
  //    `ipcMessagePort.acquire(SERVICE_PORT_RESPONSE_CHANNEL, nonce)`
  // 3. Main process responds with the nonce as data and the port in the
  //    transfer array via `webContents.postMessage(responseChannel, nonce, [port])`
  // 4. Preload relay fires, calls `window.postMessage(nonce, '*', e.ports)`
  // 5. Renderer catches the port via `window.addEventListener('message')`
  //
  // @see .reference/vscode/src/vs/platform/terminal/electron-main/electronPtyHostStarter.ts
  ipcMain.removeAllListeners(ACQUIRE_SERVICE_PORT_CHANNEL)
  ipcMain.on(ACQUIRE_SERVICE_PORT_CHANNEL, (event, payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) {
      return
    }

    const { name, nonce } = payload as {
      name: unknown
      nonce: unknown
    }

    if (typeof name !== 'string' || typeof nonce !== 'string') {
      return
    }

    const validNames: readonly SidecarName[] = [
      'server',
      'terminal',
      'file-watcher',
    ]
    if (!validNames.includes(name as SidecarName)) {
      return
    }

    const serviceName = name as SidecarName
    if (!utilityProcessManagerRef?.isRunning(serviceName)) {
      return
    }

    const utilityProcess = utilityProcessManagerRef.getProcess(serviceName)
    if (!utilityProcess) {
      return
    }

    if (event.sender.isDestroyed()) {
      return
    }

    console.log(
      `[ipc] acquireServicePort: name=${serviceName} nonce=${nonce} — creating MessageChannelMain pair`
    )
    const { port1: rendererPort, port2: utilityPort } = new MessageChannelMain()
    rendererPortRegistry.track(serviceName, rendererPort)
    utilityProcess.postMessage({ type: 'port' }, [utilityPort])
    console.log(
      `[ipc] acquireServicePort: sent utilityPort to ${serviceName}, sending rendererPort to renderer via ${SERVICE_PORT_RESPONSE_CHANNEL}`
    )
    event.sender.postMessage(SERVICE_PORT_RESPONSE_CHANNEL, nonce, [
      rendererPort,
    ])
  })

  // -- Acquire terminal data port ------------------------------------------
  // Creates a per-terminal MessagePort pair for PTY I/O streaming.
  // One port goes to the utility process (attached to a specific PTY),
  // the other goes to the renderer (attached to the xterm.js instance).
  //
  // This is separate from the RPC channel — RPC handles structured commands,
  // the data channel handles high-frequency I/O streaming.
  //
  // @see Issue #8: Terminal PTY I/O data channel over MessagePort
  // -- Acquire terminal data port ------------------------------------------
  // Routes terminal data ports to the correct utility process:
  // - Daytona terminals (prefixed with `daytona:`) → server utility process
  //   (where the Daytona SDK and PTY WebSocket connections live)
  // - Docker/host terminals → terminal utility process
  //   (where node-pty sessions are managed)
  //
  // @see Issue #17: Daytona PTY — bridge to xterm.js terminal component
  ipcMain.removeAllListeners(ACQUIRE_TERMINAL_DATA_PORT_CHANNEL)
  ipcMain.on(ACQUIRE_TERMINAL_DATA_PORT_CHANNEL, (event, payload: unknown) => {
    const parsed = parseTerminalDataPortPayload(payload)
    if (!parsed) {
      return
    }

    const { terminalId, nonce } = parsed
    const isDaytonaTerminal = terminalId.startsWith('daytona:')
    const processName = isDaytonaTerminal ? 'server' : 'terminal'
    const messageType = isDaytonaTerminal
      ? 'daytona-terminal-data-port'
      : 'terminal-data-port'

    if (!utilityProcessManagerRef?.isRunning(processName)) {
      return
    }

    const targetProcess = utilityProcessManagerRef.getProcess(processName)
    if (!targetProcess || event.sender.isDestroyed()) {
      return
    }

    const { port1: rendererPort, port2: utilityPort } = new MessageChannelMain()
    rendererPortRegistry.track(processName, rendererPort)
    targetProcess.postMessage({ type: messageType, terminalId }, [utilityPort])
    event.sender.postMessage(TERMINAL_DATA_PORT_RESPONSE_CHANNEL, nonce, [
      rendererPort,
    ])
  })

  // -- Acquire sync port ----------------------------------------------------
  ipcMain.removeAllListeners(ACQUIRE_SYNC_PORT_CHANNEL)
  ipcMain.on(ACQUIRE_SYNC_PORT_CHANNEL, (event, payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) {
      return
    }

    const { nonce } = payload as { nonce: unknown }

    if (typeof nonce !== 'string') {
      return
    }

    if (!utilityProcessManagerRef?.isRunning('server')) {
      return
    }

    const utilityProcess = utilityProcessManagerRef.getProcess('server')
    if (!utilityProcess || event.sender.isDestroyed()) {
      return
    }

    const { port1: rendererPort, port2: utilityPort } = new MessageChannelMain()
    rendererPortRegistry.track('server', rendererPort)
    utilityProcess.postMessage({ type: 'sync-port' }, [utilityPort])
    event.sender.postMessage(SYNC_PORT_RESPONSE_CHANNEL, nonce, [rendererPort])
  })
}
