/**
 * Tests that the workspace frame header remains visible when a pane is
 * fullscreened.
 *
 * Previously, the fullscreen portal overlay covered the entire PanelContent
 * area including all workspace frame headers. The fix renders the header
 * for the fullscreened pane's workspace above the overlay so the user can
 * still see project name, branch, PR status, and workspace-level actions.
 */

import type {
  PanelNode,
  WindowLayout,
  WorkspaceTileLeaf,
  WorkspaceTileNode,
} from '@laborer/shared/types'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@atlaskit/pragmatic-drag-and-drop/element/adapter', () => ({
  draggable: () => () => undefined,
  dropTargetForElements: () => () => undefined,
  monitorForElements: () => () => undefined,
}))

vi.mock('@atlaskit/pragmatic-drag-and-drop/combine', () => ({
  combine:
    (...cleanups: Array<() => void>) =>
    () => {
      for (const c of cleanups) {
        c()
      }
    },
}))

vi.mock('@atlaskit/pragmatic-drag-and-drop/reorder', () => ({
  reorder: vi.fn(),
}))

vi.mock('@/panels/panel-manager', () => ({
  PanelManager: ({ layout }: { layout: PanelNode | undefined }) => (
    <div data-layout={JSON.stringify(layout)} data-testid="panel-manager" />
  ),
}))

vi.mock('@/panes/diff-pane', () => ({
  DiffPane: () => <div data-testid="diff-pane" />,
}))

vi.mock('@/panes/tree-pane', () => ({
  TreePane: () => <div data-testid="tree-pane" />,
}))

vi.mock('@/panels/panel-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/panels/panel-context')>()
  return {
    ...actual,
    usePanelActions: () => ({
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
      reorderWindowTabsDnd: vi.fn(),
      windowLayout: undefined,
    }),
  }
})

vi.mock('../src/routes/-components/workspace-frame-header-container', () => ({
  WorkspaceFrameHeaderContainer: ({
    diffIsOpen,
    treeIsOpen,
    workspaceId,
  }: {
    diffIsOpen?: boolean
    treeIsOpen?: boolean
    workspaceId: string | undefined
  }) => (
    <div
      data-diff-open={diffIsOpen ? 'true' : 'false'}
      data-testid="workspace-frame-header"
      data-tree-open={treeIsOpen ? 'true' : 'false'}
      data-workspace-id={workspaceId}
    >
      Header {workspaceId}
    </div>
  ),
}))

vi.mock('@laborer/ui/components/resizable', () => ({
  ResizableHandle: ({ withHandle }: { withHandle?: boolean }) => (
    <div data-testid="resizable-handle" data-with-handle={withHandle} />
  ),
  ResizablePanel: ({
    children,
    defaultSize,
    minSize,
  }: {
    children: React.ReactNode
    defaultSize?: string | number
    minSize?: string
    collapsedSize?: string
    collapsible?: boolean
    panelRef?: { current: unknown }
  }) => (
    <div
      data-default-size={defaultSize}
      data-min-size={minSize}
      data-testid="resizable-panel"
    >
      {children}
    </div>
  ),
  ResizablePanelGroup: ({
    children,
    orientation,
  }: {
    children: React.ReactNode
    orientation?: string
  }) => (
    <div
      data-orientation={orientation}
      data-panel-group="true"
      data-testid="resizable-panel-group"
    >
      {children}
    </div>
  ),
}))

import { useRightPanelStore } from '@/right-panel-store'
import { PanelContent } from '../src/routes/-components/panel-content'

const SINGLE_WORKSPACE_TILE: WorkspaceTileLeaf = {
  _tag: 'WorkspaceTileLeaf',
  id: 'tile-1',
  workspaceId: 'workspace-1',
  panelTabs: [
    {
      id: 'tab-1',
      panelLayout: {
        _tag: 'LeafNode',
        id: 'pane-1',
        paneType: 'terminal',
        terminalId: 'term-1',
        workspaceId: 'workspace-1',
      },
    },
  ],
  activePanelTabId: 'tab-1',
}

const TWO_WORKSPACE_TILE: WorkspaceTileNode = {
  _tag: 'WorkspaceTileSplit',
  id: 'tile-root',
  direction: 'vertical',
  children: [
    {
      _tag: 'WorkspaceTileLeaf',
      id: 'tile-1',
      workspaceId: 'workspace-1',
      panelTabs: [
        {
          id: 'tab-1',
          panelLayout: {
            _tag: 'LeafNode',
            id: 'pane-1',
            paneType: 'terminal',
            terminalId: 'term-1',
            workspaceId: 'workspace-1',
          },
        },
      ],
      activePanelTabId: 'tab-1',
    },
    {
      _tag: 'WorkspaceTileLeaf',
      id: 'tile-2',
      workspaceId: 'workspace-2',
      panelTabs: [
        {
          id: 'tab-2',
          panelLayout: {
            _tag: 'LeafNode',
            id: 'pane-2',
            paneType: 'terminal',
            terminalId: 'term-2',
            workspaceId: 'workspace-2',
          },
        },
      ],
      activePanelTabId: 'tab-2',
    },
  ],
  sizes: [50, 50],
}

const SINGLE_WINDOW_LAYOUT: WindowLayout = {
  activeTabId: 'win-tab-1',
  tabs: [
    {
      id: 'win-tab-1',
      workspaceLayout: SINGLE_WORKSPACE_TILE,
    },
  ],
}

