import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PanelActions } from '@/panels/panel-context'
import { WorkspaceFrames } from '../src/routes/-components/workspace-frames'

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
    splitPane: vi.fn(),
    toggleDevServerPane: vi.fn(async () => false),
    toggleDiffPane: vi.fn(() => false),
    toggleFullscreenPane: vi.fn(),
    toggleReviewPane: vi.fn(() => false),
    addWindowTab: vi.fn(),
    closeWindowTab: vi.fn(),
    switchWindowTab: vi.fn(),
    switchWindowTabByIndex: vi.fn(),
    switchWindowTabRelative: vi.fn(),
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

const layout = {
  _tag: 'SplitNode' as const,
  children: [
    {
      _tag: 'LeafNode' as const,
      id: 'pane-1',
      paneType: 'terminal' as const,
      terminalId: 'term-1',
      workspaceId: 'ws-1',
    },
    {
      _tag: 'LeafNode' as const,
      id: 'pane-2',
      paneType: 'terminal' as const,
      terminalId: 'term-2',
      workspaceId: 'ws-2',
    },
  ],
  direction: 'vertical' as const,
  id: 'root',
  sizes: [50, 50],
}

const MINIMIZE_WS_1_RE = /minimize ws-1/i
const EXPAND_WS_1_RE = /expand ws-1/i

describe('WorkspaceFrames minimize behavior', () => {
  beforeEach(() => {
    panelApis.length = 0
  })

  afterEach(() => {
    cleanup()
  })

  it('renders workspace panels as collapsible when multiple workspaces are stacked', () => {
    render(
      <WorkspaceFrames
        activePaneId="pane-1"
        layout={layout}
        workspaceOrder={null}
      />
    )

    const panels = screen.getAllByTestId('resizable-panel')
    expect(panels).toHaveLength(2)
    expect(panels[0]?.getAttribute('data-collapsible')).toBe('true')
    expect(panels[1]?.getAttribute('data-collapsible')).toBe('true')
  })

  it('collapses and re-expands the workspace panel when minimize is toggled', () => {
    render(
      <WorkspaceFrames
        activePaneId="pane-1"
        layout={layout}
        workspaceOrder={null}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: MINIMIZE_WS_1_RE }))
    expect(panelApis[0]?.collapse).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { name: EXPAND_WS_1_RE }))
    expect(panelApis[0]?.expand).toHaveBeenCalledOnce()
  })
})
