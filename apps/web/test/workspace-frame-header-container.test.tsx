import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { refreshPrMock, mutationMap, useLaborerStoreMock, activePaneIdMock } =
  vi.hoisted(() => ({
    refreshPrMock: vi.fn().mockResolvedValue(undefined),
    mutationMap: new Map<unknown, ReturnType<typeof vi.fn>>(),
    useLaborerStoreMock: vi.fn(),
    activePaneIdMock: vi.fn(),
  }))

vi.mock('@effect-atom/atom-react/Hooks', () => ({
  useAtomSet: (atom: unknown) => mutationMap.get(atom) ?? vi.fn(),
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

vi.mock('@livestore/livestore', () => ({
  queryDb: (_table: unknown, options: { label: string }) => options,
}))

vi.mock('@/livestore/store', () => ({
  useLaborerStore: useLaborerStoreMock,
}))

vi.mock('@laborer/shared/schema', () => ({
  projects: { name: 'projects' },
  workspaces: { name: 'workspaces' },
}))

vi.mock('@/hooks/use-terminal-list', () => ({
  useTerminalList: () => ({ terminals: [] }),
}))

vi.mock('@/lib/workspace-agent-status', () => ({
  deriveWorkspaceAgentStatus: () => null,
}))

vi.mock('@/panels/layout-utils', () => ({
  findNodeById: () => ({ _tag: 'LeafNode', diffOpen: false }),
  getLeafNodes: (node: { _tag: string; paneType?: string }) =>
    node._tag === 'LeafNode' ? [node] : [],
  getScopedActivePaneId: (_subLayout: unknown, activePaneId: string | null) =>
    activePaneId,
}))

vi.mock('@/panels/panel-context', () => ({
  useActivePaneId: () => activePaneIdMock(),
  usePanelActions: () => null,
}))

vi.mock('@/components/workspace-frame-header', () => ({
  WorkspaceFrameHeader: () => <div data-testid="workspace-frame-header" />,
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
    useLaborerStoreMock.mockReset()
  })

  it('refreshes PR status when a pane in the workspace becomes focused', async () => {
    activePaneIdMock.mockReturnValue('pane-1')
    useLaborerStoreMock.mockReturnValue({
      useQuery: (query: { label: string }) => {
        if (query.label === 'headerProjects') {
          return [{ id: 'project-1', name: 'Demo' }]
        }

        return [
          {
            id: 'ws-1',
            projectId: 'project-1',
            branchName: 'feature/demo',
            containerId: null,
            prNumber: null,
            prState: null,
            prTitle: null,
            prUrl: null,
          },
        ]
      },
    })

    render(
      <WorkspaceFrameHeaderContainer
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
    useLaborerStoreMock.mockReturnValue({
      useQuery: () => [],
    })

    render(
      <WorkspaceFrameHeaderContainer
        isMinimized={false}
        onHeaderClick={() => undefined}
        onMinimize={() => undefined}
        subLayout={subLayout}
        workspaceId="ws-1"
      />
    )

    expect(refreshPrMock).not.toHaveBeenCalled()
  })
})
