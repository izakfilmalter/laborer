/**
 * Context menu item definition for native context menus.
 */
export interface ContextMenuItem<T extends string = string> {
  readonly destructive?: boolean
  readonly id: T
  readonly label: string
}

/**
 * Sidecar service names managed by the Electron main process.
 */
export type SidecarName = 'server' | 'terminal' | 'file-watcher'

/**
 * Sidecar status reported to the renderer.
 *
 * - `starting`     — sidecar spawned, waiting for health check
 * - `healthy`      — health check passed, service is reachable
 * - `unresponsive` — process alive but heartbeats stopped (advisory only;
 *                    emitted for status-only services like `terminal`,
 *                    self-heals to `healthy` on the next beat — ADR 0003)
 * - `crashed`      — process exited unexpectedly (includes stderr excerpt)
 * - `restarting`   — automatic restart scheduled, waiting for backoff delay
 */
export type SidecarStatusEvent =
  | { readonly state: 'starting'; readonly name: SidecarName }
  | { readonly state: 'healthy'; readonly name: SidecarName }
  | { readonly state: 'unresponsive'; readonly name: SidecarName }
  | {
      readonly state: 'crashed'
      readonly name: SidecarName
      readonly error: string
    }
  | {
      readonly state: 'restarting'
      readonly name: SidecarName
      readonly delayMs: number
    }

// ---------------------------------------------------------------------------
// Auto-update types
// ---------------------------------------------------------------------------

/** Architecture of the Electron/Node.js process or the host CPU. */
export type DesktopRuntimeArch = 'arm64' | 'x64' | 'other'

/** Runtime architecture information for the current Electron process. */
export interface DesktopRuntimeInfo {
  readonly appArch: DesktopRuntimeArch
  readonly hostArch: DesktopRuntimeArch
  readonly runningUnderArm64Translation: boolean
}

/**
 * Status of the auto-update system.
 *
 * - `disabled`    — auto-updates not available (dev build, env-disabled)
 * - `idle`        — enabled but no check has run yet
 * - `checking`    — check in progress
 * - `up-to-date`  — check completed, no update available
 * - `available`   — new version found, ready to download
 * - `downloading` — download in progress
 * - `downloaded`  — download complete, ready to install
 * - `error`       — something failed (see `errorContext`)
 */
export type DesktopUpdateStatus =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error'

/** Full state of the auto-update system, broadcast to the renderer. */
export interface DesktopUpdateState {
  readonly appArch: DesktopRuntimeArch
  readonly availableVersion: string | null
  readonly canRetry: boolean
  readonly checkedAt: string | null
  readonly currentVersion: string
  readonly downloadedVersion: string | null
  readonly downloadPercent: number | null
  readonly enabled: boolean
  readonly errorContext: 'check' | 'download' | 'install' | null
  readonly hostArch: DesktopRuntimeArch
  readonly message: string | null
  readonly runningUnderArm64Translation: boolean
  readonly status: DesktopUpdateStatus
}

/** Result of a user-initiated update action (download or install). */
export interface DesktopUpdateActionResult {
  readonly accepted: boolean
  readonly completed: boolean
  readonly state: DesktopUpdateState
}

// ---------------------------------------------------------------------------
// App quit types
// ---------------------------------------------------------------------------

/**
 * Reason the app is shutting down, sent to renderers via `onBeforeQuit`.
 *
 * - `quit`   — user explicitly quit the app (Cmd+Q, tray Quit, app.quit())
 * - `reload` — the window is being reloaded (not a full app quit)
 */
export type QuitReason = 'quit' | 'reload'

/**
 * Payload sent from the main process to the renderer participating in quit
 * negotiation. The renderer must call `respondToQuit` with `veto: true` to
 * block the quit or `veto: false` to allow it.
 */
export interface BeforeQuitPayload {
  /** Unique ID for this quit request, used to correlate the response. */
  readonly id: string
  /** Why the app is shutting down. */
  readonly reason: QuitReason
}

