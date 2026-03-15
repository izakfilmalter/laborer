/**
 * Window tab layout manipulation utilities.
 *
 * Pure functions that operate on the `WindowLayout` type to support
 * window tab CRUD operations, workspace location lookups, and terminal
 * navigation across the hierarchical layout tree.
 *
 * All functions return a new layout — the original is never mutated.
 *
 * @see packages/shared/src/types.ts — WindowLayout, WindowTab, WorkspaceTileNode
 * @see apps/web/src/panels/layout-utils.ts — panel-level tree utilities
 */

import type {
  PanelTab,
  PanelTreeNode,
  WindowLayout,
  WindowTab,
  WorkspaceTileLeaf,
  WorkspaceTileNode,
} from '@laborer/shared/types'

import { generateId } from './id-utils'

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

/** Generate a unique ID for new window tab nodes. */
function generateWindowTabId(): string {
  return generateId('window-tab')
}

// ---------------------------------------------------------------------------
// Window tab CRUD
// ---------------------------------------------------------------------------

/**
 * Add a new window tab to the layout.
 * If a `tab` is provided, it is appended as-is. Otherwise an empty tab is
 * created. The new tab becomes the active tab.
 *
 * @param layout - The current window layout
 * @param tab - Optional pre-configured tab to add
 * @returns A new WindowLayout with the tab appended and active
 */
function addWindowTab(layout: WindowLayout, tab?: WindowTab): WindowLayout {
  const newTab: WindowTab = tab ?? {
    id: generateWindowTabId(),
  }
  return {
    tabs: [...layout.tabs, newTab],
    activeTabId: newTab.id,
  }
}

/**
 * Remove a window tab by ID.
 * If the removed tab was active, the nearest sibling becomes active:
 * - Prefer the tab to the right (next index)
 * - Fall back to the tab to the left (previous index)
 * - If no tabs remain, activeTabId becomes undefined
 *
 * @param layout - The current window layout
 * @param tabId - The ID of the tab to remove
 * @returns A new WindowLayout without the tab
 */
function removeWindowTab(layout: WindowLayout, tabId: string): WindowLayout {
  const index = layout.tabs.findIndex((t) => t.id === tabId)
  if (index === -1) {
    return layout
  }

  const newTabs = layout.tabs.filter((t) => t.id !== tabId)

  if (newTabs.length === 0) {
    return { tabs: [], activeTabId: undefined }
  }

  // If the removed tab was not active, keep the current active tab
  if (layout.activeTabId !== tabId) {
    return { tabs: newTabs, activeTabId: layout.activeTabId }
  }

  // Pick nearest sibling: prefer right, fall back to left
  const nextIndex = Math.min(index, newTabs.length - 1)
  return {
    tabs: newTabs,
    activeTabId: newTabs[nextIndex]?.id,
  }
}

/**
 * Switch the active window tab by ID.
 * If the tabId doesn't exist in the layout, returns the layout unchanged.
 *
 * @param layout - The current window layout
 * @param tabId - The ID of the tab to activate
 * @returns A new WindowLayout with the active tab updated
 */
function switchWindowTab(layout: WindowLayout, tabId: string): WindowLayout {
  const exists = layout.tabs.some((t) => t.id === tabId)
  if (!exists) {
    return layout
  }
  return { ...layout, activeTabId: tabId }
}

/**
 * Switch the active window tab by 1-based index.
 * Indices 1-8 map to tabs at positions 0-7.
 * Index 9 always maps to the last tab.
 * Out-of-range indices return the layout unchanged.
 *
 * @param layout - The current window layout
 * @param index - 1-based tab index (1-8, or 9 for last)
 * @returns A new WindowLayout with the active tab updated
 */
function switchWindowTabByIndex(
  layout: WindowLayout,
  index: number
): WindowLayout {
  if (layout.tabs.length === 0) {
    return layout
  }

  // Index 9 = last tab
  if (index === 9) {
    const lastTab = layout.tabs.at(-1)
    return { ...layout, activeTabId: lastTab?.id }
  }

  // Convert 1-based to 0-based
  const zeroIndex = index - 1
  if (zeroIndex < 0 || zeroIndex >= layout.tabs.length) {
    return layout
  }

  return { ...layout, activeTabId: layout.tabs[zeroIndex]?.id }
}

/**
 * Cycle the active window tab by a relative delta.
 * A delta of +1 moves to the next tab, -1 to the previous tab.
 * Wraps around: moving past the last tab goes to the first, and vice versa.
 *
 * @param layout - The current window layout
 * @param delta - Number of positions to move (+1 = next, -1 = previous)
 * @returns A new WindowLayout with the active tab updated
 */
function switchWindowTabRelative(
  layout: WindowLayout,
  delta: number
): WindowLayout {
  if (layout.tabs.length === 0) {
    return layout
  }

  const currentIndex = layout.tabs.findIndex((t) => t.id === layout.activeTabId)

  // If active tab not found, default to first tab
  if (currentIndex === -1) {
    return { ...layout, activeTabId: layout.tabs[0]?.id }
  }

  const newIndex =
    (((currentIndex + delta) % layout.tabs.length) + layout.tabs.length) %
    layout.tabs.length
  return { ...layout, activeTabId: layout.tabs[newIndex]?.id }
}

/**
 * Reorder window tabs by moving a tab from one index to another.
 * Both indices are 0-based. If either index is out of range, returns
 * the layout unchanged.
 *
 * @param layout - The current window layout
 * @param fromIndex - The 0-based index of the tab to move
 * @param toIndex - The 0-based target index
 * @returns A new WindowLayout with tabs reordered
 */
function reorderWindowTabs(
  layout: WindowLayout,
  fromIndex: number,
  toIndex: number
): WindowLayout {
  if (
    fromIndex < 0 ||
    fromIndex >= layout.tabs.length ||
    toIndex < 0 ||
    toIndex >= layout.tabs.length ||
    fromIndex === toIndex
  ) {
    return layout
  }

  const newTabs = [...layout.tabs]
  const [moved] = newTabs.splice(fromIndex, 1)
  if (moved) {
    newTabs.splice(toIndex, 0, moved)
  }
  return { ...layout, tabs: newTabs }
}

// ---------------------------------------------------------------------------
// Workspace location lookups
// ---------------------------------------------------------------------------

/**
 * Result of a workspace location lookup.
 */
interface WorkspaceLocation {
  /** The ID of the window tab containing the workspace */
  readonly tabId: string
  /** The ID of the workspace tile leaf */
  readonly tileId: string
}

/**
 * Result of a terminal location lookup.
 */