const TWO_WORKSPACE_WINDOW_LAYOUT: WindowLayout = {
  activeTabId: 'win-tab-1',
  tabs: [
    {
      id: 'win-tab-1',
      workspaceLayout: TWO_WORKSPACE_TILE,
    },
  ],
}

describe('Workspace header visibility during fullscreen', () => {
  afterEach(() => {
    cleanup()
    useRightPanelStore.setState({ byWorkspaceId: {} })
  })

  it('shows the workspace frame header when no pane is fullscreened', () => {
    render(
      <PanelContent
        activePaneId="pane-1"
        activeTabId={SINGLE_WINDOW_LAYOUT.activeTabId}
        fullscreenPaneId={null}
        isReconciling={false}
        windowLayout={SINGLE_WINDOW_LAYOUT}
        windowTabs={SINGLE_WINDOW_LAYOUT.tabs}
      />
    )

    const headers = screen.getAllByTestId('workspace-frame-header')
    expect(headers.length).toBeGreaterThanOrEqual(1)
  })

  it('keeps workspace header visible above the fullscreen overlay for the fullscreened pane workspace', () => {
    render(
      <PanelContent
        activePaneId="pane-1"
        activeTabId={SINGLE_WINDOW_LAYOUT.activeTabId}
        fullscreenPaneId="pane-1"
        isReconciling={false}
        windowLayout={SINGLE_WINDOW_LAYOUT}
        windowTabs={SINGLE_WINDOW_LAYOUT.tabs}
      />
    )

    // The workspace header for workspace-1 should be visible (not covered
    // by the fullscreen overlay). It should be rendered as a sibling before
    // the overlay, not inside the area the overlay covers.
    const header = screen.getByTestId('fullscreen-workspace-header')
    expect(header).toBeTruthy()
    expect(header.getAttribute('data-workspace-id')).toBe('workspace-1')
  })

  it('shows the correct workspace header when fullscreening a pane from the second workspace', () => {
    render(
      <PanelContent
        activePaneId="pane-2"
        activeTabId={TWO_WORKSPACE_WINDOW_LAYOUT.activeTabId}
        fullscreenPaneId="pane-2"
        isReconciling={false}
        windowLayout={TWO_WORKSPACE_WINDOW_LAYOUT}
        windowTabs={TWO_WORKSPACE_WINDOW_LAYOUT.tabs}
      />
    )

    const header = screen.getByTestId('fullscreen-workspace-header')
    expect(header).toBeTruthy()
    expect(header.getAttribute('data-workspace-id')).toBe('workspace-2')
  })

  it('keeps fullscreen side panels mounted and reports their open state in the fullscreen header', () => {
    useRightPanelStore.getState().open('workspace-1', 'diff')

    render(
      <PanelContent
        activePaneId="pane-1"
        activeTabId={SINGLE_WINDOW_LAYOUT.activeTabId}
        fullscreenPaneId="pane-1"
        isReconciling={false}
        treeWorkspaceIds={['workspace-1']}
        windowLayout={SINGLE_WINDOW_LAYOUT}
        windowTabs={SINGLE_WINDOW_LAYOUT.tabs}
      />
    )

    expect(screen.getAllByTestId('tree-pane')).toHaveLength(1)
    // Exactly one diff instance: the fullscreen overlay owns the workspace's
    // right panel while the inline frame's copy is suppressed.
    expect(screen.getAllByTestId('diff-pane')).toHaveLength(1)

    const header = screen.getByTestId('fullscreen-workspace-header')
    expect(header.getAttribute('data-workspace-id')).toBe('workspace-1')

    const headerContent = header.querySelector(
      '[data-testid="workspace-frame-header"]'
    )
    expect(headerContent?.getAttribute('data-tree-open')).toBe('true')
    expect(headerContent?.getAttribute('data-diff-open')).toBe('true')
  })

  it('does not render the fullscreen workspace header when no pane is fullscreened', () => {
    render(
      <PanelContent
        activePaneId="pane-1"
        activeTabId={SINGLE_WINDOW_LAYOUT.activeTabId}
        fullscreenPaneId={null}
        isReconciling={false}
        windowLayout={SINGLE_WINDOW_LAYOUT}
        windowTabs={SINGLE_WINDOW_LAYOUT.tabs}
      />
    )

    expect(screen.queryByTestId('fullscreen-workspace-header')).toBeNull()
  })

  it('isolates window tab content so background pane overlays cannot paint above the fullscreen overlay', () => {
    render(
      <PanelContent
        activePaneId="pane-1"
        activeTabId={TWO_WORKSPACE_WINDOW_LAYOUT.activeTabId}
        fullscreenPaneId="pane-1"
        isReconciling={false}
        windowLayout={TWO_WORKSPACE_WINDOW_LAYOUT}
        windowTabs={TWO_WORKSPACE_WINDOW_LAYOUT.tabs}
      />
    )

    // Pane-level overlays inside the normal tree use z-20 (hover toolbar)
    // and z-30 (terminal notification). The fullscreen overlay is z-10, so
    // the tab container must form its own stacking context or those
    // overlays would render on top of the fullscreened pane.
    for (const tabContent of screen.getAllByTestId('window-tab-content')) {
      expect(tabContent.className.split(' ')).toContain('isolate')
    }
  })
})
