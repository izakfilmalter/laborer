/**
 * Shell for the window's right panel — ported from t3code's
 * `PreviewPanelShell`, inline mode only.
 *
 * The window hosts one panel: it is a flex sibling of the whole content
 * column (every workspace frame plus the fullscreen overlay) and is
 * user-resizable via a drag handle on the left edge. Width is a window-level
 * preference, so it persists under one key rather than per workspace. t3
 * also collapses the panel to a sheet under 980px viewport width; that is
 * deliberately skipped for now — the container clamp below keeps the panel
 * usable in narrow windows instead.
 */

import { cn } from '@laborer/ui/lib/utils'
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { useResizableWidth } from '@/hooks/use-resizable-width'
import { RightPanelResizeHandle } from './right-panel-resize-handle'

/** localStorage key for the window's persisted right-panel width. */
export const RIGHT_PANEL_WIDTH_STORAGE_KEY = 'laborer:right-panel-width'
const RIGHT_PANEL_MIN_WIDTH = 360
/**
 * Upper bound as a fraction of the viewport; only binds on wide screens.
 * On narrow frames the container clamp below is what preserves the
 * sibling column's space.
 */
const RIGHT_PANEL_MAX_WIDTH_FRACTION = 0.7
const RIGHT_PANEL_DEFAULT_WIDTH = 540
/**
 * Width reserved for the sibling column (the workspace frames) sharing the
 * panel's flex row. The viewport fraction alone is not enough: the sidebar
 * takes its own slice of the viewport, so the remaining 30% would leave the
 * sibling below its usable width.
 */
const SIBLING_COLUMN_MIN_WIDTH = 360

export function getRightPanelMaxWidth(
  viewportWidth: number,
  containerWidth?: number
): number {
  const fractionCap = Math.floor(viewportWidth * RIGHT_PANEL_MAX_WIDTH_FRACTION)
  const containerCap =
    containerWidth === undefined
      ? Number.POSITIVE_INFINITY
      : Math.floor(containerWidth) - SIBLING_COLUMN_MIN_WIDTH
  // Never below the panel's own minimum: when the row cannot fit both
  // columns' minimums the sibling yields, and useResizableWidth's clamp
  // must not see max < min (it would resolve the inversion to min and,
  // via drag-end persistence, overwrite the user's stored width).
  return Math.max(RIGHT_PANEL_MIN_WIDTH, Math.min(fractionCap, containerCap))
}

/**
 * Shell for the right panel: a right-anchored, user-resizable flex sibling.
 */
export function RightPanelShell(props: {
  /** localStorage key used to persist this panel's width. */
  widthStorageKey: string
  /** Workspace this panel belongs to; read by right-panel focus tracking. */
  workspaceId: string
  children: ReactNode
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const maxWidth = useClampedMaxWidth(hostRef)
  const { width, handlers } = useResizableWidth({
    storageKey: props.widthStorageKey,
    defaultWidth: RIGHT_PANEL_DEFAULT_WIDTH,
    minWidth: RIGHT_PANEL_MIN_WIDTH,
    maxWidth,
    edge: 'left',
  })

  return (
    <div
      className={cn(
        'relative flex h-full min-h-0 min-w-0 max-w-full shrink-0 flex-col self-stretch border-border border-l bg-background'
      )}
      data-right-panel
      data-workspace-id={props.workspaceId}
      ref={hostRef}
      style={{ width: `${width}px` }}
    >
      <RightPanelResizeHandle
        handlers={handlers}
        max={maxWidth}
        min={RIGHT_PANEL_MIN_WIDTH}
        value={width}
      />
      {props.children}
    </div>
  )
}

/**
 * Track viewport and flex-row widths to derive an upper bound for the panel.
 * Resize-aware so dragging the OS window narrower (or expanding a sibling
 * workspace tile) re-clamps the stored width on the next render (the hook's
 * clamp picks this up automatically). The row is observed rather than the
 * panel itself because the panel competes with its sibling column for row
 * space.
 */
function useClampedMaxWidth(hostRef: RefObject<HTMLDivElement | null>): number {
  const [vw, setVw] = useState(() =>
    typeof window === 'undefined' ? 1280 : window.innerWidth
  )
  const [containerWidth, setContainerWidth] = useState<number | undefined>(
    undefined
  )
  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    let frame = 0
    const onResize = () => {
      // Coalesce rapid resize events into one rAF tick.
      if (frame !== 0) {
        return
      }
      frame = window.requestAnimationFrame(() => {
        frame = 0
        setVw(window.innerWidth)
      })
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      if (frame !== 0) {
        window.cancelAnimationFrame(frame)
      }
    }
  }, [])
  useLayoutEffect(() => {
    const parent = hostRef.current?.parentElement
    if (!parent) {
      return
    }
    // Measure before first paint: the persisted width must be clamped
    // against the row on the initial render, not one observer tick later
    // (the panel would flash over-wide on every mount). clientWidth is
    // integral, so sub-pixel resize deltas bail out of re-rendering.
    const measure = () => {
      setContainerWidth(parent.clientWidth)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(measure)
    observer.observe(parent)
    return () => {
      observer.disconnect()
    }
  }, [hostRef])
  return getRightPanelMaxWidth(vw, containerWidth)
}
