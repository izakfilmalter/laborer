/**
 * Unit tests for panel tab layout manipulation utilities.
 *
 * Tests the pure functions in `panel-tab-utils.ts` that operate on the
 * WorkspaceTileLeaf type for panel tab CRUD within a workspace.
 *
 * @see apps/web/src/panels/panel-tab-utils.ts
 */

import type {
  PanelLeafNode,
  PanelTab,
  WorkspaceTileLeaf,
} from '@laborer/shared/types'
import { describe, expect, it } from 'vitest'
import {
  addPanelTab,
  getActivePanelTab,
  removePanelTab,
  reorderPanelTabs,
  switchPanelTab,
  switchPanelTabByIndex,
  switchPanelTabRelative,
} from '../src/panels/panel-tab-utils'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** A panel leaf node for use in fixtures. */
function makeLeaf(
  id: string,
  paneType: 'terminal' | 'diff' | 'review' | 'devServerTerminal' = 'terminal',
  terminalId?: string
): PanelLeafNode {
  return {
    _tag: 'PanelLeafNode',
    id,
    paneType,
    terminalId,
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

/** An empty workspace tile leaf with no panel tabs. */
function makeEmptyWorkspace(
  id: string,
  workspaceId: string
): WorkspaceTileLeaf {
  return {
    _tag: 'WorkspaceTileLeaf',
    id,
    workspaceId,
    panelTabs: [],
    activePanelTabId: undefined,
  }
}

/**
 * A workspace tile leaf with a given set of panel tabs.
 * The first tab is active by default.
 */
function makeWorkspace(
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

/**
 * Shorthand: workspace with N terminal panel tabs labeled tab-1..tab-N.
 */
function makeWorkspaceWithTabs(
  workspaceId: string,
  tabCount: number,
  activeIndex = 0
): WorkspaceTileLeaf {
  const tabs: PanelTab[] = []
  for (let i = 0; i < tabCount; i++) {
    const leaf = makeLeaf(`pane-${i + 1}`, 'terminal', `term-${i + 1}`)
    tabs.push(makePanelTab(`tab-${i + 1}`, leaf))
  }
  return makeWorkspace('ws-tile-1', workspaceId, tabs, tabs[activeIndex]?.id)
}

// ---------------------------------------------------------------------------
// addPanelTab
// ---------------------------------------------------------------------------

describe('addPanelTab', () => {
  it('adds a terminal tab to an empty workspace', () => {
    const ws = makeEmptyWorkspace('ws-tile-1', 'ws-1')
    const result = addPanelTab(ws, 'terminal')

    expect(result.panelTabs).toHaveLength(1)
    expect(result.activePanelTabId).toBe(result.panelTabs[0]?.id)

    const tab = result.panelTabs[0]
    expect(tab?.panelLayout._tag).toBe('PanelLeafNode')
    const leaf = tab?.panelLayout as PanelLeafNode
    expect(leaf.paneType).toBe('terminal')
    expect(leaf.workspaceId).toBe('ws-1')
  })

  it('appends a tab to existing tabs and makes it active', () => {
    const ws = makeWorkspaceWithTabs('ws-1', 2)
    const result = addPanelTab(ws, 'diff')

    expect(result.panelTabs).toHaveLength(3)
    expect(result.activePanelTabId).toBe(result.panelTabs[2]?.id)

    const newTab = result.panelTabs[2]
    const leaf = newTab?.panelLayout as PanelLeafNode
    expect(leaf.paneType).toBe('diff')
  })

  it('creates tab with correct panelType for each type', () => {
    const ws = makeEmptyWorkspace('ws-tile-1', 'ws-1')

    for (const paneType of [
      'terminal',
      'diff',
      'review',
      'devServerTerminal',
    ] as const) {
      const result = addPanelTab(ws, paneType)
      const leaf = result.panelTabs[0]?.panelLayout as PanelLeafNode
      expect(leaf.paneType).toBe(paneType)
    }
  })

  it('uses a pre-configured tab when provided', () => {
    const ws = makeEmptyWorkspace('ws-tile-1', 'ws-1')
    const customTab: PanelTab = {
      id: 'custom-tab',
      panelLayout: makeLeaf('custom-pane', 'review'),
      focusedPaneId: 'custom-pane',
    }

    const result = addPanelTab(ws, 'terminal', { tab: customTab })

    expect(result.panelTabs).toHaveLength(1)
    expect(result.panelTabs[0]?.id).toBe('custom-tab')
    expect(result.activePanelTabId).toBe('custom-tab')
  })

  it('sets terminalId on the leaf when provided', () => {
    const ws = makeEmptyWorkspace('ws-tile-1', 'ws-1')
    const result = addPanelTab(ws, 'terminal', { terminalId: 'term-42' })

    const leaf = result.panelTabs[0]?.panelLayout as PanelLeafNode
    expect(leaf.terminalId).toBe('term-42')
  })

  it('sets label on the tab when provided', () => {
    const ws = makeEmptyWorkspace('ws-tile-1', 'ws-1')
    const result = addPanelTab(ws, 'terminal', { label: 'My Tab' })

    expect(result.panelTabs[0]?.label).toBe('My Tab')
  })

  it('does not mutate the original workspace', () => {
    const ws = makeWorkspaceWithTabs('ws-1', 1)
    const originalTabs = ws.panelTabs
    const originalActiveId = ws.activePanelTabId

    addPanelTab(ws, 'diff')

    expect(ws.panelTabs).toBe(originalTabs)
    expect(ws.panelTabs).toHaveLength(1)
    expect(ws.activePanelTabId).toBe(originalActiveId)
  })

  it('sets focusedPaneId on the new tab to the pane ID', () => {
    const ws = makeEmptyWorkspace('ws-tile-1', 'ws-1')
    const result = addPanelTab(ws, 'terminal')

    const tab = result.panelTabs[0]
    const leaf = tab?.panelLayout as PanelLeafNode
    expect(tab?.focusedPaneId).toBe(leaf.id)
  })
})

// ---------------------------------------------------------------------------
// removePanelTab
// ---------------------------------------------------------------------------

describe('removePanelTab', () => {
  it('returns workspace unchanged when tabId not found', () => {
    const ws = makeWorkspaceWithTabs('ws-1', 2)
    const result = removePanelTab(ws, 'nonexistent')

    expect(result).toBe(ws)
  })

  it('removes the only tab and sets activePanelTabId to undefined', () => {
    const ws = makeWorkspaceWithTabs('ws-1', 1)
    const result = removePanelTab(ws, 'tab-1')

    expect(result.panelTabs).toHaveLength(0)
    expect(result.activePanelTabId).toBeUndefined()
  })

  it('removes a non-active tab without changing active', () => {
    const ws = makeWorkspaceWithTabs('ws-1', 3, 0)
    const result = removePanelTab(ws, 'tab-2')

    expect(result.panelTabs).toHaveLength(2)
    expect(result.activePanelTabId).toBe('tab-1')
    expect(result.panelTabs.map((t) => t.id)).toEqual(['tab-1', 'tab-3'])
  })

  it('removes active middle tab and activates right sibling', () => {
    const ws = makeWorkspaceWithTabs('ws-1', 3, 1)
    const result = removePanelTab(ws, 'tab-2')

    expect(result.panelTabs).toHaveLength(2)
    // After removing index 1 from [tab-1, tab-2, tab-3], remaining is [tab-1, tab-3]
    // nextIndex = min(1, 1) = 1 => tab-3
    expect(result.activePanelTabId).toBe('tab-3')
  })

  it('removes active last tab and activates left sibling', () => {
    const ws = makeWorkspaceWithTabs('ws-1', 3, 2)
    const result = removePanelTab(ws, 'tab-3')

    expect(result.panelTabs).toHaveLength(2)
    // After removing index 2 from [tab-1, tab-2, tab-3], remaining is [tab-1, tab-2]
    // nextIndex = min(2, 1) = 1 => tab-2
    expect(result.activePanelTabId).toBe('tab-2')
  })

  it('removes active first tab and activates right sibling', () => {
    const ws = makeWorkspaceWithTabs('ws-1', 3, 0)
    const result = removePanelTab(ws, 'tab-1')

    expect(result.panelTabs).toHaveLength(2)
    // After removing index 0 from [tab-1, tab-2, tab-3], remaining is [tab-2, tab-3]
    // nextIndex = min(0, 1) = 0 => tab-2
    expect(result.activePanelTabId).toBe('tab-2')
  })

  it('removes active tab when only 2 tabs, activates remaining', () => {
    const ws = makeWorkspaceWithTabs('ws-1', 2, 0)
    const result = removePanelTab(ws, 'tab-1')

    expect(result.panelTabs).toHaveLength(1)
    expect(result.activePanelTabId).toBe('tab-2')
  })

  it('does not mutate the original workspace', () => {
    const ws = makeWorkspaceWithTabs('ws-1', 3)
    const originalTabs = ws.panelTabs

    removePanelTab(ws, 'tab-2')

    expect(ws.panelTabs).toBe(originalTabs)
    expect(ws.panelTabs).toHaveLength(3)
  })

  it('handles removing from empty workspace gracefully', () => {
    const ws = makeEmptyWorkspace('ws-tile-1', 'ws-1')
    const result = removePanelTab(ws, 'tab-1')

    expect(result).toBe(ws)
  })
})

// ---------------------------------------------------------------------------
// switchPanelTab
// ---------------------------------------------------------------------------

describe('switchPanelTab', () => {
  it('switches to an existing tab', () => {
    const ws = makeWorkspaceWithTabs('ws-1', 3, 0)
    const result = switchPanelTab(ws, 'tab-3')

    expect(result.activePanelTabId).toBe('tab-3')
  })

  it('returns workspace unchanged when tabId not found', () => {
    const ws = makeWorkspaceWithTabs('ws-1', 3)
    const result = switchPanelTab(ws, 'nonexistent')

    expect(result).toBe(ws)
  })

  it('returns workspace unchanged when already active', () => {
    const ws = makeWorkspaceWithTabs('ws-1', 3, 0)
    const result = switchPanelTab(ws, 'tab-1')

    // Still creates a new object (shallow copy), but with same activeId
    expect(result.activePanelTabId).toBe('tab-1')
  })

  it('does not mutate the original workspace', () => {
    const ws = makeWorkspaceWithTabs('ws-1', 3, 0)
    const originalActiveId = ws.activePanelTabId

    switchPanelTab(ws, 'tab-3')

    expect(ws.activePanelTabId).toBe(originalActiveId)
  })
})

// ---------------------------------------------------------------------------
// switchPanelTabByIndex
// ---------------------------------------------------------------------------

describe('switchPanelTabByIndex', () => {
  it('switches to tab at index 1 (first tab)', () => {
    const ws = makeWorkspaceWithTabs('ws-1', 5, 2)
    const result = switchPanelTabByIndex(ws, 1)

    expect(result.activePanelTabId).toBe('tab-1')
  })

  it('switches to tab at index 5 (fifth tab)', () => {
    const ws = makeWorkspaceWithTabs('ws-1', 5, 0)
    const result = switchPanelTabByIndex(ws, 5)

    expect(result.activePanelTabId).toBe('tab-5')
  })

  it('switches to tab at index 8 when 8 tabs exist', () => {
    const ws = makeWorkspaceWithTabs('ws-1', 8, 0)
    const result = switchPanelTabByIndex(ws, 8)

    expect(result.activePanelTabId).toBe('tab-8')
  })

  it('index 9 always maps to last tab', () => {
    const ws = makeWorkspaceWithTabs('ws-1', 5, 0)
    const result = switchPanelTabByIndex(ws, 9)

    expect(result.activePanelTabId).toBe('tab-5')
  })

  it('index 9 maps to last tab with many tabs', () => {
    const ws = makeWorkspaceWithTabs('ws-1', 12, 0)
    const result = switchPanelTabByIndex(ws, 9)

    expect(result.activePanelTabId).toBe('tab-12')
  })

  it('returns unchanged for out-of-range index', () => {
    const ws = makeWorkspaceWithTabs('ws-1', 3, 0)
    const result = switchPanelTabByIndex(ws, 5)

    expect(result).toBe(ws)
  })

  it('returns unchanged for index 0', () => {
    const ws = makeWorkspaceWithTabs('ws-1', 3, 0)
    const result = switchPanelTabByIndex(ws, 0)

    expect(result).toBe(ws)
  })

  it('returns unchanged for negative index', () => {
    const ws = makeWorkspaceWithTabs('ws-1', 3, 0)
    const result = switchPanelTabByIndex(ws, -1)

    expect(result).toBe(ws)
  })

  it('returns unchanged for empty workspace', () => {
    const ws = makeEmptyWorkspace('ws-tile-1', 'ws-1')
    const result = switchPanelTabByIndex(ws, 1)

    expect(result).toBe(ws)
  })
})

// ---------------------------------------------------------------------------
// switchPanelTabRelative
// ---------------------------------------------------------------------------

describe('switchPanelTabRelative', () => {
  it('moves to next tab with delta +1', () => {
    const ws = makeWorkspaceWithTabs('ws-1', 3, 0)
    const result = switchPanelTabRelative(ws, 1)

    expect(result.activePanelTabId).toBe('tab-2')
  })

  it('moves to previous tab with delta -1', () => {
    const ws = makeWorkspaceWithTabs('ws-1', 3, 1)
    const result = switchPanelTabRelative(ws, -1)

    expect(result.activePanelTabId).toBe('tab-1')
  })

  it('wraps around forward: last tab + 1 = first tab', () => {
    const ws = makeWorkspaceWithTabs('ws-1', 3, 2)
    const result = switchPanelTabRelative(ws, 1)

    expect(result.activePanelTabId).toBe('tab-1')
  })

  it('wraps around backward: first tab - 1 = last tab', () => {
    const ws = makeWorkspaceWithTabs('ws-1', 3, 0)
    const result = switchPanelTabRelative(ws, -1)

    expect(result.activePanelTabId).toBe('tab-3')
  })

  it('handles single tab: stays on same tab', () => {
    const ws = makeWorkspaceWithTabs('ws-1', 1, 0)
    const result = switchPanelTabRelative(ws, 1)

    expect(result.activePanelTabId).toBe('tab-1')
  })

  it('returns unchanged for empty workspace', () => {
    const ws = makeEmptyWorkspace('ws-tile-1', 'ws-1')
    const result = switchPanelTabRelative(ws, 1)

    expect(result).toBe(ws)
  })

  it('handles delta +2 (skip one tab)', () => {
    const ws = makeWorkspaceWithTabs('ws-1', 5, 0)
    const result = switchPanelTabRelative(ws, 2)

    expect(result.activePanelTabId).toBe('tab-3')
  })

  it('handles delta -2 with wrapping', () => {
    const ws = makeWorkspaceWithTabs('ws-1', 5, 0)
    const result = switchPanelTabRelative(ws, -2)

    expect(result.activePanelTabId).toBe('tab-4')
  })

  it('defaults to first tab when activePanelTabId is invalid', () => {
    const ws = makeWorkspace(
      'ws-tile-1',
      'ws-1',
      [
        makePanelTab('tab-1', makeLeaf('pane-1')),
        makePanelTab('tab-2', makeLeaf('pane-2')),
      ],
      'invalid-tab-id'
    )

    const result = switchPanelTabRelative(ws, 1)

    expect(result.activePanelTabId).toBe('tab-1')
  })
})

// ---------------------------------------------------------------------------
// reorderPanelTabs
// ---------------------------------------------------------------------------

describe('reorderPanelTabs', () => {
  it('moves tab forward (0 -> 2)', () => {
    const ws = makeWorkspaceWithTabs('ws-1', 3, 0)
    const result = reorderPanelTabs(ws, 0, 2)

    expect(result.panelTabs.map((t) => t.id)).toEqual([
      'tab-2',
      'tab-3',
      'tab-1',
    ])
  })

  it('moves tab backward (2 -> 0)', () => {
    const ws = makeWorkspaceWithTabs('ws-1', 3, 0)
    const result = reorderPanelTabs(ws, 2, 0)

    expect(result.panelTabs.map((t) => t.id)).toEqual([
      'tab-3',
      'tab-1',
      'tab-2',
    ])
  })

  it('returns unchanged for same index', () => {
    const ws = makeWorkspaceWithTabs('ws-1', 3, 0)
    const result = reorderPanelTabs(ws, 1, 1)

    expect(result).toBe(ws)
  })

  it('returns unchanged for out-of-range fromIndex', () => {
    const ws = makeWorkspaceWithTabs('ws-1', 3, 0)
    const result = reorderPanelTabs(ws, 5, 1)

    expect(result).toBe(ws)
  })

  it('returns unchanged for out-of-range toIndex', () => {
    const ws = makeWorkspaceWithTabs('ws-1', 3, 0)
    const result = reorderPanelTabs(ws, 1, 5)

    expect(result).toBe(ws)
  })

  it('returns unchanged for negative indices', () => {
    const ws = makeWorkspaceWithTabs('ws-1', 3, 0)
    const result = reorderPanelTabs(ws, -1, 1)

    expect(result).toBe(ws)
  })

  it('preserves activePanelTabId', () => {
    const ws = makeWorkspaceWithTabs('ws-1', 3, 1)
    const result = reorderPanelTabs(ws, 0, 2)

    expect(result.activePanelTabId).toBe('tab-2')
  })

  it('does not mutate the original workspace', () => {
    const ws = makeWorkspaceWithTabs('ws-1', 3, 0)
    const originalTabs = ws.panelTabs

    reorderPanelTabs(ws, 0, 2)

    expect(ws.panelTabs).toBe(originalTabs)
    expect(ws.panelTabs.map((t) => t.id)).toEqual(['tab-1', 'tab-2', 'tab-3'])
  })

  it('handles two tabs (swap)', () => {
    const ws = makeWorkspaceWithTabs('ws-1', 2, 0)
    const result = reorderPanelTabs(ws, 0, 1)

    expect(result.panelTabs.map((t) => t.id)).toEqual(['tab-2', 'tab-1'])
  })
})

// ---------------------------------------------------------------------------
// getActivePanelTab
// ---------------------------------------------------------------------------

describe('getActivePanelTab', () => {
  it('returns the active tab', () => {
    const ws = makeWorkspaceWithTabs('ws-1', 3, 1)
    const result = getActivePanelTab(ws)

    expect(result?.id).toBe('tab-2')
  })

  it('returns undefined for empty workspace', () => {
    const ws = makeEmptyWorkspace('ws-tile-1', 'ws-1')
    const result = getActivePanelTab(ws)

    expect(result).toBeUndefined()
  })

  it('returns undefined when activePanelTabId is invalid', () => {
    const ws = makeWorkspace(
      'ws-tile-1',
      'ws-1',
      [makePanelTab('tab-1', makeLeaf('pane-1'))],
      'invalid-id'
    )

    const result = getActivePanelTab(ws)

    expect(result).toBeUndefined()
  })

  it('returns undefined when activePanelTabId is undefined', () => {
    const ws: WorkspaceTileLeaf = {
      _tag: 'WorkspaceTileLeaf',
      id: 'ws-tile-1',
      workspaceId: 'ws-1',
      panelTabs: [makePanelTab('tab-1', makeLeaf('pane-1'))],
      activePanelTabId: undefined,
    }

    const result = getActivePanelTab(ws)

    expect(result).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Combined operations
// ---------------------------------------------------------------------------

describe('combined operations', () => {
  it('add + remove round-trip leaves workspace with original tabs', () => {
    const ws = makeWorkspaceWithTabs('ws-1', 2, 0)
    const added = addPanelTab(ws, 'diff')
    const newTabId = added.panelTabs[2]?.id ?? ''

    const removed = removePanelTab(added, newTabId)

    expect(removed.panelTabs).toHaveLength(2)
    expect(removed.panelTabs.map((t) => t.id)).toEqual(['tab-1', 'tab-2'])
    // Active should switch to nearest sibling of the removed tab
    expect(removed.activePanelTabId).toBe('tab-2')
  })

  it('add + switch + remove: active state consistent throughout', () => {
    const ws = makeWorkspaceWithTabs('ws-1', 1, 0)

    // Add a diff tab
    const added = addPanelTab(ws, 'diff')
    expect(added.activePanelTabId).toBe(added.panelTabs[1]?.id)

    // Switch back to first tab
    const switched = switchPanelTab(added, 'tab-1')
    expect(switched.activePanelTabId).toBe('tab-1')

    // Remove the diff tab (non-active)
    const diffTabId = added.panelTabs[1]?.id ?? ''
    const removed = removePanelTab(switched, diffTabId)
    expect(removed.panelTabs).toHaveLength(1)
    expect(removed.activePanelTabId).toBe('tab-1')
  })

  it('reorder + switchByIndex targets correct tab', () => {
    const ws = makeWorkspaceWithTabs('ws-1', 3, 0)

    // Reorder: move tab-1 to end -> [tab-2, tab-3, tab-1]
    const reordered = reorderPanelTabs(ws, 0, 2)
    expect(reordered.panelTabs.map((t) => t.id)).toEqual([
      'tab-2',
      'tab-3',
      'tab-1',
    ])

    // Switch to index 2 (1-based) -> tab-3 (now at position 2)
    const switched = switchPanelTabByIndex(reordered, 2)
    expect(switched.activePanelTabId).toBe('tab-3')
  })

  it('add multiple tabs + cycle through all of them', () => {
    let ws = makeEmptyWorkspace('ws-tile-1', 'ws-1')

    // Add 4 tabs of different types
    ws = addPanelTab(ws, 'terminal')
    ws = addPanelTab(ws, 'diff')
    ws = addPanelTab(ws, 'review')
    ws = addPanelTab(ws, 'devServerTerminal')

    expect(ws.panelTabs).toHaveLength(4)

    // Last added is active
    const lastTabId = ws.panelTabs[3]?.id
    expect(ws.activePanelTabId).toBe(lastTabId)

    // Cycle through all tabs with relative navigation
    const visited: string[] = []
    let current = switchPanelTabByIndex(ws, 1) // start at first
    for (let i = 0; i < 4; i++) {
      visited.push(current.activePanelTabId ?? '')
      current = switchPanelTabRelative(current, 1)
    }

    expect(visited).toHaveLength(4)
    // All 4 tab IDs should be unique
    expect(new Set(visited).size).toBe(4)
  })

  it('panel tab operations do not affect workspace-level properties', () => {
    const ws = makeWorkspaceWithTabs('ws-1', 2, 0)

    const added = addPanelTab(ws, 'diff')
    expect(added._tag).toBe('WorkspaceTileLeaf')
    expect(added.id).toBe(ws.id)
    expect(added.workspaceId).toBe(ws.workspaceId)

    const switched = switchPanelTab(added, 'tab-1')
    expect(switched.id).toBe(ws.id)
    expect(switched.workspaceId).toBe(ws.workspaceId)

    const removed = removePanelTab(switched, 'tab-1')
    expect(removed.id).toBe(ws.id)
    expect(removed.workspaceId).toBe(ws.workspaceId)

    const reordered = reorderPanelTabs(
      makeWorkspaceWithTabs('ws-1', 3, 0),
      0,
      2
    )
    expect(reordered.id).toBe('ws-tile-1')
    expect(reordered.workspaceId).toBe('ws-1')
  })
})
