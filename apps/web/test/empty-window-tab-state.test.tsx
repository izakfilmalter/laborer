/**
 * Tests for the EmptyWindowTabState component — the empty state shown
 * when a window tab has no workspaces.
 *
 * Shows a workspace picker listing available (non-destroyed, not-yet-open)
 * workspaces grouped by project. Selecting a workspace adds it to the
 * current window tab.
 *
 * @see apps/web/src/routes/-components/workspace-frames.tsx
 * @see docs/tabbed-window-layout/issues.md — Issue #18
 */

import type { WindowLayout } from '@laborer/shared/types'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PanelActions } from '@/panels/panel-context'

// ---------------------------------------------------------------------------
// Constants — regex patterns at top-level scope
// ---------------------------------------------------------------------------

const ALL_WORKSPACES_OPEN_REGEX = /All workspaces are already open/
const SELECT_WORKSPACE_REGEX = /Select a workspace to add to this tab/

// ---------------------------------------------------------------------------
// Mocks — must be before component imports
// ---------------------------------------------------------------------------

const addWorkspaceToCurrentTabMock = vi.fn()

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
  addWorkspaceToCurrentTab: addWorkspaceToCurrentTabMock,
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

// Mock LiveStore — provides workspace and project data
interface MockWorkspace {
  branchName: string
  id: string
  projectId: string
  status: string
}

interface MockProject {
  id: string
  name: string
}

// Query results array: [workspaces, projects] set per test
const queryResults: unknown[][] = []
let queryCallIndex = 0

vi.mock('@livestore/livestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@livestore/livestore')>()
  return {
    ...actual,
    queryDb: vi.fn(() => ({})),
  }
})

