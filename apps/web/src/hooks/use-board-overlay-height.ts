import { useLiveQuery } from '@tanstack/react-db'
import { useCallback } from 'react'
import {
  boardOverlayHeightCollection,
  setSingletonPreference,
} from '@/db/local-preferences'

/** Minimum overlay height as a fraction of the main content area. */
const MIN_FRACTION = 0.2
/** Maximum overlay height — fully covering the main content area. */
const MAX_FRACTION = 1
/** Default overlay height when nothing is stored. */
const DEFAULT_FRACTION = 0.7

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
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
 * Mirrors the `useSidebarWidth` the local preference collection pattern.
 */
function useBoardOverlayHeight(): BoardOverlayHeightState {
  const { data } = useLiveQuery((query) =>
    query.from({ boardHeight: boardOverlayHeightCollection })
  )
  const fraction = clamp(
    data[0]?.value ?? DEFAULT_FRACTION,
    MIN_FRACTION,
    MAX_FRACTION
  )

  const setFraction = useCallback((nextFraction: number) => {
    const clamped = clamp(nextFraction, MIN_FRACTION, MAX_FRACTION)
    setSingletonPreference(boardOverlayHeightCollection, clamped)
  }, [])

  return { fraction, setFraction }
}

export { useBoardOverlayHeight }
