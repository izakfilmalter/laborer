import { cn } from '@laborer/ui/lib/utils'
import { Loader2Icon } from 'lucide-react'

/**
 * Chromium cannot composite a transform animation applied directly to an
 * `<svg>`, so a spinning icon costs a style recalc and a layout update on the
 * main thread at the display refresh rate for as long as it stays visible — a
 * badge that spins for a ten-minute CI run bills the whole run to the CPU.
 * Spinning an HTML wrapper instead is compositor-promoted: identical visuals,
 * no main-thread work.
 *
 * `className` lands on the wrapper because that is the layout box every caller
 * is sizing and coloring; the glyph fills it and inherits `currentColor`.
 *
 * `<output>` carries an implicit `status` role, which is what the old `<svg>`
 * spelled out by hand.
 */
function Spinner({ className, ...props }: React.ComponentProps<'output'>) {
  return (
    <output
      aria-label="Loading"
      className={cn('inline-flex size-4 animate-spin', className)}
      {...props}
    >
      <Loader2Icon aria-hidden="true" className="size-full" />
    </output>
  )
}

export { Spinner }
