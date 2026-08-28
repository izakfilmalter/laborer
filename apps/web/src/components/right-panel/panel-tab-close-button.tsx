import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@laborer/ui/components/tooltip'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'

interface PanelTabCloseButtonProps {
  readonly children: ReactNode
  readonly label: string
  readonly onClick: () => void
  readonly tooltip?: string
}

/** Inside a `group/tab` row, swaps the tab identity for its close action on hover or focus. */
function PanelTabCloseButton({
  children,
  label,
  onClick,
  tooltip,
}: PanelTabCloseButtonProps) {
  const button = (
    <button
      aria-label={label}
      className="group/close relative flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm hover:bg-muted"
      onClick={onClick}
      type="button"
    >
      <span className="relative flex size-3 items-center justify-center group-hover/tab:hidden group-focus-visible/close:hidden">
        {children}
      </span>
      <X className="hidden size-3 group-hover/tab:block group-focus-visible/close:block" />
    </button>
  )

  if (!tooltip) {
    return button
  }

  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
}

export { PanelTabCloseButton }
