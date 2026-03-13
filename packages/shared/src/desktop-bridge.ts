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
export type SidecarName =
  | 'server'
  | 'terminal'
  | 'file-watcher'
  | 'mcp'
  | 'ghostty'

/**
 * Sidecar status reported to the renderer.
 *
 * - `starting`    — sidecar spawned, waiting for health check
 * - `healthy`     — health check passed, service is reachable
 * - `crashed`     — process exited unexpectedly (includes stderr excerpt)
 * - `restarting`  — automatic restart scheduled, waiting for backoff delay
 */
export type SidecarStatusEvent =
  | { readonly state: 'starting'; readonly name: SidecarName }
  | { readonly state: 'healthy'; readonly name: SidecarName }
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
/** Options for creating a Ghostty terminal surface. */
export interface GhosttyCreateSurfaceOptions {
  readonly command?: string | undefined
  readonly height?: number | undefined
  readonly width?: number | undefined
  readonly workingDirectory?: string | undefined
}

/**
 * Key event payload for Ghostty surface input.
 * Matches the ghostty_input_key_s struct from the Ghostty C API.
 *
 * Action: 0 = release, 1 = press, 2 = repeat.
 * Mods: bitmask of SHIFT(1), CTRL(2), ALT(4), SUPER(8), etc.
 * Keycode: ghostty_input_key_e enum value (W3C UIEvents code mapping).
 */
export interface GhosttyKeyEvent {
  /** 0 = release, 1 = press, 2 = repeat. */
  readonly action: number
  /** Whether this is part of an IME compose sequence. */
  readonly composing: boolean
  /** Ghostty key code (ghostty_input_key_e enum value). */
  readonly keycode: number
  /** Modifier bitmask (ghostty_input_mods_e flags OR'd together). */
  readonly mods: number
  /** UTF-8 text produced by the key, or null. */
  readonly text: string | null
  /** Codepoint of the key without shift modifier applied. */
  readonly unshiftedCodepoint: number
}

/**
 * Mouse button event payload for Ghostty surface input.
 * Matches the ghostty_surface_mouse_button parameters from the Ghostty C API.
 *
 * State: 0 = release, 1 = press.
 * Button: 0 = unknown, 1 = left, 2 = right, 3 = middle, 4-11 = extra.
 * Mods: bitmask of SHIFT(1), CTRL(2), ALT(4), SUPER(8), etc.
 */
export interface GhosttyMouseButtonEvent {
  /** Ghostty mouse button (ghostty_input_mouse_button_e value). */
  readonly button: number
  /** Modifier bitmask. */
  readonly mods: number
  /** 0 = release, 1 = press. */
  readonly state: number
}

/**
 * Mouse position event payload for Ghostty surface input.
 * Coordinates are in pixels relative to the surface origin.
 */
export interface GhosttyMousePosEvent {
  /** Modifier bitmask. */
  readonly mods: number
  /** X position in pixels. */
  readonly x: number
  /** Y position in pixels. */
  readonly y: number
}

/**
 * Mouse scroll event payload for Ghostty surface input.
 */
export interface GhosttyMouseScrollEvent {
  /** Horizontal scroll delta. */
  readonly dx: number
  /** Vertical scroll delta. */
  readonly dy: number
  /**
   * Packed scroll modifiers (ghostty_input_scroll_mods_t).
   * Pass 0 for standard wheel events.
   */
  readonly scrollMods: number
}

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

  /** Returns the HTTP base URL for the server service (e.g., "http://127.0.0.1:12345"). */
  getServerUrl: () => string

  /** Returns the HTTP base URL for the terminal service (e.g., "http://127.0.0.1:12346"). */
  getTerminalUrl: () => string

  /** Returns the current auto-update state. */
  getUpdateState: () => Promise<DesktopUpdateState>

  /** Returns the stable identity of the current native window. */
  getWindowId: () => string

  /**
   * Create a new Ghostty terminal surface in the host process.
   * Returns the numeric surface ID assigned by the native runtime.
   */
  ghosttyCreateSurface: (
    options?: GhosttyCreateSurfaceOptions
  ) => Promise<number>

  /**
   * Destroy a Ghostty terminal surface by its ID.
   * Frees native resources in the host process.
   */
  ghosttyDestroySurface: (surfaceId: number) => Promise<void>

  /**
   * Read the current pixel data from a Ghostty surface.
   * Returns null if the surface has no rendered content yet.
   * The pixels are BGRA-format base64-encoded data.
   */
  ghosttyGetPixels: (surfaceId: number) => Promise<{
    readonly height: number
    readonly pixels: string
    readonly width: number
  } | null>

  /**
   * List all active Ghostty surface IDs in the host process.
   */
  ghosttyListSurfaces: () => Promise<readonly number[]>

  /**
   * Check whether a Ghostty surface has captured the mouse.
   * When captured, mouse events should be forwarded to the terminal.
   */
  ghosttyMouseCaptured: (surfaceId: number) => Promise<boolean>

  /**
   * Send a key event to a Ghostty surface.
   */
  ghosttySendKey: (
    surfaceId: number,
    keyEvent: GhosttyKeyEvent
  ) => Promise<void>

  /**
   * Send a mouse button event to a Ghostty surface.
   */
  ghosttySendMouseButton: (
    surfaceId: number,
    mouseEvent: GhosttyMouseButtonEvent
  ) => Promise<void>

  /**
   * Send a mouse position update to a Ghostty surface.
   */
  ghosttySendMousePos: (
    surfaceId: number,
    mouseEvent: GhosttyMousePosEvent
  ) => Promise<void>

  /**
   * Send a mouse scroll event to a Ghostty surface.
   */
  ghosttySendMouseScroll: (
    surfaceId: number,
    mouseEvent: GhosttyMouseScrollEvent
  ) => Promise<void>

  /**
   * Send composed text input to a Ghostty surface.
   */
  ghosttySendText: (surfaceId: number, text: string) => Promise<void>

  /**
   * Set the focus state of a Ghostty surface.
   */
  ghosttySetFocus: (surfaceId: number, focused: boolean) => Promise<void>

  /**
   * Set the pixel size of a Ghostty surface.
   */
  ghosttySetSize: (
    surfaceId: number,
    width: number,
    height: number
  ) => Promise<void>

  /** Triggers quit-and-install of a downloaded update. */
  installUpdate: () => Promise<DesktopUpdateActionResult>

  /**
   * Subscribes to workspace activation events from the main process.
   * Fired when another window's `focusWindowForWorkspace` call determined
   * this window owns the target workspace. The callback receives the
   * `workspaceId` so the renderer can focus the appropriate pane.
   * Returns an unsubscribe function.
   */
  onActivateWorkspace: (listener: (workspaceId: string) => void) => () => void

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
  reportVisibleWorkspaces: (workspaceIds: readonly string[]) => Promise<void>

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

  /** Updates the system tray tooltip with the current workspace count. */
  updateTrayWorkspaceCount: (count: number) => Promise<void>
}
