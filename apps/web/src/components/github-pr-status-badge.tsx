/**
 * The pull request as one pill.
 *
 * Identity on the left — number and state — and, hung off the same border,
 * whatever the pull request is still waiting on: CI health, and any review
 * threads nobody has resolved. They are one fact read at several depths: the
 * PR is where the work went, the checks are whether it survived the trip,
 * and the conversations are who is still waiting on an answer. Splitting
 * them into loose chips made the status rail read as a pile of colors.
 */

import type { PullRequestCheckRun } from '@laborer/shared/rpc'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@laborer/ui/components/tooltip'
import { cn } from '@laborer/ui/lib/utils'
import {
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  MessageSquareDot,
} from 'lucide-react'
import type { MouseEvent, ReactElement, ReactNode } from 'react'
import { GitHubCheckRunsSegment } from '@/components/github-check-runs'
import { localApi } from '@/lib/local-api'

interface GitHubPrStatusBadgeProps {
  readonly checkStatus?: 'pending' | 'success' | 'failure' | null | undefined
  readonly checks?: readonly PullRequestCheckRun[] | null | undefined
  readonly className?: string | undefined
  /**
   * Opens the conversation where the operator already is, when the surface
   * has somewhere to open it. Absent on surfaces standing in for a workspace
   * that does not exist yet — a board card for unstarted work has no pane to
   * show — and the segment falls back to GitHub in the browser rather than
   * inventing one.
   */
  readonly onOpenConversation?: (() => void) | undefined
  readonly prNumber: number | null
  readonly prState: string | null
  readonly prTitle: string | null
  readonly prUrl: string | null
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
  threadsUrl: string | null
): string | null {
  if (opensConversation) {
    return 'Open PR comments'
  }
  if (threadsUrl === null) {
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
  threadsUrl,
}: {
  readonly body: ReactNode
  readonly className: string
  readonly description: string
  readonly onOpenConversation: (() => void) | undefined
  readonly openConversation: (event: MouseEvent) => Promise<void>
  readonly threadsUrl: string | null
}): ReactElement {
  // Only something clickable lights up under the pointer.
  const interactiveClassName = cn(
    className,
    'transition-colors hover:bg-accent'
  )

  if (threadsUrl === null) {
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
      href={threadsUrl}
      onClick={
        onOpenConversation === undefined
          ? openInBrowser(threadsUrl)
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
 * The conversation segment: how many review threads are still open.
 *
 * The count is threads, not comments, because a thread is the unit anyone
 * resolves — a long argument that ended in agreement is one settled thread,
 * and counting its replies would invent work that is already done.
 *
 * It only appears while something is outstanding. A pull request with every
 * conversation resolved has nothing to report, and a permanent zero would
 * cost the pill width to say so.
 *
 * Clicking it stays in the app. The conversation it counts already has a
 * pane, and handing the operator to a browser tab would step straight over
 * the thing they asked for. GitHub remains one modifier click away, and owns
 * the plain click on surfaces that have no pane to open.
 */
function UnresolvedThreadsSegment({
  count,
  onOpenConversation,
  prUrl,
}: {
  readonly count: number
  readonly onOpenConversation: (() => void) | undefined
  readonly prUrl: string | null
}) {
  const description = `${count} unresolved ${count === 1 ? 'conversation' : 'conversations'}`
  // The seam matches the checks segment: neutral and barely there, so the
  // pill still reads as one object rather than a row of chips.
  //
  // Muted rather than amber, because an unresolved thread is a fact and not
  // a verdict — nothing is wrong, someone is just waiting. Amber is already
  // spoken for by a running check, and two adjacent amber segments meaning
  // unrelated things is exactly the pile of colors this pill exists to
  // avoid. Muted is also what the checks segment gives its own no-verdict
  // buckets, and it stays legible on all three state tints in both themes.
  const segmentClass =
    'flex items-center gap-1 border-foreground/15 border-l px-1.5 text-muted-foreground'
  const body = (
    <>
      <MessageSquareDot className="size-3 shrink-0" />
      <span className="tabular-nums">{count}</span>
    </>
  )

  // Threads are answered on the diff, so that is where GitHub is entered.
  const threadsUrl = prUrl === null ? null : `${prUrl}/files`
  const actionHint = getSegmentActionHint(
    onOpenConversation !== undefined,
    threadsUrl
  )

  const openConversation = async (event: MouseEvent) => {
    if (onOpenConversation === undefined) {
      return
    }
    if (threadsUrl !== null && opensElsewhere(event)) {
      await openInBrowser(threadsUrl)(event)
      return
    }
    event.preventDefault()
    onOpenConversation()
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={renderSegmentTrigger({
          body,
          className: segmentClass,
          description,
          onOpenConversation,
          openConversation,
          threadsUrl,
        })}
      />
      <TooltipContent>
        {description}
        {actionHint === null ? null : (
          <span className="text-tooltip-foreground/60">{actionHint}</span>
        )}
      </TooltipContent>
    </Tooltip>
  )
}

function PrStateIcon({
  prState,
  className,
}: {
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
  return <GitPullRequest className={cn('text-success', className)} />
}

function getPrStateLabel(prState: string | null): string {
  if (prState === 'MERGED') {
    return 'merged'
  }
  if (prState === 'CLOSED') {
    return 'closed'
  }
  return 'open'
}

function getPrStateClasses(prState: string | null): string {
  if (prState === 'MERGED') {
    return 'border-purple-500/30 bg-purple-500/10 text-purple-500'
  }
  if (prState === 'CLOSED') {
    return 'border-destructive/30 bg-destructive/10 text-destructive'
  }
  return 'border-success/30 bg-success/10 text-success'
}

function GitHubPrStatusBadge({
  className,
  checkStatus,
  checks,
  onOpenConversation,
  prNumber,
  prState,
  prTitle,
  prUrl,
  unresolvedThreads = null,
}: GitHubPrStatusBadgeProps) {
  if (prNumber == null && prState == null && prUrl == null) {
    return null
  }

  const handleClick = openInBrowser(prUrl ?? '')

  const identityContent = (
    <>
      <PrStateIcon className="size-3" prState={prState} />
      {prNumber != null && <span>#{prNumber}</span>}
      <span>{getPrStateLabel(prState)}</span>
    </>
  )

  const identityClassName =
    'inline-flex items-center gap-1 px-1.5 py-0.5 transition-colors hover:bg-accent'

  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-stretch overflow-hidden rounded-md border font-mono text-xs',
        getPrStateClasses(prState),
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
      {unresolvedThreads != null && unresolvedThreads > 0 && (
        <UnresolvedThreadsSegment
          count={unresolvedThreads}
          onOpenConversation={onOpenConversation}
          prUrl={prUrl}
        />
      )}
    </span>
  )
}

export { GitHubPrStatusBadge }
