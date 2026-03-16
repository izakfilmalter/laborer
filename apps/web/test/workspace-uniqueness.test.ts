/**
 * Unit tests for workspace uniqueness enforcement utilities.
 *
 * Tests the pure functions `removeWorkspaceFromLayout`, `moveWorkspace`,
 * and `addWorkspaceToTabUnique` in `window-tab-utils.ts` that enforce the
 * constraint: a workspace can only be open in one window tab at a time.
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
  addWorkspaceToTabUnique,
  moveWorkspace,
  removeWorkspaceFromLayout,
} from '../src/panels/window-tab-utils'
import {
  addWorkspaceToTab,
  removeWorkspaceFromTab,
} from '../src/panels/workspace-tile-utils'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

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

function makePanelTab(id: string, leaf: PanelLeafNode): PanelTab {
  return {
    id,
    panelLayout: leaf,
    focusedPaneId: leaf.id,
  }
}

function makeWorkspaceTile(id: string, workspaceId: string): WorkspaceTileLeaf {
  const leaf = makeLeaf(
    `pane-${workspaceId}`,
    `term-${workspaceId}`,
    workspaceId
  )
  const panelTab = makePanelTab(`pt-${workspaceId}`, leaf)
  return {
    _tag: 'WorkspaceTileLeaf',
    id,
    workspaceId,
    panelTabs: [panelTab],
    activePanelTabId: panelTab.id,
  }
}

function makeTabWithWorkspace(tabId: string, workspaceId: string): WindowTab {
  return {
    id: tabId,
    workspaceLayout: makeWorkspaceTile(`tile-${workspaceId}`, workspaceId),
  }
}

function makeTabWithMultipleWorkspaces(
  tabId: string,
  workspaceIds: string[]
): WindowTab {
  const tiles = workspaceIds.map((wsId) =>
    makeWorkspaceTile(`tile-${wsId}`, wsId)
  )
  if (tiles.length === 0) {
    return { id: tabId }
  }
  if (tiles.length === 1) {
    return { id: tabId, workspaceLayout: tiles[0] }
  }
  const equalSize = 100 / tiles.length
  const split: WorkspaceTileSplit = {
    _tag: 'WorkspaceTileSplit',
    id: `split-${tabId}`,
    direction: 'horizontal',
    children: tiles,
    sizes: tiles.map(() => equalSize),
  }
  return { id: tabId, workspaceLayout: split }
}

/** Collect all workspace IDs from a tile tree. */
function collectWorkspaceIds(node: WorkspaceTileNode): string[] {
  if (node._tag === 'WorkspaceTileLeaf') {
    return [node.workspaceId]
  }
  return node.children.flatMap(collectWorkspaceIds)
}

/** Count occurrences of a workspace ID across all tabs. */
function countWorkspaceInLayout(
  layout: WindowLayout,
  workspaceId: string
): number {
  let count = 0
  for (const tab of layout.tabs) {
    if (tab.workspaceLayout) {
      count += collectWorkspaceIds(tab.workspaceLayout).filter(
        (id) => id === workspaceId
      ).length
    }
  }
  return count
}

const emptyLayout: WindowLayout = { tabs: [] }

// ---------------------------------------------------------------------------
// removeWorkspaceFromLayout
// ---------------------------------------------------------------------------

