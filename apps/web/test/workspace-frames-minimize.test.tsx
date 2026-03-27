import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PanelActions } from '@/panels/panel-context'

const { panelApis } = vi.hoisted(() => ({
  panelApis: [] as {
    collapse: ReturnType<typeof vi.fn>
    expand: ReturnType<typeof vi.fn>
    isCollapsed: ReturnType<typeof vi.fn>
  }[],
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
      for (const cleanup of cleanups) {
        cleanup()
      }
    },
}))

vi.mock('@atlaskit/pragmatic-drag-and-drop/reorder', () => ({
  reorder: vi.fn(),
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

vi.mock('@/panels/panel-context', () => {
  const actions: PanelActions = {
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
    toggleTreePane: vi.fn(() => false),
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
  return {
    usePanelActions: () => actions,
  }
})

vi.mock('@/components/ui/resizable', () => ({
  ResizableHandle: () => <div data-testid="resize-handle" />,
  ResizablePanel: ({
    children,
    collapsible,
    collapsedSize,
    ...props
  }: {
    children: React.ReactNode
    collapsible?: boolean
    collapsedSize?: string
    panelRef?: {
      current: {
        collapse: () => void
        expand: () => void
        isCollapsed: () => boolean
      } | null
    }
  }) => {
    const refObject = props.panelRef
    if (refObject && !refObject.current) {
      let isCollapsed = false
      const panelApi = {
        collapse: vi.fn(() => {
          isCollapsed = true
        }),
        expand: vi.fn(() => {
          isCollapsed = false
        }),
        isCollapsed: vi.fn(() => isCollapsed),
      }
      refObject.current = panelApi
      panelApis.push(panelApi)
    }
    return (
      <div
        data-collapsed-size={collapsedSize ?? ''}
        data-collapsible={collapsible ? 'true' : 'false'}
        data-testid="resizable-panel"
      >
        {children}
      </div>
    )
  },
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="resizable-panel-group">{children}</div>
  ),
}))

vi.mock('../src/routes/-components/workspace-frame-header-container', () => ({
  WorkspaceFrameHeaderContainer: ({
    isMinimized,
    onMinimize,
    workspaceId,
  }: {
    isMinimized: boolean
    onMinimize: () => void
    workspaceId: string | undefined
  }) => (
    <button onClick={onMinimize} type="button">
      {isMinimized ? 'Expand' : 'Minimize'} {workspaceId}
    </button>
  ),
}))

import type { WorkspaceTileNode } from '@laborer/shared/types'
// Import after mocks are set up
import { WorkspaceFrames } from '../src/routes/-components/workspace-frames'

/** Tile layout with two workspace leaves in a vertical split. */
const tileLayout: WorkspaceTileNode = {
  _tag: 'WorkspaceTileSplit',
  id: 'tile-root',
  direction: 'vertical',
  children: [
    {
      _tag: 'WorkspaceTileLeaf',
      id: 'tile-leaf-1',
      workspaceId: 'ws-1',
      activePanelTabId: 'tab-1',
      panelTabs: [
        {
          id: 'tab-1',
          panelLayout: {
            _tag: 'LeafNode',
            id: 'pane-1',
            paneType: 'terminal',
            terminalId: 'term-1',
            workspaceId: 'ws-1',
          },
        },
      ],
    },
    {
      _tag: 'WorkspaceTileLeaf',
      id: 'tile-leaf-2',
      workspaceId: 'ws-2',
      activePanelTabId: 'tab-2',
      panelTabs: [
        {
          id: 'tab-2',
          panelLayout: {
            _tag: 'LeafNode',
            id: 'pane-2',
            paneType: 'terminal',
            terminalId: 'term-2',
            workspaceId: 'ws-2',
          },
        },
      ],
    },
  ],
  sizes: [50, 50],
}

const MINIMIZE_WS_1_RE = /minimize ws-1/i
const EXPAND_WS_1_RE = /expand ws-1/i

describe('WorkspaceFrames minimize behavior (legacy path)', () => {
  beforeEach(() => {
    panelApis.length = 0
  })

  afterEach(() => {
    cleanup()
  })

  it('renders workspace panels as collapsible when multiple workspaces are stacked', () => {
    render(
      <WorkspaceFrames activePaneId="pane-1" workspaceTileLayout={tileLayout} />
    )

    const panels = screen.getAllByTestId('resizable-panel')
    expect(panels).toHaveLength(2)
    expect(panels[0]?.getAttribute('data-collapsible')).toBe('true')
    expect(panels[1]?.getAttribute('data-collapsible')).toBe('true')
  })

  it('collapses and re-expands the workspace panel when minimize is toggled', () => {
    render(
      <WorkspaceFrames activePaneId="pane-1" workspaceTileLayout={tileLayout} />
    )

    fireEvent.click(screen.getByRole('button', { name: MINIMIZE_WS_1_RE }))
    expect(panelApis[0]?.collapse).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { name: EXPAND_WS_1_RE }))
    expect(panelApis[0]?.expand).toHaveBeenCalledOnce()
  })
})

describe('WorkspaceFrames minimize behavior (tile layout path)', () => {
  beforeEach(() => {
    panelApis.length = 0
  })

  afterEach(() => {
    cleanup()
  })

  it('renders tile leaf panels as collapsible', () => {
    render(
      <WorkspaceFrames activePaneId="pane-1" workspaceTileLayout={tileLayout} />
    )

    const panels = screen.getAllByTestId('resizable-panel')
    expect(panels).toHaveLength(2)
    expect(panels[0]?.getAttribute('data-collapsible')).toBe('true')
    expect(panels[1]?.getAttribute('data-collapsible')).toBe('true')
  })

  it('collapses the resizable panel when minimize is clicked', () => {
    render(
      <WorkspaceFrames activePaneId="pane-1" workspaceTileLayout={tileLayout} />
    )

    fireEvent.click(screen.getByRole('button', { name: MINIMIZE_WS_1_RE }))
    expect(panelApis[0]?.collapse).toHaveBeenCalledOnce()
  })

  it('expands the resizable panel when expand is clicked after minimizing', () => {
    render(
      <WorkspaceFrames activePaneId="pane-1" workspaceTileLayout={tileLayout} />
    )

    fireEvent.click(screen.getByRole('button', { name: MINIMIZE_WS_1_RE }))
    fireEvent.click(screen.getByRole('button', { name: EXPAND_WS_1_RE }))
    expect(panelApis[0]?.expand).toHaveBeenCalledOnce()
  })

  it('hides panel content when minimized', () => {
    render(
      <WorkspaceFrames activePaneId="pane-1" workspaceTileLayout={tileLayout} />
    )

    // Content is initially visible
    const managers = screen.getAllByTestId('panel-manager')
    expect(managers.length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: MINIMIZE_WS_1_RE }))

    // The workspace frame for ws-1 should no longer render its panel manager.
    // ws-2 should still have its panel manager visible.
    const managersAfter = screen.getAllByTestId('panel-manager')
    expect(managersAfter).toHaveLength(managers.length - 1)
  })

  it('shows panel content again when expanded after minimizing', () => {
    render(
      <WorkspaceFrames activePaneId="pane-1" workspaceTileLayout={tileLayout} />
    )

    const managersBefore = screen.getAllByTestId('panel-manager')

    fireEvent.click(screen.getByRole('button', { name: MINIMIZE_WS_1_RE }))
    fireEvent.click(screen.getByRole('button', { name: EXPAND_WS_1_RE }))

    const managersAfter = screen.getAllByTestId('panel-manager')
    expect(managersAfter).toHaveLength(managersBefore.length)
  })
})
