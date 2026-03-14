/**
 * Workspace tile layout manipulation utilities.
 *
 * Pure functions that operate on the workspace tile tree within a `WindowTab`
 * to support adding, removing, splitting, resizing, and reordering workspace
 * tiles. These follow the same patterns as `layout-utils.ts` (panel-level
 * splits/closes) but operate one level higher — on `WorkspaceTileNode` trees.
 *
 * All functions return a new tree — the original is never mutated.
 *
 * @see packages/shared/src/types.ts — WorkspaceTileNode, WorkspaceTileLeaf, WorkspaceTileSplit, WindowTab
 * @see apps/web/src/panels/layout-utils.ts — panel-level tree utilities
 * @see apps/web/src/panels/window-tab-utils.ts — window tab CRUD utilities
 */

import type {
  SplitDirection,
  WindowTab,
  WorkspaceTileLeaf,
  WorkspaceTileNode,
  WorkspaceTileSplit,
} from '@laborer/shared/types'

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

let _counter = 0

/**
 * Generate a unique ID for new workspace tile nodes.
 * Uses an incrementing counter with a random suffix to avoid collisions.
 */
function generateTileId(prefix: string): string {
  _counter += 1
  const random = Math.random().toString(36).slice(2, 8)
  return `${prefix}-${_counter}-${random}`
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum workspace tile size percentage — prevents tiles from being resized to nothing. */
const MIN_TILE_SIZE = 5

/** Resize step percentage — amount moved per keyboard resize action. */
const RESIZE_STEP = 5

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Create an empty workspace tile leaf with default panel tabs.
 */
function createWorkspaceTileLeaf(workspaceId: string): WorkspaceTileLeaf {
  return {
    _tag: 'WorkspaceTileLeaf',
    id: generateTileId('ws-tile'),
    workspaceId,
    panelTabs: [],
    activePanelTabId: undefined,
  }
}

/**
 * Collect all workspace tile leaf nodes from a tile tree.
 */
function getWorkspaceTileLeaves(
  node: WorkspaceTileNode
): readonly WorkspaceTileLeaf[] {
  if (node._tag === 'WorkspaceTileLeaf') {
    return [node]
  }
  return node.children.flatMap(getWorkspaceTileLeaves)
}

/**
 * Build the path from root to target node.
 * Returns an array of nodes from root to target (inclusive), or undefined
 * if the target is not found.
 */
function buildTilePath(
  root: WorkspaceTileNode,
  targetId: string
): WorkspaceTileNode[] | undefined {
  if (root.id === targetId) {
    return [root]
  }
  if (root._tag === 'WorkspaceTileSplit') {
    for (const child of root.children) {
      const childPath = buildTilePath(child, targetId)
      if (childPath) {
        return [root, ...childPath]
      }
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Remove workspace tile (recursive)
// ---------------------------------------------------------------------------

/**
 * Recursively remove a workspace tile leaf by workspace ID from a tile tree.
 * Collapses single-child splits when a sibling is removed.
 *
 * Returns the new tree, or undefined if the entire tree was removed.
 */
function removeTileRecursive(
  node: WorkspaceTileNode,
  workspaceId: string
): WorkspaceTileNode | undefined {
  // Found the target leaf — remove it
  if (node._tag === 'WorkspaceTileLeaf') {
    return node.workspaceId === workspaceId ? undefined : node
  }

  // Recurse into split children
  const newChildren: WorkspaceTileNode[] = []
  let changed = false

  for (const child of node.children) {
    const result = removeTileRecursive(child, workspaceId)
    if (result !== child) {
      changed = true
    }
    if (result) {
      newChildren.push(result)
    }
  }

  if (!changed) {
    return node
  }

  if (newChildren.length === 0) {
    return undefined
  }
  if (newChildren.length === 1) {
    // Collapse — single child takes over
    return newChildren[0]
  }

  // Redistribute sizes evenly
  const equalSize = 100 / newChildren.length
  const newSizes = newChildren.map(() => equalSize)
  return {
    ...node,
    children: newChildren,
    sizes: newSizes,
  }
}

// ---------------------------------------------------------------------------
// Split workspace tile (recursive with same-direction flattening)
// ---------------------------------------------------------------------------

/**
 * Recursively split a workspace tile leaf to place a new workspace beside it.
 *
 * If the target leaf is a direct child of a split with the same direction,
 * the new tile is inserted adjacent (flat) rather than nested.
 */
function splitTileRecursive(
  node: WorkspaceTileNode,
  targetWorkspaceId: string,
  newWorkspaceId: string,
  direction: SplitDirection
): WorkspaceTileNode {
  // Found the target leaf at root level — wrap in a new split
  if (node._tag === 'WorkspaceTileLeaf') {
    if (node.workspaceId === targetWorkspaceId) {
      const newTile = createWorkspaceTileLeaf(newWorkspaceId)
      return {
        _tag: 'WorkspaceTileSplit',
        id: generateTileId('ws-split'),
        direction,
        children: [node, newTile],
        sizes: [50, 50],
      }
    }
    return node
  }

  // Split node — check for same-direction flattening
  if (node.direction === direction) {
    const targetIndex = node.children.findIndex(
      (child) =>
        child._tag === 'WorkspaceTileLeaf' &&
        child.workspaceId === targetWorkspaceId
    )
    if (targetIndex !== -1) {
      const newTile = createWorkspaceTileLeaf(newWorkspaceId)
      const newChildren = [
        ...node.children.slice(0, targetIndex + 1),
        newTile,
        ...node.children.slice(targetIndex + 1),
      ]
      const equalSize = 100 / newChildren.length
      const newSizes = newChildren.map(() => equalSize)
      return {
        ...node,
        children: newChildren,
        sizes: newSizes,
      }
    }
  }

  // Recurse into children
  const newChildren = node.children.map((child) =>
    splitTileRecursive(child, targetWorkspaceId, newWorkspaceId, direction)
  )

  // Check if anything changed
  const changed = newChildren.some((child, i) => child !== node.children[i])
  if (!changed) {
    return node
  }

  return {
    ...node,
    children: newChildren,
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Add a workspace as a new tile leaf in a window tab.
 *
 * If the tab has no workspace layout, creates a single leaf.
 * If the tab already has workspaces, splits the root horizontally to add
 * the new workspace beside the existing ones.
 *
 * @param tab - The window tab to add the workspace to
 * @param workspaceId - The workspace ID to add
 * @returns A new WindowTab with the workspace added
 */
function addWorkspaceToTab(tab: WindowTab, workspaceId: string): WindowTab {
  const newTile = createWorkspaceTileLeaf(workspaceId)

  if (!tab.workspaceLayout) {
    return {
      ...tab,
      workspaceLayout: newTile,
    }
  }

  // Tab already has a workspace layout — split root horizontally
  const root = tab.workspaceLayout
  if (root._tag === 'WorkspaceTileLeaf') {
    // Single workspace — wrap both in a horizontal split
    return {
      ...tab,
      workspaceLayout: {
        _tag: 'WorkspaceTileSplit',
        id: generateTileId('ws-split'),
        direction: 'horizontal',
        children: [root, newTile],
        sizes: [50, 50],
      },
    }
  }

  // Root is a split — add to the root's children if horizontal,
  // or wrap in a new horizontal split
  if (root.direction === 'horizontal') {
    const newChildren = [...root.children, newTile]
    const equalSize = 100 / newChildren.length
    const newSizes = newChildren.map(() => equalSize)
    return {
      ...tab,
      workspaceLayout: {
        ...root,
        children: newChildren,
        sizes: newSizes,
      },
    }
  }

  // Root is vertical — wrap in a new horizontal split
  return {
    ...tab,
    workspaceLayout: {
      _tag: 'WorkspaceTileSplit',
      id: generateTileId('ws-split'),
      direction: 'horizontal',
      children: [root, newTile],
      sizes: [50, 50],
    },
  }
}

/**
 * Remove a workspace tile from a window tab by workspace ID.
 *
 * If the workspace is found, it is removed and single-child splits are
 * collapsed. If the workspace is the last one, the tab's workspaceLayout
 * becomes undefined (empty tab).
 *
 * @param tab - The window tab to remove the workspace from
 * @param workspaceId - The workspace ID to remove
 * @returns A new WindowTab with the workspace removed
 */
function removeWorkspaceFromTab(
  tab: WindowTab,
  workspaceId: string
): WindowTab {
  if (!tab.workspaceLayout) {
    return tab
  }

  const result = removeTileRecursive(tab.workspaceLayout, workspaceId)

  if (result === tab.workspaceLayout) {
    // Nothing changed — workspace not found
    return tab
  }

  return {
    ...tab,
    workspaceLayout: result,
  }
}

/**
 * Split a workspace tile to place a new workspace beside it.
 *
 * The existing workspace stays in place and a new empty workspace tile is
 * added as a sibling in the specified direction. Same-direction splits are
 * flattened (no unnecessary nesting).
 *
 * @param tab - The window tab containing the workspace to split
 * @param workspaceId - The workspace ID to split from
 * @param newWorkspaceId - The workspace ID for the new tile
 * @param direction - "horizontal" (side-by-side) or "vertical" (stacked)
 * @returns A new WindowTab with the workspace split applied
 */
function splitWorkspaceTile(
  tab: WindowTab,
  workspaceId: string,
  newWorkspaceId: string,
  direction: SplitDirection
): WindowTab {
  if (!tab.workspaceLayout) {
    return tab
  }

  const newLayout = splitTileRecursive(
    tab.workspaceLayout,
    workspaceId,
    newWorkspaceId,
    direction
  )

  if (newLayout === tab.workspaceLayout) {
    // Nothing changed — workspace not found
    return tab
  }

  return {
    ...tab,
    workspaceLayout: newLayout,
  }
}

/**
 * Resize workspace tiles by adjusting the sizes of a split node's children.
 *
 * Walks up from the target node to find a split node with a matching
 * direction, then shifts `RESIZE_STEP` percentage points between the target
 * and its sibling. Enforces `MIN_TILE_SIZE` minimum.
 *
 * @param tab - The window tab containing the tile tree
 * @param nodeId - The ID of the tile node to resize (typically a workspace leaf)
 * @param direction - The resize direction: "left" shrinks from right, "right" grows right, etc.
 * @returns A new WindowTab with sizes adjusted, or the same tab if resize is not possible
 */
function resizeWorkspaceTiles(
  tab: WindowTab,
  nodeId: string,
  direction: 'left' | 'right' | 'up' | 'down'
): WindowTab {
  if (!tab.workspaceLayout) {
    return tab
  }

  const path = buildTilePath(tab.workspaceLayout, nodeId)
  if (!path || path.length < 2) {
    return tab
  }

  const resizeResult = computeTileResize(path, direction)
  if (!resizeResult) {
    return tab
  }

  const newLayout = applySplitSizes(
    tab.workspaceLayout,
    resizeResult.splitNodeId,
    resizeResult.newSizes
  )

  if (newLayout === tab.workspaceLayout) {
    return tab
  }

  return {
    ...tab,
    workspaceLayout: newLayout,
  }
}

/**
 * Walk up the path from target to find a resizable ancestor split.
 */
function computeTileResize(
  path: WorkspaceTileNode[],
  direction: 'left' | 'right' | 'up' | 'down'
): { splitNodeId: string; newSizes: readonly number[] } | undefined {
  for (let i = path.length - 2; i >= 0; i--) {
    const ancestor = path[i]
    if (!ancestor || ancestor._tag !== 'WorkspaceTileSplit') {
      continue
    }

    const delta = getResizeDelta(direction, ancestor.direction)
    if (delta === undefined) {
      continue
    }

    const childInPath = path[i + 1]
    if (!childInPath) {
      continue
    }

    const childIndex = ancestor.children.findIndex(
      (c) => c.id === childInPath.id
    )
    if (childIndex === -1) {
      continue
    }

    return applyResizeDelta(ancestor, childIndex, delta)
  }

  return undefined
}

/**
 * Map a navigation direction + split orientation to a resize delta.
 * Returns RESIZE_STEP, -RESIZE_STEP, or undefined (no match).
 */
function getResizeDelta(
  direction: 'left' | 'right' | 'up' | 'down',
  splitDirection: SplitDirection
): number | undefined {
  if (splitDirection === 'horizontal' && direction === 'right') {
    return RESIZE_STEP
  }
  if (splitDirection === 'horizontal' && direction === 'left') {
    return -RESIZE_STEP
  }
  if (splitDirection === 'vertical' && direction === 'down') {
    return RESIZE_STEP
  }
  if (splitDirection === 'vertical' && direction === 'up') {
    return -RESIZE_STEP
  }
  return undefined
}

/**
 * Apply a resize delta to a split node at a given child index.
 */
function applyResizeDelta(
  ancestor: WorkspaceTileSplit,
  childIndex: number,
  delta: number
): { splitNodeId: string; newSizes: readonly number[] } | undefined {
  // Find the sibling to steal/give space from.
  const siblingIndex = delta > 0 ? childIndex + 1 : childIndex - 1
  if (siblingIndex < 0 || siblingIndex >= ancestor.children.length) {
    return undefined
  }

  const currentSize = ancestor.sizes[childIndex] ?? 50
  const siblingSize = ancestor.sizes[siblingIndex] ?? 50

  const newSize = currentSize + delta
  const newSiblingSize = siblingSize - delta

  if (newSize < MIN_TILE_SIZE || newSiblingSize < MIN_TILE_SIZE) {
    return undefined
  }

  const newSizes = [...ancestor.sizes]
  newSizes[childIndex] = newSize
  newSizes[siblingIndex] = newSiblingSize

  return { splitNodeId: ancestor.id, newSizes }
}

/**
 * Apply new sizes to a split node found by ID in the tree.
 */
function applySplitSizes(
  node: WorkspaceTileNode,
  splitNodeId: string,
  newSizes: readonly number[]
): WorkspaceTileNode {
  if (node.id === splitNodeId && node._tag === 'WorkspaceTileSplit') {
    return { ...node, sizes: newSizes }
  }

  if (node._tag === 'WorkspaceTileSplit') {
    const newChildren = node.children.map((child) =>
      applySplitSizes(child, splitNodeId, newSizes)
    )
    const changed = newChildren.some((child, i) => child !== node.children[i])
    if (!changed) {
      return node
    }
    return { ...node, children: newChildren }
  }

  return node
}

/**
 * Reorder workspace tiles within a window tab based on a new workspace order.
 *
 * Collects all workspace tile leaves from the current tree, reorders them
 * according to the provided workspace ID order, and rebuilds the tree as a
 * flat horizontal split. Workspaces not in the order array are appended at
 * the end. Workspace IDs in the order array that don't exist are ignored.
 *
 * If the tab has no workspace layout or only one workspace, returns the
 * tab unchanged.
 *
 * @param tab - The window tab to reorder
 * @param workspaceOrder - Ordered array of workspace IDs
 * @returns A new WindowTab with workspace tiles reordered
 */
function reorderWorkspaceTiles(
  tab: WindowTab,
  workspaceOrder: readonly string[]
): WindowTab {
  if (!tab.workspaceLayout) {
    return tab
  }

  const leaves = getWorkspaceTileLeaves(tab.workspaceLayout)
  if (leaves.length <= 1) {
    return tab
  }

  // Build the ordered list: matched leaves first, unmatched at end
  const ordered: WorkspaceTileLeaf[] = []
  const remaining = new Map(leaves.map((leaf) => [leaf.workspaceId, leaf]))

  for (const wsId of workspaceOrder) {
    const leaf = remaining.get(wsId)
    if (leaf) {
      ordered.push(leaf)
      remaining.delete(wsId)
    }
  }

  // Append any remaining leaves not in the order array
  for (const leaf of remaining.values()) {
    ordered.push(leaf)
  }

  // If order didn't change, return the tab unchanged
  const orderChanged = ordered.some(
    (leaf, i) => leaf.workspaceId !== leaves[i]?.workspaceId
  )
  if (!orderChanged) {
    return tab
  }

  // Rebuild as a flat structure
  if (ordered.length === 1) {
    return {
      ...tab,
      workspaceLayout: ordered[0],
    }
  }

  const equalSize = 100 / ordered.length
  const newSizes = ordered.map(() => equalSize)

  return {
    ...tab,
    workspaceLayout: {
      _tag: 'WorkspaceTileSplit',
      id: generateTileId('ws-split'),
      direction: 'horizontal',
      children: ordered,
      sizes: newSizes,
    },
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  addWorkspaceToTab,
  removeWorkspaceFromTab,
  reorderWorkspaceTiles,
  resizeWorkspaceTiles,
  splitWorkspaceTile,
}
