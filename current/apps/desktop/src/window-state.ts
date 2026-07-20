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

/** Persisted window record keyed by a stable Laborer window identity. */
export interface WindowRecord extends WindowState {
  /** Stable application-level identity for the native window. */
  windowId: string
}

interface WindowRecordCollection {
  windows: WindowRecord[]
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
    return parseWindowStateValue(JSON.parse(raw) as unknown)
  } catch {
    return null
  }
}

/**
 * Parse a raw JSON string into persisted window records.
 *
 * When `legacyWindowId` is provided, older single-window payloads are upgraded
 * into a one-record collection so existing saved bounds remain restorable.
 */
export function parseWindowRecords(
  raw: string,
  legacyWindowId?: string
): WindowRecord[] | null {
  try {
    const data = JSON.parse(raw) as unknown

    const legacyRecord =
      legacyWindowId === undefined
        ? null
        : parseLegacyWindowRecord(data, legacyWindowId)

    if (legacyRecord) {
      return [legacyRecord]
    }

    if (typeof data !== 'object' || data === null) {
      return null
    }

    const obj = data as Record<string, unknown>
    if (!Array.isArray(obj.windows)) {
      return null
    }

    const windows: WindowRecord[] = []

    for (const entry of obj.windows) {
      const parsedRecord = parseWindowRecordValue(entry)

      if (!parsedRecord) {
        return null
      }

      windows.push(parsedRecord)
    }

    return windows
  } catch {
    return null
  }
}

/** Build the on-disk payload for persisted window records. */
export function serializeWindowRecords(
  records: readonly WindowRecord[]
): WindowRecordCollection {
  return {
    windows: [...records],
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
 */
export class WindowStateManager {
  private readonly filePath: string

  constructor(userDataDir?: string) {
    const dir = userDataDir ?? app.getPath('userData')
    this.filePath = join(dir, STATE_FILE_NAME)
  }

  /**
   * Load the first persisted window state from disk.
   *
   * This remains as a compatibility helper for the current single-window boot
   * path until the full multi-window restore flow lands.
   */
  load(): WindowState {
    const savedWindow = this.loadWindowRecords()[0]

    if (savedWindow) {
      return {
        bounds: savedWindow.bounds,
        isMaximized: savedWindow.isMaximized,
      }
    }

    return this.defaultState()
  }

  /**
   * Load all persisted window records from disk, repairing off-screen bounds
   * to a safe default while preserving each window's stable identity.
   */
  loadWindowRecords(): WindowRecord[] {
    try {
      if (!existsSync(this.filePath)) {
        return []
      }

      const raw = readFileSync(this.filePath, 'utf-8')
      const records = parseWindowRecords(raw, crypto.randomUUID())

      if (!records || records.length === 0) {
        return []
      }

      const displays = screen.getAllDisplays()
      return records.map((record) => this.repairWindowRecord(record, displays))
    } catch {
      return []
    }
  }

  /**
   * Save the current window state to disk.
   *
   * This remains as a compatibility helper for callers that still think in
   * terms of one restored window.
   */
  save(state: WindowState): void {
    const existingWindowId =
      this.loadWindowRecords()[0]?.windowId ?? crypto.randomUUID()

    this.saveWindowRecords([
      {
        windowId: existingWindowId,
        bounds: state.bounds,
        isMaximized: state.isMaximized,
      },
    ])
  }

  /** Save the full persisted window record collection to disk. */
  saveWindowRecords(records: readonly WindowRecord[]): void {
    try {
      const dir = join(this.filePath, '..')
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }

      writeFileSync(
        this.filePath,
        JSON.stringify(serializeWindowRecords(records), null, 2),
        'utf-8'
      )
    } catch (error) {
      console.error('[window-state] Failed to save window state:', error)
    }
  }

  /**
   * Attach event listeners to the window that automatically save window-record
   * metadata on move/resize and on close.
   */
  track(window: Electron.BrowserWindow, windowId: string): void {
    let saveTimeout: ReturnType<typeof setTimeout> | null = null

    const saveWindowRecord = () => {
      this.upsertWindowRecord({
        windowId,
        bounds: window.getNormalBounds(),
        isMaximized: window.isMaximized(),
      })
    }

    const debouncedSave = () => {
      if (saveTimeout) {
        clearTimeout(saveTimeout)
      }
      saveTimeout = setTimeout(() => {
        if (window.isDestroyed()) {
          return
        }
        saveWindowRecord()
      }, 500)
    }

    saveWindowRecord()

    window.on('resize', debouncedSave)
    window.on('move', debouncedSave)

    window.on('close', () => {
      // Clear any pending debounced save and do a final immediate save.
      if (saveTimeout) {
        clearTimeout(saveTimeout)
      }
      if (!window.isDestroyed()) {
        saveWindowRecord()
      }
    })
  }

  /** Build the default state centered on the primary display. */
  private defaultState(): WindowState {
    return defaultWindowState(screen.getPrimaryDisplay().workArea)
  }

  private repairWindowRecord(
    record: WindowRecord,
    displays: ReadonlyArray<{ workArea: Rectangle }>
  ): WindowRecord {
    if (isBoundsOnScreen(record.bounds, displays)) {
      return record
    }

    return {
      windowId: record.windowId,
      ...this.defaultState(),
    }
  }

  /** Remove a window record from the persisted collection (e.g. when the user closes a window). */
  removeWindowRecord(windowId: string): void {
    const records = this.loadWindowRecords().filter(
      (record) => record.windowId !== windowId
    )
    this.saveWindowRecords(records)
  }

  private upsertWindowRecord(nextRecord: WindowRecord): void {
    const records = this.loadWindowRecords().filter(
      (record) => record.windowId !== nextRecord.windowId
    )

    records.push(nextRecord)
    this.saveWindowRecords(records)
  }
}

function parseWindowStateValue(data: unknown): WindowState | null {
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
    isMaximized: typeof obj.isMaximized === 'boolean' ? obj.isMaximized : false,
  }
}

function parseWindowRecordValue(data: unknown): WindowRecord | null {
  if (typeof data !== 'object' || data === null) {
    return null
  }

  const obj = data as Record<string, unknown>
  if (typeof obj.windowId !== 'string' || obj.windowId.length === 0) {
    return null
  }

  const state = parseWindowStateValue(data)
  if (!state) {
    return null
  }

  return {
    windowId: obj.windowId,
    ...state,
  }
}

function parseLegacyWindowRecord(
  data: unknown,
  windowId: string
): WindowRecord | null {
  const state = parseWindowStateValue(data)

  if (!state) {
    return null
  }

  return {
    windowId,
    ...state,
  }
}
