/**
 * Responsive layout hook for the panel system.
 *
 * Provides viewport-aware sizing values for the sidebar and panel system
 * to ensure the layout works well from 1080p to 5K displays.
 *
 * At 1080p (1920px):
 * - Sidebar: 360px min, 360px default, 90% max
 * - Pane minimum: ~100px (usable terminal with ~12 columns)
 *
 * At 1440p (2560px):
 * - Sidebar: 360px min, 360px default, 90% max
 *
 * At 4K (3840px):
 * - Sidebar: 360px min, 400px default, 90% max
 *
 * At 5K (5120px):
 * - Sidebar: 360px min, 440px default, 90% max
 *
 * Sidebar values are exposed as pixels so the sidebar does not scale when the
 * viewport width changes.
 *
 * @see Issue #81: Panel responsive layout
 */

import { useCallback, useEffect, useState } from 'react'

/** The minimum usable width for a terminal pane in pixels. */
const MIN_PANE_WIDTH_PX = 100

/** Sidebar sizing breakpoints (in viewport width pixels). */
const SIDEBAR_CONFIG = {
  /** Minimum sidebar width in pixels. */
  minPx: 360,
  /** Maximum sidebar width in pixels. */
  maxPx: 480,
  /** Default sidebar width in pixels. */
  defaultPx: 360,
  /** Additional pixels per 1000px of viewport width beyond 1920px. */
  scalePerKPx: 50,
} as const

interface ResponsiveLayoutSizes {
  /** Whether the viewport is narrow enough to support sidebar collapsing. */
  readonly canCollapseSidebar: boolean
  /** Minimum pane size as a percentage string (e.g., "5%"). */
  readonly paneMin: string
  /** Sidebar default size in pixels. */
  readonly sidebarDefaultPx: number
  /** Sidebar maximum size in pixels. */
  readonly sidebarMaxPx: number
  /** Sidebar minimum size in pixels. */
  readonly sidebarMinPx: number
  /** Current viewport width in pixels. */
  readonly viewportWidth: number
}

/**
 * Clamp a value between a minimum and maximum.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * Compute sidebar pixel values based on viewport width.
 * Sidebar grows slightly on larger displays to take advantage of space.
 */
function computeSidebarPx(viewportWidth: number): {
  defaultPx: number
  minPx: number
} {
  const extraKPx = Math.max(0, viewportWidth - 1920) / 1000
  const scale = extraKPx * SIDEBAR_CONFIG.scalePerKPx

  return {
    defaultPx: clamp(
      SIDEBAR_CONFIG.defaultPx + scale,
      SIDEBAR_CONFIG.minPx,
      SIDEBAR_CONFIG.maxPx
    ),
    minPx: SIDEBAR_CONFIG.minPx,
  }
}

/**
 * Returns responsive sizing values for the panel system based on the
 * current viewport width. Values update on window resize.
 *
 * Uses `matchMedia` listeners for efficiency rather than polling or
 * continuous resize event listeners.
 */
function useResponsiveLayout(): ResponsiveLayoutSizes {
  const computeSizes = useCallback((): ResponsiveLayoutSizes => {
    const vw = window.innerWidth
    const sidebar = computeSidebarPx(vw)

    // Minimum pane size: ensure at least MIN_PANE_WIDTH_PX, but cap at 15%
    // to prevent one pane from dominating in deeply nested splits.
    const paneMinPercent = clamp((MIN_PANE_WIDTH_PX / vw) * 100, 3, 15)

    return {
      sidebarDefaultPx: sidebar.defaultPx,
      sidebarMinPx: sidebar.minPx,
      sidebarMaxPx: Math.round(vw * 0.9),
      paneMin: `${Math.round(paneMinPercent)}%`,
      canCollapseSidebar: vw < 1280,
      viewportWidth: vw,
    }
  }, [])

  const [sizes, setSizes] = useState<ResponsiveLayoutSizes>(computeSizes)

  useEffect(() => {
    const handleResize = () => {
      setSizes(computeSizes())
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [computeSizes])

  return sizes
}

export { useResponsiveLayout, MIN_PANE_WIDTH_PX }
export type { ResponsiveLayoutSizes }
