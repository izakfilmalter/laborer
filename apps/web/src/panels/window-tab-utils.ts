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
  PanelTreeNode,
  WindowLayout,
  WindowTab,
  WorkspaceTileLeaf,
  WorkspaceTileNode,
} from '@laborer/shared/types'

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

let _counter = 0

/**
 * Generate a unique ID for new window tab nodes.
 * Uses an incrementing counter with a random suffix to avoid collisions.
 */
function generateWindowTabId(): string {
  _counter += 1
  const random = Math.random().toString(36).slice(2, 8)
  return `window-tab-${_counter}-${random}`
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
  // No active pane and no layout → close app
  if (!activePaneId) {
    return { kind: 'close-app' }
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
// Exports
// ---------------------------------------------------------------------------

export {
  addWindowTab,
  computeProgressiveCloseAction,
  findTerminalLocation,
  findWorkspaceLocation,
  getActiveWindowTab,
  getAllWorkspaceTileLeaves,
  getWorkspaceTileLeaves,
  reorderWindowTabs,
  removeWindowTab,
  switchWindowTab,
  switchWindowTabByIndex,
  switchWindowTabRelative,
  updateWorkspaceTileLeaf,
}

export type { ProgressiveCloseAction, TerminalLocation, WorkspaceLocation }
