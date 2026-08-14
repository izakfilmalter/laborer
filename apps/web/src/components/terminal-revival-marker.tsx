import { History } from 'lucide-react'

export const isTerminalRevival = (
  resetReason: 'epoch_changed' | 'cursor_out_of_range'
): boolean => resetReason === 'epoch_changed'

/** Tier-iii marker: revival is explicit and is never presented as survival. */
export function TerminalRevivalMarker() {
  return (
    <output
      aria-live="polite"
      className="absolute inset-x-0 top-2 z-20 mx-auto flex w-fit max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-full border border-warning/40 bg-background/90 px-3 py-1 text-warning text-xs shadow-sm backdrop-blur-sm"
      data-testid="terminal-revival-marker"
    >
      <History aria-hidden="true" className="size-3.5 shrink-0" />
      <span>History restored — process was restarted</span>
    </output>
  )
}
