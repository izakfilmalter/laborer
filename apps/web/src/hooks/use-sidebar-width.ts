import { useLiveQuery } from '@tanstack/react-db'
import { useCallback } from 'react'
import {
  setSidebarWidthPreference,
  sidebarWidthCollection,
} from '@/db/local-preferences'

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
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
  const { data } = useLiveQuery((query) =>
    query.from({ sidebarWidth: sidebarWidthCollection })
  )
  const storedWidth = data.find((row) => row.id === 'current')?.widthPx
  const preferredWidth =
    typeof storedWidth === 'number' && Number.isFinite(storedWidth)
      ? storedWidth
      : defaultPx
  const widthPx = clamp(preferredWidth, minPx, maxPx)

  const setWidthPx = useCallback(
    (nextWidthPx: number) => {
      const clampedWidth = clamp(nextWidthPx, minPx, maxPx)
      setSidebarWidthPreference(Math.round(clampedWidth))
    },
    [maxPx, minPx]
  )

  return {
    maxPx,
    minPx,
    setWidthPx,
    widthPx,
  }
}

export { useSidebarWidth }
