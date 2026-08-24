/**
 * The pull request as one pill.
 *
 * Identity on the left — number and state — and, hung off the same border,
 * whatever the pull request is still waiting on: CI health, where it stands
 * with its reviewers, and any review threads nobody has resolved. They are
 * one fact read at several depths: the PR is where the work went, the checks
 * are whether it survived the trip, and the reviews and conversations are who
 * is still waiting on an answer. Splitting them into loose chips made the
 * status rail read as a pile of colors.
 */

import type {
  PullRequestCheckRun,
  PullRequestReviewDecision,
} from '@laborer/shared/rpc'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@laborer/ui/components/tooltip'
import { cn } from '@laborer/ui/lib/utils'
import {
  CircleCheck,
  CircleDashed,
  FileDiff,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  MessageSquareDot,
} from 'lucide-react'
import type { ComponentType, MouseEvent, ReactElement, ReactNode } from 'react'
import { GitHubCheckRunsSegment } from '@/components/github-check-runs'
import { GitHubConversationHoverCard } from '@/components/github-conversation-hover-card'
import { localApi } from '@/lib/local-api'

interface GitHubPrStatusBadgeProps {
  /**
   * How many reviewers' latest review is an approval. Null is unread rather
   * than unapproved, and reads as nothing at all.
   */
  readonly approvals?: number | null | undefined
  readonly checkStatus?: 'pending' | 'success' | 'failure' | null | undefined
  readonly checks?: readonly PullRequestCheckRun[] | null | undefined
  readonly className?: string | undefined
  /** Enables the lazy conversation preview on workspace-backed cards. */
  readonly conversationWorkspaceId?: string | undefined
  /**
   * Opens the conversation where the operator already is, when the surface
   * has somewhere to open it. Absent on surfaces standing in for a workspace
   * that does not exist yet — a board card for unstarted work has no pane to
   * show — and the segment falls back to GitHub in the browser rather than
   * inventing one.
   */
  readonly onOpenConversation?: (() => void) | undefined
  /**
   * Whether the pull request is still a draft. A draft is open, but it is
   * not the same offer: GitHub withholds the automatic review request until
   * it is marked ready, and the merge button refuses it either way.
   */
  readonly prIsDraft?: boolean | undefined
  readonly prNumber: number | null
  readonly prState: string | null
  readonly prTitle: string | null
  readonly prUrl: string | null
  /**
   * GitHub's rolled-up verdict on the reviews. Null when the pull request
   * asks nobody for one, which is silence rather than "not yet approved".
   */
  readonly reviewDecision?: PullRequestReviewDecision | null | undefined
  /**
   * Review threads still awaiting resolution. Null is unread rather than
   * settled, so it says nothing at all; zero has been read and has nothing
   * left to say, which is the same silence.
   */
  readonly unresolvedThreads?: number | null | undefined
}

/** In the desktop shell a GitHub page belongs in the OS browser. */
const openInBrowser = (url: string) => async (event: MouseEvent) => {
  if (!localApi.isDesktop) {
    return
  }

  event.preventDefault()
  await localApi.openExternal(url)
}

/** A modifier click has always meant "somewhere else"; GitHub keeps it. */
const opensElsewhere = (event: MouseEvent) =>
  event.metaKey || event.ctrlKey || event.shiftKey || event.altKey

/**
 * Where the click goes, said once.
 *
 * The trigger's name and its tooltip used to be the same sentence, so a
 * screen reader read the count and then read it again. The name keeps the
 * count — it is the only place the digit is spelled out — and the tooltip
 * earns its second line by naming the destination instead of repeating it.
 * Null when the segment has nowhere to go, which is also when it stops
 * being a control at all.
 */
function getSegmentActionHint(
  opensConversation: boolean,
  segmentUrl: string | null
): string | null {
  if (opensConversation) {
    return 'Open PR comments'
  }
  if (segmentUrl === null) {
    return null
  }
  return 'Open on GitHub'
}

/**
 * The element the segment is, which follows from what it can do.
 *
 * A count that opens the pane is a button, a count that only points at
 * GitHub is a link, and a count with nowhere to go is neither — it is a
 * label, so it says so rather than posing as a control that ignores
 * clicks.
 */
