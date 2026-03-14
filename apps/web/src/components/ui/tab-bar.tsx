/**
 * Shared, presentational tab bar component used at both the window tab level
 * and workspace panel tab level. Props-driven with no layout tree knowledge.
 *
 * Features:
 * - Auto-hide when `autoHide` is true and there is 0 or 1 item
 * - Active tab visual indicator
 * - Close button on each tab (with optional dirty indicator)
 * - New tab (+) button
 * - Drag-and-drop reordering via @atlaskit/pragmatic-drag-and-drop
 * - Overflow: scrollable when tabs exceed available width
 * - Keyboard accessible: tab items are focusable
 *
 * @see docs/tabbed-window-layout/issues.md — Issue #7
 */

import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine'
import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter'
import { ChevronLeft, ChevronRight, Plus, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single item in the tab bar. */
interface TabBarItem {
  /** Optional icon element rendered before the label. */
  readonly icon?: React.ReactNode
  /** Unique identifier for the tab. */
  readonly id: string
  /** Whether this tab is the currently active tab. */
  readonly isActive: boolean
  /** Whether the tab has unsaved/dirty state. */
  readonly isDirty?: boolean
  /** Display label for the tab. */
  readonly label: string
  /** Optional keyboard shortcut hint shown in a tooltip on hover. */
  readonly shortcutHint?: string | undefined
}

/** Props for the TabBar component. */
interface TabBarProps {
  /** When true, the tab bar is hidden when there are 0 or 1 items. */
  readonly autoHide?: boolean | undefined
  /** Additional CSS classes for the root container. */
  readonly className?: string | undefined
  /** Tooltip text for the close button on each tab (e.g. "Close tab (Cmd+W)"). */
  readonly closeTooltip?: string | undefined
  /** Ordered list of tab items to render. */
  readonly items: readonly TabBarItem[]
  /** Tooltip text for the new tab (+) button. */
  readonly newTabTooltip?: string | undefined
  /** Called when a tab's close button is clicked. */
  readonly onClose: (id: string) => void
  /** Called when the new tab (+) button is clicked. */
  readonly onNew: () => void
  /** Called when tabs are reordered via drag-and-drop. */
  readonly onReorder: (fromIndex: number, toIndex: number) => void
  /** Called when a tab is clicked to select it. */
  readonly onSelect: (id: string) => void
}

// ---------------------------------------------------------------------------
// Drag-and-drop type guard
// ---------------------------------------------------------------------------

const TAB_BAR_ITEM_TYPE = 'tab-bar-item'

interface TabBarDragData {
  /** Unique key per tab bar instance to prevent cross-bar drops. */
  readonly barId: string
  readonly id: string
  readonly index: number
  readonly type: typeof TAB_BAR_ITEM_TYPE
  readonly [key: string]: unknown
}

function isTabBarDragData(
  data: Record<string, unknown>
): data is TabBarDragData {
  return data.type === TAB_BAR_ITEM_TYPE
}

// ---------------------------------------------------------------------------
// Counter for unique bar IDs per instance
// ---------------------------------------------------------------------------

let barIdCounter = 0

// ---------------------------------------------------------------------------
// TabBarTab — individual draggable tab
// ---------------------------------------------------------------------------

function TabBarTab({
  item,
  index,
  barId,
  onSelect,
  onClose,
  closeTooltip,
}: {
  readonly item: TabBarItem
  readonly index: number
  readonly barId: string
  readonly onSelect: (id: string) => void
  readonly onClose: (id: string) => void
  readonly closeTooltip?: string | undefined
}) {
  const tabRef = useRef<HTMLDivElement | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [closestEdge, setClosestEdge] = useState<'left' | 'right' | null>(null)

  useEffect(() => {
    const el = tabRef.current
    if (!el) {
      return
    }

    return combine(
      draggable({
        element: el,
        getInitialData: (): TabBarDragData => ({
          type: TAB_BAR_ITEM_TYPE,
          id: item.id,
          index,
          barId,
        }),
        onDragStart: () => setIsDragging(true),
        onDrop: () => setIsDragging(false),
      }),
      dropTargetForElements({
        element: el,
        canDrop: ({ source }) => {
          const data = source.data
          return isTabBarDragData(data) && data.barId === barId
        },
        getData: () => ({
          type: TAB_BAR_ITEM_TYPE,
          id: item.id,
          index,
          barId,
        }),
        onDragEnter: ({ source }) => {
          if (!isTabBarDragData(source.data)) {
            return
          }
          const sourceIndex = source.data.index
          setClosestEdge(sourceIndex < index ? 'right' : 'left')
        },
        onDrag: ({ source }) => {
          if (!isTabBarDragData(source.data)) {
            return
          }
          const sourceIndex = source.data.index
          setClosestEdge(sourceIndex < index ? 'right' : 'left')
        },
        onDragLeave: () => setClosestEdge(null),
        onDrop: () => setClosestEdge(null),
      })
    )
  }, [item.id, index, barId])

  return (
    <div className="relative flex items-stretch" ref={tabRef}>
      {closestEdge === 'left' && (
        <div className="absolute top-1 bottom-1 left-0 z-10 w-0.5 bg-primary" />
      )}
      <div
        aria-selected={item.isActive}
        className={cn(
          'group/tab relative flex cursor-pointer items-center gap-1.5 border-transparent border-r px-3 py-1 text-xs transition-colors',
          'hover:bg-muted/50',
          item.isActive
            ? 'bg-background text-foreground'
            : 'text-muted-foreground hover:text-foreground',
          isDragging && 'opacity-40'
        )}
        data-testid="tab-bar-tab"
        onClick={() => onSelect(item.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onSelect(item.id)
          }
        }}
        role="tab"
        tabIndex={item.isActive ? 0 : -1}
        title={item.shortcutHint}
      >
        {/* Active indicator — bottom border line */}
        {item.isActive && (
          <div className="absolute inset-x-0 bottom-0 h-0.5 bg-primary" />
        )}
        {item.icon && (
          <span className="flex shrink-0 items-center">{item.icon}</span>
        )}
        <span className="min-w-0 truncate">{item.label}</span>
        {item.isDirty && (
          <span
            className="size-1.5 shrink-0 rounded-full bg-amber-400"
            title="Unsaved changes"
          />
        )}
        {closeTooltip ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  aria-label={`Close ${item.label}`}
                  className={cn(
                    'ml-0.5 flex size-4 shrink-0 items-center justify-center rounded-none text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
                    'opacity-0 group-hover/tab:opacity-100',
                    item.isActive && 'opacity-100'
                  )}
                  onClick={(e) => {
                    e.stopPropagation()
                    onClose(item.id)
                  }}
                  type="button"
                />
              }
            >
              <X className="size-3" />
            </TooltipTrigger>
            <TooltipContent>{closeTooltip}</TooltipContent>
          </Tooltip>
        ) : (
          <button
            aria-label={`Close ${item.label}`}
            className={cn(
              'ml-0.5 flex size-4 shrink-0 items-center justify-center rounded-none text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
              'opacity-0 group-hover/tab:opacity-100',
              item.isActive && 'opacity-100'
            )}
            onClick={(e) => {
              e.stopPropagation()
              onClose(item.id)
            }}
            type="button"
          >
            <X className="size-3" />
          </button>
        )}
      </div>
      {closestEdge === 'right' && (
        <div className="absolute top-1 right-0 bottom-1 z-10 w-0.5 bg-primary" />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// TabBar — main component
// ---------------------------------------------------------------------------

function TabBar({
  items,
  onSelect,
  onClose,
  onNew,
  onReorder,
  autoHide = false,
  closeTooltip,
  newTabTooltip = 'New tab',
  className,
}: TabBarProps) {
  const [barId] = useState(() => {
    barIdCounter += 1
    return `tab-bar-${barIdCounter}`
  })

  // Auto-hide: render nothing when there are 0 or 1 items
  if (autoHide && items.length <= 1) {
    return null
  }

  return (
    <TabBarInner
      barId={barId}
      className={className}
      closeTooltip={closeTooltip}
      items={items}
      newTabTooltip={newTabTooltip}
      onClose={onClose}
      onNew={onNew}
      onReorder={onReorder}
      onSelect={onSelect}
    />
  )
}

// ---------------------------------------------------------------------------
// Overflow detection hook
// ---------------------------------------------------------------------------

/** Scroll overflow state for the tab area. */
interface OverflowState {
  /** Whether content overflows to the left (can scroll left). */
  readonly canScrollLeft: boolean
  /** Whether content overflows to the right (can scroll right). */
  readonly canScrollRight: boolean
}

/**
 * Detects horizontal scroll overflow on a scrollable element.
 * Returns which directions have overflowed content. Updates on scroll,
 * resize, and when items change.
 */
interface UseScrollOverflowResult {
  readonly overflow: OverflowState
  /** Call after the tab list renders to recheck overflow state. */
  readonly recheckOverflow: () => void
}

function useScrollOverflow(
  scrollRef: React.RefObject<HTMLDivElement | null>
): UseScrollOverflowResult {
  const [overflow, setOverflow] = useState<OverflowState>({
    canScrollLeft: false,
    canScrollRight: false,
  })

  const updateOverflow = useCallback(() => {
    const el = scrollRef.current
    if (!el) {
      setOverflow({ canScrollLeft: false, canScrollRight: false })
      return
    }
    const { scrollLeft, scrollWidth, clientWidth } = el
    // Use a small threshold (1px) to account for sub-pixel rounding
    setOverflow({
      canScrollLeft: scrollLeft > 1,
      canScrollRight: scrollLeft + clientWidth < scrollWidth - 1,
    })
  }, [scrollRef])

  // Subscribe to scroll events and ResizeObserver for continuous updates
  useEffect(() => {
    const el = scrollRef.current
    if (!el) {
      return
    }

    updateOverflow()

    el.addEventListener('scroll', updateOverflow, { passive: true })

    // ResizeObserver updates overflow when the container or its content
    // changes size. Guard for environments where it may not be available
    // (e.g., JSDOM in tests).
    let resizeObserver: ResizeObserver | undefined
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(updateOverflow)
      resizeObserver.observe(el)
    }

    return () => {
      el.removeEventListener('scroll', updateOverflow)
      resizeObserver?.disconnect()
    }
  }, [scrollRef, updateOverflow])

  return { overflow, recheckOverflow: updateOverflow }
}

/**
 * Inner component extracted to allow the drag-and-drop monitor useEffect
 * to only mount when the tab bar is actually rendered (not auto-hidden).
 */
function TabBarInner({
  items,
  onSelect,
  onClose,
  onNew,
  onReorder,
  closeTooltip,
  newTabTooltip,
  className,
  barId,
}: TabBarProps & { readonly barId: string }) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const { overflow, recheckOverflow } = useScrollOverflow(scrollRef)

  // Re-check overflow whenever items change. Using a microtask ensures the
  // DOM has been updated with the new tab elements before we measure.
  const prevItemCount = useRef(items.length)
  if (prevItemCount.current !== items.length) {
    prevItemCount.current = items.length
    // Schedule a microtask to recheck after React commits the DOM update.
    // This avoids reading stale scroll dimensions during render.
    queueMicrotask(recheckOverflow)
  }

  // Auto-scroll the active tab into view when the active item changes
  useEffect(() => {
    const el = scrollRef.current
    if (!el) {
      return
    }
    const activeIndex = items.findIndex((item) => item.isActive)
    if (activeIndex < 0) {
      return
    }
    const tabElements = el.querySelectorAll<HTMLElement>(
      '[data-testid="tab-bar-tab"]'
    )
    const activeEl = tabElements[activeIndex]
    if (!activeEl) {
      return
    }
    // scrollIntoView with 'nearest' avoids unnecessary scrolling when the
    // tab is already visible, and uses smooth scrolling for a polished feel.
    // Guard for JSDOM which may not implement scrollIntoView.
    activeEl.scrollIntoView?.({
      block: 'nearest',
      inline: 'nearest',
      behavior: 'smooth',
    })
  }, [items])

  // Scroll the tab area by a fixed amount when overflow buttons are clicked
  const scrollBy = useCallback(
    (delta: number) => {
      const el = scrollRef.current
      if (!el) {
        return
      }
      el.scrollBy({ left: delta, behavior: 'smooth' })
    },
    // scrollRef is a stable ref object — no dependencies needed
    []
  )

  const handleScrollLeft = useCallback(() => scrollBy(-120), [scrollBy])
  const handleScrollRight = useCallback(() => scrollBy(120), [scrollBy])

  // Monitor for drag-and-drop reorder events
  const onReorderStable = useCallback(
    (fromIndex: number, toIndex: number) => {
      onReorder(fromIndex, toIndex)
    },
    [onReorder]
  )

  useEffect(() => {
    return monitorForElements({
      canMonitor: ({ source }) => {
        const data = source.data
        return isTabBarDragData(data) && data.barId === barId
      },
      onDrop: ({ source, location }) => {
        const target = location.current.dropTargets[0]
        if (!target) {
          return
        }
        const sourceData = source.data
        const targetData = target.data
        if (!(isTabBarDragData(sourceData) && isTabBarDragData(targetData))) {
          return
        }
        if (sourceData.index === targetData.index) {
          return
        }
        onReorderStable(sourceData.index, targetData.index)
      },
    })
  }, [barId, onReorderStable])

  return (
    <div
      className={cn(
        'flex h-8 shrink-0 items-stretch border-b bg-muted/30',
        className
      )}
      data-testid="tab-bar"
      role="tablist"
    >
      {/* Left overflow scroll button */}
      {overflow.canScrollLeft && (
        <button
          aria-label="Scroll tabs left"
          className="flex shrink-0 items-center px-0.5 text-muted-foreground transition-colors hover:text-foreground"
          data-testid="tab-bar-scroll-left"
          onClick={handleScrollLeft}
          type="button"
        >
          <ChevronLeft className="size-3.5" />
        </button>
      )}
      {/* Scrollable tab area */}
      <div
        className="relative min-w-0 flex-1"
        data-testid="tab-bar-scroll-area"
      >
        <div
          className="scrollbar-none flex h-full items-stretch overflow-x-auto"
          ref={scrollRef}
        >
          {items.map((item, index) => (
            <TabBarTab
              barId={barId}
              closeTooltip={closeTooltip}
              index={index}
              item={item}
              key={item.id}
              onClose={onClose}
              onSelect={onSelect}
            />
          ))}
        </div>
        {/* Left fade gradient overlay — indicates more tabs to the left */}
        {overflow.canScrollLeft && (
          <div
            className="pointer-events-none absolute inset-y-0 left-0 w-4 bg-gradient-to-r from-muted/60 to-transparent"
            data-testid="tab-bar-fade-left"
          />
        )}
        {/* Right fade gradient overlay — indicates more tabs to the right */}
        {overflow.canScrollRight && (
          <div
            className="pointer-events-none absolute inset-y-0 right-0 w-4 bg-gradient-to-l from-muted/60 to-transparent"
            data-testid="tab-bar-fade-right"
          />
        )}
      </div>
      {/* Right overflow scroll button */}
      {overflow.canScrollRight && (
        <button
          aria-label="Scroll tabs right"
          className="flex shrink-0 items-center px-0.5 text-muted-foreground transition-colors hover:text-foreground"
          data-testid="tab-bar-scroll-right"
          onClick={handleScrollRight}
          type="button"
        >
          <ChevronRight className="size-3.5" />
        </button>
      )}
      {/* New tab button */}
      <div className="flex shrink-0 items-center px-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label={newTabTooltip}
                onClick={onNew}
                size="icon-xs"
                variant="ghost"
              />
            }
          >
            <Plus className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent>{newTabTooltip}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}

export { TabBar }
export type { TabBarItem, TabBarProps }
