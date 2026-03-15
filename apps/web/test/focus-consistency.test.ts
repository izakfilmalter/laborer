/**
 * Unit tests for focus consistency utilities.
 *
 * Tests the pure functions added to `window-tab-utils.ts` for focus
 * resolution and persistence across tab switches:
 * - `getFirstPanelTreeLeafId` — gets the first leaf pane ID from a PanelTreeNode
 * - `resolveActivePaneForPanelTab` — resolves focus for a panel tab
 * - `resolveActivePaneForWindowTab` — resolves focus for a window tab
 * - `saveFocusedPaneId` — saves focus state on the matching panel tab
 *
 * @see apps/web/src/panels/window-tab-utils.ts
 * @see docs/tabbed-window-layout/issues.md — Issue #25
 */

import type {
  PanelLeafNode,
  PanelSplitNode,
  PanelTab,
  PanelTreeNode,
  WindowLayout,
  WindowTab,
  WorkspaceTileLeaf,
  WorkspaceTileSplit,
} from '@laborer/shared/types'
import { describe, expect, it } from 'vitest'
import {
  getFirstPanelTreeLeafId,
  resolveActivePaneForPanelTab,
  resolveActivePaneForWindowTab,
  saveFocusedPaneId,
} from '../src/panels/window-tab-utils'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeLeaf(
  id: string,
  paneType: 'terminal' | 'diff' | 'review' | 'devServerTerminal' = 'terminal',
  workspaceId?: string
): PanelLeafNode {
  return {
    _tag: 'PanelLeafNode',
    id,
    paneType,
    workspaceId,
  }
}

function makeSplit(
  id: string,
  children: PanelTreeNode[],
  direction: 'horizontal' | 'vertical' = 'horizontal'
): PanelSplitNode {
  return {
    _tag: 'PanelSplitNode',
    id,
    direction,
    children,
    sizes: children.map(() => 100 / children.length),
  }
}

function makePanelTab(
  id: string,
  layout: PanelTreeNode,
  focusedPaneId?: string
): PanelTab {
  return {
    id,
    panelLayout: layout,
    focusedPaneId,
  }
}

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

function makeWindowTab(
  id: string,
  workspaceLayout?: WorkspaceTileLeaf | WorkspaceTileSplit
): WindowTab {
  return { id, workspaceLayout }
}

// ---------------------------------------------------------------------------
// getFirstPanelTreeLeafId
// ---------------------------------------------------------------------------

