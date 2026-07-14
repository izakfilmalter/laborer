/**
 * Pure layout math for workspace minimize handling.
 *
 * When a workspace frame is minimized (collapsed to its header) the freed
 * space should be distributed across all remaining expanded workspaces —
 * not handed entirely to the adjacent one, which is what the underlying
 * react-resizable-panels imperative `collapse()` API does.
 */

/** Map of panel id to percentage of the group (0..100). */
export type GroupLayout = Readonly<Record<string, number>>

/**
 * Build a full group layout from pinned sizes and relative weights.
 *
 * - `pinned` panels receive exactly their given percentage (used for
 *   collapsed/minimized panels, and for a panel being restored to its
 *   remembered pre-minimize size).
 * - All other panels share the remaining space proportionally to their
 *   `weights`. Weights are relative, so any positive numbers work
 *   (typically the panels' current percentages).
 * - When all weights are zero, the remaining space is split equally.
 *
 * Ids present in both maps are treated as pinned.
 */
export function distributeLayout({
  weights,
  pinned,
}: {
  readonly weights: GroupLayout
  readonly pinned: GroupLayout
}): Record<string, number> {
  const result: Record<string, number> = {}
  let pinnedTotal = 0
  for (const [id, pct] of Object.entries(pinned)) {
    result[id] = pct
    pinnedTotal += pct
  }

  const remaining = Math.max(0, 100 - pinnedTotal)
  const weightEntries = Object.entries(weights).filter(
    ([id]) => !(id in pinned)
  )
  if (weightEntries.length === 0) {
    return result
  }

  let weightTotal = 0
  for (const [, weight] of weightEntries) {
    weightTotal += Math.max(0, weight)
  }

  if (weightTotal <= 0) {
    const equalShare = remaining / weightEntries.length
    for (const [id] of weightEntries) {
      result[id] = equalShare
    }
    return result
  }

  for (const [id, weight] of weightEntries) {
    result[id] = (Math.max(0, weight) / weightTotal) * remaining
  }
  return result
}

/**
 * Compute the target group layout for a set of minimized workspaces.
 *
 * - Minimized panels are pinned at their collapsed size (read from
 *   `postLayout`, captured after the imperative collapse ran).
 * - Panels in `restoreIds` (just expanded) are pinned at their remembered
 *   pre-minimize share, so a minimize → expand round-trip restores the
 *   original layout.
 * - All other panels share the remaining space proportionally to their
 *   current (`preLayout`) sizes.
 * - If no other panels exist, restored panels scale to fill the remaining
 *   space instead of keeping their exact remembered share.
 */
export function computeMinimizedTargetLayout({
  childIds,
  minimizedIds,
  restoreIds,
  preLayout,
  postLayout,
  lastExpandedShares,
}: {
  readonly childIds: readonly string[]
  readonly minimizedIds: ReadonlySet<string>
  readonly restoreIds: ReadonlySet<string>
  readonly preLayout: GroupLayout
  readonly postLayout: GroupLayout
  readonly lastExpandedShares: ReadonlyMap<string, number>
}): Record<string, number> {
  const equalShare = 100 / Math.max(1, childIds.length)
  const pinned: Record<string, number> = {}
  const restored: Record<string, number> = {}
  const weights: Record<string, number> = {}
  for (const id of childIds) {
    if (minimizedIds.has(id)) {
      pinned[id] = postLayout[id] ?? preLayout[id] ?? equalShare
    } else if (restoreIds.has(id)) {
      restored[id] = lastExpandedShares.get(id) ?? equalShare
    } else {
      weights[id] = preLayout[id] ?? equalShare
    }
  }
  if (Object.keys(weights).length > 0) {
    return distributeLayout({ weights, pinned: { ...pinned, ...restored } })
  }
  // No free panels left to absorb the remainder — let restored panels
  // scale proportionally instead of keeping exact remembered shares.
  return distributeLayout({ weights: restored, pinned })
}
