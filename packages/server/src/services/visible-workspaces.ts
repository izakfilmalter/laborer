/**
 * visible-workspaces — Server-side helper
 *
 * Extracts the set of workspace IDs that currently have an open panel
 * in any Electron window. Used by polling services (DiffService,
 * PrWatcher) to gate or adjust polling frequency based on visibility.
 *
 * Walks the hierarchical layout tree:
 *   WindowLayout > WindowTab > WorkspaceTileNode > WorkspaceTileLeaf
 *
 * All window tabs are considered (not just the active one), so
 * workspaces in background tabs are still treated as "visible".
 */

import { tables } from '@laborer/shared/schema'
import type {
  WindowLayout,
  WindowTab,
  WorkspaceTileNode,
} from '@laborer/shared/types'
import type { LaborerStore } from './laborer-store.js'

/**
 * Recursively collect workspace IDs from a WorkspaceTileNode tree.
 */
const collectFromTileNode = (
  node: WorkspaceTileNode,
  result: Set<string>
): void => {
  if (node._tag === 'WorkspaceTileLeaf') {
    result.add(node.workspaceId)
  } else {
    for (const child of node.children) {
      collectFromTileNode(child, result)
    }
  }
}

/**
 * Collect all workspace IDs from a WindowTab.
 */
const collectFromTab = (tab: WindowTab, result: Set<string>): void => {
  if (tab.workspaceLayout !== undefined) {
    collectFromTileNode(tab.workspaceLayout, result)
  }
}

/**
 * Collect all workspace IDs from a WindowLayout.
 */
const collectFromLayout = (layout: WindowLayout, result: Set<string>): void => {
  for (const tab of layout.tabs) {
    collectFromTab(tab, result)
  }
}

/**
 * Query the LiveStore panel_layout table and return the set of
 * workspace IDs that are currently visible in any window.
 *
 * Returns an empty set if no windows are open or no layouts exist.
 */
const getVisibleWorkspaceIds = (
  store: LaborerStore['Type']['store']
): ReadonlySet<string> => {
  const result = new Set<string>()
  const rows = store.query(tables.panelLayout)

  for (const row of rows) {
    if (row.windowLayout !== null) {
      collectFromLayout(row.windowLayout, result)
    }
  }

  return result
}

export { getVisibleWorkspaceIds }
