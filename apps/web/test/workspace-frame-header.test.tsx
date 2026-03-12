/**
 * Unit tests for the WorkspaceFrameHeader presentational component.
 *
 * Verifies the toolbar button behaviors — diff viewer toggle, header
 * click focus, minimize/expand toggle, close-workspace button, and
 * action button visibility based on minimized state.
 *
 * @see apps/web/src/components/workspace-frame-header.tsx
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { isElectronMock, openExternalUrlMock } = vi.hoisted(() => ({
  isElectronMock: vi.fn(() => false),
  openExternalUrlMock: vi.fn(async () => true),
}))

vi.mock('@/lib/desktop', () => ({
  isElectron: isElectronMock,
  openExternalUrl: openExternalUrlMock,
}))

// Stub tooltip — the @base-ui/react tooltip uses a portal that isn't
// available in jsdom. We just need the trigger to render its content.
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-wrapper">{children}</div>
  ),
  TooltipTrigger: ({
    children,
    render,
  }: {
    children?: React.ReactNode
    render?: React.ReactElement
  }) => <>{render ?? children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
}))

import type { PanelActions } from '@/panels/panel-context'
import { WorkspaceFrameHeader } from '../src/components/workspace-frame-header'

/** Creates a mock PanelActions with all methods stubbed via vi.fn(). */
function mockActions(): PanelActions {
  return {
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
  }
}

const DIFF_VIEWER_RE = /diff viewer/i
const MINIMIZE_RE = /minimize/i
const FULLSCREEN_RE = /fullscreen/i
const MERGED_PR_RE = /#42 merged/i
const CLOSED_PR_RE = /#17 closed/i

/** Default props for a typical active pane scenario. */
const BASE_PROPS = {
  activePaneId: 'pane-1',
  branchName: 'main',
  diffIsOpen: false,
  isContainerized: false,
  prNumber: null,
  prState: null,
  prTitle: null,
  prUrl: null,
  projectName: 'my-project',
  workspaceId: 'ws-1',
} as const

