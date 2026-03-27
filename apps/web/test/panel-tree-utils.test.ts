/**
 * Unit tests for panel tree manipulation utilities.
 *
 * Tests the pure functions in `panel-tree-utils.ts` that operate on
 * `PanelNode` (the split tree within a single panel tab): split, close,
 * find, navigate, resize, and collect operations.
 *
 * @see apps/web/src/panels/panel-tree-utils.ts
 */

import type { LeafNode, PanelNode, SplitNode } from '@laborer/shared/types'
import { describe, expect, it } from 'vitest'
import {
  assignTerminal,
  closePane,
  collectTerminalIds,
  computeResize,
  containsPane,
  countLeaves,
  findLeaf,
  findNewLeafAfterSplit,
  findPaneInDirection,
  findSiblingPaneId,
  getFirstLeafId,
  getLeafIds,
  splitPane,
} from '../src/panels/panel-tree-utils'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeLeaf(
  id: string,
  terminalId?: string,
  workspaceId?: string
): LeafNode {
  return {
    _tag: 'LeafNode',
    id,
    paneType: 'terminal',
    terminalId,
    workspaceId,
  }
}

function makeSplit(
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
// getFirstLeafId
// ---------------------------------------------------------------------------

describe('getFirstLeafId', () => {
  it('returns the ID for a single leaf', () => {
    const leaf = makeLeaf('leaf-1')
    expect(getFirstLeafId(leaf)).toBe('leaf-1')
  })

  it('returns the first leaf in a horizontal split', () => {
    const tree = makeSplit('split-1', 'horizontal', [
      makeLeaf('left'),
      makeLeaf('right'),
    ])
    expect(getFirstLeafId(tree)).toBe('left')
  })

  it('returns the deepest first leaf in a nested tree', () => {
    const tree = makeSplit('root', 'vertical', [
      makeSplit('inner', 'horizontal', [
        makeLeaf('deep-left'),
        makeLeaf('deep-right'),
      ]),
      makeLeaf('outer-bottom'),
    ])
    expect(getFirstLeafId(tree)).toBe('deep-left')
  })
})

// ---------------------------------------------------------------------------
// getLeafIds
// ---------------------------------------------------------------------------

describe('getLeafIds', () => {
  it('returns a single ID for a leaf', () => {
    expect(getLeafIds(makeLeaf('a'))).toEqual(['a'])
  })

  it('returns all leaf IDs in DFS order', () => {
    const tree = makeSplit('root', 'horizontal', [
      makeLeaf('a'),
      makeSplit('inner', 'vertical', [makeLeaf('b'), makeLeaf('c')]),
      makeLeaf('d'),
    ])
    expect(getLeafIds(tree)).toEqual(['a', 'b', 'c', 'd'])
  })
})

// ---------------------------------------------------------------------------
// findLeaf
// ---------------------------------------------------------------------------

describe('findLeaf', () => {
  it('returns the leaf when found at root', () => {
    const leaf = makeLeaf('target', 'term-1')
    expect(findLeaf(leaf, 'target')).toBe(leaf)
  })

  it('returns undefined when not found', () => {
    const leaf = makeLeaf('other')
    expect(findLeaf(leaf, 'missing')).toBeUndefined()
  })

  it('finds a leaf deep in a nested tree', () => {
    const target = makeLeaf('deep', 'term-deep')
    const tree = makeSplit('root', 'horizontal', [
      makeLeaf('left'),
      makeSplit('inner', 'vertical', [makeLeaf('inner-top'), target]),
    ])
    expect(findLeaf(tree, 'deep')).toBe(target)
  })
})

// ---------------------------------------------------------------------------
// containsPane
// ---------------------------------------------------------------------------

describe('containsPane', () => {
  it('returns true when the pane is at root', () => {
    expect(containsPane(makeLeaf('a'), 'a')).toBe(true)
  })

  it('returns false when the pane is not in the tree', () => {
    expect(containsPane(makeLeaf('a'), 'b')).toBe(false)
  })

  it('finds a pane nested in splits', () => {
    const tree = makeSplit('root', 'horizontal', [
      makeLeaf('a'),
      makeSplit('inner', 'vertical', [makeLeaf('b'), makeLeaf('c')]),
    ])
    expect(containsPane(tree, 'c')).toBe(true)
    expect(containsPane(tree, 'missing')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// collectTerminalIds
// ---------------------------------------------------------------------------

describe('collectTerminalIds', () => {
  it('collects from a single leaf with terminal', () => {
    expect(collectTerminalIds(makeLeaf('a', 'term-1'))).toEqual(['term-1'])
  })

  it('returns empty for a leaf without terminal', () => {
    expect(collectTerminalIds(makeLeaf('a'))).toEqual([])
  })

  it('collects from all leaves in a tree', () => {
    const tree = makeSplit('root', 'horizontal', [
      makeLeaf('a', 'term-a'),
      makeLeaf('b'), // no terminal
      makeLeaf('c', 'term-c'),
    ])
    expect(collectTerminalIds(tree)).toEqual(['term-a', 'term-c'])
  })
})

// ---------------------------------------------------------------------------
// countLeaves
// ---------------------------------------------------------------------------

describe('countLeaves', () => {
  it('returns 1 for a single leaf', () => {
    expect(countLeaves(makeLeaf('a'))).toBe(1)
  })

  it('counts all leaves in a nested tree', () => {
    const tree = makeSplit('root', 'horizontal', [
      makeLeaf('a'),
      makeSplit('inner', 'vertical', [makeLeaf('b'), makeLeaf('c')]),
      makeLeaf('d'),
    ])
    expect(countLeaves(tree)).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// splitPane
// ---------------------------------------------------------------------------

describe('splitPane', () => {
  it('wraps a root leaf in a split with a new sibling', () => {
    const root = makeLeaf('a', 'term-a', 'ws-1')
    const result = splitPane(root, 'a', 'horizontal')

    expect(result._tag).toBe('SplitNode')
    if (result._tag === 'SplitNode') {
      expect(result.direction).toBe('horizontal')
      expect(result.children).toHaveLength(2)
      expect(result.children[0]).toBe(root)
      expect(result.children[1]?._tag).toBe('LeafNode')
      expect(result.sizes).toEqual([50, 50])
    }
  })

  it('returns the tree unchanged if paneId is not found', () => {
    const root = makeLeaf('a')
    expect(splitPane(root, 'missing', 'horizontal')).toBe(root)
  })

  it('flattens same-direction splits instead of nesting', () => {
    const root = makeSplit('split-1', 'horizontal', [
      makeLeaf('a'),
      makeLeaf('b'),
    ])
    const result = splitPane(root, 'b', 'horizontal')

    expect(result._tag).toBe('SplitNode')
    if (result._tag === 'SplitNode') {
      // Should have 3 children (flat) instead of nesting
      expect(result.children).toHaveLength(3)
      expect(result.children[0]?.id).toBe('a')
      expect(result.children[1]?.id).toBe('b')
      // Third child is the new pane
      expect(result.children[2]?._tag).toBe('LeafNode')
    }
  })

  it('nests when splitting in a different direction', () => {
    const root = makeSplit('split-1', 'horizontal', [
      makeLeaf('a'),
      makeLeaf('b'),
    ])
    const result = splitPane(root, 'b', 'vertical')

    expect(result._tag).toBe('SplitNode')
    if (result._tag === 'SplitNode') {
      expect(result.children).toHaveLength(2)
      // Second child should now be a vertical split
      const nested = result.children[1]
      expect(nested?._tag).toBe('SplitNode')
      if (nested?._tag === 'SplitNode') {
        expect(nested.direction).toBe('vertical')
        expect(nested.children).toHaveLength(2)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// closePane
// ---------------------------------------------------------------------------

describe('closePane', () => {
  it('returns undefined when closing the root leaf', () => {
    expect(closePane(makeLeaf('a'), 'a')).toBeUndefined()
  })

  it('returns the tree unchanged if paneId is not found', () => {
    const root = makeLeaf('a')
    expect(closePane(root, 'missing')).toBe(root)
  })

  it('promotes sibling when one child of a split is closed', () => {
    const sibling = makeLeaf('b', 'term-b')
    const root = makeSplit('split-1', 'horizontal', [makeLeaf('a'), sibling])
    const result = closePane(root, 'a')
    expect(result).toBe(sibling)
  })

  it('redistributes sizes when closing one of three children', () => {
    const root = makeSplit('split-1', 'horizontal', [
      makeLeaf('a'),
      makeLeaf('b'),
      makeLeaf('c'),
    ])
    const result = closePane(root, 'b')

    expect(result?._tag).toBe('SplitNode')
    if (result?._tag === 'SplitNode') {
      expect(result.children).toHaveLength(2)
      expect(result.children[0]?.id).toBe('a')
      expect(result.children[1]?.id).toBe('c')
      expect(result.sizes).toEqual([50, 50])
    }
  })

  it('recursively closes a pane in a nested split', () => {
    const root = makeSplit('root', 'horizontal', [
      makeLeaf('a'),
      makeSplit('inner', 'vertical', [makeLeaf('b'), makeLeaf('c')]),
    ])
    const result = closePane(root, 'b')

    expect(result?._tag).toBe('SplitNode')
    if (result?._tag === 'SplitNode') {
      expect(result.children).toHaveLength(2)
      // Inner split should be collapsed to just leaf 'c'
      expect(result.children[1]?.id).toBe('c')
      expect(result.children[1]?._tag).toBe('LeafNode')
    }
  })
})

// ---------------------------------------------------------------------------
// findSiblingPaneId
// ---------------------------------------------------------------------------

describe('findSiblingPaneId', () => {
  it('returns undefined for a root leaf', () => {
    expect(findSiblingPaneId(makeLeaf('a'), 'a')).toBeUndefined()
  })

  it('returns the right sibling for the first child', () => {
    const root = makeSplit('split-1', 'horizontal', [
      makeLeaf('a'),
      makeLeaf('b'),
    ])
    expect(findSiblingPaneId(root, 'a')).toBe('b')
  })

  it('returns the right sibling when available (prefers after)', () => {
    const root = makeSplit('split-1', 'horizontal', [
      makeLeaf('a'),
      makeLeaf('b'),
      makeLeaf('c'),
    ])
    expect(findSiblingPaneId(root, 'b')).toBe('c')
  })

  it('returns the left sibling for the last child', () => {
    const root = makeSplit('split-1', 'horizontal', [
      makeLeaf('a'),
      makeLeaf('b'),
    ])
    expect(findSiblingPaneId(root, 'b')).toBe('a')
  })

  it('finds a sibling in a nested split', () => {
    const root = makeSplit('root', 'horizontal', [
      makeLeaf('a'),
      makeSplit('inner', 'vertical', [makeLeaf('b'), makeLeaf('c')]),
    ])
    expect(findSiblingPaneId(root, 'b')).toBe('c')
  })
})

// ---------------------------------------------------------------------------
// findNewLeafAfterSplit
// ---------------------------------------------------------------------------

describe('findNewLeafAfterSplit', () => {
  it('finds the new leaf created by a split', () => {
    const before = makeLeaf('a', 'term-a', 'ws-1')
    const after = splitPane(before, 'a', 'horizontal')

    const newLeaf = findNewLeafAfterSplit(before, after)
    expect(newLeaf).toBeDefined()
    expect(newLeaf?._tag).toBe('LeafNode')
    expect(newLeaf?.id).not.toBe('a')
  })

  it('returns undefined when no new leaf exists', () => {
    const tree = makeLeaf('a')
    expect(findNewLeafAfterSplit(tree, tree)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// assignTerminal
// ---------------------------------------------------------------------------

describe('assignTerminal', () => {
  it('assigns a terminal to a matching leaf', () => {
    const root = makeLeaf('a')
    const result = assignTerminal(root, 'a', 'term-new')

    expect(result._tag).toBe('LeafNode')
    if (result._tag === 'LeafNode') {
      expect(result.terminalId).toBe('term-new')
    }
  })

  it('returns the tree unchanged if paneId is not found', () => {
    const root = makeLeaf('a', 'term-a')
    expect(assignTerminal(root, 'missing', 'term-new')).toBe(root)
  })

  it('assigns in a nested tree', () => {
    const root = makeSplit('root', 'horizontal', [
      makeLeaf('a', 'term-a'),
      makeLeaf('b'),
    ])
    const result = assignTerminal(root, 'b', 'term-b')

    expect(result._tag).toBe('SplitNode')
    if (result._tag === 'SplitNode') {
      const leaf = result.children[1]
      expect(leaf?._tag).toBe('LeafNode')
      if (leaf?._tag === 'LeafNode') {
        expect(leaf.terminalId).toBe('term-b')
      }
    }
  })
})

// ---------------------------------------------------------------------------
// findPaneInDirection
// ---------------------------------------------------------------------------

describe('findPaneInDirection', () => {
  it('navigates right in a horizontal split', () => {
    const root = makeSplit('root', 'horizontal', [
      makeLeaf('left'),
      makeLeaf('right'),
    ])
    expect(findPaneInDirection(root, 'left', 'right')).toBe('right')
  })

  it('navigates left in a horizontal split', () => {
    const root = makeSplit('root', 'horizontal', [
      makeLeaf('left'),
      makeLeaf('right'),
    ])
    expect(findPaneInDirection(root, 'right', 'left')).toBe('left')
  })

  it('navigates down in a vertical split', () => {
    const root = makeSplit('root', 'vertical', [
      makeLeaf('top'),
      makeLeaf('bottom'),
    ])
    expect(findPaneInDirection(root, 'top', 'down')).toBe('bottom')
  })

  it('navigates up in a vertical split', () => {
    const root = makeSplit('root', 'vertical', [
      makeLeaf('top'),
      makeLeaf('bottom'),
    ])
    expect(findPaneInDirection(root, 'bottom', 'up')).toBe('top')
  })

  it('returns undefined at the edge of the layout', () => {
    const root = makeSplit('root', 'horizontal', [
      makeLeaf('left'),
      makeLeaf('right'),
    ])
    expect(findPaneInDirection(root, 'right', 'right')).toBeUndefined()
    expect(findPaneInDirection(root, 'left', 'left')).toBeUndefined()
  })

  it('returns undefined for cross-direction navigation (horizontal split + up/down)', () => {
    const root = makeSplit('root', 'horizontal', [
      makeLeaf('left'),
      makeLeaf('right'),
    ])
    expect(findPaneInDirection(root, 'left', 'up')).toBeUndefined()
    expect(findPaneInDirection(root, 'left', 'down')).toBeUndefined()
  })

  it('navigates into nested splits (right enters left edge)', () => {
    const root = makeSplit('root', 'horizontal', [
      makeLeaf('left'),
      makeSplit('right-split', 'vertical', [
        makeLeaf('right-top'),
        makeLeaf('right-bottom'),
      ]),
    ])
    // Moving right from 'left' should enter the left (first) edge of the right subtree
    expect(findPaneInDirection(root, 'left', 'right')).toBe('right-top')
  })

  it('navigates into nested splits (left enters right edge)', () => {
    const root = makeSplit('root', 'horizontal', [
      makeSplit('left-split', 'vertical', [
        makeLeaf('left-top'),
        makeLeaf('left-bottom'),
      ]),
      makeLeaf('right'),
    ])
    // Moving left from 'right' should enter the right (last) edge of the left subtree
    expect(findPaneInDirection(root, 'right', 'left')).toBe('left-bottom')
  })

  it('returns undefined for a single leaf (no navigation possible)', () => {
    const root = makeLeaf('only')
    expect(findPaneInDirection(root, 'only', 'right')).toBeUndefined()
  })

  it('walks up to find matching ancestor for mixed splits', () => {
    // Vertical parent with horizontal children
    const root = makeSplit('root', 'vertical', [
      makeSplit('top-split', 'horizontal', [
        makeLeaf('top-left'),
        makeLeaf('top-right'),
      ]),
      makeSplit('bottom-split', 'horizontal', [
        makeLeaf('bottom-left'),
        makeLeaf('bottom-right'),
      ]),
    ])
    // Moving down from top-left should go to bottom-left
    expect(findPaneInDirection(root, 'top-left', 'down')).toBe('bottom-left')
    // Moving right from top-left should go to top-right
    expect(findPaneInDirection(root, 'top-left', 'right')).toBe('top-right')
  })
})

// ---------------------------------------------------------------------------
// computeResize
// ---------------------------------------------------------------------------

describe('computeResize', () => {
  it('grows the active pane when resizing right in a horizontal split', () => {
    const root = makeSplit(
      'root',
      'horizontal',
      [makeLeaf('left'), makeLeaf('right')],
      [50, 50]
    )

    const result = computeResize(root, 'left', 'right')
    expect(result).toBeDefined()
    expect(result?.splitNodeId).toBe('root')
    expect(result?.newSizes.left).toBe(55)
    expect(result?.newSizes.right).toBe(45)
  })

  it('shrinks the active pane when resizing left in a horizontal split', () => {
    const root = makeSplit(
      'root',
      'horizontal',
      [makeLeaf('left'), makeLeaf('right')],
      [50, 50]
    )

    const result = computeResize(root, 'right', 'left')
    expect(result).toBeDefined()
    expect(result?.newSizes.right).toBe(45)
    expect(result?.newSizes.left).toBe(55)
  })

  it('returns undefined when at minimum size', () => {
    const root = makeSplit(
      'root',
      'horizontal',
      [makeLeaf('left'), makeLeaf('right')],
      [5, 95]
    )

    // left is at minimum (5), can't shrink further
    const result = computeResize(root, 'left', 'left')
    expect(result).toBeUndefined()
  })

  it('returns undefined for cross-direction resize', () => {
    const root = makeSplit('root', 'horizontal', [
      makeLeaf('left'),
      makeLeaf('right'),
    ])
    // Up/down should not affect a horizontal split
    expect(computeResize(root, 'left', 'up')).toBeUndefined()
  })

  it('returns undefined for a single leaf', () => {
    expect(computeResize(makeLeaf('only'), 'only', 'right')).toBeUndefined()
  })

  it('returns undefined when paneId is not found', () => {
    const root = makeSplit('root', 'horizontal', [
      makeLeaf('left'),
      makeLeaf('right'),
    ])
    expect(computeResize(root, 'missing', 'right')).toBeUndefined()
  })

  it('works with vertical splits and down direction', () => {
    const root = makeSplit(
      'root',
      'vertical',
      [makeLeaf('top'), makeLeaf('bottom')],
      [50, 50]
    )

    const result = computeResize(root, 'top', 'down')
    expect(result).toBeDefined()
    expect(result?.newSizes.top).toBe(55)
    expect(result?.newSizes.bottom).toBe(45)
  })

  it('walks up to find matching ancestor in nested splits', () => {
    const root = makeSplit(
      'outer',
      'vertical',
      [
        makeSplit('inner', 'horizontal', [
          makeLeaf('inner-left'),
          makeLeaf('inner-right'),
        ]),
        makeLeaf('bottom'),
      ],
      [50, 50]
    )

    // Resizing inner-left down should affect the outer vertical split
    const result = computeResize(root, 'inner-left', 'down')
    expect(result).toBeDefined()
    expect(result?.splitNodeId).toBe('outer')
  })
})
