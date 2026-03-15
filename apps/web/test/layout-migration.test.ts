/**
 * Unit tests for layout migration: flat PanelNode → hierarchical WindowLayout.
 *
 * Tests the pure functions in `layout-migration.ts` that convert legacy
 * flat layout trees to the new hierarchical WindowLayout format.
 *
 * @see apps/web/src/panels/layout-migration.ts
 */

import type {
  LeafNode,
  PanelLeafNode,
  PanelNode,
  PanelSplitNode,
  PanelTreeNode,
  SplitNode,
  WorkspaceTileLeaf,
  WorkspaceTileSplit,
} from '@laborer/shared/types'
import { describe, expect, it } from 'vitest'
import {
  collectSidebarFlags,
  convertLeafNode,
  convertPanelTree,
  migrateToWindowLayout,
} from '../src/panels/layout-migration'

// ---------------------------------------------------------------------------
// Test fixtures — OLD (legacy) flat layout types
// ---------------------------------------------------------------------------

/** Create a legacy LeafNode for testing. */
function makeOldLeaf(
  id: string,
  opts?: {
    paneType?: LeafNode['paneType']
    workspaceId?: string
    terminalId?: string
    diffOpen?: boolean
    devServerOpen?: boolean
    devServerTerminalId?: string
  }
): LeafNode {
  return {
    _tag: 'LeafNode',
    id,
    paneType: opts?.paneType ?? 'terminal',
    ...(opts?.workspaceId !== undefined
      ? { workspaceId: opts.workspaceId }
      : {}),
    ...(opts?.terminalId !== undefined ? { terminalId: opts.terminalId } : {}),
    ...(opts?.diffOpen !== undefined ? { diffOpen: opts.diffOpen } : {}),
    ...(opts?.devServerOpen !== undefined
      ? { devServerOpen: opts.devServerOpen }
      : {}),
    ...(opts?.devServerTerminalId !== undefined
      ? { devServerTerminalId: opts.devServerTerminalId }
      : {}),
  }
}

/** Create a legacy SplitNode for testing. */
function makeOldSplit(
  id: string,
  direction: 'horizontal' | 'vertical',
  children: PanelNode[],
  sizes?: number[]
): SplitNode {
  return {
    _tag: 'SplitNode',
    id,
    direction,
    children,
    sizes: sizes ?? children.map(() => 100 / children.length),
  }
}

// ---------------------------------------------------------------------------
// convertLeafNode
// ---------------------------------------------------------------------------

describe('convertLeafNode', () => {
  it('converts a simple terminal leaf', () => {
    const old = makeOldLeaf('leaf-1', { paneType: 'terminal' })
    const result = convertLeafNode(old)

    expect(result).toStrictEqual({
      _tag: 'PanelLeafNode',
      id: 'leaf-1',
      paneType: 'terminal',
    })
  })

  it('preserves terminalId', () => {
    const old = makeOldLeaf('leaf-1', {
      terminalId: 'term-1',
    })
    const result = convertLeafNode(old)

    expect(result._tag).toBe('PanelLeafNode')
    expect(result.terminalId).toBe('term-1')
  })

  it('preserves workspaceId', () => {
    const old = makeOldLeaf('leaf-1', {
      workspaceId: 'ws-1',
    })
    const result = convertLeafNode(old)

    expect(result._tag).toBe('PanelLeafNode')
    expect(result.workspaceId).toBe('ws-1')
  })

  it('preserves both terminalId and workspaceId', () => {
    const old = makeOldLeaf('leaf-1', {
      terminalId: 'term-1',
      workspaceId: 'ws-1',
    })
    const result = convertLeafNode(old)

    expect(result._tag).toBe('PanelLeafNode')
    expect(result.terminalId).toBe('term-1')
    expect(result.workspaceId).toBe('ws-1')
  })

  it('strips diffOpen flag', () => {
    const old = makeOldLeaf('leaf-1', {
      diffOpen: true,
      workspaceId: 'ws-1',
    })
    const result = convertLeafNode(old)

    expect(result._tag).toBe('PanelLeafNode')
    expect('diffOpen' in result).toBe(false)
  })

  it('strips devServerOpen flag', () => {
    const old = makeOldLeaf('leaf-1', {
      devServerOpen: true,
      devServerTerminalId: 'dev-term-1',
    })
    const result = convertLeafNode(old)

    expect(result._tag).toBe('PanelLeafNode')
    expect('devServerOpen' in result).toBe(false)
    expect('devServerTerminalId' in result).toBe(false)
  })

  it('preserves diff paneType for non-terminal leaves', () => {
    const old = makeOldLeaf('leaf-1', { paneType: 'diff' })
    const result = convertLeafNode(old)

    expect(result.paneType).toBe('diff')
  })

  it('preserves review paneType', () => {
    const old = makeOldLeaf('leaf-1', { paneType: 'review' })
    const result = convertLeafNode(old)

    expect(result.paneType).toBe('review')
  })

  it('preserves devServerTerminal paneType', () => {
    const old = makeOldLeaf('leaf-1', {
      paneType: 'devServerTerminal',
      terminalId: 'dev-1',
    })
    const result = convertLeafNode(old)

    expect(result.paneType).toBe('devServerTerminal')
    expect(result.terminalId).toBe('dev-1')
  })
})

