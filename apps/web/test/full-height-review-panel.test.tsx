/**
 * Tests for full-height review panel feature.
 *
 * The review panel should render as a full-height side panel alongside
 * workspace frames, rather than being split inside a single workspace's
 * layout tree. This ensures the review panel spans all workspaces.
 *
 * @see Issue: Full-height review panel
 */

import type { PanelNode } from '@laborer/shared/types'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock LiveStore before any component imports
vi.mock('@livestore/livestore', () => ({
  queryDb: vi.fn(() => ({ table: 'mock' })),
}))

vi.mock('@/livestore/store', () => ({
  useLaborerStore: () => ({
    useQuery: vi.fn(() => []),
    query: vi.fn(() => []),
    commit: vi.fn(),
  }),
}))

// Mock panel context values
const mockPanelActions = {
  assignTerminalToPane: vi.fn(),
  closePane: vi.fn(),
  closeTerminalPane: vi.fn(),
  closeWorkspace: vi.fn(),
  forceCloseWorkspace: vi.fn(),
  reorderWorkspaces: vi.fn(),
  resizePane: vi.fn(),
  setActivePaneId: vi.fn(),
  splitPane: vi.fn(),
  toggleDevServerPane: vi.fn(),
  toggleDiffPane: vi.fn(),
  toggleFullscreenPane: vi.fn(),
  toggleReviewPane: vi.fn(),
}

vi.mock('@/panels/panel-context', () => ({
  PanelActionsProvider: ({ children }: React.PropsWithChildren) => (
    <>{children}</>
  ),
  useActivePaneId: () => 'pane-1',
  useFullscreenPaneId: () => null,
  usePanelActions: () => mockPanelActions,
  usePendingClosePane: () => ({
    paneId: null,
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
  }),
}))

vi.mock('@/panels/panel-manager', () => ({
  PanelManager: ({ layout }: { layout: PanelNode | undefined }) => (
    <div data-layout={JSON.stringify(layout)} data-testid="panel-manager" />
  ),
}))

vi.mock('@/panes/review-pane', () => ({
  ReviewPane: ({ workspaceId }: { workspaceId: string }) => (
    <div data-testid="review-pane" data-workspace-id={workspaceId}>
      Review Panel Content
    </div>
  ),
}))

vi.mock('../src/routes/-components/workspace-frames', () => ({
  WorkspaceFrames: () => (
    <div data-testid="workspace-frames">Workspace Frames</div>
  ),
}))

vi.mock('../src/routes/-components/workspace-frame-header-container', () => ({
  WorkspaceFrameHeaderContainer: () => (
    <div data-testid="workspace-frame-header">Header</div>
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
    defaultSize?: string
    minSize?: string
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
import { PanelContent } from '../src/routes/-components/panel-content'

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

describe('Full-height review panel', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders review panel alongside workspace frames when reviewPaneOpen is true', () => {
    render(
      <PanelContent
        activePaneId="pane-1"
        fullscreenPaneId={null}
        isReconciling={false}
        layout={TWO_WORKSPACE_LAYOUT}
        reviewPaneOpen
        reviewWorkspaceId="workspace-1"
        workspaceOrder={null}
      />
    )

    // Review pane should be rendered at the top level
    const reviewPane = screen.getByTestId('review-pane')
    expect(reviewPane).toBeTruthy()
    expect(reviewPane.getAttribute('data-workspace-id')).toBe('workspace-1')
  })

  it('does not render review panel when reviewPaneOpen is false', () => {
    render(
      <PanelContent
        activePaneId="pane-1"
        fullscreenPaneId={null}
        isReconciling={false}
        layout={TWO_WORKSPACE_LAYOUT}
        reviewPaneOpen={false}
        reviewWorkspaceId={null}
        workspaceOrder={null}
      />
    )

    // Review pane should not be rendered
    expect(screen.queryByTestId('review-pane')).toBeNull()
  })

  it('renders workspace frames and review panel side by side in horizontal split', () => {
    const { container } = render(
      <PanelContent
        activePaneId="pane-1"
        fullscreenPaneId={null}
        isReconciling={false}
        layout={TWO_WORKSPACE_LAYOUT}
        reviewPaneOpen
        reviewWorkspaceId="workspace-1"
        workspaceOrder={null}
      />
    )

    // Should have a horizontal resizable panel group containing both
    const panelGroup = container.querySelector('[data-panel-group]')
    expect(panelGroup).toBeTruthy()
    expect(panelGroup?.getAttribute('data-orientation')).toBe('horizontal')

    // Both workspace frames and review pane should be present
    expect(screen.getByTestId('workspace-frames')).toBeTruthy()
    expect(screen.getByTestId('review-pane')).toBeTruthy()
  })

  it('review panel takes up right side of the layout', () => {
    render(
      <PanelContent
        activePaneId="pane-1"
        fullscreenPaneId={null}
        isReconciling={false}
        layout={TWO_WORKSPACE_LAYOUT}
        reviewPaneOpen
        reviewWorkspaceId="workspace-1"
        workspaceOrder={null}
      />
    )

    // The review pane should be rendered (on the right side)
    const reviewPane = screen.getByTestId('review-pane')
    expect(reviewPane).toBeTruthy()
  })

  it('shows loading state during reconciliation even with review panel', () => {
    render(
      <PanelContent
        activePaneId="pane-1"
        fullscreenPaneId={null}
        isReconciling={true}
        layout={TWO_WORKSPACE_LAYOUT}
        reviewPaneOpen
        reviewWorkspaceId="workspace-1"
        workspaceOrder={null}
      />
    )

    // Should show reconciling message
    expect(screen.getByText('Restoring terminal sessions...')).toBeTruthy()
    // Review pane should not be shown during reconciliation
    expect(screen.queryByTestId('review-pane')).toBeNull()
  })

  it('renders review panel for the correct workspace', () => {
    render(
      <PanelContent
        activePaneId="pane-1"
        fullscreenPaneId={null}
        isReconciling={false}
        layout={TWO_WORKSPACE_LAYOUT}
        reviewPaneOpen
        reviewWorkspaceId="workspace-2"
        workspaceOrder={null}
      />
    )

    const reviewPane = screen.getByTestId('review-pane')
    expect(reviewPane.getAttribute('data-workspace-id')).toBe('workspace-2')
  })

  it('does not render review panel when reviewWorkspaceId is null even if reviewPaneOpen is true', () => {
    render(
      <PanelContent
        activePaneId="pane-1"
        fullscreenPaneId={null}
        isReconciling={false}
        layout={TWO_WORKSPACE_LAYOUT}
        reviewPaneOpen
        reviewWorkspaceId={null}
        workspaceOrder={null}
      />
    )

    // Review pane should not be rendered because workspaceId is null
    expect(screen.queryByTestId('review-pane')).toBeNull()
    // But workspace frames should still be rendered
    expect(screen.getByTestId('workspace-frames')).toBeTruthy()
  })

  it('does not render review panel when layout is undefined', () => {
    render(
      <PanelContent
        activePaneId="pane-1"
        fullscreenPaneId={null}
        isReconciling={false}
        layout={undefined}
        reviewPaneOpen
        reviewWorkspaceId="workspace-1"
        workspaceOrder={null}
      />
    )

    // Review pane should not be rendered because no layout exists
    expect(screen.queryByTestId('review-pane')).toBeNull()
  })
})
