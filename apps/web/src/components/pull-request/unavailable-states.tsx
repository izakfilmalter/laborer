/**
 * Error and empty states for the pull request panel, ported from t3code's
 * `PullRequestsUnavailableState` and `PullRequestActivityUnavailableState`.
 *
 * Laborer adds the missing-pull-request empty state here too: a branch
 * without a pull request is the ordinary condition of new work, not a
 * failure the reader should have to interpret (`PR_NOT_FOUND`).
 */
import { Button } from '@laborer/ui/components/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@laborer/ui/components/empty'
import { cn } from '@laborer/ui/lib/utils'
import { ExternalLink, GitPullRequest, RefreshCw } from 'lucide-react'
import { GitHubLink } from './external-links'

export function PullRequestUnavailableState({
  title = 'Could not load the pull request',
  error,
  onRetry,
  gitHubUrl,
}: {
  title?: string
  error: string
  onRetry?: () => void
  gitHubUrl?: string | undefined
}) {
  return (
    <Empty className="px-4 py-16 md:px-4">
      <EmptyMedia variant="icon">
        <GitPullRequest />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        {/* The caller names the fix — install gh, sign in — so this shows
            its message rather than inferring one from the failure text. */}
        <EmptyDescription>{error}</EmptyDescription>
      </EmptyHeader>
      {onRetry || gitHubUrl ? (
        <EmptyContent className="flex-row flex-wrap justify-center gap-2">
          {onRetry ? (
            <Button onClick={onRetry} size="sm" variant="outline">
              <RefreshCw className="size-3.5" />
              Retry
            </Button>
          ) : null}
          {gitHubUrl ? (
            <GitHubLink
              className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2.5 font-medium text-xs hover:bg-muted"
              href={gitHubUrl}
            >
              <ExternalLink aria-hidden className="size-3.5" />
              Open on GitHub
            </GitHubLink>
          ) : null}
        </EmptyContent>
      ) : null}
    </Empty>
  )
}

export function PullRequestActivityUnavailableState({
  error,
  onRetry,
  compact = false,
}: {
  error: string
  onRetry: () => void
  compact?: boolean
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 text-center',
        compact ? 'py-3' : 'min-h-48 px-4 py-10'
      )}
    >
      <p className="font-medium text-foreground text-sm">
        Could not load pull request activity
      </p>
      <p className="max-w-md text-muted-foreground text-xs">{error}</p>
      <Button onClick={onRetry} size="sm" variant="outline">
        <RefreshCw aria-hidden className="size-3.5" />
        Retry
      </Button>
    </div>
  )
}

/** A branch without a pull request: the normal state of unopened work. */
export function PullRequestMissingState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <GitPullRequest />
          </EmptyMedia>
          <EmptyTitle>No pull request yet</EmptyTitle>
          <EmptyDescription>
            Open a pull request for this branch and it will appear here.
          </EmptyDescription>
        </EmptyHeader>
        <Button onClick={onRetry} size="sm" variant="outline">
          <RefreshCw className="size-3.5" />
          Check again
        </Button>
      </Empty>
    </div>
  )
}
