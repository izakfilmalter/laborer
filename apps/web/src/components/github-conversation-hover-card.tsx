import { useAtomValue } from '@effect/atom-react/Hooks'
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@laborer/ui/components/hover-card'
import { ScrollArea } from '@laborer/ui/components/scroll-area'
import { Spinner } from '@laborer/ui/components/spinner'
import { Array, Cause, Option, pipe } from 'effect'
import { AsyncResult as Result } from 'effect/unstable/reactivity'
import { MessageSquare, TriangleAlert } from 'lucide-react'
import { type ReactElement, useMemo } from 'react'
import { extractErrorMessage } from '@/lib/errors'
import { pullRequestConversationQuery } from '@/panes/comments-pane/conversation-query'
import { CommentTimelineItem } from '@/panes/comments-pane/timeline-item'

const PREVIEW_COMMENT_COUNT = 3
// The Base UI default is 600 ms, long enough for a small status icon to feel
// inert before the preview appears. Keep enough intent delay to avoid opening
// while the pointer merely crosses the card, but answer a deliberate hover
// promptly.
const PREVIEW_OPEN_DELAY_MS = 120

/**
 * The newest remarks behind a task card's PR status segment.
 *
 * This mounts only after the hover card opens. The query family is shared with
 * the full pane, so opening the pane after reading this preview is instant and
 * does not duplicate the GitHub request.
 */
function GitHubConversationPreview({
  now = Date.now(),
  workspaceId,
}: {
  readonly now?: number | undefined
  readonly workspaceId: string
}) {
  const conversationAtom = useMemo(
    () => pullRequestConversationQuery(workspaceId),
    [workspaceId]
  )
  const result = useAtomValue(conversationAtom)
  const conversation = Option.getOrUndefined(Result.value(result))

  if (conversation === undefined && !Result.isFailure(result)) {
    return (
      <div className="flex items-center justify-center gap-2 px-3 py-8 text-muted-foreground text-xs">
        <Spinner className="size-3.5" />
        Reading conversation…
      </div>
    )
  }

  if (conversation === undefined && Result.isFailure(result)) {
    return (
      <div className="flex items-start gap-2 px-3 py-3 text-xs">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" />
        <div>
          <p className="font-medium">Could not read GitHub</p>
          <p className="text-muted-foreground">
            {extractErrorMessage(Cause.squash(result.cause))}
          </p>
        </div>
      </div>
    )
  }

  if (conversation === undefined) {
    return null
  }

  const comments = pipe(
    conversation.comments,
    Array.takeRight(PREVIEW_COMMENT_COUNT),
    Array.reverse
  )
  const total = conversation.comments.length

  return (
    <>
      <div className="flex items-start gap-2 border-b px-3 py-2.5">
        <MessageSquare className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p
            className="truncate font-medium text-xs"
            title={conversation.title ?? undefined}
          >
            {conversation.title ?? `Pull request #${conversation.number}`}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {total} {total === 1 ? 'comment' : 'comments'} · Click to open the
            panel
          </p>
        </div>
      </div>
      {comments.length === 0 ? (
        <p className="px-3 py-6 text-center text-muted-foreground text-xs">
          No comments yet.
        </p>
      ) : (
        <ScrollArea className="h-auto max-h-80">
          <ol className="flex flex-col gap-2 p-2">
            {comments.map((comment) => (
              <CommentTimelineItem
                baseHref={conversation.url}
                comment={comment}
                compact
                key={`${comment.kind}-${comment.id}`}
                now={now}
              />
            ))}
          </ol>
        </ScrollArea>
      )}
    </>
  )
}

function GitHubConversationHoverCard({
  trigger,
  workspaceId,
}: {
  readonly trigger: ReactElement
  readonly workspaceId: string
}) {
  return (
    <HoverCard>
      <HoverCardTrigger delay={PREVIEW_OPEN_DELAY_MS} render={trigger} />
      <HoverCardContent align="start" className="w-72 p-0">
        <GitHubConversationPreview workspaceId={workspaceId} />
      </HoverCardContent>
    </HoverCard>
  )
}

export { GitHubConversationHoverCard, GitHubConversationPreview }
