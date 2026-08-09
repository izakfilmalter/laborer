/**
 * Presentation vocabulary for the semantic Agent status lifecycle.
 *
 * One module owns how `working | needs_input | idle | unknown` and the
 * display-only `done` projection look and read, so terminal rows, workspace
 * frame headers, and workspace cards never drift apart. Surfaces pick the
 * pieces they need (label, badge classes, glyph, surface accent, provenance
 * sentence) instead of re-deriving colours and copy locally.
 *
 * Motion is meaning here: `needs input` pings (act now), `working` breathes
 * (in flight), `idle` and `unknown` are still (nothing to do). All motion is
 * `motion-safe:` gated so reduced-motion users get the same colour and shape
 * language without animation, and stale detection drops motion entirely —
 * hollowing the dot instead — because a status that may be out of date must
 * not look like fresh activity.
 *
 * Shape is meaning too: `done` swaps the dot for a check, so "review this
 * result" and "act on this now" differ by glyph and not only by hue.
 *
 * The same module owns the surface accents (terminal row, workspace card,
 * frame header) so the two actionable states keep one hierarchy everywhere:
 * `needs input` is the loudest surface it appears on — tint, border and a
 * glow — while `done` carries a quieter tint and border, and `working` only
 * whispers on the frame header it already owns. At-rest states accent
 * nothing, leaving the badge to say all there is to say.
 *
 * @see apps/web/src/components/agent-status-badge.tsx — shared badge
 * @see apps/web/src/components/terminal-list.tsx — terminal rows
 * @see apps/web/src/components/workspace-frame-header.tsx — frame header
 * @see apps/web/src/components/workspace-list.tsx — workspace cards
 * @see Issue #323: Semantic agent status end-to-end via process inspection
 * @see Issue #324: Seen bit, done projection, and attention surfaces
 */

import type {
  AgentStatusSnapshot,
  AgentStatusSource,
} from '@/hooks/use-terminal-list'
import {
  type AgentDisplayStatus,
  deriveAgentDisplayStatus,
} from '@/lib/agent-attention-projection'

/** How a status dot animates. `none` is used for at-rest states. */
type AgentStatusMotion = 'ping' | 'breathe' | 'none'

/**
 * The mark a badge leads with. `check` is reserved for `done`, whose
 * meaning — a finished result waiting to be read — is a different kind of
 * thing from the lifecycle dots and should not have to be told apart by
 * colour alone.
 */
type AgentStatusGlyphKind = 'dot' | 'check'

/**
 * Accents a status lends to the surfaces that host it. Empty strings mean
 * "stay quiet": an at-rest agent should not tint a row, card, or header.
 */
interface AgentStatusSurface {
  /** Workspace card in the sidebar. */
  readonly cardClassName: string
  /** Workspace frame header bar. */
  readonly headerClassName: string
  /** Terminal row in the sidebar. */
  readonly rowClassName: string
  /**
   * Hover treatment for the terminal row. Owned here rather than by the row
   * because the generic `hover:bg-accent` would otherwise wash the accent
   * away on the one interaction most likely to happen to an accented row:
   * the operator pointing at it. Accented rows deepen their own hue instead,
   * so hovering confirms the state rather than erasing it.
   */
  readonly rowHoverClassName: string
}

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
  /** The mark the badge leads with. */
  readonly glyph: AgentStatusGlyphKind
  /**
   * True when the state wants the operator: `needs input` to act now, and
   * `done` to review a result nobody has seen yet.
   */
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
 * - `done` — violet, still check. Review the completed result.
 * - `idle` — success green, matching the shell-at-prompt badge, still dot.
 * - `unknown` — muted with a dashed edge, signalling "no answer yet".
 *
 * Every hued state inks its label at the same `-400` step. The app defaults
 * to the dark theme but the light one is a switch away, and a lighter step
 * would read fine on black and wash out on white — so the states share one
 * ink weight rather than each picking the one that flatters dark mode.
 */
const AGENT_STATUS_PRESENTATION: Record<
  AgentDisplayStatus,
  AgentStatusPresentation
