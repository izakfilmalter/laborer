/**
 * Unit tests for multi-column workspace tile layout utilities.
 *
 * Covers dragging a workspace to a frame edge (`moveWorkspaceTileToEdge`)
 * — including creating a second column by dropping on a left/right edge —
 * the layout clean-up that fills columns to the minimum frame height and
 * caps them at the minimum column width (`cleanUpWorkspaceTiles`), adding workspaces to
 * column layouts (`addWorkspaceToTab`), and the pointer-to-edge mapping
 * used by the drop targets (`computeWorkspaceDropEdge`).
 *
 * @see apps/web/src/panels/workspace-tile-utils.ts
 * @see apps/web/src/panels/window-layout-utils.ts
 */

import type {
  WindowTab,
  WorkspaceTileLeaf,
  WorkspaceTileNode,
  WorkspaceTileSplit,
} from '@laborer/shared/types'
import { describe, expect, it } from 'vitest'
import { computeWorkspaceDropEdge } from '../src/panels/window-layout-utils'
import {
  addWorkspaceToTab,
  cleanUpWorkspaceTiles,
  getWorkspaceColumns,
  MIN_WORKSPACE_COLUMN_WIDTH_PX,
  MIN_WORKSPACE_TILE_HEIGHT_PX,
  moveWorkspaceTileBelow,
  moveWorkspaceTileToEdge,
} from '../src/panels/workspace-tile-utils'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** A workspace tile leaf without panel tabs (irrelevant for layout math). */
function makeTile(workspaceId: string): WorkspaceTileLeaf {
  return {
    _tag: 'WorkspaceTileLeaf',
    id: `tile-${workspaceId}`,
    workspaceId,
    panelTabs: [],
    activePanelTabId: undefined,
  }
}

/** A vertical stack of workspace tiles (a single column). */
function makeColumn(
  id: string,
  workspaceIds: readonly string[]
): WorkspaceTileNode {
  const children = workspaceIds.map(makeTile)
  const first = children[0]
  if (children.length === 1 && first) {
    return first
  }
  return {
    _tag: 'WorkspaceTileSplit',
    id,
    direction: 'vertical',
    children,
    sizes: children.map(() => 100 / children.length),
  }
}

/** A tab whose root is a vertical stack (the classic single-column layout). */
function makeStackTab(workspaceIds: readonly string[]): WindowTab {
  return { id: 'tab-1', workspaceLayout: makeColumn('col-1', workspaceIds) }
}

/** A tab whose root is a horizontal split of vertical columns. */
function makeColumnsTab(columns: readonly (readonly string[])[]): WindowTab {
  const children = columns.map((ids, i) => makeColumn(`col-${i + 1}`, ids))
  return {
    id: 'tab-1',
    workspaceLayout: {
      _tag: 'WorkspaceTileSplit',
      id: 'root',
      direction: 'horizontal',
      children,
      sizes: children.map(() => 100 / children.length),
    },
  }
}

/** Read the resulting layout back as workspace-id columns. */
function columnsOf(tab: WindowTab): string[][] {
  if (!tab.workspaceLayout) {
    return []
  }
  return getWorkspaceColumns(tab.workspaceLayout).map((column) =>
    column.map((leaf) => leaf.workspaceId)
  )
}

// ---------------------------------------------------------------------------
// moveWorkspaceTileToEdge — creating and moving between columns
// ---------------------------------------------------------------------------

