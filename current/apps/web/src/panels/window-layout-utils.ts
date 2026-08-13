/**
 * Window layout manipulation utilities.
 *
 * Pure functions that operate on `WindowLayout` — the top-level structure
 * containing window tabs, workspace tiles, and panel trees. Handles window
 * tab CRUD, workspace location lookups, focus resolution, terminal
 * navigation, close confirmation, progressive close, reconciliation, and
 * layout repair.
 *
 * All functions return a new layout — the original is never mutated.
 *
 * @see packages/shared/src/types.ts — WindowLayout, WindowTab, WorkspaceTileNode
 * @see apps/web/src/panels/panel-tree-utils.ts — panel-level tree utilities
 * @see apps/web/src/panels/workspace-tile-utils.ts — workspace tile utilities
 */

import type {
  LeafNode,
  PanelNode,
  PanelTab,
  WindowLayout,
  WindowTab,
  WorkspaceTileLeaf,
  WorkspaceTileNode,
} from '@laborer/shared/types'
import {
  PanelNodeSchema,
  PanelTabSchema,
  WindowLayoutSchema,
  WindowTabSchema,
  WorkspaceTileNodeSchema,
} from '@laborer/shared/types'
import { Result, Schema } from 'effect'

import { generateId } from './id-utils'
import { removePanelTab } from './panel-tab-utils'

import {
  closePane,
  collectTerminalIds,
  containsPane,
  countLeaves,
  findLeaf,
  findPaneInDirection,
  getFirstLeafId,
  getLeafIds,
} from './panel-tree-utils'
import { generateRandomTabName } from './random-name'
import { getWorkspaceTileLeaves } from './workspace-tile-utils'

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
 */
