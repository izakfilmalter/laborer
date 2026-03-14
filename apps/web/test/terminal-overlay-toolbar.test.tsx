/**
 * Unit tests for the TerminalOverlayToolbar component.
 *
 * Verifies that per-pane action buttons (split, fullscreen, close)
 * are rendered and delegate to the correct PanelActions methods.
 *
 * @see apps/web/src/components/terminal-overlay-toolbar.tsx
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
import { TerminalOverlayToolbar } from '../src/components/terminal-overlay-toolbar'

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
    toggleDevServerPane: vi.fn(),
    toggleDiffPane: vi.fn(),
    toggleFullscreenPane: vi.fn(),
    toggleReviewPane: vi.fn(),
    addPanelTab: vi.fn(),
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
  }
}

describe('TerminalOverlayToolbar', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders split horizontal button that calls splitPane', () => {
    const actions = mockActions()
    render(
      <TerminalOverlayToolbar
        actions={actions}
        isFullscreen={false}
        paneId="pane-1"
      />
    )

    const button = screen.getByRole('button', { name: 'Split horizontally' })
    fireEvent.click(button)

    expect(actions.splitPane).toHaveBeenCalledWith('pane-1', 'horizontal')
  })

  it('renders split vertical button that calls splitPane', () => {
    const actions = mockActions()
    render(
      <TerminalOverlayToolbar
        actions={actions}
        isFullscreen={false}
        paneId="pane-1"
      />
    )

    const button = screen.getByRole('button', { name: 'Split vertically' })
    fireEvent.click(button)

    expect(actions.splitPane).toHaveBeenCalledWith('pane-1', 'vertical')
  })

  it('renders fullscreen button that calls toggleFullscreenPane', () => {
    const actions = mockActions()
    render(
      <TerminalOverlayToolbar
        actions={actions}
        isFullscreen={false}
        paneId="pane-1"
      />
    )

    const button = screen.getByRole('button', { name: 'Fullscreen pane' })
    fireEvent.click(button)

    expect(actions.toggleFullscreenPane).toHaveBeenCalled()
  })

  it('renders exit fullscreen button when in fullscreen mode', () => {
    const actions = mockActions()
    render(
      <TerminalOverlayToolbar
        actions={actions}
        isFullscreen={true}
        paneId="pane-1"
      />
    )

    const button = screen.getByRole('button', { name: 'Exit fullscreen' })
    expect(button).toBeTruthy()
  })

  it('renders close pane button that calls closePane', () => {
    const actions = mockActions()
    render(
      <TerminalOverlayToolbar
        actions={actions}
        isFullscreen={false}
        paneId="pane-1"
      />
    )

    const button = screen.getByRole('button', { name: 'Close pane' })
    fireEvent.click(button)

    expect(actions.closePane).toHaveBeenCalledWith('pane-1')
  })

  it('does not call actions when actions is null', () => {
    render(
      <TerminalOverlayToolbar
        actions={null}
        isFullscreen={false}
        paneId="pane-1"
      />
    )

    // Buttons should render but not throw when clicked with null actions
    const buttons = screen.getAllByRole('button')
    expect(buttons.length).toBe(4)

    for (const button of buttons) {
      fireEvent.click(button)
    }
    // No errors thrown — test passes
  })
})
