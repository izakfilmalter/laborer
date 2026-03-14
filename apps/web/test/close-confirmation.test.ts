/**
 * Unit tests for hierarchical close confirmation logic.
 *
 * Tests `shouldConfirmClosePanelTab` and `shouldConfirmCloseWindowTab` —
 * pure functions that determine whether closing a panel tab or window tab
 * should show a confirmation dialog based on running terminal processes.
 *
 * @see apps/web/src/panels/window-tab-utils.ts
 */

import type {
  PanelLeafNode,
  PanelSplitNode,
  PanelTab,
  PanelTreeNode,
  WindowTab,
  WorkspaceTileLeaf,
  WorkspaceTileSplit,
} from '@laborer/shared/types'
import { describe, expect, it } from 'vitest'
import type { TerminalProcessInfo } from '../src/panels/window-tab-utils'
import {
  shouldConfirmClosePanelTab,
  shouldConfirmCloseWindowTab,
} from '../src/panels/window-tab-utils'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeLeaf(
  id: string,
  terminalId?: string,
  workspaceId?: string,
  paneType: 'terminal' | 'diff' | 'review' | 'devServerTerminal' = 'terminal'
): PanelLeafNode {
  return {
    _tag: 'PanelLeafNode',
    id,
    paneType,
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

function makeSplit(id: string, children: PanelTreeNode[]): PanelSplitNode {
  return {
    _tag: 'PanelSplitNode',
    id,
    direction: 'horizontal',
    children,
    sizes: children.map(() => 100 / children.length),
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

function makeTileSplit(
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

function makeWindowTab(
  id: string,
  workspaceLayout: WorkspaceTileLeaf | WorkspaceTileSplit | undefined
): WindowTab {
  return {
    id,
    workspaceLayout,
  }
}

function makeTerminal(
  id: string,
  hasChildProcess: boolean
): TerminalProcessInfo {
  return { id, hasChildProcess }
}

// ---------------------------------------------------------------------------
// shouldConfirmClosePanelTab
// ---------------------------------------------------------------------------

describe('shouldConfirmClosePanelTab', () => {
  it('returns false when panel tab has no terminals', () => {
    const tab = makePanelTab('tab-1', makeLeaf('pane-1', undefined, 'ws-1'))
    expect(shouldConfirmClosePanelTab(tab, [])).toBe(false)
  })

  it('returns false when terminal has no running process', () => {
    const tab = makePanelTab('tab-1', makeLeaf('pane-1', 'term-1', 'ws-1'))
    const terminals = [makeTerminal('term-1', false)]
    expect(shouldConfirmClosePanelTab(tab, terminals)).toBe(false)
  })

  it('returns true when terminal has a running process', () => {
    const tab = makePanelTab('tab-1', makeLeaf('pane-1', 'term-1', 'ws-1'))
    const terminals = [makeTerminal('term-1', true)]
    expect(shouldConfirmClosePanelTab(tab, terminals)).toBe(true)
  })

  it('returns true when any terminal in a split has a running process', () => {
    const tab = makePanelTab(
      'tab-1',
      makeSplit('split-1', [
        makeLeaf('pane-1', 'term-1', 'ws-1'),
        makeLeaf('pane-2', 'term-2', 'ws-1'),
      ])
    )
    const terminals = [
      makeTerminal('term-1', false),
      makeTerminal('term-2', true),
    ]
    expect(shouldConfirmClosePanelTab(tab, terminals)).toBe(true)
  })

  it('returns false when all terminals in a split are idle', () => {
    const tab = makePanelTab(
      'tab-1',
      makeSplit('split-1', [
        makeLeaf('pane-1', 'term-1', 'ws-1'),
        makeLeaf('pane-2', 'term-2', 'ws-1'),
      ])
    )
    const terminals = [
      makeTerminal('term-1', false),
      makeTerminal('term-2', false),
    ]
    expect(shouldConfirmClosePanelTab(tab, terminals)).toBe(false)
  })

  it('returns false when terminal is not in the live list', () => {
    const tab = makePanelTab('tab-1', makeLeaf('pane-1', 'term-1', 'ws-1'))
    const terminals: TerminalProcessInfo[] = []
    expect(shouldConfirmClosePanelTab(tab, terminals)).toBe(false)
  })

  it('returns false for non-terminal pane types', () => {
    const tab = makePanelTab(
      'tab-1',
      makeLeaf('pane-1', undefined, 'ws-1', 'diff')
    )
    expect(shouldConfirmClosePanelTab(tab, [])).toBe(false)
  })

  it('handles deeply nested splits', () => {
    const tab = makePanelTab(
      'tab-1',
      makeSplit('split-1', [
        makeSplit('split-2', [
          makeLeaf('pane-1', 'term-1', 'ws-1'),
          makeLeaf('pane-2', 'term-2', 'ws-1'),
        ]),
        makeLeaf('pane-3', 'term-3', 'ws-1'),
      ])
    )
    const terminals = [
      makeTerminal('term-1', false),
      makeTerminal('term-2', false),
      makeTerminal('term-3', true),
    ]
    expect(shouldConfirmClosePanelTab(tab, terminals)).toBe(true)
  })

  it('returns false for empty terminal list', () => {
    const tab = makePanelTab(
      'tab-1',
      makeSplit('split-1', [makeLeaf('pane-1', 'term-1', 'ws-1')])
    )
    expect(shouldConfirmClosePanelTab(tab, [])).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// shouldConfirmCloseWindowTab
// ---------------------------------------------------------------------------

describe('shouldConfirmCloseWindowTab', () => {
  it('returns false when window tab has no workspace layout', () => {
    const tab = makeWindowTab('tab-1', undefined)
    expect(shouldConfirmCloseWindowTab(tab, [])).toBe(false)
  })

  it('returns false when no terminals have running processes', () => {
    const workspace = makeWorkspaceTile('tile-1', 'ws-1', [
      makePanelTab('pt-1', makeLeaf('pane-1', 'term-1', 'ws-1')),
    ])
    const tab = makeWindowTab('tab-1', workspace)
    const terminals = [makeTerminal('term-1', false)]
    expect(shouldConfirmCloseWindowTab(tab, terminals)).toBe(false)
  })

  it('returns true when any terminal has a running process', () => {
    const workspace = makeWorkspaceTile('tile-1', 'ws-1', [
      makePanelTab('pt-1', makeLeaf('pane-1', 'term-1', 'ws-1')),
    ])
    const tab = makeWindowTab('tab-1', workspace)
    const terminals = [makeTerminal('term-1', true)]
    expect(shouldConfirmCloseWindowTab(tab, terminals)).toBe(true)
  })

  it('checks across multiple workspaces', () => {
    const ws1 = makeWorkspaceTile('tile-1', 'ws-1', [
      makePanelTab('pt-1', makeLeaf('pane-1', 'term-1', 'ws-1')),
    ])
    const ws2 = makeWorkspaceTile('tile-2', 'ws-2', [
      makePanelTab('pt-2', makeLeaf('pane-2', 'term-2', 'ws-2')),
    ])
    const tab = makeWindowTab('tab-1', makeTileSplit('split-1', [ws1, ws2]))
    const terminals = [
      makeTerminal('term-1', false),
      makeTerminal('term-2', true),
    ]
    expect(shouldConfirmCloseWindowTab(tab, terminals)).toBe(true)
  })

  it('returns false when all workspaces have idle terminals', () => {
    const ws1 = makeWorkspaceTile('tile-1', 'ws-1', [
      makePanelTab('pt-1', makeLeaf('pane-1', 'term-1', 'ws-1')),
    ])
    const ws2 = makeWorkspaceTile('tile-2', 'ws-2', [
      makePanelTab('pt-2', makeLeaf('pane-2', 'term-2', 'ws-2')),
    ])
    const tab = makeWindowTab('tab-1', makeTileSplit('split-1', [ws1, ws2]))
    const terminals = [
      makeTerminal('term-1', false),
      makeTerminal('term-2', false),
    ]
    expect(shouldConfirmCloseWindowTab(tab, terminals)).toBe(false)
  })

  it('checks across multiple panel tabs within a workspace', () => {
    const workspace = makeWorkspaceTile('tile-1', 'ws-1', [
      makePanelTab('pt-1', makeLeaf('pane-1', 'term-1', 'ws-1')),
      makePanelTab('pt-2', makeLeaf('pane-2', 'term-2', 'ws-1')),
    ])
    const tab = makeWindowTab('tab-1', workspace)
    const terminals = [
      makeTerminal('term-1', false),
      makeTerminal('term-2', true),
    ]
    expect(shouldConfirmCloseWindowTab(tab, terminals)).toBe(true)
  })

  it('checks within panel tab splits', () => {
    const workspace = makeWorkspaceTile('tile-1', 'ws-1', [
      makePanelTab(
        'pt-1',
        makeSplit('split-1', [
          makeLeaf('pane-1', 'term-1', 'ws-1'),
          makeLeaf('pane-2', 'term-2', 'ws-1'),
        ])
      ),
    ])
    const tab = makeWindowTab('tab-1', workspace)
    const terminals = [
      makeTerminal('term-1', false),
      makeTerminal('term-2', true),
    ]
    expect(shouldConfirmCloseWindowTab(tab, terminals)).toBe(true)
  })

  it('returns false for empty workspace with no panel tabs', () => {
    const workspace = makeWorkspaceTile('tile-1', 'ws-1', [])
    const tab = makeWindowTab('tab-1', workspace)
    expect(shouldConfirmCloseWindowTab(tab, [])).toBe(false)
  })

  it('handles nested workspace tile splits', () => {
    const ws1 = makeWorkspaceTile('tile-1', 'ws-1', [
      makePanelTab('pt-1', makeLeaf('pane-1', 'term-1', 'ws-1')),
    ])
    const ws2 = makeWorkspaceTile('tile-2', 'ws-2', [
      makePanelTab('pt-2', makeLeaf('pane-2', 'term-2', 'ws-2')),
    ])
    const ws3 = makeWorkspaceTile('tile-3', 'ws-3', [
      makePanelTab('pt-3', makeLeaf('pane-3', 'term-3', 'ws-3')),
    ])
    const innerSplit = makeTileSplit('inner-split', [ws2, ws3])
    const tab = makeWindowTab(
      'tab-1',
      makeTileSplit('outer-split', [ws1, innerSplit])
    )
    const terminals = [
      makeTerminal('term-1', false),
      makeTerminal('term-2', false),
      makeTerminal('term-3', true),
    ]
    expect(shouldConfirmCloseWindowTab(tab, terminals)).toBe(true)
  })

  it('ignores non-terminal pane types', () => {
    const workspace = makeWorkspaceTile('tile-1', 'ws-1', [
      makePanelTab('pt-1', makeLeaf('pane-1', undefined, 'ws-1', 'diff')),
      makePanelTab('pt-2', makeLeaf('pane-2', undefined, 'ws-1', 'review')),
    ])
    const tab = makeWindowTab('tab-1', workspace)
    expect(shouldConfirmCloseWindowTab(tab, [])).toBe(false)
  })
})
