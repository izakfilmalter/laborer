/**
 * Unit tests for window tab layout manipulation utilities.
 *
 * Tests the pure functions in `window-tab-utils.ts` that operate on the
 * WindowLayout type for window tab CRUD, workspace location lookups,
 * and terminal navigation across the hierarchical layout tree.
 *
 * @see apps/web/src/panels/window-tab-utils.ts
 */

import type {
  PanelLeafNode,
  PanelSplitNode,
  PanelTab,
  WindowLayout,
  WindowTab,
  WorkspaceTileLeaf,
  WorkspaceTileNode,
  WorkspaceTileSplit,
} from '@laborer/shared/types'
import { describe, expect, it } from 'vitest'
import {
  addWindowTab,
  computeClosePaneGateActionHierarchical,
  computeCloseWorkspaceActionHierarchical,
  computeResizePanelTree,
  findEmptyPanelTreeLeaf,
  findNewPanelTreeLeaf,
  findPaneInWindowLayout,
  findPanelTreeRootForPane,
  findSiblingPaneIdInPanelTree,
  findTerminalLocation,
  findWorkspaceLocation,
  getActiveWindowTab,
  getAllWorkspaceTileLeaves,
  getLastPanelTreeLeafId,
  getWorkspaceTileLeaves,
  removeWindowTab,
  reorderWindowTabs,
  splitPaneInPanelTree,
  switchWindowTab,
  switchWindowTabByIndex,
  switchWindowTabRelative,
} from '../src/panels/window-tab-utils'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** A panel leaf node for use in fixtures. */
function makeLeaf(
  id: string,
  terminalId?: string,
  workspaceId?: string
): PanelLeafNode {
  return {
    _tag: 'PanelLeafNode',
    id,
    paneType: 'terminal',
    terminalId,
    workspaceId,
  }
}

/** A panel tab wrapping a single leaf. */
function makePanelTab(
  id: string,
  leaf: PanelLeafNode,
  focusedPaneId?: string
): PanelTab {
  return {
    id,
    panelLayout: leaf,
    focusedPaneId: focusedPaneId ?? leaf.id,
  }
}

/** A workspace tile leaf with panel tabs. */
function makeWorkspaceTile(
  id: string,
  workspaceId: string,
  panelTabs: PanelTab[],
  activePanelTabId?: string
): WorkspaceTileLeaf {
  return {
    _tag: 'WorkspaceTileLeaf',
    id,
    workspaceId,
    panelTabs,
    activePanelTabId: activePanelTabId ?? panelTabs[0]?.id,
  }
}

/** An empty window tab with no workspace layout. */
function makeEmptyTab(id: string, label?: string): WindowTab {
  return { id, label }
}

/**
 * A window tab with a single workspace containing a single terminal pane.
 *
 * Tab
 *  └─ Workspace (workspaceId)
 *      └─ PanelTab
 *          └─ Terminal Pane (terminalId)
 */
function makeTabWithWorkspace(
  tabId: string,
  workspaceId: string,
  terminalId: string
): WindowTab {
  const leaf = makeLeaf(`pane-${terminalId}`, terminalId, workspaceId)
  const panelTab = makePanelTab(`pt-${terminalId}`, leaf)
  const tile = makeWorkspaceTile(`tile-${workspaceId}`, workspaceId, [panelTab])
  return { id: tabId, workspaceLayout: tile }
}

/** Empty layout — no tabs at all. */
const emptyLayout: WindowLayout = { tabs: [] }

/** Single-tab layout with one workspace. */
const singleTabLayout: WindowLayout = {
  tabs: [makeTabWithWorkspace('tab-1', 'ws-1', 'term-1')],
  activeTabId: 'tab-1',
}

/**
 * Multi-tab layout:
 * - Tab 1: workspace ws-1 with terminal term-1
 * - Tab 2: workspace ws-2 with terminal term-2
 * - Tab 3: workspace ws-3 with terminal term-3
 */
const multiTabLayout: WindowLayout = {
  tabs: [
    makeTabWithWorkspace('tab-1', 'ws-1', 'term-1'),
    makeTabWithWorkspace('tab-2', 'ws-2', 'term-2'),
    makeTabWithWorkspace('tab-3', 'ws-3', 'term-3'),
  ],
  activeTabId: 'tab-2',
}

/**
 * Complex layout with nested workspace tiles and multiple panel tabs:
 *
 * Tab 1:
 *  └─ H-Split
 *      ├─ Workspace ws-A (terminal term-A1, term-A2 in separate panel tabs)
 *      └─ Workspace ws-B (terminal term-B1)
 *
 * Tab 2:
 *  └─ Workspace ws-C (terminal term-C1)
 */
const complexLayout: WindowLayout = (() => {
  const leafA1 = makeLeaf('pane-A1', 'term-A1', 'ws-A')
  const leafA2 = makeLeaf('pane-A2', 'term-A2', 'ws-A')
  const ptA1 = makePanelTab('pt-A1', leafA1)
  const ptA2 = makePanelTab('pt-A2', leafA2)
  const tileA = makeWorkspaceTile('tile-A', 'ws-A', [ptA1, ptA2], 'pt-A1')

  const leafB1 = makeLeaf('pane-B1', 'term-B1', 'ws-B')
  const ptB1 = makePanelTab('pt-B1', leafB1)
  const tileB = makeWorkspaceTile('tile-B', 'ws-B', [ptB1])

  const split: WorkspaceTileSplit = {
    _tag: 'WorkspaceTileSplit',
    id: 'split-AB',
    direction: 'horizontal',
    children: [tileA, tileB],
    sizes: [50, 50],
  }

  const tab1: WindowTab = { id: 'tab-1', workspaceLayout: split }
  const tab2 = makeTabWithWorkspace('tab-2', 'ws-C', 'term-C1')

  return { tabs: [tab1, tab2], activeTabId: 'tab-1' }
})()

// ---------------------------------------------------------------------------
// addWindowTab
// ---------------------------------------------------------------------------

describe('addWindowTab', () => {
  it('adds an empty tab to an empty layout', () => {
    const result = addWindowTab(emptyLayout)
    expect(result.tabs).toHaveLength(1)
    expect(result.activeTabId).toBe(result.tabs[0]?.id)
    expect(result.tabs[0]?.workspaceLayout).toBeUndefined()
  })

  it('appends a tab and makes it active', () => {
    const result = addWindowTab(singleTabLayout)
    expect(result.tabs).toHaveLength(2)
    expect(result.tabs[0]?.id).toBe('tab-1')
    expect(result.activeTabId).toBe(result.tabs[1]?.id)
    // New tab should be different from existing
    expect(result.tabs[1]?.id).not.toBe('tab-1')
  })

  it('accepts a pre-configured tab', () => {
    const customTab: WindowTab = {
      id: 'custom-tab',
      label: 'My Tab',
    }
    const result = addWindowTab(singleTabLayout, customTab)
    expect(result.tabs).toHaveLength(2)
    expect(result.tabs[1]).toBe(customTab)
    expect(result.activeTabId).toBe('custom-tab')
  })

  it('does not mutate the original layout', () => {
    const original = { ...singleTabLayout, tabs: [...singleTabLayout.tabs] }
    addWindowTab(singleTabLayout)
    expect(singleTabLayout.tabs).toHaveLength(1)
    expect(singleTabLayout).toEqual(original)
  })
})

