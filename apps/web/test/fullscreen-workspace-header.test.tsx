/**
 * Tests that the workspace frame header remains visible when a pane is
 * fullscreened.
 *
 * Previously, the fullscreen portal overlay covered the entire PanelContent
 * area including all workspace frame headers. The fix renders the header
 * for the fullscreened pane's workspace above the overlay so the user can
 * still see project name, branch, PR status, and workspace-level actions.
 */

import type { PanelNode } from '@laborer/shared/types'
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

vi.mock('@/panes/review-pane', () => ({
  ReviewPane: () => <div data-testid="review-pane" />,
}))

vi.mock('@/panes/diff-pane', () => ({
  DiffPane: () => <div data-testid="diff-pane" />,
}))

vi.mock('@livestore/livestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@livestore/livestore')>()
  return {
    ...actual,
    queryDb: vi.fn(() => ({})),
  }
})

vi.mock('@/livestore/store', () => ({
  useLaborerStore: () => ({
    useQuery: () => [],
  }),
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
      toggleDevServerPane: vi.fn(async () => false),
      toggleDiffPane: vi.fn(() => false),
      toggleFullscreenPane: vi.fn(),
      toggleReviewPane: vi.fn(() => false),
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
    workspaceId,
  }: {
    workspaceId: string | undefined
  }) => (
    <div data-testid="workspace-frame-header" data-workspace-id={workspaceId}>
      Header {workspaceId}
    </div>
  ),
}))

vi.mock('@/components/ui/resizable', () => ({
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

import { PanelContent } from '../src/routes/-components/panel-content'

const SINGLE_WORKSPACE_LAYOUT: PanelNode = {
  _tag: 'LeafNode',
  id: 'pane-1',
  paneType: 'terminal',
  terminalId: 'term-1',
  workspaceId: 'workspace-1',
}

const TWO_WORKSPACE_LAYOUT: PanelNode = {
  _tag: 'SplitNode',
  id: 'split-root',
  direction: 'vertical',
  children: [
    {
      _tag: 'LeafNode',
      id: 'pane-1',
      paneType: 'terminal',
      terminalId: 'term-1',
      workspaceId: 'workspace-1',
    },
    {
      _tag: 'LeafNode',
      id: 'pane-2',
      paneType: 'terminal',
      terminalId: 'term-2',
      workspaceId: 'workspace-2',
    },
  ],
  sizes: [50, 50],
}

describe('Workspace header visibility during fullscreen', () => {
  afterEach(() => {
    cleanup()
  })

  it('shows the workspace frame header when no pane is fullscreened', () => {
    render(
      <PanelContent
        activePaneId="pane-1"
        fullscreenPaneId={null}
        isReconciling={false}
        layout={SINGLE_WORKSPACE_LAYOUT}
        workspaceOrder={null}
      />
    )

    const headers = screen.getAllByTestId('workspace-frame-header')
    expect(headers.length).toBeGreaterThanOrEqual(1)
  })

  it('keeps workspace header visible above the fullscreen overlay for the fullscreened pane workspace', () => {
    render(
      <PanelContent
        activePaneId="pane-1"
        fullscreenPaneId="pane-1"
        isReconciling={false}
        layout={SINGLE_WORKSPACE_LAYOUT}
        workspaceOrder={null}
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
        fullscreenPaneId="pane-2"
        isReconciling={false}
        layout={TWO_WORKSPACE_LAYOUT}
        workspaceOrder={null}
      />
    )

    const header = screen.getByTestId('fullscreen-workspace-header')
    expect(header).toBeTruthy()
    expect(header.getAttribute('data-workspace-id')).toBe('workspace-2')
  })

  it('does not render the fullscreen workspace header when no pane is fullscreened', () => {
    render(
      <PanelContent
        activePaneId="pane-1"
        fullscreenPaneId={null}
        isReconciling={false}
        layout={SINGLE_WORKSPACE_LAYOUT}
        workspaceOrder={null}
      />
    )

    expect(screen.queryByTestId('fullscreen-workspace-header')).toBeNull()
  })
})
