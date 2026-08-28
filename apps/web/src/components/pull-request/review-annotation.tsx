// biome-ignore-all lint/style/noNestedTernary: ported near-verbatim from t3code, which chains presentation ternaries in JSX.
/**
 * Pull-request-specific diff annotations: conversations already on GitHub
 * and comments queued for the review being written. Ported from t3code's
 * `PullRequestReviewAnnotation.tsx`.
 *
 * Laborer adaptations: threads arrive whole (no per-thread pagination on
 * the contract, so no "load more"), and remarks cannot be rewritten (no
 * comment-edit RPC), so the pencil is gone.
 */
import type {
  PullRequestReviewThread,
  PullRequestThreadComment,
} from '@laborer/shared/rpc'
import { Button } from '@laborer/ui/components/button'
import { Textarea } from '@laborer/ui/components/textarea'
import { cn } from '@laborer/ui/lib/utils'
import { CheckCircle2, Circle, MessageSquare, Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'
import { isCommentSubmitShortcut } from '@/lib/comment-submit-shortcut'
import { PullRequestMarkdown } from './markdown'
import { PullRequestActorLabel } from './presentation'
import { PullRequestReactionBar } from './reactions'
import { formatRelativeTime } from './relative-time'
import type { PendingReviewComment } from './review-store'

const CARD_CLASS =
  'mx-3 my-2 rounded-xl border border-border/70 bg-background p-3 text-sm shadow-sm'

/** Sends a reply on ⌘/Ctrl+Enter and abandons it on Escape. */
function submitKeys(input: {
  readonly value: string
  readonly pending: boolean
  readonly onSubmit: () => void
  readonly onCancel?: (() => void) | undefined
}) {
  return (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape' && input.onCancel) {
      event.preventDefault()
      input.onCancel()
    }
    if (isCommentSubmitShortcut(event, input.value, input.pending)) {
      event.preventDefault()
      input.onSubmit()
    }
  }
}

/** A comment waiting to be sent with the rest of the review. */
export function PendingReviewCommentCard({
  comment,
  onRemove,
}: {
  comment: PendingReviewComment
  onRemove: () => void
}) {
  return (
    <div
      className={cn(CARD_CLASS, 'border-dashed')}
      contentEditable={false}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center gap-2 text-muted-foreground text-xs">
        <MessageSquare className="size-3.5" />
        <span>Pending — sent when you submit the review</span>
        <Button
          aria-label="Discard this comment"
          className="ml-auto"
          onClick={onRemove}
          size="icon-xs"
          variant="ghost"
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
      <p className="mt-2 whitespace-pre-wrap leading-relaxed">{comment.body}</p>
    </div>
  )
}

/** A conversation already on GitHub, with what the reader may do to it. */
export function ReviewThreadCard({
  thread,
  baseHref,
  canReply,
  canResolve,
  workspaceId,
  pending,
  onReply,
  onToggleResolved,
  onReacted,
  now,
}: {
  thread: PullRequestReviewThread
  /** The pull request's URL, which relative links in bodies resolve against. */
  baseHref: string | null
  canReply: boolean
  canResolve: boolean
  workspaceId: string
  pending: boolean
  /** Resolves to whether GitHub took it, so a failed reply keeps its words. */
  onReply: (body: string) => Promise<boolean>
  onToggleResolved: () => void
  onReacted: () => void
  /** Rendering clock, so every entry in one pass agrees on "now". */
  now: number
}) {
  // A resolved thread is finished work, so it opens collapsed.
  const [expanded, setExpanded] = useState(!thread.isResolved)
  const [replying, setReplying] = useState(false)
  const [reply, setReply] = useState('')
  const sendingRef = useRef(false)

  const send = async () => {
    const trimmed = reply.trim()
    if (trimmed.length === 0 || pending || sendingRef.current) {
      return
    }
    sendingRef.current = true
    // Cleared only once GitHub has it: a failed reply must keep its words.
    try {
      if (await onReply(trimmed)) {
        setReply('')
        setReplying(false)
      }
    } finally {
      sendingRef.current = false
    }
  }

  const commentReactions = (comment: PullRequestThreadComment) => (
    <PullRequestReactionBar
      canReact={true}
      className="mt-1.5"
      onRefresh={onReacted}
      reactions={comment.reactions}
      subjectId={comment.id}
      workspaceId={workspaceId}
    />
  )

  return (
    <div
      className={CARD_CLASS}
      contentEditable={false}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center gap-2 text-muted-foreground text-xs">
        {thread.isResolved ? (
          <CheckCircle2 className="size-3.5 text-emerald-600 dark:text-emerald-500" />
        ) : (
          <Circle className="size-3.5" />
        )}
        <button
          aria-expanded={expanded}
          className="hover:text-foreground"
          onClick={() => setExpanded((current) => !current)}
          type="button"
        >
          {thread.isResolved ? 'Resolved' : 'Open'} · {thread.comments.length}{' '}
          {thread.comments.length === 1 ? 'comment' : 'comments'}
        </button>
        {thread.isOutdated ? <span>outdated</span> : null}
        {canResolve ? (
          <Button
            className="ml-auto"
            disabled={pending}
            onClick={onToggleResolved}
            size="xs"
            variant="ghost"
          >
            {thread.isResolved ? 'Unresolve' : 'Resolve'}
          </Button>
        ) : null}
      </div>

      {expanded ? (
        <>
          <div className="mt-2 space-y-3">
            {thread.comments.map((comment) => (
              <article className="group min-w-0" key={comment.id}>
                <div className="flex items-center gap-2 text-muted-foreground text-xs">
                  <PullRequestActorLabel
                    actor={comment.author}
                    className="text-foreground"
                  />
                  <span>{formatRelativeTime(comment.createdAt, now)}</span>
                </div>
                <div className="mt-1 flex items-start gap-1">
                  <PullRequestMarkdown
                    baseHref={baseHref}
                    className="min-w-0 flex-1 text-sm"
                    text={comment.body}
                  />
                </div>
                {commentReactions(comment)}
              </article>
            ))}
          </div>

          {canReply ? (
            replying ? (
              <div className="mt-2">
                <Textarea
                  aria-label="Reply to this conversation"
                  autoFocus
                  onChange={(event) => setReply(event.target.value)}
                  onKeyDown={submitKeys({
                    value: reply,
                    pending,
                    onSubmit: () => send(),
                    onCancel: () => setReplying(false),
                  })}
                  placeholder="Reply"
                  value={reply}
                />
                <div className="mt-2 flex justify-end gap-2">
                  <Button
                    onClick={() => setReplying(false)}
                    size="xs"
                    variant="ghost"
                  >
                    Cancel
                  </Button>
                  <Button
                    disabled={pending || reply.trim().length === 0}
                    onClick={() => send()}
                    size="xs"
                  >
                    Reply
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                className="mt-2 px-1"
                onClick={() => setReplying(true)}
                size="xs"
                variant="ghost"
              >
                Reply
              </Button>
            )
          ) : null}
        </>
      ) : null}
    </div>
  )
}
