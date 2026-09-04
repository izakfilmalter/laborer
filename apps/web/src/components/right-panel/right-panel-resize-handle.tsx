import { ResizeGrip } from '@laborer/ui/components/resizable'
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
 * - Sits just outside the panel's `border-l`, so the always-visible 1px line
 *   plus that border read as the same 2px edge the project sidebar draws, with
 *   the same centred grip.
 * - The hit target is 8px wide, straddling the edge, so the user can grab a
 *   few pixels off it without aiming.
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
    // biome-ignore lint/a11y/useSemanticElements: <hr> cannot hold the grip; the separator role with aria-value* is the resize contract.
    <div
      aria-label="Resize right panel"
      aria-orientation="vertical"
      aria-valuemax={max}
      aria-valuemin={min}
      aria-valuenow={value}
      className={cn(
        'group absolute inset-y-0 -left-[5px] z-20 flex w-2 cursor-col-resize select-none items-center justify-center outline-none ring-offset-background after:pointer-events-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-border focus-visible:ring-1 focus-visible:ring-ring',
        className
      )}
      role="separator"
      tabIndex={0}
      {...handlers}
    >
      <ResizeGrip className="relative" />
    </div>
  )
}