function renderSegmentTrigger({
  body,
  className,
  description,
  onOpenConversation,
  openConversation,
  segmentUrl,
}: {
  readonly body: ReactNode
  readonly className: string
  readonly description: string
  readonly onOpenConversation: (() => void) | undefined
  readonly openConversation: (event: MouseEvent) => Promise<void>
  readonly segmentUrl: string | null
}): ReactElement {
  // Only something clickable lights up under the pointer.
  const interactiveClassName = cn(
    className,
    'transition-colors hover:bg-accent'
  )

  if (segmentUrl === null) {
    return onOpenConversation === undefined ? (
      <span aria-label={description} className={className} role="img">
        {body}
      </span>
    ) : (
      <button
        aria-label={description}
        className={interactiveClassName}
        onClick={openConversation}
        type="button"
      >
        {body}
      </button>
    )
  }

  return (
    <a
      aria-label={description}
      className={interactiveClassName}
      href={segmentUrl}
      onClick={
        onOpenConversation === undefined
          ? openInBrowser(segmentUrl)
          : openConversation
      }
      rel="noopener noreferrer"
      target="_blank"
    >
      {body}
    </a>
  )
}

/**
 * A segment whose plain click belongs in the app.
 *
 * Both the review verdict and the unresolved-thread count are answered in
 * the conversation the app already has a pane for, so handing the operator
 * to a browser tab would step straight over the thing they asked for.
 * GitHub remains one modifier click away, and owns the plain click on
 * surfaces that have no pane to open.
 */
function ConversationSegment({
  body,
  conversationWorkspaceId,
  description,
  onOpenConversation,
  segmentClass,
  segmentUrl,
}: {
  readonly body: ReactNode
  readonly conversationWorkspaceId: string | undefined
  readonly description: string
  readonly onOpenConversation: (() => void) | undefined
  readonly segmentClass: string
  readonly segmentUrl: string | null
}) {
  const actionHint = getSegmentActionHint(
    onOpenConversation !== undefined,
    segmentUrl
  )

  const openConversation = async (event: MouseEvent) => {
    if (onOpenConversation === undefined) {
      return
    }
    if (segmentUrl !== null && opensElsewhere(event)) {
      await openInBrowser(segmentUrl)(event)
      return
    }
    event.preventDefault()
    onOpenConversation()
  }

  const trigger = renderSegmentTrigger({
    body,
    className: segmentClass,
    description,
    onOpenConversation,
    openConversation,
    segmentUrl,
  })

  if (conversationWorkspaceId !== undefined) {
    return (
      <GitHubConversationHoverCard
        trigger={trigger}
        workspaceId={conversationWorkspaceId}
      />
    )
  }

  return (
    <Tooltip>
      <TooltipTrigger render={trigger} />
      <TooltipContent>
        {description}
        {actionHint === null ? null : (
          <span className="text-tooltip-foreground/60">{actionHint}</span>
        )}
      </TooltipContent>
    </Tooltip>
  )
}

// The seam every hung segment shares: neutral and barely there, so the pill
// still reads as one object rather than a row of chips.
const SEGMENT_CLASS =
  'flex items-center gap-1 border-foreground/15 border-l px-1.5'

/**
 * How each review verdict looks, and what it is called out loud.
 *
 * The verdict is GitHub's own rollup rather than a tally of who said what:
 * an approval that a later change request overruled is still in the
 * timeline, but it is not what the merge button obeys, and the pill answers
 * to the merge button.
 *
 * `reviewRequired` is muted for the same reason an unresolved thread is —
 * nothing is wrong, someone is just waiting — and green and red are kept for
 * the two verdicts that actually decide something. All three stay legible on
 * the state tints they can appear over, which is the open one alone.
 *
 * Its glyph is the dashed circle the checks list already uses for a run that
 * reached no verdict, so an outstanding review reads as the same absence in
 * the same vocabulary, and stays in the circle family the approval sits in.
 * An eye would say someone had already looked, which is the one thing that
 * has not happened yet.
 */
const REVIEW_DECISION_PRESENTATION = {
  approved: {
    icon: CircleCheck,
    label: 'Approved',
    tone: 'text-success',
  },
  changesRequested: {
    icon: FileDiff,
    label: 'Changes requested',
    tone: 'text-destructive',
  },
  reviewRequired: {
    icon: CircleDashed,
    label: 'Review required',
    tone: 'text-muted-foreground',
  },
} as const satisfies Record<
  PullRequestReviewDecision,
  {
    readonly icon: ComponentType<{ className?: string }>
    readonly label: string
    readonly tone: string
  }
