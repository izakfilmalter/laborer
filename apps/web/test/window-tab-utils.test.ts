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
  findTerminalLocation,
  findWorkspaceLocation,
  getActiveWindowTab,
  getAllWorkspaceTileLeaves,
  getWorkspaceTileLeaves,
  removeWindowTab,
  reorderWindowTabs,
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
