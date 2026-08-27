/**
 * Who the review verdict is made of.
 *
 * The pill's review segment says where the pull request stands; hovering it
 * has to answer the next question, which is always "who?". That is a
 * different question from "what was said", so it gets a different preview:
 * one line per reviewer with their standing verdict, rather than the tail of
 * the conversation — that belongs to the conversation segment.
 *
 * The reviewers are derived from the conversation the pane already reads, so
 * this costs no extra GitHub request.
 */

import { useAtomValue } from '@effect/atom-react/Hooks'
import type {
  PullRequestComment,
  PullRequestReviewDecision,
  PullRequestReviewState,
} from '@laborer/shared/rpc'
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from '@laborer/ui/components/avatar'
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@laborer/ui/components/hover-card'
import { ScrollArea } from '@laborer/ui/components/scroll-area'
import { Spinner } from '@laborer/ui/components/spinner'
import { cn } from '@laborer/ui/lib/utils'
import { Cause, Option } from 'effect'
import { AsyncResult as Result } from 'effect/unstable/reactivity'
import {
  CircleCheck,
  CircleDashed,
  CircleX,
  TriangleAlert,
  Users,
} from 'lucide-react'
import { type ReactElement, useMemo } from 'react'
import { extractErrorMessage } from '@/lib/errors'
import { pullRequestConversationQuery } from '@/panes/comments-pane/conversation-query'
import { GitHubLink } from '@/panes/comments-pane/external-links'
import {
  formatAbsoluteTime,
  formatRelativeTime,
} from '@/panes/comments-pane/relative-time'

// Matches the conversation preview, so the two segments of the same pill
// answer a deliberate hover at the same speed.
const PREVIEW_OPEN_DELAY_MS = 120

/** A reviewer's standing opinion: their most recent submitted review. */
interface Reviewer {
  readonly authorAvatarUrl: string | null
  readonly authorLogin: string
  readonly authorUrl: string | null
  readonly createdAt: string
  readonly state: PullRequestReviewState
  readonly url: string
}

/**
 * One row per reviewer, newest opinion wins.
 *
 * A reviewer who requested changes and later approved has one standing
 * opinion, not two, and it is the later one — the same rule GitHub's own
 * rollup follows. Pending reviews are drafts nobody else can see, so they
 * are not opinions yet.
 */
function latestReviewPerReviewer(
  comments: readonly PullRequestComment[]
): readonly Reviewer[] {
  const byLogin = new Map<string, Reviewer>()

  for (const comment of comments) {
    if (
      comment.kind !== 'review' ||
      comment.reviewState === null ||
      comment.reviewState === 'pending'
    ) {
      continue
    }

    const existing = byLogin.get(comment.authorLogin)
    if (
      existing !== undefined &&
      Date.parse(existing.createdAt) > Date.parse(comment.createdAt)
    ) {
      continue
    }

    byLogin.set(comment.authorLogin, {
      authorAvatarUrl: comment.authorAvatarUrl,
      authorLogin: comment.authorLogin,
      authorUrl: comment.authorUrl,
      createdAt: comment.createdAt,
      state: comment.reviewState,
      url: comment.url,
    })
  }

  // Whoever decides something is read first: an approval or a change request
  // outranks a drive-by comment, and a dismissed review is history.
  const rank: Record<PullRequestReviewState, number> = {
    changesRequested: 0,
    approved: 1,
    commented: 2,
    dismissed: 3,
    pending: 4,
  }

  return [...byLogin.values()].sort(
    (left, right) =>
      rank[left.state] - rank[right.state] ||
      Date.parse(right.createdAt) - Date.parse(left.createdAt)
  )
}

const REVIEWER_PRESENTATION: Record<
  PullRequestReviewState,
  {
    readonly icon: typeof CircleCheck
    readonly label: string
    readonly tone: string
  }
> = {
  approved: { icon: CircleCheck, label: 'Approved', tone: 'text-success' },
  changesRequested: {
    icon: CircleX,
    label: 'Changes requested',
    tone: 'text-destructive',
  },
  commented: {
    icon: CircleDashed,
    label: 'Commented',
    tone: 'text-muted-foreground',
  },
  dismissed: {
    icon: CircleDashed,
    label: 'Dismissed',
    tone: 'text-muted-foreground',
  },
  pending: {
    icon: CircleDashed,
    label: 'Pending',
    tone: 'text-muted-foreground',
  },
}

