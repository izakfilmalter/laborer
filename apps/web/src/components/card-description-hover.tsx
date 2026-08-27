/**
 * The description behind a card's title, on hover.
 *
 * A card names a branch. What the branch is *for* lives in its description,
 * and until now the only way to read it was to open the editor — a modal, for
 * a glance. Hovering the title answers the question without leaving the list,
 * which is the whole point when the list is a column of a dozen branches and
 * the question is "which of these was the auth one".
 *
 * The same preview serves a checked-out workspace and a pull request that is
 * still only on the remote: one reads the task description, the other reads
 * the pull request body, and pulling one in is supposed to turn the second
 * into the first. Showing them the same way is what makes that claim legible.
 *
 * A card with no description renders its title untouched. An empty popover
 * that opens on every hover is worse than no popover.
 */

import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@laborer/ui/components/hover-card'
import { Markdown } from '@laborer/ui/components/markdown'
import { ScrollArea } from '@laborer/ui/components/scroll-area'
import type { ReactNode } from 'react'

/**
 * How long the pointer has to rest on a title before its description opens.
 *
 * Longer than the status pill's previews on purpose: those sit on chips the
 * pointer only reaches deliberately, while the title spans the card and is
 * crossed on the way to everything else. Waiting keeps a sweep down the
 * sidebar from trailing popovers behind it.
 */
const DESCRIPTION_PREVIEW_DELAY_MS = 300

function CardDescriptionHover({
  children,
  description,
  heading,
}: {
  /** The card title, which becomes the hover target. */
  readonly children: ReactNode
  /** Markdown body to preview, or null when the card has none. */
  readonly description: string | null | undefined
  /** Line above the body naming what is being previewed. */
  readonly heading: string
}) {
  const body = description?.trim() ?? ''

  if (body === '') {
    return children
  }

  return (
    <HoverCard>
      <HoverCardTrigger
        delay={DESCRIPTION_PREVIEW_DELAY_MS}
        render={<span className="block min-w-0" />}
      >
        {children}
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-80 p-0" side="top">
        <p className="border-b px-3 py-2 font-medium text-muted-foreground text-xs">
          {heading}
        </p>
        {/* Descriptions run long. A bounded, scrollable body keeps a preview
            from covering the list it is previewing. */}
        <ScrollArea className="h-auto max-h-64">
          <Markdown className="px-3 py-2 text-xs">{body}</Markdown>
        </ScrollArea>
      </HoverCardContent>
    </HoverCard>
  )
}

export { CardDescriptionHover, DESCRIPTION_PREVIEW_DELAY_MS }
