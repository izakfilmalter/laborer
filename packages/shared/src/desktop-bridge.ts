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
export type SidecarName = 'server' | 'terminal' | 'file-watcher' | 'mcp'

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

  /** Returns the HTTP base URL for the server service (e.g., "http://127.0.0.1:12345"). */
  getServerUrl: () => string

  /** Returns the HTTP base URL for the terminal service (e.g., "http://127.0.0.1:12346"). */
  getTerminalUrl: () => string

  /** Returns the current auto-update state. */
  getUpdateState: () => Promise<DesktopUpdateState>

  /** Triggers quit-and-install of a downloaded update. */
  installUpdate: () => Promise<DesktopUpdateActionResult>

  /**
   * Subscribes to application menu actions (e.g., "settings").
   * Returns an unsubscribe function.
   */
  onMenuAction: (listener: (action: string) => void) => () => void

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

  /** Manually restarts a sidecar service by name. */
  restartSidecar: (name: SidecarName) => Promise<void>

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
