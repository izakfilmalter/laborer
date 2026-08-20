/**
 * One entry in a pull request conversation.
 *
 * The shape is GitHub Desktop's comment-like dialog, rethought for a list
 * instead of a single notification: an avatar on a dashed timeline rail, a
 * one-line summary in the form "**author** {verb} · {age}", and — only when
 * there is something to read — a bubble carrying the markdown body.
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
  AvatarBadge,
  AvatarFallback,
  AvatarImage,
} from '@laborer/ui/components/avatar'
import { Markdown } from '@laborer/ui/components/markdown'
import { GitHubLink, resolveMarkdownLinks } from './external-links'
import { formatAbsoluteTime, formatRelativeTime } from './relative-time'

interface EntryPresentation {
  /**
   * The badge riding the avatar, which is color and nothing else. The design
   * system hides a badge icon at this avatar size on purpose — an 8px glyph
   * is not readable — and the verb beside it already names the state in
   * words, so the color is reinforcement rather than the only telling.
   */
  readonly badgeClassName: string
  /** What the author did, completing "<author> …". */
  readonly verb: string
}

const REVIEW_PRESENTATION: Record<PullRequestReviewState, EntryPresentation> = {
  approved: {
    badgeClassName: 'bg-success',
    verb: 'approved this pull request',
  },
  changesRequested: {
    badgeClassName: 'bg-destructive',
    verb: 'requested changes',
  },
  commented: {
    badgeClassName: 'bg-muted',
    verb: 'reviewed this pull request',
  },
  dismissed: {
    badgeClassName: 'bg-muted',
    verb: 'had a review dismissed',
  },
  // Unreachable in practice: the server's timeline reader drops pending
  // reviews, which are drafts only their author can see. Kept so this map
  // stays exhaustive over the schema's literals.
  pending: {
    badgeClassName: 'bg-muted',
    verb: 'has a pending review',
  },
}

const COMMENT_PRESENTATION: EntryPresentation = {
  badgeClassName: 'bg-muted',
  verb: 'commented',
}

const REPLY_PRESENTATION: EntryPresentation = {
  ...COMMENT_PRESENTATION,
  verb: 'replied',
}

function presentationFor(comment: PullRequestComment): EntryPresentation {
  if (comment.kind === 'review' && comment.reviewState !== null) {
    return REVIEW_PRESENTATION[comment.reviewState]
  }
  if (comment.kind === 'reviewComment') {
    return comment.inReplyToId === null
      ? COMMENT_PRESENTATION
      : REPLY_PRESENTATION
  }
  return COMMENT_PRESENTATION
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

export function CommentTimelineItem({
  baseHref,
  comment,
  now,
}: {
  /**
   * The pull request's own URL, which relative links in a body are written
   * against. Absent, such a link is left as the commenter wrote it.
   */
  readonly baseHref?: string | null | undefined
  readonly comment: PullRequestComment
  /** Rendering clock, so every entry in one pass agrees on "now". */
  readonly now: number
}) {
  const { badgeClassName, verb } = presentationFor(comment)
  const body = comment.body.trim()
  const relativeTime = formatRelativeTime(comment.createdAt, now)

  return (
    <li className="relative pl-9" data-testid="pr-comment">
      <div className="absolute top-0.5 left-0">
        <Avatar className="ring-2 ring-background" size="sm">
          {comment.authorAvatarUrl === null ? null : (
            <AvatarImage
              alt=""
              src={`${comment.authorAvatarUrl}${comment.authorAvatarUrl.includes('?') ? '&' : '?'}s=48`}
            />
          )}
          <AvatarFallback>{initialOf(comment.authorLogin)}</AvatarFallback>
          <AvatarBadge aria-hidden="true" className={badgeClassName} />
        </Avatar>
      </div>

      <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-xs">
        <GitHubLink
          className="font-medium text-foreground hover:underline"
          href={comment.authorUrl ?? comment.url}
        >
          {comment.authorLogin}
        </GitHubLink>
        <span className="text-muted-foreground">{verb}</span>
        <GitHubLink
          className="text-muted-foreground hover:underline"
          href={comment.url}
          title={formatAbsoluteTime(comment.createdAt)}
        >
          {relativeTime}
        </GitHubLink>
      </div>

      {comment.filePath === null ? null : (
        <div className="mt-1 flex min-w-0">
          <FileAnchor filePath={comment.filePath} line={comment.line} />
        </div>
      )}

      {body.length === 0 ? null : (
        <div className="relative mt-1.5 rounded-md border bg-card px-2.5 py-2">
          {/* The bubble's tail — a rotated square masking the border it
              overlaps, the same two-triangle trick GitHub Desktop uses. */}
          <span
            aria-hidden="true"
            className="absolute -top-[5px] left-3 size-2 rotate-45 border-t border-l bg-card"
          />
          <Markdown className="text-xs">
            {resolveMarkdownLinks(body, baseHref)}
          </Markdown>
        </div>
      )}
    </li>
  )
}