describe('removeWorkspaceFromLayout', () => {
  it('returns layout unchanged when workspace is not found', () => {
    const layout: WindowLayout = {
      tabs: [makeTabWithWorkspace('tab-1', 'ws-1')],
      activeTabId: 'tab-1',
    }
    const result = removeWorkspaceFromLayout(
      layout,
      'ws-nonexistent',
      removeWorkspaceFromTab
    )
    expect(result).toBe(layout)
  })

  it('returns layout unchanged for empty layout', () => {
    const result = removeWorkspaceFromLayout(
      emptyLayout,
      'ws-1',
      removeWorkspaceFromTab
    )
    expect(result).toBe(emptyLayout)
  })

  it('removes a workspace from the tab that contains it', () => {
    const layout: WindowLayout = {
      tabs: [
        makeTabWithMultipleWorkspaces('tab-1', ['ws-1', 'ws-2']),
        makeTabWithWorkspace('tab-2', 'ws-3'),
      ],
      activeTabId: 'tab-1',
    }
    const result = removeWorkspaceFromLayout(
      layout,
      'ws-1',
      removeWorkspaceFromTab
    )

    expect(result.tabs).toHaveLength(2)

    // tab-1 should only have ws-2
    const tab1Layout = result.tabs[0]?.workspaceLayout
    expect(tab1Layout).toBeDefined()
    expect(tab1Layout?._tag).toBe('WorkspaceTileLeaf')
    expect((tab1Layout as WorkspaceTileLeaf).workspaceId).toBe('ws-2')

    // tab-2 is unchanged (referential equality)
    expect(result.tabs[1]).toBe(layout.tabs[1])
  })

  it('removes the only workspace from a tab, making it empty', () => {
    const layout: WindowLayout = {
      tabs: [
        makeTabWithWorkspace('tab-1', 'ws-1'),
        makeTabWithWorkspace('tab-2', 'ws-2'),
      ],
      activeTabId: 'tab-1',
    }
    const result = removeWorkspaceFromLayout(
      layout,
      'ws-1',
      removeWorkspaceFromTab
    )

    expect(result.tabs[0]?.workspaceLayout).toBeUndefined()
    expect(result.tabs[1]).toBe(layout.tabs[1])
  })

  it('removes a workspace from a nested tile split', () => {
    const tab: WindowTab = {
      id: 'tab-1',
      workspaceLayout: {
        _tag: 'WorkspaceTileSplit',
        id: 'split-root',
        direction: 'horizontal',
        children: [
          makeWorkspaceTile('tile-ws-1', 'ws-1'),
          {
            _tag: 'WorkspaceTileSplit',
            id: 'split-nested',
            direction: 'vertical',
            children: [
              makeWorkspaceTile('tile-ws-2', 'ws-2'),
              makeWorkspaceTile('tile-ws-3', 'ws-3'),
            ],
            sizes: [50, 50],
          },
        ],
        sizes: [50, 50],
      },
    }
    const layout: WindowLayout = {
      tabs: [tab],
      activeTabId: 'tab-1',
    }

    const result = removeWorkspaceFromLayout(
      layout,
      'ws-2',
      removeWorkspaceFromTab
    )

    const tab1Layout = result.tabs[0]?.workspaceLayout
    expect(tab1Layout).toBeDefined()
    const wsIds = tab1Layout ? collectWorkspaceIds(tab1Layout) : []
    expect(wsIds).toContain('ws-1')
    expect(wsIds).toContain('ws-3')
    expect(wsIds).not.toContain('ws-2')
  })

  it('preserves activeTabId', () => {
    const layout: WindowLayout = {
      tabs: [
        makeTabWithMultipleWorkspaces('tab-1', ['ws-1', 'ws-2']),
        makeTabWithWorkspace('tab-2', 'ws-3'),
      ],
      activeTabId: 'tab-2',
    }
    const result = removeWorkspaceFromLayout(
      layout,
      'ws-1',
      removeWorkspaceFromTab
    )
    expect(result.activeTabId).toBe('tab-2')
  })
})

// ---------------------------------------------------------------------------
// moveWorkspace
// ---------------------------------------------------------------------------