describe('getFirstPanelTreeLeafId', () => {
  it('returns the ID of a single leaf', () => {
    const leaf = makeLeaf('pane-1')
    expect(getFirstPanelTreeLeafId(leaf)).toBe('pane-1')
  })

  it('returns the first leaf in a horizontal split', () => {
    const split = makeSplit('split-1', [
      makeLeaf('pane-left'),
      makeLeaf('pane-right'),
    ])
    expect(getFirstPanelTreeLeafId(split)).toBe('pane-left')
  })

  it('returns the first leaf in a nested split (DFS)', () => {
    const split = makeSplit('split-1', [
      makeSplit('split-2', [makeLeaf('pane-deep'), makeLeaf('pane-sibling')]),
      makeLeaf('pane-top'),
    ])
    expect(getFirstPanelTreeLeafId(split)).toBe('pane-deep')
  })

  it('returns undefined for a split with no children', () => {
    const split: PanelSplitNode = {
      _tag: 'PanelSplitNode',
      id: 'empty-split',
      direction: 'horizontal',
      children: [],
      sizes: [],
    }
    expect(getFirstPanelTreeLeafId(split)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// resolveActivePaneForPanelTab
// ---------------------------------------------------------------------------

describe('resolveActivePaneForPanelTab', () => {
  it('returns focusedPaneId when set', () => {
    const tab = makePanelTab(
      'tab-1',
      makeSplit('split', [makeLeaf('pane-1'), makeLeaf('pane-2')]),
      'pane-2'
    )
    expect(resolveActivePaneForPanelTab(tab)).toBe('pane-2')
  })

  it('falls back to first leaf when focusedPaneId is undefined', () => {
    const tab = makePanelTab(
      'tab-1',
      makeSplit('split', [makeLeaf('pane-1'), makeLeaf('pane-2')])
    )
    expect(resolveActivePaneForPanelTab(tab)).toBe('pane-1')
  })

  it('returns focusedPaneId even if it points to a non-first leaf', () => {
    const tab = makePanelTab(
      'tab-1',
      makeSplit('split', [makeLeaf('pane-a'), makeLeaf('pane-b')]),
      'pane-b'
    )
    expect(resolveActivePaneForPanelTab(tab)).toBe('pane-b')
  })

  it('handles single-leaf panel tab', () => {
    const tab = makePanelTab('tab-1', makeLeaf('only-pane'), 'only-pane')
    expect(resolveActivePaneForPanelTab(tab)).toBe('only-pane')
  })
})

// ---------------------------------------------------------------------------
// resolveActivePaneForWindowTab
// ---------------------------------------------------------------------------

describe('resolveActivePaneForWindowTab', () => {
  it('returns undefined for empty window tab (no workspace layout)', () => {
    const tab = makeWindowTab('tab-1')
    expect(resolveActivePaneForWindowTab(tab)).toBeUndefined()
  })

  it('returns the focused pane of the active panel tab', () => {
    const pTab = makePanelTab(
      'pt-1',
      makeSplit('split', [makeLeaf('pane-1'), makeLeaf('pane-2')]),
      'pane-2'
    )
    const tile = makeWorkspaceTile('tile-1', 'ws-1', [pTab])
    const tab = makeWindowTab('tab-1', tile)
    expect(resolveActivePaneForWindowTab(tab)).toBe('pane-2')
  })

  it('falls back to first leaf when focusedPaneId not set', () => {
    const pTab = makePanelTab(
      'pt-1',
      makeSplit('split', [makeLeaf('pane-a'), makeLeaf('pane-b')])
    )
    const tile = makeWorkspaceTile('tile-1', 'ws-1', [pTab])
    const tab = makeWindowTab('tab-1', tile)
    expect(resolveActivePaneForWindowTab(tab)).toBe('pane-a')
  })

  it('resolves from the active panel tab, not the first tab', () => {
    const pTab1 = makePanelTab('pt-1', makeLeaf('pane-tab1'), 'pane-tab1')
    const pTab2 = makePanelTab('pt-2', makeLeaf('pane-tab2'), 'pane-tab2')
    const tile = makeWorkspaceTile('tile-1', 'ws-1', [pTab1, pTab2], 'pt-2')
    const tab = makeWindowTab('tab-1', tile)
    expect(resolveActivePaneForWindowTab(tab)).toBe('pane-tab2')
  })

  it('returns undefined when workspace has no panel tabs', () => {
    const tile = makeWorkspaceTile('tile-1', 'ws-1', [])
    const tab = makeWindowTab('tab-1', tile)
    expect(resolveActivePaneForWindowTab(tab)).toBeUndefined()
  })

  it('resolves from first workspace with panel tabs in multi-workspace tab', () => {
    const pTab = makePanelTab('pt-1', makeLeaf('pane-ws2'), 'pane-ws2')
    const tile1 = makeWorkspaceTile('tile-1', 'ws-1', [])
    const tile2 = makeWorkspaceTile('tile-2', 'ws-2', [pTab])
    const split: WorkspaceTileSplit = {
      _tag: 'WorkspaceTileSplit',
      id: 'wsplit-1',
      direction: 'horizontal',
      children: [tile1, tile2],
      sizes: [50, 50],
    }
    const tab = makeWindowTab('tab-1', split)
    expect(resolveActivePaneForWindowTab(tab)).toBe('pane-ws2')
  })
})

// ---------------------------------------------------------------------------
// saveFocusedPaneId
// ---------------------------------------------------------------------------

describe('saveFocusedPaneId', () => {
  it('returns unchanged layout when pane is not found (referential equality)', () => {
    const pTab = makePanelTab('pt-1', makeLeaf('pane-1'))
    const tile = makeWorkspaceTile('tile-1', 'ws-1', [pTab])
    const layout: WindowLayout = {
      tabs: [{ id: 'tab-1', workspaceLayout: tile }],
      activeTabId: 'tab-1',
    }
    const result = saveFocusedPaneId(layout, 'nonexistent-pane')
    expect(result).toBe(layout)
  })

  it('updates focusedPaneId on the matching panel tab', () => {
    const leaf1 = makeLeaf('pane-1')
    const leaf2 = makeLeaf('pane-2')
    const split = makeSplit('split-1', [leaf1, leaf2])
    const pTab = makePanelTab('pt-1', split, 'pane-1')
    const tile = makeWorkspaceTile('tile-1', 'ws-1', [pTab])
    const layout: WindowLayout = {
      tabs: [{ id: 'tab-1', workspaceLayout: tile }],
      activeTabId: 'tab-1',
    }

    const result = saveFocusedPaneId(layout, 'pane-2')
    const updatedTab = result.tabs[0]?.workspaceLayout as WorkspaceTileLeaf
    expect(updatedTab.panelTabs[0]?.focusedPaneId).toBe('pane-2')
  })

  it('does not change layout when focusedPaneId is already correct (referential equality)', () => {
    const leaf = makeLeaf('pane-1')
    const pTab = makePanelTab('pt-1', leaf, 'pane-1')
    const tile = makeWorkspaceTile('tile-1', 'ws-1', [pTab])
    const layout: WindowLayout = {
      tabs: [{ id: 'tab-1', workspaceLayout: tile }],
      activeTabId: 'tab-1',
    }

    const result = saveFocusedPaneId(layout, 'pane-1')
    expect(result).toBe(layout)
  })

  it('only updates the panel tab containing the pane, not others', () => {
    const pTab1 = makePanelTab('pt-1', makeLeaf('pane-1'), 'pane-1')
    const pTab2 = makePanelTab('pt-2', makeLeaf('pane-2'), 'pane-2')
    const tile = makeWorkspaceTile('tile-1', 'ws-1', [pTab1, pTab2])
    const layout: WindowLayout = {
      tabs: [{ id: 'tab-1', workspaceLayout: tile }],
      activeTabId: 'tab-1',
    }

    const result = saveFocusedPaneId(layout, 'pane-1')
    // pTab1 already had 'pane-1', so no change; pTab2 unchanged
    expect(result).toBe(layout)
  })

  it('works across window tabs — updates the correct tab', () => {
    const pTab1 = makePanelTab('pt-1', makeLeaf('pane-tab1'), 'pane-tab1')
    const tile1 = makeWorkspaceTile('tile-1', 'ws-1', [pTab1])
    const leaf = makeLeaf('pane-tab2-a')
    const leaf2 = makeLeaf('pane-tab2-b')
    const split = makeSplit('split-1', [leaf, leaf2])
    const pTab2 = makePanelTab('pt-2', split, 'pane-tab2-a')
    const tile2 = makeWorkspaceTile('tile-2', 'ws-2', [pTab2])
    const layout: WindowLayout = {
      tabs: [
        { id: 'tab-1', workspaceLayout: tile1 },
        { id: 'tab-2', workspaceLayout: tile2 },
      ],
      activeTabId: 'tab-2',
    }

    const result = saveFocusedPaneId(layout, 'pane-tab2-b')
    // tab-1 should be unchanged
    expect(result.tabs[0]).toBe(layout.tabs[0])
    // tab-2's panel tab should have updated focusedPaneId
    const updatedTile = result.tabs[1]?.workspaceLayout as WorkspaceTileLeaf
    expect(updatedTile.panelTabs[0]?.focusedPaneId).toBe('pane-tab2-b')
  })

  it('works with nested workspace tile splits', () => {
    const pTab = makePanelTab(
      'pt-1',
      makeSplit('split-1', [makeLeaf('pane-a'), makeLeaf('pane-b')]),
      'pane-a'
    )
    const tile = makeWorkspaceTile('tile-1', 'ws-1', [pTab])
    const outerTile: WorkspaceTileSplit = {
      _tag: 'WorkspaceTileSplit',
      id: 'wsplit-1',
      direction: 'horizontal',
      children: [tile],
      sizes: [100],
    }
    const layout: WindowLayout = {
      tabs: [{ id: 'tab-1', workspaceLayout: outerTile }],
      activeTabId: 'tab-1',
    }

    const result = saveFocusedPaneId(layout, 'pane-b')
    const updatedSplit = result.tabs[0]?.workspaceLayout as WorkspaceTileSplit
    const updatedLeaf = updatedSplit.children[0] as WorkspaceTileLeaf
    expect(updatedLeaf.panelTabs[0]?.focusedPaneId).toBe('pane-b')
  })

  it('handles empty layout gracefully', () => {
    const layout: WindowLayout = { tabs: [] }
    const result = saveFocusedPaneId(layout, 'pane-1')
    expect(result).toBe(layout)
  })

  it('handles window tab with no workspace layout', () => {
    const layout: WindowLayout = {
      tabs: [{ id: 'tab-1' }],
      activeTabId: 'tab-1',
    }
    const result = saveFocusedPaneId(layout, 'pane-1')
    expect(result).toBe(layout)
  })
})