vi.mock('@/livestore/store', () => ({
  useLaborerStore: () => ({
    useQuery: () => {
      const result = queryResults[queryCallIndex] ?? []
      queryCallIndex += 1
      return result
    },
  }),
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

// Mock PanelManager, DiffPane, ReviewPane, resizable, and header
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
// Import component under test AFTER mocks
// ---------------------------------------------------------------------------

import { EmptyWindowTabState } from '../src/routes/-components/workspace-frames'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupQueryResults(
  workspaceData: MockWorkspace[],
  projectData: MockProject[]
) {
  // The component calls useQuery twice: first for workspaces, then for projects
  queryResults.length = 0
  queryResults.push(workspaceData, projectData)
  queryCallIndex = 0
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  // Reset windowLayout via Object.defineProperty since it's readonly
  Object.defineProperty(mockActions, 'windowLayout', {
    value: undefined,
    writable: true,
    configurable: true,
  })
  queryResults.length = 0
  queryCallIndex = 0
})

// ---------------------------------------------------------------------------
// Tests: EmptyWindowTabState
// ---------------------------------------------------------------------------

describe('EmptyWindowTabState', () => {
  it('renders the empty state container', () => {
    setupQueryResults([], [])
    render(<EmptyWindowTabState />)
    const el = screen.getByTestId('empty-window-tab-state')
    expect(el).toBeDefined()
  })

  it('displays "Empty tab" title', () => {
    setupQueryResults([], [])
    render(<EmptyWindowTabState />)
    expect(screen.getByText('Empty tab')).toBeDefined()
  })

  it('shows description text about selecting a workspace', () => {
    setupQueryResults([], [])
    render(<EmptyWindowTabState />)
    expect(screen.getByText(SELECT_WORKSPACE_REGEX)).toBeDefined()
  })

  it('shows "all workspaces open" message when no workspaces are available', () => {
    setupQueryResults([], [])
    render(<EmptyWindowTabState />)
    expect(screen.getByText(ALL_WORKSPACES_OPEN_REGEX)).toBeDefined()
  })

  it('shows available workspaces grouped by project', () => {
    setupQueryResults(
      [
        {
          id: 'ws-1',
          projectId: 'proj-1',
          branchName: 'feature/login',
          status: 'running',
        },
        {
          id: 'ws-2',
          projectId: 'proj-1',
          branchName: 'fix/auth-bug',
          status: 'running',
        },
        {
          id: 'ws-3',
          projectId: 'proj-2',
          branchName: 'main',
          status: 'running',
        },
      ],
      [
        { id: 'proj-1', name: 'Frontend App' },
        { id: 'proj-2', name: 'Backend API' },
      ]
    )
    render(<EmptyWindowTabState />)
    expect(screen.getByText('Frontend App')).toBeDefined()
    expect(screen.getByText('Backend API')).toBeDefined()
    expect(screen.getByText('feature/login')).toBeDefined()
    expect(screen.getByText('fix/auth-bug')).toBeDefined()
    expect(screen.getByText('main')).toBeDefined()
  })

  it('excludes destroyed workspaces from the picker', () => {
    setupQueryResults(
      [
        {
          id: 'ws-1',
          projectId: 'proj-1',
          branchName: 'active-branch',
          status: 'running',
        },
        {
          id: 'ws-2',
          projectId: 'proj-1',
          branchName: 'destroyed-branch',
          status: 'destroyed',
        },
      ],
      [{ id: 'proj-1', name: 'MyProject' }]
    )
    render(<EmptyWindowTabState />)
    expect(screen.getByText('active-branch')).toBeDefined()
    expect(screen.queryByText('destroyed-branch')).toBeNull()
  })

  it('excludes workspaces already open in other tabs', () => {
    // Set up a windowLayout where ws-1 is already open
    const layoutWithWs1: WindowLayout = {
      tabs: [
        {
          id: 'tab-1',
          workspaceLayout: {
            _tag: 'WorkspaceTileLeaf',
            id: 'tile-1',
            workspaceId: 'ws-1',
            panelTabs: [],
          },
        },
      ],
      activeTabId: 'tab-1',
    }
    Object.defineProperty(mockActions, 'windowLayout', {
      value: layoutWithWs1,
      writable: true,
      configurable: true,
    })

    setupQueryResults(
      [
        {
          id: 'ws-1',
          projectId: 'proj-1',
          branchName: 'already-open',
          status: 'running',
        },
        {
          id: 'ws-2',
          projectId: 'proj-1',
          branchName: 'available',
          status: 'running',
        },
      ],
      [{ id: 'proj-1', name: 'MyProject' }]
    )
    render(<EmptyWindowTabState />)
    expect(screen.queryByText('already-open')).toBeNull()
    expect(screen.getByText('available')).toBeDefined()
  })

  it('calls addWorkspaceToCurrentTab when a workspace is clicked', () => {
    setupQueryResults(
      [
        {
          id: 'ws-1',
          projectId: 'proj-1',
          branchName: 'feature/login',
          status: 'running',
        },
      ],
      [{ id: 'proj-1', name: 'MyProject' }]
    )
    render(<EmptyWindowTabState />)
    fireEvent.click(screen.getByText('feature/login'))
    expect(addWorkspaceToCurrentTabMock).toHaveBeenCalledWith('ws-1')
  })

  it('uses the Empty component library', () => {
    setupQueryResults([], [])
    render(<EmptyWindowTabState />)
    const container = screen.getByTestId('empty-window-tab-state')
    expect(container.querySelector('[data-slot="empty"]')).toBeDefined()
    expect(container.querySelector('[data-slot="empty-icon"]')).toBeDefined()
    expect(container.querySelector('[data-slot="empty-title"]')).toBeDefined()
    expect(
      container.querySelector('[data-slot="empty-description"]')
    ).toBeDefined()
  })

  it('falls back to project ID when project name is not found', () => {
    setupQueryResults(
      [
        {
          id: 'ws-1',
          projectId: 'unknown-proj',
          branchName: 'branch-1',
          status: 'running',
        },
      ],
      [] // no projects in DB
    )
    render(<EmptyWindowTabState />)
    expect(screen.getByText('unknown-proj')).toBeDefined()
    expect(screen.getByText('branch-1')).toBeDefined()
  })

  it('shows all workspaces open message when all are in tabs', () => {
    const layoutWithAll: WindowLayout = {
      tabs: [
        {
          id: 'tab-1',
          workspaceLayout: {
            _tag: 'WorkspaceTileSplit',
            id: 'split-1',
            direction: 'horizontal',
            children: [
              {
                _tag: 'WorkspaceTileLeaf',
                id: 'tile-1',
                workspaceId: 'ws-1',
                panelTabs: [],
              },
              {
                _tag: 'WorkspaceTileLeaf',
                id: 'tile-2',
                workspaceId: 'ws-2',
                panelTabs: [],
              },
            ],
            sizes: [50, 50],
          },
        },
      ],
      activeTabId: 'tab-1',
    }
    Object.defineProperty(mockActions, 'windowLayout', {
      value: layoutWithAll,
      writable: true,
      configurable: true,
    })

    setupQueryResults(
      [
        {
          id: 'ws-1',
          projectId: 'proj-1',
          branchName: 'branch-1',
          status: 'running',
        },
        {
          id: 'ws-2',
          projectId: 'proj-1',
          branchName: 'branch-2',
          status: 'running',
        },
      ],
      [{ id: 'proj-1', name: 'MyProject' }]
    )
    render(<EmptyWindowTabState />)
    expect(screen.getByText(ALL_WORKSPACES_OPEN_REGEX)).toBeDefined()
  })

  it('shows workspaces in all non-destroyed statuses', () => {
    setupQueryResults(
      [
        {
          id: 'ws-1',
          projectId: 'proj-1',
          branchName: 'running-ws',
          status: 'running',
        },
        {
          id: 'ws-2',
          projectId: 'proj-1',
          branchName: 'creating-ws',
          status: 'creating',
        },
        {
          id: 'ws-3',
          projectId: 'proj-1',
          branchName: 'paused-ws',
          status: 'paused',
        },
      ],
      [{ id: 'proj-1', name: 'MyProject' }]
    )
    render(<EmptyWindowTabState />)
    expect(screen.getByText('running-ws')).toBeDefined()
    expect(screen.getByText('creating-ws')).toBeDefined()
    expect(screen.getByText('paused-ws')).toBeDefined()
  })
})
