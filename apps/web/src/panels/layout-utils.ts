/**
 * Panel layout tree manipulation utilities.
 *
 * These pure functions operate on the `PanelNode` tree structure to support
 * splitting panes, closing panes, and finding nodes by ID. They are used by
 * the PanelManager and usePanelLayout hook to mutate the layout in response
 * to user actions (keyboard shortcuts, context menus, etc.).
 *
 * All functions return a new tree — the original tree is never mutated.
 *
 * @see packages/shared/src/types.ts — PanelNode, LeafNode, SplitNode types
 * @see Issue #69: PanelManager — recursive splits
 */

import type {
  LeafNode,
  PanelNode,
  SplitDirection,
  SplitNode,
} from '@laborer/shared/types'

let _counter = 0

/**
 * Generate a unique ID for new panel nodes.
 * Uses an incrementing counter with a random suffix to avoid collisions
 * across page reloads.
 */
function generateId(prefix: string): string {
  _counter += 1
  const random = Math.random().toString(36).slice(2, 8)
  return `${prefix}-${_counter}-${random}`
}

/**
 * Find a node by ID in the panel tree.
 * Returns the node if found, or undefined.
 */
function findNodeById(root: PanelNode, nodeId: string): PanelNode | undefined {
  if (root.id === nodeId) {
    return root
  }
  if (root._tag === 'SplitNode') {
    for (const child of root.children) {
      const found = findNodeById(child, nodeId)
      if (found) {
        return found
      }
    }
  }
  return undefined
}

/**
 * Split a pane identified by `paneId` into two panes.
 *
 * The original pane becomes one child of a new SplitNode. A new empty
 * LeafNode becomes the other child. The `direction` controls whether
 * the split is horizontal (side-by-side) or vertical (stacked).
 *
 * If the target pane is already a direct child of a SplitNode with the
 * same direction, the new pane is inserted adjacent to the target instead
 * of creating a nested split. This keeps the tree flat when possible.
 *
 * @param root - The root PanelNode tree
 * @param paneId - The ID of the LeafNode to split
 * @param direction - "horizontal" or "vertical"
 * @param newPaneContent - Optional content for the new pane (defaults to empty terminal pane)
 * @returns A new PanelNode tree with the split applied, or the original tree if paneId not found
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
      paneType: newPaneContent?.paneType ?? 'ghosttyTerminal',
      terminalId: newPaneContent?.terminalId,
      workspaceId: newPaneContent?.workspaceId ?? node.workspaceId,
    }
    const splitNode: SplitNode = {
      _tag: 'SplitNode',
      id: generateId('split'),
      direction,
      children: [node, newPane],
      sizes: [50, 50],
    }
    return splitNode
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
        const newPane: LeafNode = {
          _tag: 'LeafNode',
          id: generateId('pane'),
          paneType: newPaneContent?.paneType ?? 'ghosttyTerminal',
          terminalId: newPaneContent?.terminalId,
          workspaceId:
            newPaneContent?.workspaceId ??
            (node.children[targetIndex] as LeafNode).workspaceId,
        }
        const newChildren = [
          ...node.children.slice(0, targetIndex + 1),
          newPane,
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
      splitPaneRecursive(child, paneId, direction, newPaneContent)
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

  return node
}

/**
 * Close a pane identified by `paneId`.
 *
 * Removes the pane from its parent split. If the parent split is left with
 * a single child, the parent collapses and the remaining child takes its
 * place in the tree.
 *
 * If the target is the root leaf, returns undefined (no panes left).
 *
 * @param root - The root PanelNode tree
 * @param paneId - The ID of the LeafNode to close
 * @returns A new PanelNode tree with the pane removed, or undefined if empty
 */
function closePane(root: PanelNode, paneId: string): PanelNode | undefined {
  // Closing the root leaf → empty
  if (root._tag === 'LeafNode' && root.id === paneId) {
    return undefined
  }

  if (root._tag === 'SplitNode') {
    const result = closePaneInSplit(root, paneId)
    return result
  }

  return root
}

function closePaneInSplit(
  node: SplitNode,
  paneId: string
): PanelNode | undefined {
  // Check if a direct child is the target
  const targetIndex = node.children.findIndex(
    (child) => child._tag === 'LeafNode' && child.id === paneId
  )
  if (targetIndex !== -1) {
    const remaining = node.children.filter((_, i) => i !== targetIndex)
    if (remaining.length === 0) {
      return undefined
    }
    if (remaining.length === 1) {
      // Collapse the split — single child takes over
      return remaining[0]
    }
    // Redistribute sizes evenly
    const equalSize = 100 / remaining.length
    const newSizes = remaining.map(() => equalSize)
    return {
      ...node,
      children: remaining,
      sizes: newSizes,
    }
  }

  // Recurse into split children
  const newChildren: PanelNode[] = []
  let changed = false

  for (const child of node.children) {
    if (child._tag === 'SplitNode') {
      const result = closePaneInSplit(child, paneId)
      if (result !== child) {
        changed = true
      }
      if (result) {
        newChildren.push(result)
      }
      // If result is undefined, the entire subtree was removed
    } else {
      newChildren.push(child)
    }
  }

  if (!changed) {
    return node
  }

  if (newChildren.length === 0) {
    return undefined
  }
  if (newChildren.length === 1) {
    return newChildren[0]
  }
  const equalSize = 100 / newChildren.length
  const newSizes = newChildren.map(() => equalSize)
  return {
    ...node,
    children: newChildren,
    sizes: newSizes,
  }
}

