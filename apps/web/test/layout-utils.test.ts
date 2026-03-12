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
  closePane,
  ensureValidActivePaneId,
  filterTreeByWorkspace,
  findLeafByTerminalId,
  findNewLeafAfterSplit,
  findNodeById,
  findSiblingPaneId,
  getFirstLeafId,
  getLastLeafId,
  getLeafIds,
  getLeafNodes,
  getWorkspaceIds,
  isWorkspaceFrameData,
  shouldConfirmClose,
  sortWorkspaceLayouts,
  splitPane,
  WORKSPACE_FRAME_TYPE,
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
// Tests: getLastLeafId
// ---------------------------------------------------------------------------

describe('getLastLeafId', () => {
  it('returns the leaf ID for a single leaf', () => {
    expect(getLastLeafId(singleLeaf)).toBe('pane-A')
  })

  it('returns the last child for a flat split', () => {
    expect(getLastLeafId(twoChildSplit)).toBe('pane-B')
  })

  it('returns the last child for a 3-child split', () => {
    expect(getLastLeafId(threeChildSplit)).toBe('pane-C')
  })

  it('returns the DFS-last leaf for a nested layout', () => {
    expect(getLastLeafId(nestedLayout)).toBe('pane-D')
  })

  it('returns the DFS-last leaf for a deeply nested layout', () => {
    expect(getLastLeafId(deeplyNested)).toBe('pane-E')
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

// ---------------------------------------------------------------------------
// Test fixtures with workspaceIds — for workspace grouping tests
// ---------------------------------------------------------------------------

/** Single leaf with workspaceId. */
const leafWithWorkspace: LeafNode = {
  _tag: 'LeafNode',
  id: 'pane-A',
  paneType: 'terminal',
  workspaceId: 'ws-1',
}

/**
 * Two leaves with different workspaces in a horizontal split:
 * ┌─────────┬─────────┐
 * │  ws-1   │  ws-2   │
 * └─────────┴─────────┘
 */
const twoWorkspaceSplit: SplitNode = {
  _tag: 'SplitNode',
  id: 'split-root',
  direction: 'horizontal',
  children: [
    {
      _tag: 'LeafNode',
      id: 'pane-A',
      paneType: 'terminal',
      workspaceId: 'ws-1',
    },
    {
      _tag: 'LeafNode',
      id: 'pane-B',
      paneType: 'terminal',
      workspaceId: 'ws-2',
    },
  ],
  sizes: [50, 50],
}

/**
 * Three leaves: two from ws-1, one from ws-2:
 * ┌────┬────┬────┐
 * │ws-1│ws-2│ws-1│
 * └────┴────┴────┘
 */
const mixedWorkspaceSplit: SplitNode = {
  _tag: 'SplitNode',
  id: 'split-root',
  direction: 'horizontal',
  children: [
    {
      _tag: 'LeafNode',
      id: 'pane-A',
      paneType: 'terminal',
      workspaceId: 'ws-1',
    },
    {
      _tag: 'LeafNode',
      id: 'pane-B',
      paneType: 'terminal',
      workspaceId: 'ws-2',
    },
    {
      _tag: 'LeafNode',
      id: 'pane-C',
      paneType: 'terminal',
      workspaceId: 'ws-1',
    },
  ],
  sizes: [33, 34, 33],
}

/**
 * Nested layout with mixed workspaces:
 * ┌─────────┬──────────────┐
 * │         │    B (ws-1)  │
 * │ A (ws-1)├──────┬───────┤
 * │         │C ws-2│D ws-3 │
 * └─────────┴──────┴───────┘
 */
const nestedMixedWorkspaces: SplitNode = {
  _tag: 'SplitNode',
  id: 'split-root',
  direction: 'horizontal',
  children: [
    {
      _tag: 'LeafNode',
      id: 'pane-A',
      paneType: 'terminal',
      workspaceId: 'ws-1',
    },
    {
      _tag: 'SplitNode',
      id: 'split-right',
      direction: 'vertical',
      children: [
        {
          _tag: 'LeafNode',
          id: 'pane-B',
          paneType: 'terminal',
          workspaceId: 'ws-1',
        },
        {
          _tag: 'SplitNode',
          id: 'split-bottom-right',
          direction: 'horizontal',
          children: [
            {
              _tag: 'LeafNode',
              id: 'pane-C',
              paneType: 'terminal',
              workspaceId: 'ws-2',
            },
            {
              _tag: 'LeafNode',
              id: 'pane-D',
              paneType: 'terminal',
              workspaceId: 'ws-3',
            },
          ],
          sizes: [50, 50],
        },
      ],
      sizes: [50, 50],
    },
  ],
  sizes: [40, 60],
}

/** Leaf without workspaceId (empty pane). */
const leafWithoutWorkspace: LeafNode = {
  _tag: 'LeafNode',
  id: 'pane-empty',
  paneType: 'terminal',
}

/** Mix of leaves with and without workspaceId. */
const mixedPresenceSplit: SplitNode = {
  _tag: 'SplitNode',
  id: 'split-root',
  direction: 'horizontal',
  children: [
    {
      _tag: 'LeafNode',
      id: 'pane-A',
      paneType: 'terminal',
      workspaceId: 'ws-1',
    },
    {
      _tag: 'LeafNode',
      id: 'pane-empty',
      paneType: 'terminal',
    },
  ],
  sizes: [50, 50],
}

// ---------------------------------------------------------------------------
// Tests: getLeafNodes
// ---------------------------------------------------------------------------

describe('getLeafNodes', () => {
  it('returns the leaf itself for a single leaf', () => {
    const result = getLeafNodes(leafWithWorkspace)
    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe('pane-A')
    expect(result[0]?.workspaceId).toBe('ws-1')
  })

  it('returns all leaves from a flat split', () => {
    const result = getLeafNodes(twoWorkspaceSplit)
    expect(result).toHaveLength(2)
    expect(result.map((l) => l.id)).toEqual(['pane-A', 'pane-B'])
  })

  it('returns all leaves from a nested tree in DFS order', () => {
    const result = getLeafNodes(nestedMixedWorkspaces)
    expect(result).toHaveLength(4)
    expect(result.map((l) => l.id)).toEqual([
      'pane-A',
      'pane-B',
      'pane-C',
      'pane-D',
    ])
  })

  it('preserves workspaceId on returned leaves', () => {
    const result = getLeafNodes(nestedMixedWorkspaces)
    expect(result.map((l) => l.workspaceId)).toEqual([
      'ws-1',
      'ws-1',
      'ws-2',
      'ws-3',
    ])
  })

  it('handles leaves without workspaceId', () => {
    const result = getLeafNodes(leafWithoutWorkspace)
    expect(result).toHaveLength(1)
    expect(result[0]?.workspaceId).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Tests: getWorkspaceIds
// ---------------------------------------------------------------------------

describe('getWorkspaceIds', () => {
  it('returns single workspace for a leaf', () => {
    expect(getWorkspaceIds(leafWithWorkspace)).toEqual(['ws-1'])
  })

  it('returns unique workspace IDs in DFS appearance order', () => {
    expect(getWorkspaceIds(twoWorkspaceSplit)).toEqual(['ws-1', 'ws-2'])
  })

  it('deduplicates workspace IDs', () => {
    expect(getWorkspaceIds(mixedWorkspaceSplit)).toEqual(['ws-1', 'ws-2'])
  })

  it('returns all unique workspaces from nested layout', () => {
    expect(getWorkspaceIds(nestedMixedWorkspaces)).toEqual([
      'ws-1',
      'ws-2',
      'ws-3',
    ])
  })

  it('includes undefined for leaves without workspaceId', () => {
    expect(getWorkspaceIds(leafWithoutWorkspace)).toEqual([undefined])
  })

  it('includes both defined and undefined workspace IDs', () => {
    expect(getWorkspaceIds(mixedPresenceSplit)).toEqual(['ws-1', undefined])
  })
})

// ---------------------------------------------------------------------------
// Tests: filterTreeByWorkspace
// ---------------------------------------------------------------------------

describe('filterTreeByWorkspace', () => {
  it('returns a leaf that matches the workspace', () => {
    const result = filterTreeByWorkspace(leafWithWorkspace, 'ws-1')
    expect(result).toBeDefined()
    expect(result?._tag).toBe('LeafNode')
    expect((result as LeafNode).id).toBe('pane-A')
  })

  it('returns undefined for a leaf that does not match', () => {
    expect(filterTreeByWorkspace(leafWithWorkspace, 'ws-other')).toBeUndefined()
  })

  it('filters a flat split to matching workspace leaves', () => {
    const result = filterTreeByWorkspace(twoWorkspaceSplit, 'ws-1')
    expect(result).toBeDefined()
    // Only one leaf matches — should be collapsed to a single leaf
    expect(result?._tag).toBe('LeafNode')
    expect((result as LeafNode).id).toBe('pane-A')
  })

  it('returns undefined when no leaves match in a split', () => {
    expect(
      filterTreeByWorkspace(twoWorkspaceSplit, 'ws-nonexistent')
    ).toBeUndefined()
  })

  it('filters mixed workspace split to leaves matching ws-1', () => {
    const result = filterTreeByWorkspace(mixedWorkspaceSplit, 'ws-1')
    expect(result).toBeDefined()
    // Two leaves match ws-1 (pane-A and pane-C) — should be a split
    expect(result?._tag).toBe('SplitNode')
    const split = result as SplitNode
    expect(split.children).toHaveLength(2)
    expect((split.children[0] as LeafNode).id).toBe('pane-A')
    expect((split.children[1] as LeafNode).id).toBe('pane-C')
  })

  it('redistributes sizes proportionally after filtering', () => {
    const result = filterTreeByWorkspace(mixedWorkspaceSplit, 'ws-1')
    expect(result?._tag).toBe('SplitNode')
    const split = result as SplitNode
    expect(split.sizes).toHaveLength(2)
    expect(split.sizes[0]).toBeCloseTo(50)
    expect(split.sizes[1]).toBeCloseTo(50)
  })

  it('collapses a SplitNode to a single child when only one leaf matches', () => {
    const result = filterTreeByWorkspace(mixedWorkspaceSplit, 'ws-2')
    expect(result?._tag).toBe('LeafNode')
    expect((result as LeafNode).id).toBe('pane-B')
  })

  it('filters nested layout correctly for ws-1 (multiple levels)', () => {
    const result = filterTreeByWorkspace(nestedMixedWorkspaces, 'ws-1')
    expect(result).toBeDefined()
    expect(result?._tag).toBe('SplitNode')
    const split = result as SplitNode
    expect(split.children).toHaveLength(2)
    expect((split.children[0] as LeafNode).id).toBe('pane-A')
    expect((split.children[1] as LeafNode).id).toBe('pane-B')
  })

  it('filters nested layout correctly for ws-2 (single leaf deep in tree)', () => {
    const result = filterTreeByWorkspace(nestedMixedWorkspaces, 'ws-2')
    expect(result?._tag).toBe('LeafNode')
    expect((result as LeafNode).id).toBe('pane-C')
  })

  it('filters nested layout correctly for ws-3 (single leaf deep in tree)', () => {
    const result = filterTreeByWorkspace(nestedMixedWorkspaces, 'ws-3')
    expect(result?._tag).toBe('LeafNode')
    expect((result as LeafNode).id).toBe('pane-D')
  })

  it('handles undefined workspaceId filtering', () => {
    const result = filterTreeByWorkspace(mixedPresenceSplit, undefined)
    expect(result?._tag).toBe('LeafNode')
    expect((result as LeafNode).id).toBe('pane-empty')
  })

  it('returns undefined when filtering for undefined but all leaves have workspaceIds', () => {
    expect(filterTreeByWorkspace(twoWorkspaceSplit, undefined)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Tests: findNodeById
// ---------------------------------------------------------------------------

describe('findNodeById', () => {
  it('finds a root leaf by its ID', () => {
    const result = findNodeById(singleLeaf, 'pane-A')
    expect(result).toBe(singleLeaf)
  })

  it('returns undefined for a non-existent ID on a leaf', () => {
    expect(findNodeById(singleLeaf, 'nonexistent')).toBeUndefined()
  })

  it('finds a leaf child in a flat split', () => {
    const result = findNodeById(twoChildSplit, 'pane-B')
    expect(result?._tag).toBe('LeafNode')
    expect(result?.id).toBe('pane-B')
  })

  it('finds the SplitNode itself by its ID', () => {
    const result = findNodeById(twoChildSplit, 'split-root')
    expect(result).toBe(twoChildSplit)
  })

  it('finds a deeply nested leaf', () => {
    const result = findNodeById(deeplyNested, 'pane-C')
    expect(result?._tag).toBe('LeafNode')
    expect(result?.id).toBe('pane-C')
  })

  it('finds a nested SplitNode by ID', () => {
    const result = findNodeById(nestedLayout, 'split-bottom-right')
    expect(result?._tag).toBe('SplitNode')
    expect(result?.id).toBe('split-bottom-right')
  })

  it('returns undefined for a non-existent ID in a nested layout', () => {
    expect(findNodeById(nestedLayout, 'nonexistent')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Tests: splitPane
// ---------------------------------------------------------------------------

describe('splitPane', () => {
  it('splits a root leaf into a SplitNode with two children', () => {
    const result = splitPane(singleLeaf, 'pane-A', 'horizontal')
    expect(result._tag).toBe('SplitNode')
    const split = result as SplitNode
    expect(split.direction).toBe('horizontal')
    expect(split.children).toHaveLength(2)
    expect(split.sizes).toEqual([50, 50])
  })

  it('preserves the original pane as the first child', () => {
    const result = splitPane(singleLeaf, 'pane-A', 'horizontal')
    const split = result as SplitNode
    expect(split.children[0]).toBe(singleLeaf)
  })

  it('creates a new empty terminal pane as the second child', () => {
    const result = splitPane(singleLeaf, 'pane-A', 'vertical')
    const split = result as SplitNode
    const newPane = split.children[1] as LeafNode
    expect(newPane._tag).toBe('LeafNode')
    expect(newPane.paneType).toBe('terminal')
    expect(newPane.terminalId).toBeUndefined()
    expect(newPane.id).not.toBe('pane-A')
  })

  it('inherits workspaceId from the source pane', () => {
    const result = splitPane(leafWithWorkspace, 'pane-A', 'horizontal')
    const split = result as SplitNode
    const newPane = split.children[1] as LeafNode
    expect(newPane.workspaceId).toBe('ws-1')
  })

  it('splits a pane in a flat split, inserting adjacent when same direction', () => {
    // Splitting pane-A horizontally in a horizontal split inserts adjacent
    const result = splitPane(twoChildSplit, 'pane-A', 'horizontal')
    expect(result._tag).toBe('SplitNode')
    const split = result as SplitNode
    // Should have 3 children now (A, new, B) — inserted adjacent, not nested
    expect(split.children).toHaveLength(3)
    expect((split.children[0] as LeafNode).id).toBe('pane-A')
    expect((split.children[2] as LeafNode).id).toBe('pane-B')
    // New pane inserted after A
    const newPane = split.children[1] as LeafNode
    expect(newPane._tag).toBe('LeafNode')
    expect(newPane.paneType).toBe('terminal')
  })

  it('splits a pane in a flat split, creating nested split when different direction', () => {
    // Splitting pane-A vertically in a horizontal split creates a nested V-split
    const result = splitPane(twoChildSplit, 'pane-A', 'vertical')
    expect(result._tag).toBe('SplitNode')
    const split = result as SplitNode
    // Root should still have 2 children (nested split replaced A, B stays)
    expect(split.children).toHaveLength(2)
    expect(split.children[0]?._tag).toBe('SplitNode')
    const nestedSplit = split.children[0] as SplitNode
    expect(nestedSplit.direction).toBe('vertical')
    expect(nestedSplit.children).toHaveLength(2)
    expect((nestedSplit.children[0] as LeafNode).id).toBe('pane-A')
  })

  it('returns the original tree when the paneId is not found', () => {
    const result = splitPane(twoChildSplit, 'nonexistent', 'horizontal')
    expect(result).toBe(twoChildSplit)
  })

  it('splits a deeply nested pane', () => {
    // Split pane-C in deeplyNested (which is inside split-3 horizontal)
    const result = splitPane(deeplyNested, 'pane-C', 'horizontal')
    // pane-C is a direct child of split-3 (horizontal), same direction →
    // adjacent insert, split-3 gets a 3rd child
    const split3 = findNodeById(result, 'split-3')
    expect(split3?._tag).toBe('SplitNode')
    expect((split3 as SplitNode).children).toHaveLength(3)
  })

  it('accepts custom newPaneContent', () => {
    const result = splitPane(singleLeaf, 'pane-A', 'horizontal', {
      terminalId: 'term-custom',
      workspaceId: 'ws-custom',
    })
    const split = result as SplitNode
    const newPane = split.children[1] as LeafNode
    expect(newPane.terminalId).toBe('term-custom')
    expect(newPane.workspaceId).toBe('ws-custom')
  })
})

// ---------------------------------------------------------------------------
// Tests: closePane
// ---------------------------------------------------------------------------

describe('closePane', () => {
  it('returns undefined when closing the only root leaf', () => {
    expect(closePane(singleLeaf, 'pane-A')).toBeUndefined()
  })

  it('returns the remaining leaf when closing one child of a 2-child split', () => {
    const result = closePane(twoChildSplit, 'pane-A')
    expect(result?._tag).toBe('LeafNode')
    expect((result as LeafNode).id).toBe('pane-B')
  })

  it('collapses the split when closing leaves the split with one child', () => {
    const result = closePane(twoChildSplit, 'pane-B')
    // Should collapse to just pane-A (not a SplitNode wrapping one child)
    expect(result?._tag).toBe('LeafNode')
    expect((result as LeafNode).id).toBe('pane-A')
  })

  it('keeps a SplitNode with redistributed sizes when closing one of 3 children', () => {
    const result = closePane(threeChildSplit, 'pane-B')
    expect(result?._tag).toBe('SplitNode')
    const split = result as SplitNode
    expect(split.children).toHaveLength(2)
    expect((split.children[0] as LeafNode).id).toBe('pane-A')
    expect((split.children[1] as LeafNode).id).toBe('pane-C')
    // Sizes should be redistributed evenly
    expect(split.sizes[0]).toBe(50)
    expect(split.sizes[1]).toBe(50)
  })

  it('closes a nested leaf and collapses parent when only one sibling remains', () => {
    // nestedLayout: H-Split(A, V-Split(B, H-Split(C, D)))
    // Close pane-C → H-Split(C, D) collapses to just D
    // V-Split(B, D) remains
    const result = closePane(nestedLayout, 'pane-C')
    expect(result?._tag).toBe('SplitNode')
    const root = result as SplitNode
    expect(root.children).toHaveLength(2)
    expect((root.children[0] as LeafNode).id).toBe('pane-A')
    // Second child should be a V-Split(B, D) after collapse
    const rightSplit = root.children[1] as SplitNode
    expect(rightSplit._tag).toBe('SplitNode')
    expect(rightSplit.direction).toBe('vertical')
    expect(rightSplit.children).toHaveLength(2)
    expect((rightSplit.children[0] as LeafNode).id).toBe('pane-B')
    expect((rightSplit.children[1] as LeafNode).id).toBe('pane-D')
  })

  it('returns the original tree when paneId is not found', () => {
    const result = closePane(twoChildSplit, 'nonexistent')
    expect(result).toBe(twoChildSplit)
  })

  it('returns the original tree when trying to close a non-leaf ID', () => {
    // split-root is a SplitNode, not a LeafNode — closePane only closes leaves
    const result = closePane(twoChildSplit, 'split-root')
    expect(result).toBe(twoChildSplit)
  })

  it('closes a deeply nested leaf', () => {
    // deeplyNested: H-Split(V-Split(H-Split(V-Split(A,B),C),D), E)
    // Close pane-A → V-Split(A,B) collapses to B → H-Split(B,C)
    const result = closePane(deeplyNested, 'pane-A')
    if (!result) {
      throw new Error('Expected result to be defined')
    }
    const leafIds = getLeafIds(result)
    expect(leafIds).toContain('pane-B')
    expect(leafIds).toContain('pane-C')
    expect(leafIds).toContain('pane-D')
    expect(leafIds).toContain('pane-E')
    expect(leafIds).not.toContain('pane-A')
  })
})

// ---------------------------------------------------------------------------
// Tests: shouldConfirmClose
// ---------------------------------------------------------------------------

describe('shouldConfirmClose', () => {
  /**
   * Minimal terminal info interface matching useTerminalList's output.
   * Only the fields that shouldConfirmClose needs.
   */
  interface TerminalInfo {
    readonly hasChildProcess: boolean
    readonly id: string
    readonly status: string
  }

  it('returns true when the pane has a terminal with an active child process', () => {
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
          workspaceId: 'ws-1',
        },
        { _tag: 'LeafNode', id: 'pane-B', paneType: 'terminal' },
      ],
      sizes: [50, 50],
    }
    const terminals: TerminalInfo[] = [
      { id: 'term-1', hasChildProcess: true, status: 'running' },
    ]

    expect(shouldConfirmClose(layout, 'pane-A', terminals)).toBe(true)
  })

  it('returns false when the pane has a terminal with no child process', () => {
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
          workspaceId: 'ws-1',
        },
        { _tag: 'LeafNode', id: 'pane-B', paneType: 'terminal' },
      ],
      sizes: [50, 50],
    }
    const terminals: TerminalInfo[] = [
      { id: 'term-1', hasChildProcess: false, status: 'running' },
    ]

    expect(shouldConfirmClose(layout, 'pane-A', terminals)).toBe(false)
  })

  it('returns false when the pane has no terminal assigned', () => {
    const layout: LeafNode = {
      _tag: 'LeafNode',
      id: 'pane-empty',
      paneType: 'terminal',
    }
    const terminals: TerminalInfo[] = []

    expect(shouldConfirmClose(layout, 'pane-empty', terminals)).toBe(false)
  })

  it('returns false when the pane ID does not exist in the layout', () => {
    const terminals: TerminalInfo[] = [
      { id: 'term-1', hasChildProcess: true, status: 'running' },
    ]

    expect(shouldConfirmClose(singleLeaf, 'nonexistent', terminals)).toBe(false)
  })

  it('returns false when layout is undefined', () => {
    const terminals: TerminalInfo[] = [
      { id: 'term-1', hasChildProcess: true, status: 'running' },
    ]

    expect(shouldConfirmClose(undefined, 'pane-A', terminals)).toBe(false)
  })

  it('returns false when the terminal is not in the live terminal list', () => {
    const layout: LeafNode = {
      _tag: 'LeafNode',
      id: 'pane-A',
      paneType: 'terminal',
      terminalId: 'term-stale',
      workspaceId: 'ws-1',
    }
    const terminals: TerminalInfo[] = []

    expect(shouldConfirmClose(layout, 'pane-A', terminals)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Tests: splitPane + getLeafIds — new pane discovery pattern
//
// This pattern is used by handleSplitPane in the route component to find
// the newly created pane after a split so a terminal can be auto-spawned
// into it. The test verifies the invariant: diffing leaf IDs before and
// after a split always yields exactly one new pane ID.
// ---------------------------------------------------------------------------

describe('splitPane + getLeafIds new pane discovery', () => {
  it('finds exactly one new pane after splitting a root leaf', () => {
    const oldIds = new Set(getLeafIds(singleLeaf))
    const newTree = splitPane(singleLeaf, 'pane-A', 'horizontal')
    const newIds = getLeafIds(newTree)
    const addedIds = newIds.filter((id) => !oldIds.has(id))
    expect(addedIds).toHaveLength(1)
  })

  it('the discovered new pane is an empty terminal leaf', () => {
    const oldIds = new Set(getLeafIds(singleLeaf))
    const newTree = splitPane(singleLeaf, 'pane-A', 'vertical')
    const newIds = getLeafIds(newTree)
    const newPaneId = newIds.find((id) => !oldIds.has(id))
    expect(newPaneId).toBeDefined()
    const newPane = findNodeById(newTree, newPaneId as string)
    expect(newPane?._tag).toBe('LeafNode')
    expect((newPane as LeafNode).paneType).toBe('terminal')
    expect((newPane as LeafNode).terminalId).toBeUndefined()
  })

  it('the discovered new pane inherits the source pane workspaceId', () => {
    const oldIds = new Set(getLeafIds(leafWithWorkspace))
    const newTree = splitPane(leafWithWorkspace, 'pane-A', 'horizontal')
    const newIds = getLeafIds(newTree)
    const newPaneId = newIds.find((id) => !oldIds.has(id))
    expect(newPaneId).toBeDefined()
    const newPane = findNodeById(newTree, newPaneId as string) as LeafNode
    expect(newPane.workspaceId).toBe('ws-1')
  })

  it('finds exactly one new pane after splitting in a flat same-direction split', () => {
    const oldIds = new Set(getLeafIds(twoChildSplit))
    const newTree = splitPane(twoChildSplit, 'pane-A', 'horizontal')
    const newIds = getLeafIds(newTree)
    const addedIds = newIds.filter((id) => !oldIds.has(id))
    expect(addedIds).toHaveLength(1)
  })

  it('finds exactly one new pane after splitting in a nested layout', () => {
    const oldIds = new Set(getLeafIds(nestedLayout))
    const newTree = splitPane(nestedLayout, 'pane-D', 'vertical')
    const newIds = getLeafIds(newTree)
    const addedIds = newIds.filter((id) => !oldIds.has(id))
    expect(addedIds).toHaveLength(1)
  })

  it('finds exactly one new pane after splitting in a deeply nested layout', () => {
    const oldIds = new Set(getLeafIds(deeplyNested))
    const newTree = splitPane(deeplyNested, 'pane-B', 'horizontal')
    const newIds = getLeafIds(newTree)
    const addedIds = newIds.filter((id) => !oldIds.has(id))
    expect(addedIds).toHaveLength(1)
  })

  it('no new pane when splitting a non-existent paneId', () => {
    const oldIds = new Set(getLeafIds(twoChildSplit))
    const newTree = splitPane(twoChildSplit, 'nonexistent', 'horizontal')
    const newIds = getLeafIds(newTree)
    const addedIds = newIds.filter((id) => !oldIds.has(id))
    expect(addedIds).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Tests: findNewLeafAfterSplit
// ---------------------------------------------------------------------------

describe('findNewLeafAfterSplit', () => {
  it('returns the new leaf created by splitting a single leaf', () => {
    const before = singleLeaf
    const after = splitPane(before, 'pane-A', 'horizontal')

    const newLeaf = findNewLeafAfterSplit(before, after)

    expect(newLeaf).toBeDefined()
    expect(newLeaf?.id).not.toBe('pane-A')
    expect(newLeaf?._tag).toBe('LeafNode')
    expect(newLeaf?.paneType).toBe('terminal')
  })

  it('returns the new leaf when splitting within a flat split', () => {
    const before = twoChildSplit
    const after = splitPane(before, 'pane-B', 'horizontal')

    const newLeaf = findNewLeafAfterSplit(before, after)

    expect(newLeaf).toBeDefined()
    expect(newLeaf?.id).not.toBe('pane-A')
    expect(newLeaf?.id).not.toBe('pane-B')
  })

  it('returns undefined when before and after have the same leaves', () => {
    // No actual split occurred (e.g., paneId not found)
    const newLeaf = findNewLeafAfterSplit(twoChildSplit, twoChildSplit)
    expect(newLeaf).toBeUndefined()
  })

  it('inherits the workspaceId from the split source pane', () => {
    const leafWithWs: LeafNode = {
      _tag: 'LeafNode',
      id: 'pane-A',
      paneType: 'terminal',
      workspaceId: 'ws-1',
    }
    const after = splitPane(leafWithWs, 'pane-A', 'vertical')

    const newLeaf = findNewLeafAfterSplit(leafWithWs, after)

    expect(newLeaf).toBeDefined()
    expect(newLeaf?.workspaceId).toBe('ws-1')
  })
})

// ---------------------------------------------------------------------------
// Tests: sortWorkspaceLayouts
// ---------------------------------------------------------------------------

describe('sortWorkspaceLayouts', () => {
  const wsA: LeafNode = {
    _tag: 'LeafNode',
    id: 'pane-A',
    paneType: 'terminal',
    workspaceId: 'ws-1',
  }
  const wsB: LeafNode = {
    _tag: 'LeafNode',
    id: 'pane-B',
    paneType: 'terminal',
    workspaceId: 'ws-2',
  }
  const wsC: LeafNode = {
    _tag: 'LeafNode',
    id: 'pane-C',
    paneType: 'terminal',
    workspaceId: 'ws-3',
  }

  const layouts = [
    { workspaceId: 'ws-1' as string | undefined, subLayout: wsA },
    { workspaceId: 'ws-2' as string | undefined, subLayout: wsB },
    { workspaceId: 'ws-3' as string | undefined, subLayout: wsC },
  ]

  it('preserves original order when workspaceOrder is null', () => {
    const result = sortWorkspaceLayouts(layouts, null)
    expect(result.map((l) => l.workspaceId)).toEqual(['ws-1', 'ws-2', 'ws-3'])
  })

  it('sorts workspaces by explicit order', () => {
    const result = sortWorkspaceLayouts(layouts, ['ws-3', 'ws-1', 'ws-2'])
    expect(result.map((l) => l.workspaceId)).toEqual(['ws-3', 'ws-1', 'ws-2'])
  })

  it('appends workspaces not in the explicit order at the end', () => {
    // ws-3 is not in the order — it should appear after ws-2, ws-1
    const result = sortWorkspaceLayouts(layouts, ['ws-2', 'ws-1'])
    expect(result.map((l) => l.workspaceId)).toEqual(['ws-2', 'ws-1', 'ws-3'])
  })

  it('preserves original order when workspaceOrder is empty', () => {
    const result = sortWorkspaceLayouts(layouts, [])
    expect(result.map((l) => l.workspaceId)).toEqual(['ws-1', 'ws-2', 'ws-3'])
  })

  it('places undefined workspaceId entries at the end', () => {
    const withUndefined = [
      ...layouts,
      {
        workspaceId: undefined as string | undefined,
        subLayout: {
          _tag: 'LeafNode' as const,
          id: 'pane-empty',
          paneType: 'terminal' as const,
        },
      },
    ]
    const result = sortWorkspaceLayouts(withUndefined, ['ws-3', 'ws-2', 'ws-1'])
    expect(result.map((l) => l.workspaceId)).toEqual([
      'ws-3',
      'ws-2',
      'ws-1',
      undefined,
    ])
  })

  it('does not mutate the input array', () => {
    const original = [...layouts]
    sortWorkspaceLayouts(layouts, ['ws-3', 'ws-2', 'ws-1'])
    expect(layouts.map((l) => l.workspaceId)).toEqual(
      original.map((l) => l.workspaceId)
    )
  })
})

// ---------------------------------------------------------------------------
// Tests: isWorkspaceFrameData
// ---------------------------------------------------------------------------

describe('isWorkspaceFrameData', () => {
  it('returns true for valid workspace frame drag data', () => {
    expect(
      isWorkspaceFrameData({
        type: WORKSPACE_FRAME_TYPE,
        workspaceId: 'ws-1',
        index: 0,
      })
    ).toBe(true)
  })

  it('returns false when type does not match', () => {
    expect(
      isWorkspaceFrameData({
        type: 'something-else',
        workspaceId: 'ws-1',
        index: 0,
      })
    ).toBe(false)
  })

  it('returns false for empty object', () => {
    expect(isWorkspaceFrameData({})).toBe(false)
  })

  it('returns false when type is missing', () => {
    expect(isWorkspaceFrameData({ workspaceId: 'ws-1', index: 0 })).toBe(false)
  })
})
