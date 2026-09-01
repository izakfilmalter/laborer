/**
 * Project accent presentation — the one place a stored accent token becomes
 * Tailwind classes.
 *
 * Tokens are the durable vocabulary (see `@laborer/shared/project-colors`);
 * Tailwind needs literal class strings, so the mapping lives here on the
 * renderer side, the same split the label palette uses.
 *
 * Every surface that names a project reads its accent through this module, so
 * a project looks the same in the sidebar as it does on the header bar of the
 * workspace open underneath it — which is the whole point of the accent.
 */

import {
  PROJECT_COLORS,
  projectColorForName,
} from '@laborer/shared/project-colors'
import type { ProjectColor } from '@laborer/shared/rpc'

export interface ProjectAccent {
  /**
   * The workspace header bar when its frame is the active one: a solid
   * bottom edge in the project's colour, replacing the neutral primary edge.
   */
  readonly activeHeaderClassName: string
  /** Filled swatch, for the colour picker and for a project without an icon. */
  readonly dotClassName: string
  /** The workspace header bar at rest: a tint plus a quiet bottom edge. */
  readonly headerClassName: string
  /** Foreground colour for a project's glyph in the sidebar. */
  readonly iconClassName: string
}

/**
 * Alpha choices, held constant across the palette so no hue reads as louder
 * than another: the header wash sits under text at all times, and the active
 * edge is the only fully saturated stroke.
 */
const PROJECT_ACCENTS: Record<ProjectColor, ProjectAccent> = {
  amber: {
    activeHeaderClassName: 'border-b-2 border-b-amber-400',
    dotClassName: 'bg-amber-500',
    headerClassName: 'border-b-amber-400/30 bg-amber-400/5',
    iconClassName: 'text-amber-400',
  },
  blue: {
    activeHeaderClassName: 'border-b-2 border-b-blue-400',
    dotClassName: 'bg-blue-500',
    headerClassName: 'border-b-blue-400/30 bg-blue-400/5',
    iconClassName: 'text-blue-400',
  },
  cyan: {
    activeHeaderClassName: 'border-b-2 border-b-cyan-400',
    dotClassName: 'bg-cyan-500',
    headerClassName: 'border-b-cyan-400/30 bg-cyan-400/5',
    iconClassName: 'text-cyan-400',
  },
  emerald: {
    activeHeaderClassName: 'border-b-2 border-b-emerald-400',
    dotClassName: 'bg-emerald-500',
    headerClassName: 'border-b-emerald-400/30 bg-emerald-400/5',
    iconClassName: 'text-emerald-400',
  },
  fuchsia: {
    activeHeaderClassName: 'border-b-2 border-b-fuchsia-400',
    dotClassName: 'bg-fuchsia-500',
    headerClassName: 'border-b-fuchsia-400/30 bg-fuchsia-400/5',
    iconClassName: 'text-fuchsia-400',
  },
  indigo: {
    activeHeaderClassName: 'border-b-2 border-b-indigo-400',
    dotClassName: 'bg-indigo-500',
    headerClassName: 'border-b-indigo-400/30 bg-indigo-400/5',
    iconClassName: 'text-indigo-400',
  },
  lime: {
    activeHeaderClassName: 'border-b-2 border-b-lime-400',
    dotClassName: 'bg-lime-500',
    headerClassName: 'border-b-lime-400/30 bg-lime-400/5',
    iconClassName: 'text-lime-400',
  },
  orange: {
    activeHeaderClassName: 'border-b-2 border-b-orange-400',
    dotClassName: 'bg-orange-500',
    headerClassName: 'border-b-orange-400/30 bg-orange-400/5',
    iconClassName: 'text-orange-400',
  },
  pink: {
    activeHeaderClassName: 'border-b-2 border-b-pink-400',
    dotClassName: 'bg-pink-500',
    headerClassName: 'border-b-pink-400/30 bg-pink-400/5',
    iconClassName: 'text-pink-400',
  },
  rose: {
    activeHeaderClassName: 'border-b-2 border-b-rose-400',
    dotClassName: 'bg-rose-500',
    headerClassName: 'border-b-rose-400/30 bg-rose-400/5',
    iconClassName: 'text-rose-400',
  },
  teal: {
    activeHeaderClassName: 'border-b-2 border-b-teal-400',
    dotClassName: 'bg-teal-500',
    headerClassName: 'border-b-teal-400/30 bg-teal-400/5',
    iconClassName: 'text-teal-400',
  },
  violet: {
    activeHeaderClassName: 'border-b-2 border-b-violet-400',
    dotClassName: 'bg-violet-500',
    headerClassName: 'border-b-violet-400/30 bg-violet-400/5',
    iconClassName: 'text-violet-400',
  },
}

/** A stored accent a build older or newer than this one may not know. */
const isProjectColor = (value: string): value is ProjectColor =>
  (PROJECT_COLORS as readonly string[]).includes(value)

/**
 * Resolves a project's accent token, falling back to one derived from its
 * name. Projects registered before accents existed, and optimistic rows that
 * have not heard back from the server yet, both arrive with a null colour —
 * and neither should render uncoloured.
 */
export const projectColorToken = (project: {
  readonly color?: string | null | undefined
  readonly name: string
}): ProjectColor =>
  project.color != null && isProjectColor(project.color)
    ? project.color
    : projectColorForName(project.name)

/** The accent classes for a project. */
export const projectAccent = (project: {
  readonly color?: string | null | undefined
  readonly name: string
}): ProjectAccent => PROJECT_ACCENTS[projectColorToken(project)]

/**
 * The project accent classes for a workspace frame's header bar.
 *
 * Identity yields to every status the agent has to report, so an agent accent
 * silences the project one entirely rather than layering two washes on one 8px
 * bar. Where nothing is being reported, the active frame gets a saturated edge
 * in the project's colour instead of the project-agnostic primary, so a wall
 * of frames sorts by project at a glance.
 */
export const workspaceHeaderAccentClassName = (input: {
  readonly agentAccentClassName: string
  readonly isActiveFrame: boolean
  readonly projectColor?: string | null | undefined
  readonly projectName: string | undefined
}): string => {
  if (input.projectName === undefined || input.agentAccentClassName !== '') {
    return ''
  }
  const accent = projectAccent({
    color: input.projectColor,
    name: input.projectName,
  })
  return input.isActiveFrame
    ? `${accent.headerClassName} ${accent.activeHeaderClassName}`
    : accent.headerClassName
}

/** The swatch class for a specific token, for the accent picker. */
export const projectColorDotClassName = (color: ProjectColor): string =>
  PROJECT_ACCENTS[color].dotClassName
