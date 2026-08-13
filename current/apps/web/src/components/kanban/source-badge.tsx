/**
 * Where a card came from, as a chip.
 *
 * Shared by the board's cards and the card detail dialog, which is now opened
 * from the sidebar as well — so the chip cannot live inside the board.
 */

import { Bot, GitBranch, MessageSquare, SquarePen } from 'lucide-react'
import type { BoardTask } from '@/components/kanban/board-data'
import { Badge } from '@/components/ui/badge'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/**
 * How each card source presents itself. Agent-staged cards are the only
 * source that carries a tint: a card that appeared without a person asking
 * for it is the one worth spotting in a column of otherwise human work.
 * Every source explains its provenance on hover, since the chips are small.
 */
const SOURCE_BADGES: Record<
  BoardTask['source'],
  {
    readonly className: string
    readonly hint: string
    readonly icon: typeof Bot
    readonly label: string
  }
> = {
  agent: {
    className: 'border-primary/30 bg-primary/5 text-foreground',
    hint: 'Staged by an agent — nobody typed this card into a column.',
    icon: Bot,
    label: 'Agent staged',
  },
  execution: {
    className: 'text-muted-foreground',
    hint: 'Mirrored from an agent run.',
    icon: Bot,
    label: 'Agent',
  },
  manual: {
    className: 'text-muted-foreground',
    hint: 'Typed into a column composer.',
    icon: SquarePen,
    label: 'Manual',
  },
  slack_url: {
    className: 'text-muted-foreground',
    hint: 'Created from a Slack message link.',
    icon: MessageSquare,
    label: 'Slack',
  },
  worktree: {
    className: 'text-muted-foreground',
    hint: 'Adopted from an existing git worktree.',
    icon: GitBranch,
    label: 'Worktree',
  },
}

/** Chip showing where the card came from. */
function SourceBadge({ source }: { readonly source: BoardTask['source'] }) {
  const badge = SOURCE_BADGES[source]
  const Icon = badge.icon
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge
            className={cn('shrink-0 gap-1', badge.className)}
            variant="outline"
          />
        }
      >
        <Icon aria-hidden="true" className="size-3" />
        {badge.label}
      </TooltipTrigger>
      <TooltipContent>{badge.hint}</TooltipContent>
    </Tooltip>
  )
}

export { SourceBadge, SOURCE_BADGES }
