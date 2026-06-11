/**
 * Panel tree manipulation utilities.
 *
 * Pure functions that operate on `PanelNode` (the split tree within a single
 * panel tab). Handles splitting, closing, finding, navigating, and resizing
 * panes within the panel split tree.
 *
 * All functions return a new tree — the original is never mutated.
 *
 * @see packages/shared/src/types.ts — PanelNode, LeafNode, SplitNode
 */

import type {
  LeafNode,
  PanelNode,
  PaneType,
  SplitDirection,
} from '@laborer/shared/types'

import { generateId } from './id-utils'

// ---------------------------------------------------------------------------
// Panel tree leaf queries
// ---------------------------------------------------------------------------

/**
 * Get the first leaf pane ID from a PanelNode tree (DFS order).
 * Used as a fallback when `focusedPaneId` is not set on a panel tab.
 */
function getFirstLeafId(node: PanelNode): string | undefined {
  if (node._tag === 'LeafNode') {
    return node.id
  }
  for (const child of node.children) {
    const leafId = getFirstLeafId(child)
    if (leafId) {
      return leafId
    }
  }
  return undefined
}

/**
 * Collect all leaf IDs from a PanelNode tree (DFS order).
 */
function getLeafIds(node: PanelNode): string[] {
  if (node._tag === 'LeafNode') {
    return [node.id]
  }
  return node.children.flatMap(getLeafIds)
}

/**
 * Find a leaf by ID in a PanelNode tree.
 * Returns the leaf if found, or undefined.
 */
function findLeaf(node: PanelNode, paneId: string): LeafNode | undefined {
  if (node._tag === 'LeafNode') {
    return node.id === paneId ? node : undefined
  }
  for (const child of node.children) {
    const found = findLeaf(child, paneId)
    if (found) {
      return found
    }
  }
  return undefined
}

/**
 * Check if a PanelNode tree contains a pane with the given ID.
 */
function containsPane(node: PanelNode, paneId: string): boolean {
  if (node._tag === 'LeafNode') {
    return node.id === paneId
  }
  return node.children.some((child) => containsPane(child, paneId))
}

/**
 * Collect all terminal IDs from a PanelNode.
 */
function collectTerminalIds(node: PanelNode): readonly string[] {
  if (node._tag === 'LeafNode') {
    return node.terminalId !== undefined ? [node.terminalId] : []
  }
  return node.children.flatMap(collectTerminalIds)
}

/**
 * Count the number of leaf panes in a PanelNode tree.
 */
function countLeaves(node: PanelNode): number {
  if (node._tag === 'LeafNode') {
    return 1
  }
  let count = 0
  for (const child of node.children) {
    count += countLeaves(child)
  }
  return count
}

// ---------------------------------------------------------------------------
// Split pane
// ---------------------------------------------------------------------------

/**
 * Split a pane in a PanelNode tree by inserting a new sibling leaf.
 *
 * The original pane stays in place and a new leaf is inserted next to it.
 * If the target pane is already a direct child of a split with the same
 * direction, the new pane is inserted adjacent instead of nesting — keeping
 * the tree flat when possible.
 *
 * @param root - The root PanelNode tree
 * @param paneId - The ID of the leaf to split
 * @param direction - "horizontal" or "vertical"
 * @param newPaneContent - Optional partial content for the new leaf
 * @returns The updated tree (original unchanged if paneId not found)
 */
function splitPane(
  root: PanelNode,
  paneId: string,
  direction: SplitDirection,
  newPaneContent?: Partial<LeafNode>
): PanelNode {
  return splitPaneRecursive(root, paneId, direction, newPaneContent)
}