describe('moveWorkspaceTileToEdge', () => {
  it('moves a sub-workspace below its parent without changing row sizes', () => {
    const tab = makeStackTab(['ws-parent', 'ws-sibling', 'ws-child'])
    const root = tab.workspaceLayout as WorkspaceTileSplit
    const resized: WindowTab = {
      ...tab,
      workspaceLayout: { ...root, sizes: [50, 30, 20] },
    }

    const result = moveWorkspaceTileBelow(resized, 'ws-child', 'ws-parent')

    expect(columnsOf(result)).toEqual([['ws-parent', 'ws-child', 'ws-sibling']])
    expect((result.workspaceLayout as WorkspaceTileSplit).sizes).toEqual([
      50, 20, 30,
    ])
  })

  it('creates a second column when dropping on another frame’s right edge', () => {
    const tab = makeStackTab(['ws-1', 'ws-2', 'ws-3'])

    const result = moveWorkspaceTileToEdge(tab, 'ws-3', 'ws-1', 'right')

    expect(columnsOf(result)).toEqual([['ws-1', 'ws-2'], ['ws-3']])
    const root = result.workspaceLayout as WorkspaceTileSplit
    expect(root._tag).toBe('WorkspaceTileSplit')
    expect(root.direction).toBe('horizontal')
    expect(root.sizes).toEqual([50, 50])
  })

  it('creates a column on the left when dropping on a left edge', () => {
    const tab = makeStackTab(['ws-1', 'ws-2', 'ws-3'])

    const result = moveWorkspaceTileToEdge(tab, 'ws-3', 'ws-1', 'left')

    expect(columnsOf(result)).toEqual([['ws-3'], ['ws-1', 'ws-2']])
  })

  it('moves a workspace into its own column when dropped on its own right edge', () => {
    const tab = makeStackTab(['ws-1', 'ws-2', 'ws-3'])

    const result = moveWorkspaceTileToEdge(tab, 'ws-2', 'ws-2', 'right')

    expect(columnsOf(result)).toEqual([['ws-1', 'ws-3'], ['ws-2']])
  })

  it('reorders within a column for top/bottom edges', () => {
    const tab = makeStackTab(['ws-1', 'ws-2', 'ws-3'])

    const droppedAbove = moveWorkspaceTileToEdge(tab, 'ws-3', 'ws-1', 'top')
    expect(columnsOf(droppedAbove)).toEqual([['ws-3', 'ws-1', 'ws-2']])

    const droppedBelow = moveWorkspaceTileToEdge(tab, 'ws-1', 'ws-3', 'bottom')
    expect(columnsOf(droppedBelow)).toEqual([['ws-2', 'ws-3', 'ws-1']])
  })

  it('moves a workspace into another column and removes the emptied column', () => {
    const tab = makeColumnsTab([['ws-1', 'ws-2'], ['ws-3']])

    const result = moveWorkspaceTileToEdge(tab, 'ws-3', 'ws-1', 'bottom')

    expect(columnsOf(result)).toEqual([['ws-1', 'ws-3', 'ws-2']])
    // Single remaining column collapses — no horizontal root left over.
    const root = result.workspaceLayout as WorkspaceTileSplit
    expect(root.direction).toBe('vertical')
  })

  it('preserves column widths when the column count is unchanged', () => {
    const tab = makeColumnsTab([['ws-1', 'ws-2'], ['ws-3']])
    const root = tab.workspaceLayout as WorkspaceTileSplit
    const widenedTab: WindowTab = {
      ...tab,
      workspaceLayout: { ...root, sizes: [70, 30] },
    }

    const result = moveWorkspaceTileToEdge(widenedTab, 'ws-2', 'ws-3', 'bottom')

    expect(columnsOf(result)).toEqual([['ws-1'], ['ws-3', 'ws-2']])
    const newRoot = result.workspaceLayout as WorkspaceTileSplit
    expect(newRoot.sizes).toEqual([70, 30])
  })

  it('keeps untouched columns’ node identity so their frames do not remount', () => {
    const tab = makeColumnsTab([['ws-1', 'ws-2'], ['ws-3'], ['ws-4']])
    const root = tab.workspaceLayout as WorkspaceTileSplit
    const untouchedColumn = root.children[0] as WorkspaceTileSplit

    const result = moveWorkspaceTileToEdge(tab, 'ws-4', 'ws-3', 'bottom')

    const newRoot = result.workspaceLayout as WorkspaceTileSplit
    const preserved = newRoot.children[0] as WorkspaceTileSplit
    expect(preserved.id).toBe(untouchedColumn.id)
    expect(preserved.children).toEqual(untouchedColumn.children)
  })

  it('is a no-op for self drops on top/bottom and for unknown workspaces', () => {
    const tab = makeStackTab(['ws-1', 'ws-2'])

    expect(moveWorkspaceTileToEdge(tab, 'ws-1', 'ws-1', 'top')).toBe(tab)
    expect(moveWorkspaceTileToEdge(tab, 'ws-1', 'ws-1', 'bottom')).toBe(tab)
    expect(moveWorkspaceTileToEdge(tab, 'ws-9', 'ws-1', 'right')).toBe(tab)
    expect(moveWorkspaceTileToEdge(tab, 'ws-1', 'ws-9', 'right')).toBe(tab)
  })

  it('is a no-op when the arrangement would not change', () => {
    const tab = makeColumnsTab([['ws-1'], ['ws-2']])

    // ws-2 already lives alone in the column right of ws-1.
    const result = moveWorkspaceTileToEdge(tab, 'ws-2', 'ws-1', 'right')

    expect(result).toBe(tab)
  })

  it('is idempotent — repeating the same drop changes nothing', () => {
    const tab = makeStackTab(['ws-1', 'ws-2', 'ws-3'])

    const once = moveWorkspaceTileToEdge(tab, 'ws-3', 'ws-1', 'right')
    const twice = moveWorkspaceTileToEdge(once, 'ws-3', 'ws-1', 'right')

    expect(twice).toBe(once)
  })
})

