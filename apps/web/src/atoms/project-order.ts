/**
 * Manual project order.
 *
 * The sidebar tree and the kanban swim lanes both render the streamed project
 * table, so one rank drives both surfaces. The rank lives on the project row
 * itself as a nullable `sortOrder`, and the server orders by
 * `COALESCE(sort_order, created_at), id` — an unranked project falls back to
 * its creation time, so an untouched install looks exactly as it did before
 * and a freshly added project appears at the bottom.
 *
 * {@link compareProjects} mirrors that SQL exactly. Everything the renderer
 * shows is sorted by it, so an optimistic rank and an authoritative rank order
 * the list identically and a drag can never settle into a different position
 * than the one it promised.
 *
 * A drop writes an overlay first so the list settles under the pointer
 * instantly; the overlay is released when the project leaves the revision the
 * drag was based on — the same rule the task edit overlay uses, so the list
 * can never flash back between the response and the delta.
 *
 * This module is pure apart from its atoms and imports the shared package only
 * for types, which keeps the ordering rules directly testable.
 */

import type { SharedProjectRow } from '@laborer/shared/rpc'
import { Atom } from 'effect/unstable/reactivity'

/**
 * Distance between minted ranks, in the milliseconds `createdAt` is measured
 * in. Wide enough that a project added moments after a drag still sorts below
 * one just dropped at the bottom, rather than tying against the same instant.
 */
const RANK_GAP = 60_000

/** The rank a single project should be written to. */
export interface ProjectRankAssignment {
  readonly projectId: string
  readonly sortOrder: number
}

export interface ProjectRankOverlay {
  /** Identifies the move across its writes, so only it can withdraw itself. */
  readonly dragId: string
  /** The row revision the drag was based on; any other revision settles it. */
  readonly expectedRevision: number
  readonly sortOrder: number
}

/** Ranks a drag is promising, keyed by project id. */
export type ProjectRankOverlays = ReadonlyMap<string, ProjectRankOverlay>

/** Drag intent, deliberately separate from the authoritative stream. */
export const projectRankOverlaysAtom = Atom.make<ProjectRankOverlays>(new Map())

export const installProjectRankOverlaysAtom = Atom.writable(
  (get) => get(projectRankOverlaysAtom),
  (context, overlays: ProjectRankOverlays) => {
    const next = new Map(context.get(projectRankOverlaysAtom))
    for (const [projectId, overlay] of overlays) {
      next.set(projectId, overlay)
    }
    context.set(projectRankOverlaysAtom, next)
  }
)

/**
 * Reverts to the stored order after a rejected write. A project that a later
 * drag has since claimed keeps that drag's rank rather than snapping back.
 */
export const clearProjectRankOverlaysAtom = Atom.writable(
  (get) => get(projectRankOverlaysAtom),
  (context, dragId: string) => {
    const current = context.get(projectRankOverlaysAtom)
    const next = new Map(
      [...current].filter(([, overlay]) => overlay.dragId !== dragId)
    )
    if (next.size !== current.size) {
      context.set(projectRankOverlaysAtom, next)
    }
  }
)

/** A project the renderer can order: the streamed row, or any stand-in. */
export interface RankableProject {
  readonly createdAt: number
  readonly id: string
  readonly sortOrder: number | null
}

/** The value the server sorts on. Unranked projects fall back to createdAt. */
export const projectRank = (project: RankableProject): number =>
  project.sortOrder ?? project.createdAt

/** Mirrors `ORDER BY COALESCE(sort_order, created_at), id`. */
export const compareProjects = (
  left: RankableProject,
  right: RankableProject
): number => {
  const leftRank = projectRank(left)
  const rightRank = projectRank(right)
  if (leftRank !== rightRank) {
    return leftRank < rightRank ? -1 : 1
  }
  if (left.id === right.id) {
    return 0
  }
  return left.id < right.id ? -1 : 1
}

export const sortProjectsByRank = <Row extends RankableProject>(
  rows: readonly Row[]
): readonly Row[] => (rows.length < 2 ? rows : [...rows].sort(compareProjects))

/** Replaces stored ranks with the ones a drag is promising. */
export const applyProjectRankOverlays = <Row extends RankableProject>(
  rows: readonly Row[],
  overlays: ProjectRankOverlays
): readonly Row[] =>
  overlays.size === 0
    ? rows
    : rows.map((row) => {
        const overlay = overlays.get(row.id)
        return overlay === undefined
          ? row
          : { ...row, sortOrder: overlay.sortOrder }
      })