> = {
  working: {
    label: 'working',
    badgeClassName: 'border-blue-400/30 bg-blue-400/10 text-blue-400',
    dotClassName: 'bg-blue-400',
    dotStaleClassName: 'border-blue-400',
    glyph: 'dot',
    motion: 'breathe',
    meaning: 'The agent is working.',
    isAttention: false,
  },
  needs_input: {
    label: 'needs input',
    badgeClassName: 'border-amber-400/40 bg-amber-400/15 text-amber-400',
    dotClassName: 'bg-amber-400',
    dotStaleClassName: 'border-amber-400',
    glyph: 'dot',
    motion: 'ping',
    meaning: 'The agent is waiting on you.',
    isAttention: true,
  },
  idle: {
    label: 'idle',
    badgeClassName: 'border-success/30 bg-success/10 text-success',
    dotClassName: 'bg-success',
    dotStaleClassName: 'border-success',
    glyph: 'dot',
    motion: 'none',
    meaning: 'The agent finished and is idle.',
    isAttention: false,
  },
  done: {
    label: 'done',
    badgeClassName: 'border-violet-400/40 bg-violet-400/15 text-violet-400',
    dotClassName: 'bg-violet-400',
    dotStaleClassName: 'border-violet-400',
    glyph: 'check',
    motion: 'none',
    meaning:
      'The agent finished while you were away; open this workspace to review its result.',
    isAttention: true,
  },
  unknown: {
    label: 'unknown',
    badgeClassName:
      'border-muted-foreground/30 border-dashed bg-muted text-muted-foreground',
    dotClassName: 'bg-muted-foreground/60',
    dotStaleClassName: 'border-muted-foreground/60',
    glyph: 'dot',
    motion: 'none',
    meaning: 'The agent state could not be determined.',
    isAttention: false,
  },
}

const QUIET_SURFACE: AgentStatusSurface = {
  cardClassName: '',
  headerClassName: '',
  rowClassName: '',
  rowHoverClassName: 'hover:bg-accent hover:text-accent-foreground',
}

/**
 * Surface accents, ordered so urgency reads before hue does.
 *
 * `needs input` is the only state that borrows the whole surface: a tint, a
 * saturated edge, and — on a workspace card, where it competes with every
 * other card in the sidebar — a glow. `done` deliberately stops short of the
 * glow: an unseen result should be findable without shouting over an agent
 * that is actually blocked. `working` accents only the frame header, whose
 * bar is already the quietest place a status can live, and never fights the
 * active-frame accent for it.
 *
 * On the frame header the two attention states also claim the same
 * two-pixel edge the active frame uses, so a frame that wants the operator
 * is never drawn thinner than the frame they happen to be looking at; hue
 * and tint, not weight, say which of the two it is.
 */
const AGENT_STATUS_SURFACE: Record<AgentDisplayStatus, AgentStatusSurface> = {
  needs_input: {
    cardClassName:
      'border-amber-400/60 shadow-[0_0_10px_rgba(251,191,36,0.18)]',
    headerClassName: 'border-b-2 border-b-amber-400/70 bg-amber-400/10',
    rowClassName: 'border-amber-400/50 bg-amber-400/10',
    rowHoverClassName: 'hover:bg-amber-400/20',
  },
  done: {
    cardClassName: 'border-violet-400/45',
    headerClassName: 'border-b-2 border-b-violet-400/50 bg-violet-400/5',
    rowClassName: 'border-violet-400/35 bg-violet-400/5',
    rowHoverClassName: 'hover:bg-violet-400/15',
  },
  working: {
    cardClassName: '',
    headerClassName: 'border-b-blue-400/40 bg-blue-400/5',
    rowClassName: '',
    rowHoverClassName: QUIET_SURFACE.rowHoverClassName,
  },
  idle: QUIET_SURFACE,
  unknown: QUIET_SURFACE,
}

/**
 * Whether a status earns a badge on the workspace-level surfaces — the
 * sidebar card and the frame header — which summarise many terminals in one
 * line and so can only afford to speak when there is something to say: act
 * now, review an unseen result, or work in flight. Acknowledged idle and
 * unknown stay in the terminal rows that own them, so a quiet workspace
 * looks quiet.
 *
 * Both surfaces ask the same question, so they ask it here; expressing the
 * rule twice is how a card and its header start disagreeing about whether a
 * workspace has anything to report.
 */
function showsWorkspaceAgentStatus(
  status: AgentDisplayStatus | null | undefined
): status is AgentDisplayStatus {
  return status === 'needs_input' || status === 'done' || status === 'working'
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
  status: AgentDisplayStatus
): AgentStatusPresentation {
  return AGENT_STATUS_PRESENTATION[status]
}

/**
 * Accents a status lends to its host surfaces. At-rest states return empty
 * strings, so callers can apply the result unconditionally.
 */
function getAgentStatusSurface(
  status: AgentDisplayStatus | null | undefined
): AgentStatusSurface {
  return status == null ? QUIET_SURFACE : AGENT_STATUS_SURFACE[status]
}

/**
 * Badge classes for a snapshot, dimming and un-animating stale detection so
 * uncertainty never reads as a confident answer.
 */
function getAgentStatusBadgeClassName(snapshot: AgentStatusSnapshot): string {
  const presentation = getAgentStatusPresentation(
    deriveAgentDisplayStatus(snapshot)
  )
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
  const presentation = getAgentStatusPresentation(
    deriveAgentDisplayStatus(snapshot)
  )
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
  getAgentStatusSurface,
  showsWorkspaceAgentStatus,
}
export type {
  AgentStatusGlyphKind,
  AgentStatusMotion,
  AgentStatusPresentation,
  AgentStatusSurface,
}
