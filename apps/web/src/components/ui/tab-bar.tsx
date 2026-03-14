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
import { Plus, X } from 'lucide-react'
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
}

/** Props for the TabBar component. */
interface TabBarProps {
  /** When true, the tab bar is hidden when there are 0 or 1 items. */
  readonly autoHide?: boolean | undefined
  /** Additional CSS classes for the root container. */
  readonly className?: string | undefined
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
}: {
  readonly item: TabBarItem
  readonly index: number
  readonly barId: string
  readonly onSelect: (id: string) => void
  readonly onClose: (id: string) => void
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
      items={items}
      newTabTooltip={newTabTooltip}
      onClose={onClose}
      onNew={onNew}
      onReorder={onReorder}
      onSelect={onSelect}
    />
  )
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
  newTabTooltip,
  className,
  barId,
}: TabBarProps & { readonly barId: string }) {
  const scrollRef = useRef<HTMLDivElement | null>(null)

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
      {/* Scrollable tab area */}
      <div
        className="scrollbar-none flex min-w-0 flex-1 items-stretch overflow-x-auto"
        ref={scrollRef}
      >
        {items.map((item, index) => (
          <TabBarTab
            barId={barId}
            index={index}
            item={item}
            key={item.id}
            onClose={onClose}
            onSelect={onSelect}
          />
        ))}
      </div>
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
