import { CircleCheck, CircleDotDashed, CircleX, GitMerge } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

type CheckStatus = 'pending' | 'success' | 'failure'

const CHECK_PRESENTATION = {
  failure: {
    className: 'border-destructive/25 text-destructive',
    icon: CircleX,
    label: 'failed',
    title: 'GitHub Actions checks failed',
  },
  pending: {
    className: 'border-warning/25 text-warning',
    icon: CircleDotDashed,
    label: 'running',
    title: 'GitHub Actions checks are still running',
  },
  success: {
    className: 'border-success/25 text-success',
    icon: CircleCheck,
    label: 'passed',
    title: 'GitHub Actions checks passed',
  },
} as const satisfies Record<
  CheckStatus,
  {
    readonly className: string
    readonly icon: typeof CircleCheck
    readonly label: string
    readonly title: string
  }
>

const STATUS_CLASS =
  'h-5 gap-1 rounded-sm bg-transparent px-1.5 font-normal text-[10px] leading-none'

function HostedStatusBadge({
  className,
  icon: Icon,
  label,
  title,
}: {
  readonly className: string
  readonly icon: typeof CircleCheck
  readonly label: string
  readonly title: string
}) {
  const badge = (
    <Badge
      aria-label={title}
      className={cn(STATUS_CLASS, className)}
      variant="outline"
    >
      <Icon aria-hidden="true" className="size-3" />
      {label}
    </Badge>
  )

  return (
    <Tooltip>
      <TooltipTrigger>{badge}</TooltipTrigger>
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  )
}

function GitHubHostedStatus({
  baseBranch,
  checkStatus,
  mergeStatus,
}: {
  readonly baseBranch: string | null
  readonly checkStatus: CheckStatus | null
  readonly mergeStatus: 'clean' | 'conflicting' | 'unknown' | null
}) {
  const check = checkStatus === null ? null : CHECK_PRESENTATION[checkStatus]

  return (
    <>
      {mergeStatus === 'conflicting' ? (
        <HostedStatusBadge
          className="border-destructive/25 text-destructive"
          icon={GitMerge}
          label={`conflicts with ${baseBranch ?? 'base'}`}
          title={`This branch has merge conflicts with ${baseBranch ?? 'its base branch'}`}
        />
      ) : null}
      {check ? <HostedStatusBadge {...check} /> : null}
    </>
  )
}

export { GitHubHostedStatus }