>

/**
 * The review segment: where the pull request stands with its reviewers.
 *
 * The count rides along with the verdict rather than replacing it, because
 * "2 approvals" and "approved" are different facts — a repository wanting
 * two reviews reads the first approval as progress, not as a green light.
 * It is omitted when nobody has approved, where the verdict already says
 * everything the digit would.
 */
function ReviewDecisionSegment({
  approvals,
  conversationWorkspaceId,
  decision,
  onOpenConversation,
  prUrl,
}: {
  readonly approvals: number | null
  readonly conversationWorkspaceId: string | undefined
  readonly decision: PullRequestReviewDecision
  readonly onOpenConversation: (() => void) | undefined
  readonly prUrl: string | null
}) {
  const presentation = REVIEW_DECISION_PRESENTATION[decision]
  const approvalCount = approvals ?? 0
  const description =
    approvalCount === 0
      ? presentation.label
      : `${presentation.label} · ${approvalCount} ${
          approvalCount === 1 ? 'approval' : 'approvals'
        }`
  const body = (
    <>
      <presentation.icon className="size-3 shrink-0" />
      {approvalCount === 0 ? null : (
        <span className="tabular-nums">{approvalCount}</span>
      )}
    </>
  )

  return (
    <ConversationSegment
      body={body}
      conversationWorkspaceId={conversationWorkspaceId}
      description={description}
      onOpenConversation={onOpenConversation}
      segmentClass={cn(SEGMENT_CLASS, presentation.tone)}
      // Reviews are submitted and read on the conversation tab, so that is
      // where GitHub is entered.
      segmentUrl={prUrl}
    />
  )
}

/**
 * The conversation segment: how many review threads are still open.
 *
 * The count is threads, not comments, because a thread is the unit anyone
 * resolves — a long argument that ended in agreement is one settled thread,
 * and counting its replies would invent work that is already done.
 *
 * It only appears while something is outstanding. A pull request with every
 * conversation resolved has nothing to report, and a permanent zero would
 * cost the pill width to say so.
 */
function UnresolvedThreadsSegment({
  count,
  conversationWorkspaceId,
  onOpenConversation,
  prUrl,
}: {
  readonly count: number
  readonly conversationWorkspaceId: string | undefined
  readonly onOpenConversation: (() => void) | undefined
  readonly prUrl: string | null
}) {
  const description = `${count} unresolved ${count === 1 ? 'conversation' : 'conversations'}`
  const body = (
    <>
      <MessageSquareDot className="size-3 shrink-0" />
      <span className="tabular-nums">{count}</span>
    </>
  )

  return (
    <ConversationSegment
      body={body}
      conversationWorkspaceId={conversationWorkspaceId}
      description={description}
      onOpenConversation={onOpenConversation}
      // Muted rather than amber, because an unresolved thread is a fact and
      // not a verdict — nothing is wrong, someone is just waiting. Amber is
      // already spoken for by a running check, and two adjacent amber
      // segments meaning unrelated things is exactly the pile of colors this
      // pill exists to avoid.
      segmentClass={cn(SEGMENT_CLASS, 'text-muted-foreground')}
      // Threads are answered on the diff, so that is where GitHub is entered.
      segmentUrl={prUrl === null ? null : `${prUrl}/files`}
    />
  )
}

const isOpenState = (prState: string | null): boolean =>
  prState !== 'MERGED' && prState !== 'CLOSED'

/**
 * Draft is a state of its own, not a quieter kind of open.
 *
 * A draft is open in GitHub's data, but it is not the same offer: nobody is
 * asked for a review until it is marked ready, and the merge button refuses
 * it either way. Presenting it as green "open" would promise both. Naming it
 * is also what makes the withheld review segment legible — silence alone
 * would leave a draft looking like a pull request nobody was asked to review.
 *
 * A draft that was closed is closed; the state it ended in outranks the one
 * it was written in.
 */
const isDraftState = (prState: string | null, prIsDraft: boolean): boolean =>
  prIsDraft && isOpenState(prState)