describe('WorkspaceFrameHeader', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    isElectronMock.mockReturnValue(false)
  })

  // --- Diff viewer toggle ---

  it('renders the diff viewer toggle button', () => {
    const actions = mockActions()
    render(<WorkspaceFrameHeader {...BASE_PROPS} actions={actions} />)

    const button = screen.getByRole('button', { name: DIFF_VIEWER_RE })
    expect(button).toBeTruthy()
  })

  it('calls toggleDiffPane with the active pane ID when clicked', () => {
    const actions = mockActions()
    render(<WorkspaceFrameHeader {...BASE_PROPS} actions={actions} />)

    const button = screen.getByRole('button', { name: DIFF_VIEWER_RE })
    fireEvent.click(button)

    expect(actions.toggleDiffPane).toHaveBeenCalledWith('pane-1')
  })

  it('applies bg-accent class to diff toggle when diff is open', () => {
    const actions = mockActions()
    render(
      <WorkspaceFrameHeader {...BASE_PROPS} actions={actions} diffIsOpen />
    )

    const button = screen.getByRole('button', { name: DIFF_VIEWER_RE })
    expect(button.className).toContain('bg-accent')
  })

  it('does not apply bg-accent class to diff toggle when diff is closed', () => {
    const actions = mockActions()
    render(<WorkspaceFrameHeader {...BASE_PROPS} actions={actions} />)

    const button = screen.getByRole('button', { name: DIFF_VIEWER_RE })
    expect(button.className).not.toContain('bg-accent')
  })

  it('disables the diff toggle button when no pane is active', () => {
    const actions = mockActions()
    render(
      <WorkspaceFrameHeader
        {...BASE_PROPS}
        actions={actions}
        activePaneId={null}
      />
    )

    const button = screen.getByRole('button', { name: DIFF_VIEWER_RE })
    expect(button).toHaveProperty('disabled', true)
  })

  it('does not call toggleDiffPane when clicked with no active pane', () => {
    const actions = mockActions()
    render(
      <WorkspaceFrameHeader
        {...BASE_PROPS}
        actions={actions}
        activePaneId={null}
      />
    )

    const button = screen.getByRole('button', { name: DIFF_VIEWER_RE })
    fireEvent.click(button)

    expect(actions.toggleDiffPane).not.toHaveBeenCalled()
  })

  it('labels the button "Open diff viewer" when diff is closed', () => {
    const actions = mockActions()
    render(<WorkspaceFrameHeader {...BASE_PROPS} actions={actions} />)

    const button = screen.getByRole('button', { name: 'Open diff viewer' })
    expect(button).toBeTruthy()
  })

  it('labels the button "Close diff viewer" when diff is open', () => {
    const actions = mockActions()
    render(
      <WorkspaceFrameHeader {...BASE_PROPS} actions={actions} diffIsOpen />
    )

    const button = screen.getByRole('button', { name: 'Close diff viewer' })
    expect(button).toBeTruthy()
  })

  // --- Focus shift on button click ---

  describe('focus shift on button click', () => {
    it('calls setActivePaneId before toggling diff pane', () => {
      const actions = mockActions()
      render(<WorkspaceFrameHeader {...BASE_PROPS} actions={actions} />)

      const button = screen.getByRole('button', { name: DIFF_VIEWER_RE })
      fireEvent.click(button)

      expect(actions.setActivePaneId).toHaveBeenCalledWith('pane-1')
      // setActivePaneId should be called before toggleDiffPane
      const setActiveOrder = (
        actions.setActivePaneId as ReturnType<typeof vi.fn>
      ).mock.invocationCallOrder[0] as number
      const toggleOrder = (actions.toggleDiffPane as ReturnType<typeof vi.fn>)
        .mock.invocationCallOrder[0] as number
      expect(setActiveOrder).toBeLessThan(toggleOrder)
    })

    it('does not call setActivePaneId when no active pane', () => {
      const actions = mockActions()
      render(
        <WorkspaceFrameHeader
          {...BASE_PROPS}
          actions={actions}
          activePaneId={null}
        />
      )

      const button = screen.getByRole('button', { name: DIFF_VIEWER_RE })
      fireEvent.click(button)

      expect(actions.setActivePaneId).not.toHaveBeenCalled()
    })
  })

  // --- Close workspace button ---

  it('renders a close workspace button', () => {
    const actions = mockActions()
    render(<WorkspaceFrameHeader {...BASE_PROPS} actions={actions} />)

    const button = screen.getByRole('button', { name: 'Close workspace' })
    expect(button).toBeTruthy()
  })

  it('calls closeWorkspace with workspace ID when clicked', () => {
    const actions = mockActions()
    render(<WorkspaceFrameHeader {...BASE_PROPS} actions={actions} />)

    const button = screen.getByRole('button', { name: 'Close workspace' })
    fireEvent.click(button)

    expect(actions.closeWorkspace).toHaveBeenCalledWith('ws-1')
  })

  it('disables close workspace button when workspaceId is undefined', () => {
    const actions = mockActions()
    render(
      <WorkspaceFrameHeader
        {...BASE_PROPS}
        actions={actions}
        workspaceId={undefined}
      />
    )

    const button = screen.getByRole('button', { name: 'Close workspace' })
    expect(button).toHaveProperty('disabled', true)
  })

  it('does not call closeWorkspace when workspaceId is undefined', () => {
    const actions = mockActions()
    render(
      <WorkspaceFrameHeader
        {...BASE_PROPS}
        actions={actions}
        workspaceId={undefined}
      />
    )

    const button = screen.getByRole('button', { name: 'Close workspace' })
    fireEvent.click(button)

    expect(actions.closeWorkspace).not.toHaveBeenCalled()
  })

  // --- Removed buttons should not be present ---

  it('does not render split or fullscreen buttons (moved to terminal overlay)', () => {
    const actions = mockActions()
    render(<WorkspaceFrameHeader {...BASE_PROPS} actions={actions} />)

    expect(
      screen.queryByRole('button', { name: 'Split horizontally' })
    ).toBeNull()
    expect(
      screen.queryByRole('button', { name: 'Split vertically' })
    ).toBeNull()
    expect(screen.queryByRole('button', { name: FULLSCREEN_RE })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Close pane' })).toBeNull()
  })

  // ---------------------------------------------------------------------------
  // Header click → onHeaderClick
  // ---------------------------------------------------------------------------

  it('calls onHeaderClick when the header label area is clicked', () => {
    const actions = mockActions()
    const onHeaderClick = vi.fn()
    render(
      <WorkspaceFrameHeader
        {...BASE_PROPS}
        actions={actions}
        onHeaderClick={onHeaderClick}
      />
    )

    // Click the project name / branch name area
    const label = screen.getByText('my-project')
    fireEvent.click(label)

    expect(onHeaderClick).toHaveBeenCalledOnce()
  })

  // ---------------------------------------------------------------------------
  // Minimize button
  // ---------------------------------------------------------------------------

  it('renders a minimize button and calls onMinimize when clicked', () => {
    const actions = mockActions()
    const onMinimize = vi.fn()
    render(
      <WorkspaceFrameHeader
        {...BASE_PROPS}
        actions={actions}
        onMinimize={onMinimize}
      />
    )

    const button = screen.getByRole('button', { name: MINIMIZE_RE })
    fireEvent.click(button)

    expect(onMinimize).toHaveBeenCalledOnce()
  })

  it('labels minimize button "Minimize workspace" when expanded', () => {
    const actions = mockActions()
    render(
      <WorkspaceFrameHeader
        {...BASE_PROPS}
        actions={actions}
        isMinimized={false}
        onMinimize={vi.fn()}
      />
    )

    const button = screen.getByRole('button', { name: 'Minimize workspace' })
    expect(button).toBeTruthy()
  })

  it('labels minimize button "Expand workspace" when minimized', () => {
    const actions = mockActions()
    render(
      <WorkspaceFrameHeader
        {...BASE_PROPS}
        actions={actions}
        isMinimized
        onMinimize={vi.fn()}
      />
    )

    const button = screen.getByRole('button', { name: 'Expand workspace' })
    expect(button).toBeTruthy()
  })

  it('calls onHeaderClick when header label is clicked while minimized', () => {
    const actions = mockActions()
    const onHeaderClick = vi.fn()
    render(
      <WorkspaceFrameHeader
        {...BASE_PROPS}
        actions={actions}
        isMinimized
        onHeaderClick={onHeaderClick}
      />
    )

    const label = screen.getByText('my-project')
    fireEvent.click(label)

    expect(onHeaderClick).toHaveBeenCalledOnce()
  })

  it('calls onHeaderClick when clicking anywhere on the header bar while minimized', () => {
    const actions = mockActions()
    const onHeaderClick = vi.fn()
    render(
      <WorkspaceFrameHeader
        {...BASE_PROPS}
        actions={actions}
        isMinimized
        onHeaderClick={onHeaderClick}
      />
    )

    // Click the outer header bar itself, not the inner label button
    const headerBar = screen.getByTestId('workspace-frame-header')
    fireEvent.click(headerBar)

    expect(onHeaderClick).toHaveBeenCalledOnce()
  })

  it('does not call onHeaderClick when clicking the header bar background while expanded', () => {
    const actions = mockActions()
    const onHeaderClick = vi.fn()
    render(
      <WorkspaceFrameHeader
        {...BASE_PROPS}
        actions={actions}
        isMinimized={false}
        onHeaderClick={onHeaderClick}
      />
    )

    // Click the outer header bar itself (not the label button)
    const headerBar = screen.getByTestId('workspace-frame-header')
    fireEvent.click(headerBar)

    // Should NOT trigger onHeaderClick — only the inner label button triggers it
    expect(onHeaderClick).not.toHaveBeenCalled()
  })

  // ---------------------------------------------------------------------------
  // Minimized state hides action buttons
  // ---------------------------------------------------------------------------

  it('hides diff, close workspace, and dev server buttons when minimized', () => {
    const actions = mockActions()
    render(
      <WorkspaceFrameHeader
        {...BASE_PROPS}
        actions={actions}
        isMinimized
        onMinimize={vi.fn()}
      />
    )

    // These action buttons should not be present when minimized
    expect(screen.queryByRole('button', { name: DIFF_VIEWER_RE })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Close workspace' })).toBeNull()

    // But the minimize/expand button should still be visible
    expect(
      screen.getByRole('button', { name: 'Expand workspace' })
    ).toBeTruthy()
  })

  it('shows all action buttons when not minimized', () => {
    const actions = mockActions()
    render(
      <WorkspaceFrameHeader
        {...BASE_PROPS}
        actions={actions}
        isMinimized={false}
        onMinimize={vi.fn()}
      />
    )

    expect(screen.getByRole('button', { name: DIFF_VIEWER_RE })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Close workspace' })).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Minimize workspace' })
    ).toBeTruthy()
  })

  it('renders the GitHub PR status badge in the header', () => {
    const actions = mockActions()
    render(
      <WorkspaceFrameHeader
        {...BASE_PROPS}
        actions={actions}
        prNumber={42}
        prState="MERGED"
        prTitle="Ship the fix"
        prUrl="https://github.com/example/repo/pull/42"
      />
    )

    expect(screen.getByRole('link', { name: MERGED_PR_RE })).toBeTruthy()
    expect(screen.queryByText('running')).toBeNull()
  })

  it('opens PR links in the OS browser when running in Electron', () => {
    isElectronMock.mockReturnValue(true)
    const actions = mockActions()
    render(
      <WorkspaceFrameHeader
        {...BASE_PROPS}
        actions={actions}
        prNumber={42}
        prState="MERGED"
        prTitle="Ship the fix"
        prUrl="https://github.com/example/repo/pull/42"
      />
    )

    fireEvent.click(screen.getByRole('link', { name: MERGED_PR_RE }))

    expect(openExternalUrlMock).toHaveBeenCalledWith(
      'https://github.com/example/repo/pull/42'
    )
  })

  it('renders GitHub PR status without a link when the URL is missing', () => {
    const actions = mockActions()
    render(
      <WorkspaceFrameHeader
        {...BASE_PROPS}
        actions={actions}
        prNumber={17}
        prState="CLOSED"
        prTitle="Closed PR"
      />
    )

    expect(screen.getByText('#17')).toBeTruthy()
    expect(screen.getByText('closed')).toBeTruthy()
    expect(screen.queryByRole('link', { name: CLOSED_PR_RE })).toBeNull()
  })

  // ---------------------------------------------------------------------------
  // Agent status: needs input indicator
  // ---------------------------------------------------------------------------

  it('shows "needs input" badge when agentStatus is waiting_for_input', () => {
    const actions = mockActions()
    render(
      <WorkspaceFrameHeader
        {...BASE_PROPS}
        actions={actions}
        agentStatus="waiting_for_input"
      />
    )

    const badge = screen.getByText('needs input')
    expect(badge).toBeTruthy()
  })

  it('does not show "needs input" badge when agentStatus is null', () => {
    const actions = mockActions()
    render(
      <WorkspaceFrameHeader
        {...BASE_PROPS}
        actions={actions}
        agentStatus={null}
      />
    )

    expect(screen.queryByText('needs input')).toBeNull()
  })

  it('does not show "needs input" badge when agentStatus is active', () => {
    const actions = mockActions()
    render(
      <WorkspaceFrameHeader
        {...BASE_PROPS}
        actions={actions}
        agentStatus="active"
      />
    )

    expect(screen.queryByText('needs input')).toBeNull()
  })
})
