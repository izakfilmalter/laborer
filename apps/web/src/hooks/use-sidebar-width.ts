/**
 * Hook to persist the sidebar panel width to localStorage.
 *
 * Reads the stored width on mount and provides it as the `defaultSize`
 * for the sidebar ResizablePanel. Persists width changes via a debounced
 * write to avoid excessive localStorage writes during drag-resize.
 *
 * If no stored value exists, returns `undefined` so the caller can fall
 * back to the responsive default from `useResponsiveLayout`.
 *
 * Collapsing the sidebar (0% width) does not overwrite the stored value,
 * so restoring uses the last non-collapsed width.
 *
 * @see Issue #174: Persist sidebar width in localStorage
 */

import { useCallback, useEffect, useRef, useState } from 'react'

const STORAGE_KEY = 'laborer:sidebar-width'

/** Debounce delay for persisting width during drag resize (ms). */
const DEBOUNCE_MS = 200

/**
 * Read the persisted sidebar width (percentage) from localStorage.
 * Returns undefined if nothing is stored or the stored value is invalid.
 */
function readStoredWidth(): number | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return undefined
    }
    const parsed = Number.parseFloat(raw)
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Persist the sidebar width (percentage) to localStorage.
 */
function writeStoredWidth(percent: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(percent))
  } catch {
    // Silently ignore storage errors (e.g. quota exceeded)
  }
}

interface SidebarWidthState {
  /**
   * Call this from the ResizablePanel `onResize` callback.
   * Debounces writes to localStorage. Ignores collapsed (0%) values.
   */
  readonly handleResize: (sizePercent: number) => void
  /**
   * The stored sidebar width as a percentage string (e.g. "15%"),
   * or undefined if no stored value exists (use responsive default).
   */
  readonly storedDefault: string | undefined
}

/**
 * Hook to persist and restore the sidebar panel width.
 *
 * @param minPercent - Current minimum sidebar percentage (from responsive layout).
 *   Used to clamp the restored value to valid bounds when the viewport has changed
 *   between sessions.
 * @param maxPercent - Current maximum sidebar percentage (from responsive layout).
 */
function useSidebarWidth(
  minPercent: number,
  maxPercent: number
): SidebarWidthState {
  // Read from localStorage once on mount, clamped to current bounds.
  const [storedDefault] = useState<string | undefined>(() => {
    const stored = readStoredWidth()
    if (stored === undefined) {
      return undefined
    }
    // Clamp to current min/max bounds (viewport may have changed between sessions)
    const clamped = Math.min(Math.max(stored, minPercent), maxPercent)
    return `${clamped}%`
  })

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestRef = useRef<number | null>(null)

  const handleResize = useCallback((sizePercent: number) => {
    // Don't persist collapsed state (0%) — preserve the last non-collapsed width
    if (sizePercent <= 0) {
      return
    }

    latestRef.current = sizePercent

    // Debounce writes to localStorage during drag
    if (timerRef.current) {
      clearTimeout(timerRef.current)
    }
    timerRef.current = setTimeout(() => {
      if (latestRef.current !== null) {
        writeStoredWidth(latestRef.current)
      }
      timerRef.current = null
    }, DEBOUNCE_MS)
  }, [])

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        // Flush the latest value before unmounting
        if (latestRef.current !== null) {
          writeStoredWidth(latestRef.current)
        }
      }
    }
  }, [])

  return { storedDefault, handleResize }
}

export { useSidebarWidth }
