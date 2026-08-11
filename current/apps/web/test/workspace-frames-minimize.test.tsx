/**
 * Behavioral tests for workspace minimize handling in WorkspaceFrames.
 *
 * Uses the stateful fake in helpers/fake-resizable.tsx which emulates the
 * react-resizable-panels v4 behaviors that caused the original bugs:
 * layout resets when the panel set changes, and neighbor-pivot collapse.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PanelActions } from '@/panels/panel-context'
import { COLLAPSED_PCT } from './helpers/fake-resizable'

vi.mock('@atlaskit/pragmatic-drag-and-drop/element/adapter', () => ({
  draggable: () => () => undefined,
  dropTargetForElements: () => () => undefined,
  monitorForElements: () => () => undefined,
}))

vi.mock('@atlaskit/pragmatic-drag-and-drop/combine', () => ({
  combine:
    (...cleanups: Array<() => void>) =>
    () => {
      for (const cleanupFn of cleanups) {
        cleanupFn()
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
    updatePaneType: vi.fn(),
    toggleDevServerPane: vi.fn(async () => false),
    toggleDiffPane: vi.fn(() => false),
    toggleFullscreenPane: vi.fn(),
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
    usePendingClosePanelTab: () => ({
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
      tabId: null,
      workspaceId: null,
    }),
    usePendingCloseWorkspace: () => ({
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
      workspaceId: null,
    }),
    usePendingDestroyOnCloseWorkspace: () => ({
      onCancel: vi.fn(),
      onCloseAndDestroy: vi.fn(),
      onConfirm: vi.fn(),
      workspaceId: null,
    }),
  }
})

vi.mock('@/components/ui/resizable', async () => {
  const fake = await import('./helpers/fake-resizable')
  return {
    ResizableHandle: fake.ResizableHandle,
    ResizablePanel: fake.ResizablePanel,
    ResizablePanelGroup: fake.ResizablePanelGroup,
  }
})

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

import type {
  WorkspaceTileLeaf,
  WorkspaceTileNode,
} from '@laborer/shared/types'
// Import after mocks are set up
import { WorkspaceFrames } from '../src/routes/-components/workspace-frames'

/** Build a workspace tile leaf with a single terminal panel tab. */
function makeLeaf(index: number): WorkspaceTileLeaf {
  return {
    _tag: 'WorkspaceTileLeaf',
    id: `tile-leaf-${index}`,
    workspaceId: `ws-${index}`,
    activePanelTabId: `tab-${index}`,
    panelTabs: [
      {
        id: `tab-${index}`,
        panelLayout: {
          _tag: 'LeafNode',
          id: `pane-${index}`,
          paneType: 'terminal',
          terminalId: `term-${index}`,
          workspaceId: `ws-${index}`,
        },
      },
    ],
  }
}

/** Vertical split of workspace leaves with the given sizes. */
function makeSplit(sizes: readonly number[]): WorkspaceTileNode {
  return {
    _tag: 'WorkspaceTileSplit',
    id: 'tile-root',
    direction: 'vertical',
    children: sizes.map((_, i) => makeLeaf(i + 1)),
    sizes: [...sizes],
  }
}

/** Read the rendered percentage size of the workspace panel at an index. */
function panelSize(index: number): number {
  const panels = screen.getAllByTestId('resizable-panel')
  const el = panels[index]
  if (!el) {
    throw new Error(`No panel found at index ${index}`)
  }
  return Number.parseFloat(el.getAttribute('data-size') ?? '')
}

const MINIMIZE_WS_1_RE = /minimize ws-1/i
const EXPAND_WS_1_RE = /expand ws-1/i