function splitPaneRecursive(
  node: PanelNode,
  paneId: string,
  direction: SplitDirection,
  newPaneContent?: Partial<LeafNode>
): PanelNode {
  // Found the target leaf — wrap it in a split with a new sibling
  if (node._tag === 'LeafNode' && node.id === paneId) {
    const newPane: LeafNode = {
      _tag: 'LeafNode',
      id: generateId('pane'),
      command: newPaneContent?.command,
      paneType: (newPaneContent?.paneType ?? 'terminal') as PaneType,
      terminalId: newPaneContent?.terminalId,
      workspaceId: newPaneContent?.workspaceId ?? node.workspaceId,
    }
    return {
      _tag: 'SplitNode',
      id: generateId('split'),
      direction,
      children: [node, newPane],
      sizes: [50, 50],
    }
  }

  // Recurse into SplitNode children
  if (node._tag === 'SplitNode') {
    // Check if any direct child is the target and has the same direction.
    // If so, insert adjacent instead of nesting.
    if (node.direction === direction) {
      const targetIndex = node.children.findIndex(
        (child) => child._tag === 'LeafNode' && child.id === paneId
      )
      if (targetIndex !== -1) {
        const targetChild = node.children[targetIndex] as LeafNode
        const newPane: LeafNode = {
          _tag: 'LeafNode',
          id: generateId('pane'),
          command: newPaneContent?.command,
          paneType: (newPaneContent?.paneType ?? 'terminal') as PaneType,
          terminalId: newPaneContent?.terminalId,
          workspaceId: newPaneContent?.workspaceId ?? targetChild.workspaceId,
        }
        const newChildren = [
          ...node.children.slice(0, targetIndex + 1),
          newPane,
          ...node.children.slice(targetIndex + 1),
        ]
        const equalSize = 100 / newChildren.length
        return {
          ...node,
          children: newChildren,
          sizes: newChildren.map(() => equalSize),
        }
      }
    }

    // Recurse into children
    const newChildren = node.children.map((child) =>
      splitPaneRecursive(child, paneId, direction, newPaneContent)
    )
    const changed = newChildren.some((child, i) => child !== node.children[i])
    if (!changed) {
      return node
    }
    return { ...node, children: newChildren }
  }

  return node
}

// ---------------------------------------------------------------------------
// Close pane
// ---------------------------------------------------------------------------

/**
 * Collapse a list of panel tree children after a removal.
 * Returns the single remaining child, a new split node, or undefined if empty.
 */
function collapseChildren(
  parent: PanelNode & { readonly _tag: 'SplitNode' },
  children: PanelNode[]
): PanelNode | undefined {
  if (children.length === 0) {
    return undefined
  }
  if (children.length === 1) {
    return children[0]
  }
  const equalSize = 100 / children.length
  return {
    ...parent,
    children,
    sizes: children.map(() => equalSize),
  }
}

/**
 * Close a pane (leaf) in a PanelNode tree by its ID.
 * Returns the updated tree, or undefined if the pane was the root
 * (meaning the entire tree is now empty).
 */
function closePane(root: PanelNode, paneId: string): PanelNode | undefined {
  if (root._tag === 'LeafNode') {
    return root.id === paneId ? undefined : root
  }

  // Check if a direct child is the target
  const targetIndex = root.children.findIndex(
    (child) => child._tag === 'LeafNode' && child.id === paneId
  )
  if (targetIndex !== -1) {
    const remaining = root.children.filter((_, i) => i !== targetIndex)
    return collapseChildren(root, remaining)
  }

  // Recurse into split children
  const newChildren: PanelNode[] = []
  let changed = false

  for (const child of root.children) {
    if (child._tag === 'SplitNode') {
      const result = closePane(child, paneId)
      if (result !== child) {
        changed = true
        if (result) {
          newChildren.push(result)
        }
      } else {
        newChildren.push(child)
      }
    } else {
      newChildren.push(child)
    }
  }

  if (!changed) {
    return root
  }

  return collapseChildren(root, newChildren)
}

// ---------------------------------------------------------------------------
// Sibling / new leaf discovery
// ---------------------------------------------------------------------------

