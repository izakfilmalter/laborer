import { cn } from '@laborer/ui/lib/utils'
import type { ResizableWidthHandlers } from '@/hooks/use-resizable-width'

interface Props {
  readonly className?: string
  readonly handlers: ResizableWidthHandlers
}

/**
 * Hit target for resizing a right-anchored panel via its left edge.
 *
 * - Sits on top of the panel's border with a 4px overlap on each side so the
 *   user can grab a few pixels off the edge without aiming.
 * - Visual indicator is a 1px line that lights up on hover/active to mirror
 *   VS Code / Cursor.
 * - Pointer-only and hidden from assistive tech: it has no keyboard
 *   interaction, and the persisted width has no accessible control surface
 *   here (matching the sidebar resize strip, which is also `tabIndex={-1}`).
 */
function RightPanelResizeHandle({ handlers, className }: Props) {
  return (
    <div
      aria-hidden
      className={cn(
        'group absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize select-none',
        className
      )}
      {...handlers}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors duration-150 group-hover:bg-border group-active:bg-primary/60"
      />
    </div>
  )
}

export { RightPanelResizeHandle }
