/**
 * Behavioral tests for the agent attention outline drawn around a whole
 * workspace frame.
 *
 * The point of the outline is reach: a finished agent has to be findable
 * from across a tiled screen, so the cue wraps the workspace and every
 * terminal in it rather than tinting the 8px header above them. These tests
 * pin that scope — the outline contains the header and the panes — plus the
 * states that earn one, and the fact that it never eats a click meant for
 * the terminal underneath.
 *
 * @see apps/web/src/routes/-components/workspace-frames.tsx
 * @see apps/web/src/lib/agent-status-presentation.ts
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusSnapshot } from '@/hooks/use-terminal-list'
import type { PanelActions } from '@/panels/panel-context'

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

vi.mock('@/panels/panel-manager', () => ({
  PanelManager: () => <div data-testid="panel-manager" />,
}))

vi.mock('@/panes/diff-pane', () => ({
  DiffPane: () => <div data-testid="diff-pane" />,
}))

vi.mock('@/panes/tree-pane', () => ({
  TreePane: () => <div data-testid="tree-pane" />,
}))

vi.mock('@/panels/panel-context', () => {
  const actions = {
    closeWorkspace: vi.fn(),
    reorderWorkspaces: vi.fn(),
    setActivePaneId: vi.fn(),
  } as unknown as PanelActions
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

vi.mock('@laborer/ui/components/resizable', () => ({
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

const terminals: Array<{
  readonly agentStatus: AgentStatusSnapshot | null
  readonly workspaceId: string | undefined
}> = []

vi.mock('@/hooks/use-terminal-list', () => ({
  useTerminalList: () => ({ terminals }),
}))

import type { WorkspaceTileNode } from '@laborer/shared/types'
import { WorkspaceFrames } from '../src/routes/-components/workspace-frames'

const OUTLINE = 'workspace-frame-attention-outline'

const snapshot = (
  overrides: Partial<AgentStatusSnapshot> = {}
): AgentStatusSnapshot => ({
  status: 'idle',
  source: 'ps',
  changedAt: 0,
  stale: false,
  seen: false,
  ...overrides,
})

/** Point the mocked terminal list at one agent in `ws-1`. */
function setWorkspaceAgent(agentStatus: AgentStatusSnapshot | null): void {
  terminals.length = 0
  terminals.push({ agentStatus, workspaceId: 'ws-1' })
}

const singleLeafLayout: WorkspaceTileNode = {
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
}

function renderFrames() {
  return render(
    <WorkspaceFrames
      activePaneId="pane-1"
      workspaceTileLayout={singleLeafLayout}
    />
  )
}

describe('workspace frame attention outline', () => {
  afterEach(() => {
    terminals.length = 0
    cleanup()
  })

  it('wraps the workspace and its terminals when an agent finished unseen', () => {
    setWorkspaceAgent(snapshot())
    renderFrames()

    const outline = screen.getByTestId(OUTLINE)
    const frame = screen.getByTestId('workspace-frame')

    // The outline belongs to the frame — the header and the panes are both
    // inside it, which is the whole reason it is not a header treatment.
    expect(outline.parentElement).toBe(frame)
    expect(frame.contains(screen.getByTestId('workspace-header'))).toBe(true)
    expect(frame.contains(screen.getByTestId('panel-manager'))).toBe(true)
    expect(outline.getAttribute('data-agent-status')).toBe('done')
  })

  it('never intercepts a click meant for the terminal underneath', () => {
    setWorkspaceAgent(snapshot())
    renderFrames()

    const outline = screen.getByTestId(OUTLINE)

    expect(outline.className).toContain('pointer-events-none')
    expect(outline.getAttribute('aria-hidden')).toBe('true')
  })

  it('outlines a blocked agent louder than a finished one', () => {
    setWorkspaceAgent(snapshot())
    const { unmount } = renderFrames()
    const doneClassName = screen.getByTestId(OUTLINE).className
    unmount()

    setWorkspaceAgent(snapshot({ status: 'needs_input', seen: true }))
    renderFrames()
    const needsInputClassName = screen.getByTestId(OUTLINE).className

    expect(doneClassName).toContain('violet')
    expect(needsInputClassName).toContain('amber')
    expect(needsInputClassName).not.toBe(doneClassName)
  })

  it('stays quiet while an agent is simply working', () => {
    setWorkspaceAgent(snapshot({ status: 'working', seen: true }))
    renderFrames()

    expect(screen.queryByTestId(OUTLINE)).toBeNull()
  })

  it('stays quiet once a finished result has been seen', () => {
    setWorkspaceAgent(snapshot({ seen: true }))
    renderFrames()

    expect(screen.queryByTestId(OUTLINE)).toBeNull()
  })

  it('stays quiet when the workspace has no agent at all', () => {
    setWorkspaceAgent(null)
    renderFrames()

    expect(screen.queryByTestId(OUTLINE)).toBeNull()
  })
})
