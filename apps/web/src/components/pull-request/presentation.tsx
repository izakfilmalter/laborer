/**
 * Shared presentational pieces for the pull request panel, ported from
 * t3code's `pullRequestPresentation.tsx`.
 *
 * Laborer adaptations: tooltips use `TooltipContent`, badges take tone
 * classes over the outline variant (Laborer's Badge has no success/error
 * variants), and the checks-state rollup type lives here because Laborer's
 * contracts do not carry a server-computed rollup.
 */
import type {
  PullRequestActor,
  PullRequestCheck,
  PullRequestCheckStatus,
  PullRequestMergeability,
  PullRequestState,
} from '@laborer/shared/rpc'
import { Badge } from '@laborer/ui/components/badge'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@laborer/ui/components/tooltip'
import { cn } from '@laborer/ui/lib/utils'
import {
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleX,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Loader,
  TriangleAlert,
} from 'lucide-react'
import { Children, isValidElement, type ReactNode } from 'react'
import type { PullRequestReviewOutcome } from './detail-logic'

interface StatePresentation {
  readonly Icon: typeof GitPullRequest
  readonly label: string
  readonly toneClassName: string
}

/**
 * How a pull request's state reads on this panel. Draft outranks
 * conflicts: a draft is not heading for a merge yet.
 */
export function resolvePullRequestState(input: {
  readonly state: PullRequestState
  readonly isDraft: boolean
  readonly mergeability?: PullRequestMergeability
  readonly baseBranch?: string
}): StatePresentation {
  if (input.state === 'merged') {
    return {
      label: 'Merged',
      toneClassName: 'text-violet-600 dark:text-violet-300/90',
      Icon: GitMerge,
    }
  }
  if (input.state === 'closed') {
    return {
      label: 'Closed',
      toneClassName: 'text-red-600 dark:text-red-300/90',
      Icon: GitPullRequestClosed,
    }
  }
  if (input.isDraft) {
    return {
      label: 'Draft',
      toneClassName: 'text-zinc-500 dark:text-zinc-400/80',
      Icon: GitPullRequestDraft,
    }
  }
  if (input.mergeability === 'conflicting') {
    return {
      label: input.baseBranch
        ? `Conflicts with ${input.baseBranch}`
        : 'Has conflicts',
      toneClassName: 'text-destructive',
      Icon: TriangleAlert,
    }
  }
  return {
    label: 'Open',
    toneClassName: 'text-emerald-600 dark:text-emerald-300/90',
    Icon: GitPullRequest,
  }
}

const CHECK_STATUS_PRESENTATION = {
  pending: {
    label: 'Running',
    Icon: Loader,
    toneClassName: 'animate-spin text-amber-500',
  },
  success: {
    label: 'Passed',
    Icon: CircleCheck,
    toneClassName: 'text-emerald-600 dark:text-emerald-300/90',
  },
  failure: {
    label: 'Failed',
    Icon: CircleX,
    toneClassName: 'text-destructive',
  },
  cancelled: {
    label: 'Cancelled',
    Icon: CircleX,
    toneClassName: 'text-destructive',
  },
  skipped: {
    label: 'Skipped',
    Icon: CircleDashed,
    toneClassName: 'text-muted-foreground/70',
  },
  neutral: {
    label: 'Neutral',
    Icon: CircleDashed,
    toneClassName: 'text-muted-foreground/70',
  },
} as const satisfies Record<
  PullRequestCheckStatus,
  { label: string; Icon: typeof CircleCheck; toneClassName: string }
>

export function pullRequestCheckStatusLabel(
  status: PullRequestCheckStatus
): string {
  return CHECK_STATUS_PRESENTATION[status].label
}

export function PullRequestCheckStatusIcon({
  status,
}: {
  status: PullRequestCheckStatus
}) {
  const presentation = CHECK_STATUS_PRESENTATION[status]
  return (
    <presentation.Icon
      aria-hidden
      className={cn('size-3.5 shrink-0', presentation.toneClassName)}
    />
  )
}

/** The one-word rollup of a change's checks, as GitHub's own header words it. */
export type PullRequestChecksState = 'passing' | 'failing' | 'pending'