function addWindowTab(layout: WindowLayout, tab?: WindowTab): WindowLayout {
  const newTab: WindowTab = tab ?? {
    id: generateWindowTabId(),
    label: generateRandomTabName(),
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
 * Rename a window tab by ID.
 * If the tabId doesn't exist in the layout, returns the layout unchanged.
 */
function renameWindowTab(
  layout: WindowLayout,
  tabId: string,
  label: string
): WindowLayout {
  const index = layout.tabs.findIndex((t) => t.id === tabId)
  if (index === -1) {
    return layout
  }
  const newTabs = layout.tabs.map((t) => (t.id === tabId ? { ...t, label } : t))
  return { ...layout, tabs: newTabs }
}

/**
 * Switch the active window tab by ID.
 * If the tabId doesn't exist in the layout, returns the layout unchanged.
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
  node: PanelNode,
  terminalId: string
): string | undefined {
  if (node._tag === 'LeafNode') {
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
// Utility: collect all workspace tile leaves across all tabs
// ---------------------------------------------------------------------------

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
 * Resolve the pane that should receive focus for a given panel tab.
 * Prefers `focusedPaneId` if set, falls back to the first leaf pane.
 */
function resolveActivePaneForPanelTab(tab: PanelTab): string | undefined {
  if (tab.focusedPaneId) {
    return tab.focusedPaneId
  }
  return getFirstLeafId(tab.panelLayout)
}

/**
 * Try to resolve a valid active pane ID from a single workspace tile leaf.
 * Returns the pane ID if the leaf has a resolvable active pane,
 * otherwise undefined.
 */
function resolveActivePaneFromLeaf(
  leaf: WorkspaceTileLeaf
): string | undefined {
  const activeTab = leaf.panelTabs.find((t) => t.id === leaf.activePanelTabId)
  if (activeTab) {
    const paneId = resolveActivePaneForPanelTab(activeTab)
    if (paneId) {
      return paneId
    }
  }
  const firstTab = leaf.panelTabs[0]
  if (firstTab) {
    const paneId = resolveActivePaneForPanelTab(firstTab)
    if (paneId) {
      return paneId
    }
  }
  return undefined
}

/**
 * Resolve the pane that should receive focus when switching to a window tab.
 *
 * Prefers the workspace tile leaf recorded in `focusedWorkspaceTileId`,
 * then walks its active panel tab to find the focused pane. Falls back to
 * the first leaf with a resolvable active pane (DFS order) for backward
 * compatibility with layouts that predate the `focusedWorkspaceTileId` field.
 */
function resolveActivePaneForWindowTab(tab: WindowTab): string | undefined {
  if (!tab.workspaceLayout) {
    return undefined
  }
  const leaves = getWorkspaceTileLeaves(tab.workspaceLayout)
  if (leaves.length === 0) {
    return undefined
  }

  // Prefer the focused workspace tile if it exists and has a valid pane
  if (tab.focusedWorkspaceTileId) {
    const focusedLeaf = leaves.find((l) => l.id === tab.focusedWorkspaceTileId)
    if (focusedLeaf) {
      const resolved = resolveActivePaneFromLeaf(focusedLeaf)
      if (resolved) {
        return resolved
      }
    }
  }

  // Fallback: iterate leaves in DFS order
  for (const leaf of leaves) {
    const resolved = resolveActivePaneFromLeaf(leaf)
    if (resolved) {
      return resolved
    }
  }
  return undefined
}

/**
 * Try to resolve a valid workspace ID from a single workspace tile leaf.
 * Returns the leaf's workspace ID if it has a resolvable active pane,
 * otherwise undefined.
 */
function resolveWorkspaceIdFromLeaf(
  leaf: WorkspaceTileLeaf
): string | undefined {
  return resolveActivePaneFromLeaf(leaf) ? leaf.workspaceId : undefined
}

/**
 * Resolve the active workspace ID from the hierarchical layout.
 *
 * Prefers the workspace tile leaf recorded in `focusedWorkspaceTileId` on
 * the active window tab. Falls back to the first leaf with a resolvable
 * active pane (DFS order) for backward compatibility with layouts that
 * predate the `focusedWorkspaceTileId` field.
 */
function resolveActiveWorkspaceId(layout: WindowLayout): string | undefined {
  const activeTab = getActiveWindowTab(layout)
  if (!activeTab?.workspaceLayout) {
    return undefined
  }
  const leaves = getWorkspaceTileLeaves(activeTab.workspaceLayout)

  // Prefer the focused workspace tile if it exists and has a valid pane
  if (activeTab.focusedWorkspaceTileId) {
    const focusedLeaf = leaves.find(
      (l) => l.id === activeTab.focusedWorkspaceTileId
    )
    if (focusedLeaf) {
      const resolved = resolveWorkspaceIdFromLeaf(focusedLeaf)
      if (resolved) {
        return resolved
      }
    }
  }

  // Fallback: iterate leaves in DFS order
  for (const leaf of leaves) {
    const resolved = resolveWorkspaceIdFromLeaf(leaf)
    if (resolved) {
      return resolved
    }
  }
  return undefined
}

/**
 * Save the current focusedPaneId on the active panel tab of the workspace
 * that contains the given pane. Walks all tabs > all workspaces > all panel
 * tabs to find the pane and update its panel tab's focusedPaneId.
 */
function saveFocusedPaneId(layout: WindowLayout, paneId: string): WindowLayout {
  const newTabs = layout.tabs.map((tab) => {
    if (!tab.workspaceLayout) {
      return tab
    }
    const newWorkspaceLayout = saveFocusInTileTree(tab.workspaceLayout, paneId)
    const tileId = findTileLeafContainingPane(tab.workspaceLayout, paneId)
    const newFocusedTileId = tileId ?? tab.focusedWorkspaceTileId
    const layoutChanged = newWorkspaceLayout !== tab.workspaceLayout
    const tileChanged = newFocusedTileId !== tab.focusedWorkspaceTileId
    if (!(layoutChanged || tileChanged)) {
      return tab
    }
    return {
      ...tab,
      workspaceLayout: newWorkspaceLayout,
      focusedWorkspaceTileId: newFocusedTileId,
    }
  })
  if (newTabs.every((tab, i) => tab === layout.tabs[i])) {
    return layout
  }
  return { ...layout, tabs: newTabs }
}

/**
 * Find the workspace tile leaf ID that contains a given pane.
 * Searches all tile leaves' panel tabs for the pane.
 */
function findTileLeafContainingPane(
  node: WorkspaceTileNode,
  paneId: string
): string | undefined {
  if (node._tag === 'WorkspaceTileLeaf') {
    for (const tab of node.panelTabs) {
      if (containsPane(tab.panelLayout, paneId)) {
        return node.id
      }
    }
    return undefined
  }
  for (const child of node.children) {
    const found = findTileLeafContainingPane(child, paneId)
    if (found) {
      return found
    }
  }
  return undefined
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
    if (containsPane(tab.panelLayout, paneId)) {
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

// ---------------------------------------------------------------------------
// Workspace tile leaf update
// ---------------------------------------------------------------------------

/**
 * Apply a transform to the workspace tile node that matches a given
 * workspace ID within a tile tree.
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
  if (newChildren.every((child, i) => child === node.children[i])) {
    return node
  }
  return { ...node, children: newChildren }
}

/**
 * Apply a transform to a workspace tile leaf within a WindowLayout.
 * Searches all tabs for the workspace and applies the transform.
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
 * entire layout.
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

  if (newTabs.every((tab, i) => tab === layout.tabs[i])) {
    return layout
  }

  return { ...layout, tabs: newTabs }
}

/**
 * Move a workspace from its current location (any tab in the layout) to
 * a specific target tab.
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
 * Collect all terminal IDs from a WorkspaceTileNode tree.
 * Walks workspace tiles > panel tabs > panel tree nodes.
 */
function collectTerminalIdsFromTileTree(
  node: WorkspaceTileNode
): readonly string[] {
  if (node._tag === 'WorkspaceTileLeaf') {
    return node.panelTabs.flatMap((tab) => collectTerminalIds(tab.panelLayout))
  }
  return node.children.flatMap(collectTerminalIdsFromTileTree)
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
 */
function shouldConfirmClosePanelTab(
  panelTab: PanelTab,
  terminals: readonly TerminalProcessInfo[]
): boolean {
  const terminalIds = collectTerminalIds(panelTab.panelLayout)
  return hasRunningProcess(terminalIds, terminals)
}

/**
 * Determine whether closing a window tab should show a confirmation dialog.
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
      /** Close a pane within a panel tab's split tree. */
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
      /** Remove a workspace from the active window tab. */
      readonly kind: 'close-workspace'
      readonly workspaceId: string
    }
  | {
      /** Close the active window tab. */
      readonly kind: 'close-window-tab'
      readonly tabId: string
    }
  | {
      /** No tabs left — show the close-app dialog or do nothing. */
      readonly kind: 'close-app'
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

/**
 * Determine whether closing the last item at this level should escalate
 * to closing the window tab.
 */
function resolveLastWorkspaceCloseAction(
  _layout: WindowLayout,
  activeTab: WindowTab
): ProgressiveCloseAction {
  return { kind: 'close-window-tab', tabId: activeTab.id }
}

/**
 * Determine the close action when the workspace has no active panel tab.
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
 * Determine the close action when the active panel tab has exactly one pane.
 */
function resolveLastPaneCloseAction(
  activePanelTabId: string,
  activeWorkspaceId: string
): ProgressiveCloseAction {
  return {
    kind: 'close-panel-tab',
    tabId: activePanelTabId,
    workspaceId: activeWorkspaceId,
  }
}

/**
 * Resolve the close action when no pane is focused.
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
      return { kind: 'close-window-tab', tabId: activeTab.id }
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
 */
function computeProgressiveCloseAction(
  layout: WindowLayout | undefined,
  activePaneId: string | null,
  activeWorkspaceId: string | undefined
): ProgressiveCloseAction {
  if (!activePaneId) {
    return resolveNullPaneCloseAction(layout)
  }

  if (!layout) {
    return { kind: 'close-pane', paneId: activePaneId }
  }

  const activeTab = getActiveWindowTab(layout)
  if (!activeTab) {
    return { kind: 'close-app' }
  }

  if (!activeWorkspaceId) {
    if (!activeTab.workspaceLayout) {
      return { kind: 'close-window-tab', tabId: activeTab.id }
    }
    const leaves = getWorkspaceTileLeaves(activeTab.workspaceLayout)
    if (leaves.length === 0) {
      return { kind: 'close-window-tab', tabId: activeTab.id }
    }
    return { kind: 'close-pane', paneId: activePaneId }
  }

  const workspaceLeaf = activeTab.workspaceLayout
    ? findWorkspaceTileLeaf(activeTab.workspaceLayout, activeWorkspaceId)
    : undefined

  if (!workspaceLeaf) {
    return { kind: 'close-pane', paneId: activePaneId }
  }

  const activePanelTab = workspaceLeaf.panelTabs.find(
    (t) => t.id === workspaceLeaf.activePanelTabId
  )

  if (!activePanelTab) {
    return resolveEmptyWorkspaceAction(layout, activeTab, activeWorkspaceId)
  }

  const paneCount = countLeaves(activePanelTab.panelLayout)
  if (paneCount > 1) {
    return { kind: 'close-pane', paneId: activePaneId }
  }

  return resolveLastPaneCloseAction(activePanelTab.id, activeWorkspaceId)
}

// ---------------------------------------------------------------------------
// Close terminal in hierarchical layout
// ---------------------------------------------------------------------------

/**
 * Close a terminal's pane in the hierarchical window layout.
 *
 * Searches all window tabs, workspaces, and panel tabs for the terminal.
 * If the pane is the only one in its panel tab, removes the entire panel tab.
 * Otherwise, removes just the pane from the panel tree.
 */
function closeTerminalInWindowLayout(
  layout: WindowLayout,
  terminalId: string
): WindowLayout {
  const location = findTerminalLocation(layout, terminalId)
  if (!location) {
    return layout
  }

  const paneCount = (() => {
    for (const tab of layout.tabs) {
      if (tab.id !== location.tabId || !tab.workspaceLayout) {
        continue
      }
      const tile = findWorkspaceTileLeaf(
        tab.workspaceLayout,
        location.workspaceId
      )
      if (!tile) {
        continue
      }
      const panelTab = tile.panelTabs.find((t) => t.id === location.panelTabId)
      if (panelTab) {
        return countLeaves(panelTab.panelLayout)
      }
    }
    return 0
  })()

  if (paneCount <= 1) {
    return updateWorkspaceTileLeaf(layout, location.workspaceId, (leaf) =>
      removePanelTab(leaf, location.panelTabId)
    )
  }

  return updateWorkspaceTileLeaf(layout, location.workspaceId, (leaf) => {
    const newTabs = leaf.panelTabs.map((tab) => {
      if (tab.id !== location.panelTabId) {
        return tab
      }
      const newLayout = closePane(tab.panelLayout, location.paneId)
      if (!newLayout) {
        return tab
      }
      return { ...tab, panelLayout: newLayout }
    })
    return { ...leaf, panelTabs: newTabs }
  })
}

// ---------------------------------------------------------------------------
// Hierarchical reconciliation: stale terminal detection + ID replacement
// ---------------------------------------------------------------------------

/**
 * Stale terminal leaf info within the hierarchical layout.
 */
interface StaleTerminalLeaf {
  /**
   * Spawn intent recorded on the leaf (e.g. `opencode`). Respawn passes
   * it through so an agent pane comes back as an agent (ADR 0003).
   */
  readonly command: string | undefined
  readonly paneId: string
  readonly terminalId: string
  readonly workspaceId: string | undefined
}

/**
 * Collect all terminal leaves from a PanelNode whose terminalId is
 * not in the live terminal set.
 */
function getStaleTerminalLeavesFromPanelTree(
  node: PanelNode,
  liveTerminalIds: ReadonlySet<string>
): readonly StaleTerminalLeaf[] {
  if (node._tag === 'LeafNode') {
    if (
      node.terminalId !== undefined &&
      !liveTerminalIds.has(node.terminalId)
    ) {
      return [
        {
          command: node.command,
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
 * Reconcile a PanelNode by replacing stale terminal IDs with
 * respawned ones.
 */
function reconcilePanelTree(
  node: PanelNode,
  liveTerminalIds: ReadonlySet<string>,
  respawnedIds: ReadonlyMap<string, string>
): PanelNode {
  if (node._tag === 'LeafNode') {
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
 * Preserves referential equality when no changes are made.
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
// Schema-based layout decode and repair
// ---------------------------------------------------------------------------

/**
 * Result of decoding/repairing a WindowLayout.
 */
interface RepairWindowLayoutResult {
  readonly wasRepaired: boolean
  readonly windowLayout: WindowLayout | undefined
}

/** Type guard for record-like objects. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Decode and repair a deserialized `WindowLayout` using Effect Schema.
 *
 * Replaces the 490-line manual `repairWindowLayout` function with a
 * Schema decode pipeline. Handles all the same edge cases:
 *
 * 1. Non-object input → `undefined` layout
 * 2. Missing/invalid `tabs` → empty layout
 * 3. Invalid nodes dropped (bad `_tag`, empty `id`, invalid `paneType`)
 * 4. Single-child splits collapsed to their child
 * 5. Invalid sizes redistributed as equal
 * 6. Stale `activeTabId` / `activePanelTabId` resolved to first valid
 * 7. Invalid optional fields stripped (`terminalId`, `label`, `focusedPaneId`)
 *
 * Returns `{ windowLayout, wasRepaired }` — same shape as `repairWindowLayout`
 * for drop-in replacement at the call site.
 */
function decodeWindowLayout(input: unknown): RepairWindowLayoutResult {
  try {
    // Step 1: Try strict Schema decode first (fast path for valid data)
    const decodeResult = Schema.decodeUnknownResult(
      Schema.toType(WindowLayoutSchema)
    )(input)

    if (Result.isSuccess(decodeResult)) {
      // Valid layout — apply repair transforms (collapse splits, fix sizes, etc.)
      const decoded = decodeResult.success
      const repaired = repairTransforms(decoded)
      const wasRepaired = !deepEqual(decoded, repaired)
      return { windowLayout: repaired, wasRepaired }
    }

    // Step 2: Schema decode failed — attempt lenient field-by-field recovery
    return lenientDecodeWindowLayout(input)
  } catch {
    // Persisted state must never prevent the renderer from starting, including
    // if a decoder or repair transform itself unexpectedly defects.
    return { windowLayout: undefined, wasRepaired: true }
  }
}

/**
 * Apply repair transformations to a structurally valid WindowLayout:
 * - Collapse single-child splits to their child
 * - Redistribute invalid sizes
 * - Filter out tabs/nodes with empty IDs
 * - Resolve stale `activeTabId` to first valid tab
 * - Resolve stale `activePanelTabId` to first valid panel tab
 */
function repairTransforms(layout: WindowLayout): WindowLayout {
  const repairedTabs = layout.tabs
    .filter((t) => t.id !== '')
    .map(repairWindowTabTransform)
  const activeTabId = resolveActiveTabId(layout.activeTabId, repairedTabs)
  return { tabs: repairedTabs, activeTabId }
}

function repairWindowTabTransform(tab: WindowTab): WindowTab {
  if (!tab.workspaceLayout) {
    return tab
  }
  const repairedLayout = repairWorkspaceTileTransform(tab.workspaceLayout)
  if (repairedLayout === tab.workspaceLayout) {
    return tab
  }
  return { ...tab, workspaceLayout: repairedLayout }
}

function repairWorkspaceTileTransform(
  node: WorkspaceTileNode
): WorkspaceTileNode {
  if (node._tag === 'WorkspaceTileLeaf') {
    const repairedTabs = node.panelTabs.map(repairPanelTabTransform)
    const activeId = resolveActiveId(
      node.activePanelTabId,
      repairedTabs.map((t) => t.id)
    )
    const changed =
      repairedTabs !== node.panelTabs || activeId !== node.activePanelTabId
    return changed
      ? { ...node, panelTabs: repairedTabs, activePanelTabId: activeId }
      : node
  }

  // WorkspaceTileSplit
  const repairedChildren = node.children.map(repairWorkspaceTileTransform)

  // Collapse single-child
  if (repairedChildren.length === 1 && repairedChildren[0]) {
    return repairedChildren[0]
  }

  const sizes = repairSizesTransform(node.sizes, repairedChildren.length)
  const changed = repairedChildren !== node.children || sizes !== node.sizes
  return changed ? { ...node, children: repairedChildren, sizes } : node
}

function repairPanelTabTransform(tab: PanelTab): PanelTab {
  const repairedLayout = repairPanelNodeTransform(tab.panelLayout)
  if (repairedLayout === tab.panelLayout) {
    return tab
  }
  return { ...tab, panelLayout: repairedLayout }
}

function repairPanelNodeTransform(node: PanelNode): PanelNode {
  if (node._tag === 'LeafNode') {
    return node
  }

  // SplitNode
  const repairedChildren = node.children.map(repairPanelNodeTransform)

  // Collapse single-child
  if (repairedChildren.length === 1 && repairedChildren[0]) {
    return repairedChildren[0]
  }

  const sizes = repairSizesTransform(node.sizes, repairedChildren.length)
  const changed = repairedChildren !== node.children || sizes !== node.sizes
  return changed ? { ...node, children: repairedChildren, sizes } : node
}

function repairSizesTransform(
  sizes: readonly number[],
  expectedLength: number
): readonly number[] {
  if (
    sizes.length === expectedLength &&
    sizes.every((s) => typeof s === 'number' && s > 0)
  ) {
    return sizes
  }
  const equalSize = 100 / expectedLength
  return Array.from({ length: expectedLength }, () => equalSize)
}

function resolveActiveTabId(
  activeTabId: string | undefined,
  tabs: readonly WindowTab[]
): string | undefined {
  if (activeTabId && tabs.some((t) => t.id === activeTabId)) {
    return activeTabId
  }
  return tabs[0]?.id
}

function resolveActiveId(
  current: string | undefined,
  validIds: readonly string[]
): string | undefined {
  if (current && validIds.includes(current)) {
    return current
  }
  return validIds[0]
}

/**
 * Simple deep equality check for WindowLayout structures.
 * Compares JSON serializations for structural equality.
 */
function deepEqual(a: WindowLayout, b: WindowLayout): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

// Schema decoders (cached at module level for performance)
const decodeWindowTab = Schema.decodeUnknownResult(
  Schema.toType(WindowTabSchema)
)
const decodePanelNode = Schema.decodeUnknownResult(
  Schema.toType(PanelNodeSchema)
)
const decodePanelTab = Schema.decodeUnknownResult(Schema.toType(PanelTabSchema))
const decodeTileNode = Schema.decodeUnknownResult(
  Schema.toType(WorkspaceTileNodeSchema)
)

/**
 * Lenient decode of a WindowLayout from `unknown` input.
 *
 * When strict Schema decode fails (some nodes are malformed), this function
 * processes the input field-by-field: it tries Schema decode on each node
 * individually, dropping nodes that fail, and applying repair transforms
 * (collapse single-child splits, redistribute sizes, resolve active IDs).
 */
function lenientDecodeWindowLayout(input: unknown): RepairWindowLayoutResult {
  if (!isRecord(input)) {
    return { windowLayout: undefined, wasRepaired: true }
  }

  if (!Array.isArray(input.tabs)) {
    return { windowLayout: undefined, wasRepaired: true }
  }

  const validTabs: WindowTab[] = []
  for (const rawTab of input.tabs) {
    const decoded = lenientDecodeWindowTab(rawTab)
    if (decoded) {
      validTabs.push(decoded)
    }
  }

  if (validTabs.length === 0) {
    return {
      windowLayout: { tabs: [], activeTabId: undefined },
      wasRepaired: true,
    }
  }

  const activeTabId = resolveActiveTabId(
    typeof input.activeTabId === 'string' ? input.activeTabId : undefined,
    validTabs
  )
  const layout: WindowLayout = { tabs: validTabs, activeTabId }
  const repaired = repairTransforms(layout)
  return { windowLayout: repaired, wasRepaired: true }
}

/**
 * Lenient decode of a WindowTab. Returns undefined if the tab is irrecoverable.
 */
function lenientDecodeWindowTab(raw: unknown): WindowTab | undefined {
  // Try strict Schema decode first
  const result = decodeWindowTab(raw)
  if (Result.isSuccess(result) && result.success.id !== '') {
    return result.success
  }

  // Lenient: validate required fields manually
  if (!isRecord(raw)) {
    return undefined
  }
  if (typeof raw.id !== 'string' || raw.id === '') {
    return undefined
  }

  const tab: Record<string, unknown> = { id: raw.id }
  if (typeof raw.label === 'string') {
    tab.label = raw.label
  }
  if (raw.workspaceLayout !== undefined && raw.workspaceLayout !== null) {
    const tile = lenientDecodeTileNode(raw.workspaceLayout)
    if (tile) {
      tab.workspaceLayout = tile
    }
  }

  return tab as unknown as WindowTab
}

/**
 * Lenient decode of a WorkspaceTileNode.
 */
function lenientDecodeTileNode(raw: unknown): WorkspaceTileNode | undefined {
  // Try strict Schema decode
  const result = decodeTileNode(raw)
  if (Result.isSuccess(result)) {
    return result.success
  }

  if (!isRecord(raw) || typeof raw._tag !== 'string') {
    return undefined
  }

  if (raw._tag === 'WorkspaceTileLeaf') {
    return lenientDecodeTileLeaf(raw)
  }

  if (raw._tag === 'WorkspaceTileSplit') {
    return lenientDecodeTileSplit(raw)
  }

  return undefined
}

/**
 * Lenient decode of a WorkspaceTileLeaf.
 */
function lenientDecodeTileLeaf(
  raw: Record<string, unknown>
): WorkspaceTileLeaf | undefined {
  if (typeof raw.id !== 'string' || raw.id === '') {
    return undefined
  }
  if (typeof raw.workspaceId !== 'string' || raw.workspaceId === '') {
    return undefined
  }

  const panelTabs: PanelTab[] = []
  if (Array.isArray(raw.panelTabs)) {
    for (const rawTab of raw.panelTabs) {
      const decoded = lenientDecodePanelTab(rawTab)
      if (decoded) {
        panelTabs.push(decoded)
      }
    }
  }

  const activePanelTabId = resolveActiveId(
    typeof raw.activePanelTabId === 'string' ? raw.activePanelTabId : undefined,
    panelTabs.map((t) => t.id)
  )

  return {
    _tag: 'WorkspaceTileLeaf',
    id: raw.id,
    workspaceId: raw.workspaceId,
    panelTabs,
    activePanelTabId,
  }
}

/**
 * Lenient decode of a WorkspaceTileSplit.
 */
function lenientDecodeTileSplit(
  raw: Record<string, unknown>
): WorkspaceTileNode | undefined {
  if (typeof raw.id !== 'string' || raw.id === '') {
    return undefined
  }
  if (typeof raw.direction !== 'string') {
    return undefined
  }
  if (raw.direction !== 'horizontal' && raw.direction !== 'vertical') {
    return undefined
  }
  if (!Array.isArray(raw.children)) {
    return undefined
  }

  const validChildren: WorkspaceTileNode[] = []
  for (const child of raw.children) {
    const decoded = lenientDecodeTileNode(child)
    if (decoded) {
      validChildren.push(decoded)
    }
  }

  if (validChildren.length === 0) {
    return undefined
  }
  if (validChildren.length === 1 && validChildren[0]) {
    return validChildren[0]
  }

  const sizes = repairSizesTransform(
    Array.isArray(raw.sizes) ? (raw.sizes as readonly number[]) : [],
    validChildren.length
  )

  return {
    _tag: 'WorkspaceTileSplit',
    id: raw.id,
    direction: raw.direction,
    children: validChildren,
    sizes,
  }
}

/**
 * Lenient decode of a PanelTab.
 */
function lenientDecodePanelTab(raw: unknown): PanelTab | undefined {
  // Try strict Schema decode first
  const result = decodePanelTab(raw)
  if (Result.isSuccess(result) && result.success.id !== '') {
    return result.success
  }

  // Lenient: validate required fields
  if (!isRecord(raw)) {
    return undefined
  }
  if (typeof raw.id !== 'string' || raw.id === '') {
    return undefined
  }

  const panelLayout = lenientDecodePanelNode(raw.panelLayout)
  if (!panelLayout) {
    return undefined
  }

  const tab: Record<string, unknown> = {
    id: raw.id,
    panelLayout,
  }
  if (typeof raw.label === 'string') {
    tab.label = raw.label
  }
  if (typeof raw.focusedPaneId === 'string') {
    tab.focusedPaneId = raw.focusedPaneId
  }

  return tab as unknown as PanelTab
}

/**
 * Lenient decode of a PanelNode (LeafNode or SplitNode).
 */
function lenientDecodePanelNode(raw: unknown): PanelNode | undefined {
  // Try strict Schema decode first
  const result = decodePanelNode(raw)
  if (Result.isSuccess(result)) {
    return result.success
  }

  if (!isRecord(raw) || typeof raw._tag !== 'string') {
    return undefined
  }

  if (raw._tag === 'LeafNode') {
    return lenientDecodeLeafNode(raw)
  }

  if (raw._tag === 'SplitNode') {
    return lenientDecodeSplitNode(raw)
  }

  return undefined
}

/**
 * Lenient decode of a LeafNode.
 */
function lenientDecodeLeafNode(
  raw: Record<string, unknown>
): PanelNode | undefined {
  if (typeof raw.id !== 'string' || raw.id === '') {
    return undefined
  }
  if (typeof raw.paneType !== 'string') {
    return undefined
  }

  const validPaneTypes = new Set([
    'agent',
    'terminal',
    'diff',
    'devServerTerminal',
  ])
  if (!validPaneTypes.has(raw.paneType)) {
    return undefined
  }

  const result: Record<string, unknown> = {
    _tag: 'LeafNode',
    id: raw.id,
    paneType: raw.paneType,
  }

  if (typeof raw.terminalId === 'string') {
    result.terminalId = raw.terminalId
  }
  if (typeof raw.workspaceId === 'string') {
    result.workspaceId = raw.workspaceId
  }

  return result as unknown as PanelNode
}

/**
 * Lenient decode of a SplitNode.
 */
function lenientDecodeSplitNode(
  raw: Record<string, unknown>
): PanelNode | undefined {
  if (typeof raw.id !== 'string' || raw.id === '') {
    return undefined
  }
  if (typeof raw.direction !== 'string') {
    return undefined
  }
  if (raw.direction !== 'horizontal' && raw.direction !== 'vertical') {
    return undefined
  }
  if (!Array.isArray(raw.children)) {
    return undefined
  }

  const validChildren: PanelNode[] = []
  for (const child of raw.children) {
    const decoded = lenientDecodePanelNode(child)
    if (decoded) {
      validChildren.push(decoded)
    }
  }

  if (validChildren.length === 0) {
    return undefined
  }
  if (validChildren.length === 1 && validChildren[0]) {
    return validChildren[0]
  }

  const sizes = repairSizesTransform(
    Array.isArray(raw.sizes) ? (raw.sizes as readonly number[]) : [],
    validChildren.length
  )

  return {
    _tag: 'SplitNode',
    id: raw.id,
    direction: raw.direction,
    children: validChildren,
    sizes,
  }
}

// ---------------------------------------------------------------------------
// Pane/leaf lookups
// ---------------------------------------------------------------------------

/**
 * Find a leaf pane by ID across all workspace tile leaves' active panel tabs
 * in the active window tab. Searches only the active panel tab of each
 * workspace tile leaf (the visible panes).
 *
 * Replaces `findNodeById(layout, paneId)` for the common case of looking
 * up a pane in the currently visible layout.
 */
function findPaneInActiveTab(
  layout: WindowLayout,
  paneId: string
): { leaf: LeafNode; workspaceId: string | undefined } | undefined {
  const activeTab = getActiveWindowTab(layout)
  if (!activeTab?.workspaceLayout) {
    return undefined
  }
  const leaves = getWorkspaceTileLeaves(activeTab.workspaceLayout)
  for (const tileLeaf of leaves) {
    const activePanel = tileLeaf.panelTabs.find(
      (t) => t.id === tileLeaf.activePanelTabId
    )
    const panelTree =
      activePanel?.panelLayout ?? tileLeaf.panelTabs[0]?.panelLayout
    if (!panelTree) {
      continue
    }
    const found = findLeaf(panelTree, paneId)
    if (found) {
      return { leaf: found, workspaceId: tileLeaf.workspaceId }
    }
  }
  return undefined
}

/**
 * Find a leaf pane by ID across ALL panel tabs (not just active) in the
 * active window tab. Useful for checking if a pane exists anywhere in the
 * layout, not just in the currently visible tabs.
 */
function findPaneAcrossAllTabs(
  layout: WindowLayout,
  paneId: string
): { leaf: LeafNode; workspaceId: string | undefined } | undefined {
  const activeTab = getActiveWindowTab(layout)
  if (!activeTab?.workspaceLayout) {
    return undefined
  }
  const leaves = getWorkspaceTileLeaves(activeTab.workspaceLayout)
  for (const tileLeaf of leaves) {
    for (const panelTab of tileLeaf.panelTabs) {
      const found = findLeaf(panelTab.panelLayout, paneId)
      if (found) {
        return { leaf: found, workspaceId: tileLeaf.workspaceId }
      }
    }
  }
  return undefined
}

/**
 * Find a leaf pane by terminal ID across all panel tabs in the active
 * window tab. Returns the leaf node and its workspace ID.
 */
function findLeafByTerminalIdInLayout(
  layout: WindowLayout,
  terminalId: string
): { leaf: LeafNode; workspaceId: string | undefined } | undefined {
  const activeTab = getActiveWindowTab(layout)
  if (!activeTab?.workspaceLayout) {
    return undefined
  }
  const leaves = getWorkspaceTileLeaves(activeTab.workspaceLayout)
  for (const tileLeaf of leaves) {
    for (const panelTab of tileLeaf.panelTabs) {
      const found = findLeafByTerminalIdInTree(panelTab.panelLayout, terminalId)
      if (found) {
        return { leaf: found, workspaceId: tileLeaf.workspaceId }
      }
    }
  }
  return undefined
}

/**
 * Recursively search a panel tree for a terminal ID. Returns the leaf node.
 */
function findLeafByTerminalIdInTree(
  node: PanelNode,
  terminalId: string
): LeafNode | undefined {
  if (node._tag === 'LeafNode') {
    return node.terminalId === terminalId ? node : undefined
  }
  for (const child of node.children) {
    const found = findLeafByTerminalIdInTree(child, terminalId)
    if (found) {
      return found
    }
  }
  return undefined
}

/**
 * Get all leaf nodes from the active window tab's workspace tile leaves'
 * active panel tabs. Returns only the visible leaves.
 */
function getActiveTabLeafNodes(layout: WindowLayout): LeafNode[] {
  const activeTab = getActiveWindowTab(layout)
  if (!activeTab?.workspaceLayout) {
    return []
  }
  const leaves = getWorkspaceTileLeaves(activeTab.workspaceLayout)
  const result: LeafNode[] = []
  for (const tileLeaf of leaves) {
    const activePanel = tileLeaf.panelTabs.find(
      (t) => t.id === tileLeaf.activePanelTabId
    )
    const panelTree =
      activePanel?.panelLayout ?? tileLeaf.panelTabs[0]?.panelLayout
    if (panelTree) {
      collectLeafNodes(panelTree, result)
    }
  }
  return result
}

/** Recursively collect leaf nodes from a panel tree. */
function collectLeafNodes(node: PanelNode, result: LeafNode[]): void {
  if (node._tag === 'LeafNode') {
    result.push(node)
    return
  }
  for (const child of node.children) {
    collectLeafNodes(child, result)
  }
}

/**
 * Get all leaf pane IDs from the active window tab's workspace tile leaves'
 * active panel tabs. Returns only the visible pane IDs.
 */
function getActiveTabLeafIds(layout: WindowLayout): string[] {
  const activeTab = getActiveWindowTab(layout)
  if (!activeTab?.workspaceLayout) {
    return []
  }
  const leaves = getWorkspaceTileLeaves(activeTab.workspaceLayout)
  const result: string[] = []
  for (const tileLeaf of leaves) {
    const activePanel = tileLeaf.panelTabs.find(
      (t) => t.id === tileLeaf.activePanelTabId
    )
    const panelTree =
      activePanel?.panelLayout ?? tileLeaf.panelTabs[0]?.panelLayout
    if (panelTree) {
      result.push(...getLeafIds(panelTree))
    }
  }
  return result
}

/**
 * Resolve the active pane ID scoped to a specific workspace's sub-layout.
 *
 * If the global `activePaneId` belongs to one of this workspace's leaves,
 * it is returned as-is. Otherwise, falls back to the first leaf so that
 * header buttons always operate on a pane within their own workspace.
 *
 * Operates on `PanelNode` directly.
 */
function getScopedActivePaneId(
  subLayout: PanelNode,
  globalActivePaneId: string | null
): string | null {
  if (
    globalActivePaneId != null &&
    containsPane(subLayout, globalActivePaneId)
  ) {
    return globalActivePaneId
  }
  return getFirstLeafId(subLayout) ?? null
}

/**
 * Compute the close-pane gating action for the hierarchical layout.
 *
 * Determines whether closing a pane should proceed immediately or show
 * a confirmation dialog. Checks if the terminal has a running process
 * and if the pane is the last for a merged-PR workspace.
 */
function computeClosePaneGateAction(
  layout: WindowLayout | undefined,
  paneId: string,
  terminals: ReadonlyArray<{
    readonly id: string
    readonly hasChildProcess: boolean
  }>,
  prState: string | null
): ClosePaneGateResult {
  if (!layout) {
    return { action: 'close' }
  }

  const found = findPaneAcrossAllTabs(layout, paneId)
  if (!found || found.leaf._tag !== 'LeafNode') {
    return { action: 'close' }
  }

  const node = found.leaf
  const hasProcess =
    node.terminalId != null &&
    terminals.some(
      (t) => t.id === node.terminalId && t.hasChildProcess === true
    )
  const workspaceId = found.workspaceId
  const isPrMerged = prState === 'MERGED'

  // Check if this is the last pane for the workspace across all panel tabs
  let isLastPaneForWorkspace = false
  if (workspaceId != null && isPrMerged) {
    const activeTab = getActiveWindowTab(layout)
    if (activeTab?.workspaceLayout) {
      const tileLeaves = getWorkspaceTileLeaves(activeTab.workspaceLayout)
      const wsTile = tileLeaves.find((l) => l.workspaceId === workspaceId)
      if (wsTile) {
        let totalPanes = 0
        for (const pt of wsTile.panelTabs) {
          totalPanes += countLeaves(pt.panelLayout)
        }
        isLastPaneForWorkspace = totalPanes === 1
      }
    }
  }

  if (hasProcess && isLastPaneForWorkspace && workspaceId != null) {
    return { action: 'confirm-with-destroy', workspaceId }
  }

  if (hasProcess) {
    return { action: 'confirm' }
  }

  if (isLastPaneForWorkspace && workspaceId != null) {
    return { action: 'prompt-destroy', workspaceId }
  }

  return { action: 'close' }
}

/**
 * Compute whether closing a workspace should proceed immediately or show
 * a confirmation dialog.
 *
 * Uses the hierarchical layout to find all terminals in the workspace's
 * panel tabs and checks if any have running child processes.
 */
function computeCloseWorkspaceAction(
  layout: WindowLayout | undefined,
  workspaceId: string,
  terminals: ReadonlyArray<{
    readonly id: string
    readonly hasChildProcess: boolean
  }>
): 'close' | 'confirm' {
  if (!layout) {
    return 'close'
  }
  const activeTab = getActiveWindowTab(layout)
  if (!activeTab?.workspaceLayout) {
    return 'close'
  }
  const tileLeaves = getWorkspaceTileLeaves(activeTab.workspaceLayout)
  const wsTile = tileLeaves.find((l) => l.workspaceId === workspaceId)
  if (!wsTile) {
    return 'close'
  }
  // Collect all terminal IDs across all panel tabs
  const terminalIds: string[] = []
  for (const pt of wsTile.panelTabs) {
    terminalIds.push(...collectTerminalIds(pt.panelLayout))
  }
  const hasRunning = terminalIds.some((id) => {
    const terminal = terminals.find((t) => t.id === id)
    return terminal?.hasChildProcess === true
  })
  return hasRunning ? 'confirm' : 'close'
}

/**
 * Navigate to a pane in the given direction within the active panel tab's
 * panel tree. Scoped to the workspace containing the active pane.
 *
 * Replaces `findPaneInDirection(layout, activePaneId, direction)` which
 * operated on the flat legacy tree. This version finds the workspace
 * containing the active pane, gets its active panel tab tree, and delegates
 * to `findPaneInDirection` on that tree.
 */
function navigateDirection(
  layout: WindowLayout,
  activePaneId: string,
  direction: 'left' | 'right' | 'up' | 'down'
): string | undefined {
  const activeTab = getActiveWindowTab(layout)
  if (!activeTab?.workspaceLayout) {
    return undefined
  }
  const tileLeaves = getWorkspaceTileLeaves(activeTab.workspaceLayout)
  for (const tileLeaf of tileLeaves) {
    const activePanel = tileLeaf.panelTabs.find(
      (t) => t.id === tileLeaf.activePanelTabId
    )
    const panelTree =
      activePanel?.panelLayout ?? tileLeaf.panelTabs[0]?.panelLayout
    if (!panelTree) {
      continue
    }
    if (containsPane(panelTree, activePaneId)) {
      return findPaneInDirection(panelTree, activePaneId, direction)
    }
  }
  return undefined
}

/** Result of the close-pane gating action. */
type ClosePaneGateResult =
  | { readonly action: 'close' }
  | { readonly action: 'confirm' }
  | { readonly action: 'confirm-with-destroy'; readonly workspaceId: string }
  | { readonly action: 'prompt-destroy'; readonly workspaceId: string }

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  addWindowTab,
  addWorkspaceToTabUnique,
  closeTerminalInWindowLayout,
  collectTerminalIdsFromTileTree,
  computeClosePaneGateAction,
  computeCloseWorkspaceAction,
  computeProgressiveCloseAction,
  decodeWindowLayout,
  findLeafByTerminalIdInLayout,
  findPaneAcrossAllTabs,
  findPaneInActiveTab,
  findTerminalLocation,
  findWorkspaceLocation,
  getActiveTabLeafIds,
  getActiveTabLeafNodes,
  getActiveWindowTab,
  getAllWorkspaceTileLeaves,
  getScopedActivePaneId,
  getStaleTerminalLeavesHierarchical,
  moveWorkspace,
  navigateDirection,
  reconcileWindowLayout,
  removeWindowTab,
  removeWorkspaceFromLayout,
  renameWindowTab,
  reorderWindowTabs,
  resolveActivePaneForPanelTab,
  resolveActivePaneForWindowTab,
  resolveActivePaneFromLeaf,
  resolveActiveWorkspaceId,
  saveFocusedPaneId,
  shouldConfirmClosePanelTab,
  shouldConfirmCloseWindowTab,
  switchWindowTab,
  switchWindowTabByIndex,
  switchWindowTabRelative,
  updateWorkspaceTileLeaf,
  isWorkspaceFrameData,
  WORKSPACE_FRAME_TYPE,
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

export type {
  ClosePaneGateResult,
  ProgressiveCloseAction,
  RepairWindowLayoutResult,
  StaleTerminalLeaf,
  TerminalLocation,
  TerminalProcessInfo,
  WorkspaceLocation,
}