const DECISION_HEADLINE: Record<PullRequestReviewDecision, string> = {
  approved: 'Approved',
  changesRequested: 'Changes requested',
  reviewRequired: 'Review required',
}

const initialOf = (login: string) => login.slice(0, 1).toUpperCase()

function ReviewerRow({
  now,
  reviewer,
}: {
  readonly now: number
  readonly reviewer: Reviewer
}) {
  const presentation = REVIEWER_PRESENTATION[reviewer.state]

  return (
    <li className="flex min-w-0 items-center gap-2 rounded-sm px-1.5 py-1 text-xs">
      <Avatar className="size-5 shrink-0 ring-1 ring-background">
        {reviewer.authorAvatarUrl === null ? null : (
          <AvatarImage
            alt=""
            src={`${reviewer.authorAvatarUrl}${reviewer.authorAvatarUrl.includes('?') ? '&' : '?'}s=48`}
          />
        )}
        <AvatarFallback className="text-[9px]">
          {initialOf(reviewer.authorLogin)}
        </AvatarFallback>
      </Avatar>
      <GitHubLink
        className="min-w-0 flex-1 truncate font-medium hover:underline"
        href={reviewer.authorUrl ?? reviewer.url}
      >
        {reviewer.authorLogin}
      </GitHubLink>
      <span
        className={cn(
          'inline-flex shrink-0 items-center gap-1',
          presentation.tone
        )}
        title={formatAbsoluteTime(reviewer.createdAt)}
      >
        <presentation.icon aria-hidden="true" className="size-3" />
        <span className="sr-only">{presentation.label}</span>
        <span className="text-[10px] text-muted-foreground">
          {formatRelativeTime(reviewer.createdAt, now)}
        </span>
      </span>
    </li>
  )
}

/**
 * The reviewers behind a pull request's review verdict.
 *
 * Mounts only once the hover card opens, on the query family the pane and
 * the conversation preview already share.
 */
function GitHubReviewersPreview({
  decision,
  now = Date.now(),
  workspaceId,
}: {
  readonly decision: PullRequestReviewDecision
  readonly now?: number | undefined
  readonly workspaceId: string
}) {
  const conversationAtom = useMemo(
    () => pullRequestConversationQuery(workspaceId),
    [workspaceId]
  )
  const result = useAtomValue(conversationAtom)
  const conversation = Option.getOrUndefined(Result.value(result))

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
    return (
      <div className="flex items-center justify-center gap-2 px-3 py-8 text-muted-foreground text-xs">
        <Spinner className="size-3.5" />
        Reading reviews…
      </div>
    )
  }

  const reviewers = latestReviewPerReviewer(conversation.comments)
  const approvals = reviewers.filter(
    (reviewer) => reviewer.state === 'approved'
  ).length

  return (
    <>
      <div className="flex items-start gap-2 border-b px-3 py-2.5">
        <Users className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="font-medium text-xs leading-snug">
            {DECISION_HEADLINE[decision]}
          </p>
          <p className="text-[11px] text-muted-foreground leading-snug">
            {approvals === 0
              ? 'Nobody has approved yet'
              : `${approvals} ${approvals === 1 ? 'approval' : 'approvals'}`}
          </p>
        </div>
      </div>
      {reviewers.length === 0 ? (
        <p className="px-3 py-6 text-center text-muted-foreground text-xs">
          No reviews yet.
        </p>
      ) : (
        <ScrollArea className="h-auto max-h-64">
          <ul className="flex flex-col gap-0.5 p-1.5">
            {reviewers.map((reviewer) => (
              <ReviewerRow
                key={reviewer.authorLogin}
                now={now}
                reviewer={reviewer}
              />
            ))}
          </ul>
        </ScrollArea>
      )}
    </>
  )
}

function GitHubReviewersHoverCard({
  decision,
  trigger,
  workspaceId,
}: {
  readonly decision: PullRequestReviewDecision
  readonly trigger: ReactElement
  readonly workspaceId: string
}) {
  return (
    <HoverCard>
      <HoverCardTrigger delay={PREVIEW_OPEN_DELAY_MS} render={trigger} />
      <HoverCardContent align="start" className="w-64 p-0">
        <GitHubReviewersPreview decision={decision} workspaceId={workspaceId} />
      </HoverCardContent>
    </HoverCard>
  )
}

export {
  GitHubReviewersHoverCard,
  GitHubReviewersPreview,
  latestReviewPerReviewer,
}
