/**
 * Tests for workspace-scoped side panels (review and diff).
 *
 * Diff and review panels render inside the WorkspaceFrame they belong to,
 * spanning the full height of that workspace. When multiple workspaces are
 * open, only the workspace matching the panel's workspaceId shows the panel.
 *
 * @see Issue: Diff and review panel placement
 */

import type {
  PanelNode,
  WorkspaceTileLeaf,
  WorkspaceTileNode,
} from '@laborer/shared/types'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { toggleDiffPaneMock, toggleReviewPaneMock } = vi.hoisted(() => ({
  toggleDiffPaneMock: vi.fn(() => false),
  toggleReviewPaneMock: vi.fn(() => false),
}))

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
  ReviewPane: ({
    onClose,
    workspaceId,
  }: {
    onClose?: () => void
    workspaceId: string
  }) => (
    <div data-testid="review-pane" data-workspace-id={workspaceId}>
      <button onClick={onClose} type="button">
        Close review pane
      </button>
      Review Panel Content
    </div>
  ),
}))

// Mock LiveStore dependencies (workspace-frames.tsx imports @laborer/shared/schema)
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

vi.mock('@/panes/diff-pane', () => ({
  DiffPane: ({
    onClose,
    workspaceId,
  }: {
    onClose?: () => void
    workspaceId: string
  }) => (
    <div data-testid="diff-pane" data-workspace-id={workspaceId}>
      <button onClick={onClose} type="button">
        Close diff viewer
      </button>
      Diff Panel Content
    </div>
  ),
}))

vi.mock('@/panels/panel-context', () => ({
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
    toggleDiffPane: toggleDiffPaneMock,
    toggleFullscreenPane: vi.fn(),
    toggleReviewPane: toggleReviewPaneMock,
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
}))

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

// Import after mocks are set up
import { WorkspaceFrames } from '../src/routes/-components/workspace-frames'

const SINGLE_WORKSPACE_LAYOUT: PanelNode = {
  _tag: 'LeafNode',
  id: 'pane-1',
  paneType: 'terminal',
  terminalId: 'term-1',
  workspaceId: 'workspace-1',
}

const SINGLE_WORKSPACE_TILE: WorkspaceTileLeaf = {
  _tag: 'WorkspaceTileLeaf',
  id: 'tile-1',
  workspaceId: 'workspace-1',
  panelTabs: [{ id: 'tab-1', panelLayout: SINGLE_WORKSPACE_LAYOUT }],
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

describe('Workspace-scoped review panel', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    toggleDiffPaneMock.mockClear()
    toggleReviewPaneMock.mockClear()
  })

  it('renders review panel inside the matching workspace frame', () => {
    render(
      <WorkspaceFrames
        activePaneId="pane-1"
        reviewWorkspaceIds={['workspace-1']}
        workspaceTileLayout={SINGLE_WORKSPACE_TILE}
      />
    )

    // Review pane should be rendered inside the workspace frame
    const reviewPane = screen.getByTestId('review-pane')
    expect(reviewPane).toBeTruthy()
    expect(reviewPane.getAttribute('data-workspace-id')).toBe('workspace-1')
  })

  it('does not render review panel when reviewWorkspaceIds is empty', () => {
    render(
      <WorkspaceFrames
        activePaneId="pane-1"
        reviewWorkspaceIds={[]}
        workspaceTileLayout={SINGLE_WORKSPACE_TILE}
      />
    )

    expect(screen.queryByTestId('review-pane')).toBeNull()
  })

  it('renders review panel only in the matching workspace when multiple workspaces exist', () => {
    render(
      <WorkspaceFrames
        activePaneId="pane-1"
        reviewWorkspaceIds={['workspace-1']}
        workspaceTileLayout={TWO_WORKSPACE_TILE}
      />
    )

    // Review pane should exist once, for workspace-1
    const reviewPanes = screen.getAllByTestId('review-pane')
    expect(reviewPanes).toHaveLength(1)
    expect(reviewPanes[0]?.getAttribute('data-workspace-id')).toBe(
      'workspace-1'
    )

    // The workspace-1 header's frame should contain the review pane
    const headers = screen.getAllByTestId('workspace-frame-header')
    const ws1Header = headers.find(
      (h) => h.getAttribute('data-workspace-id') === 'workspace-1'
    )
    expect(ws1Header).toBeTruthy()

    // The workspace-2 frame should NOT contain a review pane
    const ws2Header = headers.find(
      (h) => h.getAttribute('data-workspace-id') === 'workspace-2'
    )
    expect(ws2Header).toBeTruthy()
  })

  it('renders review panel for workspace-2 when that workspace is targeted', () => {
    render(
      <WorkspaceFrames
        activePaneId="pane-1"
        reviewWorkspaceIds={['workspace-2']}
        workspaceTileLayout={TWO_WORKSPACE_TILE}
      />
    )

    const reviewPane = screen.getByTestId('review-pane')
    expect(reviewPane.getAttribute('data-workspace-id')).toBe('workspace-2')
  })
})

