/**
 * Unit tests for hierarchical layout persistence functions.
 *
 * Tests the pure functions for:
 * - Stale terminal detection in hierarchical layouts
 * - Reconciliation (replacing stale terminal IDs with respawned ones)
 * - Layout repair (validating and fixing malformed hierarchical trees)
 *
 * @see apps/web/src/panels/window-tab-utils.ts
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
  getStaleTerminalLeavesHierarchical,
  reconcileWindowLayout,
  repairWindowLayout,
} from '../src/panels/window-tab-utils'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeLeaf(
  id: string,
  terminalId?: string,
  workspaceId?: string,
  paneType = 'terminal'
): PanelLeafNode {
  return {
    _tag: 'PanelLeafNode',
    id,
    paneType: paneType as PanelLeafNode['paneType'],
    terminalId,
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
  panelLayout: PanelTreeNode,
  focusedPaneId?: string
): PanelTab {
  return {
    id,
    panelLayout,
    focusedPaneId:
      focusedPaneId ??
      (panelLayout._tag === 'PanelLeafNode' ? panelLayout.id : undefined),
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

function makeLayout(tabs: WindowTab[], activeTabId?: string): WindowLayout {
  return { tabs, activeTabId: activeTabId ?? tabs[0]?.id }
}

// ---------------------------------------------------------------------------
// getStaleTerminalLeavesHierarchical
// ---------------------------------------------------------------------------

describe('getStaleTerminalLeavesHierarchical', () => {
  it('returns empty when no terminals exist', () => {
    const leaf = makeLeaf('pane-1', undefined, 'ws-1')
    const tab = makePanelTab('tab-1', leaf)
    const tile = makeWorkspaceTile('tile-1', 'ws-1', [tab])
    const layout = makeLayout([makeWindowTab('wt-1', tile)])

    const result = getStaleTerminalLeavesHierarchical(layout, new Set())
    expect(result).toEqual([])
  })

  it('returns empty when all terminals are live', () => {
    const leaf = makeLeaf('pane-1', 'term-1', 'ws-1')
    const tab = makePanelTab('tab-1', leaf)
    const tile = makeWorkspaceTile('tile-1', 'ws-1', [tab])
    const layout = makeLayout([makeWindowTab('wt-1', tile)])

    const result = getStaleTerminalLeavesHierarchical(
      layout,
      new Set(['term-1'])
    )
    expect(result).toEqual([])
  })

  it('detects stale terminals in a single pane', () => {
    const leaf = makeLeaf('pane-1', 'term-stale', 'ws-1')
    const tab = makePanelTab('tab-1', leaf)
    const tile = makeWorkspaceTile('tile-1', 'ws-1', [tab])
    const layout = makeLayout([makeWindowTab('wt-1', tile)])

    const result = getStaleTerminalLeavesHierarchical(layout, new Set())
    expect(result).toEqual([
      { paneId: 'pane-1', terminalId: 'term-stale', workspaceId: 'ws-1' },
    ])
  })

  it('detects stale terminals across multiple panel tabs', () => {
    const leaf1 = makeLeaf('pane-1', 'term-1', 'ws-1')
    const leaf2 = makeLeaf('pane-2', 'term-2', 'ws-1')
    const tab1 = makePanelTab('tab-1', leaf1)
    const tab2 = makePanelTab('tab-2', leaf2)
    const tile = makeWorkspaceTile('tile-1', 'ws-1', [tab1, tab2])
    const layout = makeLayout([makeWindowTab('wt-1', tile)])

    const result = getStaleTerminalLeavesHierarchical(
      layout,
      new Set(['term-1'])
    )
    expect(result).toEqual([
      { paneId: 'pane-2', terminalId: 'term-2', workspaceId: 'ws-1' },
    ])
  })

  it('detects stale terminals across multiple window tabs', () => {
    const leaf1 = makeLeaf('pane-1', 'term-1', 'ws-1')
    const leaf2 = makeLeaf('pane-2', 'term-2', 'ws-2')
    const tile1 = makeWorkspaceTile('tile-1', 'ws-1', [
      makePanelTab('tab-1', leaf1),
    ])
    const tile2 = makeWorkspaceTile('tile-2', 'ws-2', [
      makePanelTab('tab-2', leaf2),
    ])
    const layout = makeLayout([
      makeWindowTab('wt-1', tile1),
      makeWindowTab('wt-2', tile2),
    ])

    const result = getStaleTerminalLeavesHierarchical(layout, new Set())
    expect(result).toHaveLength(2)
    expect(result).toContainEqual({
      paneId: 'pane-1',
      terminalId: 'term-1',
      workspaceId: 'ws-1',
    })
    expect(result).toContainEqual({
      paneId: 'pane-2',
      terminalId: 'term-2',
      workspaceId: 'ws-2',
    })
  })

  it('detects stale terminals in nested panel splits', () => {
    const leaf1 = makeLeaf('pane-1', 'term-live', 'ws-1')
    const leaf2 = makeLeaf('pane-2', 'term-stale', 'ws-1')
    const split = makeSplit('split-1', [leaf1, leaf2])
    const tab = makePanelTab('tab-1', split)
    const tile = makeWorkspaceTile('tile-1', 'ws-1', [tab])
    const layout = makeLayout([makeWindowTab('wt-1', tile)])

    const result = getStaleTerminalLeavesHierarchical(
      layout,
      new Set(['term-live'])
    )
    expect(result).toEqual([
      { paneId: 'pane-2', terminalId: 'term-stale', workspaceId: 'ws-1' },
    ])
  })

  it('handles empty layout with no tabs', () => {
    const layout = makeLayout([])
    const result = getStaleTerminalLeavesHierarchical(layout, new Set())
    expect(result).toEqual([])
  })

  it('handles window tab with no workspace layout', () => {
    const layout = makeLayout([makeWindowTab('wt-1')])
    const result = getStaleTerminalLeavesHierarchical(layout, new Set())
    expect(result).toEqual([])
  })

  it('handles workspace tile split (nested workspace tiles)', () => {
    const leaf1 = makeLeaf('pane-1', 'term-1', 'ws-1')
    const leaf2 = makeLeaf('pane-2', 'term-2', 'ws-2')
    const tile1 = makeWorkspaceTile('tile-1', 'ws-1', [
      makePanelTab('tab-1', leaf1),
    ])
    const tile2 = makeWorkspaceTile('tile-2', 'ws-2', [
      makePanelTab('tab-2', leaf2),
    ])
    const tileSplit: WorkspaceTileSplit = {
      _tag: 'WorkspaceTileSplit',
      id: 'ws-split-1',
      direction: 'horizontal',
      children: [tile1, tile2],
      sizes: [50, 50],
    }
    const layout = makeLayout([makeWindowTab('wt-1', tileSplit)])

    const result = getStaleTerminalLeavesHierarchical(layout, new Set())
    expect(result).toHaveLength(2)
  })

  it('skips non-terminal pane types without terminalId', () => {
    const diffLeaf = makeLeaf('pane-diff', undefined, 'ws-1', 'diff')
    const tab = makePanelTab('tab-1', diffLeaf)
    const tile = makeWorkspaceTile('tile-1', 'ws-1', [tab])
    const layout = makeLayout([makeWindowTab('wt-1', tile)])

    const result = getStaleTerminalLeavesHierarchical(layout, new Set())
    expect(result).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// reconcileWindowLayout
// ---------------------------------------------------------------------------

describe('reconcileWindowLayout', () => {
  it('returns the same reference when no changes are needed', () => {
    const leaf = makeLeaf('pane-1', 'term-1', 'ws-1')
    const tab = makePanelTab('tab-1', leaf)
    const tile = makeWorkspaceTile('tile-1', 'ws-1', [tab])
    const layout = makeLayout([makeWindowTab('wt-1', tile)])

    const result = reconcileWindowLayout(layout, new Set(['term-1']), new Map())
    expect(result).toBe(layout)
  })

  it('replaces stale terminal IDs with respawned ones', () => {
    const leaf = makeLeaf('pane-1', 'term-old', 'ws-1')
    const tab = makePanelTab('tab-1', leaf)
    const tile = makeWorkspaceTile('tile-1', 'ws-1', [tab])
    const layout = makeLayout([makeWindowTab('wt-1', tile)])

    const result = reconcileWindowLayout(
      layout,
      new Set(),
      new Map([['term-old', 'term-new']])
    )

    expect(result).not.toBe(layout)
    const reconciledLeaf = (
      result.tabs[0]?.workspaceLayout as WorkspaceTileLeaf
    ).panelTabs[0]?.panelLayout as PanelLeafNode
    expect(reconciledLeaf.terminalId).toBe('term-new')
  })

  it('clears terminal ID when stale but no respawn mapping exists', () => {
    const leaf = makeLeaf('pane-1', 'term-old', 'ws-1')
    const tab = makePanelTab('tab-1', leaf)
    const tile = makeWorkspaceTile('tile-1', 'ws-1', [tab])
    const layout = makeLayout([makeWindowTab('wt-1', tile)])

    const result = reconcileWindowLayout(layout, new Set(), new Map())

    const reconciledLeaf = (
      result.tabs[0]?.workspaceLayout as WorkspaceTileLeaf
    ).panelTabs[0]?.panelLayout as PanelLeafNode
    expect(reconciledLeaf.terminalId).toBeUndefined()
  })

  it('reconciles across multiple panel tabs', () => {
    const leaf1 = makeLeaf('pane-1', 'term-1', 'ws-1')
    const leaf2 = makeLeaf('pane-2', 'term-2', 'ws-1')
    const tab1 = makePanelTab('tab-1', leaf1)
    const tab2 = makePanelTab('tab-2', leaf2)
    const tile = makeWorkspaceTile('tile-1', 'ws-1', [tab1, tab2])
    const layout = makeLayout([makeWindowTab('wt-1', tile)])

    const result = reconcileWindowLayout(
      layout,
      new Set(),
      new Map([
        ['term-1', 'term-new-1'],
        ['term-2', 'term-new-2'],
      ])
    )

    const reconciledTile = result.tabs[0]?.workspaceLayout as WorkspaceTileLeaf
    expect(
      (reconciledTile.panelTabs[0]?.panelLayout as PanelLeafNode).terminalId
    ).toBe('term-new-1')
    expect(
      (reconciledTile.panelTabs[1]?.panelLayout as PanelLeafNode).terminalId
    ).toBe('term-new-2')
  })

  it('reconciles across multiple window tabs', () => {
    const leaf1 = makeLeaf('pane-1', 'term-1', 'ws-1')
    const leaf2 = makeLeaf('pane-2', 'term-2', 'ws-2')
    const tile1 = makeWorkspaceTile('tile-1', 'ws-1', [
      makePanelTab('tab-1', leaf1),
    ])
    const tile2 = makeWorkspaceTile('tile-2', 'ws-2', [
      makePanelTab('tab-2', leaf2),
    ])
    const layout = makeLayout([
      makeWindowTab('wt-1', tile1),
      makeWindowTab('wt-2', tile2),
    ])

    const result = reconcileWindowLayout(
      layout,
      new Set(),
      new Map([
        ['term-1', 'term-new-1'],
        ['term-2', 'term-new-2'],
      ])
    )

    expect(result.tabs).toHaveLength(2)
    const tab1Leaf = (result.tabs[0]?.workspaceLayout as WorkspaceTileLeaf)
      .panelTabs[0]?.panelLayout as PanelLeafNode
    const tab2Leaf = (result.tabs[1]?.workspaceLayout as WorkspaceTileLeaf)
      .panelTabs[0]?.panelLayout as PanelLeafNode
    expect(tab1Leaf.terminalId).toBe('term-new-1')
    expect(tab2Leaf.terminalId).toBe('term-new-2')
  })

  it('preserves live terminals unchanged', () => {
    const liveLeaf = makeLeaf('pane-1', 'term-live', 'ws-1')
    const staleLeaf = makeLeaf('pane-2', 'term-stale', 'ws-1')
    const split = makeSplit('split-1', [liveLeaf, staleLeaf])
    const tab = makePanelTab('tab-1', split)
    const tile = makeWorkspaceTile('tile-1', 'ws-1', [tab])
    const layout = makeLayout([makeWindowTab('wt-1', tile)])

    const result = reconcileWindowLayout(
      layout,
      new Set(['term-live']),
      new Map([['term-stale', 'term-new']])
    )

    const reconciledSplit = (
      result.tabs[0]?.workspaceLayout as WorkspaceTileLeaf
    ).panelTabs[0]?.panelLayout as PanelSplitNode
    expect((reconciledSplit.children[0] as PanelLeafNode).terminalId).toBe(
      'term-live'
    )
    expect((reconciledSplit.children[1] as PanelLeafNode).terminalId).toBe(
      'term-new'
    )
  })

  it('handles empty layout', () => {
    const layout = makeLayout([])
    const result = reconcileWindowLayout(layout, new Set(), new Map())
    expect(result).toBe(layout)
  })

  it('handles workspace tile splits', () => {
    const leaf1 = makeLeaf('pane-1', 'term-1', 'ws-1')
    const leaf2 = makeLeaf('pane-2', 'term-2', 'ws-2')
    const tile1 = makeWorkspaceTile('tile-1', 'ws-1', [
      makePanelTab('tab-1', leaf1),
    ])
    const tile2 = makeWorkspaceTile('tile-2', 'ws-2', [
      makePanelTab('tab-2', leaf2),
    ])
    const tileSplit: WorkspaceTileSplit = {
      _tag: 'WorkspaceTileSplit',
      id: 'ws-split-1',
      direction: 'horizontal',
      children: [tile1, tile2],
      sizes: [50, 50],
    }
    const layout = makeLayout([makeWindowTab('wt-1', tileSplit)])

    const result = reconcileWindowLayout(
      layout,
      new Set(),
      new Map([['term-1', 'term-new-1']])
    )

    const reconciledSplit = result.tabs[0]
      ?.workspaceLayout as WorkspaceTileSplit
    const reconciledTile1 = reconciledSplit.children[0] as WorkspaceTileLeaf
    const reconciledTile2 = reconciledSplit.children[1] as WorkspaceTileLeaf
    expect(
      (reconciledTile1.panelTabs[0]?.panelLayout as PanelLeafNode).terminalId
    ).toBe('term-new-1')
    // term-2 had no mapping, so it becomes undefined
    expect(
      (reconciledTile2.panelTabs[0]?.panelLayout as PanelLeafNode).terminalId
    ).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// repairWindowLayout
// ---------------------------------------------------------------------------

describe('repairWindowLayout', () => {
  it('returns undefined for non-object input', () => {
    expect(repairWindowLayout(null)).toEqual({
      windowLayout: undefined,
      wasRepaired: true,
    })
    expect(repairWindowLayout('string')).toEqual({
      windowLayout: undefined,
      wasRepaired: true,
    })
    expect(repairWindowLayout(42)).toEqual({
      windowLayout: undefined,
      wasRepaired: true,
    })
  })

  it('returns undefined when tabs is not an array', () => {
    expect(repairWindowLayout({ tabs: 'not-array' })).toEqual({
      windowLayout: undefined,
      wasRepaired: true,
    })
  })

  it('returns undefined when all tabs are invalid', () => {
    expect(repairWindowLayout({ tabs: [{ id: '' }, { id: 42 }] })).toEqual({
      windowLayout: undefined,
      wasRepaired: true,
    })
  })

  it('repairs a valid layout without changes', () => {
    const leaf = makeLeaf('pane-1', 'term-1', 'ws-1')
    const tab = makePanelTab('tab-1', leaf)
    const tile = makeWorkspaceTile('tile-1', 'ws-1', [tab])
    const layout = makeLayout([makeWindowTab('wt-1', tile)])

    const result = repairWindowLayout(layout)
    expect(result.wasRepaired).toBe(false)
    expect(result.windowLayout).toEqual(layout)
  })

  it('repairs activeTabId pointing to non-existent tab', () => {
    const leaf = makeLeaf('pane-1')
    const tab = makePanelTab('tab-1', leaf)
    const tile = makeWorkspaceTile('tile-1', 'ws-1', [tab])
    const layout = {
      tabs: [makeWindowTab('wt-1', tile)],
      activeTabId: 'non-existent',
    }

    const result = repairWindowLayout(layout)
    expect(result.wasRepaired).toBe(true)
    expect(result.windowLayout?.activeTabId).toBe('wt-1')
  })

  it('drops invalid window tabs', () => {
    const validLeaf = makeLeaf('pane-1')
    const validTab = makePanelTab('tab-1', validLeaf)
    const validTile = makeWorkspaceTile('tile-1', 'ws-1', [validTab])
    const layout = {
      tabs: [
        makeWindowTab('wt-1', validTile),
        { id: '' }, // invalid — empty id
      ],
      activeTabId: 'wt-1',
    }

    const result = repairWindowLayout(layout)
    expect(result.wasRepaired).toBe(true)
    expect(result.windowLayout?.tabs).toHaveLength(1)
    expect(result.windowLayout?.tabs[0]?.id).toBe('wt-1')
  })

  it('repairs workspace tile with invalid panel tabs', () => {
    const validLeaf = makeLeaf('pane-1')
    const layout = {
      tabs: [
        {
          id: 'wt-1',
          workspaceLayout: {
            _tag: 'WorkspaceTileLeaf',
            id: 'tile-1',
            workspaceId: 'ws-1',
            panelTabs: [
              makePanelTab('tab-1', validLeaf),
              { id: '' }, // invalid tab
            ],
            activePanelTabId: 'tab-1',
          },
        },
      ],
      activeTabId: 'wt-1',
    }

    const result = repairWindowLayout(layout)
    expect(result.wasRepaired).toBe(true)
    const tile = result.windowLayout?.tabs[0]
      ?.workspaceLayout as WorkspaceTileLeaf
    expect(tile.panelTabs).toHaveLength(1)
    expect(tile.panelTabs[0]?.id).toBe('tab-1')
  })

  it('repairs stale activePanelTabId', () => {
    const leaf = makeLeaf('pane-1')
    const tab = makePanelTab('tab-1', leaf)
    const layout = {
      tabs: [
        {
          id: 'wt-1',
          workspaceLayout: {
            _tag: 'WorkspaceTileLeaf',
            id: 'tile-1',
            workspaceId: 'ws-1',
            panelTabs: [tab],
            activePanelTabId: 'non-existent',
          },
        },
      ],
      activeTabId: 'wt-1',
    }

    const result = repairWindowLayout(layout)
    expect(result.wasRepaired).toBe(true)
    const tile = result.windowLayout?.tabs[0]
      ?.workspaceLayout as WorkspaceTileLeaf
    expect(tile.activePanelTabId).toBe('tab-1')
  })

  it('collapses single-child workspace tile splits', () => {
    const leaf = makeLeaf('pane-1')
    const tab = makePanelTab('tab-1', leaf)
    const tile = makeWorkspaceTile('tile-1', 'ws-1', [tab])
    const layout = {
      tabs: [
        {
          id: 'wt-1',
          workspaceLayout: {
            _tag: 'WorkspaceTileSplit',
            id: 'ws-split-1',
            direction: 'horizontal',
            children: [tile],
            sizes: [100],
          },
        },
      ],
      activeTabId: 'wt-1',
    }

    const result = repairWindowLayout(layout)
    expect(result.wasRepaired).toBe(true)
    expect(result.windowLayout?.tabs[0]?.workspaceLayout?._tag).toBe(
      'WorkspaceTileLeaf'
    )
  })

  it('collapses single-child panel split nodes', () => {
    const leaf = makeLeaf('pane-1')
    const layout = {
      tabs: [
        {
          id: 'wt-1',
          workspaceLayout: {
            _tag: 'WorkspaceTileLeaf',
            id: 'tile-1',
            workspaceId: 'ws-1',
            panelTabs: [
              {
                id: 'tab-1',
                panelLayout: {
                  _tag: 'PanelSplitNode',
                  id: 'split-1',
                  direction: 'horizontal',
                  children: [leaf],
                  sizes: [100],
                },
              },
            ],
            activePanelTabId: 'tab-1',
          },
        },
      ],
      activeTabId: 'wt-1',
    }

    const result = repairWindowLayout(layout)
    expect(result.wasRepaired).toBe(true)
    const tile = result.windowLayout?.tabs[0]
      ?.workspaceLayout as WorkspaceTileLeaf
    expect(tile.panelTabs[0]?.panelLayout._tag).toBe('PanelLeafNode')
  })

  it('repairs invalid panel leaf pane types', () => {
    const layout = {
      tabs: [
        {
          id: 'wt-1',
          workspaceLayout: {
            _tag: 'WorkspaceTileLeaf',
            id: 'tile-1',
            workspaceId: 'ws-1',
            panelTabs: [
              {
                id: 'tab-1',
                panelLayout: {
                  _tag: 'PanelLeafNode',
                  id: 'pane-1',
                  paneType: 'invalid-type',
                },
              },
            ],
            activePanelTabId: 'tab-1',
          },
        },
      ],
      activeTabId: 'wt-1',
    }

    const result = repairWindowLayout(layout)
    expect(result.wasRepaired).toBe(true)
    // The invalid pane type causes the panel tab to be dropped
    const tile = result.windowLayout?.tabs[0]
      ?.workspaceLayout as WorkspaceTileLeaf
    expect(tile.panelTabs).toHaveLength(0)
  })

  it('preserves valid diff and review pane types', () => {
    const diffLeaf = makeLeaf('pane-diff', undefined, 'ws-1', 'diff')
    const reviewLeaf = makeLeaf('pane-review', undefined, 'ws-1', 'review')
    const tab1 = makePanelTab('tab-1', diffLeaf)
    const tab2 = makePanelTab('tab-2', reviewLeaf)
    const tile = makeWorkspaceTile('tile-1', 'ws-1', [tab1, tab2])
    const layout = makeLayout([makeWindowTab('wt-1', tile)])

    const result = repairWindowLayout(layout)
    expect(result.wasRepaired).toBe(false)
    expect(result.windowLayout).toEqual(layout)
  })

  it('strips invalid optional fields from panel leaf nodes', () => {
    const layout = {
      tabs: [
        {
          id: 'wt-1',
          workspaceLayout: {
            _tag: 'WorkspaceTileLeaf',
            id: 'tile-1',
            workspaceId: 'ws-1',
            panelTabs: [
              {
                id: 'tab-1',
                panelLayout: {
                  _tag: 'PanelLeafNode',
                  id: 'pane-1',
                  paneType: 'terminal',
                  terminalId: 42, // invalid — should be string
                  workspaceId: 'ws-1',
                },
              },
            ],
            activePanelTabId: 'tab-1',
          },
        },
      ],
      activeTabId: 'wt-1',
    }

    const result = repairWindowLayout(layout)
    expect(result.wasRepaired).toBe(true)
    const tile = result.windowLayout?.tabs[0]
      ?.workspaceLayout as WorkspaceTileLeaf
    const repairedLeaf = tile.panelTabs[0]?.panelLayout as PanelLeafNode
    expect(repairedLeaf.terminalId).toBeUndefined()
    expect(repairedLeaf.workspaceId).toBe('ws-1')
  })

  it('redistributes sizes when invalid', () => {
    const leaf1 = makeLeaf('pane-1')
    const leaf2 = makeLeaf('pane-2')
    const layout = {
      tabs: [
        {
          id: 'wt-1',
          workspaceLayout: {
            _tag: 'WorkspaceTileLeaf',
            id: 'tile-1',
            workspaceId: 'ws-1',
            panelTabs: [
              {
                id: 'tab-1',
                panelLayout: {
                  _tag: 'PanelSplitNode',
                  id: 'split-1',
                  direction: 'horizontal',
                  children: [leaf1, leaf2],
                  sizes: 'not-an-array',
                },
              },
            ],
            activePanelTabId: 'tab-1',
          },
        },
      ],
      activeTabId: 'wt-1',
    }

    const result = repairWindowLayout(layout)
    expect(result.wasRepaired).toBe(true)
    const tile = result.windowLayout?.tabs[0]
      ?.workspaceLayout as WorkspaceTileLeaf
    const split = tile.panelTabs[0]?.panelLayout as PanelSplitNode
    expect(split.sizes).toEqual([50, 50])
  })

  it('handles deeply nested hierarchies', () => {
    const leaf = makeLeaf('pane-1', 'term-1', 'ws-1')
    const tab = makePanelTab('tab-1', leaf)
    const tile1 = makeWorkspaceTile('tile-1', 'ws-1', [tab])
    const tile2 = makeWorkspaceTile('tile-2', 'ws-2', [
      makePanelTab('tab-2', makeLeaf('pane-2', 'term-2', 'ws-2')),
    ])
    const tileSplit: WorkspaceTileSplit = {
      _tag: 'WorkspaceTileSplit',
      id: 'ws-split-1',
      direction: 'horizontal',
      children: [tile1, tile2],
      sizes: [50, 50],
    }
    const layout = makeLayout([
      makeWindowTab('wt-1', tileSplit),
      makeWindowTab('wt-2', tile1),
    ])

    const result = repairWindowLayout(layout)
    expect(result.wasRepaired).toBe(false)
    expect(result.windowLayout).toEqual(layout)
  })
})