const CHECKS_STATE_PRESENTATION = {
  passing: {
    label: 'All checks have passed',
    Icon: CircleCheck,
    toneClassName: 'text-emerald-600 dark:text-emerald-300/90',
  },
  failing: {
    label: 'Some checks were not successful',
    Icon: CircleX,
    toneClassName: 'text-destructive',
  },
  pending: {
    label: "Some checks haven't completed yet",
    Icon: CircleDot,
    toneClassName: 'text-amber-600 dark:text-amber-400/90',
  },
} as const satisfies Record<
  PullRequestChecksState,
  { label: string; Icon: typeof CircleCheck; toneClassName: string }
>

export function pullRequestChecksStatePresentation(
  state: PullRequestChecksState
) {
  return CHECKS_STATE_PRESENTATION[state]
}

/**
 * The rollup, worked out from the checks the detail already holds. Null for
 * a change with no checks: nothing to show beats a tick nobody earned.
 */
export function pullRequestChecksState(
  checks: readonly PullRequestCheck[]
): PullRequestChecksState | null {
  if (checks.length === 0) {
    return null
  }
  const statuses = checks.map((check) => check.status)
  if (statuses.includes('failure') || statuses.includes('cancelled')) {
    return 'failing'
  }
  if (statuses.includes('pending')) {
    return 'pending'
  }
  return statuses.includes('success') ? 'passing' : null
}

/**
 * How a verdict reads, in the one place every surface takes it from. The
 * green is the green a passing check already wears in the same panel.
 */
const REVIEW_OUTCOME_PRESENTATION = {
  approved: {
    label: 'Approved',
    Icon: CircleCheck,
    toneClassName: 'text-emerald-600 dark:text-emerald-300/90',
    ringClassName: 'ring-2 ring-emerald-500 dark:ring-emerald-400',
    staleRingClassName:
      'ring-2 ring-[color-mix(in_srgb,var(--color-emerald-500)_35%,var(--background))] dark:ring-[color-mix(in_srgb,var(--color-emerald-400)_35%,var(--background))]',
    badgeToneClassName: 'border-success/25 bg-success/10 text-success',
  },
  'changes-requested': {
    label: 'Changes requested',
    Icon: CircleX,
    toneClassName: 'text-destructive',
    ringClassName: 'ring-2 ring-destructive',
    staleRingClassName:
      'ring-2 ring-[color-mix(in_srgb,var(--destructive)_35%,var(--background))]',
    badgeToneClassName:
      'border-destructive/25 bg-destructive/10 text-destructive',
  },
  dismissed: {
    label: 'Review dismissed',
    Icon: CircleDashed,
    toneClassName: 'text-muted-foreground/70',
    ringClassName: 'ring-2 ring-muted-foreground/60',
    staleRingClassName:
      'ring-2 ring-[color-mix(in_srgb,var(--muted-foreground)_30%,var(--background))]',
    badgeToneClassName: 'border-border/70 bg-muted/40 text-muted-foreground',
  },
} as const satisfies Record<
  PullRequestReviewOutcome,
  {
    label: string
    Icon: typeof CircleCheck
    toneClassName: string
    ringClassName: string
    staleRingClassName: string
    badgeToneClassName: string
  }
>

export function pullRequestReviewOutcomeToneClassName(
  outcome: PullRequestReviewOutcome
): string {
  return REVIEW_OUTCOME_PRESENTATION[outcome].toneClassName
}

/** Worn by whatever wraps a reviewer's avatar, so their verdict reads inline. */
export function pullRequestReviewOutcomeRingClassName(
  outcome: PullRequestReviewOutcome,
  stale = false
): string {
  const presentation = REVIEW_OUTCOME_PRESENTATION[outcome]
  return stale ? presentation.staleRingClassName : presentation.ringClassName
}

/** What a superseded verdict says: the same word with when it applied added. */
export function pullRequestReviewOutcomeStaleLabel(
  outcome: PullRequestReviewOutcome
): string {
  return `${REVIEW_OUTCOME_PRESENTATION[outcome].label} earlier changes`
}

/** Decorative: every caller says which verdict this is in words beside it. */
export function PullRequestReviewOutcomeIcon({
  outcome,
  className,
}: {
  outcome: PullRequestReviewOutcome
  className?: string
}) {
  const presentation = REVIEW_OUTCOME_PRESENTATION[outcome]
  return (
    <presentation.Icon
      aria-hidden
      className={cn('size-3.5 shrink-0', presentation.toneClassName, className)}
    />
  )
}

