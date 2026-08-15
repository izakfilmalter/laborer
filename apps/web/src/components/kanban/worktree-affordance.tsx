/**
 * Bot-card worktree affordances (#379).
 *
 * A card carries two paired controls: a chip that states, at a glance, what
 * state its worktree is in, and a terminal button that attaches a shell to
 * that worktree's path. Both read passively from the shared-db projection —
 * nothing here polls. The button stays pressable in the degraded states so a
 * human's click is the re-check.
 *
 * Bot ownership is advisory: the owner marker only changes the chip's wording,
 * never whether the terminal can be opened.
 */

import { Badge } from '@laborer/ui/components/badge'
import { Button } from '@laborer/ui/components/button'
import { Spinner } from '@laborer/ui/components/spinner'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@laborer/ui/components/tooltip'
import { cn } from '@laborer/ui/lib/utils'
import { FolderGit2, FolderX, Terminal } from 'lucide-react'
import type { WorktreeState } from '@/components/kanban/board-data'

/** The card fields these affordances read. */
export interface WorktreeCard {
  readonly title: string
  readonly worktreeBotOwned: boolean
  readonly worktreePath: string | null
  readonly worktreeState: WorktreeState
}

/** Wording for the terminal button in each worktree state. */
export const terminalActionLabel = (state: WorktreeState): string =>
  state === 'exists' ? 'Terminal' : 'Re-check'

/** Why the button is there, spelled out for tooltip and screen readers. */
export const terminalActionHint = (card: WorktreeCard): string => {
  switch (card.worktreeState) {
    case 'exists':
      return `Open a terminal in ${card.worktreePath ?? 'the worktree'}`
    case 'provisioning':
      return 'Worktree is still provisioning — check again'
    default:
      return 'Worktree is missing on disk — check again'
  }
}

const terminalActionAriaLabel = (card: WorktreeCard): string => {
  switch (card.worktreeState) {
    case 'exists':
      return `Open terminal in worktree for ${card.title}`
    case 'provisioning':
      return `Re-check provisioning worktree for ${card.title}`
    default:
      return `Re-check missing worktree for ${card.title}`
  }
}

/**
 * Worktree state, said once and scannably. Cards with no path at all stay
 * quiet rather than claiming a worktree that was never asked for.
 */
export function WorktreeChip({ card }: { readonly card: WorktreeCard }) {
  if (card.worktreeState === 'provisioning') {
    return (
      <Badge className="gap-1 text-muted-foreground" variant="outline">
        <Spinner className="size-3" />
        Provisioning…
      </Badge>
    )
  }
  if (card.worktreeState === 'gone') {
    return (
      <Badge
        className="gap-1 border-dashed text-muted-foreground/70"
        variant="outline"
      >
        <FolderX className="size-3" />
        Worktree gone
      </Badge>
    )
  }
  if (card.worktreeState === 'exists') {
    return (
      <Badge className="gap-1 text-muted-foreground" variant="outline">
        <FolderGit2 className="size-3" />
        {card.worktreeBotOwned ? 'Bot worktree' : 'Worktree'}
      </Badge>
    )
  }
  return null
}

/**
 * Attach a terminal to the card's worktree path. Pressable in every state
 * that has a path: in the degraded states the press is the existence check,
 * which is how the card recovers without polling. Once attached the control
 * is a toggle, so the same press that opened the terminal closes it — which
 * is what its pressed state promises.
 */
export function TerminalAttachButton({
  attached = false,
  busy = false,
  card,
  disabled = false,
  id,
  onAttach,
}: {
  readonly attached?: boolean
  readonly busy?: boolean
  readonly card: WorktreeCard
  readonly disabled?: boolean
  readonly id?: string
  readonly onAttach: () => void
}) {
  if (card.worktreePath === null) {
    return null
  }

  const exists = card.worktreeState === 'exists'
  const label = terminalActionLabel(card.worktreeState)
  const hint = attached
    ? `Attached to ${card.worktreePath} — press to close`
    : terminalActionHint(card)

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-busy={busy || undefined}
            aria-label={
              attached
                ? `Terminal attached for ${card.title}`
                : terminalActionAriaLabel(card)
            }
            aria-pressed={attached}
            className={cn(
              'ml-auto',
              exists ? undefined : 'text-muted-foreground',
              attached && 'ring-1 ring-ring/40'
            )}
            disabled={disabled || busy}
            id={id}
            onClick={(event) => {
              event.stopPropagation()
              onAttach()
            }}
            onPointerDown={(event) => event.stopPropagation()}
            size="xs"
            variant={exists ? 'secondary' : 'ghost'}
          />
        }
      >
        {busy ? (
          <Spinner className="size-3" />
        ) : (
          <Terminal className="size-3" />
        )}
        {label}
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  )
}
