import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { refreshPrMock, mutationMap, activePaneIdMock, projectRowsMock } =
  vi.hoisted(() => ({
    refreshPrMock: vi.fn().mockResolvedValue(undefined),
    mutationMap: new Map<unknown, ReturnType<typeof vi.fn>>(),
    activePaneIdMock: vi.fn(),
    projectRowsMock: vi.fn(),
  }))

vi.mock('@effect/atom-react/Hooks', () => ({
  useAtomSet: (atom: unknown) => mutationMap.get(atom) ?? vi.fn(),
  useAtomValue: projectRowsMock,
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
    projectRowsMock.mockReset()
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
})
