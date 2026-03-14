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
// Exports
// ---------------------------------------------------------------------------

export {
  addWindowTab,
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
}

export type { TerminalLocation, WorkspaceLocation }
