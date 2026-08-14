import { History, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

export const isTerminalRevival = (
  resetReason: 'epoch_changed' | 'cursor_out_of_range'
): boolean => resetReason === 'epoch_changed'

/**
 * Tier-iii marker: revival is explicit and is never presented as survival.
 *
 * Tiers i (cursor retained) and ii (snapshot re-render) stay silent because
 * the process itself survived. Only a changed epoch means the shell is new,
 * so the marker states plainly that the history is restored output rather
 * than a live process, and stays until the operator dismisses it.
 */
export function TerminalRevivalMarker({
  onDismiss,
}: {
  readonly onDismiss?: (() => void) | undefined
}) {
  return (
    <output
      aria-live="polite"
      className="slide-in-from-top-1 fade-in absolute inset-x-0 top-2 z-20 mx-auto flex w-fit max-w-[calc(100%-1rem)] animate-in items-center gap-2 rounded-full border border-warning/40 bg-background/95 py-1 pr-1 pl-3 text-xs shadow-sm backdrop-blur-sm duration-300"
      data-testid="terminal-revival-marker"
    >
      <History aria-hidden="true" className="size-3.5 shrink-0 text-warning" />
      <span className="min-w-0 truncate">
        <span className="font-medium text-foreground">History restored</span>
        <span className="text-muted-foreground">
          {' — process was restarted'}
        </span>
      </span>
      <Button
        aria-label="Dismiss restored history notice"
        className="size-5 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
        onClick={onDismiss}
        size="icon-xs"
        variant="ghost"
      >
        <X className="size-3" />
      </Button>
    </output>
  )
}