// ---------------------------------------------------------------------------
// removeWindowTab
// ---------------------------------------------------------------------------

describe('removeWindowTab', () => {
  it('returns layout unchanged when tabId not found', () => {
    const result = removeWindowTab(multiTabLayout, 'nonexistent')
    expect(result).toBe(multiTabLayout)
  })

  it('removes the only tab, leaving empty layout', () => {
    const result = removeWindowTab(singleTabLayout, 'tab-1')
    expect(result.tabs).toHaveLength(0)
    expect(result.activeTabId).toBeUndefined()
  })

  it('removes a non-active tab, keeping active unchanged', () => {
    const result = removeWindowTab(multiTabLayout, 'tab-1')
    expect(result.tabs).toHaveLength(2)
    expect(result.tabs.map((t) => t.id)).toEqual(['tab-2', 'tab-3'])
    expect(result.activeTabId).toBe('tab-2')
  })

  it('removes the active middle tab, activates the next tab', () => {
    const result = removeWindowTab(multiTabLayout, 'tab-2')
    expect(result.tabs).toHaveLength(2)
    expect(result.tabs.map((t) => t.id)).toEqual(['tab-1', 'tab-3'])
    // tab-2 was at index 1, next tab (tab-3) is now at index 1
    expect(result.activeTabId).toBe('tab-3')
  })

  it('removes the active last tab, activates the previous tab', () => {
    const layout: WindowLayout = { ...multiTabLayout, activeTabId: 'tab-3' }
    const result = removeWindowTab(layout, 'tab-3')
    expect(result.tabs).toHaveLength(2)
    // tab-3 was at index 2, no next → fall back to index 1 (tab-2)
    expect(result.activeTabId).toBe('tab-2')
  })

  it('removes the active first tab, activates the next tab', () => {
    const layout: WindowLayout = { ...multiTabLayout, activeTabId: 'tab-1' }
    const result = removeWindowTab(layout, 'tab-1')
    expect(result.tabs).toHaveLength(2)
    // tab-1 was at index 0, next tab is tab-2 at index 0
    expect(result.activeTabId).toBe('tab-2')
  })

  it('does not mutate the original layout', () => {
    const original = { ...multiTabLayout, tabs: [...multiTabLayout.tabs] }
    removeWindowTab(multiTabLayout, 'tab-2')
    expect(multiTabLayout.tabs).toHaveLength(3)
    expect(multiTabLayout).toEqual(original)
  })
})

// ---------------------------------------------------------------------------
// switchWindowTab
// ---------------------------------------------------------------------------

describe('switchWindowTab', () => {
  it('switches to an existing tab', () => {
    const result = switchWindowTab(multiTabLayout, 'tab-3')
    expect(result.activeTabId).toBe('tab-3')
    expect(result.tabs).toBe(multiTabLayout.tabs) // tabs array unchanged
  })

  it('returns layout unchanged when tabId not found', () => {
    const result = switchWindowTab(multiTabLayout, 'nonexistent')
    expect(result).toBe(multiTabLayout)
  })

  it('returns layout unchanged when already on that tab', () => {
    const result = switchWindowTab(multiTabLayout, 'tab-2')
    // Should still return a new object since activeTabId matches
    expect(result.activeTabId).toBe('tab-2')
  })
})

// ---------------------------------------------------------------------------
// switchWindowTabByIndex
// ---------------------------------------------------------------------------

describe('switchWindowTabByIndex', () => {
  it('switches to tab at index 1 (first tab)', () => {
    const result = switchWindowTabByIndex(multiTabLayout, 1)
    expect(result.activeTabId).toBe('tab-1')
  })

  it('switches to tab at index 2 (second tab)', () => {
    const result = switchWindowTabByIndex(multiTabLayout, 2)
    expect(result.activeTabId).toBe('tab-2')
  })

  it('switches to tab at index 3 (third tab)', () => {
    const result = switchWindowTabByIndex(multiTabLayout, 3)
    expect(result.activeTabId).toBe('tab-3')
  })

  it('index 9 switches to the last tab', () => {
    const result = switchWindowTabByIndex(multiTabLayout, 9)
    expect(result.activeTabId).toBe('tab-3')
  })

  it('index 9 on single tab switches to that tab', () => {
    const result = switchWindowTabByIndex(singleTabLayout, 9)
    expect(result.activeTabId).toBe('tab-1')
  })

  it('returns layout unchanged for out-of-range index', () => {
    const result = switchWindowTabByIndex(multiTabLayout, 5)
    expect(result).toBe(multiTabLayout)
  })

  it('returns layout unchanged for index 0', () => {
    const result = switchWindowTabByIndex(multiTabLayout, 0)
    expect(result).toBe(multiTabLayout)
  })

  it('returns layout unchanged for negative index', () => {
    const result = switchWindowTabByIndex(multiTabLayout, -1)
    expect(result).toBe(multiTabLayout)
  })

  it('returns layout unchanged for empty layout', () => {
    const result = switchWindowTabByIndex(emptyLayout, 1)
    expect(result).toBe(emptyLayout)
  })
})

// ---------------------------------------------------------------------------
// switchWindowTabRelative
// ---------------------------------------------------------------------------

describe('switchWindowTabRelative', () => {
  it('moves to next tab with delta +1', () => {
    const result = switchWindowTabRelative(multiTabLayout, 1)
    expect(result.activeTabId).toBe('tab-3') // tab-2 -> tab-3
  })

  it('moves to previous tab with delta -1', () => {
    const result = switchWindowTabRelative(multiTabLayout, -1)
    expect(result.activeTabId).toBe('tab-1') // tab-2 -> tab-1
  })

  it('wraps around from last to first with delta +1', () => {
    const layout: WindowLayout = { ...multiTabLayout, activeTabId: 'tab-3' }
    const result = switchWindowTabRelative(layout, 1)
    expect(result.activeTabId).toBe('tab-1')
  })

  it('wraps around from first to last with delta -1', () => {
    const layout: WindowLayout = { ...multiTabLayout, activeTabId: 'tab-1' }
    const result = switchWindowTabRelative(layout, -1)
    expect(result.activeTabId).toBe('tab-3')
  })

  it('returns to same tab when only one tab exists', () => {
    const result = switchWindowTabRelative(singleTabLayout, 1)
    expect(result.activeTabId).toBe('tab-1')
  })

  it('returns layout unchanged for empty layout', () => {
    const result = switchWindowTabRelative(emptyLayout, 1)
    expect(result).toBe(emptyLayout)
  })

  it('handles delta > 1 (skip tabs)', () => {
    const layout: WindowLayout = { ...multiTabLayout, activeTabId: 'tab-1' }
    const result = switchWindowTabRelative(layout, 2)
    expect(result.activeTabId).toBe('tab-3')
  })

  it('defaults to first tab when activeTabId is invalid', () => {
    const layout: WindowLayout = {
      ...multiTabLayout,
      activeTabId: 'nonexistent',
    }
    const result = switchWindowTabRelative(layout, 1)
    expect(result.activeTabId).toBe('tab-1')
  })
})

