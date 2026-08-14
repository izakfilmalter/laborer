/**
 * The CI half of the pull request pill.
 *
 * The rollup on the pill answers "should I worry"; the card behind it answers
 * "about what". Checks are the one branch fact with real internal structure —
 * a list of named runs grouped by the workflow that produced them — so it is
 * the one fact that earns a surface bigger than a chip.
 */

import type { PullRequestCheckRun } from '@laborer/shared/rpc'
import {
  CircleCheck,
  CircleDashed,
  CircleSlash,
  CircleX,
  LoaderCircle,
} from 'lucide-react'
import type { ComponentType, MouseEvent } from 'react'
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card'
import { isElectron, openExternalUrl } from '@/lib/desktop'
import { cn } from '@/lib/utils'

type CheckStatus = 'pending' | 'success' | 'failure'
type CheckBucket = PullRequestCheckRun['bucket']

const BUCKET_PRESENTATION = {
  cancelled: {
    icon: CircleSlash,
    noun: 'canceled',
    spins: false,
    tone: 'text-muted-foreground',
  },
  failure: {
    icon: CircleX,
    noun: 'failed',
    spins: false,
    tone: 'text-destructive',
  },
  pending: {
    icon: LoaderCircle,
    noun: 'running',
    spins: true,
    tone: 'text-warning',
  },
  skipped: {
    icon: CircleDashed,
    noun: 'skipped',
    spins: false,
    tone: 'text-muted-foreground',
  },
  success: {
    icon: CircleCheck,
    noun: 'passed',
    spins: false,
    tone: 'text-success',
  },
} as const satisfies Record<
  CheckBucket,
  {
    readonly icon: ComponentType<{ className?: string }>
    readonly noun: string
    readonly spins: boolean
    readonly tone: string
  }
>

const ROLLUP_HEADLINE = {
  failure: 'Some checks were not successful',
  pending: 'Checks are still running',
  success: 'All checks passed',
} as const satisfies Record<CheckStatus, string>

/** The rollup reads as one of the buckets, so the pill and the list agree. */
const rollupBucket = (status: CheckStatus): CheckBucket => status

const COUNTED_BUCKETS = [
  'failure',
  'pending',
  'success',
  'cancelled',
  'skipped',
] as const satisfies readonly CheckBucket[]

/** "2 failed · 6 passed · 1 skipped", loudest bucket first. */
function summarize(checks: readonly PullRequestCheckRun[]): string {
  return COUNTED_BUCKETS.flatMap((bucket) => {
    const count = checks.filter((check) => check.bucket === bucket).length
    return count === 0 ? [] : [`${count} ${BUCKET_PRESENTATION[bucket].noun}`]
  }).join(' · ')
}