describe('moveWorkspace', () => {
  it('is a no-op when workspace is already in the target tab', () => {
    const layout: WindowLayout = {
      tabs: [
        makeTabWithWorkspace('tab-1', 'ws-1'),
        makeTabWithWorkspace('tab-2', 'ws-2'),
      ],
      activeTabId: 'tab-1',
    }
    const result = moveWorkspace(
      layout,
      'ws-1',
      'tab-1',
      removeWorkspaceFromTab,
      addWorkspaceToTab
    )
    expect(result).toBe(layout)
  })

  it('moves a workspace from one tab to another', () => {
    const layout: WindowLayout = {
      tabs: [
        makeTabWithMultipleWorkspaces('tab-1', ['ws-1', 'ws-2']),
        makeTabWithWorkspace('tab-2', 'ws-3'),
      ],
      activeTabId: 'tab-1',
    }
    const result = moveWorkspace(
      layout,
      'ws-1',
      'tab-2',
      removeWorkspaceFromTab,
      addWorkspaceToTab
    )

    // tab-1 should only have ws-2
    const tab1Layout = result.tabs[0]?.workspaceLayout
    expect(tab1Layout?._tag).toBe('WorkspaceTileLeaf')
    expect((tab1Layout as WorkspaceTileLeaf).workspaceId).toBe('ws-2')

    // tab-2 should have ws-3 and ws-1
    const tab2Layout = result.tabs[1]?.workspaceLayout
    expect(tab2Layout?._tag).toBe('WorkspaceTileSplit')
    const tab2WsIds = tab2Layout ? collectWorkspaceIds(tab2Layout) : []
    expect(tab2WsIds).toContain('ws-1')
    expect(tab2WsIds).toContain('ws-3')
  })

  it('adds a workspace to an empty tab', () => {
    const layout: WindowLayout = {
      tabs: [makeTabWithWorkspace('tab-1', 'ws-1'), { id: 'tab-2' }],
      activeTabId: 'tab-1',
    }
    const result = moveWorkspace(
      layout,
      'ws-1',
      'tab-2',
      removeWorkspaceFromTab,
      addWorkspaceToTab
    )

    // tab-1 should now be empty
    expect(result.tabs[0]?.workspaceLayout).toBeUndefined()

    // tab-2 should have ws-1
    const tab2Layout = result.tabs[1]?.workspaceLayout
    expect(tab2Layout?._tag).toBe('WorkspaceTileLeaf')
    expect((tab2Layout as WorkspaceTileLeaf).workspaceId).toBe('ws-1')
  })

  it('adds a workspace not currently in any tab', () => {
    const layout: WindowLayout = {
      tabs: [makeTabWithWorkspace('tab-1', 'ws-1'), { id: 'tab-2' }],
      activeTabId: 'tab-1',
    }
    const result = moveWorkspace(
      layout,
      'ws-new',
      'tab-2',
      removeWorkspaceFromTab,
      addWorkspaceToTab
    )

    // tab-1 unchanged
    expect(result.tabs[0]).toBe(layout.tabs[0])

    // tab-2 should have ws-new
    const tab2Layout = result.tabs[1]?.workspaceLayout
    expect(tab2Layout?._tag).toBe('WorkspaceTileLeaf')
    expect((tab2Layout as WorkspaceTileLeaf).workspaceId).toBe('ws-new')
  })

  it('preserves activeTabId during move', () => {
    const layout: WindowLayout = {
      tabs: [
        makeTabWithMultipleWorkspaces('tab-1', ['ws-1', 'ws-2']),
        makeTabWithWorkspace('tab-2', 'ws-3'),
      ],
      activeTabId: 'tab-2',
    }
    const result = moveWorkspace(
      layout,
      'ws-1',
      'tab-2',
      removeWorkspaceFromTab,
      addWorkspaceToTab
    )
    expect(result.activeTabId).toBe('tab-2')
  })

  it('immutability: does not modify the original layout', () => {
    const layout: WindowLayout = {
      tabs: [
        makeTabWithMultipleWorkspaces('tab-1', ['ws-1', 'ws-2']),
        makeTabWithWorkspace('tab-2', 'ws-3'),
      ],
      activeTabId: 'tab-1',
    }
    const originalTabCount = layout.tabs.length
    const originalTab1Ws = layout.tabs[0]?.workspaceLayout
    moveWorkspace(
      layout,
      'ws-1',
      'tab-2',
      removeWorkspaceFromTab,
      addWorkspaceToTab
    )
    expect(layout.tabs).toHaveLength(originalTabCount)
    expect(layout.tabs[0]?.workspaceLayout).toBe(originalTab1Ws)
  })
})

// ---------------------------------------------------------------------------
// addWorkspaceToTabUnique
// ---------------------------------------------------------------------------