// ---------------------------------------------------------------------------
// reorderWindowTabs
// ---------------------------------------------------------------------------

describe('reorderWindowTabs', () => {
  it('moves a tab from index 0 to index 2', () => {
    const result = reorderWindowTabs(multiTabLayout, 0, 2)
    expect(result.tabs.map((t) => t.id)).toEqual(['tab-2', 'tab-3', 'tab-1'])
    expect(result.activeTabId).toBe('tab-2') // active tab unchanged
  })

  it('moves a tab from index 2 to index 0', () => {
    const result = reorderWindowTabs(multiTabLayout, 2, 0)
    expect(result.tabs.map((t) => t.id)).toEqual(['tab-3', 'tab-1', 'tab-2'])
  })

  it('returns layout unchanged when fromIndex equals toIndex', () => {
    const result = reorderWindowTabs(multiTabLayout, 1, 1)
    expect(result).toBe(multiTabLayout)
  })

  it('returns layout unchanged for out-of-range fromIndex', () => {
    const result = reorderWindowTabs(multiTabLayout, -1, 1)
    expect(result).toBe(multiTabLayout)
  })

  it('returns layout unchanged for out-of-range toIndex', () => {
    const result = reorderWindowTabs(multiTabLayout, 0, 5)
    expect(result).toBe(multiTabLayout)
  })

  it('preserves activeTabId', () => {
    const result = reorderWindowTabs(multiTabLayout, 0, 2)
    expect(result.activeTabId).toBe(multiTabLayout.activeTabId)
  })

  it('does not mutate the original layout', () => {
    const originalIds = multiTabLayout.tabs.map((t) => t.id)
    reorderWindowTabs(multiTabLayout, 0, 2)
    expect(multiTabLayout.tabs.map((t) => t.id)).toEqual(originalIds)
  })
})

// ---------------------------------------------------------------------------
// findWorkspaceLocation
// ---------------------------------------------------------------------------

