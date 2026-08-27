import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const {
  activePaneIdMock,
  headerPropsMock,
  mutationMap,
  projectRowsMock,
  refreshPrMock,
  viewerLoginMock,
  workspaceRowsMock,
} = vi.hoisted(() => ({
  activePaneIdMock: vi.fn(),
  viewerLoginMock: vi.fn<() => string | null>(() => null),
  headerPropsMock: vi.fn(),
  refreshPrMock: vi.fn().mockResolvedValue(undefined),
  mutationMap: new Map<unknown, ReturnType<typeof vi.fn>>(),
  projectRowsMock: vi.fn(),
  workspaceRowsMock: vi.fn(() => []),
}))

vi.mock('@effect/atom-react/Hooks', () => ({
  useAtomSet: (atom: unknown) => mutationMap.get(atom) ?? vi.fn(),
}))

vi.mock('@tanstack/react-db', () => ({
  useLiveQuery: (
    buildQuery: (query: {
      from: (collections: Record<string, unknown>) => unknown
    }) => unknown
  ) =>
    buildQuery({
      from: (collections) => ({
        data: 'projects' in collections ? projectRowsMock() : [],
      }),
    }),
}))

vi.mock('@/db/shared-state', () => ({
  projectCollection: Symbol('projects'),
  taskCollection: Symbol('tasks'),
  workspaceViewsFromRows: () => workspaceRowsMock(),
}))

vi.mock('@/hooks/use-current-github-login', () => ({
  useCurrentGithubLogin: () => viewerLoginMock(),
}))

vi.mock('@/hooks/use-project-short-name', () => ({
  useProjectShortName: () => 'LAB',
}))

vi.mock('@/atoms/laborer-client', () => ({
  LaborerClient: {
    mutation: (name: string) => {
      const sentinel = Symbol.for(`mutation:${name}`)
      if (name === 'workspace.refreshPr') {
        mutationMap.set(sentinel, refreshPrMock)
      }
      return sentinel
    },
  },
}))

vi.mock('@/hooks/use-terminal-list', () => ({
  useTerminalList: () => ({ terminals: [] }),
}))

vi.mock('@/lib/workspace-agent-status', () => ({
  deriveWorkspaceAgentStatus: () => null,
}))

vi.mock('@/panels/window-layout-utils', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return {
    ...original,
    getScopedActivePaneId: (_subLayout: unknown, activePaneId: string | null) =>
      activePaneId,
  }
})

vi.mock('@/panels/panel-context', () => ({
  useActivePaneId: () => activePaneIdMock(),
  usePanelActions: () => null,
}))

vi.mock('@/components/workspace-frame-header', () => ({
  WorkspaceFrameHeader: (props: unknown) => {
    headerPropsMock(props)
    return <div data-testid="workspace-frame-header" />
  },
}))

import { WorkspaceFrameHeaderContainer } from '../src/routes/-components/workspace-frame-header-container'

const subLayout = {
  _tag: 'LeafNode' as const,
  id: 'pane-1',
  paneType: 'terminal' as const,
  terminalId: 'term-1',
  workspaceId: 'ws-1',
}