describe('addWorkspaceToTabUnique', () => {
  it('adds a workspace to the target tab when it is not open anywhere', () => {
    const layout: WindowLayout = {
      tabs: [makeTabWithWorkspace('tab-1', 'ws-1'), { id: 'tab-2' }],
      activeTabId: 'tab-1',
    }
    const result = addWorkspaceToTabUnique(
      layout,
      'ws-new',
      'tab-2',
      removeWorkspaceFromTab,
      addWorkspaceToTab
    )

    // tab-1 unchanged
    expect(result.tabs[0]).toBe(layout.tabs[0])

    // tab-2 now has ws-new
    const tab2Layout = result.tabs[1]?.workspaceLayout
    expect(tab2Layout?._tag).toBe('WorkspaceTileLeaf')
    expect((tab2Layout as WorkspaceTileLeaf).workspaceId).toBe('ws-new')
  })

  it('moves a workspace from another tab to the target tab', () => {
    const layout: WindowLayout = {
      tabs: [
        makeTabWithMultipleWorkspaces('tab-1', ['ws-1', 'ws-2']),
        makeTabWithWorkspace('tab-2', 'ws-3'),
        { id: 'tab-3' },
      ],
      activeTabId: 'tab-1',
    }
    const result = addWorkspaceToTabUnique(
      layout,
      'ws-1',
      'tab-3',
      removeWorkspaceFromTab,
      addWorkspaceToTab
    )

    // tab-1 should only have ws-2
    const tab1Layout = result.tabs[0]?.workspaceLayout
    expect(tab1Layout?._tag).toBe('WorkspaceTileLeaf')
    expect((tab1Layout as WorkspaceTileLeaf).workspaceId).toBe('ws-2')

    // tab-2 unchanged
    expect(result.tabs[1]).toBe(layout.tabs[1])

    // tab-3 should have ws-1
    const tab3Layout = result.tabs[2]?.workspaceLayout
    expect(tab3Layout?._tag).toBe('WorkspaceTileLeaf')
    expect((tab3Layout as WorkspaceTileLeaf).workspaceId).toBe('ws-1')
  })

  it('is a no-op when workspace is already in the target tab', () => {
    const layout: WindowLayout = {
      tabs: [
        makeTabWithWorkspace('tab-1', 'ws-1'),
        makeTabWithWorkspace('tab-2', 'ws-2'),
      ],
      activeTabId: 'tab-1',
    }
    const result = addWorkspaceToTabUnique(
      layout,
      'ws-1',
      'tab-1',
      removeWorkspaceFromTab,
      addWorkspaceToTab
    )
    expect(result).toBe(layout)
  })

  it('handles empty layout', () => {
    const result = addWorkspaceToTabUnique(
      emptyLayout,
      'ws-1',
      'tab-nonexistent',
      removeWorkspaceFromTab,
      addWorkspaceToTab
    )
    expect(result).toBe(emptyLayout)
  })

  it('enforces no duplicate workspace views after move', () => {
    const layout: WindowLayout = {
      tabs: [
        makeTabWithWorkspace('tab-1', 'ws-1'),
        makeTabWithWorkspace('tab-2', 'ws-2'),
      ],
      activeTabId: 'tab-1',
    }
    const result = addWorkspaceToTabUnique(
      layout,
      'ws-1',
      'tab-2',
      removeWorkspaceFromTab,
      addWorkspaceToTab
    )

    expect(countWorkspaceInLayout(result, 'ws-1')).toBe(1)
  })

  it('workspace ends up in the target tab after move', () => {
    const layout: WindowLayout = {
      tabs: [
        makeTabWithMultipleWorkspaces('tab-1', ['ws-1', 'ws-2', 'ws-3']),
        makeTabWithWorkspace('tab-2', 'ws-4'),
      ],
      activeTabId: 'tab-1',
    }
    const result = addWorkspaceToTabUnique(
      layout,
      'ws-2',
      'tab-2',
      removeWorkspaceFromTab,
      addWorkspaceToTab
    )

    // tab-2 should contain both ws-4 and ws-2
    const tab2Layout = result.tabs[1]?.workspaceLayout
    expect(tab2Layout?._tag).toBe('WorkspaceTileSplit')
    const tab2WsIds = tab2Layout ? collectWorkspaceIds(tab2Layout) : []
    expect(tab2WsIds).toContain('ws-2')
    expect(tab2WsIds).toContain('ws-4')

    // tab-1 should have ws-1 and ws-3 (ws-2 removed)
    const tab1Layout = result.tabs[0]?.workspaceLayout
    expect(tab1Layout?._tag).toBe('WorkspaceTileSplit')
    const tab1WsIds = tab1Layout ? collectWorkspaceIds(tab1Layout) : []
    expect(tab1WsIds).toContain('ws-1')
    expect(tab1WsIds).toContain('ws-3')
    expect(tab1WsIds).not.toContain('ws-2')
  })

  it('uniqueness holds after multiple sequential operations', () => {
    let layout: WindowLayout = {
      tabs: [
        makeTabWithMultipleWorkspaces('tab-1', ['ws-1', 'ws-2']),
        makeTabWithWorkspace('tab-2', 'ws-3'),
        { id: 'tab-3' },
      ],
      activeTabId: 'tab-1',
    }

    // Move ws-1 from tab-1 to tab-3
    layout = addWorkspaceToTabUnique(
      layout,
      'ws-1',
      'tab-3',
      removeWorkspaceFromTab,
      addWorkspaceToTab
    )
    expect(countWorkspaceInLayout(layout, 'ws-1')).toBe(1)

    // Move ws-3 from tab-2 to tab-3
    layout = addWorkspaceToTabUnique(
      layout,
      'ws-3',
      'tab-3',
      removeWorkspaceFromTab,
      addWorkspaceToTab
    )
    expect(countWorkspaceInLayout(layout, 'ws-3')).toBe(1)

    // Move ws-2 from tab-1 to tab-2
    layout = addWorkspaceToTabUnique(
      layout,
      'ws-2',
      'tab-2',
      removeWorkspaceFromTab,
      addWorkspaceToTab
    )
    expect(countWorkspaceInLayout(layout, 'ws-2')).toBe(1)

    // All workspaces exist exactly once
    expect(countWorkspaceInLayout(layout, 'ws-1')).toBe(1)
    expect(countWorkspaceInLayout(layout, 'ws-2')).toBe(1)
    expect(countWorkspaceInLayout(layout, 'ws-3')).toBe(1)
  })
})
