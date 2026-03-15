/**
 * Layout migration: flat PanelNode → hierarchical WindowLayout.
 *
 * Converts the legacy flat `PanelNode` layout tree into the new hierarchical
 * `WindowLayout` format (WindowTabs > WorkspaceTiles > PanelTabs > PanelSplits).
 *
 * The migration:
 * 1. Extracts unique workspace IDs from the old flat tree
 * 2. Filters the tree per workspace using `filterTreeByWorkspace`
 * 3. Converts old `LeafNode`/`SplitNode` to new `PanelLeafNode`/`PanelSplitNode`
 * 4. Promotes sidebar toggle flags to independent panel tabs:
 *    - `diffOpen: true` → additional diff panel tab
 *    - `devServerOpen: true` → additional devServer panel tab
 * 5. Wraps each workspace's panels in a `WorkspaceTileLeaf`
 * 6. Arranges workspace tiles in a horizontal split (respecting `workspaceOrder`)
 * 7. Wraps everything in a single `WindowTab` inside a `WindowLayout`
 *
 * All functions are pure — the old tree is never mutated.
 *
 * @see packages/shared/src/types.ts — PanelNode (legacy), WindowLayout (new)
 * @see apps/web/src/panels/layout-utils.ts — filterTreeByWorkspace, getWorkspaceIds
 */

import type {
  LeafNode,
  PanelLeafNode,
  PanelNode,
  PanelSplitNode,
  PanelTab,
  PanelTreeNode,
  SplitNode,
  WindowLayout,
  WindowTab,
  WorkspaceTileLeaf,
  WorkspaceTileNode,
  WorkspaceTileSplit,
} from '@laborer/shared/types'
import { filterTreeByWorkspace, getWorkspaceIds } from './layout-utils'

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

let _counter = 0

/**
 * Generate a unique ID for migration-created nodes.
 * Uses an incrementing counter with a random suffix to avoid collisions.
 */
function generateMigrationId(prefix: string): string {
  _counter += 1
  const random = Math.random().toString(36).slice(2, 8)
  return `${prefix}-${_counter}-${random}`
}

// ---------------------------------------------------------------------------
// Old → New node conversion
// ---------------------------------------------------------------------------

/**
 * Convert an old `LeafNode` to a new `PanelLeafNode`.
 * Strips the sidebar toggle flags (`diffOpen`, `devServerOpen`,
 * `devServerTerminalId`) since those are promoted to independent panel types.
 */
function convertLeafNode(node: LeafNode): PanelLeafNode {
  return {
    _tag: 'PanelLeafNode',
    id: node.id,
    paneType: node.paneType,
    ...(node.terminalId !== undefined ? { terminalId: node.terminalId } : {}),
    ...(node.workspaceId !== undefined
      ? { workspaceId: node.workspaceId }
      : {}),
  }
}

/**
 * Convert an old `PanelNode` tree to a new `PanelTreeNode` tree.
 * Recursively converts all `LeafNode`s to `PanelLeafNode`s and
 * all `SplitNode`s to `PanelSplitNode`s.
 */
function convertPanelTree(node: PanelNode): PanelTreeNode {
  if (node._tag === 'LeafNode') {
    return convertLeafNode(node)
  }

  const children = node.children.map(convertPanelTree)
  const result: PanelSplitNode = {
    _tag: 'PanelSplitNode',
    id: node.id,
    direction: node.direction,
    children,
    sizes: node.sizes,
  }
  return result
}

// ---------------------------------------------------------------------------
// New → Old node conversion (for rendering compatibility)
// ---------------------------------------------------------------------------

/**
 * Convert a new `PanelTreeNode` tree back to a legacy `PanelNode` tree.
 *
 * This is needed because `PanelManager` and `layout-utils` functions operate
 * on the legacy `PanelNode` type (`LeafNode` / `SplitNode`). When the
 * hierarchical layout provides a `PanelTreeNode` (from a panel tab's layout),
 * it must be converted to a `PanelNode` before passing to these consumers.
 */
