import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PanelActions } from '@/panels/panel-context'

vi.mock('@atlaskit/pragmatic-drag-and-drop/element/adapter', () => ({
  draggable: () => () => undefined,
  dropTargetForElements: () => () => undefined,
  monitorForElements: () => () => undefined,
}))

vi.mock('@atlaskit/pragmatic-drag-and-drop/combine', () => ({
  combine:
    (...cleanups: Array<() => void>) =>
    () => {
      for (const fn of cleanups) {
        fn()
      }
    },
}))

vi.mock('@atlaskit/pragmatic-drag-and-drop/reorder', () => ({
  reorder: vi.fn(),
}))

vi.mock('@/panels/panel-manager', () => ({
  PanelManager: ({ layout }: { layout: unknown }) => (
    <div data-testid="panel-manager">{layout ? 'has-layout' : 'empty'}</div>
  ),
}))

vi.mock('@/panes/diff-pane', () => ({
  DiffPane: ({ workspaceId }: { workspaceId: string }) => (
    <div data-testid="diff-pane" data-workspace-id={workspaceId} />
  ),
}))

vi.mock('@/panes/tree-pane', () => ({
  TreePane: ({ workspaceId }: { workspaceId: string }) => (
    <div data-testid="tree-pane" data-workspace-id={workspaceId} />
  ),
}))

vi.mock('@/panels/panel-context', () => {
  const actions: PanelActions = {
    assignTerminalToPane: vi.fn(),
    closePane: vi.fn(),
    closeTerminalPane: vi.fn(),
    closeWorkspace: vi.fn(),
    forceCloseWorkspace: vi.fn(),
    reorderWorkspaces: vi.fn(),
    resizePane: vi.fn(),
    setActivePaneId: vi.fn(),
    showPanelTypePicker: vi.fn(),
    splitPane: vi.fn(),
    updatePaneType: vi.fn(),
    toggleDevServerPane: vi.fn(async () => false),
    toggleDiffPane: vi.fn(() => false),
    toggleFullscreenPane: vi.fn(),
    toggleTreePane: vi.fn(() => false),
    addPanelTab: vi.fn(),
    addWorkspaceToCurrentTab: vi.fn(),
    addWindowTab: vi.fn(),
    closeWindowTab: vi.fn(),
    removePanelTab: vi.fn(),
    reorderPanelTabsDnd: vi.fn(),
    switchPanelTab: vi.fn(),
    switchPanelTabByIndex: vi.fn(),
    switchPanelTabRelative: vi.fn(),
    switchWindowTab: vi.fn(),
    switchWindowTabByIndex: vi.fn(),
    switchWindowTabRelative: vi.fn(),
    renameWindowTab: vi.fn(),
    reorderWindowTabsDnd: vi.fn(),
    windowLayout: undefined,
  }
  return {
    usePanelActions: () => actions,
    usePendingClosePanelTab: () => ({
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
      tabId: null,
      workspaceId: null,
    }),
    usePendingCloseWorkspace: () => ({
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
      workspaceId: null,
    }),
    usePendingDestroyOnCloseWorkspace: () => ({
      onCancel: vi.fn(),
      onCloseAndDestroy: vi.fn(),
      onConfirm: vi.fn(),
      workspaceId: null,
    }),
  }
})

vi.mock('@/components/ui/resizable', () => ({
  ResizableHandle: () => <div data-testid="resize-handle" />,
  ResizablePanel: ({
    children,
  }: {
    children: React.ReactNode
    [key: string]: unknown
  }) => <div data-testid="resizable-panel">{children}</div>,
  ResizablePanelGroup: ({
    children,
    orientation,
  }: {
    children: React.ReactNode
    orientation?: string
  }) => (
    <div data-orientation={orientation} data-testid="resizable-panel-group">
      {children}
    </div>
  ),
}))

vi.mock('../src/routes/-components/workspace-frame-header-container', () => ({
  WorkspaceFrameHeaderContainer: ({
    workspaceId,
  }: {
    workspaceId: string | undefined
    [key: string]: unknown
  }) => <div data-testid="workspace-header">{workspaceId}</div>,
}))

import type { WorkspaceTileNode } from '@laborer/shared/types'
import {
  computeSidePanelSizes,
  WorkspaceFrames,
} from '../src/routes/-components/workspace-frames'

/** Single workspace tile leaf for tree panel tests. */
const singleLeafLayout: WorkspaceTileNode = {
  _tag: 'WorkspaceTileLeaf',
  id: 'tile-leaf-1',
  workspaceId: 'ws-1',
  activePanelTabId: 'tab-1',
  panelTabs: [
    {
      id: 'tab-1',
      panelLayout: {
        _tag: 'LeafNode',
        id: 'pane-1',
        paneType: 'terminal',
        terminalId: 'term-1',
        workspaceId: 'ws-1',
      },
    },
  ],
}