/**
 * Find the sibling pane ID for a given pane in a PanelNode tree.
 * Used to determine where focus should go after closing a pane.
 */
function findSiblingPaneId(
  root: PanelNode,
  paneId: string
): string | undefined {
  if (root._tag === 'LeafNode') {
    return undefined
  }
  // Check if the target is a direct child of this split
  const idx = root.children.findIndex(
    (child) => child._tag === 'LeafNode' && child.id === paneId
  )
  if (idx !== -1) {
    // Prefer the sibling after, then before
    const sibling = root.children[idx + 1] ?? root.children[idx - 1]
    if (sibling) {
      return getFirstLeafId(sibling)
    }
    return undefined
  }
  // Recurse
  for (const child of root.children) {
    const found = findSiblingPaneId(child, paneId)
    if (found) {
      return found
    }
  }
  return undefined
}

/**
 * Find the new leaf added to a PanelNode tree after a split.
 * Compares leaf IDs before and after to find the new one.
 */
function findNewLeafAfterSplit(
  before: PanelNode,
  after: PanelNode
): LeafNode | undefined {
  const beforeIds = new Set(getLeafIds(before))
  const afterIds = getLeafIds(after)
  const newId = afterIds.find((id) => !beforeIds.has(id))
  if (!newId) {
    return undefined
  }
  return findLeaf(after, newId)
}

// ---------------------------------------------------------------------------
// Terminal assignment
// ---------------------------------------------------------------------------

/**
 * Assign a terminal ID to a specific pane leaf within a PanelNode tree.
 *
 * Recursively walks the tree and replaces the `terminalId` on the leaf
 * whose `id` matches `paneId`. Returns the original tree unchanged
 * (referential equality) if no matching leaf is found.
 *
 * When `command` is provided it is recorded on the leaf as the pane's
 * spawn intent (ADR 0003) so reconciliation can respawn a dead terminal
 * as what it was (e.g. an agent CLI) instead of a plain shell. Passing
 * `undefined` clears any previous intent — the pane now hosts a shell.
 */
function assignTerminal(
  node: PanelNode,
  paneId: string,
  terminalId: string,
  command?: string
): PanelNode {
  if (node._tag === 'LeafNode') {
    if (node.id === paneId) {
      return { ...node, terminalId, command }
    }
    return node
  }
  const newChildren = node.children.map((child) =>
    assignTerminal(child, paneId, terminalId, command)
  )
  // Only create a new object if something changed
  if (newChildren.every((child, i) => child === node.children[i])) {
    return node
  }
  return { ...node, children: newChildren }
}

/**
 * Update the pane type of a specific leaf within a PanelNode tree.
 *
 * Recursively walks the tree and replaces the `paneType` on the leaf
 * whose `id` matches `paneId`. Returns the original tree unchanged
 * (referential equality) if no matching leaf is found.
 */
function updateLeafType(
  node: PanelNode,
  paneId: string,
  paneType: PaneType
): PanelNode {
  if (node._tag === 'LeafNode') {
    if (node.id === paneId) {
      return { ...node, paneType }
    }
    return node
  }
  const newChildren = node.children.map((child) =>
    updateLeafType(child, paneId, paneType)
  )
  if (newChildren.every((child, i) => child === node.children[i])) {
    return node
  }
  return { ...node, children: newChildren }
}

// ---------------------------------------------------------------------------
// Directional navigation
// ---------------------------------------------------------------------------

/**
 * Direction type for directional pane navigation.
 *
 * Maps to split orientations:
 * - "left" / "right" → navigate within "horizontal" splits (side-by-side)
 * - "up" / "down" → navigate within "vertical" splits (stacked)
 */
type NavigationDirection = 'left' | 'right' | 'up' | 'down'

/**
 * Build the path from the root to a target node.
 * Returns an array of PanelNode from root to target (inclusive), or
 * undefined if the target is not found.
 */
