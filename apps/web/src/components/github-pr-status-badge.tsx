/**
 * The pull request as one pill, in two segments.
 *
 * Identity on the left — number and state — and CI health on the right, hung
 * off the same border. They are one fact read at two depths: the PR is where
 * the work went, the checks are whether it survived the trip. Splitting them
 * into two loose chips made the status rail read as a pile of colors.
 */

import type { PullRequestCheckRun } from '@laborer/shared/rpc'
import { GitMerge, GitPullRequest, GitPullRequestClosed } from 'lucide-react'
import { GitHubCheckRunsSegment } from '@/components/github-check-runs'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { localApi } from '@/lib/local-api'
import { cn } from '@/lib/utils'

interface GitHubPrStatusBadgeProps {
  readonly checkStatus?: 'pending' | 'success' | 'failure' | null | undefined
  readonly checks?: readonly PullRequestCheckRun[] | null | undefined
  readonly className?: string | undefined
  readonly prNumber: number | null
  readonly prState: string | null
  readonly prTitle: string | null
  readonly prUrl: string | null
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
}: GitHubPrStatusBadgeProps) {
  if (prNumber == null && prState == null && prUrl == null) {
    return null
  }

  const handleClick = async (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!localApi.isDesktop) {
      return
    }

    event.preventDefault()
    await localApi.openExternal(prUrl ?? '')
  }

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
    </span>
  )
}

export { GitHubPrStatusBadge }
