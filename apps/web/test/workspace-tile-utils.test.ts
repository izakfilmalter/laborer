/**
 * Unit tests for workspace tile layout manipulation utilities.
 *
 * Tests the pure functions in `workspace-tile-utils.ts` that operate on the
 * workspace tile tree within a WindowTab to support adding, removing,
 * splitting, resizing, and reordering workspace tiles.
 *
 * @see apps/web/src/panels/workspace-tile-utils.ts
 */

import type {
  PanelLeafNode,
  PanelTab,
  WindowTab,
  WorkspaceTileLeaf,
  WorkspaceTileNode,
  WorkspaceTileSplit,
} from '@laborer/shared/types'
import { describe, expect, it } from 'vitest'
import {
  addWorkspaceToTab,
  removeWorkspaceFromTab,
  reorderWorkspaceTiles,
  resizeWorkspaceTiles,
  splitWorkspaceTile,
} from '../src/panels/workspace-tile-utils'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** A panel leaf node for use in fixtures. */
function makeLeaf(id: string, terminalId?: string): PanelLeafNode {
  return {
    _tag: 'PanelLeafNode',
    id,
    paneType: 'terminal',
    terminalId,
  }
}

/** A panel tab wrapping a single leaf. */
function makePanelTab(id: string, leaf: PanelLeafNode): PanelTab {
  return {
    id,
    panelLayout: leaf,
    focusedPaneId: leaf.id,
  }
}

/** A workspace tile leaf with panel tabs. */
function makeTile(
  id: string,
  workspaceId: string,
  panelTabs?: PanelTab[]
): WorkspaceTileLeaf {
  const tabs = panelTabs ?? [makePanelTab(`pt-${id}`, makeLeaf(`pane-${id}`))]
  return {
    _tag: 'WorkspaceTileLeaf',
    id,
    workspaceId,
    panelTabs: tabs,
    activePanelTabId: tabs[0]?.id,
  }
}

/** A workspace tile split. */
function makeTileSplit(
  id: string,
  direction: 'horizontal' | 'vertical',
  children: WorkspaceTileNode[],
  sizes?: number[]
): WorkspaceTileSplit {
  const equalSize = 100 / children.length
  return {
    _tag: 'WorkspaceTileSplit',
    id,
    direction,
    children,
    sizes: sizes ?? children.map(() => equalSize),
  }
}

/** An empty window tab (no workspace layout). */
function makeEmptyTab(id: string): WindowTab {
  return { id }
}

/** A window tab with a workspace layout. */
function makeTab(id: string, workspaceLayout: WorkspaceTileNode): WindowTab {
  return { id, workspaceLayout }
}

/** Collect all workspace IDs from a tile tree in DFS order. */
function getWorkspaceIds(node: WorkspaceTileNode): string[] {
  if (node._tag === 'WorkspaceTileLeaf') {
    return [node.workspaceId]
  }
  return node.children.flatMap(getWorkspaceIds)
}

// ---------------------------------------------------------------------------
// addWorkspaceToTab
// ---------------------------------------------------------------------------

