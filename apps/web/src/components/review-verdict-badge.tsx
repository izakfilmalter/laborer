/**
 * ReviewVerdictBadge — shows the brrr review verdict on workspace cards.
 *
 * Fetches the verdict via the lightweight `review.fetchVerdict` RPC and
 * renders a compact badge: green checkmark for "approved", red X for
 * "needs_fix", and nothing when no review exists or the fetch fails.
 *
 * The component self-manages its data fetching so the workspace card
 * only needs to pass `workspaceId`.
 *
 * @see docs/review-findings-panel/PRD-review-findings-panel.md — "Verdict Badge Data Source"
 * @see Issue #7: Verdict badge on workspace card
 */

import { useAtomValue } from '@effect-atom/atom-react/Hooks'
import type { ReviewVerdict } from '@laborer/shared/rpc'
import { Check, X } from 'lucide-react'
import { useMemo } from 'react'
import { LaborerClient } from '@/atoms/laborer-client'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface ReviewVerdictBadgeProps {
  readonly className?: string | undefined
  readonly workspaceId: string
}

function getVerdictConfig(verdict: ReviewVerdict): {
  className: string
  icon: typeof Check
  label: string
} {
  if (verdict === 'approved') {
    return {
      icon: Check,
      label: 'Review: approved',
      className: 'border-success/30 bg-success/10 text-success',
    }
  }
  return {
    icon: X,
    label: 'Review: needs fix',
    className: 'border-destructive/30 bg-destructive/10 text-destructive',
  }
}

function ReviewVerdictBadge({
  className,
  workspaceId,
}: ReviewVerdictBadgeProps) {
  const verdictAtom$ = useMemo(
    () => LaborerClient.query('review.fetchVerdict', { workspaceId }),
    [workspaceId]
  )
  const result = useAtomValue(verdictAtom$)

  // Only render when we have a successful result with a non-null verdict
  if (result._tag !== 'Success') {
    return null
  }

  const { verdict } = result.value
  if (verdict === null) {
    return null
  }

  const config = getVerdictConfig(verdict)
  const Icon = config.icon

  return (
    <Tooltip>
      <TooltipTrigger>
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-xs',
            config.className,
            className
          )}
          data-testid="review-verdict-badge"
          data-verdict={verdict}
        >
          <Icon className="size-3" />
        </span>
      </TooltipTrigger>
      <TooltipContent>{config.label}</TooltipContent>
    </Tooltip>
  )
}

export { ReviewVerdictBadge }
