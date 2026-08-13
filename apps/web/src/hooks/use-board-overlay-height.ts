import { useCallback, useState } from 'react'

const STORAGE_KEY = 'laborer:board-overlay-height'

/** Minimum overlay height as a fraction of the main content area. */
const MIN_FRACTION = 0.2
/** Maximum overlay height — fully covering the main content area. */
const MAX_FRACTION = 1
/** Default overlay height when nothing is stored. */
const DEFAULT_FRACTION = 0.7

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}

function readStoredFraction(): number | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return undefined
    }

    const parsed = Number.parseFloat(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
  } catch {
    return undefined
  }
}

function writeStoredFraction(fraction: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(fraction))
  } catch {
    // Ignore storage failures; resizing should keep working for the session.
  }
}

interface BoardOverlayHeightState {
  /** Overlay height as a fraction (0–1) of the main content area. */
  readonly fraction: number
  /** Clamp, persist, and apply a new height fraction. */
  readonly setFraction: (fraction: number) => void
}

/**
 * Persisted height for the kanban board overlay, stored as a fraction of
 * the main content area so window resizes keep the same relative coverage.
 *
 * Mirrors the `useSidebarWidth` localStorage pattern.
 */
function useBoardOverlayHeight(): BoardOverlayHeightState {
  const [fraction, setFractionState] = useState(() =>
    clamp(readStoredFraction() ?? DEFAULT_FRACTION, MIN_FRACTION, MAX_FRACTION)
  )

  const setFraction = useCallback((nextFraction: number) => {
    const clamped = clamp(nextFraction, MIN_FRACTION, MAX_FRACTION)
    setFractionState(clamped)
    writeStoredFraction(clamped)
  }, [])

  return { fraction, setFraction }
}

export { useBoardOverlayHeight }