/**
 * Count the total number of leaf panes in a layout tree.
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

/**
 * Get the maximum nesting depth of the layout tree.
 * A single LeafNode has depth 1. A SplitNode adds 1 to the max child depth.
 */
function getTreeDepth(node: PanelNode): number {
  if (node._tag === 'LeafNode') {
    return 1
  }
  let maxChildDepth = 0
  for (const child of node.children) {
    const d = getTreeDepth(child)
    if (d > maxChildDepth) {
      maxChildDepth = d
    }
  }
  return 1 + maxChildDepth
}

/**
 * Get all leaf node IDs in the tree, in order.
 */
function getLeafIds(node: PanelNode): string[] {
  if (node._tag === 'LeafNode') {
    return [node.id]
  }
  const ids: string[] = []
  for (const child of node.children) {
    ids.push(...getLeafIds(child))
  }
  return ids
}

/**
 * Replace a node in the tree by ID with a new node.
 */
function replaceNode(
  root: PanelNode,
  nodeId: string,
  replacement: PanelNode
): PanelNode {
  if (root.id === nodeId) {
    return replacement
  }
  if (root._tag === 'SplitNode') {
    const newChildren = root.children.map((child) =>
      replaceNode(child, nodeId, replacement)
    )
    const changed = newChildren.some((child, i) => child !== root.children[i])
    if (!changed) {
      return root
    }
    return { ...root, children: newChildren }
  }
  return root
}

/**
 * Find the parent SplitNode of a given node ID.
 * Returns the parent SplitNode and the index of the child within it,
 * or undefined if the node is the root or not found.
 */
function findParent(
  root: PanelNode,
  nodeId: string
): { parent: SplitNode; index: number } | undefined {
  if (root._tag === 'SplitNode') {
    for (let i = 0; i < root.children.length; i++) {
      const child = root.children[i]
      if (child && child.id === nodeId) {
        return { parent: root, index: i }
      }
      if (child && child._tag === 'SplitNode') {
        const result = findParent(child, nodeId)
        if (result) {
          return result
        }
      }
    }
  }
  return undefined
}

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
 * Get the first leaf node in a subtree, preferring a specific edge.
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
    // Unreachable in valid trees — SplitNodes always have children
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

/**
 * Resize step percentage — how much the active pane grows or shrinks
 * per keyboard shortcut press (in percentage points).
 */
const RESIZE_STEP = 5

/**
 * Compute the resize direction based on the keyboard arrow and the
 * split's orientation.
 *
 * Returns a delta to apply to the active pane's size:
 * - Positive delta → grow the active pane
 * - Negative delta → shrink the active pane
 * - undefined → the arrow direction doesn't match the split orientation
 *
 * Mapping:
 * - Horizontal split + Shift+ArrowRight → grow (+RESIZE_STEP)
 * - Horizontal split + Shift+ArrowLeft → shrink (-RESIZE_STEP)
 * - Vertical split + Shift+ArrowDown → grow (+RESIZE_STEP)
 * - Vertical split + Shift+ArrowUp → shrink (-RESIZE_STEP)
 *
 * Arrow keys that don't match the split orientation return undefined
 * so the caller can walk up to a higher ancestor.
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
 * Find the parent SplitNode of the active pane that can be resized in the
 * given direction, and compute the new sizes array.
 *
 * Walks up from the active pane's parent toward the root looking for a
 * SplitNode whose orientation matches the resize direction. Once found,
 * adjusts the sizes array by moving `RESIZE_STEP` percentage points from
 * the adjacent sibling to the active pane (or vice versa).
 *
 * Returns the parent SplitNode ID and new sizes, or undefined if resize
 * is not possible (e.g., no matching split orientation, at minimum size).
 *
 * @see Issue #79: Keyboard shortcut — resize panes
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

/** Minimum pane size percentage — prevents panes from being resized to nothing. */
const MIN_PANE_SIZE = 5

/**
 * Walk up the path from the active pane to find a resizable ancestor.
 * Extracted from computeResize to keep complexity under Biome's limit.
 */
