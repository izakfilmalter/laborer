/**
 * One entry in a pull request conversation.
 *
 * The shape follows t3code's pull request summary: each remark is its own
 * quiet bordered card, with attribution and review state in a compact header
 * and markdown flowing directly beneath it.
 *
 * Reviews are the reason the summary line carries its weight. "approved"
 * with no body is the entire message, so a review with an empty body still
 * renders as a timeline entry with no bubble beneath it.
 *
 * @see app/src/ui/notifications/pull-request-comment-like.tsx in
 *   desktop/desktop — the interface this is modeled on
 */

import type {
  PullRequestComment,
  PullRequestReviewState,
} from '@laborer/shared/rpc'
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from '@laborer/ui/components/avatar'
import { Badge } from '@laborer/ui/components/badge'
import { Markdown } from '@laborer/ui/components/markdown'
import { cn } from '@laborer/ui/lib/utils'
import { CircleCheck, CircleDashed, CircleX } from 'lucide-react'
import type { ComponentType } from 'react'
import { GitHubLink, resolveMarkdownLinks } from './external-links'
import { formatAbsoluteTime, formatRelativeTime } from './relative-time'

interface EntryPresentation {
  readonly icon: ComponentType<{ className?: string }>
  readonly label: string
  readonly tone: string
}

const REVIEW_PRESENTATION: Record<PullRequestReviewState, EntryPresentation> = {
  approved: {
    icon: CircleCheck,
    label: 'Approved',
    tone: 'border-success/25 bg-success/10 text-success',
  },
  changesRequested: {
    icon: CircleX,
    label: 'Changes requested',
    tone: 'border-destructive/25 bg-destructive/10 text-destructive',
  },
  commented: {
    icon: CircleDashed,
    label: 'Reviewed',
    tone: 'border-border/70 bg-muted/40 text-muted-foreground',
  },
  dismissed: {
    icon: CircleDashed,
    label: 'Review dismissed',
    tone: 'border-border/70 bg-muted/40 text-muted-foreground',
  },
  // Unreachable in practice: the server's timeline reader drops pending
  // reviews, which are drafts only their author can see. Kept so this map
  // stays exhaustive over the schema's literals.
  pending: {
    icon: CircleDashed,
    label: 'Pending review',
    tone: 'border-border/70 bg-muted/40 text-muted-foreground',
  },
}

/** First letter of the login, for accounts whose avatar will not load. */
const initialOf = (login: string) => login.slice(0, 1).toUpperCase()

/**
 * The file and line a review comment is anchored to.
 *
 * Only the basename is shown — the full path is the tooltip — because the
 * pane is narrow and the last segment is what identifies the file.
 */
function FileAnchor({
  filePath,
  line,
}: {
  readonly filePath: string
  readonly line: number | null
}) {
  const fileName = filePath.split('/').at(-1) ?? filePath
  const label = line === null ? fileName : `${fileName}:${line}`

  return (
    <span
      className="inline-flex max-w-full items-center gap-1 truncate rounded border bg-muted/50 px-1 py-px font-mono text-[10px] text-muted-foreground"
      title={line === null ? filePath : `${filePath}:${line}`}
    >
      {label}
    </span>
  )
}

function ReviewBadge({ state }: { readonly state: PullRequestReviewState }) {
  const presentation = REVIEW_PRESENTATION[state]

  return (
    <Badge
      className={cn('h-5 gap-1 px-1.5 text-[10px]', presentation.tone)}
      variant="outline"
    >
      <presentation.icon aria-hidden="true" className="size-3" />
      {presentation.label}
    </Badge>
  )
}

export function CommentTimelineItem({
  baseHref,
  comment,
  compact = false,
  now,
}: {
  /**
   * The pull request's own URL, which relative links in a body are written
   * against. Absent, such a link is left as the commenter wrote it.
   */
  readonly baseHref?: string | null | undefined
  readonly comment: PullRequestComment
  /** A bounded card body for the task-card hover preview. */
  readonly compact?: boolean | undefined
  /** Rendering clock, so every entry in one pass agrees on "now". */
  readonly now: number
}) {
  const body = comment.body.trim()
  const relativeTime = formatRelativeTime(comment.createdAt, now)
  const isReply =
    comment.kind === 'reviewComment' && comment.inReplyToId !== null

  return (
    <li
      className={cn(
        'group rounded-lg border border-border/60 bg-background p-3',
        compact && 'p-2.5'
      )}
      data-slot="pr-comment-card"
      data-testid="pr-comment"
    >
      <div className="flex min-w-0 items-start gap-2">
        <Avatar className="size-5 ring-1 ring-background">
          {comment.authorAvatarUrl === null ? null : (
            <AvatarImage
              alt=""
              src={`${comment.authorAvatarUrl}${comment.authorAvatarUrl.includes('?') ? '&' : '?'}s=48`}
            />
          )}
          <AvatarFallback className="text-[9px]">
            {initialOf(comment.authorLogin)}
          </AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
          <GitHubLink
            className="max-w-full truncate font-medium text-foreground hover:underline"
            href={comment.authorUrl ?? comment.url}
          >
            {comment.authorLogin}
          </GitHubLink>
          <GitHubLink
            className="text-muted-foreground hover:underline"
            href={comment.url}
            title={formatAbsoluteTime(comment.createdAt)}
          >
            {relativeTime}
          </GitHubLink>
          {comment.kind === 'review' && comment.reviewState !== null ? (
            <ReviewBadge state={comment.reviewState} />
          ) : null}
          {isReply ? (
            <span className="text-muted-foreground">Replied</span>
          ) : null}
        </div>
      </div>

      {comment.filePath === null ? null : (
        <div className="mt-1.5 flex min-w-0">
          <FileAnchor filePath={comment.filePath} line={comment.line} />
        </div>
      )}

      {body.length === 0 ? null : (
        <div
          className={cn(
            'mt-2',
            compact && 'max-h-32 overflow-hidden [overflow-wrap:anywhere]'
          )}
          data-slot="pr-comment-body"
        >
          <Markdown className="text-xs">
            {resolveMarkdownLinks(body, baseHref)}
          </Markdown>
        </div>
      )}
    </li>
  )
}
