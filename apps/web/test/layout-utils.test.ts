/**
 * Unit tests for panel layout tree manipulation utilities.
 *
 * Tests the pure functions in `layout-utils.ts` that operate on the
 * PanelNode tree structure. These functions are used by the panel system
 * for splitting, closing, navigating, and resizing panes.
 *
 * @see apps/web/src/panels/layout-utils.ts
 * @see Issue #149: Focus auto-transfer on pane close
 * @see Issue #150: Guaranteed active pane invariant
 */

import type { LeafNode, SplitNode } from '@laborer/shared/types'
import { describe, expect, it } from 'vitest'
import {
  ensureValidActivePaneId,
  findLeafByTerminalId,
  findSiblingPaneId,
  getFirstLeafId,
  getLeafIds,
} from '../src/panels/layout-utils'

// ---------------------------------------------------------------------------
// Test fixtures — reusable layout tree configurations
// ---------------------------------------------------------------------------

/** Single leaf root — the simplest possible layout. */
const singleLeaf: LeafNode = {
  _tag: 'LeafNode',
  id: 'pane-A',
  paneType: 'terminal',
}

/**
 * Flat horizontal split with 2 children:
 * ┌─────┬─────┐
 * │  A  │  B  │
 * └─────┴─────┘
 */
const twoChildSplit: SplitNode = {
  _tag: 'SplitNode',
  id: 'split-root',
  direction: 'horizontal',
  children: [
    { _tag: 'LeafNode', id: 'pane-A', paneType: 'terminal' },
    { _tag: 'LeafNode', id: 'pane-B', paneType: 'terminal' },
  ],
  sizes: [50, 50],
}

/**
 * Flat horizontal split with 3 children:
 * ┌─────┬─────┬─────┐
 * │  A  │  B  │  C  │
 * └─────┴─────┴─────┘
 */
const threeChildSplit: SplitNode = {
  _tag: 'SplitNode',
  id: 'split-root',
  direction: 'horizontal',
  children: [
    { _tag: 'LeafNode', id: 'pane-A', paneType: 'terminal' },
    { _tag: 'LeafNode', id: 'pane-B', paneType: 'terminal' },
    { _tag: 'LeafNode', id: 'pane-C', paneType: 'terminal' },
  ],
  sizes: [33, 34, 33],
}

/**
 * Nested layout:
 * ┌─────┬───────────┐
 * │     │     B     │
 * │  A  ├─────┬─────┤
 * │     │  C  │  D  │
 * └─────┴─────┴─────┘
 *
 * Tree: H-Split(A, V-Split(B, H-Split(C, D)))
 */
const nestedLayout: SplitNode = {
  _tag: 'SplitNode',
  id: 'split-root',
  direction: 'horizontal',
  children: [
    { _tag: 'LeafNode', id: 'pane-A', paneType: 'terminal' },
    {
      _tag: 'SplitNode',
      id: 'split-right',
      direction: 'vertical',
      children: [
        { _tag: 'LeafNode', id: 'pane-B', paneType: 'terminal' },
        {
          _tag: 'SplitNode',
          id: 'split-bottom-right',
          direction: 'horizontal',
          children: [
            { _tag: 'LeafNode', id: 'pane-C', paneType: 'terminal' },
            { _tag: 'LeafNode', id: 'pane-D', paneType: 'terminal' },
          ],
          sizes: [50, 50],
        },
      ],
      sizes: [50, 50],
    },
  ],
  sizes: [50, 50],
}

/**
 * Deeply nested (5 levels) layout for edge case testing:
 *
 * H-Split(
 *   V-Split(
 *     H-Split(
 *       V-Split(
 *         A, B
 *       ),
 *       C
 *     ),
 *     D
 *   ),
 *   E
 * )
 */