function convertPanelTreeToLegacy(node: PanelTreeNode): PanelNode {
  if (node._tag === 'PanelLeafNode') {
    const leaf: LeafNode = {
      _tag: 'LeafNode',
      id: node.id,
      paneType: node.paneType,
      ...(node.terminalId !== undefined ? { terminalId: node.terminalId } : {}),
      ...(node.workspaceId !== undefined
        ? { workspaceId: node.workspaceId }
        : {}),
    }
    return leaf
  }

  const children = node.children.map(convertPanelTreeToLegacy)
  const result: SplitNode = {
    _tag: 'SplitNode',
    id: node.id,
    direction: node.direction,
    children,
    sizes: [...node.sizes],
  }
  return result
}

// ---------------------------------------------------------------------------
// Sidebar flag extraction
// ---------------------------------------------------------------------------

/**
 * Collect sidebar toggle flags from all leaf nodes in a workspace's sub-tree.
 * Returns flags indicating whether any leaf had `diffOpen` or `devServerOpen`
 * set to `true`, and the associated `devServerTerminalId` if present.
 */
interface SidebarFlags {
  readonly devServerOpen: boolean
  readonly devServerTerminalId: string | undefined
  readonly diffOpen: boolean
}

function collectSidebarFlags(node: PanelNode): SidebarFlags {
  if (node._tag === 'LeafNode') {
    return {
      diffOpen: node.diffOpen === true,
      devServerOpen: node.devServerOpen === true,
      devServerTerminalId: node.devServerTerminalId,
    }
  }

  let diffOpen = false
  let devServerOpen = false
  let devServerTerminalId: string | undefined

  for (const child of node.children) {
    const childFlags = collectSidebarFlags(child)
    if (childFlags.diffOpen) {
      diffOpen = true
    }
    if (childFlags.devServerOpen) {
      devServerOpen = true
      if (childFlags.devServerTerminalId !== undefined) {
        devServerTerminalId = childFlags.devServerTerminalId
      }
    }
  }

  return { diffOpen, devServerOpen, devServerTerminalId }
}

// ---------------------------------------------------------------------------
// Workspace → WorkspaceTileLeaf conversion
// ---------------------------------------------------------------------------

/**
 * Build a `WorkspaceTileLeaf` for a workspace from its old sub-tree.
 *
 * Creates:
 * 1. A main panel tab from the converted sub-tree
 * 2. An additional diff panel tab if `diffOpen` was true on any leaf
 * 3. An additional devServer panel tab if `devServerOpen` was true on any leaf
 *
 * The main panel tab is set as the active tab.
 */
function buildWorkspaceTile(
  workspaceId: string | undefined,
  subTree: PanelNode,
  activePaneId: string | null
): WorkspaceTileLeaf {
  const panelTabs: PanelTab[] = []

  // Main panel tab from the converted tree
  const convertedTree = convertPanelTree(subTree)
  const mainTabId = generateMigrationId('panel-tab')
  const mainTab: PanelTab = {
    id: mainTabId,
    label: 'Terminal',
    panelLayout: convertedTree,
    focusedPaneId: resolveFocusedPaneId(convertedTree, activePaneId),
  }
  panelTabs.push(mainTab)

  // Extract sidebar flags from the OLD tree (before conversion)
  const flags = collectSidebarFlags(subTree)

  // Create additional panel tabs for promoted sidebar panels
  if (flags.diffOpen) {
    const diffTabId = generateMigrationId('panel-tab')
    const diffLeaf: PanelLeafNode = {
      _tag: 'PanelLeafNode',
      id: generateMigrationId('pane'),
      paneType: 'diff',
      ...(workspaceId !== undefined ? { workspaceId } : {}),
    }
    panelTabs.push({
      id: diffTabId,
      label: 'Diff',
      panelLayout: diffLeaf,
      focusedPaneId: diffLeaf.id,
    })
  }

  if (flags.devServerOpen) {
    const devServerTabId = generateMigrationId('panel-tab')
    const devServerLeaf: PanelLeafNode = {
      _tag: 'PanelLeafNode',
      id: generateMigrationId('pane'),
      paneType: 'devServerTerminal',
      ...(flags.devServerTerminalId !== undefined
        ? { terminalId: flags.devServerTerminalId }
        : {}),
      ...(workspaceId !== undefined ? { workspaceId } : {}),
    }
    panelTabs.push({
      id: devServerTabId,
      label: 'Dev Server',
      panelLayout: devServerLeaf,
      focusedPaneId: devServerLeaf.id,
    })
  }

  const tileId = generateMigrationId('workspace-tile')
  const tile: WorkspaceTileLeaf = {
    _tag: 'WorkspaceTileLeaf',
    id: tileId,
    workspaceId: workspaceId ?? '',
    panelTabs,
    activePanelTabId: mainTabId,
  }
  return tile
}