/** Durations read as a glance, not a stopwatch: 40s, 2m 59s, 1h 4m. */
function formatDuration(durationMs: number): string | null {
  const totalSeconds = Math.round(durationMs / 1000)
  if (totalSeconds < 1) {
    return null
  }
  if (totalSeconds < 60) {
    return `${totalSeconds}s`
  }
  const minutes = Math.floor(totalSeconds / 60)
  if (minutes < 60) {
    return `${minutes}m ${totalSeconds % 60}s`
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

const UNGROUPED = 'Other'

/**
 * Workflows are how GitHub actually organizes runs, so the headings carry
 * information rather than decorating the list. A single group needs no
 * heading — it would name the whole list.
 */
function groupChecks(
  checks: readonly PullRequestCheckRun[]
): readonly (readonly [string, readonly PullRequestCheckRun[]])[] {
  const groups = new Map<string, PullRequestCheckRun[]>()
  for (const check of checks) {
    const key = check.group ?? UNGROUPED
    const existing = groups.get(key)
    if (existing === undefined) {
      groups.set(key, [check])
    } else {
      existing.push(check)
    }
  }
  return [...groups]
}

/** In the desktop shell a check belongs in the OS browser, not in a frame. */
function openInBrowser(url: string) {
  return async (event: MouseEvent<HTMLAnchorElement>) => {
    if (!isElectron()) {
      return
    }
    event.preventDefault()
    await openExternalUrl(url)
  }
}

function BucketIcon({
  bucket,
  className,
}: {
  readonly bucket: CheckBucket
  readonly className?: string | undefined
}) {
  const presentation = BUCKET_PRESENTATION[bucket]
  return (
    <presentation.icon
      className={cn(
        'shrink-0',
        presentation.tone,
        // Motion earns its place only while something is actually moving:
        // a spinning glyph is how a running check differs from a settled one.
        presentation.spins && 'motion-safe:animate-spin',
        className
      )}
    />
  )
}

function CheckRunRow({ check }: { readonly check: PullRequestCheckRun }) {
  const duration =
    check.durationMs === null ? null : formatDuration(check.durationMs)
  const body = (
    <>
      <BucketIcon bucket={check.bucket} className="size-3.5" />
      <span className="min-w-0 flex-1 truncate">{check.name}</span>
      {duration === null ? null : (
        <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
          {duration}
        </span>
      )}
    </>
  )
  const rowClass =
    'flex items-center gap-2 rounded-sm px-1.5 py-1 text-left text-xs'

  if (check.url === null) {
    return <div className={rowClass}>{body}</div>
  }

  return (
    <a
      className={cn(rowClass, 'transition-colors hover:bg-accent')}
      href={check.url}
      onClick={openInBrowser(check.url)}
      rel="noopener"
      target="_blank"
    >
      {body}
    </a>
  )
}

/**
 * What the rollup is made of: the headline it earns, the tally underneath,
 * and every run grouped by the workflow that produced it.
 */
function GitHubCheckRunsSummary({
  checks,
  checkStatus,
}: {
  readonly checks: readonly PullRequestCheckRun[]
  readonly checkStatus: CheckStatus
}) {
  const groups = groupChecks(checks)

  return (
    <>
      <div className="flex items-start gap-2 border-b px-3 py-2.5">
        <BucketIcon
          bucket={rollupBucket(checkStatus)}
          className="mt-px size-4"
        />
        <div className="min-w-0">
          <p className="font-medium text-xs leading-snug">
            {ROLLUP_HEADLINE[checkStatus]}
          </p>
          <p className="text-[11px] text-muted-foreground leading-snug">
            {summarize(checks)}
          </p>
        </div>
      </div>
      <div className="max-h-72 overflow-y-auto p-1">
        {groups.map(([group, runs]) => (
          <div key={group}>
            {/* One group would name the whole list, so the heading only
                appears once workflows actually divide it. */}
            {groups.length > 1 && (
              <p className="px-1.5 pt-1.5 pb-1 font-medium text-[10px] text-muted-foreground uppercase tracking-wider">
                {group}
              </p>
            )}
            {runs.map((check) => (
              <CheckRunRow check={check} key={`${group}/${check.name}`} />
            ))}
          </div>
        ))}
      </div>
    </>
  )
}

/**
 * The CI segment of the pull request pill: a rollup glyph, and the count of
 * whatever is not yet fine. A green rollup carries no number — there is
 * nothing left to act on.
 */
function GitHubCheckRunsSegment({
  checksUrl,
  checkStatus,
  checks,
}: {
  readonly checksUrl: string | null
  readonly checkStatus: CheckStatus
  readonly checks: readonly PullRequestCheckRun[] | null
}) {
  const bucket = rollupBucket(checkStatus)
  const outstanding =
    checks === null
      ? 0
      : checks.filter((check) => check.bucket === bucket).length
  const label =
    checks === null
      ? ROLLUP_HEADLINE[checkStatus]
      : `${ROLLUP_HEADLINE[checkStatus]}: ${summarize(checks)}`

  // The divider is the pill's own seam, not a second border: neutral and
  // barely there, so the two segments read as one object.
  const segmentClass = cn(
    'flex items-center gap-1 border-foreground/15 border-l px-1.5 transition-colors hover:bg-accent',
    BUCKET_PRESENTATION[bucket].tone
  )
  const segmentBody = (
    <>
      <BucketIcon bucket={bucket} className="size-3" />
      {checkStatus === 'success' || outstanding === 0 ? null : (
        <span className="tabular-nums">{outstanding}</span>
      )}
    </>
  )

  const trigger =
    checksUrl === null ? (
      <button aria-label={label} className={segmentClass} type="button">
        {segmentBody}
      </button>
    ) : (
      <a
        aria-label={label}
        className={segmentClass}
        href={checksUrl}
        onClick={openInBrowser(checksUrl)}
        rel="noopener"
        target="_blank"
      >
        {segmentBody}
      </a>
    )

  if (checks === null) {
    return trigger
  }

  return (
    <HoverCard>
      <HoverCardTrigger nativeButton={checksUrl === null} render={trigger} />
      <HoverCardContent align="start" className="w-72 p-0">
        <GitHubCheckRunsSummary checkStatus={checkStatus} checks={checks} />
      </HoverCardContent>
    </HoverCard>
  )
}

export {
  formatDuration,
  GitHubCheckRunsSegment,
  GitHubCheckRunsSummary,
  summarize,
}