const deeplyNested: SplitNode = {
  _tag: 'SplitNode',
  id: 'split-1',
  direction: 'horizontal',
  children: [
    {
      _tag: 'SplitNode',
      id: 'split-2',
      direction: 'vertical',
      children: [
        {
          _tag: 'SplitNode',
          id: 'split-3',
          direction: 'horizontal',
          children: [
            {
              _tag: 'SplitNode',
              id: 'split-4',
              direction: 'vertical',
              children: [
                { _tag: 'LeafNode', id: 'pane-A', paneType: 'terminal' },
                { _tag: 'LeafNode', id: 'pane-B', paneType: 'terminal' },
              ],
              sizes: [50, 50],
            },
            { _tag: 'LeafNode', id: 'pane-C', paneType: 'terminal' },
          ],
          sizes: [50, 50],
        },
        { _tag: 'LeafNode', id: 'pane-D', paneType: 'terminal' },
      ],
      sizes: [50, 50],
    },
    { _tag: 'LeafNode', id: 'pane-E', paneType: 'terminal' },
  ],
  sizes: [50, 50],
}

// ---------------------------------------------------------------------------
// Tests: findSiblingPaneId
// ---------------------------------------------------------------------------

describe('findSiblingPaneId', () => {
  it('returns null for a single leaf root', () => {
    expect(findSiblingPaneId(singleLeaf, 'pane-A')).toBeNull()
  })

  it('closing first child focuses next sibling', () => {
    expect(findSiblingPaneId(twoChildSplit, 'pane-A')).toBe('pane-B')
  })

  it('closing last child focuses previous sibling', () => {
    expect(findSiblingPaneId(twoChildSplit, 'pane-B')).toBe('pane-A')
  })

  it('closing middle child focuses previous sibling in 3-child split', () => {
    expect(findSiblingPaneId(threeChildSplit, 'pane-B')).toBe('pane-A')
  })

  it('closing first child focuses next sibling in 3-child split', () => {
    expect(findSiblingPaneId(threeChildSplit, 'pane-A')).toBe('pane-B')
  })

  it('closing last child focuses previous sibling in 3-child split', () => {
    expect(findSiblingPaneId(threeChildSplit, 'pane-C')).toBe('pane-B')
  })

  it('closing a deeply nested pane focuses nearest sibling in parent split', () => {
    // In nestedLayout: C and D are siblings in split-bottom-right.
    // Closing C → D (next sibling since C is first child)
    expect(findSiblingPaneId(nestedLayout, 'pane-C')).toBe('pane-D')
    // Closing D → C (previous sibling since D is last child)
    expect(findSiblingPaneId(nestedLayout, 'pane-D')).toBe('pane-C')
  })

  it('sibling is a SplitNode — drills to nearest edge leaf', () => {
    // In nestedLayout: A and the V-Split(B, H-Split(C,D)) are siblings
    // in the root horizontal split. Closing A → next sibling is the
    // V-Split, drill to its first leaf = B.
    expect(findSiblingPaneId(nestedLayout, 'pane-A')).toBe('pane-B')
  })

  it('sibling is a SplitNode — drills to last edge leaf when closing non-first', () => {
    // In nestedLayout: B is the first child of split-right (vertical).
    // The second child of split-right is H-Split(C, D).
    // Closing B → next sibling (index=0, so delta=1) = H-Split(C, D).
    // Drill to first leaf = C.
    expect(findSiblingPaneId(nestedLayout, 'pane-B')).toBe('pane-C')
  })

  it('handles 5+ levels of nesting', () => {
    // In deeplyNested: A and B are siblings in split-4 (vertical).
    // Closing A → B (next sibling, first child)
    expect(findSiblingPaneId(deeplyNested, 'pane-A')).toBe('pane-B')
    // Closing B → A (previous sibling, last child)
    expect(findSiblingPaneId(deeplyNested, 'pane-B')).toBe('pane-A')
  })

  it('handles deeply nested pane with split sibling', () => {
    // In deeplyNested: split-4 (V-Split(A,B)) and pane-C are siblings
    // in split-3 (horizontal). Closing C → previous sibling is split-4,
    // drill to last leaf = B.
    expect(findSiblingPaneId(deeplyNested, 'pane-C')).toBe('pane-B')
  })

  it('returns null for non-existent pane ID', () => {
    expect(findSiblingPaneId(twoChildSplit, 'nonexistent')).toBeNull()
  })

  it('returns null for non-existent pane ID on single leaf', () => {
    expect(findSiblingPaneId(singleLeaf, 'nonexistent')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Tests: getLeafIds (verify test fixtures are correct)
// ---------------------------------------------------------------------------

describe('getLeafIds', () => {
  it('returns single ID for a leaf node', () => {
    expect(getLeafIds(singleLeaf)).toEqual(['pane-A'])
  })

  it('returns IDs in order for flat split', () => {
    expect(getLeafIds(threeChildSplit)).toEqual(['pane-A', 'pane-B', 'pane-C'])
  })

  it('returns IDs in DFS order for nested layout', () => {
    expect(getLeafIds(nestedLayout)).toEqual([
      'pane-A',
      'pane-B',
      'pane-C',
      'pane-D',
    ])
  })

  it('returns IDs in DFS order for deeply nested layout', () => {
    expect(getLeafIds(deeplyNested)).toEqual([
      'pane-A',
      'pane-B',
      'pane-C',
      'pane-D',
      'pane-E',
    ])
  })
})

// ---------------------------------------------------------------------------
// Tests: getFirstLeafId
// @see Issue #150: Guaranteed active pane invariant
// ---------------------------------------------------------------------------

describe('getFirstLeafId', () => {
  it('returns the leaf ID for a single leaf', () => {
    expect(getFirstLeafId(singleLeaf)).toBe('pane-A')
  })

  it('returns the first child for a flat split', () => {
    expect(getFirstLeafId(twoChildSplit)).toBe('pane-A')
  })

  it('returns the first child for a 3-child split', () => {
    expect(getFirstLeafId(threeChildSplit)).toBe('pane-A')
  })

  it('returns the DFS-first leaf for a nested layout', () => {
    expect(getFirstLeafId(nestedLayout)).toBe('pane-A')
  })

  it('returns the DFS-first leaf for a deeply nested layout', () => {
    expect(getFirstLeafId(deeplyNested)).toBe('pane-A')
  })
})

// ---------------------------------------------------------------------------
// Tests: ensureValidActivePaneId
// @see Issue #150: Guaranteed active pane invariant
// ---------------------------------------------------------------------------

describe('ensureValidActivePaneId', () => {
  it('returns the activePaneId when it references a valid leaf', () => {
    expect(ensureValidActivePaneId(twoChildSplit, 'pane-A')).toBe('pane-A')
    expect(ensureValidActivePaneId(twoChildSplit, 'pane-B')).toBe('pane-B')
  })

  it('falls back to first leaf when activePaneId is null', () => {
    expect(ensureValidActivePaneId(twoChildSplit, null)).toBe('pane-A')
  })

  it('falls back to first leaf when activePaneId references a non-existent node', () => {
    expect(ensureValidActivePaneId(twoChildSplit, 'nonexistent')).toBe('pane-A')
  })

  it('falls back to first leaf when activePaneId references a SplitNode (not a leaf)', () => {
    expect(ensureValidActivePaneId(twoChildSplit, 'split-root')).toBe('pane-A')
  })

  it('works with a single leaf layout', () => {
    expect(ensureValidActivePaneId(singleLeaf, null)).toBe('pane-A')
    expect(ensureValidActivePaneId(singleLeaf, 'pane-A')).toBe('pane-A')
    expect(ensureValidActivePaneId(singleLeaf, 'stale-id')).toBe('pane-A')
  })

  it('falls back to DFS-first leaf for nested layouts with null', () => {
    expect(ensureValidActivePaneId(nestedLayout, null)).toBe('pane-A')
  })

  it('falls back to DFS-first leaf for nested layouts with stale ID', () => {
    expect(ensureValidActivePaneId(nestedLayout, 'pane-removed')).toBe('pane-A')
  })

  it('preserves valid activePaneId in nested layouts', () => {
    expect(ensureValidActivePaneId(nestedLayout, 'pane-C')).toBe('pane-C')
    expect(ensureValidActivePaneId(nestedLayout, 'pane-D')).toBe('pane-D')
  })

  it('falls back correctly for deeply nested layouts', () => {
    expect(ensureValidActivePaneId(deeplyNested, null)).toBe('pane-A')
    expect(ensureValidActivePaneId(deeplyNested, 'stale')).toBe('pane-A')
    expect(ensureValidActivePaneId(deeplyNested, 'pane-E')).toBe('pane-E')
  })
})

// ---------------------------------------------------------------------------
// Tests: findLeafByTerminalId
// ---------------------------------------------------------------------------

describe('findLeafByTerminalId', () => {
  it('returns undefined for a leaf with no terminalId', () => {
    expect(findLeafByTerminalId(singleLeaf, 'term-1')).toBeUndefined()
  })

  it('returns the leaf when its terminalId matches', () => {
    const leaf: LeafNode = {
      _tag: 'LeafNode',
      id: 'pane-X',
      paneType: 'terminal',
      terminalId: 'term-1',
      workspaceId: 'ws-1',
    }
    expect(findLeafByTerminalId(leaf, 'term-1')).toBe(leaf)
  })

  it('returns undefined when no leaf has the requested terminalId', () => {
    const layout: SplitNode = {
      _tag: 'SplitNode',
      id: 'split-root',
      direction: 'horizontal',
      children: [
        {
          _tag: 'LeafNode',
          id: 'pane-A',
          paneType: 'terminal',
          terminalId: 'term-1',
        },
        {
          _tag: 'LeafNode',
          id: 'pane-B',
          paneType: 'terminal',
          terminalId: 'term-2',
        },
      ],
      sizes: [50, 50],
    }
    expect(findLeafByTerminalId(layout, 'term-999')).toBeUndefined()
  })

  it('finds a terminal in a nested layout', () => {
    // nestedLayout has panes A, B, C, D — none have terminalIds by default.
    // Create a version where pane-C has a terminal assigned.
    const withTerminal: SplitNode = {
      _tag: 'SplitNode',
      id: 'split-root',
      direction: 'horizontal',
      children: [
        { _tag: 'LeafNode', id: 'pane-A', paneType: 'terminal' },
        {
          _tag: 'SplitNode',
          id: 'split-right',
          direction: 'vertical',
          children: [
            { _tag: 'LeafNode', id: 'pane-B', paneType: 'terminal' },
            {
              _tag: 'LeafNode',
              id: 'pane-C',
              paneType: 'terminal',
              terminalId: 'term-deep',
              workspaceId: 'ws-1',
            },
          ],
          sizes: [50, 50],
        },
      ],
      sizes: [50, 50],
    }
    const result = findLeafByTerminalId(withTerminal, 'term-deep')
    expect(result).toBeDefined()
    expect(result?.id).toBe('pane-C')
    expect(result?.terminalId).toBe('term-deep')
  })

  it('returns the first match in DFS order when multiple leaves share a terminalId', () => {
    const layout: SplitNode = {
      _tag: 'SplitNode',
      id: 'split-root',
      direction: 'horizontal',
      children: [
        {
          _tag: 'LeafNode',
          id: 'pane-first',
          paneType: 'terminal',
          terminalId: 'term-dup',
        },
        {
          _tag: 'LeafNode',
          id: 'pane-second',
          paneType: 'terminal',
          terminalId: 'term-dup',
        },
      ],
      sizes: [50, 50],
    }
    const result = findLeafByTerminalId(layout, 'term-dup')
    expect(result?.id).toBe('pane-first')
  })
})
