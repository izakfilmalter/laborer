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

const { isElectronMock, openExternalUrlMock, syncCountsRef } = vi.hoisted(
  () => ({
    isElectronMock: vi.fn(() => false),
    openExternalUrlMock: vi.fn(async () => true),
    syncCountsRef: {
      current: {
        aheadCount: null as number | null,
        behindCount: null as number | null,
      },
    },
  })
)

// The header no longer receives sync counts as props: the indicator reads
// them for its own workspace.
vi.mock('@/hooks/use-workspace-sync-status', () => ({
  useWorkspaceSyncStatus: () => syncCountsRef.current,
}))

vi.mock('@/lib/local-api', () => ({
  localApi: {
    get isDesktop() {
      return isElectronMock()
    },
    openExternal: openExternalUrlMock,
  },
  serverRpcUrl: () => 'http://localhost:2100/rpc',
}))

// Stub tooltip — the @base-ui/react tooltip uses a portal that isn't
// available in jsdom. We just need the trigger to render its content.
vi.mock('@laborer/ui/components/tooltip', () => ({
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

// The edit button reads the task backing the workspace from the shared
// collection; the header only decides whether it belongs on the bar.
vi.mock('@/components/edit-task-card-button', () => ({
  EditTaskCardButton: ({ branchName }: { branchName: string }) => (
    <button aria-label={`Edit card for ${branchName}`} type="button" />
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
    showPanelTypePicker: vi.fn(),
    splitPane: vi.fn(),
    updatePaneType: vi.fn(),
    toggleDevServerPane: vi.fn(),
    toggleDiffPane: vi.fn(),
    toggleFullscreenPane: vi.fn(),
    toggleFilesPane: vi.fn(() => false),
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
}

const CREATE_SUB_WORKSPACE_RE = /create sub-workspace from/i
const EDIT_CARD_RE = /edit card for/i
const DIFF_VIEWER_RE = /diff viewer/i
const MINIMIZE_RE = /minimize/i
const FULLSCREEN_RE = /fullscreen/i
const MERGED_PR_RE = /#42 merged/i
const CLOSED_PR_RE = /#17 closed/i
const PUSH_COMMITS_RE = /push 2 commits/i
const PULL_COMMITS_RE = /pull 3 commits/i
const SYNC_RE = /pull|push/i
const CONFLICTS_RE = /Conflicts with/i
const CHECKS_RE = /checks/i
const UNRESOLVED_RE = /unresolved conversation/i
const APPROVED_RE = /^Approved/
const ANY_REVIEW_RE = /Approved|Review required|Changes requested/
const WORKSPACE_FRAME_AUTHOR_TEST_ID_RE = /^workspace-frame-author-/

/** Default props for a typical active pane scenario. */
const BASE_PROPS = {
  activePaneId: 'pane-1',
  branchName: 'main',
  diffIsOpen: false,
  prNumber: null,
  prState: null,
  prTitle: null,
  prUrl: null,
  projectId: 'project-1',
  projectName: 'my-project',
  projectShortName: 'LAB',
  taskNumber: 7,
  workspaceId: 'ws-1',
  workspacePath: [] as readonly string[],
} as const

describe('WorkspaceFrameHeader', () => {
  afterEach(() => {
    cleanup()
    syncCountsRef.current = { aheadCount: null, behindCount: null }
  })

  beforeEach(() => {
    vi.clearAllMocks()
    isElectronMock.mockReturnValue(false)
  })

  it('shows the task identifier in the workspace header', () => {
    render(<WorkspaceFrameHeader {...BASE_PROPS} actions={mockActions()} />)

    expect(screen.getByText('LAB-7').getAttribute('data-task-identifier')).toBe(
      'LAB-7'
    )
  })

  it("names the author between the project and the branch when the work is somebody else's", () => {
    render(
      <WorkspaceFrameHeader
        {...BASE_PROPS}
        actions={mockActions()}
        authorLogin="octocat"
        branchName="claude/errors-view"
      />
    )

    const title = screen.getByTestId('workspace-frame-author-octocat')
    expect(title.textContent).toContain('octocat')
    // The avatar fallback initial renders in jsdom, so only the ordering of
    // project, author, and branch is asserted.
    expect(title.parentElement?.textContent?.replace(/\s+/g, '')).toBe(
      'my-project/Ooctocat/claude/errors-view'
    )
  })

  it('leaves the title unadorned for the viewer’s own work', () => {
    render(<WorkspaceFrameHeader {...BASE_PROPS} actions={mockActions()} />)

    expect(screen.queryByTestId(WORKSPACE_FRAME_AUTHOR_TEST_ID_RE)).toBeNull()
  })

  it('does not show a task identifier for a root workspace', () => {
    render(
      <WorkspaceFrameHeader
        {...BASE_PROPS}
        actions={mockActions()}
        taskNumber={null}
      />
    )

    expect(screen.queryByText('LAB-7')).toBeNull()
  })

  // --- Card actions on the frame doing the card's work ---

  it('offers branching and card editing for a task-backed workspace', () => {
    render(<WorkspaceFrameHeader {...BASE_PROPS} actions={mockActions()} />)

    expect(screen.getByLabelText(CREATE_SUB_WORKSPACE_RE)).toBeTruthy()
    expect(screen.getByLabelText(EDIT_CARD_RE)).toBeTruthy()
  })

  it('omits branching and card editing for a root workspace', () => {
    render(
      <WorkspaceFrameHeader
        {...BASE_PROPS}
        actions={mockActions()}
        taskNumber={null}
        workspaceId="root-project-1"
      />
    )

    expect(screen.queryByLabelText(CREATE_SUB_WORKSPACE_RE)).toBeNull()
    expect(screen.queryByLabelText(EDIT_CARD_RE)).toBeNull()
  })

  it('hides branching and card editing when minimized', () => {
    render(
      <WorkspaceFrameHeader
        {...BASE_PROPS}
        actions={mockActions()}
        isMinimized={true}
      />
    )

    expect(screen.queryByLabelText(CREATE_SUB_WORKSPACE_RE)).toBeNull()
    expect(screen.queryByLabelText(EDIT_CARD_RE)).toBeNull()
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
    expect(button.getAttribute('aria-pressed')).toBe('true')
  })

  it('does not apply bg-accent class to diff toggle when diff is closed', () => {
    const actions = mockActions()
    render(<WorkspaceFrameHeader {...BASE_PROPS} actions={actions} />)

    const button = screen.getByRole('button', { name: DIFF_VIEWER_RE })
    expect(button.className).not.toContain('bg-accent')
    expect(button.getAttribute('aria-pressed')).toBe('false')
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

  it('does not render pane action buttons', () => {
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

  it('hides diff and close workspace buttons when minimized', () => {
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

  it('hangs the check rollup off the header pull request pill', () => {
    const actions = mockActions()
    render(
      <WorkspaceFrameHeader
        {...BASE_PROPS}
        actions={actions}
        prCheckStatus="failure"
        prChecks={[
          {
            bucket: 'failure',
            durationMs: 179_000,
            group: 'Merge Checks',
            name: 'Unit Tests',
            url: null,
          },
          {
            bucket: 'success',
            durationMs: 40_000,
            group: 'Merge Checks',
            name: 'Build',
            url: null,
          },
        ]}
        prNumber={42}
        prState="OPEN"
        prTitle="Ship the fix"
        prUrl="https://github.com/example/repo/pull/42"
      />
    )

    const pill = screen
      .getByText('#42')
      .closest('[data-slot="pr-status-badge"]')
    const checks = screen.getByRole('link', {
      name: 'Some checks were not successful: 1 failed · 1 passed',
    })
    expect(pill?.contains(checks)).toBe(true)
    expect(checks.getAttribute('href')).toBe(
      'https://github.com/example/repo/pull/42/checks'
    )
  })

  it('marks a merge conflict in the header without spending words on it', () => {
    const actions = mockActions()
    render(
      <WorkspaceFrameHeader
        {...BASE_PROPS}
        actions={actions}
        prBaseBranch="dev"
        prMergeStatus="conflicting"
        prNumber={42}
        prState="OPEN"
        prTitle="Ship the fix"
        prUrl="https://github.com/example/repo/pull/42"
      />
    )

    expect(screen.getByRole('img', { name: 'Conflicts with dev' })).toBeTruthy()
  })

  it('leaves the header pill bare when the pull request has no checks', () => {
    const actions = mockActions()
    render(
      <WorkspaceFrameHeader
        {...BASE_PROPS}
        actions={actions}
        prNumber={42}
        prState="OPEN"
        prTitle="Ship the fix"
        prUrl="https://github.com/example/repo/pull/42"
      />
    )

    expect(screen.queryByRole('img', { name: CONFLICTS_RE })).toBeNull()
    expect(screen.queryByRole('link', { name: CHECKS_RE })).toBeNull()
  })

  // ---------------------------------------------------------------------------
  // Unresolved conversations: the count opens the pane it counts
  // ---------------------------------------------------------------------------

  describe('unresolved conversations on the header pill', () => {
    const withComments = () => ({
      ...mockActions(),
      toggleCommentsPane: vi.fn(() => true),
    })

    const renderWithThreads = (
      actions: PanelActions,
      overrides?: { activePaneId?: string | null; commentsIsOpen?: boolean }
    ) =>
      render(
        <WorkspaceFrameHeader
          {...BASE_PROPS}
          actions={actions}
          // `??` would swallow a deliberate null, which is the whole point of
          // the no-pane case.
          activePaneId={
            overrides?.activePaneId === undefined
              ? BASE_PROPS.activePaneId
              : overrides.activePaneId
          }
          commentsIsOpen={overrides?.commentsIsOpen ?? false}
          prNumber={42}
          prState="OPEN"
          prTitle="Ship the fix"
          prUnresolvedThreads={3}
          prUrl="https://github.com/example/repo/pull/42"
        />
      )

    it('opens the comments pane instead of leaving for the browser', () => {
      isElectronMock.mockReturnValue(true)
      const actions = withComments()
      renderWithThreads(actions)

      fireEvent.click(screen.getByRole('link', { name: UNRESOLVED_RE }))

      expect(actions.toggleCommentsPane).toHaveBeenCalledWith('pane-1')
      expect(openExternalUrlMock).not.toHaveBeenCalled()
    })

    it('focuses a pane that is already open rather than closing it', () => {
      const actions = withComments()
      renderWithThreads(actions, { commentsIsOpen: true })

      fireEvent.click(screen.getByRole('link', { name: UNRESOLVED_RE }))

      expect(actions.setActivePaneId).toHaveBeenCalledWith('pane-1')
      expect(actions.toggleCommentsPane).not.toHaveBeenCalled()
    })

    it('falls back to the diff on GitHub when the frame has no pane', () => {
      isElectronMock.mockReturnValue(true)
      const actions = withComments()
      renderWithThreads(actions, { activePaneId: null })

      fireEvent.click(screen.getByRole('link', { name: UNRESOLVED_RE }))

      expect(actions.toggleCommentsPane).not.toHaveBeenCalled()
      expect(openExternalUrlMock).toHaveBeenCalledWith(
        'https://github.com/example/repo/pull/42/files'
      )
    })
  })

  // ---------------------------------------------------------------------------
  // Review verdict: the header hands the badge what the workspace knows
  // ---------------------------------------------------------------------------

  describe('the review verdict on the header pill', () => {
    const renderWithReview = (
      props: Partial<{
        prApprovals: number | null
        prIsDraft: boolean
        prReviewDecision: 'approved' | 'changesRequested' | 'reviewRequired'
      }>
    ) =>
      render(
        <WorkspaceFrameHeader
          {...BASE_PROPS}
          actions={mockActions()}
          prNumber={42}
          prState="OPEN"
          prTitle="Ship the fix"
          prUrl="https://github.com/example/repo/pull/42"
          {...props}
        />
      )

    it('shows the verdict and its approvals the workspace was given', () => {
      renderWithReview({ prApprovals: 2, prReviewDecision: 'approved' })

      const segment = screen.getByRole('link', { name: APPROVED_RE })
      expect(segment.textContent).toContain('2')
    })

    it('reads an unreviewed pull request as still waiting on one', () => {
      renderWithReview({})

      expect(screen.getByRole('link', { name: ANY_REVIEW_RE })).toBeTruthy()
    })

    it('says where a draft stands with its reviewers too', () => {
      renderWithReview({
        prApprovals: 0,
        prIsDraft: true,
        prReviewDecision: 'reviewRequired',
      })

      expect(screen.getByRole('link', { name: ANY_REVIEW_RE })).toBeTruthy()
      expect(screen.getByText('draft')).toBeTruthy()
    })
  })

  it('offers pulling first when the workspace is both ahead and behind', () => {
    syncCountsRef.current = { aheadCount: 2, behindCount: 3 }
    const actions = mockActions()
    render(<WorkspaceFrameHeader {...BASE_PROPS} actions={actions} />)

    // One button, not two: pulling is the step that keeps the later push
    // fast-forwardable, so it owns the click while the push count rides along.
    expect(screen.getAllByRole('button', { name: SYNC_RE })).toHaveLength(1)
    expect(screen.getByRole('button', { name: PULL_COMMITS_RE })).toBeTruthy()
  })

  it('offers pushing when the workspace is only ahead', () => {
    syncCountsRef.current = { aheadCount: 2, behindCount: 0 }
    const actions = mockActions()
    render(<WorkspaceFrameHeader {...BASE_PROPS} actions={actions} />)

    expect(screen.getByRole('button', { name: PUSH_COMMITS_RE })).toBeTruthy()
  })

  it('renders no sync actions while the workspace is level with upstream', () => {
    syncCountsRef.current = { aheadCount: 0, behindCount: 0 }
    const actions = mockActions()
    render(<WorkspaceFrameHeader {...BASE_PROPS} actions={actions} />)

    expect(screen.queryByRole('button', { name: PUSH_COMMITS_RE })).toBeNull()
    expect(screen.queryByRole('button', { name: PULL_COMMITS_RE })).toBeNull()
  })

  // ---------------------------------------------------------------------------
  // Agent status: needs input indicator
  // ---------------------------------------------------------------------------

  it('shows "needs input" badge when agentStatus is needs_input', () => {
    const actions = mockActions()
    render(
      <WorkspaceFrameHeader
        {...BASE_PROPS}
        actions={actions}
        agentStatus="needs_input"
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

  it('shows a "working" badge when the workspace agent is working', () => {
    const actions = mockActions()
    render(
      <WorkspaceFrameHeader
        {...BASE_PROPS}
        actions={actions}
        agentStatus="working"
      />
    )

    expect(screen.getByText('working')).toBeTruthy()
  })

  it('stays quiet for at-rest agent states', () => {
    const actions = mockActions()
    render(
      <WorkspaceFrameHeader
        {...BASE_PROPS}
        actions={actions}
        agentStatus="idle"
      />
    )

    expect(screen.queryByText('idle')).toBeNull()
    expect(screen.queryByText('needs input')).toBeNull()
  })

  it('does not show "needs input" badge when agentStatus is active', () => {
    const actions = mockActions()
    render(
      <WorkspaceFrameHeader
        {...BASE_PROPS}
        actions={actions}
        agentStatus="working"
      />
    )

    expect(screen.queryByText('needs input')).toBeNull()
  })

  // ---------------------------------------------------------------------------
  // Active frame: accent bottom border on header
  // ---------------------------------------------------------------------------

  it('applies accent bottom border when isActiveFrame is true', () => {
    const actions = mockActions()
    render(
      <WorkspaceFrameHeader {...BASE_PROPS} actions={actions} isActiveFrame />
    )

    const header = screen.getByTestId('workspace-frame-header')
    expect(header.className).toContain('border-b-2')
    expect(header.className).toContain('border-b-primary')
  })

  it('does not apply accent bottom border when isActiveFrame is false', () => {
    const actions = mockActions()
    render(
      <WorkspaceFrameHeader
        {...BASE_PROPS}
        actions={actions}
        isActiveFrame={false}
      />
    )

    const header = screen.getByTestId('workspace-frame-header')
    expect(header.className).not.toContain('border-b-2')
    expect(header.className).not.toContain('border-b-primary')
  })

  it('does not apply accent bottom border when isActiveFrame is not provided', () => {
    const actions = mockActions()
    render(<WorkspaceFrameHeader {...BASE_PROPS} actions={actions} />)

    const header = screen.getByTestId('workspace-frame-header')
    expect(header.className).not.toContain('border-b-2')
    expect(header.className).not.toContain('border-b-primary')
  })

  it('recolours rather than thins the active edge when the agent needs input', () => {
    const actions = mockActions()
    render(
      <WorkspaceFrameHeader
        {...BASE_PROPS}
        actions={actions}
        agentStatus="needs_input"
        isActiveFrame
      />
    )

    const header = screen.getByTestId('workspace-frame-header')
    // Attention takes the edge over from the active-frame accent, and keeps
    // its weight: a blocked frame must never read lighter than the frame the
    // operator happens to be looking at.
    expect(header.className).toContain('border-b-2')
    expect(header.className).not.toContain('border-b-primary')
    expect(header.className).toContain('border-b-amber-400')
  })

  it('accents an unseen completion differently from a blocked agent', () => {
    const actions = mockActions()
    const { container } = render(
      <WorkspaceFrameHeader
        {...BASE_PROPS}
        actions={actions}
        agentStatus="done"
      />
    )

    const header = screen.getByTestId('workspace-frame-header')
    expect(screen.getByText('done')).toBeTruthy()
    expect(header.className).toContain('border-b-2')
    expect(header.className).toContain('border-b-violet-400')
    expect(header.className).not.toContain('border-b-primary')
    expect(header.className).not.toContain('amber')
    // The check glyph, not hue alone, separates "review" from "act now".
    expect(
      container.querySelector('[data-testid="agent-status-check"]')
    ).not.toBeNull()
  })

  it('lets the active-frame accent win over a merely working agent', () => {
    const actions = mockActions()
    render(
      <WorkspaceFrameHeader
        {...BASE_PROPS}
        actions={actions}
        agentStatus="working"
        isActiveFrame
      />
    )

    const header = screen.getByTestId('workspace-frame-header')
    expect(header.className).toContain('border-b-primary')
    expect(header.className).not.toContain('bg-blue-400')
  })
})
