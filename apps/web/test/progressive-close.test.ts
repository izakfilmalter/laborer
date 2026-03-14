/**
 * Unit tests for the progressive close logic.
 *
 * Tests `computeProgressiveCloseAction` — the pure function that determines
 * the correct close action for the progressive `Cmd+W` chain. The chain
 * escalates from innermost to outermost:
 *
 * 1. Multiple panes in active panel tab → close the active pane
 * 2. Single pane in active panel tab → close the panel tab
 * 3. Last panel tab in workspace → remove the workspace
 * 4. Last workspace in window tab → close the window tab
 * 5. Last window tab → close the app
 *
 * @see apps/web/src/panels/window-tab-utils.ts — computeProgressiveCloseAction
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
import { computeProgressiveCloseAction } from '../src/panels/window-tab-utils'

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

function makePanelTab(
  id: string,
  panelLayout: PanelTreeNode,
  focusedPaneId?: string
): PanelTab {
  const firstLeafId =
    panelLayout._tag === 'PanelLeafNode' ? panelLayout.id : undefined
  return {
    id,
    panelLayout,
    focusedPaneId: focusedPaneId ?? firstLeafId,
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

function makeSplitLayout(
  id: string,
  children: PanelTreeNode[]
): PanelSplitNode {
  return {
    _tag: 'PanelSplitNode',
    id,
    direction: 'horizontal',
    children,
    sizes: children.map(() => 100 / children.length),
  }
}

function makeWorkspaceTileSplit(
  id: string,
  children: (WorkspaceTileLeaf | WorkspaceTileSplit)[]
): WorkspaceTileSplit {
  return {
    _tag: 'WorkspaceTileSplit',
    id,
    direction: 'horizontal',
    children,
    sizes: children.map(() => 100 / children.length),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeProgressiveCloseAction', () => {
  describe('no layout / no active pane', () => {
    it('returns close-app when no active pane', () => {
      const result = computeProgressiveCloseAction(undefined, null, undefined)
      expect(result).toEqual({ kind: 'close-app' })
    })

    it('returns close-pane when no hierarchical layout', () => {
      const result = computeProgressiveCloseAction(undefined, 'pane-1', 'ws-1')
      expect(result).toEqual({ kind: 'close-pane', paneId: 'pane-1' })
    })

    it('returns close-app when layout has no tabs', () => {
      const layout: WindowLayout = { tabs: [], activeTabId: undefined }
      const result = computeProgressiveCloseAction(layout, null, undefined)
      expect(result).toEqual({ kind: 'close-app' })
    })

    it('returns close-app when active tab not found', () => {
      const layout: WindowLayout = {
        tabs: [{ id: 'tab-1' }],
        activeTabId: 'tab-missing',
      }
      const result = computeProgressiveCloseAction(layout, 'pane-1', 'ws-1')
      expect(result).toEqual({ kind: 'close-app' })
    })
  })

  describe('no workspace context', () => {
    it('returns close-pane when no activeWorkspaceId', () => {
      const layout: WindowLayout = {
        tabs: [{ id: 'tab-1' }],
        activeTabId: 'tab-1',
      }
      const result = computeProgressiveCloseAction(layout, 'pane-1', undefined)
      expect(result).toEqual({ kind: 'close-pane', paneId: 'pane-1' })
    })

    it('returns close-pane when workspace not found in active tab', () => {
      const tab: WindowTab = {
        id: 'tab-1',
        workspaceLayout: makeWorkspaceTile(
          'tile-1',
          'ws-1',
          [makePanelTab('pt-1', makeLeaf('pane-1', 'term-1', 'ws-1'))],
          'pt-1'
        ),
      }
      const layout: WindowLayout = {
        tabs: [tab],
        activeTabId: 'tab-1',
      }
      // Active workspace is ws-missing which doesn't exist in the tab
      const result = computeProgressiveCloseAction(
        layout,
        'pane-1',
        'ws-missing'
      )
      expect(result).toEqual({ kind: 'close-pane', paneId: 'pane-1' })
    })
  })

  describe('close-pane: multiple panes in active panel tab', () => {
    it('closes pane when panel tab has multiple split panes', () => {
      const splitLayout = makeSplitLayout('split-1', [
        makeLeaf('pane-1', 'term-1', 'ws-1'),
        makeLeaf('pane-2', 'term-2', 'ws-1'),
      ])
      const tab: WindowTab = {
        id: 'tab-1',
        workspaceLayout: makeWorkspaceTile(
          'tile-1',
          'ws-1',
          [makePanelTab('pt-1', splitLayout, 'pane-1')],
          'pt-1'
        ),
      }
      const layout: WindowLayout = {
        tabs: [tab],
        activeTabId: 'tab-1',
      }
      const result = computeProgressiveCloseAction(layout, 'pane-1', 'ws-1')
      expect(result).toEqual({ kind: 'close-pane', paneId: 'pane-1' })
    })

    it('closes pane when panel tab has 3 panes', () => {
      const splitLayout = makeSplitLayout('split-1', [
        makeLeaf('pane-1', 'term-1', 'ws-1'),
        makeLeaf('pane-2', 'term-2', 'ws-1'),
        makeLeaf('pane-3', 'term-3', 'ws-1'),
      ])
      const tab: WindowTab = {
        id: 'tab-1',
        workspaceLayout: makeWorkspaceTile(
          'tile-1',
          'ws-1',
          [makePanelTab('pt-1', splitLayout, 'pane-2')],
          'pt-1'
        ),
      }
      const layout: WindowLayout = {
        tabs: [tab],
        activeTabId: 'tab-1',
      }
      const result = computeProgressiveCloseAction(layout, 'pane-2', 'ws-1')
      expect(result).toEqual({ kind: 'close-pane', paneId: 'pane-2' })
    })
  })

  describe('close-panel-tab: single pane in panel tab, multiple tabs', () => {
    it('closes panel tab when single pane and multiple panel tabs exist', () => {
      const tab: WindowTab = {
        id: 'tab-1',
        workspaceLayout: makeWorkspaceTile(
          'tile-1',
          'ws-1',
          [
            makePanelTab('pt-1', makeLeaf('pane-1', 'term-1', 'ws-1')),
            makePanelTab('pt-2', makeLeaf('pane-2', 'term-2', 'ws-1')),
          ],
          'pt-1'
        ),
      }
      const layout: WindowLayout = {
        tabs: [tab],
        activeTabId: 'tab-1',
      }
      const result = computeProgressiveCloseAction(layout, 'pane-1', 'ws-1')
      expect(result).toEqual({
        kind: 'close-panel-tab',
        tabId: 'pt-1',
        workspaceId: 'ws-1',
      })
    })

    it('closes the correct panel tab when non-first tab is active', () => {
      const tab: WindowTab = {
        id: 'tab-1',
        workspaceLayout: makeWorkspaceTile(
          'tile-1',
          'ws-1',
          [
            makePanelTab('pt-1', makeLeaf('pane-1', 'term-1', 'ws-1')),
            makePanelTab('pt-2', makeLeaf('pane-2', 'term-2', 'ws-1')),
            makePanelTab('pt-3', makeLeaf('pane-3', 'term-3', 'ws-1')),
          ],
          'pt-2' // second tab is active
        ),
      }
      const layout: WindowLayout = {
        tabs: [tab],
        activeTabId: 'tab-1',
      }
      const result = computeProgressiveCloseAction(layout, 'pane-2', 'ws-1')
      expect(result).toEqual({
        kind: 'close-panel-tab',
        tabId: 'pt-2',
        workspaceId: 'ws-1',
      })
    })
  })

  describe('close-workspace: last panel tab, multiple workspaces', () => {
    it('closes workspace when single pane, single panel tab, multiple workspaces', () => {
      const tab: WindowTab = {
        id: 'tab-1',
        workspaceLayout: makeWorkspaceTileSplit('split-1', [
          makeWorkspaceTile(
            'tile-1',
            'ws-1',
            [makePanelTab('pt-1', makeLeaf('pane-1', 'term-1', 'ws-1'))],
            'pt-1'
          ),
          makeWorkspaceTile(
            'tile-2',
            'ws-2',
            [makePanelTab('pt-2', makeLeaf('pane-2', 'term-2', 'ws-2'))],
            'pt-2'
          ),
        ]),
      }
      const layout: WindowLayout = {
        tabs: [tab],
        activeTabId: 'tab-1',
      }
      const result = computeProgressiveCloseAction(layout, 'pane-1', 'ws-1')
      expect(result).toEqual({
        kind: 'close-workspace',
        workspaceId: 'ws-1',
      })
    })
  })

  describe('close-window-tab: last workspace, multiple window tabs', () => {
    it('closes window tab when single workspace, single pane, multiple window tabs', () => {
      const tab1: WindowTab = {
        id: 'tab-1',
        workspaceLayout: makeWorkspaceTile(
          'tile-1',
          'ws-1',
          [makePanelTab('pt-1', makeLeaf('pane-1', 'term-1', 'ws-1'))],
          'pt-1'
        ),
      }
      const tab2: WindowTab = {
        id: 'tab-2',
        workspaceLayout: makeWorkspaceTile(
          'tile-2',
          'ws-2',
          [makePanelTab('pt-2', makeLeaf('pane-2', 'term-2', 'ws-2'))],
          'pt-2'
        ),
      }
      const layout: WindowLayout = {
        tabs: [tab1, tab2],
        activeTabId: 'tab-1',
      }
      const result = computeProgressiveCloseAction(layout, 'pane-1', 'ws-1')
      expect(result).toEqual({
        kind: 'close-window-tab',
        tabId: 'tab-1',
      })
    })
  })

  describe('close-app: last window tab, last workspace, last pane', () => {
    it('returns close-app when single tab, single workspace, single pane', () => {
      const tab: WindowTab = {
        id: 'tab-1',
        workspaceLayout: makeWorkspaceTile(
          'tile-1',
          'ws-1',
          [makePanelTab('pt-1', makeLeaf('pane-1', 'term-1', 'ws-1'))],
          'pt-1'
        ),
      }
      const layout: WindowLayout = {
        tabs: [tab],
        activeTabId: 'tab-1',
      }
      const result = computeProgressiveCloseAction(layout, 'pane-1', 'ws-1')
      expect(result).toEqual({ kind: 'close-app' })
    })
  })

  describe('empty workspace (no active panel tab)', () => {
    it('removes workspace when empty workspace and multiple workspaces exist', () => {
      const tab: WindowTab = {
        id: 'tab-1',
        workspaceLayout: makeWorkspaceTileSplit('split-1', [
          makeWorkspaceTile('tile-1', 'ws-1', [], undefined), // empty workspace
          makeWorkspaceTile(
            'tile-2',
            'ws-2',
            [makePanelTab('pt-2', makeLeaf('pane-2', 'term-2', 'ws-2'))],
            'pt-2'
          ),
        ]),
      }
      const layout: WindowLayout = {
        tabs: [tab],
        activeTabId: 'tab-1',
      }
      const result = computeProgressiveCloseAction(layout, 'pane-x', 'ws-1')
      expect(result).toEqual({
        kind: 'close-workspace',
        workspaceId: 'ws-1',
      })
    })

    it('closes window tab when empty workspace is the only workspace, multiple tabs', () => {
      const tab1: WindowTab = {
        id: 'tab-1',
        workspaceLayout: makeWorkspaceTile('tile-1', 'ws-1', [], undefined),
      }
      const tab2: WindowTab = {
        id: 'tab-2',
        workspaceLayout: makeWorkspaceTile(
          'tile-2',
          'ws-2',
          [makePanelTab('pt-2', makeLeaf('pane-2', 'term-2', 'ws-2'))],
          'pt-2'
        ),
      }
      const layout: WindowLayout = {
        tabs: [tab1, tab2],
        activeTabId: 'tab-1',
      }
      const result = computeProgressiveCloseAction(layout, 'pane-x', 'ws-1')
      expect(result).toEqual({
        kind: 'close-window-tab',
        tabId: 'tab-1',
      })
    })

    it('returns close-app when empty workspace is the only workspace and only tab', () => {
      const tab: WindowTab = {
        id: 'tab-1',
        workspaceLayout: makeWorkspaceTile('tile-1', 'ws-1', [], undefined),
      }
      const layout: WindowLayout = {
        tabs: [tab],
        activeTabId: 'tab-1',
      }
      const result = computeProgressiveCloseAction(layout, 'pane-x', 'ws-1')
      expect(result).toEqual({ kind: 'close-app' })
    })
  })

  describe('window tab with no workspace layout', () => {
    it('returns close-window-tab when tab has no workspace layout and multiple tabs', () => {
      const tab1: WindowTab = { id: 'tab-1' }
      const tab2: WindowTab = {
        id: 'tab-2',
        workspaceLayout: makeWorkspaceTile(
          'tile-2',
          'ws-2',
          [makePanelTab('pt-2', makeLeaf('pane-2', 'term-2', 'ws-2'))],
          'pt-2'
        ),
      }
      const layout: WindowLayout = {
        tabs: [tab1, tab2],
        activeTabId: 'tab-1',
      }
      // When the active tab has no workspace, we need an activeWorkspaceId
      // that doesn't exist to trigger the fallback
      const result = computeProgressiveCloseAction(
        layout,
        'pane-x',
        'ws-missing'
      )
      // Workspace not found → falls back to close-pane
      expect(result).toEqual({ kind: 'close-pane', paneId: 'pane-x' })
    })
  })

  describe('nested workspace tiles', () => {
    it('closes workspace from nested tile split', () => {
      const tab: WindowTab = {
        id: 'tab-1',
        workspaceLayout: makeWorkspaceTileSplit('split-1', [
          makeWorkspaceTile(
            'tile-1',
            'ws-1',
            [makePanelTab('pt-1', makeLeaf('pane-1', 'term-1', 'ws-1'))],
            'pt-1'
          ),
          makeWorkspaceTileSplit('split-2', [
            makeWorkspaceTile(
              'tile-2',
              'ws-2',
              [makePanelTab('pt-2', makeLeaf('pane-2', 'term-2', 'ws-2'))],
              'pt-2'
            ),
            makeWorkspaceTile(
              'tile-3',
              'ws-3',
              [makePanelTab('pt-3', makeLeaf('pane-3', 'term-3', 'ws-3'))],
              'pt-3'
            ),
          ]),
        ]),
      }
      const layout: WindowLayout = {
        tabs: [tab],
        activeTabId: 'tab-1',
      }
      // Closing ws-2 should remove the workspace (3 workspaces exist)
      const result = computeProgressiveCloseAction(layout, 'pane-2', 'ws-2')
      expect(result).toEqual({
        kind: 'close-workspace',
        workspaceId: 'ws-2',
      })
    })
  })

  describe('full escalation chain', () => {
    it('each step returns the correct next action', () => {
      // Start: 1 tab, 1 workspace, 2 panel tabs with 2 panes each
      const splitLayout1 = makeSplitLayout('split-1', [
        makeLeaf('pane-1a', 'term-1a', 'ws-1'),
        makeLeaf('pane-1b', 'term-1b', 'ws-1'),
      ])
      const splitLayout2 = makeSplitLayout('split-2', [
        makeLeaf('pane-2a', 'term-2a', 'ws-1'),
        makeLeaf('pane-2b', 'term-2b', 'ws-1'),
      ])
      const tab: WindowTab = {
        id: 'tab-1',
        workspaceLayout: makeWorkspaceTile(
          'tile-1',
          'ws-1',
          [
            makePanelTab('pt-1', splitLayout1, 'pane-1a'),
            makePanelTab('pt-2', splitLayout2, 'pane-2a'),
          ],
          'pt-1'
        ),
      }
      const layout: WindowLayout = {
        tabs: [tab],
        activeTabId: 'tab-1',
      }

      // Step 1: 2 panes → close-pane
      const step1 = computeProgressiveCloseAction(layout, 'pane-1a', 'ws-1')
      expect(step1.kind).toBe('close-pane')

      // Simulate: now the panel tab has 1 pane (pane-1b)
      const afterStep1Tab: WindowTab = {
        id: 'tab-1',
        workspaceLayout: makeWorkspaceTile(
          'tile-1',
          'ws-1',
          [
            makePanelTab('pt-1', makeLeaf('pane-1b', 'term-1b', 'ws-1')),
            makePanelTab('pt-2', splitLayout2, 'pane-2a'),
          ],
          'pt-1'
        ),
      }
      const afterStep1Layout: WindowLayout = {
        tabs: [afterStep1Tab],
        activeTabId: 'tab-1',
      }

      // Step 2: 1 pane, 2 panel tabs → close-panel-tab
      const step2 = computeProgressiveCloseAction(
        afterStep1Layout,
        'pane-1b',
        'ws-1'
      )
      expect(step2.kind).toBe('close-panel-tab')

      // Simulate: now only 1 panel tab remains (pt-2)
      const afterStep2Tab: WindowTab = {
        id: 'tab-1',
        workspaceLayout: makeWorkspaceTile(
          'tile-1',
          'ws-1',
          [makePanelTab('pt-2', makeLeaf('pane-2a', 'term-2a', 'ws-1'))],
          'pt-2'
        ),
      }
      const afterStep2Layout: WindowLayout = {
        tabs: [afterStep2Tab],
        activeTabId: 'tab-1',
      }

      // Step 3: 1 panel tab, 1 workspace, 1 tab → close-app
      const step3 = computeProgressiveCloseAction(
        afterStep2Layout,
        'pane-2a',
        'ws-1'
      )
      expect(step3.kind).toBe('close-app')
    })
  })

  describe('diff/review pane types', () => {
    it('closes pane for diff pane in split', () => {
      const splitLayout = makeSplitLayout('split-1', [
        makeLeaf('pane-1', 'term-1', 'ws-1'),
        {
          _tag: 'PanelLeafNode' as const,
          id: 'pane-diff',
          paneType: 'diff' as const,
          workspaceId: 'ws-1',
        },
      ])
      const tab: WindowTab = {
        id: 'tab-1',
        workspaceLayout: makeWorkspaceTile(
          'tile-1',
          'ws-1',
          [makePanelTab('pt-1', splitLayout, 'pane-diff')],
          'pt-1'
        ),
      }
      const layout: WindowLayout = {
        tabs: [tab],
        activeTabId: 'tab-1',
      }
      const result = computeProgressiveCloseAction(layout, 'pane-diff', 'ws-1')
      expect(result).toEqual({ kind: 'close-pane', paneId: 'pane-diff' })
    })
  })
})
