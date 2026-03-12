/**
 * Unit tests for the WorkspaceFrameHeader presentational component.
 *
 * Verifies the toolbar button behaviors — diff viewer toggle and
 * the new close-workspace button that replaced the per-pane buttons.
 *
 * @see apps/web/src/components/workspace-frame-header.tsx
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Stub tooltip — the @base-ui/react tooltip uses a portal that isn't
// available in jsdom. We just need the trigger to render its content.
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-wrapper">{children}</div>
  ),
  TooltipTrigger: ({ render }: { render: React.ReactElement }) => render,
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
const FULLSCREEN_RE = /fullscreen/i

/** Default props for a typical active pane scenario. */
const BASE_PROPS = {
  activePaneId: 'pane-1',
  branchName: 'main',
  diffIsOpen: false,
  isContainerized: false,
  projectName: 'my-project',
  workspaceId: 'ws-1',
} as const

describe('WorkspaceFrameHeader', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    vi.clearAllMocks()
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
})