// ---------------------------------------------------------------------------
// cleanUpWorkspaceTiles — columns capped by width, filled by height
// ---------------------------------------------------------------------------

/** Content area sized as a multiple of the minimum column and row. */
function area(columns: number, rows: number) {
  return {
    widthPx: MIN_WORKSPACE_COLUMN_WIDTH_PX * columns,
    heightPx: MIN_WORKSPACE_TILE_HEIGHT_PX * rows,
  }
}

describe('cleanUpWorkspaceTiles', () => {
  it('fills columns vertically before opening another column', () => {
    // 3 columns fit by width and 3 rows fit by height, but 6 workspaces
    // only need 2 full columns — prefer 2 stacks of 3 over 3 stacks of 2.
    const tab = makeStackTab(['ws-1', 'ws-2', 'ws-3', 'ws-4', 'ws-5', 'ws-6'])

    const result = cleanUpWorkspaceTiles(tab, area(3, 3))

    expect(columnsOf(result)).toEqual([
      ['ws-1', 'ws-2', 'ws-3'],
      ['ws-4', 'ws-5', 'ws-6'],
    ])
  })

  it('spreads across the columns width allows when frames need height', () => {
    // 2 rows per column would need ceil(5 / 2) = 3 columns, and 3 fit by
    // width, so the stack balances 2/2/1.
    const tab = makeStackTab(['ws-1', 'ws-2', 'ws-3', 'ws-4', 'ws-5'])

    const result = cleanUpWorkspaceTiles(tab, area(3, 2))

    expect(columnsOf(result)).toEqual([
      ['ws-1', 'ws-2'],
      ['ws-3', 'ws-4'],
      ['ws-5'],
    ])
    const root = result.workspaceLayout as WorkspaceTileSplit
    expect(root.direction).toBe('horizontal')
    expect(root.sizes).toEqual([100 / 3, 100 / 3, 100 / 3])
    for (const child of root.children) {
      if (child._tag === 'WorkspaceTileSplit') {
        expect(child.sizes).toEqual(
          child.children.map(() => 100 / child.children.length)
        )
      }
    }
  })

  it('caps columns at what the width fits, however short the area', () => {
    // Height alone would want a column per workspace; width allows 2.
    const tab = makeStackTab(['ws-1', 'ws-2', 'ws-3', 'ws-4'])

    const result = cleanUpWorkspaceTiles(tab, area(2, 1))

    expect(columnsOf(result)).toEqual([
      ['ws-1', 'ws-2'],
      ['ws-3', 'ws-4'],
    ])
  })

  it('merges excess columns back when the content area is narrow', () => {
    const tab = makeColumnsTab([['ws-1'], ['ws-2'], ['ws-3']])

    // Only one 500px column fits: everything stacks in a single column.
    const result = cleanUpWorkspaceTiles(tab, area(1, 3))

    expect(columnsOf(result)).toEqual([['ws-1', 'ws-2', 'ws-3']])
  })

  it('equalizes squished rows even when the arrangement is unchanged', () => {
    const column: WorkspaceTileSplit = {
      _tag: 'WorkspaceTileSplit',
      id: 'col-1',
      direction: 'vertical',
      children: [makeTile('ws-1'), makeTile('ws-2')],
      sizes: [90, 10],
    }
    const tab: WindowTab = { id: 'tab-1', workspaceLayout: column }

    const result = cleanUpWorkspaceTiles(tab, area(1, 2))

    expect(columnsOf(result)).toEqual([['ws-1', 'ws-2']])
    const root = result.workspaceLayout as WorkspaceTileSplit
    expect(root.sizes).toEqual([50, 50])
    // Node id survives so the column's frames do not remount.
    expect(root.id).toBe('col-1')
  })

  it('never creates more columns than workspaces', () => {
    const tab = makeStackTab(['ws-1', 'ws-2'])

    const result = cleanUpWorkspaceTiles(tab, area(8, 1))

    expect(columnsOf(result)).toEqual([['ws-1'], ['ws-2']])
  })

  it('keeps a single column when the area is smaller than one frame', () => {
    const tab = makeColumnsTab([['ws-1'], ['ws-2']])

    const result = cleanUpWorkspaceTiles(tab, { widthPx: 10, heightPx: 10 })

    expect(columnsOf(result)).toEqual([['ws-1', 'ws-2']])
  })

  it('is a no-op for tabs without a workspace layout', () => {
    const tab: WindowTab = { id: 'tab-1' }
    expect(cleanUpWorkspaceTiles(tab, area(3, 3))).toBe(tab)
  })
})

