/**
 * Panel tab layout manipulation utilities.
 *
 * Pure functions that operate on the `WorkspaceTileLeaf` type to support
 * panel tab CRUD operations within a workspace. Each workspace frame has
 * an ordered list of panel tabs, and these utilities manage adding, removing,
 * switching, and reordering those tabs.
 *
 * Panel tabs contain a `PanelTreeNode` split tree (the existing panel split
 * model), so existing split/close/navigate functions continue to work within
 * a tab's content.
 *
 * All functions return a new workspace tile leaf — the original is never mutated.
 *
 * @see packages/shared/src/types.ts — WorkspaceTileLeaf, PanelTab, PanelTreeNode
 * @see apps/web/src/panels/window-tab-utils.ts — window tab CRUD utilities
 * @see apps/web/src/panels/workspace-tile-utils.ts — workspace tile utilities
 */

import type {
  PanelTab,
  PaneType,
  WorkspaceTileLeaf,
} from '@laborer/shared/types'

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

let _counter = 0

/**
 * Generate a unique ID for new panel tab nodes.
 * Uses an incrementing counter with a random suffix to avoid collisions.
 */
function generatePanelTabId(): string {
  _counter += 1
  const random = Math.random().toString(36).slice(2, 8)
  return `panel-tab-${_counter}-${random}`
}

/**
 * Generate a unique ID for new panel leaf nodes.
 */
function generatePaneId(): string {
  _counter += 1
  const random = Math.random().toString(36).slice(2, 8)
  return `pane-${_counter}-${random}`
}

// ---------------------------------------------------------------------------
// Panel tab CRUD
// ---------------------------------------------------------------------------

/**
 * Options for creating a new panel tab.
 */
interface AddPanelTabOptions {
  /** Optional label for the tab */
  readonly label?: string
  /** Optional pre-configured tab to use instead of creating a new one */
  readonly tab?: PanelTab
  /** Optional terminal ID to assign to the pane (for terminal type) */
  readonly terminalId?: string
}

/**
 * Add a new panel tab to a workspace.
 *
 * If `options.tab` is provided, it is appended as-is. Otherwise a new tab
 * is created with a single leaf pane of the specified `panelType`.
 * The new tab becomes the active panel tab.
 *
 * @param workspace - The workspace tile leaf to add the tab to
 * @param panelType - The pane type for the new tab's leaf pane
 * @param options - Optional configuration for the new tab
 * @returns A new WorkspaceTileLeaf with the panel tab appended and active
 */
function addPanelTab(
  workspace: WorkspaceTileLeaf,
  panelType: PaneType,
  options?: AddPanelTabOptions
): WorkspaceTileLeaf {
  const paneId = generatePaneId()
  const newTab: PanelTab = options?.tab ?? {
    id: generatePanelTabId(),
    label: options?.label,
    panelLayout: {
      _tag: 'PanelLeafNode',
      id: paneId,
      paneType: panelType,
      terminalId: options?.terminalId,
      workspaceId: workspace.workspaceId,
    },
    focusedPaneId: paneId,
  }
  return {
    ...workspace,
    panelTabs: [...workspace.panelTabs, newTab],
    activePanelTabId: newTab.id,
  }
}

/**
 * Remove a panel tab by ID from a workspace.
 *
 * If the removed tab was active, the nearest sibling becomes active:
 * - Prefer the tab to the right (next index)
 * - Fall back to the tab to the left (previous index)
 * - If no tabs remain, activePanelTabId becomes undefined
 *
 * @param workspace - The workspace tile leaf to remove the tab from
 * @param tabId - The ID of the panel tab to remove
 * @returns A new WorkspaceTileLeaf without the tab
 */
function removePanelTab(
  workspace: WorkspaceTileLeaf,
  tabId: string
): WorkspaceTileLeaf {
  const index = workspace.panelTabs.findIndex((t) => t.id === tabId)
  if (index === -1) {
    return workspace
  }

  const newTabs = workspace.panelTabs.filter((t) => t.id !== tabId)

  if (newTabs.length === 0) {
    return {
      ...workspace,
      panelTabs: [],
      activePanelTabId: undefined,
    }
  }

  // If the removed tab was not active, keep the current active tab
  if (workspace.activePanelTabId !== tabId) {
    return {
      ...workspace,
      panelTabs: newTabs,
    }
  }

  // Pick nearest sibling: prefer right, fall back to left
  const nextIndex = Math.min(index, newTabs.length - 1)
  return {
    ...workspace,
    panelTabs: newTabs,
    activePanelTabId: newTabs[nextIndex]?.id,
  }
}

