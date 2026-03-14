/**
 * ReviewFindingsCount — shows the count of unresolved review findings.
 *
 * Fetches comments via the `review.fetchComments` RPC and counts findings
 * that are not resolved (no thumbs_up or confused reactions). Renders a
 * compact badge with the count, or nothing when there are no unresolved
 * findings or the fetch fails.
 *
 * The component self-manages its data fetching so consumers only need to
 * pass `workspaceId`.
 *
 * Also exports `useUnresolvedFindingsCount` for use in components that
 * need the raw count (e.g., the workspace frame header review button).
 *
 * @see components/review-verdict-badge.tsx — similar self-fetching pattern
 */

import { useAtomValue } from '@effect-atom/atom-react/Hooks'
import type { PrCommentReaction } from '@laborer/shared/rpc'
import { ClipboardCheck } from 'lucide-react'
import { useMemo } from 'react'
import { LaborerClient } from '@/atoms/laborer-client'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface ReviewFindingsCountProps {
  readonly className?: string | undefined
  readonly workspaceId: string
}

/**
 * Whether a finding is "resolved" — has a thumbs_up (fixed) or confused
 * (won't-fix) reaction.
 */
function isResolved(reactions: readonly PrCommentReaction[]): boolean {
  return reactions.some(
    (r) => r.content === 'thumbs_up' || r.content === 'confused'
  )
}

/**
 * Hook to fetch and compute the number of unresolved review findings.
 * Must be rendered inside a Suspense boundary.
 */
function useUnresolvedFindingsCount(workspaceId: string): number {
  const reviewComments$ = useMemo(
    () => LaborerClient.query('review.fetchComments', { workspaceId }),
    [workspaceId]
  )
  const result = useAtomValue(reviewComments$)

  if (result._tag !== 'Success') {
    return 0
  }

  return result.value.findings.filter((f) => !isResolved(f.reactions)).length
}

function ReviewFindingsCount({
  className,
  workspaceId,
}: ReviewFindingsCountProps) {
  const unresolvedCount = useUnresolvedFindingsCount(workspaceId)

  if (unresolvedCount === 0) {
    return null
  }

  return (
    <Tooltip>
      <TooltipTrigger>
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-md border border-orange-500/30 bg-orange-500/10 px-1.5 py-0.5 font-mono text-orange-600 text-xs dark:bg-orange-500/20 dark:text-orange-400',
            className
          )}
          data-count={unresolvedCount}
          data-testid="review-findings-count"
        >
          <ClipboardCheck className="size-3" />
          {unresolvedCount}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {unresolvedCount} unresolved review{' '}
        {unresolvedCount === 1 ? 'finding' : 'findings'}
      </TooltipContent>
    </Tooltip>
  )
}

export { ReviewFindingsCount, useUnresolvedFindingsCount }