function PrStateIcon({
  prIsDraft,
  prState,
  className,
}: {
  readonly prIsDraft: boolean
  readonly prState: string | null
  readonly className?: string | undefined
}) {
  if (prState === 'MERGED') {
    return <GitMerge className={cn('text-purple-500', className)} />
  }
  if (prState === 'CLOSED') {
    return (
      <GitPullRequestClosed className={cn('text-destructive', className)} />
    )
  }
  if (prIsDraft) {
    return (
      <GitPullRequestDraft className={cn('text-muted-foreground', className)} />
    )
  }
  return <GitPullRequest className={cn('text-success', className)} />
}

function getPrStateLabel(prState: string | null, prIsDraft: boolean): string {
  if (prState === 'MERGED') {
    return 'merged'
  }
  if (prState === 'CLOSED') {
    return 'closed'
  }
  return prIsDraft ? 'draft' : 'open'
}

function getPrStateClasses(prState: string | null, prIsDraft: boolean): string {
  if (prState === 'MERGED') {
    return 'border-purple-500/30 bg-purple-500/10 text-purple-500'
  }
  if (prState === 'CLOSED') {
    return 'border-destructive/30 bg-destructive/10 text-destructive'
  }
  if (prIsDraft) {
    return 'border-muted-foreground/30 bg-muted-foreground/10 text-muted-foreground'
  }
  return 'border-success/30 bg-success/10 text-success'
}

function GitHubPrStatusBadge({
  approvals = null,
  className,
  checkStatus,
  checks,
  conversationWorkspaceId,
  onOpenConversation,
  prIsDraft = false,
  prNumber,
  prState,
  prTitle,
  prUrl,
  reviewDecision = null,
  unresolvedThreads = null,
}: GitHubPrStatusBadgeProps) {
  if (prNumber == null && prState == null && prUrl == null) {
    return null
  }

  const isDraft = isDraftState(prState, prIsDraft)
  const handleClick = openInBrowser(prUrl ?? '')
  const previewsOnUnresolvedThread =
    unresolvedThreads != null && unresolvedThreads > 0

  const identityContent = (
    <>
      <PrStateIcon className="size-3" prIsDraft={isDraft} prState={prState} />
      {prNumber != null && <span>#{prNumber}</span>}
      <span>{getPrStateLabel(prState, isDraft)}</span>
    </>
  )

  const identityClassName =
    'inline-flex items-center gap-1 px-1.5 py-0.5 transition-colors hover:bg-accent'

  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-stretch overflow-hidden rounded-md border font-mono text-xs',
        getPrStateClasses(prState, isDraft),
        className
      )}
      data-slot="pr-status-badge"
    >
      <Tooltip>
        <TooltipTrigger>
          {prUrl ? (
            <a
              className={identityClassName}
              href={prUrl}
              onClick={handleClick}
              rel="noopener noreferrer"
              target="_blank"
            >
              {identityContent}
            </a>
          ) : (
            <span className={identityClassName}>{identityContent}</span>
          )}
        </TooltipTrigger>
        <TooltipContent>{prTitle ?? 'GitHub pull request'}</TooltipContent>
      </Tooltip>
      {checkStatus == null ? null : (
        <GitHubCheckRunsSegment
          checkStatus={checkStatus}
          checks={checks ?? null}
          checksUrl={prUrl === null ? null : `${prUrl}/checks`}
        />
      )}
      {/* Only a pull request actually asking for review is waiting on its
          reviewers. On one already merged or closed the verdict is history,
          and a green check beside a purple "merged" would read as a second,
          quieter state. A draft has not asked yet — GitHub withholds the
          automatic request until it is marked ready — so "Review required"
          there would invent a reviewer nobody notified. */}
      {reviewDecision === null || isDraft || !isOpenState(prState) ? null : (
        <ReviewDecisionSegment
          approvals={approvals}
          conversationWorkspaceId={
            previewsOnUnresolvedThread ? undefined : conversationWorkspaceId
          }
          decision={reviewDecision}
          onOpenConversation={onOpenConversation}
          prUrl={prUrl}
        />
      )}
      {unresolvedThreads != null && unresolvedThreads > 0 && (
        <UnresolvedThreadsSegment
          conversationWorkspaceId={conversationWorkspaceId}
          count={unresolvedThreads}
          onOpenConversation={onOpenConversation}
          prUrl={prUrl}
        />
      )}
    </span>
  )
}

export { GitHubPrStatusBadge }
