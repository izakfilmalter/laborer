/**
 * Unit tests for the WorkspaceFrameHeader presentational component.
 *
 * Verifies the toolbar button behaviors — particularly the diff viewer
 * toggle that was accidentally dropped during a prior refactor.
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

/** Default props for a typical active pane scenario. */
const BASE_PROPS = {
  activePaneId: 'pane-1',
  branchName: 'main',
  diffIsOpen: false,
  isContainerized: false,
  isFullscreen: false,
  projectName: 'my-project',
} as const

describe('WorkspaceFrameHeader', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

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
})