/**
 * Resolve the focused pane ID for a panel tab.
 * If the global `activePaneId` belongs to a leaf in this tree, use it.
 * Otherwise, fall back to the first leaf.
 */
function resolveFocusedPaneId(
  tree: PanelTreeNode,
  activePaneId: string | null
): string | undefined {
  const leafIds = collectPanelLeafIds(tree)
  if (activePaneId !== null && leafIds.includes(activePaneId)) {
    return activePaneId
  }
  return leafIds[0]
}

/**
 * Collect all leaf IDs from a PanelTreeNode in DFS order.
 */
function collectPanelLeafIds(node: PanelTreeNode): string[] {
  if (node._tag === 'PanelLeafNode') {
    return [node.id]
  }
  const ids: string[] = []
  for (const child of node.children) {
    ids.push(...collectPanelLeafIds(child))
  }
  return ids
}

// ---------------------------------------------------------------------------
// Main migration function
// ---------------------------------------------------------------------------

/**
 * Migrate an old flat `PanelNode` layout tree to the new hierarchical
 * `WindowLayout` format.
 *
 * Steps:
 * 1. Extract unique workspace IDs from the old tree
 * 2. Sort workspaces according to `workspaceOrder` (if provided)
 * 3. For each workspace, filter and convert its sub-tree
 * 4. Promote sidebar toggle flags (diff, devServer) to independent panel tabs
 * 5. Arrange workspace tiles horizontally (or as a single leaf)
 * 6. Wrap in a single WindowTab inside a WindowLayout
 *
 * @param oldTree - The legacy flat PanelNode tree
 * @param activePaneId - The legacy active pane ID (may be null)
 * @param workspaceOrder - The legacy workspace ordering (may be null)
 * @returns The new WindowLayout with a single window tab
 */
function migrateToWindowLayout(
  oldTree: PanelNode,
  activePaneId: string | null,
  workspaceOrder: string[] | null
): WindowLayout {
  // Extract unique workspace IDs
  const rawWorkspaceIds = getWorkspaceIds(oldTree)

  // Sort by workspaceOrder if provided
  const sortedWorkspaceIds = sortWorkspaceIdsByOrder(
    rawWorkspaceIds,
    workspaceOrder
  )

  // Build workspace tile leaves (skip undefined/empty workspace IDs)
  const tileLeaves: WorkspaceTileLeaf[] = []
  for (const wsId of sortedWorkspaceIds) {
    if (!wsId) {
      continue
    }
    const subTree = filterTreeByWorkspace(oldTree, wsId)
    if (!subTree) {
      continue
    }
    const tile = buildWorkspaceTile(wsId, subTree, activePaneId)
    tileLeaves.push(tile)
  }

  // Build workspace tile tree
  let workspaceLayout: WorkspaceTileNode | undefined
  if (tileLeaves.length === 0) {
    workspaceLayout = undefined
  } else if (tileLeaves.length === 1) {
    workspaceLayout = tileLeaves[0]
  } else {
    const equalSize = 100 / tileLeaves.length
    const split: WorkspaceTileSplit = {
      _tag: 'WorkspaceTileSplit',
      id: generateMigrationId('workspace-split'),
      direction: 'horizontal',
      children: tileLeaves,
      sizes: tileLeaves.map(() => equalSize),
    }
    workspaceLayout = split
  }

  // Create the window tab
  const windowTabId = generateMigrationId('window-tab')
  const windowTab: WindowTab = {
    id: windowTabId,
    label: 'Main',
    workspaceLayout,
  }

  return {
    tabs: [windowTab],
    activeTabId: windowTabId,
  }
}

