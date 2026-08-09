/**
 * Presentation vocabulary for the semantic Agent status lifecycle.
 *
 * One module owns how `working | needs_input | idle | unknown` looks and
 * reads, so terminal rows, workspace frame headers, and workspace cards
 * never drift apart. Surfaces pick the pieces they need (label, badge
 * classes, dot treatment, provenance sentence) instead of re-deriving
 * colours and copy locally.
 *
 * Motion is meaning here: `needs input` pings (act now), `working` breathes
 * (in flight), `idle` and `unknown` are still (nothing to do). All motion is
 * `motion-safe:` gated so reduced-motion users get the same colour and shape
 * language without animation, and stale detection drops motion entirely —
 * hollowing the dot instead — because a status that may be out of date must
 * not look like fresh activity.
 *
 * @see apps/web/src/components/agent-status-badge.tsx — shared badge
 * @see apps/web/src/components/terminal-list.tsx — terminal rows
 * @see apps/web/src/components/workspace-frame-header.tsx — frame header
 * @see Issue #323: Semantic agent status end-to-end via process inspection
 */

import type {
  AgentStatus,
  AgentStatusSnapshot,
  AgentStatusSource,
} from '@/hooks/use-terminal-list'

/** How a status dot animates. `none` is used for at-rest states. */
type AgentStatusMotion = 'ping' | 'breathe' | 'none'

interface AgentStatusPresentation {
  /** Badge chrome (border, background, text colour). */
  readonly badgeClassName: string
  /** Fill colour for the status dot. */
  readonly dotClassName: string
  /**
   * Border colour for the hollow dot used when detection is stale, so
   * "possibly out of date" reads as a shape change and not only as dimmer
   * ink — the one cue that survives both colour-blindness and low contrast.
   */
  readonly dotStaleClassName: string
  /** True when the state asks the operator to act now. */
  readonly isAttention: boolean
  /** Human-readable badge text, lower case to match sibling badges. */
  readonly label: string
  /** Sentence explaining what the state means, used in tooltips. */
  readonly meaning: string
  /** Motion applied to the dot when detection is fresh. */
  readonly motion: AgentStatusMotion
}

/**
 * Colour language, chosen so the four states are distinguishable at a
 * glance and by more than hue:
 *
 * - `needs input` — amber, pinging dot. The only state that demands action.
 * - `working` — blue, the agent identity colour, breathing dot.
 * - `idle` — success green, matching the shell-at-prompt badge, still dot.
 * - `unknown` — muted with a dashed edge, signalling "no answer yet".
 */
const AGENT_STATUS_PRESENTATION: Record<AgentStatus, AgentStatusPresentation> =
  {
    working: {
      label: 'working',
      badgeClassName: 'border-blue-400/30 bg-blue-400/10 text-blue-400',
      dotClassName: 'bg-blue-400',
      dotStaleClassName: 'border-blue-400',
      motion: 'breathe',
      meaning: 'The agent is working.',
      isAttention: false,
    },
    needs_input: {
      label: 'needs input',
      badgeClassName: 'border-amber-400/40 bg-amber-400/15 text-amber-400',
      dotClassName: 'bg-amber-400',
      dotStaleClassName: 'border-amber-400',
      motion: 'ping',
      meaning: 'The agent is waiting on you.',
      isAttention: true,
    },
    idle: {
      label: 'idle',
      badgeClassName: 'border-success/30 bg-success/10 text-success',
      dotClassName: 'bg-success',
      dotStaleClassName: 'border-success',
      motion: 'none',
      meaning: 'The agent finished and is idle.',
      isAttention: false,
    },
    unknown: {
      label: 'unknown',
      badgeClassName:
        'border-muted-foreground/30 border-dashed bg-muted text-muted-foreground',
      dotClassName: 'bg-muted-foreground/60',
      dotStaleClassName: 'border-muted-foreground/60',
      motion: 'none',
      meaning: 'The agent state could not be determined.',
      isAttention: false,
    },
  }

/** Detector names in operator language rather than implementation shorthand. */
const AGENT_STATUS_SOURCE_LABEL: Record<AgentStatusSource, string> = {
  hook: 'agent hook',
  ps: 'process inspection',
}

/**
 * Chrome added to a badge whose detection has gone stale: a dashed edge and
 * a light dim. The dim stops at 70% because a stale badge still has to be
 * readable — the stronger stale cues are the dashed edge, the hollow dot,
 * and the "may be out of date" sentence, none of which depend on contrast.
 */
const STALE_BADGE_CLASSNAME = 'border-dashed opacity-70'

function getAgentStatusPresentation(
  status: AgentStatus
): AgentStatusPresentation {
  return AGENT_STATUS_PRESENTATION[status]
}

/**
 * Badge classes for a snapshot, dimming and un-animating stale detection so
 * uncertainty never reads as a confident answer.
 */
function getAgentStatusBadgeClassName(snapshot: AgentStatusSnapshot): string {
  const presentation = getAgentStatusPresentation(snapshot.status)
  return snapshot.stale
    ? `${presentation.badgeClassName} ${STALE_BADGE_CLASSNAME}`
    : presentation.badgeClassName
}

/**
 * A one-line explanation of the state and its provenance, e.g.
 * `Needs input — the agent is waiting on you. Reported by agent hook at
 * 10:14:02. Detection is stale; this may be out of date.`
 *
 * Used as both the tooltip text and the accessible name of the badge so
 * pointer and screen-reader users learn the same thing.
 */
function describeAgentStatus(snapshot: AgentStatusSnapshot): string {
  const presentation = getAgentStatusPresentation(snapshot.status)
  const source = AGENT_STATUS_SOURCE_LABEL[snapshot.source]
  const changedAt = new Date(snapshot.changedAt).toLocaleTimeString()
  const staleNote = snapshot.stale
    ? ' Detection is stale; this may be out of date.'
    : ''

  return `Agent ${presentation.label} — ${presentation.meaning} Reported by ${source} at ${changedAt}.${staleNote}`
}

export {
  AGENT_STATUS_SOURCE_LABEL,
  describeAgentStatus,
  getAgentStatusBadgeClassName,
  getAgentStatusPresentation,
}
export type { AgentStatusMotion, AgentStatusPresentation }