interface TerminalLocation {
  /** The ID of the pane (leaf node) containing the terminal */
  readonly paneId: string
  /** The ID of the panel tab containing the terminal */
  readonly panelTabId: string
  /** The ID of the window tab containing the terminal */
  readonly tabId: string
  /** The ID of the workspace tile leaf */
  readonly tileId: string
  /** The workspace ID */
  readonly workspaceId: string
}

/**
 * Find which window tab contains a specific workspace.
 * Searches all tabs' workspace tile trees for a tile leaf with the
 * given workspace ID.
 *
 * @param layout - The window layout to search
 * @param workspaceId - The workspace ID to find
 * @returns The location of the workspace, or undefined if not found
 */
function findWorkspaceLocation(
  layout: WindowLayout,
  workspaceId: string
): WorkspaceLocation | undefined {
  for (const tab of layout.tabs) {
    if (tab.workspaceLayout) {
      const tileId = findWorkspaceInTileTree(tab.workspaceLayout, workspaceId)
      if (tileId) {
        return { tabId: tab.id, tileId }
      }
    }
  }
  return undefined
}

/**
 * Recursively search a workspace tile tree for a workspace ID.
 * Returns the tile leaf ID if found.
 */
function findWorkspaceInTileTree(
  node: WorkspaceTileNode,
  workspaceId: string
): string | undefined {
  if (node._tag === 'WorkspaceTileLeaf') {
    return node.workspaceId === workspaceId ? node.id : undefined
  }
  for (const child of node.children) {
    const found = findWorkspaceInTileTree(child, workspaceId)
    if (found) {
      return found
    }
  }
  return undefined
}

/**
 * Find the exact location of a terminal across all tabs, workspaces,
 * panel tabs, and panes.
 *
 * Searches: all tabs > all workspace tile leaves > all panel tabs > all
 * pane leaves in their split trees.
 *
 * @param layout - The window layout to search
 * @param terminalId - The terminal ID to find
 * @returns The full location path, or undefined if not found
 */
function findTerminalLocation(
  layout: WindowLayout,
  terminalId: string
): TerminalLocation | undefined {
  for (const tab of layout.tabs) {
    if (tab.workspaceLayout) {
      const result = findTerminalInTileTree(
        tab.id,
        tab.workspaceLayout,
        terminalId
      )
      if (result) {
        return result
      }
    }
  }
  return undefined
}

/**
 * Recursively search a workspace tile tree for a terminal ID.
 */
function findTerminalInTileTree(
  tabId: string,
  node: WorkspaceTileNode,
  terminalId: string
): TerminalLocation | undefined {
  if (node._tag === 'WorkspaceTileLeaf') {
    return findTerminalInWorkspaceTile(tabId, node, terminalId)
  }
  for (const child of node.children) {
    const result = findTerminalInTileTree(tabId, child, terminalId)
    if (result) {
      return result
    }
  }
  return undefined
}

/**
 * Search a workspace tile leaf's panel tabs for a terminal ID.
 */
function findTerminalInWorkspaceTile(
  tabId: string,
  tile: WorkspaceTileLeaf,
  terminalId: string
): TerminalLocation | undefined {
  for (const panelTab of tile.panelTabs) {
    const paneId = findTerminalInPanelTree(panelTab.panelLayout, terminalId)
    if (paneId) {
      return {
        tabId,
        tileId: tile.id,
        workspaceId: tile.workspaceId,
        panelTabId: panelTab.id,
        paneId,
      }
    }
  }
  return undefined
}

/**
 * Recursively search a panel tree for a terminal ID.
 * Returns the pane (leaf) ID if found.
 */
