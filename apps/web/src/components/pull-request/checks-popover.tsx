/**
 * The checks indicator and the list it opens, ported from t3code's
 * `PullRequestChecksPopover.tsx`. Laborer only shows this in the detail
 * header, which is already holding every check, so t3's lazy listing-row
 * variant is left out.
 */
import type { PullRequestCheck } from '@laborer/shared/rpc'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@laborer/ui/components/popover'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@laborer/ui/components/tooltip'
import { cn } from '@laborer/ui/lib/utils'
import { openExternally } from './external-links'
import {
  PullRequestCheckStatusIcon,
  type PullRequestChecksState,
  pullRequestCheckStatusLabel,
  pullRequestChecksStatePresentation,
  summarizePullRequestChecks,
} from './presentation'

function ChecksBody({ checks }: { checks: readonly PullRequestCheck[] }) {
  if (checks.length === 0) {
    return <p className="text-muted-foreground text-xs">No checks reported</p>
  }
  return (
    <ul className="flex flex-col gap-1">
      {/* Keyed by position as well as by name: GitHub decides how many runs
          share a name, and a repeated key is a rendering fault. */}
      {checks.map((check, index) => (
        <li
          className="flex items-center gap-2 text-xs"
          key={`${index}:${check.name}`}
        >
          <PullRequestCheckStatusIcon status={check.status} />
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="min-w-0 flex-1 truncate">{check.name}</span>
              }
            />
            <TooltipContent side="top">
              {check.description ?? check.name}
            </TooltipContent>
          </Tooltip>
          <span className="shrink-0 text-muted-foreground">
            {pullRequestCheckStatusLabel(check.status)}
          </span>
          {check.url === null ? null : (
            <button
              className="shrink-0 text-primary hover:underline"
              onClick={() => openExternally(check.url ?? '')}
              type="button"
            >
              Details
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}

export function PullRequestChecksPopover({
  checksState,
  checks,
  className,
}: {
  checksState: PullRequestChecksState
  checks: readonly PullRequestCheck[]
  className?: string
}) {
  const presentation = pullRequestChecksStatePresentation(checksState)
  const summary = summarizePullRequestChecks(checks)
  return (
    <Popover>
      <PopoverTrigger
        onClick={(event) => event.stopPropagation()}
        render={
          // biome-ignore lint/a11y/useSemanticElements: the popover trigger renders as a span so it can sit inside button-shaped rows; role="button" keeps it accessible.
          <span
            aria-label={`Checks: ${presentation.label}`}
            className={cn(
              'inline-flex shrink-0 cursor-pointer items-center',
              className
            )}
            role="button"
            tabIndex={0}
          />
        }
      >
        <presentation.Icon
          aria-hidden
          className={cn('size-3.5', presentation.toneClassName)}
        />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 max-w-full" side="bottom">
        <p className="mb-2 font-medium text-sm">{presentation.label}</p>
        <p className="mb-2 text-muted-foreground text-xs">{summary}</p>
        <ChecksBody checks={checks} />
      </PopoverContent>
    </Popover>
  )
}
