/**
 * Hook to persist the sidebar panel width to localStorage.
 *
 * Reads the stored pixel width on mount and provides it as the `defaultSize`
 * for the sidebar ResizablePanel. Persists width changes via a debounced
 * write to avoid excessive localStorage writes during drag-resize.
 *
 * If no stored value exists, uses the responsive default from
 * `useResponsiveLayout` as the initial pixel width.
 *
 * Collapsing the sidebar (0px width) does not overwrite the stored value,
 * so restoring uses the last non-collapsed width.
 *
 * @see Issue #174: Persist sidebar width in localStorage
 */

import { useCallback, useEffect, useRef, useState } from 'react'

const STORAGE_KEY = 'laborer:sidebar-width'

/** Debounce delay for persisting width during drag resize (ms). */
const DEBOUNCE_MS = 200

/**
 * Read the persisted sidebar width (pixels) from localStorage.
 * Returns undefined if nothing is stored or the stored value is invalid.
 */
function readStoredWidth(viewportWidth: number): number | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return undefined
    }
    const parsed = Number.parseFloat(raw)
    if (Number.isFinite(parsed) && parsed > 0) {
      if (parsed <= 100) {
        return (parsed / 100) * viewportWidth
      }
      return parsed
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Persist the sidebar width (pixels) to localStorage.
 */
function writeStoredWidth(px: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(Math.round(px)))
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
  /** Call after applying a viewport-driven resize. */
  readonly handleViewportResizeApplied: () => void
  /** Re-apply this percentage after viewport resizes to preserve pixel width. */
  readonly resizePercent: string | undefined
  /**
   * The stored sidebar width as a percentage string (e.g. "15%"),
   * falling back to the responsive default if no stored value exists.
   */
  readonly storedDefault: string
}

/**
 * Hook to persist and restore the sidebar panel width.
 *
 * @param minPercent - Current minimum sidebar percentage (from responsive layout).
 *   Used to clamp the restored value to valid bounds when the viewport has changed
 *   between sessions.
 * @param maxPercent - Current maximum sidebar percentage (from responsive layout).
 * @param defaultPercent - Current default sidebar percentage (from responsive layout).
 */
function useSidebarWidth(
  minPercent: number,
  maxPercent: number,
  defaultPercent: number
): SidebarWidthState {
  const viewportWidth = window.innerWidth
  const minPx = (minPercent / 100) * viewportWidth
  const maxPx = (maxPercent / 100) * viewportWidth
  const defaultPx = (defaultPercent / 100) * viewportWidth

  // Read from localStorage once on mount, clamped to current bounds.
  const [initialPreferredPx] = useState<number>(() => {
    const stored = readStoredWidth(viewportWidth)
    if (stored === undefined) {
      return defaultPx
    }
    // Clamp to current min/max bounds (viewport may have changed between sessions)
    return Math.min(Math.max(stored, minPx), maxPx)
  })

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const preferredPxRef = useRef(initialPreferredPx)
  const storedDefaultRef = useRef(
    `${(Math.min(Math.max(initialPreferredPx, minPx), maxPx) / viewportWidth) * 100}%`
  )
  const previousViewportWidthRef = useRef(viewportWidth)

  const handleResize = useCallback((sizePercent: number) => {
    if (window.innerWidth !== previousViewportWidthRef.current) {
      return
    }

    // Don't persist collapsed state (0%) — preserve the last non-collapsed width
    if (sizePercent <= 0) {
      return
    }

    const nextPx = (sizePercent / 100) * window.innerWidth
    preferredPxRef.current = nextPx

    // Debounce writes to localStorage during drag
    if (timerRef.current) {
      clearTimeout(timerRef.current)
    }
    timerRef.current = setTimeout(() => {
      writeStoredWidth(preferredPxRef.current)
      timerRef.current = null
    }, DEBOUNCE_MS)
  }, [])

  const handleViewportResizeApplied = useCallback(() => {
    previousViewportWidthRef.current = window.innerWidth
  }, [])

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        // Flush the latest value before unmounting
        writeStoredWidth(preferredPxRef.current)
      }
    }
  }, [])

  const clampedStoredPx = Math.min(
    Math.max(preferredPxRef.current, minPx),
    maxPx
  )
  const resizePercent =
    previousViewportWidthRef.current === viewportWidth
      ? undefined
      : `${(clampedStoredPx / viewportWidth) * 100}%`

  return {
    storedDefault: storedDefaultRef.current,
    resizePercent,
    handleResize,
    handleViewportResizeApplied,
  }
}

export { useSidebarWidth }