describe('findWorkspaceLocation', () => {
  it('finds a workspace in a single-tab layout', () => {
    const result = findWorkspaceLocation(singleTabLayout, 'ws-1')
    expect(result).toEqual({ tabId: 'tab-1', tileId: 'tile-ws-1' })
  })

  it('finds a workspace in the correct tab of a multi-tab layout', () => {
    const result = findWorkspaceLocation(multiTabLayout, 'ws-2')
    expect(result).toEqual({ tabId: 'tab-2', tileId: 'tile-ws-2' })
  })

  it('finds a workspace in a nested tile tree (complex layout)', () => {
    const result = findWorkspaceLocation(complexLayout, 'ws-B')
    expect(result).toEqual({ tabId: 'tab-1', tileId: 'tile-B' })
  })

  it('finds a workspace in the second tab of complex layout', () => {
    const result = findWorkspaceLocation(complexLayout, 'ws-C')
    expect(result).toEqual({ tabId: 'tab-2', tileId: 'tile-ws-C' })
  })

  it('returns undefined when workspace not found', () => {
    const result = findWorkspaceLocation(multiTabLayout, 'nonexistent')
    expect(result).toBeUndefined()
  })

  it('returns undefined for empty layout', () => {
    const result = findWorkspaceLocation(emptyLayout, 'ws-1')
    expect(result).toBeUndefined()
  })

  it('handles tabs with no workspace layout', () => {
    const layout: WindowLayout = {
      tabs: [makeEmptyTab('tab-empty')],
      activeTabId: 'tab-empty',
    }
    const result = findWorkspaceLocation(layout, 'ws-1')
    expect(result).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// findTerminalLocation
// ---------------------------------------------------------------------------

describe('findTerminalLocation', () => {
  it('finds a terminal in a single-tab layout', () => {
    const result = findTerminalLocation(singleTabLayout, 'term-1')
    expect(result).toEqual({
      tabId: 'tab-1',
      tileId: 'tile-ws-1',
      workspaceId: 'ws-1',
      panelTabId: 'pt-term-1',
      paneId: 'pane-term-1',
    })
  })

  it('finds a terminal in the correct tab of multi-tab layout', () => {
    const result = findTerminalLocation(multiTabLayout, 'term-3')
    expect(result).toEqual({
      tabId: 'tab-3',
      tileId: 'tile-ws-3',
      workspaceId: 'ws-3',
      panelTabId: 'pt-term-3',
      paneId: 'pane-term-3',
    })
  })

  it('finds a terminal in a nested workspace tile (complex layout)', () => {
    const result = findTerminalLocation(complexLayout, 'term-B1')
    expect(result).toEqual({
      tabId: 'tab-1',
      tileId: 'tile-B',
      workspaceId: 'ws-B',
      panelTabId: 'pt-B1',
      paneId: 'pane-B1',
    })
  })

  it('finds a terminal in a non-active panel tab (complex layout)', () => {
    const result = findTerminalLocation(complexLayout, 'term-A2')
    expect(result).toEqual({
      tabId: 'tab-1',
      tileId: 'tile-A',
      workspaceId: 'ws-A',
      panelTabId: 'pt-A2',
      paneId: 'pane-A2',
    })
  })

  it('finds a terminal in the second tab (complex layout)', () => {
    const result = findTerminalLocation(complexLayout, 'term-C1')
    expect(result).toEqual({
      tabId: 'tab-2',
      tileId: 'tile-ws-C',
      workspaceId: 'ws-C',
      panelTabId: 'pt-term-C1',
      paneId: 'pane-term-C1',
    })
  })

  it('returns undefined when terminal not found', () => {
    const result = findTerminalLocation(multiTabLayout, 'nonexistent')
    expect(result).toBeUndefined()
  })

  it('returns undefined for empty layout', () => {
    const result = findTerminalLocation(emptyLayout, 'term-1')
    expect(result).toBeUndefined()
  })

  it('handles tabs with no workspace layout', () => {
    const layout: WindowLayout = {
      tabs: [makeEmptyTab('tab-empty')],
      activeTabId: 'tab-empty',
    }
    const result = findTerminalLocation(layout, 'term-1')
    expect(result).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// getWorkspaceTileLeaves
// ---------------------------------------------------------------------------

describe('getWorkspaceTileLeaves', () => {
  it('returns a single leaf from a leaf node', () => {
    const tile = makeWorkspaceTile('tile-1', 'ws-1', [])
    const result = getWorkspaceTileLeaves(tile)
    expect(result).toHaveLength(1)
    expect(result[0]?.workspaceId).toBe('ws-1')
  })

  it('returns all leaves from a split', () => {
    const split: WorkspaceTileNode = {
      _tag: 'WorkspaceTileSplit',
      id: 'split-1',
      direction: 'horizontal',
      children: [
        makeWorkspaceTile('tile-1', 'ws-1', []),
        makeWorkspaceTile('tile-2', 'ws-2', []),
      ],
      sizes: [50, 50],
    }
    const result = getWorkspaceTileLeaves(split)
    expect(result).toHaveLength(2)
    expect(result.map((l) => l.workspaceId)).toEqual(['ws-1', 'ws-2'])
  })

  it('returns all leaves from a nested split', () => {
    const split: WorkspaceTileNode = {
      _tag: 'WorkspaceTileSplit',
      id: 'split-1',
      direction: 'horizontal',
      children: [
        makeWorkspaceTile('tile-1', 'ws-1', []),
        {
          _tag: 'WorkspaceTileSplit',
          id: 'split-2',
          direction: 'vertical',
          children: [
            makeWorkspaceTile('tile-2', 'ws-2', []),
            makeWorkspaceTile('tile-3', 'ws-3', []),
          ],
          sizes: [50, 50],
        },
      ],
      sizes: [50, 50],
    }
    const result = getWorkspaceTileLeaves(split)
    expect(result).toHaveLength(3)
    expect(result.map((l) => l.workspaceId)).toEqual(['ws-1', 'ws-2', 'ws-3'])
  })
})

// ---------------------------------------------------------------------------
// getAllWorkspaceTileLeaves
// ---------------------------------------------------------------------------

describe('getAllWorkspaceTileLeaves', () => {
  it('returns empty array for empty layout', () => {
    const result = getAllWorkspaceTileLeaves(emptyLayout)
    expect(result).toEqual([])
  })

  it('returns all workspace tiles across tabs', () => {
    const result = getAllWorkspaceTileLeaves(multiTabLayout)
    expect(result).toHaveLength(3)
    expect(result.map((l) => l.workspaceId)).toEqual(['ws-1', 'ws-2', 'ws-3'])
  })

  it('returns all workspace tiles from complex layout', () => {
    const result = getAllWorkspaceTileLeaves(complexLayout)
    expect(result).toHaveLength(3)
    expect(result.map((l) => l.workspaceId)).toEqual(['ws-A', 'ws-B', 'ws-C'])
  })

  it('skips tabs with no workspace layout', () => {
    const layout: WindowLayout = {
      tabs: [
        makeEmptyTab('tab-empty'),
        makeTabWithWorkspace('tab-1', 'ws-1', 'term-1'),
      ],
      activeTabId: 'tab-1',
    }
    const result = getAllWorkspaceTileLeaves(layout)
    expect(result).toHaveLength(1)
    expect(result[0]?.workspaceId).toBe('ws-1')
  })
})

// ---------------------------------------------------------------------------
// getActiveWindowTab
// ---------------------------------------------------------------------------

describe('getActiveWindowTab', () => {
  it('returns the active tab', () => {
    const result = getActiveWindowTab(multiTabLayout)
    expect(result?.id).toBe('tab-2')
  })

  it('returns undefined for empty layout', () => {
    const result = getActiveWindowTab(emptyLayout)
    expect(result).toBeUndefined()
  })

  it('returns undefined when activeTabId is invalid', () => {
    const layout: WindowLayout = {
      ...multiTabLayout,
      activeTabId: 'nonexistent',
    }
    const result = getActiveWindowTab(layout)
    expect(result).toBeUndefined()
  })

  it('returns undefined when activeTabId is undefined', () => {
    const layout: WindowLayout = { tabs: multiTabLayout.tabs }
    const result = getActiveWindowTab(layout)
    expect(result).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Edge cases: combined operations
// ---------------------------------------------------------------------------

describe('combined operations', () => {
  it('add then remove returns to original tab count', () => {
    const afterAdd = addWindowTab(singleTabLayout)
    const newTabId = afterAdd.tabs[1]?.id ?? ''
    const afterRemove = removeWindowTab(afterAdd, newTabId)
    expect(afterRemove.tabs).toHaveLength(1)
    expect(afterRemove.tabs[0]?.id).toBe('tab-1')
    expect(afterRemove.activeTabId).toBe('tab-1')
  })

  it('add then switch then remove switches back correctly', () => {
    const afterAdd = addWindowTab(multiTabLayout)
    const newTabId = afterAdd.activeTabId ?? ''
    // Switch back to original
    const afterSwitch = switchWindowTab(afterAdd, 'tab-2')
    expect(afterSwitch.activeTabId).toBe('tab-2')
    // Remove the new tab
    const afterRemove = removeWindowTab(afterSwitch, newTabId)
    expect(afterRemove.tabs).toHaveLength(3)
    expect(afterRemove.activeTabId).toBe('tab-2')
  })

  it('reorder then switchByIndex finds the moved tab', () => {
    // Move tab-1 from index 0 to index 2
    const reordered = reorderWindowTabs(multiTabLayout, 0, 2)
    // Tab order is now: tab-2, tab-3, tab-1
    const switched = switchWindowTabByIndex(reordered, 3)
    expect(switched.activeTabId).toBe('tab-1')
  })
})

// ---------------------------------------------------------------------------
// splitPaneInPanelTree
// ---------------------------------------------------------------------------

describe('splitPaneInPanelTree', () => {
  it('wraps a leaf in a split with a new sibling', () => {
    const leaf = makeLeaf('pane-1', 'term-1', 'ws-1')
    const result = splitPaneInPanelTree(leaf, 'pane-1', 'horizontal')
    expect(result._tag).toBe('PanelSplitNode')
    const split = result as PanelSplitNode
    expect(split.direction).toBe('horizontal')
    expect(split.children).toHaveLength(2)
    expect(split.children[0]).toBe(leaf)
    expect(split.children[1]?._tag).toBe('PanelLeafNode')
    expect(split.sizes).toEqual([50, 50])
  })

  it('new pane inherits workspaceId from target', () => {
    const leaf = makeLeaf('pane-1', 'term-1', 'ws-1')
    const result = splitPaneInPanelTree(leaf, 'pane-1', 'vertical')
    const split = result as PanelSplitNode
    const newLeaf = split.children[1]
    expect(newLeaf?._tag).toBe('PanelLeafNode')
    if (newLeaf?._tag === 'PanelLeafNode') {
      expect(newLeaf.workspaceId).toBe('ws-1')
      expect(newLeaf.paneType).toBe('terminal')
    }
  })

  it('respects newPaneContent overrides', () => {
    const leaf = makeLeaf('pane-1', 'term-1', 'ws-1')
    const result = splitPaneInPanelTree(leaf, 'pane-1', 'horizontal', {
      paneType: 'agent',
      workspaceId: 'ws-2',
    })
    const split = result as PanelSplitNode
    const newLeaf = split.children[1]
    if (newLeaf?._tag === 'PanelLeafNode') {
      expect(newLeaf.paneType).toBe('agent')
      expect(newLeaf.workspaceId).toBe('ws-2')
    }
  })

  it('inserts adjacent when direction matches parent split', () => {
    const leaf1 = makeLeaf('pane-1', 'term-1', 'ws-1')
    const leaf2 = makeLeaf('pane-2', 'term-2', 'ws-1')
    const split: PanelSplitNode = {
      _tag: 'PanelSplitNode',
      id: 'split-1',
      direction: 'horizontal',
      children: [leaf1, leaf2],
      sizes: [50, 50],
    }
    // Split pane-1 horizontally — should insert adjacent, not nest
    const result = splitPaneInPanelTree(split, 'pane-1', 'horizontal')
    expect(result._tag).toBe('PanelSplitNode')
    const resultSplit = result as PanelSplitNode
    expect(resultSplit.children).toHaveLength(3)
    expect(resultSplit.children[0]?.id).toBe('pane-1')
    expect(resultSplit.children[1]?._tag).toBe('PanelLeafNode')
    expect(resultSplit.children[2]?.id).toBe('pane-2')
    // Equal sizes for 3 children
    const expectedSize = 100 / 3
    for (const size of resultSplit.sizes) {
      expect(size).toBeCloseTo(expectedSize)
    }
  })

  it('nests when direction differs from parent split', () => {
    const leaf1 = makeLeaf('pane-1', 'term-1', 'ws-1')
    const leaf2 = makeLeaf('pane-2', 'term-2', 'ws-1')
    const split: PanelSplitNode = {
      _tag: 'PanelSplitNode',
      id: 'split-1',
      direction: 'horizontal',
      children: [leaf1, leaf2],
      sizes: [50, 50],
    }
    // Split pane-1 vertically — should nest since parent is horizontal
    const result = splitPaneInPanelTree(split, 'pane-1', 'vertical')
    expect(result._tag).toBe('PanelSplitNode')
    const resultSplit = result as PanelSplitNode
    // Parent still has 2 children
    expect(resultSplit.children).toHaveLength(2)
    // First child is now a vertical split
    expect(resultSplit.children[0]?._tag).toBe('PanelSplitNode')
    const nestedSplit = resultSplit.children[0] as PanelSplitNode
    expect(nestedSplit.direction).toBe('vertical')
    expect(nestedSplit.children).toHaveLength(2)
    expect(nestedSplit.children[0]).toBe(leaf1)
  })

  it('returns unchanged tree when pane not found', () => {
    const leaf = makeLeaf('pane-1', 'term-1', 'ws-1')
    const result = splitPaneInPanelTree(leaf, 'nonexistent', 'horizontal')
    expect(result).toBe(leaf)
  })
})

// ---------------------------------------------------------------------------
// findNewPanelTreeLeaf
// ---------------------------------------------------------------------------

describe('findNewPanelTreeLeaf', () => {
  it('finds the new leaf after a split', () => {
    const leaf = makeLeaf('pane-1', 'term-1', 'ws-1')
    const after = splitPaneInPanelTree(leaf, 'pane-1', 'horizontal')
    const newLeaf = findNewPanelTreeLeaf(leaf, after)
    expect(newLeaf).toBeDefined()
    expect(newLeaf?.id).not.toBe('pane-1')
    expect(newLeaf?._tag).toBe('PanelLeafNode')
  })

  it('returns undefined when trees are identical', () => {
    const leaf = makeLeaf('pane-1', 'term-1', 'ws-1')
    const result = findNewPanelTreeLeaf(leaf, leaf)
    expect(result).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// findSiblingPaneIdInPanelTree
// ---------------------------------------------------------------------------

describe('findSiblingPaneIdInPanelTree', () => {
  it('returns sibling after target in a split', () => {
    const leaf1 = makeLeaf('pane-1', 'term-1', 'ws-1')
    const leaf2 = makeLeaf('pane-2', 'term-2', 'ws-1')
    const split: PanelSplitNode = {
      _tag: 'PanelSplitNode',
      id: 'split-1',
      direction: 'horizontal',
      children: [leaf1, leaf2],
      sizes: [50, 50],
    }
    expect(findSiblingPaneIdInPanelTree(split, 'pane-1')).toBe('pane-2')
  })

  it('returns sibling before target when target is last', () => {
    const leaf1 = makeLeaf('pane-1', 'term-1', 'ws-1')
    const leaf2 = makeLeaf('pane-2', 'term-2', 'ws-1')
    const split: PanelSplitNode = {
      _tag: 'PanelSplitNode',
      id: 'split-1',
      direction: 'horizontal',
      children: [leaf1, leaf2],
      sizes: [50, 50],
    }
    expect(findSiblingPaneIdInPanelTree(split, 'pane-2')).toBe('pane-1')
  })

  it('returns undefined for a single leaf', () => {
    const leaf = makeLeaf('pane-1', 'term-1', 'ws-1')
    expect(findSiblingPaneIdInPanelTree(leaf, 'pane-1')).toBeUndefined()
  })

  it('finds sibling in nested tree', () => {
    const leaf1 = makeLeaf('pane-1', 'term-1', 'ws-1')
    const leaf2 = makeLeaf('pane-2', 'term-2', 'ws-1')
    const leaf3 = makeLeaf('pane-3', 'term-3', 'ws-1')
    const innerSplit: PanelSplitNode = {
      _tag: 'PanelSplitNode',
      id: 'split-inner',
      direction: 'vertical',
      children: [leaf1, leaf2],
      sizes: [50, 50],
    }
    const outerSplit: PanelSplitNode = {
      _tag: 'PanelSplitNode',
      id: 'split-outer',
      direction: 'horizontal',
      children: [innerSplit, leaf3],
      sizes: [50, 50],
    }
    // pane-1's sibling within the inner split is pane-2
    expect(findSiblingPaneIdInPanelTree(outerSplit, 'pane-1')).toBe('pane-2')
  })
})

// ---------------------------------------------------------------------------
// getLastPanelTreeLeafId
// ---------------------------------------------------------------------------

describe('getLastPanelTreeLeafId', () => {
  it('returns the ID of a single leaf', () => {
    const leaf: PanelLeafNode = {
      _tag: 'PanelLeafNode',
      id: 'pane-only',
      paneType: 'terminal',
      terminalId: 'term-1',
      workspaceId: 'ws-1',
    }
    expect(getLastPanelTreeLeafId(leaf)).toBe('pane-only')
  })

  it('returns the last leaf in DFS order for a flat split', () => {
    const leaf1: PanelLeafNode = {
      _tag: 'PanelLeafNode',
      id: 'pane-1',
      paneType: 'terminal',
      workspaceId: 'ws-1',
    }
    const leaf2: PanelLeafNode = {
      _tag: 'PanelLeafNode',
      id: 'pane-2',
      paneType: 'terminal',
      workspaceId: 'ws-1',
    }
    const split: PanelSplitNode = {
      _tag: 'PanelSplitNode',
      id: 'split-root',
      direction: 'horizontal',
      children: [leaf1, leaf2],
      sizes: [50, 50],
    }
    expect(getLastPanelTreeLeafId(split)).toBe('pane-2')
  })

  it('returns the rightmost leaf in a nested tree', () => {
    const leaf1: PanelLeafNode = {
      _tag: 'PanelLeafNode',
      id: 'pane-1',
      paneType: 'terminal',
      workspaceId: 'ws-1',
    }
    const leaf2: PanelLeafNode = {
      _tag: 'PanelLeafNode',
      id: 'pane-2',
      paneType: 'terminal',
      workspaceId: 'ws-1',
    }
    const leaf3: PanelLeafNode = {
      _tag: 'PanelLeafNode',
      id: 'pane-3',
      paneType: 'terminal',
      workspaceId: 'ws-1',
    }
    const innerSplit: PanelSplitNode = {
      _tag: 'PanelSplitNode',
      id: 'split-inner',
      direction: 'vertical',
      children: [leaf1, leaf2],
      sizes: [50, 50],
    }
    const outerSplit: PanelSplitNode = {
      _tag: 'PanelSplitNode',
      id: 'split-outer',
      direction: 'horizontal',
      children: [innerSplit, leaf3],
      sizes: [50, 50],
    }
    expect(getLastPanelTreeLeafId(outerSplit)).toBe('pane-3')
  })
})

// ---------------------------------------------------------------------------
// findEmptyPanelTreeLeaf
// ---------------------------------------------------------------------------

describe('findEmptyPanelTreeLeaf', () => {
  it('returns undefined for a leaf with a terminal assigned', () => {
    const leaf: PanelLeafNode = {
      _tag: 'PanelLeafNode',
      id: 'pane-1',
      paneType: 'terminal',
      terminalId: 'term-1',
      workspaceId: 'ws-1',
    }
    expect(findEmptyPanelTreeLeaf(leaf)).toBeUndefined()
  })

  it('returns the leaf if it has no terminalId', () => {
    const leaf: PanelLeafNode = {
      _tag: 'PanelLeafNode',
      id: 'pane-empty',
      paneType: 'terminal',
      workspaceId: 'ws-1',
    }
    expect(findEmptyPanelTreeLeaf(leaf)).toBe(leaf)
  })

  it('returns undefined for a non-terminal pane type', () => {
    const leaf: PanelLeafNode = {
      _tag: 'PanelLeafNode',
      id: 'pane-agent',
      paneType: 'agent',
      workspaceId: 'ws-1',
    }
    expect(findEmptyPanelTreeLeaf(leaf)).toBeUndefined()
  })

  it('finds the first empty terminal pane in a split tree', () => {
    const occupiedLeaf: PanelLeafNode = {
      _tag: 'PanelLeafNode',
      id: 'pane-1',
      paneType: 'terminal',
      terminalId: 'term-1',
      workspaceId: 'ws-1',
    }
    const emptyLeaf: PanelLeafNode = {
      _tag: 'PanelLeafNode',
      id: 'pane-empty',
      paneType: 'terminal',
      workspaceId: 'ws-1',
    }
    const split: PanelSplitNode = {
      _tag: 'PanelSplitNode',
      id: 'split-root',
      direction: 'horizontal',
      children: [occupiedLeaf, emptyLeaf],
      sizes: [50, 50],
    }
    expect(findEmptyPanelTreeLeaf(split)).toBe(emptyLeaf)
  })

  it('returns undefined when all panes are occupied', () => {
    const leaf1: PanelLeafNode = {
      _tag: 'PanelLeafNode',
      id: 'pane-1',
      paneType: 'terminal',
      terminalId: 'term-1',
      workspaceId: 'ws-1',
    }
    const leaf2: PanelLeafNode = {
      _tag: 'PanelLeafNode',
      id: 'pane-2',
      paneType: 'terminal',
      terminalId: 'term-2',
      workspaceId: 'ws-1',
    }
    const split: PanelSplitNode = {
      _tag: 'PanelSplitNode',
      id: 'split-root',
      direction: 'horizontal',
      children: [leaf1, leaf2],
      sizes: [50, 50],
    }
    expect(findEmptyPanelTreeLeaf(split)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// findPaneInWindowLayout
// ---------------------------------------------------------------------------

describe('findPaneInWindowLayout', () => {
  it('finds a pane in a single-tab layout', () => {
    const result = findPaneInWindowLayout(singleTabLayout, 'pane-term-1')
    expect(result).toBeDefined()
    expect(result?.leaf.id).toBe('pane-term-1')
    expect(result?.workspaceId).toBe('ws-1')
    expect(result?.tabId).toBe('tab-1')
  })

  it('finds a pane across tabs in a complex layout', () => {
    const result = findPaneInWindowLayout(complexLayout, 'pane-B1')
    expect(result).toBeDefined()
    expect(result?.leaf.id).toBe('pane-B1')
    expect(result?.workspaceId).toBe('ws-B')
    expect(result?.tabId).toBe('tab-1')
  })

  it('finds a pane in a different tab', () => {
    const result = findPaneInWindowLayout(complexLayout, 'pane-term-C1')
    expect(result).toBeDefined()
    expect(result?.leaf.id).toBe('pane-term-C1')
    expect(result?.workspaceId).toBe('ws-C')
    expect(result?.tabId).toBe('tab-2')
  })

  it('returns undefined for a non-existent pane', () => {
    expect(
      findPaneInWindowLayout(singleTabLayout, 'no-such-pane')
    ).toBeUndefined()
  })

  it('returns undefined for an empty layout', () => {
    expect(findPaneInWindowLayout(emptyLayout, 'any-pane')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// computeClosePaneGateActionHierarchical
// ---------------------------------------------------------------------------

describe('computeClosePaneGateActionHierarchical', () => {
  const terminals = [
    { id: 'term-1', hasChildProcess: false },
    { id: 'term-running', hasChildProcess: true },
  ]

  it('returns close when layout is undefined', () => {
    const result = computeClosePaneGateActionHierarchical(
      undefined,
      'pane-1',
      terminals,
      null
    )
    expect(result.action).toBe('close')
  })

  it('returns close when pane is not found', () => {
    const result = computeClosePaneGateActionHierarchical(
      singleTabLayout,
      'non-existent',
      terminals,
      null
    )
    expect(result.action).toBe('close')
  })

  it('returns close for a pane with no running process', () => {
    const result = computeClosePaneGateActionHierarchical(
      singleTabLayout,
      'pane-term-1',
      terminals,
      null
    )
    expect(result.action).toBe('close')
  })

  it('returns confirm when the pane has a running process', () => {
    // Build a layout with a running terminal
    const leaf = makeLeaf('pane-running', 'term-running', 'ws-run')
    const pt = makePanelTab('pt-run', leaf)
    const tile = makeWorkspaceTile('tile-run', 'ws-run', [pt])
    const layout: WindowLayout = {
      tabs: [{ id: 'tab-run', workspaceLayout: tile }],
      activeTabId: 'tab-run',
    }
    const result = computeClosePaneGateActionHierarchical(
      layout,
      'pane-running',
      terminals,
      null
    )
    expect(result.action).toBe('confirm')
  })

  it('returns prompt-destroy when last pane + merged PR + no process', () => {
    const result = computeClosePaneGateActionHierarchical(
      singleTabLayout,
      'pane-term-1',
      terminals,
      'MERGED'
    )
    expect(result.action).toBe('prompt-destroy')
    if (result.action === 'prompt-destroy') {
      expect(result.workspaceId).toBe('ws-1')
    }
  })

  it('returns confirm-with-destroy when last pane + merged PR + running process', () => {
    const leaf = makeLeaf('pane-running', 'term-running', 'ws-run')
    const pt = makePanelTab('pt-run', leaf)
    const tile = makeWorkspaceTile('tile-run', 'ws-run', [pt])
    const layout: WindowLayout = {
      tabs: [{ id: 'tab-run', workspaceLayout: tile }],
      activeTabId: 'tab-run',
    }
    const result = computeClosePaneGateActionHierarchical(
      layout,
      'pane-running',
      terminals,
      'MERGED'
    )
    expect(result.action).toBe('confirm-with-destroy')
    if (result.action === 'confirm-with-destroy') {
      expect(result.workspaceId).toBe('ws-run')
    }
  })

  it('returns close when PR is merged but workspace has multiple panes', () => {
    const leaf1 = makeLeaf('pane-1', 'term-1', 'ws-multi')
    const leaf2 = makeLeaf('pane-2', 'term-2', 'ws-multi')
    const split: PanelSplitNode = {
      _tag: 'PanelSplitNode',
      id: 'split-1',
      direction: 'horizontal',
      children: [leaf1, leaf2],
      sizes: [50, 50],
    }
    const pt: PanelTab = {
      id: 'pt-multi',
      panelLayout: split,
      focusedPaneId: 'pane-1',
    }
    const tile = makeWorkspaceTile('tile-multi', 'ws-multi', [pt])
    const layout: WindowLayout = {
      tabs: [{ id: 'tab-multi', workspaceLayout: tile }],
      activeTabId: 'tab-multi',
    }
    const result = computeClosePaneGateActionHierarchical(
      layout,
      'pane-1',
      [
        { id: 'term-1', hasChildProcess: false },
        { id: 'term-2', hasChildProcess: false },
      ],
      'MERGED'
    )
    expect(result.action).toBe('close')
  })
})

// ---------------------------------------------------------------------------
// computeCloseWorkspaceActionHierarchical
// ---------------------------------------------------------------------------

describe('computeCloseWorkspaceActionHierarchical', () => {
  it('returns close when layout is undefined', () => {
    expect(computeCloseWorkspaceActionHierarchical(undefined, 'ws-1', [])).toBe(
      'close'
    )
  })

  it('returns close when workspace is not found', () => {
    expect(
      computeCloseWorkspaceActionHierarchical(singleTabLayout, 'no-such-ws', [])
    ).toBe('close')
  })

  it('returns close when workspace has no running processes', () => {
    expect(
      computeCloseWorkspaceActionHierarchical(singleTabLayout, 'ws-1', [
        { id: 'term-1', hasChildProcess: false },
      ])
    ).toBe('close')
  })

  it('returns confirm when workspace has a running process', () => {
    expect(
      computeCloseWorkspaceActionHierarchical(singleTabLayout, 'ws-1', [
        { id: 'term-1', hasChildProcess: true },
      ])
    ).toBe('confirm')
  })

  it('returns confirm when any terminal in the workspace has a running process', () => {
    const leaf1 = makeLeaf('pane-1', 'term-1', 'ws-multi')
    const leaf2 = makeLeaf('pane-2', 'term-2', 'ws-multi')
    const split: PanelSplitNode = {
      _tag: 'PanelSplitNode',
      id: 'split-1',
      direction: 'horizontal',
      children: [leaf1, leaf2],
      sizes: [50, 50],
    }
    const pt: PanelTab = {
      id: 'pt-multi',
      panelLayout: split,
      focusedPaneId: 'pane-1',
    }
    const tile = makeWorkspaceTile('tile-multi', 'ws-multi', [pt])
    const layout: WindowLayout = {
      tabs: [{ id: 'tab-multi', workspaceLayout: tile }],
      activeTabId: 'tab-multi',
    }
    expect(
      computeCloseWorkspaceActionHierarchical(layout, 'ws-multi', [
        { id: 'term-1', hasChildProcess: false },
        { id: 'term-2', hasChildProcess: true },
      ])
    ).toBe('confirm')
  })
})

// ---------------------------------------------------------------------------
// computeResizePanelTree
// ---------------------------------------------------------------------------

describe('computeResizePanelTree', () => {
  it('returns undefined for a single leaf (no split to resize)', () => {
    const leaf = makeLeaf('pane-1')
    expect(computeResizePanelTree(leaf, 'pane-1', 'right')).toBeUndefined()
  })

  it('returns undefined when pane ID is not found', () => {
    const leaf = makeLeaf('pane-1')
    expect(computeResizePanelTree(leaf, 'nonexistent', 'right')).toBeUndefined()
  })

  it('grows the first child when resizing right in a horizontal split', () => {
    const left = makeLeaf('left')
    const right = makeLeaf('right')
    const split: PanelSplitNode = {
      _tag: 'PanelSplitNode',
      id: 'split-h',
      direction: 'horizontal',
      children: [left, right],
      sizes: [50, 50],
    }

    const result = computeResizePanelTree(split, 'left', 'right')
    expect(result).toBeDefined()
    expect(result?.splitNodeId).toBe('split-h')
    expect(result?.newSizes.left).toBe(55)
    expect(result?.newSizes.right).toBe(45)
  })

  it('shrinks the first child when resizing left in a horizontal split', () => {
    const left = makeLeaf('left')
    const right = makeLeaf('right')
    const split: PanelSplitNode = {
      _tag: 'PanelSplitNode',
      id: 'split-h',
      direction: 'horizontal',
      children: [left, right],
      sizes: [50, 50],
    }

    const result = computeResizePanelTree(split, 'left', 'left')
    // left is the first child; shrinking left means delta=-5, sibling=-1 which is out of bounds
    expect(result).toBeUndefined()
  })

  it('grows the second child when resizing left (takes from sibling)', () => {
    const left = makeLeaf('left')
    const right = makeLeaf('right')
    const split: PanelSplitNode = {
      _tag: 'PanelSplitNode',
      id: 'split-h',
      direction: 'horizontal',
      children: [left, right],
      sizes: [50, 50],
    }

    // Resizing "right" pane to the left means shrinking it (delta = -5),
    // sibling index = 1 - 1 = 0 (left), so left grows
    const result = computeResizePanelTree(split, 'right', 'left')
    expect(result).toBeDefined()
    expect(result?.splitNodeId).toBe('split-h')
    expect(result?.newSizes.right).toBe(45)
    expect(result?.newSizes.left).toBe(55)
  })

  it('handles vertical splits with up/down directions', () => {
    const top = makeLeaf('top')
    const bottom = makeLeaf('bottom')
    const split: PanelSplitNode = {
      _tag: 'PanelSplitNode',
      id: 'split-v',
      direction: 'vertical',
      children: [top, bottom],
      sizes: [50, 50],
    }

    const result = computeResizePanelTree(split, 'top', 'down')
    expect(result).toBeDefined()
    expect(result?.splitNodeId).toBe('split-v')
    expect(result?.newSizes.top).toBe(55)
    expect(result?.newSizes.bottom).toBe(45)
  })

  it('returns undefined when direction does not match split orientation', () => {
    const left = makeLeaf('left')
    const right = makeLeaf('right')
    const split: PanelSplitNode = {
      _tag: 'PanelSplitNode',
      id: 'split-h',
      direction: 'horizontal',
      children: [left, right],
      sizes: [50, 50],
    }

    // up/down on a horizontal split should not produce a result
    expect(computeResizePanelTree(split, 'left', 'up')).toBeUndefined()
    expect(computeResizePanelTree(split, 'left', 'down')).toBeUndefined()
  })

  it('prevents resizing below minimum size', () => {
    const left = makeLeaf('left')
    const right = makeLeaf('right')
    const split: PanelSplitNode = {
      _tag: 'PanelSplitNode',
      id: 'split-h',
      direction: 'horizontal',
      children: [left, right],
      sizes: [93, 7],
    }

    // Growing left (size 93) by 5 → right (size 7) becomes 2 → below MIN_PANE_SIZE (5)
    const result = computeResizePanelTree(split, 'left', 'right')
    expect(result).toBeUndefined()
  })

  it('walks up to find the correct ancestor in a nested tree', () => {
    const innerLeft = makeLeaf('inner-left')
    const innerRight = makeLeaf('inner-right')
    const innerSplit: PanelSplitNode = {
      _tag: 'PanelSplitNode',
      id: 'inner-split',
      direction: 'vertical',
      children: [innerLeft, innerRight],
      sizes: [50, 50],
    }
    const outerRight = makeLeaf('outer-right')
    const outerSplit: PanelSplitNode = {
      _tag: 'PanelSplitNode',
      id: 'outer-split',
      direction: 'horizontal',
      children: [innerSplit, outerRight],
      sizes: [60, 40],
    }

    // Resizing inner-left to the right — inner-split is vertical, so it
    // doesn't match horizontal. Walk up to outer-split which is horizontal.
    const result = computeResizePanelTree(outerSplit, 'inner-left', 'right')
    expect(result).toBeDefined()
    expect(result?.splitNodeId).toBe('outer-split')
    expect(result?.newSizes['inner-split']).toBe(65)
    expect(result?.newSizes['outer-right']).toBe(35)
  })

  it('resizes inner split when direction matches inner orientation', () => {
    const innerLeft = makeLeaf('inner-top')
    const innerRight = makeLeaf('inner-bottom')
    const innerSplit: PanelSplitNode = {
      _tag: 'PanelSplitNode',
      id: 'inner-split',
      direction: 'vertical',
      children: [innerLeft, innerRight],
      sizes: [50, 50],
    }
    const outerRight = makeLeaf('outer-right')
    const outerSplit: PanelSplitNode = {
      _tag: 'PanelSplitNode',
      id: 'outer-split',
      direction: 'horizontal',
      children: [innerSplit, outerRight],
      sizes: [60, 40],
    }

    // Resizing inner-top downward should hit the inner vertical split
    const result = computeResizePanelTree(outerSplit, 'inner-top', 'down')
    expect(result).toBeDefined()
    expect(result?.splitNodeId).toBe('inner-split')
    expect(result?.newSizes['inner-top']).toBe(55)
    expect(result?.newSizes['inner-bottom']).toBe(45)
  })
})

// ---------------------------------------------------------------------------
// findPanelTreeRootForPane
// ---------------------------------------------------------------------------

describe('findPanelTreeRootForPane', () => {
  it('finds the panel tree root containing a pane', () => {
    const root = findPanelTreeRootForPane(singleTabLayout, 'pane-term-1')
    expect(root).toBeDefined()
    expect(root?._tag).toBe('PanelLeafNode')
    expect(root?.id).toBe('pane-term-1')
  })

  it('returns undefined when pane is not in the layout', () => {
    expect(
      findPanelTreeRootForPane(singleTabLayout, 'nonexistent')
    ).toBeUndefined()
  })

  it('finds a pane in a split panel tree', () => {
    const leaf1 = makeLeaf('pane-a', 'term-a', 'ws-split')
    const leaf2 = makeLeaf('pane-b', 'term-b', 'ws-split')
    const split: PanelSplitNode = {
      _tag: 'PanelSplitNode',
      id: 'split-1',
      direction: 'horizontal',
      children: [leaf1, leaf2],
      sizes: [50, 50],
    }
    const pt: PanelTab = {
      id: 'pt-split',
      panelLayout: split,
      focusedPaneId: 'pane-a',
    }
    const tile = makeWorkspaceTile('tile-split', 'ws-split', [pt])
    const layout: WindowLayout = {
      tabs: [{ id: 'tab-split', workspaceLayout: tile }],
      activeTabId: 'tab-split',
    }

    const root = findPanelTreeRootForPane(layout, 'pane-b')
    expect(root).toBeDefined()
    // The root should be the split node, not the leaf
    expect(root?._tag).toBe('PanelSplitNode')
    expect(root?.id).toBe('split-1')
  })

  it('returns undefined for an empty layout', () => {
    expect(findPanelTreeRootForPane(emptyLayout, 'any-pane')).toBeUndefined()
  })

  it('finds a pane across different tabs', () => {
    const root = findPanelTreeRootForPane(multiTabLayout, 'pane-term-2')
    expect(root).toBeDefined()
    expect(root?.id).toBe('pane-term-2')
  })
})
