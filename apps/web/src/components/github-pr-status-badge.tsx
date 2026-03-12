import { GitMerge, GitPullRequest, GitPullRequestClosed } from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface GitHubPrStatusBadgeProps {
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
  prNumber,
  prState,
  prTitle,
  prUrl,
}: GitHubPrStatusBadgeProps) {
  if (prNumber == null && prState == null && prUrl == null) {
    return null
  }

  const content = (
    <>
      <PrStateIcon className="size-3" prState={prState} />
      {prNumber != null && <span>#{prNumber}</span>}
      <span>{getPrStateLabel(prState)}</span>
    </>
  )

  const badgeClassName = cn(
    'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-xs transition-colors hover:bg-accent',
    getPrStateClasses(prState),
    className
  )

  return (
    <Tooltip>
      <TooltipTrigger>
        {prUrl ? (
          <a
            className={badgeClassName}
            href={prUrl}
            rel="noopener"
            target="_blank"
          >
            {content}
          </a>
        ) : (
          <span className={badgeClassName}>{content}</span>
        )}
      </TooltipTrigger>
      <TooltipContent>{prTitle ?? 'GitHub pull request'}</TooltipContent>
    </Tooltip>
  )
}

export { GitHubPrStatusBadge }