// ---------------------------------------------------------------------------
// addWorkspaceToTab — column-aware appends
// ---------------------------------------------------------------------------

describe('addWorkspaceToTab with a column layout', () => {
  it('adds the new workspace to the column with the fewest workspaces', () => {
    const tab = makeColumnsTab([['ws-1', 'ws-2'], ['ws-3']])

    const result = addWorkspaceToTab(tab, 'ws-4')

    expect(columnsOf(result)).toEqual([
      ['ws-1', 'ws-2'],
      ['ws-3', 'ws-4'],
    ])
    // Column widths untouched.
    const root = result.workspaceLayout as WorkspaceTileSplit
    expect(root.direction).toBe('horizontal')
    expect(root.sizes).toEqual([50, 50])
  })

  it('still stacks vertically for single-column layouts', () => {
    const tab = makeStackTab(['ws-1', 'ws-2'])

    const result = addWorkspaceToTab(tab, 'ws-3')

    expect(columnsOf(result)).toEqual([['ws-1', 'ws-2', 'ws-3']])
  })
})

// ---------------------------------------------------------------------------
// computeWorkspaceDropEdge — pointer position → drop edge
// ---------------------------------------------------------------------------

describe('computeWorkspaceDropEdge', () => {
  const rect = { left: 0, top: 0, width: 1000, height: 400 }

  it('maps the side strips to left/right', () => {
    expect(computeWorkspaceDropEdge({ clientX: 10, clientY: 200 }, rect)).toBe(
      'left'
    )
    expect(computeWorkspaceDropEdge({ clientX: 990, clientY: 200 }, rect)).toBe(
      'right'
    )
  })

  it('maps the middle area to top/bottom halves', () => {
    expect(computeWorkspaceDropEdge({ clientX: 500, clientY: 50 }, rect)).toBe(
      'top'
    )
    expect(computeWorkspaceDropEdge({ clientX: 500, clientY: 350 }, rect)).toBe(
      'bottom'
    )
  })

  it('caps the side strips at 120px on wide frames', () => {
    const wide = { left: 0, top: 0, width: 2000, height: 400 }
    // 20% would be 400px, but the cap keeps 130px in the middle zone.
    expect(computeWorkspaceDropEdge({ clientX: 130, clientY: 50 }, wide)).toBe(
      'top'
    )
    expect(computeWorkspaceDropEdge({ clientX: 110, clientY: 50 }, wide)).toBe(
      'left'
    )
  })
})