function findTerminalInPanelTree(
  node: PanelTreeNode,
  terminalId: string
): string | undefined {
  if (node._tag === 'PanelLeafNode') {
    return node.terminalId === terminalId ? node.id : undefined
  }
  for (const child of node.children) {
    const found = findTerminalInPanelTree(child, terminalId)
    if (found) {
      return found
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Utility: collect all workspace tile leaves from a tile tree
// ---------------------------------------------------------------------------

/**
 * Collect all workspace tile leaves from a workspace tile tree.
 * Useful for listing all workspaces in a window tab.
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
 * Collect all workspace tile leaves across all tabs.
 */
function getAllWorkspaceTileLeaves(
  layout: WindowLayout
): readonly WorkspaceTileLeaf[] {
  return layout.tabs.flatMap((tab) =>
    tab.workspaceLayout ? getWorkspaceTileLeaves(tab.workspaceLayout) : []
  )
}

/**
 * Get the active window tab from a layout.
 * Returns undefined if the layout has no tabs or the activeTabId is invalid.
 */
function getActiveWindowTab(layout: WindowLayout): WindowTab | undefined {
  return layout.tabs.find((t) => t.id === layout.activeTabId)
}

// ---------------------------------------------------------------------------
// Focus resolution — derive activePaneId from the hierarchical structure
// ---------------------------------------------------------------------------

/**
 * Get the first leaf pane ID from a PanelTreeNode tree (DFS order).
 * Used as a fallback when `focusedPaneId` is not set on a panel tab.
 */
function getFirstPanelTreeLeafId(node: PanelTreeNode): string | undefined {
  if (node._tag === 'PanelLeafNode') {
    return node.id
  }
  for (const child of node.children) {
    const leafId = getFirstPanelTreeLeafId(child)
    if (leafId) {
      return leafId
    }
  }
  return undefined
}

/**
 * Resolve the pane that should receive focus for a given panel tab.
 * Prefers `focusedPaneId` if set, falls back to the first leaf pane.
 */
function resolveActivePaneForPanelTab(tab: PanelTab): string | undefined {
  if (tab.focusedPaneId) {
    return tab.focusedPaneId
  }
  return getFirstPanelTreeLeafId(tab.panelLayout)
}

/**
 * Resolve the pane that should receive focus when switching to a window tab.
 *
 * Walks the hierarchy: active workspace tile > active panel tab > focusedPaneId.
 * Falls back at each level if the preferred value is not available.
 *
 * @param tab - The window tab to resolve focus for
 * @returns The pane ID that should receive focus, or undefined
 */
function resolveActivePaneForWindowTab(tab: WindowTab): string | undefined {
  if (!tab.workspaceLayout) {
    return undefined
  }
  // Get the first workspace tile leaf as a fallback
  const leaves = getWorkspaceTileLeaves(tab.workspaceLayout)
  if (leaves.length === 0) {
    return undefined
  }
  // Prefer the first workspace that has panel tabs
  for (const leaf of leaves) {
    const activeTab = leaf.panelTabs.find((t) => t.id === leaf.activePanelTabId)
    if (activeTab) {
      const paneId = resolveActivePaneForPanelTab(activeTab)
      if (paneId) {
        return paneId
      }
    }
    // Fallback: first panel tab of this workspace
    const firstTab = leaf.panelTabs[0]
    if (firstTab) {
      const paneId = resolveActivePaneForPanelTab(firstTab)
      if (paneId) {
        return paneId
      }
    }
  }
  return undefined
}

/**
 * Save the current focusedPaneId on the active panel tab of the workspace
 * that contains the given pane. Walks all tabs > all workspaces > all panel
 * tabs to find the pane and update its panel tab's focusedPaneId.
 *
 * @param layout - The window layout
 * @param paneId - The pane that is now focused
 * @returns A new WindowLayout with focusedPaneId updated on the matching panel tab
 */
function saveFocusedPaneId(layout: WindowLayout, paneId: string): WindowLayout {
  const newTabs = layout.tabs.map((tab) => {
    if (!tab.workspaceLayout) {
      return tab
    }
    const newWorkspaceLayout = saveFocusInTileTree(tab.workspaceLayout, paneId)
    if (newWorkspaceLayout === tab.workspaceLayout) {
      return tab
    }
    return { ...tab, workspaceLayout: newWorkspaceLayout }
  })
  if (newTabs.every((tab, i) => tab === layout.tabs[i])) {
    return layout
  }
  return { ...layout, tabs: newTabs }
}

/**
 * Recursively search a workspace tile tree and save focusedPaneId
 * on the panel tab containing the given pane.
 */
function saveFocusInTileTree(
  node: WorkspaceTileNode,
  paneId: string
): WorkspaceTileNode {
  if (node._tag === 'WorkspaceTileLeaf') {
    return saveFocusInWorkspaceTile(node, paneId)
  }
  const newChildren = node.children.map((child) =>
    saveFocusInTileTree(child, paneId)
  )
  if (newChildren.every((child, i) => child === node.children[i])) {
    return node
  }
  return { ...node, children: newChildren }
}

/**
 * Save focusedPaneId on the panel tab in a workspace tile leaf that
 * contains the given pane.
 */
function saveFocusInWorkspaceTile(
  tile: WorkspaceTileLeaf,
  paneId: string
): WorkspaceTileLeaf {
  const newPanelTabs = tile.panelTabs.map((tab) => {
    if (panelTreeContainsPane(tab.panelLayout, paneId)) {
      if (tab.focusedPaneId === paneId) {
        return tab
      }
      return { ...tab, focusedPaneId: paneId }
    }
    return tab
  })
  if (newPanelTabs.every((tab, i) => tab === tile.panelTabs[i])) {
    return tile
  }
  return { ...tile, panelTabs: newPanelTabs }
}

/**
 * Check if a PanelTreeNode tree contains a pane with the given ID.
 */
function panelTreeContainsPane(node: PanelTreeNode, paneId: string): boolean {
  if (node._tag === 'PanelLeafNode') {
    return node.id === paneId
  }
  return node.children.some((child) => panelTreeContainsPane(child, paneId))
}

// ---------------------------------------------------------------------------
// Workspace tile leaf update
// ---------------------------------------------------------------------------

/**
 * Apply a transform to the workspace tile node that matches a given
 * workspace ID within a tile tree. Returns a new tree with the leaf
 * replaced by the transform's return value.
 *
 * @param node - The workspace tile tree to search
 * @param workspaceId - The workspace ID to find
 * @param transform - Function that receives the leaf and returns the updated leaf
 * @returns A new tile tree with the leaf updated, or the original tree if not found
 */
function updateTileLeaf(
  node: WorkspaceTileNode,
  workspaceId: string,
  transform: (leaf: WorkspaceTileLeaf) => WorkspaceTileLeaf
): WorkspaceTileNode {
  if (node._tag === 'WorkspaceTileLeaf') {
    return node.workspaceId === workspaceId ? transform(node) : node
  }
  const newChildren = node.children.map((child) =>
    updateTileLeaf(child, workspaceId, transform)
  )
  // Only create a new split if something changed
  if (newChildren.every((child, i) => child === node.children[i])) {
    return node
  }
  return { ...node, children: newChildren }
}

/**
 * Apply a transform to a workspace tile leaf within a WindowLayout.
 * Searches all tabs for the workspace and applies the transform to the
 * matching leaf. Returns a new WindowLayout with the update applied.
 *
 * @param layout - The window layout to search
 * @param workspaceId - The workspace ID to find
 * @param transform - Function that receives the leaf and returns the updated leaf
 * @returns A new WindowLayout with the workspace updated
 */
function updateWorkspaceTileLeaf(
  layout: WindowLayout,
  workspaceId: string,
  transform: (leaf: WorkspaceTileLeaf) => WorkspaceTileLeaf
): WindowLayout {
  const newTabs = layout.tabs.map((tab) => {
    if (!tab.workspaceLayout) {
      return tab
    }
    const newLayout = updateTileLeaf(
      tab.workspaceLayout,
      workspaceId,
      transform
    )
    if (newLayout === tab.workspaceLayout) {
      return tab
    }
    return { ...tab, workspaceLayout: newLayout }
  })
  // Only create new layout if something changed
  if (newTabs.every((tab, i) => tab === layout.tabs[i])) {
    return layout
  }
  return { ...layout, tabs: newTabs }
}

// ---------------------------------------------------------------------------
// Workspace uniqueness enforcement
// ---------------------------------------------------------------------------

/**
 * Remove a workspace from whatever tab it currently lives in across the
 * entire layout.  Uses `findWorkspaceLocation` to locate the workspace
 * and then `removeWorkspaceFromTab` (from `workspace-tile-utils.ts`) to
 * strip it from the owning tab.
 *
 * If the workspace is not found anywhere in the layout, returns the
 * layout unchanged (referential equality).
 *
 * @param layout - The current window layout
 * @param workspaceId - The workspace ID to remove
 * @param removeFromTab - A function that removes a workspace from a tab (injected to avoid circular imports)
 * @returns A new WindowLayout with the workspace removed from its previous location
 */
function removeWorkspaceFromLayout(
  layout: WindowLayout,
  workspaceId: string,
  removeFromTab: (tab: WindowTab, workspaceId: string) => WindowTab
): WindowLayout {
  const location = findWorkspaceLocation(layout, workspaceId)
  if (!location) {
    return layout
  }

  const newTabs = layout.tabs.map((tab) =>
    tab.id === location.tabId ? removeFromTab(tab, workspaceId) : tab
  )

  // Only create a new layout if something changed
  if (newTabs.every((tab, i) => tab === layout.tabs[i])) {
    return layout
  }

  return { ...layout, tabs: newTabs }
}

/**
 * Move a workspace from its current location (any tab in the layout) to
 * a specific target tab.  This is the core of workspace uniqueness
 * enforcement: if the workspace already lives in a tab, it is removed
 * from the old tab before being added to the new one.
 *
 * If the workspace is already in the target tab, the layout is returned
 * unchanged (no-op).
 *
 * @param layout - The current window layout
 * @param workspaceId - The workspace ID to move
 * @param targetTabId - The ID of the tab to move the workspace into
 * @param removeFromTab - Injected `removeWorkspaceFromTab` to avoid circular imports
 * @param addToTab - Injected `addWorkspaceToTab` to avoid circular imports
 * @returns A new WindowLayout with the workspace in the target tab only
 */
function moveWorkspace(
  layout: WindowLayout,
  workspaceId: string,
  targetTabId: string,
  removeFromTab: (tab: WindowTab, workspaceId: string) => WindowTab,
  addToTab: (tab: WindowTab, workspaceId: string) => WindowTab
): WindowLayout {
  const existing = findWorkspaceLocation(layout, workspaceId)

  // Already in the target tab — nothing to do
  if (existing?.tabId === targetTabId) {
    return layout
  }

  // Step 1: Remove from old location (if any)
  let intermediate = layout
  if (existing) {
    intermediate = removeWorkspaceFromLayout(layout, workspaceId, removeFromTab)
  }

  // Step 2: Add to target tab
  const newTabs = intermediate.tabs.map((tab) =>
    tab.id === targetTabId ? addToTab(tab, workspaceId) : tab
  )

  if (newTabs.every((tab, i) => tab === intermediate.tabs[i])) {
    return intermediate
  }

  return { ...intermediate, tabs: newTabs }
}

/**
 * Enforce workspace uniqueness within a layout by adding a workspace to
 * a target tab after removing it from any other tab.
 *
 * This is the primary entry point for the within-window uniqueness
 * enforcement path.
 *
 * @param layout - The current window layout
 * @param workspaceId - The workspace ID to add
 * @param targetTabId - The ID of the tab to add the workspace to
 * @param removeFromTab - Injected `removeWorkspaceFromTab`
 * @param addToTab - Injected `addWorkspaceToTab`
 * @returns A new WindowLayout with the workspace only in the target tab
 */
function addWorkspaceToTabUnique(
  layout: WindowLayout,
  workspaceId: string,
  targetTabId: string,
  removeFromTab: (tab: WindowTab, workspaceId: string) => WindowTab,
  addToTab: (tab: WindowTab, workspaceId: string) => WindowTab
): WindowLayout {
  return moveWorkspace(
    layout,
    workspaceId,
    targetTabId,
    removeFromTab,
    addToTab
  )
}

// ---------------------------------------------------------------------------
// Close confirmation for hierarchical levels
// ---------------------------------------------------------------------------

/**
 * Minimal terminal info needed for close confirmation checks.
 */
interface TerminalProcessInfo {
  readonly hasChildProcess: boolean
  readonly id: string
}

/**
 * Collect all terminal IDs from a PanelTreeNode.
 */
function collectTerminalIdsFromPanelTree(
  node: PanelTreeNode
): readonly string[] {
  if (node._tag === 'PanelLeafNode') {
    return node.terminalId !== undefined ? [node.terminalId] : []
  }
  return node.children.flatMap(collectTerminalIdsFromPanelTree)
}

/**
 * Check whether any terminal in the given IDs has a running child process.
 */
function hasRunningProcess(
  terminalIds: readonly string[],
  terminals: readonly TerminalProcessInfo[]
): boolean {
  return terminalIds.some((id) => {
    const terminal = terminals.find((t) => t.id === id)
    return terminal?.hasChildProcess === true
  })
}

/**
 * Determine whether closing a panel tab should show a confirmation dialog.
 *
 * Returns true when the panel tab contains any terminal with a running
 * child process. This prevents accidental loss of running work when
 * the progressive close chain removes a panel tab.
 *
 * @param panelTab - The panel tab to check
 * @param terminals - The live terminal list with hasChildProcess info
 * @returns Whether the close confirmation dialog should be shown
 */
function shouldConfirmClosePanelTab(
  panelTab: PanelTab,
  terminals: readonly TerminalProcessInfo[]
): boolean {
  const terminalIds = collectTerminalIdsFromPanelTree(panelTab.panelLayout)
  return hasRunningProcess(terminalIds, terminals)
}

/**
 * Collect all terminal IDs from a WorkspaceTileNode tree.
 * Walks workspace tiles > panel tabs > panel tree nodes.
 */
function collectTerminalIdsFromTileTree(
  node: WorkspaceTileNode
): readonly string[] {
  if (node._tag === 'WorkspaceTileLeaf') {
    return node.panelTabs.flatMap((tab) =>
      collectTerminalIdsFromPanelTree(tab.panelLayout)
    )
  }
  return node.children.flatMap(collectTerminalIdsFromTileTree)
}

/**
 * Determine whether closing a window tab should show a confirmation dialog.
 *
 * Returns true when the window tab contains any terminal (across all
 * workspaces and panel tabs) with a running child process.
 *
 * @param windowTab - The window tab to check
 * @param terminals - The live terminal list with hasChildProcess info
 * @returns Whether the close confirmation dialog should be shown
 */
function shouldConfirmCloseWindowTab(
  windowTab: WindowTab,
  terminals: readonly TerminalProcessInfo[]
): boolean {
  if (!windowTab.workspaceLayout) {
    return false
  }
  const terminalIds = collectTerminalIdsFromTileTree(windowTab.workspaceLayout)
  return hasRunningProcess(terminalIds, terminals)
}

// ---------------------------------------------------------------------------
// Progressive close logic
// ---------------------------------------------------------------------------

/**
 * Result of `computeProgressiveCloseAction` — a discriminated union
 * describing the correct close action for the current state.
 */
type ProgressiveCloseAction =
  | {
      /** Close a pane within a panel tab's split tree (existing behavior). */
      readonly kind: 'close-pane'
      readonly paneId: string
    }
  | {
      /** Remove the active panel tab from a workspace (last pane in tab). */
      readonly kind: 'close-panel-tab'
      readonly tabId: string
      readonly workspaceId: string
    }
  | {
      /** Remove a workspace from the active window tab (last panel tab in workspace). */
      readonly kind: 'close-workspace'
      readonly workspaceId: string
    }
  | {
      /** Close the active window tab (no workspaces left). */
      readonly kind: 'close-window-tab'
      readonly tabId: string
    }
  | {
      /** No tabs left — show the close-app dialog or do nothing. */
      readonly kind: 'close-app'
    }

/**
 * Count the number of leaf panes in a PanelTreeNode tree.
 */
function countPanelLeaves(node: PanelTreeNode): number {
  if (node._tag === 'PanelLeafNode') {
    return 1
  }
  let count = 0
  for (const child of node.children) {
    count += countPanelLeaves(child)
  }
  return count
}

/**
 * Determine whether closing the last item at this level should escalate
 * to closing the window tab or the app.
 */
function resolveLastWorkspaceCloseAction(
  layout: WindowLayout,
  activeTab: WindowTab
): ProgressiveCloseAction {
  return layout.tabs.length <= 1
    ? { kind: 'close-app' }
    : { kind: 'close-window-tab', tabId: activeTab.id }
}

/**
 * Determine the close action when the workspace has no active panel tab
 * (empty workspace state).
 */
function resolveEmptyWorkspaceAction(
  layout: WindowLayout,
  activeTab: WindowTab,
  activeWorkspaceId: string
): ProgressiveCloseAction {
  if (!activeTab.workspaceLayout) {
    return resolveLastWorkspaceCloseAction(layout, activeTab)
  }
  const allLeaves = getWorkspaceTileLeaves(activeTab.workspaceLayout)
  if (allLeaves.length <= 1) {
    return resolveLastWorkspaceCloseAction(layout, activeTab)
  }
  return { kind: 'close-workspace', workspaceId: activeWorkspaceId }
}

/**
 * Determine the close action when the active panel tab has exactly one
 * pane — escalate from panel tab to workspace to window tab.
 */
function resolveLastPaneCloseAction(
  layout: WindowLayout,
  activeTab: WindowTab,
  workspaceLeaf: WorkspaceTileLeaf,
  activePanelTabId: string,
  activeWorkspaceId: string
): ProgressiveCloseAction {
  // More than one panel tab → close just this tab
  if (workspaceLeaf.panelTabs.length > 1) {
    return {
      kind: 'close-panel-tab',
      tabId: activePanelTabId,
      workspaceId: activeWorkspaceId,
    }
  }
  // Last panel tab → escalate to workspace level
  return resolveEmptyWorkspaceAction(layout, activeTab, activeWorkspaceId)
}

/**
 * Resolve the close action when no pane is focused (activePaneId is null).
 * Tries to find a pane via the layout hierarchy before falling back to close-app.
 */
function resolveNullPaneCloseAction(
  layout: WindowLayout | undefined
): ProgressiveCloseAction {
  if (layout) {
    const activeTab = getActiveWindowTab(layout)
    if (activeTab) {
      const resolvedPaneId = resolveActivePaneForWindowTab(activeTab)
      if (resolvedPaneId) {
        return { kind: 'close-pane', paneId: resolvedPaneId }
      }
      // Active tab exists but has no panes — close the tab
      if (layout.tabs.length > 1) {
        return { kind: 'close-window-tab', tabId: activeTab.id }
      }
    }
  }
  return { kind: 'close-app' }
}

/**
 * Determine the correct close action for the progressive `Cmd+W` chain.
 *
 * The chain escalates from innermost to outermost:
 * 1. If the active panel tab has multiple panes → close the active pane
 * 2. If the active panel tab has exactly 1 pane → close the panel tab
 * 3. If that was the last panel tab → remove the workspace from the window tab
 * 4. If that was the last workspace → close the window tab
 * 5. If that was the last window tab → close the app
 *
 * Falls back to `close-pane` with `activePaneId` if the hierarchical layout
 * is not available (legacy mode).
 *
 * @param layout - The hierarchical window layout (may be undefined for legacy mode)
 * @param activePaneId - The currently focused pane ID
 * @param activeWorkspaceId - The workspace ID of the active pane (used for tab/workspace lookup)
 * @returns A discriminated union describing the action to take
 */
function computeProgressiveCloseAction(
  layout: WindowLayout | undefined,
  activePaneId: string | null,
  activeWorkspaceId: string | undefined
): ProgressiveCloseAction {
  // No active pane — attempt to resolve one from the layout before
  // falling back to close-app. This handles the case where the user
  // clicks outside any pane (deselecting focus) then presses Cmd+W.
  if (!activePaneId) {
    return resolveNullPaneCloseAction(layout)
  }

  // No hierarchical layout available → fall back to simple pane close
  if (!layout) {
    return { kind: 'close-pane', paneId: activePaneId }
  }

  // Find the active window tab
  const activeTab = getActiveWindowTab(layout)
  if (!activeTab) {
    return { kind: 'close-app' }
  }

  // If no workspace context, just close the pane
  if (!activeWorkspaceId) {
    return { kind: 'close-pane', paneId: activePaneId }
  }

  // Find the workspace tile leaf
  const workspaceLeaf = activeTab.workspaceLayout
    ? findWorkspaceTileLeaf(activeTab.workspaceLayout, activeWorkspaceId)
    : undefined

  if (!workspaceLeaf) {
    return { kind: 'close-pane', paneId: activePaneId }
  }

  // Find the active panel tab
  const activePanelTab = workspaceLeaf.panelTabs.find(
    (t) => t.id === workspaceLeaf.activePanelTabId
  )

  if (!activePanelTab) {
    return resolveEmptyWorkspaceAction(layout, activeTab, activeWorkspaceId)
  }

  // Multiple panes → close the active pane
  const paneCount = countPanelLeaves(activePanelTab.panelLayout)
  if (paneCount > 1) {
    return { kind: 'close-pane', paneId: activePaneId }
  }

  // Single pane → escalate
  return resolveLastPaneCloseAction(
    layout,
    activeTab,
    workspaceLeaf,
    activePanelTab.id,
    activeWorkspaceId
  )
}

/**
 * Find a workspace tile leaf by workspace ID in a tile tree.
 */
function findWorkspaceTileLeaf(
  node: WorkspaceTileNode,
  workspaceId: string
): WorkspaceTileLeaf | undefined {
  if (node._tag === 'WorkspaceTileLeaf') {
    return node.workspaceId === workspaceId ? node : undefined
  }
  for (const child of node.children) {
    const found = findWorkspaceTileLeaf(child, workspaceId)
    if (found) {
      return found
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Hierarchical reconciliation: stale terminal detection + ID replacement
// ---------------------------------------------------------------------------

/**
 * Stale terminal leaf info within the hierarchical layout.
 * Contains the terminal leaf details plus its location in the hierarchy.
 */
interface StaleTerminalLeaf {
  readonly paneId: string
  readonly terminalId: string
  readonly workspaceId: string | undefined
}

/**
 * Collect all terminal leaves from a PanelTreeNode whose terminalId is
 * not in the live terminal set. These are candidates for respawning.
 */
function getStaleTerminalLeavesFromPanelTree(
  node: PanelTreeNode,
  liveTerminalIds: ReadonlySet<string>
): readonly StaleTerminalLeaf[] {
  if (node._tag === 'PanelLeafNode') {
    if (
      node.terminalId !== undefined &&
      !liveTerminalIds.has(node.terminalId)
    ) {
      return [
        {
          paneId: node.id,
          terminalId: node.terminalId,
          workspaceId: node.workspaceId,
        },
      ]
    }
    return []
  }
  return node.children.flatMap((child) =>
    getStaleTerminalLeavesFromPanelTree(child, liveTerminalIds)
  )
}

/**
 * Collect all stale terminal leaves from a WorkspaceTileNode tree.
 * Walks workspace tiles > panel tabs > panel tree nodes.
 */
function getStaleTerminalLeavesFromTileTree(
  node: WorkspaceTileNode,
  liveTerminalIds: ReadonlySet<string>
): readonly StaleTerminalLeaf[] {
  if (node._tag === 'WorkspaceTileLeaf') {
    return node.panelTabs.flatMap((tab) =>
      getStaleTerminalLeavesFromPanelTree(tab.panelLayout, liveTerminalIds)
    )
  }
  return node.children.flatMap((child) =>
    getStaleTerminalLeavesFromTileTree(child, liveTerminalIds)
  )
}

/**
 * Collect all stale terminal leaves from a WindowLayout.
 * Searches all window tabs > workspace tiles > panel tabs > panel splits.
 *
 * @param layout - The hierarchical window layout
 * @param liveTerminalIds - Set of terminal IDs that are currently live
 * @returns Array of stale terminal leaf info
 */
function getStaleTerminalLeavesHierarchical(
  layout: WindowLayout,
  liveTerminalIds: ReadonlySet<string>
): readonly StaleTerminalLeaf[] {
  return layout.tabs.flatMap((tab) =>
    tab.workspaceLayout
      ? getStaleTerminalLeavesFromTileTree(tab.workspaceLayout, liveTerminalIds)
      : []
  )
}

/**
 * Reconcile a PanelTreeNode by replacing stale terminal IDs with
 * respawned ones. If a stale leaf has no mapping entry, terminalId
 * becomes undefined. Preserves referential equality when no changes.
 */
function reconcilePanelTree(
  node: PanelTreeNode,
  liveTerminalIds: ReadonlySet<string>,
  respawnedIds: ReadonlyMap<string, string>
): PanelTreeNode {
  if (node._tag === 'PanelLeafNode') {
    if (
      node.terminalId !== undefined &&
      !liveTerminalIds.has(node.terminalId)
    ) {
      const newId = respawnedIds.get(node.terminalId)
      return { ...node, terminalId: newId }
    }
    return node
  }

  let changed = false
  const newChildren = node.children.map((child) => {
    const reconciled = reconcilePanelTree(child, liveTerminalIds, respawnedIds)
    if (reconciled !== child) {
      changed = true
    }
    return reconciled
  })

  return changed ? { ...node, children: newChildren } : node
}

/**
 * Reconcile a WorkspaceTileNode by walking its panel tabs and
 * replacing stale terminal IDs.
 */
function reconcileTileTree(
  node: WorkspaceTileNode,
  liveTerminalIds: ReadonlySet<string>,
  respawnedIds: ReadonlyMap<string, string>
): WorkspaceTileNode {
  if (node._tag === 'WorkspaceTileLeaf') {
    let changed = false
    const newPanelTabs = node.panelTabs.map((tab) => {
      const newLayout = reconcilePanelTree(
        tab.panelLayout,
        liveTerminalIds,
        respawnedIds
      )
      if (newLayout !== tab.panelLayout) {
        changed = true
        return { ...tab, panelLayout: newLayout }
      }
      return tab
    })
    return changed ? { ...node, panelTabs: newPanelTabs } : node
  }

  let changed = false
  const newChildren = node.children.map((child) => {
    const reconciled = reconcileTileTree(child, liveTerminalIds, respawnedIds)
    if (reconciled !== child) {
      changed = true
    }
    return reconciled
  })

  return changed ? { ...node, children: newChildren } : node
}

/**
 * Reconcile a WindowLayout by replacing stale terminal IDs with
 * respawned ones across all window tabs, workspace tiles, and panel tabs.
 *
 * Preserves referential equality when no changes are made (returns
 * the same object reference).
 *
 * @param layout - The hierarchical window layout
 * @param liveTerminalIds - Set of terminal IDs that are currently live
 * @param respawnedIds - Map of old stale terminal ID → new respawned terminal ID
 * @returns The reconciled layout (same reference if unchanged)
 */
function reconcileWindowLayout(
  layout: WindowLayout,
  liveTerminalIds: ReadonlySet<string>,
  respawnedIds: ReadonlyMap<string, string>
): WindowLayout {
  let changed = false
  const newTabs = layout.tabs.map((tab) => {
    if (!tab.workspaceLayout) {
      return tab
    }
    const newLayout = reconcileTileTree(
      tab.workspaceLayout,
      liveTerminalIds,
      respawnedIds
    )
    if (newLayout !== tab.workspaceLayout) {
      changed = true
      return { ...tab, workspaceLayout: newLayout }
    }
    return tab
  })

  return changed ? { ...layout, tabs: newTabs } : layout
}

// ---------------------------------------------------------------------------
// Hierarchical layout repair
// ---------------------------------------------------------------------------

/** Valid pane types for repair validation. */
const VALID_PANE_TYPES = new Set([
  'terminal',
  'diff',
  'devServerTerminal',
  'review',
])

/** Valid split directions for repair validation. */
const VALID_DIRECTIONS = new Set(['horizontal', 'vertical'])

/** Type guard for record-like objects. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate and rebuild split sizes.
 * Returns even distribution if the original sizes are invalid.
 */
function repairSplitSizes(
  rawSizes: unknown,
  validCount: number,
  originalCount: number
): { sizes: readonly number[]; repaired: boolean } {
  const sizes = Array.isArray(rawSizes) ? (rawSizes as number[]) : []
  if (
    sizes.length === validCount &&
    sizes.every((s) => typeof s === 'number' && s > 0)
  ) {
    return {
      sizes,
      repaired: validCount !== originalCount,
    }
  }
  const equalSize = 100 / validCount
  return {
    sizes: Array.from({ length: validCount }, () => equalSize),
    repaired: true,
  }
}

/**
 * Result of repairing a WindowLayout.
 */
interface RepairWindowLayoutResult {
  readonly wasRepaired: boolean
  readonly windowLayout: WindowLayout | undefined
}

/**
 * Repair a PanelTreeNode (PanelLeafNode or PanelSplitNode).
 * Validates structure and drops invalid nodes.
 * Returns undefined if the node is completely invalid.
 */
function repairPanelTreeNode(
  node: unknown
): { tree: PanelTreeNode; repaired: boolean } | undefined {
  if (!isRecord(node) || typeof node._tag !== 'string') {
    return undefined
  }

  if (node._tag === 'PanelLeafNode') {
    return repairPanelLeafNode(node)
  }

  if (node._tag === 'PanelSplitNode') {
    return repairPanelSplitNode(node)
  }

  return undefined
}

/**
 * Repair a PanelLeafNode.
 * Validates id and paneType, strips invalid optional fields.
 */
function repairPanelLeafNode(
  node: Record<string, unknown>
): { tree: PanelTreeNode; repaired: boolean } | undefined {
  if (typeof node.id !== 'string' || node.id === '') {
    return undefined
  }

  if (
    typeof node.paneType !== 'string' ||
    !VALID_PANE_TYPES.has(node.paneType)
  ) {
    return undefined
  }

  let repaired = false
  const result: Record<string, unknown> = {
    _tag: 'PanelLeafNode',
    id: node.id,
    paneType: node.paneType,
  }

  // Validate optional fields
  if (node.terminalId !== undefined) {
    if (typeof node.terminalId === 'string') {
      result.terminalId = node.terminalId
    } else {
      repaired = true
    }
  }
  if (node.workspaceId !== undefined) {
    if (typeof node.workspaceId === 'string') {
      result.workspaceId = node.workspaceId
    } else {
      repaired = true
    }
  }

  return { tree: result as unknown as PanelTreeNode, repaired }
}

/**
 * Repair a PanelSplitNode.
 * Validates structure, recursively repairs children, collapses single-child splits.
 */
function repairPanelSplitNode(
  node: Record<string, unknown>
): { tree: PanelTreeNode; repaired: boolean } | undefined {
  if (typeof node.id !== 'string' || node.id === '') {
    return undefined
  }
  if (
    typeof node.direction !== 'string' ||
    !VALID_DIRECTIONS.has(node.direction)
  ) {
    return undefined
  }
  if (!Array.isArray(node.children)) {
    return undefined
  }

  let repaired = false
  const validChildren: PanelTreeNode[] = []
  for (const child of node.children) {
    const result = repairPanelTreeNode(child)
    if (result) {
      validChildren.push(result.tree)
      if (result.repaired) {
        repaired = true
      }
    } else {
      repaired = true
    }
  }

  if (validChildren.length === 0) {
    return undefined
  }
  const onlyChild = validChildren.length === 1 ? validChildren[0] : undefined
  if (onlyChild) {
    return { tree: onlyChild, repaired: true }
  }

  // Validate/rebuild sizes
  const sizesResult = repairSplitSizes(
    node.sizes,
    validChildren.length,
    (node.children as unknown[]).length
  )
  if (sizesResult.repaired) {
    repaired = true
  }

  return {
    tree: {
      _tag: 'PanelSplitNode',
      id: node.id,
      direction: node.direction as 'horizontal' | 'vertical',
      children: validChildren,
      sizes: sizesResult.sizes,
    },
    repaired,
  }
}

/**
 * Repair a PanelTab.
 * Validates structure and repairs the inner panelLayout.
 */
function repairPanelTab(
  tab: unknown
): { tab: PanelTab; repaired: boolean } | undefined {
  if (!isRecord(tab)) {
    return undefined
  }
  if (typeof tab.id !== 'string' || tab.id === '') {
    return undefined
  }

  const layoutResult = repairPanelTreeNode(tab.panelLayout)
  if (!layoutResult) {
    return undefined
  }

  let repaired = layoutResult.repaired
  const result: Record<string, unknown> = {
    id: tab.id,
    panelLayout: layoutResult.tree,
  }

  if (tab.label !== undefined) {
    if (typeof tab.label === 'string') {
      result.label = tab.label
    } else {
      repaired = true
    }
  }
  if (tab.focusedPaneId !== undefined) {
    if (typeof tab.focusedPaneId === 'string') {
      result.focusedPaneId = tab.focusedPaneId
    } else {
      repaired = true
    }
  }

  return { tab: result as unknown as PanelTab, repaired }
}

/**
 * Repair a WorkspaceTileNode (leaf or split).
 */
function repairWorkspaceTileNode(
  node: unknown
): { tile: WorkspaceTileNode; repaired: boolean } | undefined {
  if (!isRecord(node) || typeof node._tag !== 'string') {
    return undefined
  }

  if (node._tag === 'WorkspaceTileLeaf') {
    return repairWorkspaceTileLeaf(node)
  }

  if (node._tag === 'WorkspaceTileSplit') {
    return repairWorkspaceTileSplit(node)
  }

  return undefined
}

/**
 * Repair panel tabs from a raw array.
 * Returns valid tabs and whether any repairs were made.
 */
function repairPanelTabsArray(rawTabs: unknown): {
  tabs: PanelTab[]
  repaired: boolean
} {
  if (!Array.isArray(rawTabs)) {
    return { tabs: [], repaired: true }
  }

  let repaired = false
  const validTabs: PanelTab[] = []
  for (const rawTab of rawTabs) {
    const result = repairPanelTab(rawTab)
    if (result) {
      validTabs.push(result.tab)
      if (result.repaired) {
        repaired = true
      }
    } else {
      repaired = true
    }
  }
  return { tabs: validTabs, repaired }
}

/**
 * Validate and resolve activePanelTabId against valid tabs.
 */
function resolveActivePanelTabId(
  raw: unknown,
  validTabs: readonly PanelTab[]
): { id: string | undefined; repaired: boolean } {
  if (typeof raw === 'string') {
    const tabExists = validTabs.some((t) => t.id === raw)
    if (tabExists) {
      return { id: raw, repaired: false }
    }
    return { id: validTabs[0]?.id, repaired: true }
  }
  return {
    id: validTabs[0]?.id,
    // Always flag as repaired when activePanelTabId is being set from a
    // non-string value so the caller re-persists the corrected layout.
    repaired: true,
  }
}

/**
 * Repair a WorkspaceTileLeaf.
 * Validates structure, repairs panel tabs, drops invalid tabs.
 */
function repairWorkspaceTileLeaf(
  node: Record<string, unknown>
): { tile: WorkspaceTileNode; repaired: boolean } | undefined {
  if (typeof node.id !== 'string' || node.id === '') {
    return undefined
  }
  if (typeof node.workspaceId !== 'string' || node.workspaceId === '') {
    return undefined
  }

  const tabsResult = repairPanelTabsArray(node.panelTabs)
  const activeResult = resolveActivePanelTabId(
    node.activePanelTabId,
    tabsResult.tabs
  )
  const repaired = tabsResult.repaired || activeResult.repaired

  return {
    tile: {
      _tag: 'WorkspaceTileLeaf',
      id: node.id,
      workspaceId: node.workspaceId as string,
      panelTabs: tabsResult.tabs,
      activePanelTabId: activeResult.id,
    },
    repaired,
  }
}

/**
 * Repair a WorkspaceTileSplit.
 * Validates structure, recursively repairs children, collapses single-child splits.
 */
/**
 * Repair the children array of a workspace tile split.
 * Returns valid children and whether any repairs were made.
 */
function repairTileSplitChildren(rawChildren: unknown[]): {
  children: WorkspaceTileNode[]
  repaired: boolean
} {
  let repaired = false
  const validChildren: WorkspaceTileNode[] = []
  for (const child of rawChildren) {
    const result = repairWorkspaceTileNode(child)
    if (result) {
      validChildren.push(result.tile)
      if (result.repaired) {
        repaired = true
      }
    } else {
      repaired = true
    }
  }
  return { children: validChildren, repaired }
}

function repairWorkspaceTileSplit(
  node: Record<string, unknown>
): { tile: WorkspaceTileNode; repaired: boolean } | undefined {
  if (typeof node.id !== 'string' || node.id === '') {
    return undefined
  }
  if (
    typeof node.direction !== 'string' ||
    !VALID_DIRECTIONS.has(node.direction)
  ) {
    return undefined
  }
  if (!Array.isArray(node.children)) {
    return undefined
  }

  const childrenResult = repairTileSplitChildren(node.children)
  const { children: validChildren } = childrenResult
  let repaired = childrenResult.repaired

  if (validChildren.length === 0) {
    return undefined
  }
  const onlyTileChild =
    validChildren.length === 1 ? validChildren[0] : undefined
  if (onlyTileChild) {
    return { tile: onlyTileChild, repaired: true }
  }

  const sizesResult = repairSplitSizes(
    node.sizes,
    validChildren.length,
    node.children.length
  )
  if (sizesResult.repaired) {
    repaired = true
  }

  return {
    tile: {
      _tag: 'WorkspaceTileSplit',
      id: node.id,
      direction: node.direction as 'horizontal' | 'vertical',
      children: validChildren,
      sizes: sizesResult.sizes,
    },
    repaired,
  }
}

/**
 * Repair a WindowTab.
 * Validates structure and repairs the workspace tile tree.
 */
function repairWindowTab(
  tab: unknown
): { tab: WindowTab; repaired: boolean } | undefined {
  if (!isRecord(tab)) {
    return undefined
  }
  if (typeof tab.id !== 'string' || tab.id === '') {
    return undefined
  }

  let repaired = false
  const result: Record<string, unknown> = { id: tab.id }

  if (tab.label !== undefined) {
    if (typeof tab.label === 'string') {
      result.label = tab.label
    } else {
      repaired = true
    }
  }

  if (tab.workspaceLayout !== undefined && tab.workspaceLayout !== null) {
    const tileResult = repairWorkspaceTileNode(tab.workspaceLayout)
    if (tileResult) {
      result.workspaceLayout = tileResult.tile
      if (tileResult.repaired) {
        repaired = true
      }
    } else {
      // Invalid workspace layout — drop it (tab becomes empty)
      repaired = true
    }
  }

  return { tab: result as unknown as WindowTab, repaired }
}

/**
 * Repair a deserialized WindowLayout.
 *
 * Validates every node in the hierarchy recursively:
 * - WindowLayout: validates `tabs` array and `activeTabId`
 * - WindowTab: validates `id`, `label`, and `workspaceLayout`
 * - WorkspaceTileNode: validates leaves (workspace ID, panel tabs) and splits
 * - PanelTab: validates `id`, `panelLayout`, optional fields
 * - PanelTreeNode: validates leaves (pane type, terminal ID) and splits
 *
 * Invalid nodes are dropped. Single-child splits are collapsed.
 * Sizes are redistributed when invalid.
 *
 * Returns `{ windowLayout, wasRepaired }`. If `wasRepaired` is true,
 * the caller should re-persist the repaired layout.
 *
 * @param layout - The raw deserialized WindowLayout (may be malformed)
 * @returns The repaired layout and whether any repairs were made
 */
function repairWindowLayout(layout: unknown): RepairWindowLayoutResult {
  if (!isRecord(layout)) {
    return { windowLayout: undefined, wasRepaired: true }
  }

  if (!Array.isArray(layout.tabs)) {
    return { windowLayout: undefined, wasRepaired: true }
  }

  let repaired = false
  const validTabs: WindowTab[] = []
  for (const rawTab of layout.tabs) {
    const result = repairWindowTab(rawTab)
    if (result) {
      validTabs.push(result.tab)
      if (result.repaired) {
        repaired = true
      }
    } else {
      repaired = true
    }
  }

  if (validTabs.length === 0) {
    return { windowLayout: undefined, wasRepaired: true }
  }

  // Validate activeTabId
  let activeTabId: string | undefined
  if (typeof layout.activeTabId === 'string') {
    const tabExists = validTabs.some((t) => t.id === layout.activeTabId)
    if (tabExists) {
      activeTabId = layout.activeTabId as string
    } else {
      activeTabId = validTabs[0]?.id
      repaired = true
    }
  } else {
    activeTabId = validTabs[0]?.id
    // Always flag as repaired when activeTabId is being set from a
    // non-string value (undefined or invalid type) so the caller re-persists.
    repaired = true
  }

  return {
    windowLayout: { tabs: validTabs, activeTabId },
    wasRepaired: repaired,
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  addWindowTab,
  addWorkspaceToTabUnique,
  computeProgressiveCloseAction,
  findTerminalLocation,
  findWorkspaceLocation,
  getActiveWindowTab,
  getAllWorkspaceTileLeaves,
  getFirstPanelTreeLeafId,
  getStaleTerminalLeavesHierarchical,
  getWorkspaceTileLeaves,
  moveWorkspace,
  reconcileWindowLayout,
  removeWindowTab,
  removeWorkspaceFromLayout,
  reorderWindowTabs,
  repairWindowLayout,
  resolveActivePaneForPanelTab,
  resolveActivePaneForWindowTab,
  saveFocusedPaneId,
  shouldConfirmClosePanelTab,
  shouldConfirmCloseWindowTab,
  switchWindowTab,
  switchWindowTabByIndex,
  switchWindowTabRelative,
  updateWorkspaceTileLeaf,
}

export type {
  ProgressiveCloseAction,
  RepairWindowLayoutResult,
  StaleTerminalLeaf,
  TerminalLocation,
  TerminalProcessInfo,
  WorkspaceLocation,
}