function computeResizeFromPath(
  path: PanelNode[],
  direction: NavigationDirection
): { splitNodeId: string; newSizes: Record<string, number> } | undefined {
  // Walk up from the active pane's parent toward the root
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
 * Apply a resize delta to a SplitNode at a given child index.
 * Returns the new layout or undefined if resize is not possible.
 */
function applyResizeDelta(
  ancestor: SplitNode,
  childIndex: number,
  delta: number
): { splitNodeId: string; newSizes: Record<string, number> } | undefined {
  // Find the sibling to steal/give space from.
  // Growing → take from the next sibling. Shrinking → give to the previous sibling.
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

  // Enforce minimum size
  if (newSize < MIN_PANE_SIZE || newSiblingSize < MIN_PANE_SIZE) {
    return undefined
  }

  // Build the new sizes map using child IDs as keys (for the imperative API)
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
 * Find the sibling pane ID that should receive focus when a pane is closed.
 *
 * Resolution strategy:
 * 1. Find the parent SplitNode containing the pane being closed.
 * 2. If the pane is the first child → focus the next sibling.
 * 3. If the pane is the last or middle child → focus the previous sibling.
 * 4. The sibling may be a SplitNode, in which case we drill into it to
 *    find the nearest leaf (first leaf for next-sibling, last leaf for
 *    previous-sibling).
 * 5. If no parent exists (pane is the root) → return null (no panes remain).
 *
 * This function must be called BEFORE `closePane` mutates the tree, since
 * the pane being closed needs to be present to locate its parent and siblings.
 *
 * @param root - The root PanelNode tree (before close mutation)
 * @param paneId - The ID of the pane about to be closed
 * @returns The leaf ID to focus, or null if no sibling exists
 *
 * @see Issue #149: Focus auto-transfer on pane close
 */
function findSiblingPaneId(root: PanelNode, paneId: string): string | null {
  // Root leaf → no siblings
  if (root._tag === 'LeafNode') {
    return null
  }

  const parentInfo = findParent(root, paneId)
  if (!parentInfo) {
    return null
  }

  const { parent, index } = parentInfo
  const siblingCount = parent.children.length

  // Only child → no sibling (parent will collapse)
  if (siblingCount <= 1) {
    return null
  }

  // First child → focus next sibling; otherwise focus previous sibling
  const siblingIndex = index === 0 ? 1 : index - 1
  const sibling = parent.children[siblingIndex]
  if (!sibling) {
    return null
  }

  // If the sibling is a leaf, return its ID directly.
  // If it's a split, drill into it to find the nearest edge leaf.
  // When focusing the next sibling (index === 0), enter from the left/top edge (first).
  // When focusing the previous sibling (index > 0), enter from the right/bottom edge (last).
  const edge = index === 0 ? 'first' : 'last'
  return getEdgeLeaf(sibling, edge).id
}

/**
 * Get the first leaf ID in a layout tree (DFS order).
 * Returns undefined if the tree has no leaves (should not happen for valid trees).
 */
function getFirstLeafId(root: PanelNode): string | undefined {
  if (root._tag === 'LeafNode') {
    return root.id
  }
  for (const child of root.children) {
    const leafId = getFirstLeafId(child)
    if (leafId) {
      return leafId
    }
  }
  return undefined
}

/**
 * Get the last leaf ID in a layout tree (DFS order).
 * Returns undefined if the tree has no leaves (should not happen for valid trees).
 */
function getLastLeafId(root: PanelNode): string | undefined {
  if (root._tag === 'LeafNode') {
    return root.id
  }
  for (let i = root.children.length - 1; i >= 0; i--) {
    const child = root.children[i]
    if (child) {
      const leafId = getLastLeafId(child)
      if (leafId) {
        return leafId
      }
    }
  }
  return undefined
}

/**
 * Validate that an activePaneId references an existing leaf node in the
 * layout tree. If it does not (stale reference, null when panes exist),
 * falls back to the first leaf in the tree.
 *
 * Enforces the invariant: "there is always exactly one focused pane when
 * at least one pane exists."
 *
 * @param root - The current layout tree
 * @param activePaneId - The current activePaneId (may be null or stale)
 * @returns A valid leaf ID, or null only when the tree has no leaves
 *
 * @see Issue #150: Guaranteed active pane invariant
 */
function ensureValidActivePaneId(
  root: PanelNode,
  activePaneId: string | null
): string | null {
  // If activePaneId is set, check it references an existing leaf
  if (activePaneId) {
    const node = findNodeById(root, activePaneId)
    if (node && node._tag === 'LeafNode') {
      return activePaneId
    }
  }

  // activePaneId is null or stale — fall back to first leaf
  return getFirstLeafId(root) ?? null
}

interface RepairPanelLayoutTreeResult {
  readonly layoutTree: PanelNode | undefined
  readonly wasRepaired: boolean
}

const VALID_PANE_TYPES = new Set([
  'terminal',
  'diff',
  'devServerTerminal',
  'review',
  'ghosttyTerminal',
])
const VALID_SPLIT_DIRECTIONS = new Set(['horizontal', 'vertical'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function hasInvalidLeafOptionalFields(node: Record<string, unknown>): boolean {
  return (
    ('devServerOpen' in node &&
      node.devServerOpen !== undefined &&
      typeof node.devServerOpen !== 'boolean') ||
    ('devServerTerminalId' in node &&
      node.devServerTerminalId !== undefined &&
      typeof node.devServerTerminalId !== 'string') ||
    ('diffOpen' in node &&
      node.diffOpen !== undefined &&
      typeof node.diffOpen !== 'boolean') ||
    ('ghosttySurfaceId' in node &&
      node.ghosttySurfaceId !== undefined &&
      typeof node.ghosttySurfaceId !== 'number') ||
    ('terminalId' in node &&
      node.terminalId !== undefined &&
      typeof node.terminalId !== 'string') ||
    ('workspaceId' in node &&
      node.workspaceId !== undefined &&
      typeof node.workspaceId !== 'string')
  )
}

function repairLeafNode(
  node: Record<string, unknown>
): RepairPanelLayoutTreeResult {
  if (
    typeof node.id !== 'string' ||
    node.id.length === 0 ||
    typeof node.paneType !== 'string' ||
    !VALID_PANE_TYPES.has(node.paneType)
  ) {
    return { layoutTree: undefined, wasRepaired: true }
  }

  // Migrate persisted 'terminal' panes to 'ghosttyTerminal'.
  // Ghostty is now the default terminal renderer; old xterm.js panes
  // from prior sessions are upgraded during layout repair.
  const migratedPaneType =
    node.paneType === 'terminal' ? 'ghosttyTerminal' : node.paneType
  const paneTypeMigrated = migratedPaneType !== node.paneType

  if (!(hasInvalidLeafOptionalFields(node) || paneTypeMigrated)) {
    return { layoutTree: node as unknown as PanelNode, wasRepaired: false }
  }

  const repairedLeaf: LeafNode = {
    _tag: 'LeafNode',
    id: node.id,
    paneType: migratedPaneType as LeafNode['paneType'],
    ...(typeof node.devServerOpen === 'boolean'
      ? { devServerOpen: node.devServerOpen }
      : {}),
    ...(typeof node.devServerTerminalId === 'string'
      ? { devServerTerminalId: node.devServerTerminalId }
      : {}),
    ...(typeof node.diffOpen === 'boolean' ? { diffOpen: node.diffOpen } : {}),
    ...(typeof node.ghosttySurfaceId === 'number'
      ? { ghosttySurfaceId: node.ghosttySurfaceId }
      : {}),
    // Strip terminalId when migrating to ghosttyTerminal — ghostty panes
    // self-initialize and don't use xterm terminal IDs.
    ...(!paneTypeMigrated && typeof node.terminalId === 'string'
      ? { terminalId: node.terminalId }
      : {}),
    ...(typeof node.workspaceId === 'string'
      ? { workspaceId: node.workspaceId }
      : {}),
  }

  return { layoutTree: repairedLeaf, wasRepaired: true }
}

function hasValidSplitSizes(
  sizes: unknown,
  childCount: number
): sizes is readonly number[] {
  return (
    Array.isArray(sizes) &&
    sizes.length === childCount &&
    sizes.every(
      (size) => typeof size === 'number' && Number.isFinite(size) && size > 0
    )
  )
}

function repairSplitNode(
  node: Record<string, unknown>
): RepairPanelLayoutTreeResult {
  if (
    typeof node.id !== 'string' ||
    node.id.length === 0 ||
    typeof node.direction !== 'string' ||
    !VALID_SPLIT_DIRECTIONS.has(node.direction) ||
    !Array.isArray(node.children)
  ) {
    return { layoutTree: undefined, wasRepaired: true }
  }

  const repairedChildren: PanelNode[] = []
  let didRepairChildren = false

  for (const child of node.children) {
    const repairedChild = repairPanelLayoutTree(child)
    if (repairedChild.wasRepaired) {
      didRepairChildren = true
    }
    if (repairedChild.layoutTree) {
      repairedChildren.push(repairedChild.layoutTree)
    }
  }

  if (repairedChildren.length === 0) {
    return { layoutTree: undefined, wasRepaired: true }
  }

  if (repairedChildren.length === 1) {
    return { layoutTree: repairedChildren[0], wasRepaired: true }
  }

  if (
    !didRepairChildren &&
    hasValidSplitSizes(node.sizes, repairedChildren.length)
  ) {
    return { layoutTree: node as unknown as PanelNode, wasRepaired: false }
  }

  const equalSize = 100 / repairedChildren.length
  return {
    layoutTree: {
      _tag: 'SplitNode',
      id: node.id,
      direction: node.direction as SplitNode['direction'],
      children: repairedChildren,
      sizes: hasValidSplitSizes(node.sizes, repairedChildren.length)
        ? node.sizes
        : repairedChildren.map(() => equalSize),
    },
    wasRepaired: true,
  }
}

function repairPanelLayoutTree(node: unknown): RepairPanelLayoutTreeResult {
  if (!isRecord(node) || typeof node._tag !== 'string') {
    return { layoutTree: undefined, wasRepaired: true }
  }

  if (node._tag === 'LeafNode') {
    return repairLeafNode(node)
  }

  if (node._tag !== 'SplitNode') {
    return { layoutTree: undefined, wasRepaired: true }
  }

  return repairSplitNode(node)
}

/**
 * Collect all leaf nodes from the layout tree whose terminal IDs are
 * stale (not present in the live terminal set). These are candidates
 * for respawning after a full app restart.
 */
function getStaleTerminalLeaves(
  node: PanelNode,
  liveTerminalIds: ReadonlySet<string>
): readonly LeafNode[] {
  if (node._tag === 'LeafNode') {
    // Ghostty panes self-initialize their own surfaces and don't use
    // xterm terminal IDs — skip them during stale-terminal detection.
    if (node.paneType === 'ghosttyTerminal') {
      return []
    }
    if (
      node.terminalId !== undefined &&
      !liveTerminalIds.has(node.terminalId)
    ) {
      return [node]
    }
    return []
  }
  return node.children.flatMap((child) =>
    getStaleTerminalLeaves(child, liveTerminalIds)
  )
}

/**
 * Reconcile a persisted layout tree by replacing stale terminal IDs
 * with new ones from the provided mapping.
 *
 * Used after respawning terminals for stale panes: the mapping contains
 * `{ oldTerminalId -> newTerminalId }` entries. Leaves whose terminal
 * ID appears as a key are updated to the new ID. Leaves with stale IDs
 * that have no mapping entry (e.g., spawn failed) have their terminal
 * ID cleared.
 *
 * Returns the original tree if no changes are needed (referential equality).
 */
function reconcileLayout(
  node: PanelNode,
  liveTerminalIds: ReadonlySet<string>,
  respawnedIds?: ReadonlyMap<string, string>
): PanelNode {
  if (node._tag === 'LeafNode') {
    if (
      node.terminalId !== undefined &&
      !liveTerminalIds.has(node.terminalId)
    ) {
      const newId = respawnedIds?.get(node.terminalId)
      return {
        ...node,
        terminalId: newId,
      }
    }
    return node
  }

  let changed = false
  const newChildren = node.children.map((child) => {
    const reconciled = reconcileLayout(child, liveTerminalIds, respawnedIds)
    if (reconciled !== child) {
      changed = true
    }
    return reconciled
  })

  return changed ? { ...node, children: newChildren } : node
}

/**
 * Find an empty terminal pane in the layout tree.
 * An empty terminal pane is a LeafNode with paneType 'terminal' and no
 * terminalId assigned. Returns the first such leaf found in DFS order,
 * or undefined if all panes are occupied.
 *
 * Note: ghosttyTerminal panes are NOT matched — they self-initialize
 * and should not be repurposed for xterm.js terminal assignment.
 */
function findEmptyTerminalPane(node: PanelNode): LeafNode | undefined {
  if (
    node._tag === 'LeafNode' &&
    node.paneType === 'terminal' &&
    !node.terminalId
  ) {
    return node
  }
  if (node._tag === 'SplitNode') {
    for (const child of node.children) {
      const found = findEmptyTerminalPane(child)
      if (found) {
        return found
      }
    }
  }
  return undefined
}

/**
 * Find a leaf node that is displaying a specific terminal.
 * Returns the LeafNode if found, or undefined.
 */
function findLeafByTerminalId(
  node: PanelNode,
  terminalId: string
): LeafNode | undefined {
  if (node._tag === 'LeafNode') {
    return node.terminalId === terminalId ? node : undefined
  }
  for (const child of node.children) {
    const found = findLeafByTerminalId(child, terminalId)
    if (found) {
      return found
    }
  }
  return undefined
}

/**
 * Collect all leaf nodes from a panel tree (DFS order).
 */
function getLeafNodes(node: PanelNode): LeafNode[] {
  if (node._tag === 'LeafNode') {
    return [node]
  }
  const leaves: LeafNode[] = []
  for (const child of node.children) {
    leaves.push(...getLeafNodes(child))
  }
  return leaves
}

/**
 * Resolve the active pane ID scoped to a specific workspace's sub-layout.
 *
 * If the global `activePaneId` belongs to one of this workspace's leaves,
 * it is returned as-is. Otherwise, falls back to the first leaf in the
 * workspace's sub-layout so that header buttons always operate on a pane
 * within their own workspace.
 */
function getScopedActivePaneId(
  subLayout: PanelNode,
  globalActivePaneId: string | null
): string | null {
  const leaves = getLeafNodes(subLayout)
  if (
    globalActivePaneId != null &&
    leaves.some((l) => l.id === globalActivePaneId)
  ) {
    return globalActivePaneId
  }
  return leaves[0]?.id ?? null
}

/**
 * Extract unique workspace IDs from the leaf nodes of a layout tree.
 * Returns an array of workspace IDs in the order they first appear (DFS).
 * Leaves without a workspaceId are grouped under `undefined`.
 */
function getWorkspaceIds(node: PanelNode): (string | undefined)[] {
  const leaves = getLeafNodes(node)
  const seen = new Set<string | undefined>()
  const ids: (string | undefined)[] = []
  for (const leaf of leaves) {
    if (!seen.has(leaf.workspaceId)) {
      seen.add(leaf.workspaceId)
      ids.push(leaf.workspaceId)
    }
  }
  return ids
}

/**
 * Filter a layout tree to contain only leaves matching a specific workspaceId.
 *
 * - If a SplitNode contains no matching leaves, it is removed.
 * - If a SplitNode is reduced to a single child, it is collapsed to that child.
 * - Sizes are redistributed proportionally among remaining children.
 *
 * Returns undefined if no matching leaves exist in the tree.
 */
function filterTreeByWorkspace(
  node: PanelNode,
  workspaceId: string | undefined
): PanelNode | undefined {
  if (node._tag === 'LeafNode') {
    return node.workspaceId === workspaceId ? node : undefined
  }

  const filteredChildren: PanelNode[] = []
  const retainedIndices: number[] = []

  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i]
    if (!child) {
      continue
    }
    const filtered = filterTreeByWorkspace(child, workspaceId)
    if (filtered) {
      filteredChildren.push(filtered)
      retainedIndices.push(i)
    }
  }

  if (filteredChildren.length === 0) {
    return undefined
  }

  if (filteredChildren.length === 1) {
    return filteredChildren[0]
  }

  // Redistribute sizes proportionally among retained children
  const retainedSizes = retainedIndices.map(
    (i) => node.sizes[i] ?? 100 / node.children.length
  )
  const totalRetained = retainedSizes.reduce((sum, s) => sum + s, 0)
  const normalizedSizes =
    totalRetained > 0
      ? retainedSizes.map((s) => (s / totalRetained) * 100)
      : retainedSizes.map(() => 100 / filteredChildren.length)

  return {
    ...node,
    children: filteredChildren,
    sizes: normalizedSizes,
  }
}

/**
 * Collect terminal IDs that should be removed when a pane is closed.
 *
 * When closing a pane, any terminal processes displayed in that pane
 * must be killed — you shouldn't have running terminals that aren't
 * in a pane. This function finds:
 * 1. The pane's main terminal (terminalId)
 * 2. The pane's dev server terminal (devServerTerminalId), if any
 *
 * Returns an empty array when:
 * - The layout is undefined
 * - The paneId doesn't exist in the layout
 * - The pane is not a LeafNode
 * - The pane has no terminal assigned
 *
 * This is the pure logic extracted from `handleClosePane` in
 * HomeComponent, making it testable without React component
 * infrastructure.
 *
 * @param layout - The current panel layout tree (may be undefined)
 * @param paneId - The ID of the pane being closed
 * @returns Array of terminal IDs that should be removed from the service
 */
function getTerminalIdsToRemove(
  layout: PanelNode | undefined,
  paneId: string
): readonly string[] {
  if (!layout) {
    return []
  }
  const node = findNodeById(layout, paneId)
  if (!node || node._tag !== 'LeafNode') {
    return []
  }
  const ids: string[] = []
  if (node.terminalId) {
    ids.push(node.terminalId)
  }
  if (node.devServerTerminalId) {
    ids.push(node.devServerTerminalId)
  }
  return ids
}

/**
 * Compute whether closing a pane should proceed immediately or show a
 * confirmation dialog.
 *
 * Uses the cached terminal list (from the 5-second poll) to make an
 * instant, synchronous decision — no RPC calls at close time.
 *
 * Returns `'close'` when the pane can be closed immediately, or
 * `'confirm'` when a confirmation dialog should be shown because the
 * terminal has a running child process.
 *
 * This follows the same pattern as VS Code's ChildProcessMonitor:
 * process state is pre-cached and read synchronously at close time.
 *
 * @param layout - The current panel layout tree (may be undefined)
 * @param paneId - The ID of the pane being closed
 * @param terminals - The cached terminal list from useTerminalList
 * @returns `'close'` to close immediately, `'confirm'` to show dialog
 */
function computeClosePaneAction(
  layout: PanelNode | undefined,
  paneId: string,
  terminals: ReadonlyArray<{
    readonly id: string
    readonly hasChildProcess: boolean
  }>
): 'close' | 'confirm' {
  return shouldConfirmClose(layout, paneId, terminals) ? 'confirm' : 'close'
}

/**
 * Compute whether closing a workspace should proceed immediately or show
 * a confirmation dialog.
 *
 * Uses the cached terminal list to make an instant, synchronous decision.
 * Returns `'confirm'` when any terminal in the workspace has a running
 * child process.
 *
 * @param layout - The current panel layout tree (may be undefined)
 * @param workspaceId - The workspace being closed
 * @param terminals - The cached terminal list from useTerminalList
 * @returns `'close'` to close immediately, `'confirm'` to show dialog
 */
function computeCloseWorkspaceAction(
  layout: PanelNode | undefined,
  workspaceId: string,
  terminals: ReadonlyArray<{
    readonly id: string
    readonly hasChildProcess: boolean
  }>
): 'close' | 'confirm' {
  return shouldConfirmCloseWorkspace(layout, workspaceId, terminals)
    ? 'confirm'
    : 'close'
}

/**
 * Determine whether closing a pane should show a confirmation dialog.
 *
 * Returns true only when ALL of these conditions hold:
 * 1. A layout tree exists
 * 2. The pane ID references a LeafNode in the tree
 * 3. The leaf has a terminalId assigned
 * 4. That terminal appears in the live terminal list with
 *    `hasChildProcess === true`
 *
 * This is the pure logic extracted from HomeComponent's `gatedClosePane`
 * callback, making it testable without React component infrastructure.
 *
 * @param layout - The current panel layout tree (may be undefined)
 * @param paneId - The ID of the pane being closed
 * @param terminals - The live terminal list from useTerminalList
 * @returns Whether the close confirmation dialog should be shown
 */
function shouldConfirmClose(
  layout: PanelNode | undefined,
  paneId: string,
  terminals: ReadonlyArray<{
    readonly id: string
    readonly hasChildProcess: boolean
  }>
): boolean {
  if (!layout) {
    return false
  }
  const node = findNodeById(layout, paneId)
  if (!node || node._tag !== 'LeafNode' || !node.terminalId) {
    return false
  }
  const terminal = terminals.find((t) => t.id === node.terminalId)
  return terminal?.hasChildProcess === true
}

/**
 * Find the newly created leaf after a split operation.
 *
 * Compares the leaf IDs before and after the split to identify which
 * leaf is new. This is the pure logic extracted from `handleSplitPane`
 * in HomeComponent, enabling unit testing without React hooks.
 *
 * @param before - The layout tree before the split
 * @param after - The layout tree after the split
 * @returns The new LeafNode, or undefined if no new leaf was created
 */
function findNewLeafAfterSplit(
  before: PanelNode,
  after: PanelNode
): LeafNode | undefined {
  const beforeIds = new Set(getLeafIds(before))
  const afterLeaves = getLeafNodes(after)
  return afterLeaves.find((leaf) => !beforeIds.has(leaf.id))
}

// ---------------------------------------------------------------------------
// Terminal pane assignment — pure computation
// ---------------------------------------------------------------------------

/**
 * Result of computing where a terminal should be assigned in the layout.
 *
 * @see computeTerminalPaneAssignment
 */
interface TerminalPaneAssignmentResult {
  /** The pane ID that should receive focus (the pane displaying the terminal). */
  readonly activePaneId: string
  /** The updated layout tree with the terminal assigned. */
  readonly layoutTree: PanelNode
  /**
   * Whether the dev server auto-open logic should fire for this assignment.
   * True for new pane creation / replacement, false when just focusing an
   * existing pane that already has the terminal.
   */
  readonly triggerDevServer: boolean
}

interface TerminalPaneAssignmentOptions {
  readonly autoOpenDevServer?: boolean | undefined
}

/**
 * Compute the layout tree mutation and focus target for assigning a terminal
 * to a pane.
 *
 * This is the pure logic extracted from `handleAssignTerminalToPane` in the
 * route component, making it testable without React hooks or LiveStore.
 *
 * Resolution strategy (in order):
 * 1. If no `paneId` and the terminal already has a pane → focus it.
 * 2. If no layout exists → create a single-pane layout.
 * 3. If a specific `paneId` is given → replace that pane's content.
 * 4. If an empty terminal pane exists → assign to it.
 * 5. Otherwise → split the last leaf vertically and assign to the new pane.
 *
 * In ALL cases the returned `activePaneId` points to the pane displaying the
 * terminal, ensuring newly spawned terminals are immediately focused.
 *
 * @param base - The current layout tree, or undefined if no layout exists
 * @param terminalId - The terminal to display
 * @param workspaceId - The workspace the terminal belongs to
 * @param paneId - Optional specific pane to assign to
 * @returns The new layout tree, active pane ID, and dev-server trigger flag
 */
function computeTerminalPaneAssignment(
  base: PanelNode | undefined,
  terminalId: string,
  workspaceId: string,
  paneId?: string,
  options?: TerminalPaneAssignmentOptions
): TerminalPaneAssignmentResult {
  const shouldAutoOpenDevServer = options?.autoOpenDevServer === true

  // 1. If no specific pane target, check if this terminal already has a pane.
  if (!paneId && base) {
    const existingLeaf = findLeafByTerminalId(base, terminalId)
    if (existingLeaf) {
      return {
        layoutTree: base,
        activePaneId: existingLeaf.id,
        triggerDevServer: false,
      }
    }
  }

  // 2. No layout at all — create a new single-pane layout.
  if (!base) {
    const newLeafId = generateId('pane')
    const newLeaf: LeafNode = {
      _tag: 'LeafNode',
      id: newLeafId,
      paneType: 'terminal',
      terminalId,
      workspaceId,
    }
    return {
      layoutTree: newLeaf,
      activePaneId: newLeafId,
      triggerDevServer: shouldAutoOpenDevServer,
    }
  }

  // 3. Specific pane ID given — replace that pane's content.
  if (paneId) {
    const targetLeaf: LeafNode = {
      _tag: 'LeafNode',
      id: paneId,
      paneType: 'terminal',
      terminalId,
      workspaceId,
    }
    const newTree = replaceNode(base, paneId, targetLeaf)
    return {
      layoutTree: newTree,
      activePaneId: paneId,
      triggerDevServer: shouldAutoOpenDevServer,
    }
  }

  // 4. Find an empty terminal pane.
  const emptyPane = findEmptyTerminalPane(base)
  if (emptyPane) {
    const updatedLeaf: LeafNode = {
      _tag: 'LeafNode',
      id: emptyPane.id,
      paneType: 'terminal',
      terminalId,
      workspaceId,
    }
    const newTree = replaceNode(base, emptyPane.id, updatedLeaf)
    return {
      layoutTree: newTree,
      activePaneId: emptyPane.id,
      triggerDevServer: shouldAutoOpenDevServer,
    }
  }

  // 5. No empty pane — split the last leaf and assign to the new pane.
  const lastLeafId = getLastLeafId(base)
  if (lastLeafId) {
    const newPaneContent: Partial<LeafNode> = {
      paneType: 'terminal',
      terminalId,
      workspaceId,
    }
    const newTree = splitPane(base, lastLeafId, 'vertical', newPaneContent)
    const newLeaf = findNewLeafAfterSplit(base, newTree)
    const newActivePaneId = newLeaf?.id ?? lastLeafId
    return {
      layoutTree: newTree,
      activePaneId: newActivePaneId,
      triggerDevServer: shouldAutoOpenDevServer,
    }
  }

  // Fallback — should not happen for valid trees, but return base unchanged.
  return {
    layoutTree: base,
    activePaneId: getFirstLeafId(base) ?? '',
    triggerDevServer: false,
  }
}

// ---------------------------------------------------------------------------
// Workspace frame drag-and-drop helpers
// ---------------------------------------------------------------------------

/** Custom data type identifier for workspace frame drag operations. */
const WORKSPACE_FRAME_TYPE = 'workspace-frame'

/** Type guard: check if drag source data is a workspace frame. */
function isWorkspaceFrameData(data: Record<string, unknown>): data is {
  type: typeof WORKSPACE_FRAME_TYPE
  workspaceId: string
  index: number
} {
  return data.type === WORKSPACE_FRAME_TYPE
}

/**
 * Sort workspace layouts by an explicit ordering.
 *
 * When `workspaceOrder` is non-null, workspaces are sorted to match
 * the given ID order. Workspaces not in the order array are appended
 * at the end, preserving their relative order.
 *
 * When `workspaceOrder` is null, the original array is returned as-is
 * (DFS traversal order from the layout tree).
 *
 * Returns a new array — does not mutate the input.
 */
/**
 * Collect all terminal IDs (including dev server terminals) from leaves
 * that belong to the given workspace.
 *
 * Returns an array of terminal IDs that should be removed when closing
 * all panes for a workspace.
 */
function getWorkspaceTerminalIds(
  layout: PanelNode | undefined,
  workspaceId: string
): readonly string[] {
  if (!layout) {
    return []
  }
  const leaves = getLeafNodes(layout)
  const ids: string[] = []
  for (const leaf of leaves) {
    if (leaf.workspaceId !== workspaceId) {
      continue
    }
    if (leaf.terminalId) {
      ids.push(leaf.terminalId)
    }
    if (leaf.devServerTerminalId) {
      ids.push(leaf.devServerTerminalId)
    }
  }
  return ids
}

/**
 * Determine whether closing a workspace should show a confirmation dialog.
 *
 * Returns true when the workspace has any terminal with a running child
 * process. This prevents accidental loss of running work (e.g., a dev
 * server, vim, or an AI agent) when the user clicks "Close workspace".
 *
 * @param layout - The current panel layout tree (may be undefined)
 * @param workspaceId - The workspace being closed
 * @param terminals - The live terminal list from useTerminalList
 * @returns Whether the close confirmation dialog should be shown
 */
function shouldConfirmCloseWorkspace(
  layout: PanelNode | undefined,
  workspaceId: string,
  terminals: ReadonlyArray<{
    readonly id: string
    readonly hasChildProcess: boolean
  }>
): boolean {
  const terminalIds = getWorkspaceTerminalIds(layout, workspaceId)
  return terminalIds.some((id) => {
    const terminal = terminals.find((t) => t.id === id)
    return terminal?.hasChildProcess === true
  })
}

/**
 * Return active terminals (those with running child processes) for a
 * workspace, including their human-readable foreground process labels.
 *
 * Used by the destroy workspace dialog to show which terminals will be
 * killed, so the user can make an informed decision without a second
 * confirmation modal.
 *
 * @param layout - The current panel layout tree (may be undefined)
 * @param workspaceId - The workspace being destroyed
 * @param terminals - The live terminal list from useTerminalList
 * @returns Array of active terminal descriptors with id and display label
 */
function getWorkspaceActiveTerminals(
  layout: PanelNode | undefined,
  workspaceId: string,
  terminals: ReadonlyArray<{
    readonly id: string
    readonly hasChildProcess: boolean
    readonly foregroundProcess: {
      readonly label: string
    } | null
  }>
): ReadonlyArray<{ readonly id: string; readonly label: string }> {
  const terminalIds = getWorkspaceTerminalIds(layout, workspaceId)
  const result: { readonly id: string; readonly label: string }[] = []
  for (const id of terminalIds) {
    const terminal = terminals.find((t) => t.id === id)
    if (terminal?.hasChildProcess === true) {
      result.push({
        id,
        label: terminal.foregroundProcess?.label ?? 'Running process',
      })
    }
  }
  return result
}

/**
 * Remove all leaf nodes belonging to a workspace from the layout tree.
 *
 * Sequentially closes each workspace leaf. Returns the resulting tree
 * (or undefined if all panes were removed).
 */
function closeWorkspacePanes(
  layout: PanelNode,
  workspaceId: string
): PanelNode | undefined {
  let current: PanelNode | undefined = layout
  // Iteratively close workspace leaves until none remain.
  // Each closePane call may restructure the tree, so we re-scan after each.
  while (current) {
    const leaves = getLeafNodes(current)
    const workspaceLeaf = leaves.find((l) => l.workspaceId === workspaceId)
    if (!workspaceLeaf) {
      break
    }
    current = closePane(current, workspaceLeaf.id)
  }
  return current
}

function sortWorkspaceLayouts<
  T extends { readonly workspaceId: string | undefined },
>(layouts: readonly T[], workspaceOrder: string[] | null): T[] {
  const result = [...layouts]
  if (!workspaceOrder || workspaceOrder.length === 0) {
    return result
  }

  const orderIndex = new Map(workspaceOrder.map((id, idx) => [id, idx]))
  result.sort((a, b) => {
    const aIdx =
      a.workspaceId != null
        ? (orderIndex.get(a.workspaceId) ?? Number.MAX_SAFE_INTEGER)
        : Number.MAX_SAFE_INTEGER
    const bIdx =
      b.workspaceId != null
        ? (orderIndex.get(b.workspaceId) ?? Number.MAX_SAFE_INTEGER)
        : Number.MAX_SAFE_INTEGER
    return aIdx - bIdx
  })
  return result
}

export {
  closePane,
  closeWorkspacePanes,
  computeClosePaneAction,
  computeCloseWorkspaceAction,
  computeResize,
  computeTerminalPaneAssignment,
  countLeaves,
  ensureValidActivePaneId,
  filterTreeByWorkspace,
  findEmptyTerminalPane,
  findLeafByTerminalId,
  findNewLeafAfterSplit,
  findNodeById,
  findPaneInDirection,
  findParent,
  findSiblingPaneId,
  generateId,
  getFirstLeafId,
  getLastLeafId,
  getLeafIds,
  getLeafNodes,
  getScopedActivePaneId,
  getStaleTerminalLeaves,
  getTerminalIdsToRemove,
  getTreeDepth,
  getWorkspaceActiveTerminals,
  getWorkspaceIds,
  getWorkspaceTerminalIds,
  isWorkspaceFrameData,
  repairPanelLayoutTree,
  reconcileLayout,
  replaceNode,
  shouldConfirmClose,
  shouldConfirmCloseWorkspace,
  sortWorkspaceLayouts,
  splitPane,
  WORKSPACE_FRAME_TYPE,
}
export type { NavigationDirection }