/**
 * Sort workspace IDs according to a workspace order array.
 * IDs in the order array come first (in that order), followed by any
 * remaining IDs not in the order array (preserving their original order).
 */
function sortWorkspaceIdsByOrder(
  workspaceIds: (string | undefined)[],
  workspaceOrder: string[] | null
): (string | undefined)[] {
  if (!workspaceOrder || workspaceOrder.length === 0) {
    return workspaceIds
  }

  const orderIndex = new Map(workspaceOrder.map((id, idx) => [id, idx]))
  const sorted = [...workspaceIds]
  sorted.sort((a, b) => {
    const aIdx =
      a !== undefined
        ? (orderIndex.get(a) ?? Number.MAX_SAFE_INTEGER)
        : Number.MAX_SAFE_INTEGER
    const bIdx =
      b !== undefined
        ? (orderIndex.get(b) ?? Number.MAX_SAFE_INTEGER)
        : Number.MAX_SAFE_INTEGER
    return aIdx - bIdx
  })
  return sorted
}

// ---------------------------------------------------------------------------
// Derive legacy flat tree from hierarchical layout
// ---------------------------------------------------------------------------

/**
 * Build a legacy `PanelNode` flat tree from a `WindowLayout`'s active
 * window tab. Extracts all workspace tile leaves from the active tab,
 * takes each workspace's active panel tab's layout, converts it to legacy
 * format, and combines them into a single flat tree.
 *
 * This is used to keep the legacy `layout` variable (consumed by hotkeys,
 * directional navigation, and other legacy code) in sync with the
 * hierarchical layout that drives rendering.
 *
 * @param windowLayout - The hierarchical window layout
 * @returns A legacy PanelNode tree, or undefined if no active tab/workspace exists
 */
function deriveLegacyTreeFromHierarchical(
  windowLayout: WindowLayout
): PanelNode | undefined {
  const activeTab = windowLayout.tabs.find(
    (t) => t.id === windowLayout.activeTabId
  )
  if (!activeTab?.workspaceLayout) {
    return undefined
  }

  // Collect all workspace tile leaves from the active window tab,
  // skipping any with empty/missing workspaceId (invalid data)
  const allLeaves = collectWorkspaceTileLeaves(activeTab.workspaceLayout)
  const leaves = allLeaves.filter((l) => l.workspaceId !== '')
  if (leaves.length === 0) {
    return undefined
  }

  // Convert each workspace's active panel tab layout to legacy format
  const legacySubTrees: PanelNode[] = []
  for (const leaf of leaves) {
    const activePanelTab = leaf.panelTabs.find(
      (t) => t.id === leaf.activePanelTabId
    )
    if (activePanelTab) {
      legacySubTrees.push(convertPanelTreeToLegacy(activePanelTab.panelLayout))
    }
  }

  if (legacySubTrees.length === 0) {
    return undefined
  }

  if (legacySubTrees.length === 1) {
    return legacySubTrees[0]
  }

  // Combine into a horizontal split (matching the legacy flat tree format)
  return {
    _tag: 'SplitNode' as const,
    id: `derived-split-${activeTab.id}`,
    direction: 'horizontal' as const,
    children: legacySubTrees,
    sizes: legacySubTrees.map(() => 100 / legacySubTrees.length),
  }
}

/**
 * Recursively collect all WorkspaceTileLeaf nodes from a workspace tile tree.
 */
function collectWorkspaceTileLeaves(
  node: WorkspaceTileNode
): WorkspaceTileLeaf[] {
  if (node._tag === 'WorkspaceTileLeaf') {
    return [node]
  }
  const result: WorkspaceTileLeaf[] = []
  for (const child of node.children) {
    result.push(...collectWorkspaceTileLeaves(child))
  }
  return result
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  collectSidebarFlags,
  convertLeafNode,
  convertPanelTree,
  convertPanelTreeToLegacy,
  deriveLegacyTreeFromHierarchical,
  migrateToWindowLayout,
}
