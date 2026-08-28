/**
 * The reaction pills under a remark, and the picker that adds one. Ported
 * from t3code's `PullRequestReactions.tsx`.
 *
 * The same bar serves the description, a conversation comment and a review
 * thread's comments: what differs is only which subject GitHub is told
 * about. The add button is revealed by hovering the remark it belongs to,
 * so the parent must carry `group`.
 *
 * Laborer adaptation: `canReact` is decided by whether the entry carries a
 * GraphQL node id — an entry without one cannot be addressed by
 * `pullRequest.setReaction`, so the affordance is hidden.
 */
import { useAtomSet } from '@effect/atom-react/Hooks'
import type {
  PullRequestReaction,
  PullRequestReactionContent,
} from '@laborer/shared/rpc'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@laborer/ui/components/popover'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@laborer/ui/components/tooltip'
import { cn } from '@laborer/ui/lib/utils'
import { SmilePlus } from 'lucide-react'
import { useState } from 'react'
import { toast } from '@/lib/toast'
import { pullRequestSetReactionMutation } from './queries'
import {
  applyPendingPullRequestReactions,
  PULL_REQUEST_REACTION_ORDER,
  pullRequestReactionEmoji,
  pullRequestReactionName,
  pullRequestReactionTooltip,
} from './reactions-logic'

const PILL_CLASS =
  'inline-flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring'

const EMPTY_PENDING: ReadonlyMap<PullRequestReactionContent, boolean> =
  new Map()

/** What GitHub last said, so a press in flight is forgotten once real counts land. */
function reactionsSignature(reactions: readonly PullRequestReaction[]): string {
  return reactions
    .map(
      (reaction) =>
        `${reaction.content}:${reaction.count}:${reaction.viewerHasReacted ? 1 : 0}`
    )
    .join(' ')
}

export function PullRequestReactionBar({
  reactions,
  canReact,
  subjectId,
  workspaceId,
  onRefresh,
  className,
}: {
  readonly reactions: readonly PullRequestReaction[]
  readonly canReact: boolean
  /** Absent reacts to the pull request itself (its description's reactions). */
  readonly subjectId?: string | undefined
  readonly workspaceId: string
  readonly onRefresh: () => void
  readonly className?: string | undefined
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pending, setPending] = useState<{
    readonly signature: string
    readonly values: ReadonlyMap<PullRequestReactionContent, boolean>
  }>({ signature: '', values: EMPTY_PENDING })
  const setReaction = useAtomSet(pullRequestSetReactionMutation, {
    mode: 'promise',
  })

  const signature = reactionsSignature(reactions)
  const values =
    pending.signature === signature ? pending.values : EMPTY_PENDING
  const shown = applyPendingPullRequestReactions(reactions, values)

  const toggle = async (
    content: PullRequestReactionContent,
    reacted: boolean
  ) => {
    setPending({ signature, values: new Map([...values, [content, reacted]]) })
    try {
      await setReaction({
        payload: {
          workspaceId,
          ...(subjectId === undefined ? {} : { subjectId }),
          content,
          reacted,
        },
      })
    } catch {
      setPending((current) => {
        const next = new Map(current.values)
        next.delete(content)
        return { signature: current.signature, values: next }
      })
      toast.error('The reaction could not be saved')
      return
    }
    onRefresh()
  }

  if (shown.length === 0 && !canReact) {
    return null
  }

  return (
    <div className={cn('flex flex-wrap items-center gap-1', className)}>
      {shown.map((reaction) => (
        <Tooltip key={reaction.content}>
          <TooltipTrigger
            render={
              <button
                aria-label={`${pullRequestReactionName(reaction.content)}, ${reaction.count}`}
                aria-pressed={reaction.viewerHasReacted}
                className={cn(
                  PILL_CLASS,
                  reaction.viewerHasReacted
                    ? 'border-primary/60 bg-primary/10 text-foreground'
                    : 'border-border/70 bg-muted/40 text-muted-foreground',
                  canReact ? 'hover:border-primary/60' : 'cursor-default'
                )}
                disabled={!canReact}
                onClick={() =>
                  toggle(reaction.content, !reaction.viewerHasReacted)
                }
                type="button"
              />
            }
          >
            <span aria-hidden>
              {pullRequestReactionEmoji(reaction.content)}
            </span>
            <span className="tabular-nums">{reaction.count}</span>
          </TooltipTrigger>
          <TooltipContent side="top">
            {pullRequestReactionTooltip(reaction)}
          </TooltipContent>
        </Tooltip>
      ))}

      {canReact ? (
        <Popover onOpenChange={setPickerOpen} open={pickerOpen}>
          <PopoverTrigger
            render={
              <button
                aria-label="Add a reaction"
                className={cn(
                  PILL_CLASS,
                  'border-border/70 px-1.5 text-muted-foreground hover:border-primary/60 hover:text-foreground',
                  shown.length === 0 &&
                    !pickerOpen &&
                    'opacity-0 focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100'
                )}
                type="button"
              />
            }
          >
            <SmilePlus aria-hidden className="size-3.5" />
          </PopoverTrigger>
          <PopoverContent align="start" className="w-auto p-2" side="top">
            <div className="flex items-center gap-0.5">
              {PULL_REQUEST_REACTION_ORDER.map((content) => {
                const reacted =
                  shown.find((reaction) => reaction.content === content)
                    ?.viewerHasReacted ?? false
                return (
                  <button
                    aria-label={pullRequestReactionName(content)}
                    aria-pressed={reacted}
                    className={cn(
                      'flex size-7 items-center justify-center rounded-md text-base outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
                      reacted && 'bg-primary/10'
                    )}
                    key={content}
                    onClick={() => {
                      setPickerOpen(false)
                      toggle(content, !reacted)
                    }}
                    type="button"
                  >
                    <span aria-hidden>{pullRequestReactionEmoji(content)}</span>
                  </button>
                )
              })}
            </div>
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  )
}