export function pullRequestReviewOutcomeLabel(
  outcome: PullRequestReviewOutcome
): string {
  return REVIEW_OUTCOME_PRESENTATION[outcome].label
}

export function PullRequestReviewOutcomeBadge({
  outcome,
  className,
}: {
  outcome: PullRequestReviewOutcome
  className?: string
}) {
  const presentation = REVIEW_OUTCOME_PRESENTATION[outcome]
  return (
    <Badge
      className={cn(
        'h-5 gap-1 px-1.5 text-[10px]',
        presentation.badgeToneClassName,
        className
      )}
      variant="outline"
    >
      <presentation.Icon aria-hidden className="size-3" />
      {presentation.label}
    </Badge>
  )
}

export function PullRequestActorAvatar({
  actor,
  className,
}: {
  actor: PullRequestActor | null
  className?: string
}) {
  const login = actor?.login ?? 'ghost'
  const avatarUrl = actor?.avatarUrl ?? null
  return avatarUrl === null ? (
    // Not every account reports an avatar, so the initial stands in.
    <span
      aria-hidden
      className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded-full bg-muted font-medium text-[8px] text-muted-foreground',
        className
      )}
    >
      {login.slice(0, 1).toUpperCase()}
    </span>
  ) : (
    // biome-ignore lint/correctness/useImageSize: the avatar is sized by its class; GitHub avatars have no intrinsic size worth naming.
    <img
      alt=""
      aria-hidden
      className={cn(
        'size-4 shrink-0 rounded-full bg-muted object-cover',
        className
      )}
      loading="lazy"
      src={avatarUrl}
    />
  )
}

/** GitHub attributes work from a deleted account to "ghost"; say the same word everywhere. */
export function PullRequestActorLabel({
  actor,
  className,
  tooltip = true,
}: {
  actor: PullRequestActor | null
  className?: string
  tooltip?: boolean
}) {
  const login = actor?.login ?? 'ghost'
  const label = (
    <>
      <PullRequestActorAvatar actor={actor} />
      <span className="truncate">{login}</span>
    </>
  )
  if (!tooltip) {
    return (
      <span className={cn('flex min-w-0 items-center gap-1.5', className)}>
        {label}
      </span>
    )
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn('flex min-w-0 items-center gap-1.5', className)}
          />
        }
      >
        {label}
      </TooltipTrigger>
      <TooltipContent side="top">{login}</TooltipContent>
    </Tooltip>
  )
}

/** Added and removed lines, coloured the way every host colours them. */
export function PullRequestDiffStat({
  additions,
  deletions,
  className,
}: {
  additions: number
  deletions: number
  className?: string
}) {
  // "+0 -0" would read as an empty change set rather than a missing one.
  if (additions === 0 && deletions === 0) {
    return null
  }
  return (
    <span
      className={cn('inline-flex items-baseline gap-1 tabular-nums', className)}
    >
      <span className="text-emerald-600 dark:text-emerald-300/90">
        +{additions.toLocaleString()}
      </span>
      <span className="text-destructive">-{deletions.toLocaleString()}</span>
    </span>
  )
}

/**
 * Dot-separated metadata. It owns the separator, and draws one only
 * between the segments that survive.
 */
function separatorKey(segment: ReactNode): string {
  return `separator:${isValidElement(segment) ? String(segment.key) : String(segment)}`
}

export function PullRequestMetaLine({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  const segments = Children.toArray(children)
  return (
    <span className={cn('flex min-w-0 items-center gap-1.5', className)}>
      {segments.flatMap((segment, index) =>
        index === 0
          ? segment
          : [
              <span
                aria-hidden
                className="shrink-0 text-muted-foreground/50"
                key={separatorKey(segment)}
              >
                ·
              </span>,
              segment,
            ]
      )}
    </span>
  )
}

export function summarizePullRequestChecks(
  checks: readonly PullRequestCheck[]
): string {
  if (checks.length === 0) {
    return 'No checks reported'
  }
  const failed = checks.filter(
    (check) => check.status === 'failure' || check.status === 'cancelled'
  ).length
  const pending = checks.filter((check) => check.status === 'pending').length
  const passed = checks.filter((check) => check.status === 'success').length
  if (failed > 0) {
    return `${failed} of ${checks.length} failing`
  }
  if (pending > 0) {
    return `${pending} of ${checks.length} running`
  }
  return passed === checks.length
    ? 'All checks passed'
    : `${passed} of ${checks.length} passing`
}