function buildPath(root: PanelNode, targetId: string): PanelNode[] | undefined {
  if (root.id === targetId) {
    return [root]
  }
  if (root._tag === 'SplitNode') {
    for (const child of root.children) {
      const childPath = buildPath(child, targetId)
      if (childPath) {
        return [root, ...childPath]
      }
    }
  }
  return undefined
}

/**
 * Get the first or last leaf node in a subtree.
 *
 * - "first" → leftmost / topmost leaf (DFS, always pick first child)
 * - "last" → rightmost / bottommost leaf (DFS, always pick last child)
 *
 * When entering a subtree from a directional navigation, we want:
 * - Moving right → enter the left edge of the new subtree (first)
 * - Moving left → enter the right edge of the new subtree (last)
 * - Moving down → enter the top edge of the new subtree (first)
 * - Moving up → enter the bottom edge of the new subtree (last)
 */
function getEdgeLeaf(node: PanelNode, edge: 'first' | 'last'): LeafNode {
  if (node._tag === 'LeafNode') {
    return node
  }
  const child = edge === 'first' ? node.children[0] : node.children.at(-1)
  // Safety: SplitNode always has at least one child in valid trees
  if (!child) {
    return node as unknown as LeafNode
  }
  return getEdgeLeaf(child, edge)
}

/**
 * Try to navigate from a specific path index in the given direction.
 * Returns the target leaf ID if a neighbor is found at this ancestor, or
 * undefined to signal the caller to continue walking up.
 */
function tryNavigateAtAncestor(
  path: PanelNode[],
  index: number,
  targetOrientation: 'horizontal' | 'vertical',
  delta: number
): string | undefined {
  const ancestor = path[index]
  if (!ancestor || ancestor._tag !== 'SplitNode') {
    return undefined
  }
  if (ancestor.direction !== targetOrientation) {
    return undefined
  }

  const childInPath = path[index + 1]
  if (!childInPath) {
    return undefined
  }
  const childIndex = ancestor.children.findIndex((c) => c.id === childInPath.id)
  if (childIndex === -1) {
    return undefined
  }

  const neighborIndex = childIndex + delta
  const neighbor = ancestor.children[neighborIndex]
  if (!neighbor) {
    return undefined
  }

  const edge = delta > 0 ? 'first' : 'last'
  return getEdgeLeaf(neighbor, edge).id
}

/**
 * Find the pane to navigate to from the active pane in a given direction.
 *
 * The algorithm:
 * 1. Build the path from root to the active pane.
 * 2. Walk up the path to find the nearest ancestor SplitNode whose
 *    orientation matches the navigation direction.
 *    - horizontal splits handle left/right
 *    - vertical splits handle up/down
 * 3. In that split, find the adjacent child in the requested direction.
 * 4. Drill into the adjacent subtree to find the nearest leaf on the
 *    entering edge (e.g., moving right enters from the left edge).
 *
 * Returns the target leaf ID, or undefined if navigation is not possible
 * (at the edge of the layout in that direction).
 */
function findPaneInDirection(
  root: PanelNode,
  activePaneId: string,
  direction: NavigationDirection
): string | undefined {
  const path = buildPath(root, activePaneId)
  if (!path || path.length < 2) {
    return undefined
  }

  const targetOrientation: 'horizontal' | 'vertical' =
    direction === 'left' || direction === 'right' ? 'horizontal' : 'vertical'
  const delta = direction === 'left' || direction === 'up' ? -1 : 1

  // Walk up from the active pane's parent toward the root
  for (let i = path.length - 2; i >= 0; i--) {
    const result = tryNavigateAtAncestor(path, i, targetOrientation, delta)
    if (result) {
      return result
    }
  }

  return undefined
}

// ---------------------------------------------------------------------------
// Resize
// ---------------------------------------------------------------------------

/** Resize step percentage — how much the active pane grows or shrinks per action. */
const RESIZE_STEP = 5

/** Minimum pane size percentage — prevents panes from being resized to nothing. */
const MIN_PANE_SIZE = 5