describe('WorkspaceFrames minimize behavior', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders workspace panels as collapsible when multiple workspaces are stacked', () => {
    render(
      <WorkspaceFrames
        activePaneId="pane-1"
        workspaceTileLayout={makeSplit([50, 50])}
      />
    )

    const panels = screen.getAllByTestId('resizable-panel')
    expect(panels).toHaveLength(2)
    expect(panels[0]?.getAttribute('data-collapsible')).toBe('true')
    expect(panels[1]?.getAttribute('data-collapsible')).toBe('true')
  })

  it('collapses the workspace panel to the collapsed size when minimize is clicked', () => {
    render(
      <WorkspaceFrames
        activePaneId="pane-1"
        workspaceTileLayout={makeSplit([50, 50])}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: MINIMIZE_WS_1_RE }))

    expect(panelSize(0)).toBeCloseTo(COLLAPSED_PCT, 1)
  })

  it('restores the workspace panel size when expand is clicked after minimizing', () => {
    render(
      <WorkspaceFrames
        activePaneId="pane-1"
        workspaceTileLayout={makeSplit([50, 50])}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: MINIMIZE_WS_1_RE }))
    fireEvent.click(screen.getByRole('button', { name: EXPAND_WS_1_RE }))

    expect(panelSize(0)).toBeCloseTo(50, 1)
    expect(panelSize(1)).toBeCloseTo(50, 1)
  })

  it('hides panel content when minimized', () => {
    render(
      <WorkspaceFrames
        activePaneId="pane-1"
        workspaceTileLayout={makeSplit([50, 50])}
      />
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
      <WorkspaceFrames
        activePaneId="pane-1"
        workspaceTileLayout={makeSplit([50, 50])}
      />
    )

    const managersBefore = screen.getAllByTestId('panel-manager')

    fireEvent.click(screen.getByRole('button', { name: MINIMIZE_WS_1_RE }))
    fireEvent.click(screen.getByRole('button', { name: EXPAND_WS_1_RE }))

    const managersAfter = screen.getAllByTestId('panel-manager')
    expect(managersAfter).toHaveLength(managersBefore.length)
  })

  it('keeps a minimized workspace collapsed when a new workspace is added', () => {
    const { rerender } = render(
      <WorkspaceFrames
        activePaneId="pane-1"
        workspaceTileLayout={makeSplit([50, 50])}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: MINIMIZE_WS_1_RE }))
    expect(panelSize(0)).toBeCloseTo(COLLAPSED_PCT, 1)

    // Adding a workspace changes the resizable group's panel set, which
    // makes the library rebuild the layout from default sizes. The
    // minimized workspace must stay collapsed instead of silently
    // re-occupying space while its content is still hidden.
    rerender(
      <WorkspaceFrames
        activePaneId="pane-1"
        workspaceTileLayout={makeSplit([33, 33, 34])}
      />
    )

    expect(panelSize(0)).toBeCloseTo(COLLAPSED_PCT, 1)
    // The freed space is shared by the expanded workspaces proportionally
    // to their default sizes (33:34).
    const remaining = 100 - COLLAPSED_PCT
    expect(panelSize(1)).toBeCloseTo((33 / 67) * remaining, 0)
    expect(panelSize(2)).toBeCloseTo((34 / 67) * remaining, 0)
    // ws-1 content stays hidden (header-only).
    expect(screen.getAllByTestId('panel-manager')).toHaveLength(2)
  })

  it('distributes freed space across all expanded workspaces when minimizing', () => {
    render(
      <WorkspaceFrames
        activePaneId="pane-1"
        workspaceTileLayout={makeSplit([40, 35, 25])}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: MINIMIZE_WS_1_RE }))

    // ws-1 collapses; its freed space (40 - collapsed) is split between
    // ws-2 and ws-3 proportionally to their sizes (35:25), not handed
    // entirely to the adjacent workspace.
    const remaining = 100 - COLLAPSED_PCT
    expect(panelSize(0)).toBeCloseTo(COLLAPSED_PCT, 1)
    expect(panelSize(1)).toBeCloseTo((35 / 60) * remaining, 0)
    expect(panelSize(2)).toBeCloseTo((25 / 60) * remaining, 0)
  })
})
