/**
 * Merge conflicts, reduced to a mark.
 *
 * A conflict is rare, binary, and always says the same sentence, so it costs
 * a chip's worth of the status rail to repeat that sentence on the few cards
 * that have one. It sits last — after the pull request and the workspace's own
 * state — because it is an obstacle to landing work, not a stage of it, and
 * carries its full sentence in a tooltip.
 */

import { GitCompareArrows } from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

function GitHubMergeConflictMark({
  baseBranch,
  mergeStatus,
}: {
  readonly baseBranch: string | null
  readonly mergeStatus: 'clean' | 'conflicting' | 'unknown' | null
}) {
  if (mergeStatus !== 'conflicting') {
    return null
  }

  const label = `Conflicts with ${baseBranch ?? 'the base branch'}`

  return (
    <Tooltip>
      <TooltipTrigger>
        <span
          aria-label={label}
          className="inline-flex size-5 shrink-0 items-center justify-center rounded-md border border-destructive/30 bg-destructive/10 text-destructive"
          role="img"
        >
          <GitCompareArrows aria-hidden="true" className="size-3" />
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

export { GitHubMergeConflictMark }
