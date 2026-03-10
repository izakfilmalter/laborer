import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { app, type Rectangle, screen } from 'electron'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Persisted window state on disk. */
export interface WindowState {
  /** Window bounds (x, y, width, height). */
  bounds: Rectangle
  /** Whether the window was maximized when last closed. */
  isMaximized: boolean
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default window dimensions for first launch. */
export const DEFAULT_WIDTH = 800
export const DEFAULT_HEIGHT = 600
const STATE_FILE_NAME = 'window-state.json'

// ---------------------------------------------------------------------------
// Pure functions (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Parse a raw JSON string into a valid `WindowState`, or return `null`
 * if the data is malformed.
 */
export function parseWindowState(raw: string): WindowState | null {
  try {
    const data = JSON.parse(raw) as unknown

    if (typeof data !== 'object' || data === null) {
      return null
    }

    const obj = data as Record<string, unknown>
    const bounds = obj.bounds as Record<string, unknown> | undefined

    if (typeof bounds !== 'object' || bounds === null) {
      return null
    }

    const x = bounds.x
    const y = bounds.y
    const width = bounds.width
    const height = bounds.height

    if (
      typeof x !== 'number' ||
      typeof y !== 'number' ||
      typeof width !== 'number' ||
      typeof height !== 'number'
    ) {
      return null
    }

    if (
      !(
        Number.isFinite(x) &&
        Number.isFinite(y) &&
        Number.isFinite(width) &&
        Number.isFinite(height)
      )
    ) {
      return null
    }

    if (width <= 0 || height <= 0) {
      return null
    }

    return {
      bounds: {
        x: Math.floor(x),
        y: Math.floor(y),
        width: Math.floor(width),
        height: Math.floor(height),
      },
      isMaximized:
        typeof obj.isMaximized === 'boolean' ? obj.isMaximized : false,
    }
  } catch {
    return null
  }
}

/**
 * Check whether the given bounds are visible on at least one of the
 * provided displays. A window is considered visible if at least 100px
 * of its width and 50px of its height overlap a display's work area.
 *
 * @param bounds — the window bounds to check
 * @param displays — the list of available displays (from `screen.getAllDisplays()`)
 * @returns `true` if the window overlaps at least one display
 */
export function isBoundsOnScreen(
  bounds: Rectangle,
  displays: ReadonlyArray<{ workArea: Rectangle }>
): boolean {
  const MIN_VISIBLE_WIDTH = 100
  const MIN_VISIBLE_HEIGHT = 50

  for (const display of displays) {
    const wa = display.workArea

    // Calculate overlap in each dimension.
    const overlapX = Math.max(
      0,
      Math.min(bounds.x + bounds.width, wa.x + wa.width) -
        Math.max(bounds.x, wa.x)
    )
    const overlapY = Math.max(
      0,
      Math.min(bounds.y + bounds.height, wa.y + wa.height) -
        Math.max(bounds.y, wa.y)
    )

    if (overlapX >= MIN_VISIBLE_WIDTH && overlapY >= MIN_VISIBLE_HEIGHT) {
      return true
    }
  }

  return false
}

/**
 * Build the default window state centered on the primary display.
 *
 * @param primaryWorkArea — the primary display's work area (from `screen.getPrimaryDisplay().workArea`)
 */
export function defaultWindowState(primaryWorkArea: Rectangle): WindowState {
  const width = DEFAULT_WIDTH
  const height = DEFAULT_HEIGHT
  const x = Math.floor(primaryWorkArea.x + (primaryWorkArea.width - width) / 2)
  const y = Math.floor(
    primaryWorkArea.y + (primaryWorkArea.height - height) / 2
  )

  return {
    bounds: { x, y, width, height },
    isMaximized: false,
  }
}

// ---------------------------------------------------------------------------
// WindowStateManager — stateful, uses Electron APIs
// ---------------------------------------------------------------------------

/**
 * Manages persisting and restoring window bounds across app restarts.
 *
 * State is stored as a JSON file in the Electron `userData` directory.
 *
 * Usage:
 * ```ts
 * const wsm = new WindowStateManager()
 * const state = wsm.load()
 * const win = new BrowserWindow({ ...state.bounds })
 * if (state.isMaximized) win.maximize()
 * wsm.track(win)
 * ```
 */
export class WindowStateManager {
  private readonly filePath: string

  constructor(userDataDir?: string) {
    const dir = userDataDir ?? app.getPath('userData')
    this.filePath = join(dir, STATE_FILE_NAME)
  }

  /**
   * Load the persisted window state from disk, validating that the
   * saved bounds are still visible on a connected display.
   *
   * If the file is missing, corrupt, or the bounds are off-screen
   * (e.g., an external monitor was disconnected), returns the default
   * state centered on the primary display.
   */
  load(): WindowState {
    try {
      if (!existsSync(this.filePath)) {
        return this.defaultState()
      }

      const raw = readFileSync(this.filePath, 'utf-8')
      const state = parseWindowState(raw)

      if (!state) {
        return this.defaultState()
      }

      // Verify the saved bounds are still visible on at least one display.
      const displays = screen.getAllDisplays()
      if (!isBoundsOnScreen(state.bounds, displays)) {
        return this.defaultState()
      }

      return state
    } catch {
      return this.defaultState()
    }
  }

  /**
   * Save the current window state to disk.
   *
   * @param state — the window state to persist
   */
  save(state: WindowState): void {
    try {
      const dir = join(this.filePath, '..')
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }

      writeFileSync(this.filePath, JSON.stringify(state, null, 2), 'utf-8')
    } catch (error) {
      console.error('[window-state] Failed to save window state:', error)
    }
  }

  /**
   * Attach event listeners to the window that automatically save
   * bounds on move/resize and save final state on close.
   *
   * This is the primary API — call once after creating the window.
   */
  track(window: Electron.BrowserWindow): void {
    let saveTimeout: ReturnType<typeof setTimeout> | null = null

    const debouncedSave = () => {
      if (saveTimeout) {
        clearTimeout(saveTimeout)
      }
      saveTimeout = setTimeout(() => {
        if (window.isDestroyed()) {
          return
        }
        this.save({
          bounds: window.getNormalBounds(),
          isMaximized: window.isMaximized(),
        })
      }, 500)
    }

    window.on('resize', debouncedSave)
    window.on('move', debouncedSave)

    window.on('close', () => {
      // Clear any pending debounced save and do a final immediate save.
      if (saveTimeout) {
        clearTimeout(saveTimeout)
      }
      if (!window.isDestroyed()) {
        this.save({
          bounds: window.getNormalBounds(),
          isMaximized: window.isMaximized(),
        })
      }
    })
  }

  /** Build the default state centered on the primary display. */
  private defaultState(): WindowState {
    return defaultWindowState(screen.getPrimaryDisplay().workArea)
  }
}
