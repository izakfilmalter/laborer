import { useCallback, useEffect, useRef, useState } from 'react'

const STORAGE_KEY = 'laborer:sidebar-width'

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}

function readStoredWidth(): number | undefined {
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

function writeStoredWidth(px: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(Math.round(px)))
  } catch {
    // Ignore storage failures; resizing should keep working for the session.
  }
}

interface SidebarWidthState {
  readonly maxPx: number
  readonly minPx: number
  readonly setWidthPx: (widthPx: number) => void
  readonly widthPx: number
}

function useSidebarWidth(
  minPx: number,
  maxPx: number,
  defaultPx: number
): SidebarWidthState {
  const preferredPxRef = useRef<number | null>(null)

  const [widthPx, setWidthPxState] = useState(() => {
    const stored = readStoredWidth() ?? defaultPx
    const initialWidth = clamp(stored, minPx, maxPx)
    preferredPxRef.current = initialWidth
    return initialWidth
  })

  const setWidthPx = useCallback(
    (nextWidthPx: number) => {
      const clampedWidth = clamp(nextWidthPx, minPx, maxPx)
      preferredPxRef.current = clampedWidth
      setWidthPxState(clampedWidth)
      writeStoredWidth(clampedWidth)
    },
    [maxPx, minPx]
  )

  useEffect(() => {
    const preferredWidth = preferredPxRef.current ?? defaultPx
    setWidthPxState(clamp(preferredWidth, minPx, maxPx))
  }, [defaultPx, maxPx, minPx])

  return {
    maxPx,
    minPx,
    setWidthPx,
    widthPx,
  }
}

export { useSidebarWidth }