/**
 * Compute the resize direction based on the keyboard arrow and the
 * split's orientation.
 *
 * Returns a delta to apply to the active pane's size:
 * - Positive delta → grow the active pane
 * - Negative delta → shrink the active pane
 * - undefined → the arrow direction doesn't match the split orientation
 */
function getResizeDelta(
  direction: NavigationDirection,
  splitOrientation: 'horizontal' | 'vertical'
): number | undefined {
  if (splitOrientation === 'horizontal') {
    if (direction === 'right') {
      return RESIZE_STEP
    }
    if (direction === 'left') {
      return -RESIZE_STEP
    }
    return undefined
  }
  // vertical
  if (direction === 'down') {
    return RESIZE_STEP
  }
  if (direction === 'up') {
    return -RESIZE_STEP
  }
  return undefined
}

/**
 * Apply a resize delta to a SplitNode at a given child index.
 * Returns the split node ID and new sizes map, or undefined if resize is not possible.
 */
function applyResizeDelta(
  ancestor: PanelNode & { readonly _tag: 'SplitNode' },
  childIndex: number,
  delta: number
): { splitNodeId: string; newSizes: Record<string, number> } | undefined {
  const siblingIndex = delta > 0 ? childIndex + 1 : childIndex - 1
  const siblingExists =
    siblingIndex >= 0 && siblingIndex < ancestor.children.length
  if (!siblingExists) {
    return undefined
  }

  const currentSize = ancestor.sizes[childIndex] ?? 50
  const siblingSize = ancestor.sizes[siblingIndex] ?? 50

  const newSize = currentSize + delta
  const newSiblingSize = siblingSize - delta

  if (newSize < MIN_PANE_SIZE || newSiblingSize < MIN_PANE_SIZE) {
    return undefined
  }

  const newSizes: Record<string, number> = {}
  for (let j = 0; j < ancestor.children.length; j++) {
    const child = ancestor.children[j]
    if (!child) {
      continue
    }
    if (j === childIndex) {
      newSizes[child.id] = newSize
    } else if (j === siblingIndex) {
      newSizes[child.id] = newSiblingSize
    } else {
      newSizes[child.id] = ancestor.sizes[j] ?? 100 / ancestor.children.length
    }
  }

  return { splitNodeId: ancestor.id, newSizes }
}

/**
 * Walk up the path from the active pane to find a resizable ancestor.
 */
function computeResizeFromPath(
  path: PanelNode[],
  direction: NavigationDirection
): { splitNodeId: string; newSizes: Record<string, number> } | undefined {
  for (let i = path.length - 2; i >= 0; i--) {
    const ancestor = path[i]
    if (!ancestor || ancestor._tag !== 'SplitNode') {
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
 * Find the parent SplitNode of the active pane that can be resized in the
 * given direction, and compute the new sizes.
 *
 * Walks up from the active pane's parent toward the root looking for a
 * SplitNode whose orientation matches the resize direction. Once found,
 * adjusts the sizes by moving `RESIZE_STEP` percentage points between
 * the active pane and its adjacent sibling.
 *
 * Returns the parent SplitNode ID and new sizes, or undefined if resize
 * is not possible.
 */
function computeResize(
  root: PanelNode,
  activePaneId: string,
  direction: NavigationDirection
): { splitNodeId: string; newSizes: Record<string, number> } | undefined {
  const path = buildPath(root, activePaneId)
  if (!path || path.length < 2) {
    return undefined
  }

  return computeResizeFromPath(path, direction)
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  assignTerminal,
  buildPath,
  closePane,
  collectTerminalIds,
  computeResize,
  containsPane,
  countLeaves,
  findLeaf,
  findNewLeafAfterSplit,
  findPaneInDirection,
  findSiblingPaneId,
  getFirstLeafId,
  getLeafIds,
  splitPane,
  updateLeafType,
}

export type { NavigationDirection }