/**
 * Switch the active panel tab by ID within a workspace.
 *
 * If the tabId doesn't exist in the workspace's panel tabs, returns the
 * workspace unchanged.
 *
 * @param workspace - The workspace tile leaf
 * @param tabId - The ID of the panel tab to activate
 * @returns A new WorkspaceTileLeaf with the active tab updated
 */
function switchPanelTab(
  workspace: WorkspaceTileLeaf,
  tabId: string
): WorkspaceTileLeaf {
  const exists = workspace.panelTabs.some((t) => t.id === tabId)
  if (!exists) {
    return workspace
  }
  return { ...workspace, activePanelTabId: tabId }
}

/**
 * Switch the active panel tab by 1-based index within a workspace.
 *
 * Indices 1-8 map to tabs at positions 0-7.
 * Index 9 always maps to the last tab.
 * Out-of-range indices return the workspace unchanged.
 *
 * @param workspace - The workspace tile leaf
 * @param index - 1-based tab index (1-8, or 9 for last)
 * @returns A new WorkspaceTileLeaf with the active tab updated
 */
function switchPanelTabByIndex(
  workspace: WorkspaceTileLeaf,
  index: number
): WorkspaceTileLeaf {
  if (workspace.panelTabs.length === 0) {
    return workspace
  }

  // Index 9 = last tab
  if (index === 9) {
    const lastTab = workspace.panelTabs.at(-1)
    return { ...workspace, activePanelTabId: lastTab?.id }
  }

  // Convert 1-based to 0-based
  const zeroIndex = index - 1
  if (zeroIndex < 0 || zeroIndex >= workspace.panelTabs.length) {
    return workspace
  }

  return { ...workspace, activePanelTabId: workspace.panelTabs[zeroIndex]?.id }
}

/**
 * Cycle the active panel tab by a relative delta within a workspace.
 *
 * A delta of +1 moves to the next tab, -1 to the previous tab.
 * Wraps around: moving past the last tab goes to the first, and vice versa.
 *
 * @param workspace - The workspace tile leaf
 * @param delta - Number of positions to move (+1 = next, -1 = previous)
 * @returns A new WorkspaceTileLeaf with the active tab updated
 */
function switchPanelTabRelative(
  workspace: WorkspaceTileLeaf,
  delta: number
): WorkspaceTileLeaf {
  if (workspace.panelTabs.length === 0) {
    return workspace
  }

  const currentIndex = workspace.panelTabs.findIndex(
    (t) => t.id === workspace.activePanelTabId
  )

  // If active tab not found, default to first tab
  if (currentIndex === -1) {
    return { ...workspace, activePanelTabId: workspace.panelTabs[0]?.id }
  }

  const newIndex =
    (((currentIndex + delta) % workspace.panelTabs.length) +
      workspace.panelTabs.length) %
    workspace.panelTabs.length
  return { ...workspace, activePanelTabId: workspace.panelTabs[newIndex]?.id }
}

/**
 * Reorder panel tabs by moving a tab from one index to another within a
 * workspace.
 *
 * Both indices are 0-based. If either index is out of range, returns the
 * workspace unchanged.
 *
 * @param workspace - The workspace tile leaf
 * @param fromIndex - The 0-based index of the tab to move
 * @param toIndex - The 0-based target index
 * @returns A new WorkspaceTileLeaf with panel tabs reordered
 */
function reorderPanelTabs(
  workspace: WorkspaceTileLeaf,
  fromIndex: number,
  toIndex: number
): WorkspaceTileLeaf {
  if (
    fromIndex < 0 ||
    fromIndex >= workspace.panelTabs.length ||
    toIndex < 0 ||
    toIndex >= workspace.panelTabs.length ||
    fromIndex === toIndex
  ) {
    return workspace
  }

  const newTabs = [...workspace.panelTabs]
  const [moved] = newTabs.splice(fromIndex, 1)
  if (moved) {
    newTabs.splice(toIndex, 0, moved)
  }
  return { ...workspace, panelTabs: newTabs }
}

/**
 * Get the active panel tab from a workspace.
 *
 * Returns undefined if the workspace has no panel tabs or the
 * activePanelTabId is invalid.
 *
 * @param workspace - The workspace tile leaf
 * @returns The active PanelTab, or undefined
 */
function getActivePanelTab(workspace: WorkspaceTileLeaf): PanelTab | undefined {
  return workspace.panelTabs.find((t) => t.id === workspace.activePanelTabId)
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  addPanelTab,
  getActivePanelTab,
  removePanelTab,
  reorderPanelTabs,
  switchPanelTab,
  switchPanelTabByIndex,
  switchPanelTabRelative,
}

export type { AddPanelTabOptions }
