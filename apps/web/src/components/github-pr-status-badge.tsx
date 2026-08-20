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
import type { MouseEvent } from 'react'
import { GitHubCheckRunsSegment } from '@/components/github-check-runs'
import { localApi } from '@/lib/local-api'

interface GitHubPrStatusBadgeProps {
  readonly checkStatus?: 'pending' | 'success' | 'failure' | null | undefined
  readonly checks?: readonly PullRequestCheckRun[] | null | undefined
  readonly className?: string | undefined
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
  prUrl,
}: {
  readonly count: number
  readonly prUrl: string | null
}) {
  const label = `${count} unresolved ${count === 1 ? 'conversation' : 'conversations'}`
  // The seam matches the checks segment: neutral and barely there, so the
  // pill still reads as one object rather than a row of chips.
  const segmentClass =
    'flex items-center gap-1 border-foreground/15 border-l px-1.5 text-warning transition-colors hover:bg-accent'
  const body = (
    <>
      <MessageSquareDot className="size-3 shrink-0" />
      <span className="tabular-nums">{count}</span>
    </>
  )

  // Threads are answered on the diff, so that is where the segment goes.
  const threadsUrl = prUrl === null ? null : `${prUrl}/files`

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          threadsUrl === null ? (
            <button aria-label={label} className={segmentClass} type="button">
              {body}
            </button>
          ) : (
            <a
              aria-label={label}
              className={segmentClass}
              href={threadsUrl}
              onClick={openInBrowser(threadsUrl)}
              rel="noopener"
              target="_blank"
            >
              {body}
            </a>
          )
        }
      />
      <TooltipContent>{label}</TooltipContent>
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
              rel="noopener"
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
        <UnresolvedThreadsSegment count={unresolvedThreads} prUrl={prUrl} />
      )}
    </span>
  )
}

export { GitHubPrStatusBadge }