describe('addWorkspaceToTab', () => {
  it('adds first workspace to an empty tab', () => {
    const tab = makeEmptyTab('tab-1')
    const result = addWorkspaceToTab(tab, 'ws-1')

    expect(result.workspaceLayout).toBeDefined()
    expect(result.workspaceLayout?._tag).toBe('WorkspaceTileLeaf')
    const leaf = result.workspaceLayout as WorkspaceTileLeaf
    expect(leaf.workspaceId).toBe('ws-1')
    expect(leaf.panelTabs).toEqual([])
  })

  it('adds second workspace to a tab with a single workspace (creates horizontal split)', () => {
    const tile = makeTile('tile-1', 'ws-1')
    const tab = makeTab('tab-1', tile)
    const result = addWorkspaceToTab(tab, 'ws-2')

    expect(result.workspaceLayout?._tag).toBe('WorkspaceTileSplit')
    const split = result.workspaceLayout as WorkspaceTileSplit
    expect(split.direction).toBe('horizontal')
    expect(split.children.length).toBe(2)
    expect(split.sizes).toEqual([50, 50])

    // First child is the original tile
    expect(split.children[0]).toBe(tile)
    // Second child is the new workspace
    expect((split.children[1] as WorkspaceTileLeaf).workspaceId).toBe('ws-2')
  })

  it('adds to an existing horizontal split (flattens)', () => {
    const split = makeTileSplit(
      'split-1',
      'horizontal',
      [makeTile('tile-1', 'ws-1'), makeTile('tile-2', 'ws-2')],
      [50, 50]
    )
    const tab = makeTab('tab-1', split)
    const result = addWorkspaceToTab(tab, 'ws-3')

    expect(result.workspaceLayout?._tag).toBe('WorkspaceTileSplit')
    const newSplit = result.workspaceLayout as WorkspaceTileSplit
    expect(newSplit.direction).toBe('horizontal')
    expect(newSplit.children.length).toBe(3)
    expect(getWorkspaceIds(newSplit)).toEqual(['ws-1', 'ws-2', 'ws-3'])

    // Sizes redistributed evenly
    const expectedSize = 100 / 3
    for (const size of newSplit.sizes) {
      expect(size).toBeCloseTo(expectedSize)
    }
  })

  it('wraps a vertical root split in a new horizontal split', () => {
    const split = makeTileSplit(
      'split-1',
      'vertical',
      [makeTile('tile-1', 'ws-1'), makeTile('tile-2', 'ws-2')],
      [50, 50]
    )
    const tab = makeTab('tab-1', split)
    const result = addWorkspaceToTab(tab, 'ws-3')

    expect(result.workspaceLayout?._tag).toBe('WorkspaceTileSplit')
    const newSplit = result.workspaceLayout as WorkspaceTileSplit
    expect(newSplit.direction).toBe('horizontal')
    expect(newSplit.children.length).toBe(2)
    expect(newSplit.sizes).toEqual([50, 50])

    // First child is the original vertical split
    expect(newSplit.children[0]).toBe(split)
    // Second child is the new workspace
    expect((newSplit.children[1] as WorkspaceTileLeaf).workspaceId).toBe('ws-3')
  })

  it('does not mutate the original tab', () => {
    const tab = makeEmptyTab('tab-1')
    const result = addWorkspaceToTab(tab, 'ws-1')
    expect(result).not.toBe(tab)
    expect(tab.workspaceLayout).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// removeWorkspaceFromTab
// ---------------------------------------------------------------------------

describe('removeWorkspaceFromTab', () => {
  it('returns tab unchanged when workspace layout is empty', () => {
    const tab = makeEmptyTab('tab-1')
    const result = removeWorkspaceFromTab(tab, 'ws-1')
    expect(result).toBe(tab)
  })

  it('returns tab unchanged when workspace is not found', () => {
    const tab = makeTab('tab-1', makeTile('tile-1', 'ws-1'))
    const result = removeWorkspaceFromTab(tab, 'ws-999')
    expect(result).toBe(tab)
  })

  it('removes the only workspace (layout becomes undefined)', () => {
    const tab = makeTab('tab-1', makeTile('tile-1', 'ws-1'))
    const result = removeWorkspaceFromTab(tab, 'ws-1')
    expect(result.workspaceLayout).toBeUndefined()
  })

  it('removes one workspace from a two-workspace split (collapses to leaf)', () => {
    const tile1 = makeTile('tile-1', 'ws-1')
    const tile2 = makeTile('tile-2', 'ws-2')
    const split = makeTileSplit('split-1', 'horizontal', [tile1, tile2])
    const tab = makeTab('tab-1', split)

    const result = removeWorkspaceFromTab(tab, 'ws-1')
    // Collapsed — remaining leaf takes over
    expect(result.workspaceLayout?._tag).toBe('WorkspaceTileLeaf')
    expect(result.workspaceLayout).toBe(tile2)
  })

  it('removes a workspace from a three-workspace split (redistributes sizes)', () => {
    const split = makeTileSplit('split-1', 'horizontal', [
      makeTile('tile-1', 'ws-1'),
      makeTile('tile-2', 'ws-2'),
      makeTile('tile-3', 'ws-3'),
    ])
    const tab = makeTab('tab-1', split)

    const result = removeWorkspaceFromTab(tab, 'ws-2')
    expect(result.workspaceLayout?._tag).toBe('WorkspaceTileSplit')
    const newSplit = result.workspaceLayout as WorkspaceTileSplit
    expect(newSplit.children.length).toBe(2)
    expect(getWorkspaceIds(newSplit)).toEqual(['ws-1', 'ws-3'])
    expect(newSplit.sizes).toEqual([50, 50])
  })

  it('collapses single-child splits after removing a nested workspace', () => {
    // Layout: H-Split(ws-1, V-Split(ws-2, ws-3))
    const innerSplit = makeTileSplit('inner', 'vertical', [
      makeTile('tile-2', 'ws-2'),
      makeTile('tile-3', 'ws-3'),
    ])
    const outerSplit = makeTileSplit('outer', 'horizontal', [
      makeTile('tile-1', 'ws-1'),
      innerSplit,
    ])
    const tab = makeTab('tab-1', outerSplit)

    // Remove ws-2 from inner split → inner collapses to ws-3 leaf
    const result = removeWorkspaceFromTab(tab, 'ws-2')
    expect(result.workspaceLayout?._tag).toBe('WorkspaceTileSplit')
    const newOuter = result.workspaceLayout as WorkspaceTileSplit
    expect(newOuter.children.length).toBe(2)
    expect(getWorkspaceIds(newOuter)).toEqual(['ws-1', 'ws-3'])
    // Inner split collapsed — second child is now a leaf
    expect(newOuter.children[1]?._tag).toBe('WorkspaceTileLeaf')
  })

  it('removes a deeply nested workspace and cascades collapse', () => {
    // Layout: H-Split(ws-1, V-Split(H-Split(ws-2)))
    // Removing ws-2 should cascade: H-Split(ws-2) → undefined → V-Split(undefined) → undefined
    // Result: ws-1 leaf only
    const deepInner = makeTileSplit('deep', 'horizontal', [
      makeTile('tile-2', 'ws-2'),
    ])
    // Note: single-child splits are unusual but test robustness
    const midSplit = makeTileSplit('mid', 'vertical', [deepInner])
    const outerSplit = makeTileSplit('outer', 'horizontal', [
      makeTile('tile-1', 'ws-1'),
      midSplit,
    ])
    const tab = makeTab('tab-1', outerSplit)

    const result = removeWorkspaceFromTab(tab, 'ws-2')
    expect(result.workspaceLayout?._tag).toBe('WorkspaceTileLeaf')
    expect((result.workspaceLayout as WorkspaceTileLeaf).workspaceId).toBe(
      'ws-1'
    )
  })

  it('does not mutate the original tab', () => {
    const tile1 = makeTile('tile-1', 'ws-1')
    const tile2 = makeTile('tile-2', 'ws-2')
    const split = makeTileSplit('split-1', 'horizontal', [tile1, tile2])
    const tab = makeTab('tab-1', split)
    const originalChildren = [...split.children]

    removeWorkspaceFromTab(tab, 'ws-1')

    expect(split.children).toEqual(originalChildren)
    expect(tab.workspaceLayout).toBe(split)
  })
})

// ---------------------------------------------------------------------------
// splitWorkspaceTile
// ---------------------------------------------------------------------------

describe('splitWorkspaceTile', () => {
  it('returns tab unchanged when workspace layout is empty', () => {
    const tab = makeEmptyTab('tab-1')
    const result = splitWorkspaceTile(tab, 'ws-1', 'ws-new', 'horizontal')
    expect(result).toBe(tab)
  })

  it('returns tab unchanged when target workspace is not found', () => {
    const tab = makeTab('tab-1', makeTile('tile-1', 'ws-1'))
    const result = splitWorkspaceTile(tab, 'ws-999', 'ws-new', 'horizontal')
    expect(result).toBe(tab)
  })

  it('splits a root leaf horizontally', () => {
    const tile = makeTile('tile-1', 'ws-1')
    const tab = makeTab('tab-1', tile)

    const result = splitWorkspaceTile(tab, 'ws-1', 'ws-2', 'horizontal')
    expect(result.workspaceLayout?._tag).toBe('WorkspaceTileSplit')
    const split = result.workspaceLayout as WorkspaceTileSplit
    expect(split.direction).toBe('horizontal')
    expect(split.children.length).toBe(2)
    expect(split.sizes).toEqual([50, 50])
    expect(split.children[0]).toBe(tile)
    expect((split.children[1] as WorkspaceTileLeaf).workspaceId).toBe('ws-2')
  })

  it('splits a root leaf vertically', () => {
    const tile = makeTile('tile-1', 'ws-1')
    const tab = makeTab('tab-1', tile)

    const result = splitWorkspaceTile(tab, 'ws-1', 'ws-2', 'vertical')
    expect(result.workspaceLayout?._tag).toBe('WorkspaceTileSplit')
    const split = result.workspaceLayout as WorkspaceTileSplit
    expect(split.direction).toBe('vertical')
    expect(split.children.length).toBe(2)
    expect(split.children[0]).toBe(tile)
  })

  it('flattens same-direction split (horizontal into horizontal)', () => {
    const split = makeTileSplit('split-1', 'horizontal', [
      makeTile('tile-1', 'ws-1'),
      makeTile('tile-2', 'ws-2'),
    ])
    const tab = makeTab('tab-1', split)

    const result = splitWorkspaceTile(tab, 'ws-1', 'ws-3', 'horizontal')
    const newSplit = result.workspaceLayout as WorkspaceTileSplit
    expect(newSplit.direction).toBe('horizontal')
    // Flattened: 3 children instead of nested split
    expect(newSplit.children.length).toBe(3)
    expect(getWorkspaceIds(newSplit)).toEqual(['ws-1', 'ws-3', 'ws-2'])

    const expectedSize = 100 / 3
    for (const size of newSplit.sizes) {
      expect(size).toBeCloseTo(expectedSize)
    }
  })

  it('flattens same-direction split (vertical into vertical)', () => {
    const split = makeTileSplit('split-1', 'vertical', [
      makeTile('tile-1', 'ws-1'),
      makeTile('tile-2', 'ws-2'),
    ])
    const tab = makeTab('tab-1', split)

    const result = splitWorkspaceTile(tab, 'ws-2', 'ws-3', 'vertical')
    const newSplit = result.workspaceLayout as WorkspaceTileSplit
    expect(newSplit.direction).toBe('vertical')
    expect(newSplit.children.length).toBe(3)
    expect(getWorkspaceIds(newSplit)).toEqual(['ws-1', 'ws-2', 'ws-3'])
  })

  it('nests different-direction split (vertical into horizontal)', () => {
    const split = makeTileSplit('split-1', 'horizontal', [
      makeTile('tile-1', 'ws-1'),
      makeTile('tile-2', 'ws-2'),
    ])
    const tab = makeTab('tab-1', split)

    const result = splitWorkspaceTile(tab, 'ws-1', 'ws-3', 'vertical')
    const outer = result.workspaceLayout as WorkspaceTileSplit
    // Outer remains horizontal with 2 children
    expect(outer.direction).toBe('horizontal')
    expect(outer.children.length).toBe(2)

    // First child is now a vertical split containing ws-1 and ws-3
    const nested = outer.children[0] as WorkspaceTileSplit
    expect(nested._tag).toBe('WorkspaceTileSplit')
    expect(nested.direction).toBe('vertical')
    expect(nested.children.length).toBe(2)
    expect(getWorkspaceIds(nested)).toEqual(['ws-1', 'ws-3'])
  })

  it('splits a nested workspace tile', () => {
    // Layout: H-Split(ws-1, V-Split(ws-2, ws-3))
    const innerSplit = makeTileSplit('inner', 'vertical', [
      makeTile('tile-2', 'ws-2'),
      makeTile('tile-3', 'ws-3'),
    ])
    const outerSplit = makeTileSplit('outer', 'horizontal', [
      makeTile('tile-1', 'ws-1'),
      innerSplit,
    ])
    const tab = makeTab('tab-1', outerSplit)

    // Split ws-3 vertically (same direction as inner — should flatten)
    const result = splitWorkspaceTile(tab, 'ws-3', 'ws-4', 'vertical')
    const outer = result.workspaceLayout as WorkspaceTileSplit
    expect(outer.children.length).toBe(2)

    const inner = outer.children[1] as WorkspaceTileSplit
    expect(inner.direction).toBe('vertical')
    expect(inner.children.length).toBe(3) // Flattened: ws-2, ws-3, ws-4
    expect(getWorkspaceIds(inner)).toEqual(['ws-2', 'ws-3', 'ws-4'])
  })

  it('does not mutate the original tab', () => {
    const tile = makeTile('tile-1', 'ws-1')
    const tab = makeTab('tab-1', tile)
    const result = splitWorkspaceTile(tab, 'ws-1', 'ws-2', 'horizontal')
    expect(result).not.toBe(tab)
    expect(tab.workspaceLayout).toBe(tile)
  })
})

// ---------------------------------------------------------------------------
// resizeWorkspaceTiles
// ---------------------------------------------------------------------------

describe('resizeWorkspaceTiles', () => {
  it('returns tab unchanged when workspace layout is empty', () => {
    const tab = makeEmptyTab('tab-1')
    const result = resizeWorkspaceTiles(tab, 'tile-1', 'right')
    expect(result).toBe(tab)
  })

  it('returns tab unchanged when node is not found', () => {
    const tab = makeTab('tab-1', makeTile('tile-1', 'ws-1'))
    const result = resizeWorkspaceTiles(tab, 'tile-999', 'right')
    expect(result).toBe(tab)
  })

  it('returns tab unchanged for a root leaf (no split to resize)', () => {
    const tab = makeTab('tab-1', makeTile('tile-1', 'ws-1'))
    const result = resizeWorkspaceTiles(tab, 'tile-1', 'right')
    expect(result).toBe(tab)
  })

  it('grows a tile to the right in a horizontal split', () => {
    const tile1 = makeTile('tile-1', 'ws-1')
    const tile2 = makeTile('tile-2', 'ws-2')
    const split = makeTileSplit(
      'split-1',
      'horizontal',
      [tile1, tile2],
      [50, 50]
    )
    const tab = makeTab('tab-1', split)

    const result = resizeWorkspaceTiles(tab, 'tile-1', 'right')
    const newSplit = result.workspaceLayout as WorkspaceTileSplit
    expect(newSplit.sizes[0]).toBe(55)
    expect(newSplit.sizes[1]).toBe(45)
  })

  it('shrinks a tile from the left in a horizontal split', () => {
    const tile1 = makeTile('tile-1', 'ws-1')
    const tile2 = makeTile('tile-2', 'ws-2')
    const split = makeTileSplit(
      'split-1',
      'horizontal',
      [tile1, tile2],
      [50, 50]
    )
    const tab = makeTab('tab-1', split)

    // Shrink tile-2 to the left (gives space to tile-1)
    const result = resizeWorkspaceTiles(tab, 'tile-2', 'left')
    const newSplit = result.workspaceLayout as WorkspaceTileSplit
    expect(newSplit.sizes[0]).toBe(55)
    expect(newSplit.sizes[1]).toBe(45)
  })

  it('grows a tile downward in a vertical split', () => {
    const tile1 = makeTile('tile-1', 'ws-1')
    const tile2 = makeTile('tile-2', 'ws-2')
    const split = makeTileSplit('split-1', 'vertical', [tile1, tile2], [50, 50])
    const tab = makeTab('tab-1', split)

    const result = resizeWorkspaceTiles(tab, 'tile-1', 'down')
    const newSplit = result.workspaceLayout as WorkspaceTileSplit
    expect(newSplit.sizes[0]).toBe(55)
    expect(newSplit.sizes[1]).toBe(45)
  })

  it('shrinks a tile upward in a vertical split', () => {
    const tile1 = makeTile('tile-1', 'ws-1')
    const tile2 = makeTile('tile-2', 'ws-2')
    const split = makeTileSplit('split-1', 'vertical', [tile1, tile2], [50, 50])
    const tab = makeTab('tab-1', split)

    // Shrink tile-2 upward (gives space to tile-1)
    const result = resizeWorkspaceTiles(tab, 'tile-2', 'up')
    const newSplit = result.workspaceLayout as WorkspaceTileSplit
    expect(newSplit.sizes[0]).toBe(55)
    expect(newSplit.sizes[1]).toBe(45)
  })

  it('does not resize past minimum size', () => {
    const tile1 = makeTile('tile-1', 'ws-1')
    const tile2 = makeTile('tile-2', 'ws-2')
    const split = makeTileSplit(
      'split-1',
      'horizontal',
      [tile1, tile2],
      [5, 95]
    )
    const tab = makeTab('tab-1', split)

    // tile-1 is at minimum size (5), cannot shrink further left
    const result = resizeWorkspaceTiles(tab, 'tile-1', 'left')
    expect(result).toBe(tab)
  })

  it('does not resize when direction does not match split orientation', () => {
    const tile1 = makeTile('tile-1', 'ws-1')
    const tile2 = makeTile('tile-2', 'ws-2')
    const split = makeTileSplit(
      'split-1',
      'horizontal',
      [tile1, tile2],
      [50, 50]
    )
    const tab = makeTab('tab-1', split)

    // Up/down don't match horizontal split
    const resultUp = resizeWorkspaceTiles(tab, 'tile-1', 'up')
    expect(resultUp).toBe(tab)
    const resultDown = resizeWorkspaceTiles(tab, 'tile-1', 'down')
    expect(resultDown).toBe(tab)
  })

  it('does not resize when target is at edge (no sibling in that direction)', () => {
    const tile1 = makeTile('tile-1', 'ws-1')
    const tile2 = makeTile('tile-2', 'ws-2')
    const split = makeTileSplit(
      'split-1',
      'horizontal',
      [tile1, tile2],
      [50, 50]
    )
    const tab = makeTab('tab-1', split)

    // tile-1 is leftmost — cannot shrink left (delta -5, sibling at index -1)
    // Actually this should try to shrink, and siblingIndex becomes -1, so no resize
    // tile-2 is rightmost — cannot grow right
    const resultGrowRight = resizeWorkspaceTiles(tab, 'tile-2', 'right')
    expect(resultGrowRight).toBe(tab)
  })

  it('resizes a nested tile by walking up to the matching ancestor', () => {
    // Layout: H-Split(ws-1, V-Split(ws-2, ws-3))
    const innerSplit = makeTileSplit(
      'inner',
      'vertical',
      [makeTile('tile-2', 'ws-2'), makeTile('tile-3', 'ws-3')],
      [50, 50]
    )
    const outerSplit = makeTileSplit(
      'outer',
      'horizontal',
      [makeTile('tile-1', 'ws-1'), innerSplit],
      [50, 50]
    )
    const tab = makeTab('tab-1', outerSplit)

    // Resize tile-2 down (matches vertical inner split)
    const result = resizeWorkspaceTiles(tab, 'tile-2', 'down')
    const outer = result.workspaceLayout as WorkspaceTileSplit
    // Outer sizes unchanged
    expect(outer.sizes).toEqual([50, 50])
    // Inner sizes changed
    const inner = outer.children[1] as WorkspaceTileSplit
    expect(inner.sizes[0]).toBe(55)
    expect(inner.sizes[1]).toBe(45)
  })

  it('does not mutate the original tab', () => {
    const tile1 = makeTile('tile-1', 'ws-1')
    const tile2 = makeTile('tile-2', 'ws-2')
    const split = makeTileSplit(
      'split-1',
      'horizontal',
      [tile1, tile2],
      [50, 50]
    )
    const tab = makeTab('tab-1', split)
    const originalSizes = [...split.sizes]

    resizeWorkspaceTiles(tab, 'tile-1', 'right')

    expect(split.sizes).toEqual(originalSizes)
  })
})

// ---------------------------------------------------------------------------
// reorderWorkspaceTiles
// ---------------------------------------------------------------------------

describe('reorderWorkspaceTiles', () => {
  it('returns tab unchanged when workspace layout is empty', () => {
    const tab = makeEmptyTab('tab-1')
    const result = reorderWorkspaceTiles(tab, ['ws-1', 'ws-2'])
    expect(result).toBe(tab)
  })

  it('returns tab unchanged when only one workspace exists', () => {
    const tab = makeTab('tab-1', makeTile('tile-1', 'ws-1'))
    const result = reorderWorkspaceTiles(tab, ['ws-1'])
    expect(result).toBe(tab)
  })

  it('reorders two workspaces', () => {
    const split = makeTileSplit('split-1', 'horizontal', [
      makeTile('tile-1', 'ws-1'),
      makeTile('tile-2', 'ws-2'),
    ])
    const tab = makeTab('tab-1', split)

    const result = reorderWorkspaceTiles(tab, ['ws-2', 'ws-1'])
    const newSplit = result.workspaceLayout as WorkspaceTileSplit
    expect(getWorkspaceIds(newSplit)).toEqual(['ws-2', 'ws-1'])
    expect(newSplit.sizes).toEqual([50, 50])
  })

  it('reorders three workspaces', () => {
    const split = makeTileSplit('split-1', 'horizontal', [
      makeTile('tile-1', 'ws-1'),
      makeTile('tile-2', 'ws-2'),
      makeTile('tile-3', 'ws-3'),
    ])
    const tab = makeTab('tab-1', split)

    const result = reorderWorkspaceTiles(tab, ['ws-3', 'ws-1', 'ws-2'])
    const newSplit = result.workspaceLayout as WorkspaceTileSplit
    expect(getWorkspaceIds(newSplit)).toEqual(['ws-3', 'ws-1', 'ws-2'])
  })

  it('returns tab unchanged when order matches current order', () => {
    const split = makeTileSplit('split-1', 'horizontal', [
      makeTile('tile-1', 'ws-1'),
      makeTile('tile-2', 'ws-2'),
    ])
    const tab = makeTab('tab-1', split)

    const result = reorderWorkspaceTiles(tab, ['ws-1', 'ws-2'])
    expect(result).toBe(tab)
  })

  it('appends workspaces not in the order array at the end', () => {
    const split = makeTileSplit('split-1', 'horizontal', [
      makeTile('tile-1', 'ws-1'),
      makeTile('tile-2', 'ws-2'),
      makeTile('tile-3', 'ws-3'),
    ])
    const tab = makeTab('tab-1', split)

    // Only specify ws-3 and ws-1 — ws-2 should be appended at end
    const result = reorderWorkspaceTiles(tab, ['ws-3', 'ws-1'])
    const newSplit = result.workspaceLayout as WorkspaceTileSplit
    expect(getWorkspaceIds(newSplit)).toEqual(['ws-3', 'ws-1', 'ws-2'])
  })

  it('ignores workspace IDs in the order array that do not exist', () => {
    const split = makeTileSplit('split-1', 'horizontal', [
      makeTile('tile-1', 'ws-1'),
      makeTile('tile-2', 'ws-2'),
    ])
    const tab = makeTab('tab-1', split)

    const result = reorderWorkspaceTiles(tab, ['ws-999', 'ws-2', 'ws-1'])
    const newSplit = result.workspaceLayout as WorkspaceTileSplit
    expect(getWorkspaceIds(newSplit)).toEqual(['ws-2', 'ws-1'])
  })

  it('flattens a nested split tree into a flat horizontal split on reorder', () => {
    // Layout: H-Split(ws-1, V-Split(ws-2, ws-3))
    // After reorder, should be flat: H-Split(ws-3, ws-2, ws-1)
    const innerSplit = makeTileSplit('inner', 'vertical', [
      makeTile('tile-2', 'ws-2'),
      makeTile('tile-3', 'ws-3'),
    ])
    const outerSplit = makeTileSplit('outer', 'horizontal', [
      makeTile('tile-1', 'ws-1'),
      innerSplit,
    ])
    const tab = makeTab('tab-1', outerSplit)

    const result = reorderWorkspaceTiles(tab, ['ws-3', 'ws-2', 'ws-1'])
    const newSplit = result.workspaceLayout as WorkspaceTileSplit
    expect(newSplit.direction).toBe('horizontal')
    expect(newSplit.children.length).toBe(3)
    expect(getWorkspaceIds(newSplit)).toEqual(['ws-3', 'ws-2', 'ws-1'])
  })

  it('preserves tile leaf panel tabs and state during reorder', () => {
    const panelTab1 = makePanelTab('pt-1', makeLeaf('pane-1', 'term-1'))
    const panelTab2 = makePanelTab('pt-2', makeLeaf('pane-2', 'term-2'))
    const tile1 = makeTile('tile-1', 'ws-1', [panelTab1])
    const tile2 = makeTile('tile-2', 'ws-2', [panelTab2])
    const split = makeTileSplit('split-1', 'horizontal', [tile1, tile2])
    const tab = makeTab('tab-1', split)

    const result = reorderWorkspaceTiles(tab, ['ws-2', 'ws-1'])
    const newSplit = result.workspaceLayout as WorkspaceTileSplit
    // Panel tabs are preserved
    const reorderedTile1 = newSplit.children[0] as WorkspaceTileLeaf
    const reorderedTile2 = newSplit.children[1] as WorkspaceTileLeaf
    expect(reorderedTile1.panelTabs).toEqual([panelTab2])
    expect(reorderedTile2.panelTabs).toEqual([panelTab1])
  })
})

// ---------------------------------------------------------------------------
// Combined operations
// ---------------------------------------------------------------------------

describe('combined operations', () => {
  it('add then remove returns to empty tab', () => {
    const tab = makeEmptyTab('tab-1')
    const withWorkspace = addWorkspaceToTab(tab, 'ws-1')
    const result = removeWorkspaceFromTab(withWorkspace, 'ws-1')
    expect(result.workspaceLayout).toBeUndefined()
  })

  it('add two workspaces, split one, remove the split target', () => {
    const tab = makeEmptyTab('tab-1')
    const step1 = addWorkspaceToTab(tab, 'ws-1')
    const step2 = addWorkspaceToTab(step1, 'ws-2')
    // Split ws-1 vertically to add ws-3
    const step3 = splitWorkspaceTile(step2, 'ws-1', 'ws-3', 'vertical')
    // Remove ws-1
    const step4 = removeWorkspaceFromTab(step3, 'ws-1')

    expect(step4.workspaceLayout).toBeDefined()
    const layout = step4.workspaceLayout as WorkspaceTileNode
    const ids = getWorkspaceIds(layout)
    expect(ids).toContain('ws-2')
    expect(ids).toContain('ws-3')
    expect(ids).not.toContain('ws-1')
    expect(ids.length).toBe(2)
  })

  it('add three workspaces, reorder, then resize', () => {
    let tab = makeEmptyTab('tab-1')
    tab = addWorkspaceToTab(tab, 'ws-1')
    tab = addWorkspaceToTab(tab, 'ws-2')
    tab = addWorkspaceToTab(tab, 'ws-3')

    // Reorder
    tab = reorderWorkspaceTiles(tab, ['ws-3', 'ws-1', 'ws-2'])
    expect(tab.workspaceLayout).toBeDefined()
    expect(getWorkspaceIds(tab.workspaceLayout as WorkspaceTileNode)).toEqual([
      'ws-3',
      'ws-1',
      'ws-2',
    ])

    // Get the tile IDs after reorder to resize
    const split = tab.workspaceLayout as WorkspaceTileSplit
    const firstChild = split.children[0]
    expect(firstChild).toBeDefined()
    const firstTileId = (firstChild as WorkspaceTileNode).id

    // Resize first tile to the right
    const resized = resizeWorkspaceTiles(tab, firstTileId, 'right')
    const resizedSplit = resized.workspaceLayout as WorkspaceTileSplit
    const expectedBase = 100 / 3
    expect(resizedSplit.sizes[0]).toBeCloseTo(expectedBase + 5)
    expect(resizedSplit.sizes[1]).toBeCloseTo(expectedBase - 5)
    // Third tile unchanged
    expect(resizedSplit.sizes[2]).toBeCloseTo(expectedBase)
  })
})
