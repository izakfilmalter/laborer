import { join } from 'node:path'

import {
  app,
  type BrowserWindow,
  globalShortcut,
  Menu,
  type MenuItemConstructorOptions,
  nativeImage,
  Tray,
} from 'electron'

// ---------------------------------------------------------------------------
// Tooltip formatting
// ---------------------------------------------------------------------------

/**
 * Build the tray tooltip string based on the workspace count.
 * Matches the format from the previous Tauri implementation:
 * - 0: "Laborer — No running workspaces"
 * - 1: "Laborer — 1 running workspace"
 * - N: "Laborer — N running workspaces"
 */
export function formatTrayTooltip(count: number): string {
  if (count === 0) {
    return 'Laborer — No running workspaces'
  }
  if (count === 1) {
    return 'Laborer — 1 running workspace'
  }
  return `Laborer — ${count} running workspaces`
}

// ---------------------------------------------------------------------------
// Tray manager
// ---------------------------------------------------------------------------

/**
 * Manages the system tray icon, tooltip, and context menu.
 *
 * On macOS, the tray icon uses a template image so it automatically
 * adapts to the menu bar's dark/light mode.
 *
 * Context menu items:
 * - "Show Laborer" — focuses/shows the main window
 * - "Quit" — terminates the app (including child processes)
 *
 * Left-clicking the tray icon also focuses the main window.
 */
export class TrayManager {
  private tray: Tray | null = null
  private workspaceCount = 0

  /**
   * Create and display the system tray icon.
   * Should be called once during app bootstrap (after `app.whenReady()`).
   *
   * @param getMainWindow — callback that returns the current main window
   *   (or null if it was closed). Using a callback avoids holding a stale
   *   reference if the window is recreated.
   */
  create(getMainWindow: () => BrowserWindow | null): void {
    if (this.tray) {
      return
    }

    const icon = this.loadTrayIcon()
    this.tray = new Tray(icon)

    // Set initial tooltip.
    this.tray.setToolTip(formatTrayTooltip(this.workspaceCount))

    // Build the context menu.
    this.rebuildContextMenu(getMainWindow)

    // Left-click on macOS: focus/show the main window.
    this.tray.on('click', () => {
      focusMainWindow(getMainWindow())
    })
  }

  /**
   * Update the tray tooltip to reflect the current workspace count.
   * Called from the renderer via IPC (`updateTrayWorkspaceCount`).
   */
  updateWorkspaceCount(count: number): void {
    this.workspaceCount = count
    this.tray?.setToolTip(formatTrayTooltip(count))
  }

  /** Destroy the tray icon. Called during shutdown. */
  destroy(): void {
    this.tray?.destroy()
    this.tray = null
  }

  /** Whether the tray icon is currently visible. */
  get isCreated(): boolean {
    return this.tray !== null
  }

  /**
   * Load the tray icon as a native image.
   *
   * On macOS, uses a template image (`trayIconTemplate.png` / `@2x`)
   * which automatically adapts to the menu bar's dark/light appearance.
   * On other platforms, falls back to the regular app icon.
   */
  private loadTrayIcon(): Electron.NativeImage {
    const resourcesDir = join(import.meta.dirname, '..', 'resources')

    if (process.platform === 'darwin') {
      // Electron resolves `trayIconTemplate.png` + `trayIconTemplate@2x.png`
      // automatically when the base name contains "Template".
      const templatePath = join(resourcesDir, 'trayIconTemplate.png')
      const image = nativeImage.createFromPath(templatePath)
      image.setTemplateImage(true)
      return image
    }

    // Non-macOS: use the full-color app icon.
    return nativeImage.createFromPath(join(resourcesDir, 'icon.png'))
  }

  /**
   * Build and set the tray context menu.
   */
  private rebuildContextMenu(getMainWindow: () => BrowserWindow | null): void {
    const template: MenuItemConstructorOptions[] = [
      {
        label: 'Show Laborer',
        click: () => {
          focusMainWindow(getMainWindow())
        },
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          // Setting this ensures the close-to-tray logic does NOT
          // intercept the quit — the `before-quit` handler in main.ts
          // sets the `isQuitting` flag. `app.quit()` triggers it.
          app.quit()
        },
      },
    ]

    this.tray?.setContextMenu(Menu.buildFromTemplate(template))
  }
}

// ---------------------------------------------------------------------------
// Global shortcut
// ---------------------------------------------------------------------------

/**
 * Register the global shortcut `Cmd+Shift+L` (macOS) / `Ctrl+Shift+L`
 * (other platforms) that brings the Laborer window to the foreground from
 * any application.
 *
 * @param getMainWindow — callback returning the current main window.
 * @returns A cleanup function that unregisters the shortcut.
 */
export function registerGlobalShortcut(
  getMainWindow: () => BrowserWindow | null
): () => void {
  const accelerator = 'CommandOrControl+Shift+L'

  const registered = globalShortcut.register(accelerator, () => {
    focusMainWindow(getMainWindow())
  })

  if (!registered) {
    console.warn(
      `[tray] Failed to register global shortcut ${accelerator} — ` +
        'it may be registered by another application.'
    )
  }

  return () => {
    globalShortcut.unregister(accelerator)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Show, unminimize, and focus the main window.
 * Shared by the tray click handler, "Show Laborer" menu item, and global shortcut.
 */
function focusMainWindow(window: BrowserWindow | null): void {
  if (!window) {
    return
  }
  // If the window is minimized, restore it first.
  if (window.isMinimized()) {
    window.restore()
  }
  // Show the window (in case it was hidden by close-to-tray).
  window.show()
  // Bring to front and give focus.
  window.focus()
}
