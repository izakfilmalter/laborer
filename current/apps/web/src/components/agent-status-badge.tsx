/**
 * Shared badge for the semantic Agent status lifecycle.
 *
 * Renders one status dot plus its label so every agent surface — terminal
 * rows, workspace frame headers, workspace cards — reads identically. The
 * dot carries the state redundantly (colour, motion) alongside the text
 * label, so the state survives colour-blindness and reduced motion.
 *
 * The badge is not interactive: it exposes its provenance through `title`
 * and an `aria-label`, avoiding a nested interactive tooltip trigger inside
 * the draggable terminal row button.
 *
 * @see apps/web/src/lib/agent-status-presentation.ts — the vocabulary
 * @see Issue #323: Semantic agent status end-to-end via process inspection
 */

import { Badge } from '@/components/ui/badge'
import type {
  AgentStatus,
  AgentStatusSnapshot,
} from '@/hooks/use-terminal-list'
import type { AgentStatusMotion } from '@/lib/agent-status-presentation'
import {
  describeAgentStatus,
  getAgentStatusBadgeClassName,
  getAgentStatusPresentation,
} from '@/lib/agent-status-presentation'
import { cn } from '@/lib/utils'

/**
 * The status dot. `needs input` pings outward to pull the eye, `working`
 * breathes to read as in-flight, and at-rest states hold still. Stale
 * detection never animates and renders hollow — uncertainty must not look
 * like activity, and the hollow ring says so without relying on colour.
 */
function AgentStatusDot({
  className,
  motion,
  staleClassName,
}: {
  readonly className: string
  readonly motion: AgentStatusMotion
  readonly staleClassName?: string | undefined
}) {
  const isStale = staleClassName !== undefined

  return (
    <span aria-hidden="true" className="relative inline-flex size-1.5 shrink-0">
      {motion === 'ping' && (
        <span
          className={cn(
            'absolute inline-flex size-full rounded-full opacity-75 motion-safe:animate-ping',
            className
          )}
        />
      )}
      <span
        className={cn(
          'relative inline-flex size-full rounded-full',
          isStale ? cn('border', staleClassName) : className,
          motion === 'breathe' && 'motion-safe:animate-pulse'
        )}
      />
    </span>
  )
}

interface AgentStatusBadgeProps {
  /** Extra classes for the host surface (e.g. `shrink-0`). */
  readonly className?: string | undefined
  /** The status to render, with its provenance. */
  readonly snapshot: AgentStatusSnapshot
}

function AgentStatusBadge({ className, snapshot }: AgentStatusBadgeProps) {
  const presentation = getAgentStatusPresentation(snapshot.status)
  const description = describeAgentStatus(snapshot)

  return (
    <Badge
      className={cn(
        'gap-1 border text-[10px] leading-none',
        getAgentStatusBadgeClassName(snapshot),
        className
      )}
      data-agent-status={snapshot.status}
      data-agent-status-stale={snapshot.stale ? 'true' : undefined}
      title={description}
      variant="outline"
    >
      <AgentStatusDot
        className={presentation.dotClassName}
        motion={snapshot.stale ? 'none' : presentation.motion}
        staleClassName={
          snapshot.stale ? presentation.dotStaleClassName : undefined
        }
      />
      {/* The visible label is hidden from assistive tech because the sr-only
          sentence below already opens with it; otherwise the state would be
          announced twice before its provenance. */}
      <span aria-hidden="true">{presentation.label}</span>
      <span className="sr-only">{description}</span>
    </Badge>
  )
}

/**
 * Convenience wrapper for surfaces that only hold an aggregate status with
 * no provenance (workspace rollups), rendered with the same vocabulary.
 */
function AggregateAgentStatusBadge({
  className,
  status,
}: {
  readonly className?: string | undefined
  readonly status: AgentStatus
}) {
  const presentation = getAgentStatusPresentation(status)
  const description = `Agent ${presentation.label} — ${presentation.meaning}`

  return (
    <Badge
      className={cn(
        'gap-1 border text-[10px] leading-none',
        presentation.badgeClassName,
        className
      )}
      data-agent-status={status}
      title={description}
      variant="outline"
    >
      <AgentStatusDot
        className={presentation.dotClassName}
        motion={presentation.motion}
      />
      <span aria-hidden="true">{presentation.label}</span>
      <span className="sr-only">{description}</span>
    </Badge>
  )
}

export { AgentStatusBadge, AgentStatusDot, AggregateAgentStatusBadge }