// ---------------------------------------------------------------------------
// convertPanelTree
// ---------------------------------------------------------------------------

describe('convertPanelTree', () => {
  it('converts a single leaf', () => {
    const old = makeOldLeaf('leaf-1', {
      workspaceId: 'ws-1',
      terminalId: 'term-1',
    })
    const result = convertPanelTree(old)

    expect(result._tag).toBe('PanelLeafNode')
    expect(result.id).toBe('leaf-1')
  })

  it('converts a split with two leaves', () => {
    const old = makeOldSplit('split-1', 'horizontal', [
      makeOldLeaf('leaf-1', { workspaceId: 'ws-1' }),
      makeOldLeaf('leaf-2', { workspaceId: 'ws-1' }),
    ])
    const result = convertPanelTree(old)

    expect(result._tag).toBe('PanelSplitNode')
    const split = result as PanelSplitNode
    expect(split.direction).toBe('horizontal')
    expect(split.children).toHaveLength(2)
    expect(split.children[0]?._tag).toBe('PanelLeafNode')
    expect(split.children[1]?._tag).toBe('PanelLeafNode')
  })

  it('preserves sizes from the old split', () => {
    const old = makeOldSplit(
      'split-1',
      'vertical',
      [makeOldLeaf('leaf-1'), makeOldLeaf('leaf-2')],
      [30, 70]
    )
    const result = convertPanelTree(old) as PanelSplitNode

    expect(result.sizes).toStrictEqual([30, 70])
  })

  it('converts nested splits recursively', () => {
    const old = makeOldSplit('split-1', 'horizontal', [
      makeOldLeaf('leaf-1'),
      makeOldSplit('split-2', 'vertical', [
        makeOldLeaf('leaf-2'),
        makeOldLeaf('leaf-3'),
      ]),
    ])
    const result = convertPanelTree(old)

    expect(result._tag).toBe('PanelSplitNode')
    const outer = result as PanelSplitNode
    expect(outer.children[1]?._tag).toBe('PanelSplitNode')
    const inner = outer.children[1] as PanelSplitNode
    expect(inner.direction).toBe('vertical')
    expect(inner.children).toHaveLength(2)
  })

  it('strips sidebar flags from all leaves in a nested tree', () => {
    const old = makeOldSplit('split-1', 'horizontal', [
      makeOldLeaf('leaf-1', { diffOpen: true, workspaceId: 'ws-1' }),
      makeOldLeaf('leaf-2', {
        devServerOpen: true,
        devServerTerminalId: 'dev-1',
        workspaceId: 'ws-1',
      }),
    ])
    const result = convertPanelTree(old) as PanelSplitNode

    for (const child of result.children) {
      expect('diffOpen' in child).toBe(false)
      expect('devServerOpen' in child).toBe(false)
      expect('devServerTerminalId' in child).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// collectSidebarFlags
// ---------------------------------------------------------------------------

describe('collectSidebarFlags', () => {
  it('returns false for leaf without flags', () => {
    const leaf = makeOldLeaf('leaf-1')
    const flags = collectSidebarFlags(leaf)

    expect(flags.diffOpen).toBe(false)
    expect(flags.devServerOpen).toBe(false)
    expect(flags.devServerTerminalId).toBeUndefined()
  })

  it('detects diffOpen on a leaf', () => {
    const leaf = makeOldLeaf('leaf-1', { diffOpen: true })
    const flags = collectSidebarFlags(leaf)

    expect(flags.diffOpen).toBe(true)
  })

  it('detects devServerOpen on a leaf', () => {
    const leaf = makeOldLeaf('leaf-1', {
      devServerOpen: true,
      devServerTerminalId: 'dev-1',
    })
    const flags = collectSidebarFlags(leaf)

    expect(flags.devServerOpen).toBe(true)
    expect(flags.devServerTerminalId).toBe('dev-1')
  })

  it('aggregates flags from children in a split', () => {
    const split = makeOldSplit('split-1', 'horizontal', [
      makeOldLeaf('leaf-1', { diffOpen: true }),
      makeOldLeaf('leaf-2', {
        devServerOpen: true,
        devServerTerminalId: 'dev-1',
      }),
    ])
    const flags = collectSidebarFlags(split)

    expect(flags.diffOpen).toBe(true)
    expect(flags.devServerOpen).toBe(true)
    expect(flags.devServerTerminalId).toBe('dev-1')
  })

  it('aggregates flags from deeply nested splits', () => {
    const tree = makeOldSplit('split-1', 'horizontal', [
      makeOldLeaf('leaf-1'),
      makeOldSplit('split-2', 'vertical', [
        makeOldLeaf('leaf-2'),
        makeOldLeaf('leaf-3', { diffOpen: true }),
      ]),
    ])
    const flags = collectSidebarFlags(tree)

    expect(flags.diffOpen).toBe(true)
    expect(flags.devServerOpen).toBe(false)
  })

  it('treats diffOpen: false as false', () => {
    const leaf = makeOldLeaf('leaf-1', { diffOpen: false })
    const flags = collectSidebarFlags(leaf)

    expect(flags.diffOpen).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// migrateToWindowLayout
// ---------------------------------------------------------------------------

describe('migrateToWindowLayout', () => {
  describe('single workspace', () => {
    it('migrates a single-leaf tree to one window tab with one workspace tile and one panel tab', () => {
      const oldTree = makeOldLeaf('leaf-1', {
        workspaceId: 'ws-1',
        terminalId: 'term-1',
      })
      const result = migrateToWindowLayout(oldTree, 'leaf-1', null)

      // One window tab
      expect(result.tabs).toHaveLength(1)
      expect(result.activeTabId).toBe(result.tabs[0]?.id)

      // Workspace layout is a single leaf (not a split)
      const tab = result.tabs[0]
      expect(tab?.workspaceLayout?._tag).toBe('WorkspaceTileLeaf')

      const tile = tab?.workspaceLayout as WorkspaceTileLeaf
      expect(tile.workspaceId).toBe('ws-1')

      // One panel tab
      expect(tile.panelTabs).toHaveLength(1)
      expect(tile.activePanelTabId).toBe(tile.panelTabs[0]?.id)

      // Panel tab contains the converted tree
      const panelTab = tile.panelTabs[0]
      expect(panelTab?.panelLayout._tag).toBe('PanelLeafNode')
      const leaf = panelTab?.panelLayout as PanelLeafNode
      expect(leaf.terminalId).toBe('term-1')
      expect(leaf.paneType).toBe('terminal')
    })

    it('migrates a split tree within a single workspace', () => {
      const oldTree = makeOldSplit('split-1', 'horizontal', [
        makeOldLeaf('leaf-1', {
          workspaceId: 'ws-1',
          terminalId: 'term-1',
        }),
        makeOldLeaf('leaf-2', {
          workspaceId: 'ws-1',
          terminalId: 'term-2',
        }),
      ])
      const result = migrateToWindowLayout(oldTree, 'leaf-2', null)

      const tab = result.tabs[0]
      const tile = tab?.workspaceLayout as WorkspaceTileLeaf

      // One panel tab with a split tree inside
      expect(tile.panelTabs).toHaveLength(1)
      const panelTab = tile.panelTabs[0]
      expect(panelTab?.panelLayout._tag).toBe('PanelSplitNode')
      const split = panelTab?.panelLayout as PanelSplitNode
      expect(split.children).toHaveLength(2)
    })

    it('preserves activePaneId as focusedPaneId in the main panel tab', () => {
      const oldTree = makeOldSplit('split-1', 'horizontal', [
        makeOldLeaf('leaf-1', { workspaceId: 'ws-1' }),
        makeOldLeaf('leaf-2', { workspaceId: 'ws-1' }),
      ])
      const result = migrateToWindowLayout(oldTree, 'leaf-2', null)

      const tile = result.tabs[0]?.workspaceLayout as WorkspaceTileLeaf
      const panelTab = tile.panelTabs[0]
      expect(panelTab?.focusedPaneId).toBe('leaf-2')
    })

    it('falls back to first leaf when activePaneId is null', () => {
      const oldTree = makeOldLeaf('leaf-1', { workspaceId: 'ws-1' })
      const result = migrateToWindowLayout(oldTree, null, null)

      const tile = result.tabs[0]?.workspaceLayout as WorkspaceTileLeaf
      const panelTab = tile.panelTabs[0]
      expect(panelTab?.focusedPaneId).toBe('leaf-1')
    })

    it('falls back to first leaf when activePaneId points to a different workspace', () => {
      const oldTree = makeOldSplit('split-1', 'horizontal', [
        makeOldLeaf('leaf-1', { workspaceId: 'ws-1' }),
        makeOldLeaf('leaf-2', { workspaceId: 'ws-2' }),
      ])
      const result = migrateToWindowLayout(oldTree, 'leaf-2', null)

      // ws-1's panel tab should fall back to leaf-1 (first leaf in ws-1's sub-tree)
      const layout = result.tabs[0]?.workspaceLayout
      let ws1Tile: WorkspaceTileLeaf | undefined
      if (layout?._tag === 'WorkspaceTileSplit') {
        ws1Tile = layout.children.find(
          (c) => c._tag === 'WorkspaceTileLeaf' && c.workspaceId === 'ws-1'
        ) as WorkspaceTileLeaf | undefined
      }
      if (ws1Tile) {
        expect(ws1Tile.panelTabs[0]?.focusedPaneId).toBe('leaf-1')
      }
    })
  })

  describe('sidebar flag promotion', () => {
    it('creates an additional diff panel tab when diffOpen is true', () => {
      const oldTree = makeOldLeaf('leaf-1', {
        workspaceId: 'ws-1',
        terminalId: 'term-1',
        diffOpen: true,
      })
      const result = migrateToWindowLayout(oldTree, 'leaf-1', null)

      const tile = result.tabs[0]?.workspaceLayout as WorkspaceTileLeaf
      expect(tile.panelTabs).toHaveLength(2)

      // First tab is the main terminal tab
      expect(tile.panelTabs[0]?.label).toBe('Terminal')

      // Second tab is the diff tab
      const diffTab = tile.panelTabs[1]
      expect(diffTab?.label).toBe('Diff')
      expect(diffTab?.panelLayout._tag).toBe('PanelLeafNode')
      expect((diffTab?.panelLayout as PanelLeafNode).paneType).toBe('diff')
      expect((diffTab?.panelLayout as PanelLeafNode).workspaceId).toBe('ws-1')
    })

    it('creates an additional devServer panel tab when devServerOpen is true', () => {
      const oldTree = makeOldLeaf('leaf-1', {
        workspaceId: 'ws-1',
        devServerOpen: true,
        devServerTerminalId: 'dev-term-1',
      })
      const result = migrateToWindowLayout(oldTree, 'leaf-1', null)

      const tile = result.tabs[0]?.workspaceLayout as WorkspaceTileLeaf
      expect(tile.panelTabs).toHaveLength(2)

      const devServerTab = tile.panelTabs[1]
      expect(devServerTab?.label).toBe('Dev Server')
      expect(devServerTab?.panelLayout._tag).toBe('PanelLeafNode')
      const devLeaf = devServerTab?.panelLayout as PanelLeafNode
      expect(devLeaf.paneType).toBe('devServerTerminal')
      expect(devLeaf.terminalId).toBe('dev-term-1')
      expect(devLeaf.workspaceId).toBe('ws-1')
    })

    it('creates both diff and devServer tabs when both flags are true', () => {
      const oldTree = makeOldLeaf('leaf-1', {
        workspaceId: 'ws-1',
        diffOpen: true,
        devServerOpen: true,
        devServerTerminalId: 'dev-term-1',
      })
      const result = migrateToWindowLayout(oldTree, 'leaf-1', null)

      const tile = result.tabs[0]?.workspaceLayout as WorkspaceTileLeaf
      expect(tile.panelTabs).toHaveLength(3)
      expect(tile.panelTabs[0]?.label).toBe('Terminal')
      expect(tile.panelTabs[1]?.label).toBe('Diff')
      expect(tile.panelTabs[2]?.label).toBe('Dev Server')
    })

    it('does not create additional tabs when sidebar flags are false', () => {
      const oldTree = makeOldLeaf('leaf-1', {
        workspaceId: 'ws-1',
        diffOpen: false,
        devServerOpen: false,
      })
      const result = migrateToWindowLayout(oldTree, 'leaf-1', null)

      const tile = result.tabs[0]?.workspaceLayout as WorkspaceTileLeaf
      expect(tile.panelTabs).toHaveLength(1)
    })

    it('main tab remains active even when sidebar tabs are created', () => {
      const oldTree = makeOldLeaf('leaf-1', {
        workspaceId: 'ws-1',
        diffOpen: true,
        devServerOpen: true,
      })
      const result = migrateToWindowLayout(oldTree, 'leaf-1', null)

      const tile = result.tabs[0]?.workspaceLayout as WorkspaceTileLeaf
      expect(tile.activePanelTabId).toBe(tile.panelTabs[0]?.id)
    })

    it('handles devServerOpen without devServerTerminalId', () => {
      const oldTree = makeOldLeaf('leaf-1', {
        workspaceId: 'ws-1',
        devServerOpen: true,
      })
      const result = migrateToWindowLayout(oldTree, 'leaf-1', null)

      const tile = result.tabs[0]?.workspaceLayout as WorkspaceTileLeaf
      const devTab = tile.panelTabs[1]
      const devLeaf = devTab?.panelLayout as PanelLeafNode
      expect(devLeaf.terminalId).toBeUndefined()
    })

    it('extracts sidebar flags from split children', () => {
      const oldTree = makeOldSplit('split-1', 'horizontal', [
        makeOldLeaf('leaf-1', {
          workspaceId: 'ws-1',
          diffOpen: true,
        }),
        makeOldLeaf('leaf-2', {
          workspaceId: 'ws-1',
          devServerOpen: true,
          devServerTerminalId: 'dev-1',
        }),
      ])
      const result = migrateToWindowLayout(oldTree, 'leaf-1', null)

      const tile = result.tabs[0]?.workspaceLayout as WorkspaceTileLeaf
      expect(tile.panelTabs).toHaveLength(3)
      expect(tile.panelTabs[0]?.label).toBe('Terminal')
      expect(tile.panelTabs[1]?.label).toBe('Diff')
      expect(tile.panelTabs[2]?.label).toBe('Dev Server')
    })
  })

  describe('multi-workspace', () => {
    it('migrates a multi-workspace tree to one window tab with multiple workspace tiles', () => {
      const oldTree = makeOldSplit('split-1', 'horizontal', [
        makeOldLeaf('leaf-1', {
          workspaceId: 'ws-1',
          terminalId: 'term-1',
        }),
        makeOldLeaf('leaf-2', {
          workspaceId: 'ws-2',
          terminalId: 'term-2',
        }),
      ])
      const result = migrateToWindowLayout(oldTree, 'leaf-1', null)

      // One window tab
      expect(result.tabs).toHaveLength(1)

      // Workspace layout is a split with two leaves
      const layout = result.tabs[0]?.workspaceLayout
      expect(layout?._tag).toBe('WorkspaceTileSplit')

      const split = layout as WorkspaceTileSplit
      expect(split.direction).toBe('horizontal')
      expect(split.children).toHaveLength(2)

      const ws1 = split.children[0] as WorkspaceTileLeaf
      const ws2 = split.children[1] as WorkspaceTileLeaf
      expect(ws1.workspaceId).toBe('ws-1')
      expect(ws2.workspaceId).toBe('ws-2')

      // Each workspace has one panel tab
      expect(ws1.panelTabs).toHaveLength(1)
      expect(ws2.panelTabs).toHaveLength(1)
    })

    it('creates equal sizes for workspace tiles', () => {
      const oldTree = makeOldSplit('split-1', 'horizontal', [
        makeOldLeaf('leaf-1', { workspaceId: 'ws-1' }),
        makeOldLeaf('leaf-2', { workspaceId: 'ws-2' }),
        makeOldLeaf('leaf-3', { workspaceId: 'ws-3' }),
      ])
      const result = migrateToWindowLayout(oldTree, null, null)

      const split = result.tabs[0]?.workspaceLayout as WorkspaceTileSplit
      expect(split.sizes).toHaveLength(3)
      for (const size of split.sizes) {
        expect(size).toBeCloseTo(100 / 3)
      }
    })

    it('respects workspaceOrder for tile ordering', () => {
      const oldTree = makeOldSplit('split-1', 'horizontal', [
        makeOldLeaf('leaf-1', { workspaceId: 'ws-a' }),
        makeOldLeaf('leaf-2', { workspaceId: 'ws-b' }),
        makeOldLeaf('leaf-3', { workspaceId: 'ws-c' }),
      ])
      const result = migrateToWindowLayout(oldTree, null, [
        'ws-c',
        'ws-a',
        'ws-b',
      ])

      const split = result.tabs[0]?.workspaceLayout as WorkspaceTileSplit
      expect((split.children[0] as WorkspaceTileLeaf).workspaceId).toBe('ws-c')
      expect((split.children[1] as WorkspaceTileLeaf).workspaceId).toBe('ws-a')
      expect((split.children[2] as WorkspaceTileLeaf).workspaceId).toBe('ws-b')
    })

    it('handles partial workspaceOrder (unmatched come after matched)', () => {
      const oldTree = makeOldSplit('split-1', 'horizontal', [
        makeOldLeaf('leaf-1', { workspaceId: 'ws-a' }),
        makeOldLeaf('leaf-2', { workspaceId: 'ws-b' }),
        makeOldLeaf('leaf-3', { workspaceId: 'ws-c' }),
      ])
      const result = migrateToWindowLayout(oldTree, null, ['ws-c'])

      const split = result.tabs[0]?.workspaceLayout as WorkspaceTileSplit
      // ws-c should be first, then ws-a and ws-b in original order
      expect((split.children[0] as WorkspaceTileLeaf).workspaceId).toBe('ws-c')
    })

    it("activePaneId maps to the correct workspace's focusedPaneId", () => {
      const oldTree = makeOldSplit('split-1', 'horizontal', [
        makeOldLeaf('leaf-1', { workspaceId: 'ws-1' }),
        makeOldLeaf('leaf-2', { workspaceId: 'ws-2' }),
      ])
      const result = migrateToWindowLayout(oldTree, 'leaf-2', null)

      const split = result.tabs[0]?.workspaceLayout as WorkspaceTileSplit
      const ws1 = split.children[0] as WorkspaceTileLeaf
      const ws2 = split.children[1] as WorkspaceTileLeaf

      // ws-1 should NOT have leaf-2 as focused (it belongs to ws-2)
      expect(ws1.panelTabs[0]?.focusedPaneId).toBe('leaf-1')
      // ws-2 should have leaf-2 as focused
      expect(ws2.panelTabs[0]?.focusedPaneId).toBe('leaf-2')
    })

    it('handles multi-workspace with mixed sidebar flags', () => {
      const oldTree = makeOldSplit('split-1', 'horizontal', [
        makeOldLeaf('leaf-1', {
          workspaceId: 'ws-1',
          diffOpen: true,
        }),
        makeOldLeaf('leaf-2', {
          workspaceId: 'ws-2',
          devServerOpen: true,
          devServerTerminalId: 'dev-1',
        }),
      ])
      const result = migrateToWindowLayout(oldTree, null, null)

      const split = result.tabs[0]?.workspaceLayout as WorkspaceTileSplit
      const ws1 = split.children[0] as WorkspaceTileLeaf
      const ws2 = split.children[1] as WorkspaceTileLeaf

      // ws-1 has terminal + diff tabs
      expect(ws1.panelTabs).toHaveLength(2)
      expect(ws1.panelTabs[1]?.label).toBe('Diff')

      // ws-2 has terminal + devServer tabs
      expect(ws2.panelTabs).toHaveLength(2)
      expect(ws2.panelTabs[1]?.label).toBe('Dev Server')
    })
  })

  describe('edge cases', () => {
    it('handles a tree with leaves that have no workspaceId', () => {
      const oldTree = makeOldLeaf('leaf-1', { paneType: 'terminal' })
      const result = migrateToWindowLayout(oldTree, 'leaf-1', null)

      // Leaves without a workspaceId are dropped during migration
      expect(result.tabs).toHaveLength(1)
      expect(result.tabs[0]?.workspaceLayout).toBeUndefined()
    })

    it('handles nested splits within a single workspace', () => {
      const oldTree = makeOldSplit('split-1', 'vertical', [
        makeOldLeaf('leaf-1', { workspaceId: 'ws-1' }),
        makeOldSplit('split-2', 'horizontal', [
          makeOldLeaf('leaf-2', { workspaceId: 'ws-1' }),
          makeOldLeaf('leaf-3', { workspaceId: 'ws-1' }),
        ]),
      ])
      const result = migrateToWindowLayout(oldTree, 'leaf-2', null)

      // Single workspace tile (not a split of tiles)
      const tile = result.tabs[0]?.workspaceLayout as WorkspaceTileLeaf
      expect(tile._tag).toBe('WorkspaceTileLeaf')

      // Panel tab contains a split tree
      const panelLayout = tile.panelTabs[0]?.panelLayout
      expect(panelLayout?._tag).toBe('PanelSplitNode')
    })

    it('handles deeply nested multi-workspace tree', () => {
      // ws-1 and ws-2 interleaved in a complex split tree
      const oldTree = makeOldSplit('split-1', 'horizontal', [
        makeOldSplit('split-2', 'vertical', [
          makeOldLeaf('leaf-1', {
            workspaceId: 'ws-1',
            terminalId: 'term-1',
          }),
          makeOldLeaf('leaf-2', {
            workspaceId: 'ws-2',
            terminalId: 'term-2',
          }),
        ]),
        makeOldLeaf('leaf-3', {
          workspaceId: 'ws-1',
          terminalId: 'term-3',
        }),
      ])
      const result = migrateToWindowLayout(oldTree, 'leaf-1', null)

      const layout = result.tabs[0]?.workspaceLayout
      expect(layout?._tag).toBe('WorkspaceTileSplit')

      const split = layout as WorkspaceTileSplit
      expect(split.children).toHaveLength(2)

      // Verify both workspaces are present
      const workspaceIds = split.children.map(
        (c) => (c as WorkspaceTileLeaf).workspaceId
      )
      expect(workspaceIds).toContain('ws-1')
      expect(workspaceIds).toContain('ws-2')
    })

    it('handles empty workspaceOrder (same as null)', () => {
      const oldTree = makeOldSplit('split-1', 'horizontal', [
        makeOldLeaf('leaf-1', { workspaceId: 'ws-a' }),
        makeOldLeaf('leaf-2', { workspaceId: 'ws-b' }),
      ])
      const result1 = migrateToWindowLayout(oldTree, null, null)
      const result2 = migrateToWindowLayout(oldTree, null, [])

      const split1 = result1.tabs[0]?.workspaceLayout as WorkspaceTileSplit
      const split2 = result2.tabs[0]?.workspaceLayout as WorkspaceTileSplit

      // Same workspace ordering
      expect((split1.children[0] as WorkspaceTileLeaf).workspaceId).toBe(
        (split2.children[0] as WorkspaceTileLeaf).workspaceId
      )
    })

    it('output structure has correct tags at every level', () => {
      const oldTree = makeOldLeaf('leaf-1', {
        workspaceId: 'ws-1',
        terminalId: 'term-1',
      })
      const result = migrateToWindowLayout(oldTree, 'leaf-1', null)

      // WindowLayout
      expect(result.tabs).toBeDefined()
      expect(result.activeTabId).toBeDefined()

      // WindowTab
      const tab = result.tabs[0]
      expect(tab?.id).toBeDefined()

      // WorkspaceTileLeaf
      const tile = tab?.workspaceLayout as WorkspaceTileLeaf
      expect(tile._tag).toBe('WorkspaceTileLeaf')

      // PanelTab
      const panelTab = tile.panelTabs[0]
      expect(panelTab?.id).toBeDefined()
      expect(panelTab?.panelLayout).toBeDefined()

      // PanelLeafNode
      const leaf = panelTab?.panelLayout as PanelLeafNode
      expect(leaf._tag).toBe('PanelLeafNode')
    })

    it('does not mutate the input tree', () => {
      const leaf1 = makeOldLeaf('leaf-1', {
        workspaceId: 'ws-1',
        diffOpen: true,
      })
      const oldTree = makeOldSplit('split-1', 'horizontal', [
        leaf1,
        makeOldLeaf('leaf-2', { workspaceId: 'ws-2' }),
      ])

      // Snapshot the old tree
      const snapshot = JSON.parse(JSON.stringify(oldTree))

      migrateToWindowLayout(oldTree, 'leaf-1', null)

      // Old tree should be unchanged
      expect(oldTree).toStrictEqual(snapshot)
    })

    it('handles a tree where all workspaces have diffOpen', () => {
      const oldTree = makeOldSplit('split-1', 'horizontal', [
        makeOldLeaf('leaf-1', {
          workspaceId: 'ws-1',
          diffOpen: true,
        }),
        makeOldLeaf('leaf-2', {
          workspaceId: 'ws-2',
          diffOpen: true,
        }),
      ])
      const result = migrateToWindowLayout(oldTree, null, null)

      const split = result.tabs[0]?.workspaceLayout as WorkspaceTileSplit
      const ws1 = split.children[0] as WorkspaceTileLeaf
      const ws2 = split.children[1] as WorkspaceTileLeaf

      // Both workspaces should have 2 panel tabs
      expect(ws1.panelTabs).toHaveLength(2)
      expect(ws2.panelTabs).toHaveLength(2)
    })

    it('produces valid IDs (no duplicates) across workspaces', () => {
      const oldTree = makeOldSplit('split-1', 'horizontal', [
        makeOldLeaf('leaf-1', {
          workspaceId: 'ws-1',
          diffOpen: true,
          devServerOpen: true,
        }),
        makeOldLeaf('leaf-2', {
          workspaceId: 'ws-2',
          diffOpen: true,
          devServerOpen: true,
        }),
      ])
      const result = migrateToWindowLayout(oldTree, null, null)

      // Collect all IDs
      const ids = new Set<string>()
      for (const tab of result.tabs) {
        ids.add(tab.id)
        if (!tab.workspaceLayout) {
          continue
        }
        collectAllIds(tab.workspaceLayout, ids)
      }

      // All IDs should be unique (set size equals total count)
      const idArray: string[] = []
      for (const tab of result.tabs) {
        idArray.push(tab.id)
        if (!tab.workspaceLayout) {
          continue
        }
        collectAllIdsToArray(tab.workspaceLayout, idArray)
      }
      expect(ids.size).toBe(idArray.length)
    })
  })

  describe('round-trip structure', () => {
    it('migrated layout matches expected structure for a complex tree', () => {
      const oldTree = makeOldSplit('split-root', 'horizontal', [
        makeOldSplit('split-ws1', 'vertical', [
          makeOldLeaf('leaf-1', {
            workspaceId: 'ws-1',
            terminalId: 'term-1',
          }),
          makeOldLeaf('leaf-2', {
            workspaceId: 'ws-1',
            terminalId: 'term-2',
            diffOpen: true,
          }),
        ]),
        makeOldLeaf('leaf-3', {
          workspaceId: 'ws-2',
          terminalId: 'term-3',
          devServerOpen: true,
          devServerTerminalId: 'dev-term-1',
        }),
      ])
      const result = migrateToWindowLayout(oldTree, 'leaf-2', ['ws-2', 'ws-1'])

      // Workspaces should be ordered per workspaceOrder: ws-2 first
      const split = result.tabs[0]?.workspaceLayout as WorkspaceTileSplit
      const firstTile = split.children[0] as WorkspaceTileLeaf
      const secondTile = split.children[1] as WorkspaceTileLeaf

      expect(firstTile.workspaceId).toBe('ws-2')
      expect(secondTile.workspaceId).toBe('ws-1')

      // ws-2 should have terminal + devServer tabs
      expect(firstTile.panelTabs).toHaveLength(2)
      expect(firstTile.panelTabs[1]?.label).toBe('Dev Server')

      // ws-1 should have terminal + diff tabs
      expect(secondTile.panelTabs).toHaveLength(2)
      expect(secondTile.panelTabs[1]?.label).toBe('Diff')

      // ws-1's main panel tab should have a split tree with 2 leaves
      const ws1MainTab = secondTile.panelTabs[0]
      expect(ws1MainTab?.panelLayout._tag).toBe('PanelSplitNode')
      const ws1Split = ws1MainTab?.panelLayout as PanelSplitNode
      expect(ws1Split.children).toHaveLength(2)

      // activePaneId leaf-2 belongs to ws-1, should be focused there
      expect(ws1MainTab?.focusedPaneId).toBe('leaf-2')
    })
  })
})

// ---------------------------------------------------------------------------
// Helpers for collecting IDs (used in uniqueness test)
// ---------------------------------------------------------------------------

function collectAllIds(
  node: import('@laborer/shared/types').WorkspaceTileNode,
  ids: Set<string>
): void {
  if (node._tag === 'WorkspaceTileLeaf') {
    ids.add(node.id)
    for (const tab of node.panelTabs) {
      ids.add(tab.id)
      collectPanelTreeIds(tab.panelLayout, ids)
    }
    return
  }
  ids.add(node.id)
  for (const child of node.children) {
    collectAllIds(child, ids)
  }
}

function collectAllIdsToArray(
  node: import('@laborer/shared/types').WorkspaceTileNode,
  arr: string[]
): void {
  if (node._tag === 'WorkspaceTileLeaf') {
    arr.push(node.id)
    for (const tab of node.panelTabs) {
      arr.push(tab.id)
      collectPanelTreeIdsToArray(tab.panelLayout, arr)
    }
    return
  }
  arr.push(node.id)
  for (const child of node.children) {
    collectAllIdsToArray(child, arr)
  }
}

function collectPanelTreeIds(node: PanelTreeNode, ids: Set<string>): void {
  ids.add(node.id)
  if (node._tag === 'PanelSplitNode') {
    for (const child of node.children) {
      collectPanelTreeIds(child, ids)
    }
  }
}

function collectPanelTreeIdsToArray(node: PanelTreeNode, arr: string[]): void {
  arr.push(node.id)
  if (node._tag === 'PanelSplitNode') {
    for (const child of node.children) {
      collectPanelTreeIdsToArray(child, arr)
    }
  }
}