const twoLeafLayout: WorkspaceTileNode = {
  _tag: 'WorkspaceTileSplit',
  id: 'tile-root',
  direction: 'vertical',
  children: [
    singleLeafLayout,
    {
      _tag: 'WorkspaceTileLeaf',
      id: 'tile-leaf-2',
      workspaceId: 'ws-2',
      activePanelTabId: 'tab-2',
      panelTabs: [
        {
          id: 'tab-2',
          panelLayout: {
            _tag: 'LeafNode',
            id: 'pane-2',
            paneType: 'terminal',
            terminalId: 'term-2',
            workspaceId: 'ws-2',
          },
        },
      ],
    },
  ],
  sizes: [50, 50],
}

describe('WorkspaceFrames tree panel positioning', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders tree pane on the LEFT side of main content when treeWorkspaceIds includes the workspace', () => {
    render(
      <WorkspaceFrames
        activePaneId="pane-1"
        treeWorkspaceIds={['ws-1']}
        workspaceTileLayout={singleLeafLayout}
      />
    )

    const treePanes = screen.getAllByTestId('tree-pane')
    expect(treePanes).toHaveLength(1)
    expect(treePanes[0]?.getAttribute('data-workspace-id')).toBe('ws-1')

    // The tree pane should appear BEFORE the panel-manager in the DOM
    // (left side of a horizontal ResizablePanelGroup)
    const panelGroup = screen.getByTestId('resizable-panel-group')
    const allTestIds = Array.from(
      panelGroup.querySelectorAll('[data-testid]')
    ).map((el) => el.getAttribute('data-testid'))

    const treeIndex = allTestIds.indexOf('tree-pane')
    const managerIndex = allTestIds.indexOf('panel-manager')
    expect(treeIndex).toBeGreaterThan(-1)
    expect(managerIndex).toBeGreaterThan(-1)
    expect(treeIndex).toBeLessThan(managerIndex)
  })

  it('does NOT render tree pane when treeWorkspaceIds is empty', () => {
    render(
      <WorkspaceFrames
        activePaneId="pane-1"
        treeWorkspaceIds={[]}
        workspaceTileLayout={singleLeafLayout}
      />
    )

    expect(screen.queryByTestId('tree-pane')).toBeNull()
  })

  it('does NOT render tree pane when treeWorkspaceIds does not include the workspace', () => {
    render(
      <WorkspaceFrames
        activePaneId="pane-1"
        treeWorkspaceIds={['ws-other']}
        workspaceTileLayout={singleLeafLayout}
      />
    )

    expect(screen.queryByTestId('tree-pane')).toBeNull()
  })

  it('renders tree panes for every workspace listed in treeWorkspaceIds', () => {
    render(
      <WorkspaceFrames
        activePaneId="pane-1"
        treeWorkspaceIds={['ws-1', 'ws-2']}
        workspaceTileLayout={twoLeafLayout}
      />
    )

    const treeWorkspaceIds = screen
      .getAllByTestId('tree-pane')
      .map((pane) => pane.getAttribute('data-workspace-id'))

    expect(treeWorkspaceIds).toEqual(['ws-1', 'ws-2'])
  })
})

describe('computeSidePanelSizes', () => {
  it('returns 30%/70% for a single side panel', () => {
    const result = computeSidePanelSizes(1)
    expect(result.sidePanelSize).toBe('30%')
    expect(result.mainPanelSize).toBe('70%')
  })

  it('returns 20%/60% for two side panels', () => {
    const result = computeSidePanelSizes(2)
    expect(result.sidePanelSize).toBe('20%')
    expect(result.mainPanelSize).toBe('60%')
  })

  it('returns 15%/55% for three side panels', () => {
    const result = computeSidePanelSizes(3)
    expect(result.sidePanelSize).toBe('15%')
    expect(result.mainPanelSize).toBe('55%')
  })
})

describe('WorkspaceFrames tree + diff panel positioning', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders tree on left, main in center, diff on right', () => {
    render(
      <WorkspaceFrames
        activePaneId="pane-1"
        diffWorkspaceIds={['ws-1']}
        treeWorkspaceIds={['ws-1']}
        workspaceTileLayout={singleLeafLayout}
      />
    )

    const treePanes = screen.getAllByTestId('tree-pane')
    const diffPanes = screen.getAllByTestId('diff-pane')
    expect(treePanes).toHaveLength(1)
    expect(diffPanes).toHaveLength(1)

    // Get the horizontal panel group that contains the side panels
    const panelGroup = screen.getByTestId('resizable-panel-group')
    const allTestIds = Array.from(
      panelGroup.querySelectorAll('[data-testid]')
    ).map((el) => el.getAttribute('data-testid'))

    const treeIndex = allTestIds.indexOf('tree-pane')
    const managerIndex = allTestIds.indexOf('panel-manager')
    const diffIndex = allTestIds.indexOf('diff-pane')

    // Order: tree (left) < main (center) < diff (right)
    expect(treeIndex).toBeLessThan(managerIndex)
    expect(managerIndex).toBeLessThan(diffIndex)
  })
})