// ---------------------------------------------------------------------------
// Agent notification types
// ---------------------------------------------------------------------------

/**
 * Payload for a desktop notification triggered by agent status transitions.
 * The renderer sends this to the main process via IPC; clicking the resulting
 * OS notification sends `workspaceId` back so the renderer can focus the pane.
 */
export interface AgentNotificationPayload {
  /** Notification body text (e.g., "Claude is waiting for input"). */
  readonly body: string
  /** Notification title (e.g., workspace branch name). */
  readonly title: string
  /** Workspace that triggered the notification — used to focus the right pane on click. */
  readonly workspaceId: string
}

// ---------------------------------------------------------------------------
// DesktopBridge interface
// ---------------------------------------------------------------------------

/**
 * Typed contract between the Electron preload script and the renderer.
 *
 * The preload script implements this interface via `contextBridge.exposeInMainWorld()`,
 * and the renderer accesses it via `window.desktopBridge`. When running outside
 * Electron (e.g., in a plain browser for development), `window.desktopBridge` is
 * undefined and the renderer falls back to browser-native equivalents.
 */
export interface DesktopBridge {
  /** Shows a native confirmation dialog with Yes/No buttons. Returns true if confirmed. */
  confirm: (message: string) => Promise<boolean>

  /** Triggers download of an available update. */
  downloadUpdate: () => Promise<DesktopUpdateActionResult>

  /**
   * Checks if a workspace is already visible in another window.
   * If so, focuses that window, tells the target renderer to activate
   * the workspace's pane, and returns true. If not, returns false so
   * the caller can proceed with opening the workspace in the current window.
   *
   * Returns false when the workspace is only in the requesting window
   * or is not open in any window.
   */
  focusWindowForWorkspace: (workspaceId: string) => Promise<boolean>

  /** Returns the server backend WebSocket URL for desktop RPC clients. */
  getBackendWsUrl: () => string | null

  /**
   * Returns the current status of all sidecar services.
   * Used on mount to catch up on statuses that were broadcast before the
   * window was created or ready to receive IPC events.
   */
  getSidecarStatuses: () => Promise<SidecarStatusEvent[]>

  /** Returns the current auto-update state. */
  getUpdateState: () => Promise<DesktopUpdateState>

  /** Returns the stable identity of the current native window. */
  getWindowId: () => string

  /** Triggers quit-and-install of a downloaded update. */
  installUpdate: () => Promise<DesktopUpdateActionResult>
  /**
   * Low-level MessagePort relay following VS Code's pattern.
   *
   * `acquire(responseChannel, nonce)` installs a one-shot `ipcRenderer`
   * listener on `responseChannel`. When the main process responds with a
   * MessagePort in the IPC event's `ports` array, the preload relays it
   * to the renderer world via `window.postMessage(nonce, '*', e.ports)`.
   *
   * The renderer must listen on `window` for a `message` event with
   * `event.data === nonce` to receive the actual `MessagePort` in
   * `event.ports[0]`.
   *
   * This is necessary because `contextBridge` uses structured clone which
   * cannot transfer `MessagePort` objects. The `window.postMessage` transfer
   * mechanism bypasses the context isolation boundary.
   *
   * @see VS Code's `ipcMessagePort.acquire()` in
   *   `.reference/vscode/src/vs/base/parts/sandbox/electron-browser/preload.ts`
   */
  ipcMessagePort: {
    acquire: (responseChannel: string, nonce: string) => void
  }

  /**
   * Send an IPC message to the main process (fire-and-forget).
   * Wraps `ipcRenderer.send(channel, ...args)`.
   */
  ipcSend: (channel: string, ...args: unknown[]) => void

