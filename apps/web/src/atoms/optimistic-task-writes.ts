/**
 * Optimistic create and edit for task cards.
 *
 * The composer mints the card's ULID and renders a synthesized row
 * immediately; the server stores the same id, so the authoritative row that
 * later streams in replaces the pending row without re-keying the card. An
 * edit patches the authoritative row in place until the stream delivers the
 * saved revision. Both overlays settle against the authoritative table — not
 * the RPC response — so a card can never flash back to its previous state
 * between the response and the subscription delta.
 *
 * This module is pure and imports the shared package only for types (plus the
 * Effect-free Slack URL classifier), so it stays testable while the Effect 4
 * port of the RPC layer is in flight (#436).
 */

import type { SharedTaskRow } from '@laborer/shared/rpc'
import { isSlackMessageUrl } from '@laborer/shared/slack-url'

export type PendingTaskRows = ReadonlyMap<string, SharedTaskRow>

export interface TaskEditOverlay {
  /** The revision the draft was based on; any other revision settles it. */
  readonly expectedRevision: number
  readonly patch: {
    readonly description: string | null
    readonly title: string
  }
}

export type TaskEditOverlays = ReadonlyMap<string, TaskEditOverlay>

/**
 * An in-flight label-set write. Labels are their own overlay rather than part
 * of the edit patch because they are written by their own RPC: a picker
 * selection must not resurrect a title the detail dialog is still drafting.
 */
export interface TaskLabelOverlay {
  /** The revision the selection was based on; any other revision settles it. */
  readonly expectedRevision: number
  readonly labelIds: readonly string[]
}

export type TaskLabelOverlays = ReadonlyMap<string, TaskLabelOverlay>

/**
 * The row the server will store for this composer commit, synthesized
 * client-side. Mirrors `createTaskCard`: a Slack permalink becomes the
 * placeholder title and queues analysis; anything else is a manual card.
 */
export const pendingTaskRow = (input: {
  readonly id: string
  readonly now: number
  readonly rootPath: string
  readonly status: Exclude<SharedTaskRow['status'], 'cancelled'>
  readonly text: string
}): SharedTaskRow => {
  const text = input.text.trim()
  const slackUrl = isSlackMessageUrl(text) ? new URL(text).toString() : null
  return {
    actionName: null,
    baseBranch: null,
    baseSha: null,
    branchName: null,
    createdAt: input.now,
    description: null,
    executionId: null,
    executionStatus: slackUrl === null ? null : 'queued',
    id: input.id,
    labelIds: [],
    parentTaskId: null,
    prBaseBranch: null,
    prCheckStatus: null,
    prChecks: null,
    prIsDraft: false,
    prMergeStatus: null,
    prNumber: null,
    prState: null,
    prTitle: null,
    prUrl: null,
    revision: 1,
    rootPath: input.rootPath,
    setupCompletedAt: null,
    slackPermalink: slackUrl,
    sortOrder: null,
    source: slackUrl === null ? 'manual' : 'slack_url',
    status: input.status,
    taskNumber: 0,
    title: slackUrl ?? text,
    updatedAt: input.now,
    worktreeBotOwned: false,
    worktreeError: null,
    worktreeExists: false,
    worktreePath: null,
    worktreeStatus: null,
  }
}

/** Authoritative rows plus the pending cards the stream has not stored yet. */
export const mergePendingTaskRows = (
  rows: readonly SharedTaskRow[],
  pending: PendingTaskRows
): readonly SharedTaskRow[] => {
  if (pending.size === 0) {
    return rows
  }
  const stored = new Set(rows.map(({ id }) => id))
  const additions = [...pending.values()].filter(({ id }) => !stored.has(id))
  return additions.length === 0 ? rows : [...rows, ...additions]
}

/**
 * A pending card settles the moment the authoritative table stores its id.
 * From then on the stream owns the row; keeping the synthesized copy around
 * could only mask later authoritative changes.
 */
export const settleTaskCreateOverlays = (
  pending: PendingTaskRows,
  rows: readonly SharedTaskRow[]
): PendingTaskRows => {
  if (pending.size === 0) {
    return pending
  }
  const stored = new Set(rows.map(({ id }) => id))
  const next = new Map<string, SharedTaskRow>()
  for (const [id, row] of pending) {
    if (!stored.has(id)) {
      next.set(id, row)
    }
  }
  return next.size === pending.size ? pending : next
}

/** Rows with any in-flight title/description edit applied on top. */
export const applyTaskEditOverlays = (
  rows: readonly SharedTaskRow[],
  overlays: TaskEditOverlays
): readonly SharedTaskRow[] =>
  overlays.size === 0
    ? rows
    : rows.map((row) => {
        const overlay = overlays.get(row.id)
        return overlay === undefined ? row : { ...row, ...overlay.patch }
      })

/**
 * An edit overlay lives exactly as long as the authoritative row still sits
 * at the revision the draft was based on. Any advance settles it: our own
 * save landing is the common case, and a rival write advancing the row means
 * the server rejected our CAS — the RPC error path restores the draft, so the
 * overlay must stop hiding the winning version.
 */
export const settleTaskEditOverlays = (
  overlays: TaskEditOverlays,
  rows: readonly SharedTaskRow[]
): TaskEditOverlays => {
  if (overlays.size === 0) {
    return overlays
  }
  const revisions = new Map(rows.map((row) => [row.id, row.revision]))
  const next = new Map<string, TaskEditOverlay>()
  for (const [taskId, overlay] of overlays) {
    if (revisions.get(taskId) === overlay.expectedRevision) {
      next.set(taskId, overlay)
    }
  }
  return next.size === overlays.size ? overlays : next
}

/** Rows with any in-flight label selection applied on top. */
export const applyTaskLabelOverlays = (
  rows: readonly SharedTaskRow[],
  overlays: TaskLabelOverlays
): readonly SharedTaskRow[] =>
  overlays.size === 0
    ? rows
    : rows.map((row) => {
        const overlay = overlays.get(row.id)
        return overlay === undefined
          ? row
          : { ...row, labelIds: overlay.labelIds }
      })

/**
 * Label overlays settle on the same rule as edits: they live exactly as long
 * as the authoritative row still sits at the revision the selection was based
 * on, so a rejected CAS stops hiding the winning label set.
 */
export const settleTaskLabelOverlays = (
  overlays: TaskLabelOverlays,
  rows: readonly SharedTaskRow[]
): TaskLabelOverlays => {
  if (overlays.size === 0) {
    return overlays
  }
  const revisions = new Map(rows.map((row) => [row.id, row.revision]))
  const next = new Map<string, TaskLabelOverlay>()
  for (const [taskId, overlay] of overlays) {
    if (revisions.get(taskId) === overlay.expectedRevision) {
      next.set(taskId, overlay)
    }
  }
  return next.size === overlays.size ? overlays : next
}