describe('Workspace-scoped diff panel', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    toggleDiffPaneMock.mockClear()
    toggleReviewPaneMock.mockClear()
  })

  it('renders diff panel inside the matching workspace frame', () => {
    render(
      <WorkspaceFrames
        activePaneId="pane-1"
        diffWorkspaceIds={['workspace-1']}
        workspaceTileLayout={SINGLE_WORKSPACE_TILE}
      />
    )

    const diffPane = screen.getByTestId('diff-pane')
    expect(diffPane).toBeTruthy()
    expect(diffPane.getAttribute('data-workspace-id')).toBe('workspace-1')
  })

  it('does not render diff panel when diffWorkspaceIds is empty', () => {
    render(
      <WorkspaceFrames
        activePaneId="pane-1"
        diffWorkspaceIds={[]}
        workspaceTileLayout={SINGLE_WORKSPACE_TILE}
      />
    )

    expect(screen.queryByTestId('diff-pane')).toBeNull()
  })

  it('renders diff panel only in the matching workspace when multiple workspaces exist', () => {
    render(
      <WorkspaceFrames
        activePaneId="pane-1"
        diffWorkspaceIds={['workspace-2']}
        workspaceTileLayout={TWO_WORKSPACE_TILE}
      />
    )

    const diffPanes = screen.getAllByTestId('diff-pane')
    expect(diffPanes).toHaveLength(1)
    expect(diffPanes[0]?.getAttribute('data-workspace-id')).toBe('workspace-2')
  })
  it('renders diff panels for multiple workspaces at once', () => {
    render(
      <WorkspaceFrames
        activePaneId="pane-1"
        diffWorkspaceIds={['workspace-1', 'workspace-2']}
        workspaceTileLayout={TWO_WORKSPACE_TILE}
      />
    )

    const diffWorkspaceIds = screen
      .getAllByTestId('diff-pane')
      .map((pane) => pane.getAttribute('data-workspace-id'))

    expect(diffWorkspaceIds).toEqual(['workspace-1', 'workspace-2'])
  })
})

describe('Both panels in same workspace', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    toggleDiffPaneMock.mockClear()
    toggleReviewPaneMock.mockClear()
  })

  it('renders both review and diff panels inside the same workspace frame', () => {
    render(
      <WorkspaceFrames
        activePaneId="pane-1"
        diffWorkspaceIds={['workspace-1']}
        reviewWorkspaceIds={['workspace-1']}
        workspaceTileLayout={SINGLE_WORKSPACE_TILE}
      />
    )

    expect(screen.getByTestId('review-pane')).toBeTruthy()
    expect(screen.getByTestId('diff-pane')).toBeTruthy()
  })

  it('renders the workspace header above the side panel group', () => {
    render(
      <WorkspaceFrames
        activePaneId="pane-1"
        diffWorkspaceIds={['workspace-1']}
        reviewWorkspaceIds={['workspace-1']}
        workspaceTileLayout={SINGLE_WORKSPACE_TILE}
      />
    )

    const frame = screen.getByTestId('workspace-frame')
    const frameChildren = Array.from(frame.children)

    expect(frameChildren[0]).toBe(screen.getByTestId('workspace-frame-header'))
    expect(frameChildren[1]).toBe(screen.getByTestId('resizable-panel-group'))
  })

  it('closes the diff viewer from the side panel header', async () => {
    const user = userEvent.setup()

    render(
      <WorkspaceFrames
        activePaneId="pane-1"
        diffWorkspaceIds={['workspace-1']}
        workspaceTileLayout={SINGLE_WORKSPACE_TILE}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Close diff viewer' }))

    expect(toggleDiffPaneMock).toHaveBeenCalledWith('pane-1')
  })

  it('closes the review pane from the side panel header', async () => {
    const user = userEvent.setup()

    render(
      <WorkspaceFrames
        activePaneId="pane-1"
        reviewWorkspaceIds={['workspace-1']}
        workspaceTileLayout={SINGLE_WORKSPACE_TILE}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Close review pane' }))

    expect(toggleReviewPaneMock).toHaveBeenCalledWith('pane-1')
  })

  it('renders panels in different workspaces simultaneously', () => {
    render(
      <WorkspaceFrames
        activePaneId="pane-1"
        diffWorkspaceIds={['workspace-2']}
        reviewWorkspaceIds={['workspace-1']}
        workspaceTileLayout={TWO_WORKSPACE_TILE}
      />
    )

    const reviewPane = screen.getByTestId('review-pane')
    const diffPane = screen.getByTestId('diff-pane')

    expect(reviewPane.getAttribute('data-workspace-id')).toBe('workspace-1')
    expect(diffPane.getAttribute('data-workspace-id')).toBe('workspace-2')
  })
  it('renders review panels for multiple workspaces at once', () => {
    render(
      <WorkspaceFrames
        activePaneId="pane-1"
        reviewWorkspaceIds={['workspace-1', 'workspace-2']}
        workspaceTileLayout={TWO_WORKSPACE_TILE}
      />
    )

    const reviewWorkspaceIds = screen
      .getAllByTestId('review-pane')
      .map((pane) => pane.getAttribute('data-workspace-id'))

    expect(reviewWorkspaceIds).toEqual(['workspace-1', 'workspace-2'])
  })
})

describe('PanelContent passes through side panel state', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    toggleDiffPaneMock.mockClear()
    toggleReviewPaneMock.mockClear()
  })

  it('shows loading state during reconciliation regardless of panel state', async () => {
    // We need to test PanelContent separately for the reconciling state
    // since WorkspaceFrames is not rendered during reconciliation
    vi.doMock('@/livestore/store', () => ({
      useLaborerStore: () => ({
        useQuery: vi.fn(() => []),
        query: vi.fn(() => []),
        commit: vi.fn(),
      }),
    }))

    vi.doMock('@livestore/livestore', () => ({
      queryDb: vi.fn(() => ({ table: 'mock' })),
    }))

    const { PanelContent } = await import(
      '../src/routes/-components/panel-content'
    )

    render(
      <PanelContent
        activePaneId="pane-1"
        fullscreenPaneId={null}
        isReconciling={true}
        reviewWorkspaceIds={['workspace-1']}
      />
    )

    expect(screen.getByText('Restoring terminal sessions...')).toBeTruthy()
    expect(screen.queryByTestId('review-pane')).toBeNull()
  })
})