/** An overlay lives exactly as long as the revision it was written against. */
export const settleProjectRankOverlays = (
  overlays: ProjectRankOverlays,
  rows: readonly SharedProjectRow[]
): ProjectRankOverlays => {
  if (overlays.size === 0) {
    return overlays
  }
  const revisions = new Map(rows.map(({ id, revision }) => [id, revision]))
  const next = new Map(
    [...overlays].filter(
      ([projectId, overlay]) =>
        revisions.get(projectId) === overlay.expectedRevision
    )
  )
  return next.size === overlays.size ? overlays : next
}

/**
 * Spaces every project evenly. Used only when the neighbours a project is
 * being dropped between hold the same rank, which leaves no value in the gap
 * for a single-row write to take.
 */
const rebalance = (
  ordered: readonly RankableProject[]
): readonly ProjectRankAssignment[] => {
  const first = ordered[0]
  const base = first === undefined ? 0 : projectRank(first)
  return ordered.map((project, index) => ({
    projectId: project.id,
    sortOrder: base + index * RANK_GAP,
  }))
}

/**
 * The rank writes that place `movedProjectId` at `toIndex`, or an empty plan
 * when it is already there.
 *
 * The common case is a single write: the moved project takes a rank between
 * the neighbours it lands between, and every other project is left alone. That
 * is what keeps the first drag on a fresh install from rewriting rows it has
 * no reason to touch.
 */
export const planProjectRanks = (
  rows: readonly RankableProject[],
  movedProjectId: string,
  toIndex: number
): readonly ProjectRankAssignment[] => {
  const ordered = sortProjectsByRank(rows)
  const from = ordered.findIndex(({ id }) => id === movedProjectId)
  const moved = ordered[from]
  if (
    moved === undefined ||
    toIndex < 0 ||
    toIndex >= ordered.length ||
    from === toIndex
  ) {
    return []
  }
  // The ranks of the projects the move lands between, absent at either end.
  const remaining = ordered.filter(({ id }) => id !== movedProjectId)
  const previous = remaining[toIndex - 1]
  const next = remaining[toIndex]
  const previousRank = previous === undefined ? null : projectRank(previous)
  const nextRank = next === undefined ? null : projectRank(next)

  if (previousRank === null) {
    return nextRank === null
      ? []
      : [{ projectId: movedProjectId, sortOrder: nextRank - RANK_GAP }]
  }
  if (nextRank === null) {
    return [{ projectId: movedProjectId, sortOrder: previousRank + RANK_GAP }]
  }
  const midpoint = (previousRank + nextRank) / 2
  if (midpoint <= previousRank || midpoint >= nextRank) {
    // The neighbours tie, or the gap is finer than a double can split. Space
    // the whole list out and place the project into its slot.
    const placed = [
      ...remaining.slice(0, toIndex),
      moved,
      ...remaining.slice(toIndex),
    ]
    return rebalance(placed)
  }
  return [{ projectId: movedProjectId, sortOrder: midpoint }]
}

/**
 * The rank writes after a drop. The drag may happen while the sidebar is
 * filtered, so the moved project has to land next to its target within the
 * complete list.
 *
 * Moving down lands the project after its target and moving up lands it
 * before, which is the placement the drop indicator promises.
 */
export const planProjectMove = (
  rows: readonly RankableProject[],
  movedProjectId: string,
  targetProjectId: string
): readonly ProjectRankAssignment[] => {
  const ordered = sortProjectsByRank(rows)
  const toIndex = ordered.findIndex(({ id }) => id === targetProjectId)
  return toIndex < 0 ? [] : planProjectRanks(ordered, movedProjectId, toIndex)
}

/** The rank writes after a keyboard nudge, empty at either end of the list. */
export const planProjectNudge = (
  rows: readonly RankableProject[],
  projectId: string,
  delta: number
): readonly ProjectRankAssignment[] => {
  const ordered = sortProjectsByRank(rows)
  const from = ordered.findIndex(({ id }) => id === projectId)
  return from < 0 ? [] : planProjectRanks(ordered, projectId, from + delta)
}
