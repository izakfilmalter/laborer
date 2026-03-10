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
export type SidecarName = 'server' | 'terminal' | 'mcp'

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
  /** Returns the HTTP base URL for the server service (e.g., "http://127.0.0.1:12345"). */
  getServerUrl: () => string

  /** Returns the HTTP base URL for the terminal service (e.g., "http://127.0.0.1:12346"). */
  getTerminalUrl: () => string

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
