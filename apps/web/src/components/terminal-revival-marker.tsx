import { History, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export const isTerminalRevival = (
  resetReason: 'epoch_changed' | 'cursor_out_of_range'
): boolean => resetReason === 'epoch_changed'

/**
 * Spoken form of the marker. It is announced from an always-mounted region
 * owned by the terminal pane, because a live region that mounts together with
 * its own content is routinely swallowed by screen readers.
 */
export const TERMINAL_REVIVAL_ANNOUNCEMENT =
  'History restored. The terminal process was restarted, so this output is restored history rather than a live session.'

/**
 * Tier-iii marker: revival is explicit and is never presented as survival.
 *
 * Tiers i (cursor retained) and ii (snapshot re-render) stay silent because
 * the process itself survived. Only a changed epoch means the shell is new,
 * so the marker states plainly that the history is restored output rather
 * than a live process, and stays until the operator dismisses it.
 */
export function TerminalRevivalMarker({
  belowBanner = false,
  onDismiss,
}: {
  /** Connection banners own the top edge; drop below them instead of overlapping. */
  readonly belowBanner?: boolean
  readonly onDismiss?: (() => void) | undefined
}) {
  return (
    <div
      className={cn(
        'motion-safe:slide-in-from-top-1 motion-safe:fade-in absolute inset-x-0 z-20 mx-auto flex w-fit max-w-[calc(100%-1rem)] items-center gap-2 rounded-full border border-warning/40 bg-background/95 py-1 pr-1 pl-3 text-xs shadow-sm backdrop-blur-sm motion-safe:animate-in motion-safe:duration-300',
        belowBanner ? 'top-8' : 'top-2'
      )}
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
    </div>
  )
}