  /**
   * Subscribes to workspace activation events from the main process.
   * Fired when another window's `focusWindowForWorkspace` call determined
   * this window owns the target workspace. The callback receives the
   * `workspaceId` so the renderer can focus the appropriate pane.
   * Returns an unsubscribe function.
   */
  onActivateWorkspace: (listener: (workspaceId: string) => void) => () => void

  /**
   * Subscribes to quit requests from the main process.
   *
   * When the main process wants to quit, it sends a `BeforeQuitPayload` to
   * every renderer window. The renderer MUST call `respondToQuit` with the
   * payload's `id` and a `veto` flag. If any window vetoes, the quit is
   * cancelled.
   *
   * Use this to:
   * - Flush pending LiveStore state
   * - Prompt the user about running terminals/tasks
   * - Clean up subscriptions and resources
   *
   * Returns an unsubscribe function.
   */
  onBeforeQuit: (listener: (payload: BeforeQuitPayload) => void) => () => void

  /**
   * Subscribes to GitHub OAuth callback events.
   * Fired when the OS routes an `x-github-desktop-dev-auth://oauth?code=...&state=...`
   * URL to the app. The callback receives the full URL string.
   * Returns an unsubscribe function.
   */
  onGithubOAuthCallback: (listener: (url: string) => void) => () => void

  /**
   * Subscribes to application menu actions (e.g., "settings").
   * Returns an unsubscribe function.
   */
  onMenuAction: (listener: (action: string) => void) => () => void

  /**
   * Subscribes to notification click events.
   * Fired when the user clicks an OS notification created by `sendNotification`.
   * The callback receives the `workspaceId` so the renderer can focus that pane.
   * Returns an unsubscribe function.
   */
  onNotificationClicked: (listener: (workspaceId: string) => void) => () => void

  /**
   * Subscribes to sidecar status change events.
   * Returns an unsubscribe function.
   */
  onSidecarStatus: (
    listener: (status: SidecarStatusEvent) => void
  ) => () => void

  /**
   * Subscribes to auto-update state changes.
   * Returns an unsubscribe function.
   */
  onUpdateState: (listener: (state: DesktopUpdateState) => void) => () => void

  /** Opens a URL in the user's default browser. Returns true on success. */
  openExternal: (url: string) => Promise<boolean>

  /** Opens a native macOS folder picker dialog. Returns the selected path, or null if cancelled. */
  pickFolder: () => Promise<string | null>

  /**
   * Reports the workspace IDs currently visible in this window's panel layout.
   * The main process uses this to route notification clicks and other
   * workspace-targeting actions to the correct window.
   */
  reportVisibleWorkspaces: (
    workspaceIds: readonly string[],
    focused?: boolean
  ) => Promise<void>

  /**
   * Responds to a quit request from the main process.
   *
   * @param id    — The `id` from the `BeforeQuitPayload` this is responding to.
   * @param veto  — `true` to block the quit, `false` to allow it to proceed.
   */
  respondToQuit: (id: string, veto: boolean) => void

  /** Manually restarts a sidecar service by name. */
  restartSidecar: (name: SidecarName) => Promise<void>

  /**
   * Sends a native OS notification for an agent status change.
   * The main process creates an Electron `Notification`; clicking it
   * fires the `onNotificationClicked` listener with the workspace ID.
   */
  sendNotification: (payload: AgentNotificationPayload) => Promise<void>

  /**
   * Shows a native context menu at the cursor or specified position.
   * Returns the `id` of the selected item, or null if dismissed.
   */
  showContextMenu: <T extends string>(
    items: readonly ContextMenuItem<T>[],
    position?: { x: number; y: number }
  ) => Promise<T | null>

  /**
   * Opens the GitHub OAuth authorization page in the user's browser.
   * The state parameter is a CSRF token the caller generates and validates
   * when the callback arrives.
   */
  startGithubOAuth: (state: string) => Promise<void>

  /** Updates the system tray tooltip with the current workspace count. */
  updateTrayWorkspaceCount: (count: number) => Promise<void>
}
