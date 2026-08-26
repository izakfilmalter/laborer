/**
 * Pure state derivations behind the diff pane's toolbar.
 *
 * The toolbar itself is presentation; everything it decides — which diff
 * style wins, whether "collapse all" is really an "expand all", what the
 * totals line says — is derived here so it can be tested without a DOM.
 *
 * Ported from t3code's `diffCollapse` helpers, widened to cover our
 * collapse map (path → explicit collapsed flag, absent = size default)
 * and the responsive/explicit diff-style negotiation the pane needs.
 */

/** The two shapes the viewer can paint a patch in. */
export type DiffStyle = 'split' | 'unified'

/**
 * What the user explicitly asked for, or `null` for "follow the pane
 * width". `null` is the initial value: until someone touches the
 * toggle, the pane's ResizeObserver owns the decision.
 */
export type DiffStyleOverride = DiffStyle | null

/** The style the pane's width alone would pick. */
export const responsiveDiffStyle = (narrow: boolean): DiffStyle =>
  narrow ? 'unified' : 'split'

/**
 * An explicit choice beats the observer. The observer keeps measuring
 * while an override is set — it just stops being consulted, so clearing
 * the override snaps straight back to whatever the current width wants
 * rather than to a stale measurement.
 */
export const resolveDiffStyle = (
  override: DiffStyleOverride,
  responsive: DiffStyle
): DiffStyle => override ?? responsive

/**
 * Reduce a toolbar click to the next override.
 *
 * Picking the style the pane would have chosen anyway hands control
 * back to the observer instead of freezing the pane at that style. Both
 * branches render identically at the current width, so the only visible
 * difference shows up on the next resize — which is exactly the
 * behaviour someone re-picking the current style is asking for. This is
 * also the only way back to automatic without a third toolbar state.
 */
export const nextDiffStyleOverride = (
  requested: DiffStyle,
  responsive: DiffStyle
): DiffStyleOverride => (requested === responsive ? null : requested)

/** True when there is at least one file and every one of them is collapsed. */
export const areAllDiffFilesCollapsed = (
  paths: readonly string[],
  isCollapsed: (path: string) => boolean
): boolean => paths.length > 0 && paths.every(isCollapsed)

/**
 * Force every listed file to `collapsed`, keeping overrides for files
 * that are not currently rendered (a truncated or filtered-out file
 * should not silently lose the state the user gave it).
 */
export const withCollapseAll = (
  previous: ReadonlyMap<string, boolean>,
  paths: readonly string[],
  collapsed: boolean
): ReadonlyMap<string, boolean> => {
  const next = new Map(previous)
  for (const path of paths) {
    next.set(path, collapsed)
  }
  return next
}

export interface DiffStatTotals {
  readonly added: number
  readonly removed: number
}

/**
 * Total added/removed across the changed files, matching the per-file
 * counts the viewer paints in each file header.
 */
export const sumDiffStats = (
  entries: readonly { readonly added: number; readonly removed: number }[]
): DiffStatTotals =>
  entries.reduce<DiffStatTotals>(
    (totals, entry) => ({
      added: totals.added + entry.added,
      removed: totals.removed + entry.removed,
    }),
    { added: 0, removed: 0 }
  )