describe('WorkspaceFrameHeaderContainer', () => {
  afterEach(() => {
    cleanup()
    refreshPrMock.mockClear()
    activePaneIdMock.mockReset()
    projectRowsMock.mockReset()
    workspaceRowsMock.mockReset()
    workspaceRowsMock.mockReturnValue([])
    viewerLoginMock.mockReturnValue(null)
    headerPropsMock.mockClear()
  })

  it("names another author's login in the header, and never the viewer's own", () => {
    activePaneIdMock.mockReturnValue('pane-1')
    projectRowsMock.mockReturnValue([{ id: 'project-1', name: 'Demo' }])
    viewerLoginMock.mockReturnValue('izakfilmalter')
    workspaceRowsMock.mockReturnValue([
      {
        branchName: 'claude/errors-view',
        id: 'ws-root',
        parentTaskId: null,
        prAuthorLogin: 'octocat',
        projectId: 'project-1',
        status: 'ready',
        taskNumber: 7,
      },
      {
        branchName: 'fixup/nit',
        id: 'ws-1',
        parentTaskId: 'ws-root',
        prAuthorLogin: 'izakfilmalter',
        projectId: 'project-1',
        status: 'ready',
        taskNumber: 8,
      },
    ])

    const view = render(
      <WorkspaceFrameHeaderContainer
        isActiveFrame
        isMinimized={false}
        onHeaderClick={() => undefined}
        onMinimize={() => undefined}
        subLayout={subLayout}
        workspaceId="ws-1"
      />
    )

    // A sub-workspace is attributed to the branch it patches, not to itself.
    expect(headerPropsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ authorLogin: 'octocat' })
    )

    headerPropsMock.mockClear()
    viewerLoginMock.mockReturnValue('octocat')
    view.rerender(
      <WorkspaceFrameHeaderContainer
        isActiveFrame
        isMinimized={false}
        onHeaderClick={() => undefined}
        onMinimize={() => undefined}
        subLayout={subLayout}
        workspaceId="ws-1"
      />
    )

    expect(headerPropsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ authorLogin: null })
    )
  })

  it('refreshes PR status when a pane in the workspace becomes focused', async () => {
    activePaneIdMock.mockReturnValue('pane-1')
    projectRowsMock.mockReturnValue([{ id: 'project-1', name: 'Demo' }])

    render(
      <WorkspaceFrameHeaderContainer
        isActiveFrame
        isMinimized={false}
        onHeaderClick={() => undefined}
        onMinimize={() => undefined}
        subLayout={subLayout}
        workspaceId="ws-1"
      />
    )

    await waitFor(() => {
      expect(refreshPrMock).toHaveBeenCalledWith({
        payload: { workspaceId: 'ws-1' },
      })
    })
  })

  it('does not refresh PR status when no pane in the workspace is focused', () => {
    activePaneIdMock.mockReturnValue(null)
    projectRowsMock.mockReturnValue([])

    render(
      <WorkspaceFrameHeaderContainer
        isActiveFrame={false}
        isMinimized={false}
        onHeaderClick={() => undefined}
        onMinimize={() => undefined}
        subLayout={subLayout}
        workspaceId="ws-1"
      />
    )

    expect(refreshPrMock).not.toHaveBeenCalled()
  })

  it('forwards the task identifier data to the workspace header', () => {
    activePaneIdMock.mockReturnValue('pane-1')
    projectRowsMock.mockReturnValue([{ id: 'project-1', name: 'Demo' }])
    workspaceRowsMock.mockReturnValue([
      {
        branchName: 'feature/ticket-header',
        id: 'ws-1',
        parentTaskId: null,
        projectId: 'project-1',
        status: 'ready',
        taskNumber: 7,
      },
    ])

    render(
      <WorkspaceFrameHeaderContainer
        isActiveFrame
        isMinimized={false}
        onHeaderClick={() => undefined}
        onMinimize={() => undefined}
        subLayout={subLayout}
        workspaceId="ws-1"
      />
    )

    expect(headerPropsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        projectShortName: 'LAB',
        taskNumber: 7,
      })
    )
  })

  it('forwards the pull request check rollup and merge status to the header', () => {
    activePaneIdMock.mockReturnValue('pane-1')
    projectRowsMock.mockReturnValue([{ id: 'project-1', name: 'Demo' }])
    const prChecks = [
      {
        bucket: 'failure',
        durationMs: 179_000,
        group: 'Merge Checks',
        name: 'Unit Tests',
        url: null,
      },
    ]
    workspaceRowsMock.mockReturnValue([
      {
        branchName: 'feature/ticket-header',
        id: 'ws-1',
        parentTaskId: null,
        prBaseBranch: 'dev',
        prCheckStatus: 'failure',
        prChecks,
        prMergeStatus: 'conflicting',
        prNumber: 42,
        prState: 'OPEN',
        prTitle: 'Ship the fix',
        prUrl: 'https://github.com/example/repo/pull/42',
        projectId: 'project-1',
        status: 'ready',
        taskNumber: 7,
      },
    ])

    render(
      <WorkspaceFrameHeaderContainer
        isActiveFrame
        isMinimized={false}
        onHeaderClick={() => undefined}
        onMinimize={() => undefined}
        subLayout={subLayout}
        workspaceId="ws-1"
      />
    )

    expect(headerPropsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        prBaseBranch: 'dev',
        prCheckStatus: 'failure',
        prChecks,
        prMergeStatus: 'conflicting',
        prNumber: 42,
      })
    )
  })
})
