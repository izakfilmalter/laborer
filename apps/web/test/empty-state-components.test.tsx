/**
 * Tests for the empty state components used in the tabbed window layout:
 * - EmptyWorkspaceState: shown when all panel tabs in a workspace are closed
 * - EmptyPanelTabState: shown when all panes in a panel tab are closed
 *
 * Both components embed the PanelTypePicker inline and display keyboard
 * shortcut hints to guide the user.
 *
 * @see apps/web/src/routes/-components/workspace-frames.tsx
 * @see docs/tabbed-window-layout/issues.md — Issue #19
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PanelActions } from '@/panels/panel-context'

// ---------------------------------------------------------------------------
// Constants — regex patterns at top-level scope
// ---------------------------------------------------------------------------

const SELECT_PANEL_TYPE_REGEX = /Select a panel type to create a new tab/
const TAB_HAS_NO_PANELS_REGEX = /This tab has no panels/

// ---------------------------------------------------------------------------
// Mocks — must be before component imports
// ---------------------------------------------------------------------------

const mockActions: PanelActions = {
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
}

// Stub haptics
vi.mock('@/lib/haptics', () => ({
  haptics: { buttonTap: vi.fn(), heavyImpact: vi.fn() },
}))

vi.mock('@/panels/panel-context', () => ({
  usePanelActions: () => mockActions,
  useActiveWorkspaceId: () => null,
}))

// Stub drag-and-drop (required by workspace-frames.tsx imports)
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

// Mock LiveStore dependencies (needed because workspace-frames.tsx imports
// @laborer/shared/schema which uses State from @livestore/livestore)
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

// Mock PanelManager, DiffPane, ReviewPane, resizable, and header to avoid
// transitive LiveStore / xterm / heavyweight dependency imports
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

vi.mock('@/panes/review-pane', () => ({
  ReviewPane: ({ workspaceId }: { workspaceId: string }) => (
    <div data-testid="review-pane" data-workspace-id={workspaceId} />
  ),
}))

vi.mock('@/components/ui/resizable', () => ({
  ResizableHandle: () => <div data-testid="resize-handle" />,
  ResizablePanel: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="resizable-panel">{children}</div>
  ),
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="resizable-panel-group">{children}</div>
  ),
}))

vi.mock('../src/routes/-components/workspace-frame-header-container', () => ({
  WorkspaceFrameHeaderContainer: ({
    workspaceId,
  }: {
    workspaceId: string | undefined
  }) => <div data-testid="workspace-header">{workspaceId}</div>,
}))

// ---------------------------------------------------------------------------
// Import components under test AFTER mocks
// ---------------------------------------------------------------------------

import {
  EmptyPanelTabState,
  EmptyWorkspaceState,
} from '../src/routes/-components/workspace-frames'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getPickerOptions() {
  return screen.getAllByTestId('panel-type-picker-option')
}

function getOptionAt(index: number) {
  const options = getPickerOptions()
  const option = options[index]
  if (!option) {
    throw new Error(`No picker option at index ${index}`)
  }
  return option
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Tests: EmptyWorkspaceState
// ---------------------------------------------------------------------------

describe('EmptyWorkspaceState', () => {
  it('renders the empty state container', () => {
    render(<EmptyWorkspaceState workspaceId="ws-1" />)
    const el = screen.getByTestId('empty-workspace-state')
    expect(el).toBeDefined()
  })

  it('displays "No panel tabs" title', () => {
    render(<EmptyWorkspaceState workspaceId="ws-1" />)
    expect(screen.getByText('No panel tabs')).toBeDefined()
  })

  it('shows Ctrl+T keyboard shortcut hint', () => {
    render(<EmptyWorkspaceState workspaceId="ws-1" />)
    expect(screen.getByText('Ctrl+T')).toBeDefined()
  })

  it('embeds the PanelTypePicker with 4 options', () => {
    render(<EmptyWorkspaceState workspaceId="ws-1" />)
    expect(getPickerOptions()).toHaveLength(4)
  })

  it('calls addPanelTab when terminal is selected from the picker', () => {
    render(<EmptyWorkspaceState workspaceId="ws-1" />)
    fireEvent.click(getOptionAt(0))
    expect(mockActions.addPanelTab).toHaveBeenCalledWith('ws-1', 'terminal')
  })

  it('calls addPanelTab with diff when option 2 is clicked', () => {
    render(<EmptyWorkspaceState workspaceId="ws-1" />)
    fireEvent.click(getOptionAt(1))
    expect(mockActions.addPanelTab).toHaveBeenCalledWith('ws-1', 'diff')
  })

  it('calls addPanelTab with review when option 3 is clicked', () => {
    render(<EmptyWorkspaceState workspaceId="ws-1" />)
    fireEvent.click(getOptionAt(2))
    expect(mockActions.addPanelTab).toHaveBeenCalledWith('ws-1', 'review')
  })

  it('calls addPanelTab with devServerTerminal when option 4 is clicked', () => {
    render(<EmptyWorkspaceState workspaceId="ws-1" />)
    fireEvent.click(getOptionAt(3))
    expect(mockActions.addPanelTab).toHaveBeenCalledWith(
      'ws-1',
      'devServerTerminal'
    )
  })

  it('does not call addPanelTab when workspaceId is undefined', () => {
    render(<EmptyWorkspaceState workspaceId={undefined} />)
    fireEvent.click(getOptionAt(0))
    expect(mockActions.addPanelTab).not.toHaveBeenCalled()
  })

  it('supports keyboard selection via number keys', () => {
    render(<EmptyWorkspaceState workspaceId="ws-1" />)
    const picker = screen.getByTestId('panel-type-picker')
    fireEvent.keyDown(picker, { key: '2' })
    expect(mockActions.addPanelTab).toHaveBeenCalledWith('ws-1', 'diff')
  })

  it('supports keyboard selection via Enter key', () => {
    render(<EmptyWorkspaceState workspaceId="ws-1" />)
    const picker = screen.getByTestId('panel-type-picker')
    // Terminal is pre-selected, Enter confirms
    fireEvent.keyDown(picker, { key: 'Enter' })
    expect(mockActions.addPanelTab).toHaveBeenCalledWith('ws-1', 'terminal')
  })

  it('renders the description text', () => {
    render(<EmptyWorkspaceState workspaceId="ws-1" />)
    expect(screen.getByText(SELECT_PANEL_TYPE_REGEX)).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Tests: EmptyPanelTabState
// ---------------------------------------------------------------------------

describe('EmptyPanelTabState', () => {
  it('renders the empty state container', () => {
    render(<EmptyPanelTabState workspaceId="ws-1" />)
    const el = screen.getByTestId('empty-panel-tab-state')
    expect(el).toBeDefined()
  })

  it('displays "Empty tab" title', () => {
    render(<EmptyPanelTabState workspaceId="ws-1" />)
    expect(screen.getByText('Empty tab')).toBeDefined()
  })

  it('shows Cmd+D keyboard shortcut hint', () => {
    render(<EmptyPanelTabState workspaceId="ws-1" />)
    expect(screen.getByText('Cmd+D')).toBeDefined()
  })

  it('embeds the PanelTypePicker with 4 options', () => {
    render(<EmptyPanelTabState workspaceId="ws-1" />)
    expect(getPickerOptions()).toHaveLength(4)
  })

  it('calls addPanelTab when terminal is selected from the picker', () => {
    render(<EmptyPanelTabState workspaceId="ws-1" />)
    fireEvent.click(getOptionAt(0))
    expect(mockActions.addPanelTab).toHaveBeenCalledWith('ws-1', 'terminal')
  })

  it('calls addPanelTab with review when option 3 is clicked', () => {
    render(<EmptyPanelTabState workspaceId="ws-1" />)
    fireEvent.click(getOptionAt(2))
    expect(mockActions.addPanelTab).toHaveBeenCalledWith('ws-1', 'review')
  })

  it('does not call addPanelTab when workspaceId is undefined', () => {
    render(<EmptyPanelTabState workspaceId={undefined} />)
    fireEvent.click(getOptionAt(0))
    expect(mockActions.addPanelTab).not.toHaveBeenCalled()
  })

  it('renders the description text', () => {
    render(<EmptyPanelTabState workspaceId="ws-1" />)
    expect(screen.getByText(TAB_HAS_NO_PANELS_REGEX)).toBeDefined()
  })

  it('supports keyboard selection via number keys', () => {
    render(<EmptyPanelTabState workspaceId="ws-1" />)
    const picker = screen.getByTestId('panel-type-picker')
    fireEvent.keyDown(picker, { key: '3' })
    expect(mockActions.addPanelTab).toHaveBeenCalledWith('ws-1', 'review')
  })
})

// ---------------------------------------------------------------------------
// Tests: Visual consistency
// ---------------------------------------------------------------------------

describe('Visual consistency', () => {
  it('EmptyWorkspaceState uses the Empty component library', () => {
    render(<EmptyWorkspaceState workspaceId="ws-1" />)
    const container = screen.getByTestId('empty-workspace-state')
    expect(container.querySelector('[data-slot="empty"]')).toBeDefined()
    expect(container.querySelector('[data-slot="empty-icon"]')).toBeDefined()
    expect(container.querySelector('[data-slot="empty-title"]')).toBeDefined()
    expect(
      container.querySelector('[data-slot="empty-description"]')
    ).toBeDefined()
  })

  it('EmptyPanelTabState uses the Empty component library', () => {
    render(<EmptyPanelTabState workspaceId="ws-1" />)
    const container = screen.getByTestId('empty-panel-tab-state')
    expect(container.querySelector('[data-slot="empty"]')).toBeDefined()
    expect(container.querySelector('[data-slot="empty-icon"]')).toBeDefined()
    expect(container.querySelector('[data-slot="empty-title"]')).toBeDefined()
    expect(
      container.querySelector('[data-slot="empty-description"]')
    ).toBeDefined()
  })
})
