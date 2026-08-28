import { cn } from '@laborer/ui/lib/utils'
import type { ResizableWidthHandlers } from '@/hooks/use-resizable-width'

interface Props {
  readonly className?: string
  readonly handlers: ResizableWidthHandlers
  readonly max: number
  readonly min: number
  readonly value: number
}

/**
 * Hit target for resizing a right-anchored panel via its left edge.
 *
 * - Sits on top of the panel's border with a 4px overlap on each side so the
 *   user can grab a few pixels off the edge without aiming.
 * - Visual indicator is a 1px line that lights up on hover/active to mirror
 *   VS Code / Cursor.
 * - Exposed as a separator so keyboard and assistive-technology users can
 *   resize with ArrowLeft/ArrowRight/Home/End.
 */
export function RightPanelResizeHandle({
  handlers,
  className,
  max,
  min,
  value,
}: Props) {
  return (
    <hr
      aria-label="Resize right panel"
      aria-orientation="vertical"
      aria-valuemax={max}
      aria-valuemin={min}
      aria-valuenow={value}
      className={cn(
        'absolute inset-y-0 -left-1 z-20 m-0 h-auto w-2 cursor-col-resize select-none border-0 outline-none after:pointer-events-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-transparent after:transition-colors after:duration-150 hover:after:bg-border focus-visible:ring-2 focus-visible:ring-primary/60 active:after:bg-primary/60',
        className
      )}
      tabIndex={0}
      {...handlers}
    />
  )
}
