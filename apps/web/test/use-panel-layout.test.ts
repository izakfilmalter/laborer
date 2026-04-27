import type { PanelNode } from '@laborer/shared/types'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  currentWindowIdRef,
  focusExistingWindowForWorkspaceMock,
  initialLayoutRef,
  persistedRowsRef,
  reportVisibleWorkspacesMock,
  spawnTerminalMock,
  storeCommitMock,
  storeQueryMock,
  storeUseQueryMock,
  terminalListRef,
  upsertTerminalListItemMock,
  workspaceRowsRef,
  windowLayoutUpdatedMock,
} = vi.hoisted(() => ({
  currentWindowIdRef: { current: 'window-a' as string | null },
  focusExistingWindowForWorkspaceMock: vi.fn(
    async (_workspaceId: string) => false
  ),
  reportVisibleWorkspacesMock: vi.fn(async () => undefined),
  initialLayoutRef: { current: undefined as PanelNode | undefined },
  windowLayoutUpdatedMock: vi.fn((payload) => ({
    payload,
    type: 'windowLayoutUpdated',
  })),
  persistedRowsRef: {
    current: [] as Record<string, unknown>[],
  },
  spawnTerminalMock: vi.fn(async () => ({
    id: 'spawned-terminal',
    command: '/bin/zsh',
    status: 'running' as const,
    workspaceId: 'workspace-a',
  })),
  storeCommitMock: vi.fn(),
  storeQueryMock: vi.fn(),
  storeUseQueryMock: vi.fn(),
  terminalListRef: {
    current: {
      isLoading: false,
      terminals: [] as Array<{ readonly id: string }>,
    },
  },
  upsertTerminalListItemMock: vi.fn(),
  workspaceRowsRef: {
    current: [] as Record<string, unknown>[],
  },
}))

vi.mock('@effect-atom/atom-react/Hooks', () => ({
  useAtomSet: () => spawnTerminalMock,
}))

vi.mock('@laborer/shared/schema', () => ({
  panelLayout: { table: 'panel_layout' },
  windowLayoutUpdated: windowLayoutUpdatedMock,
  workspaces: { table: 'workspaces' },
}))

vi.mock('@livestore/livestore', () => ({
  queryDb: vi.fn((table: unknown, options: unknown) => ({ table, options })),
}))

vi.mock('@/atoms/laborer-client', () => ({
  LaborerClient: {
    mutation: vi.fn(() => Symbol('laborer-mutation')),
  },
}))

vi.mock('@/atoms/terminal-service-client', () => ({
  TerminalServiceClient: {
    mutation: vi.fn(() => Symbol('terminal-mutation')),
  },
}))

vi.mock('@/hooks/use-spawn-terminal', () => ({
  useSpawnTerminal: () => spawnTerminalMock,
}))

vi.mock('@/hooks/use-terminal-list', () => ({
  removeTerminalListItem: vi.fn(),
  upsertTerminalListItem: (...args: unknown[]) =>
    upsertTerminalListItemMock(...args),
  useTerminalList: vi.fn(() => terminalListRef.current),
}))

vi.mock('@/lib/desktop', () => ({
  focusExistingWindowForWorkspace: (workspaceId: string) =>
    focusExistingWindowForWorkspaceMock(workspaceId),
  getCurrentWindowId: vi.fn(() => currentWindowIdRef.current),
  getDesktopBridge: vi.fn(() =>
    currentWindowIdRef.current
      ? { reportVisibleWorkspaces: reportVisibleWorkspacesMock }
      : undefined
  ),
}))

vi.mock('@/livestore/store', () => ({
  useLaborerStore: vi.fn(() => ({
    commit: storeCommitMock,
    query: storeQueryMock,
    useQuery: storeUseQueryMock,
  })),
}))

vi.mock('@/panels/panel-group-registry', () => ({
  usePanelGroupRegistry: vi.fn(() => null),
}))

vi.mock('../src/routes/-hooks/use-initial-layout', () => ({
  useInitialLayout: vi.fn(() => initialLayoutRef.current),
}))

import { usePanelLayout } from '../src/routes/-hooks/use-panel-layout'

const WINDOW_A_LAYOUT: PanelNode = {
  _tag: 'SplitNode',
  children: [
    {
      _tag: 'LeafNode',
      id: 'pane-a-left',
      paneType: 'terminal',
      terminalId: undefined,
      workspaceId: 'workspace-a',
    },
    {
      _tag: 'LeafNode',
      id: 'pane-a-right',
      paneType: 'terminal',
      terminalId: undefined,
      workspaceId: 'workspace-b',
    },
  ],
  direction: 'horizontal',
  id: 'split-a',
  sizes: [50, 50],
}

const WINDOW_B_LAYOUT: PanelNode = {
  _tag: 'LeafNode',
  id: 'pane-b-only',
  paneType: 'terminal',
  terminalId: undefined,
  workspaceId: 'workspace-c',
}

type PersistedLayoutRow = (typeof persistedRowsRef.current)[number]

interface PersistedLayoutEvent {
  payload: any
  type: string
}

const getPersistedRow = (windowId: string): PersistedLayoutRow | undefined =>
  persistedRowsRef.current.find((row) => row.windowId === windowId)

const upsertPersistedRow = (
  windowId: string,
  update: (currentRow?: PersistedLayoutRow) => PersistedLayoutRow
) => {
  const currentRow = getPersistedRow(windowId)
  const nextRow = update(currentRow)
  const otherRows = persistedRowsRef.current.filter(
    (row) => row.windowId !== windowId
  )
  persistedRowsRef.current = [...otherRows, nextRow]
}

const applyPersistedLayoutEvent = (event: PersistedLayoutEvent) => {
  const { payload, type } = event

  // Only windowLayoutUpdated writes to the table.
  if (type === 'windowLayoutUpdated') {
    upsertPersistedRow(payload.windowId, () => ({
      windowId: payload.windowId,
      windowLayout: payload.windowLayout,
    }))
  }
}

const layoutContainsTerminal = (
  value: unknown,
  terminalId: string
): boolean => {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  if ('terminalId' in value && value.terminalId === terminalId) {
    return true
  }
  return Object.values(value).some((child) =>
    layoutContainsTerminal(child, terminalId)
  )
}

describe('usePanelLayout', () => {
  beforeEach(() => {
    currentWindowIdRef.current = 'window-a'
    initialLayoutRef.current = undefined
    persistedRowsRef.current = []
    workspaceRowsRef.current = []
    terminalListRef.current = { isLoading: false, terminals: [] }
    focusExistingWindowForWorkspaceMock.mockReset()
    focusExistingWindowForWorkspaceMock.mockResolvedValue(false)
    windowLayoutUpdatedMock.mockClear()
    reportVisibleWorkspacesMock.mockClear()
    spawnTerminalMock.mockClear()
    spawnTerminalMock.mockImplementation(async () => ({
      id: 'spawned-terminal',
      command: '/bin/zsh',
      status: 'running' as const,
      workspaceId: 'workspace-a',
    }))
    upsertTerminalListItemMock.mockClear()
    storeCommitMock.mockReset()
    storeQueryMock.mockReset()
    storeUseQueryMock.mockReset()
    storeCommitMock.mockImplementation((event: PersistedLayoutEvent) => {
      applyPersistedLayoutEvent(event)
    })
    storeUseQueryMock.mockImplementation(
      (query: { options?: { label?: string } }) =>
        query.options?.label === 'homePanelWorkspaces'
          ? workspaceRowsRef.current
          : persistedRowsRef.current
    )
    storeQueryMock.mockImplementation(
      (query: { options?: { label?: string } }) =>
        query.options?.label === 'homePanelWorkspaces'
          ? workspaceRowsRef.current
          : persistedRowsRef.current
    )
  })

  afterEach(() => {
    cleanup()
  })

  // TODO: Rewrite for single windowLayoutUpdated event (Issue 2)
  it.todo('hydrates only the persisted session for the current window id')

  // TODO: Rewrite for single windowLayoutUpdated event (Issue 2)
  it.todo('derives active pane selection from the current window session only')

  // TODO: Rewrite for single windowLayoutUpdated event (Issue 2)
  it.todo('repairs stale active-pane pointers during restore')

  // TODO: Rewrite for single windowLayoutUpdated event (Issue 2)
  it.todo(
    'reads a different persisted session when bootstrapped with another window id'
  )

  // TODO: Rewrite for single windowLayoutUpdated event (Issue 2)
  it.todo(
    'falls back to the default session when the persisted layout is corrupted'
  )

  // TODO: Rewrite for single windowLayoutUpdated event (Issue 2)
  it.todo(
    'seeds a new native window with the blank default session instead of cloning existing layout state'
  )

  // TODO: Rewrite for single windowLayoutUpdated event (Issue 2)
  it.todo('gives repeated native windows the same default starting session')

  // TODO: Rewrite for single windowLayoutUpdated event (Issue 2)
  it.todo('writes split operations back only to the current window session')

  // TODO: Rewrite for single windowLayoutUpdated event (Issue 2)
  it.todo('writes close operations back only to the current window session')

  // TODO: Rewrite for single windowLayoutUpdated event (Issue 2)
  it.todo(
    'scopes terminal assignment and workspace reorder writes to the current window'
  )

  it('skips terminal assignment when the workspace is already open in another window', async () => {
    persistedRowsRef.current = [
      {
        activePaneId: 'pane-a-left',
        layoutTree: WINDOW_A_LAYOUT,
        windowId: 'window-a',
      },
      {
        activePaneId: 'pane-b-only',
        layoutTree: WINDOW_B_LAYOUT,
        windowId: 'window-b',
      },
    ]

    // Simulate the desktop main process reporting that workspace-c
    // is already open in another window (window-b)
    focusExistingWindowForWorkspaceMock.mockResolvedValue(true)

    const { result } = renderHook(() => usePanelLayout())

    await act(async () => {
      await result.current.panelActions.assignTerminalToPane(
        'terminal-new',
        'workspace-c'
      )
    })

    // The assignment should NOT have been committed because the workspace
    // was focused in a different window
    expect(focusExistingWindowForWorkspaceMock).toHaveBeenCalledWith(
      'workspace-c'
    )
    expect(windowLayoutUpdatedMock).not.toHaveBeenCalled()
    // Window A's layout should be unchanged
    const windowARow = getPersistedRow('window-a')
    expect(windowARow?.layoutTree).toEqual(WINDOW_A_LAYOUT)
  })

  // TODO: Rewrite for single windowLayoutUpdated event (Issue 2)
  it.todo(
    'proceeds with terminal assignment when the workspace is not open elsewhere'
  )

  // TODO: Rewrite for single windowLayoutUpdated event (Issue 2)
  it.todo(
    'optimistically updates the terminal list when reconciling stale terminals on startup'
  )

  // TODO: Rewrite for single windowLayoutUpdated event (Issue 2)
  it.todo(
    'reconciles the persisted layout tree with new terminal IDs after respawning'
  )

  it('creates a panel tab when assigning a terminal to a workspace with no panel tabs', async () => {
    // Layout: workspace-new has a tile leaf but zero panel tabs.
    // This simulates the state after addWorkspaceToTab creates an empty tile.
    const layoutWithEmptyWorkspace = {
      tabs: [
        {
          id: 'win-tab-1',
          label: 'Tab 1',
          workspaceLayout: {
            _tag: 'WorkspaceTileLeaf' as const,
            id: 'ws-tile-new',
            workspaceId: 'workspace-new',
            panelTabs: [],
            activePanelTabId: undefined,
          },
        },
      ],
      activeTabId: 'win-tab-1',
    }
    persistedRowsRef.current = [
      {
        windowId: 'window-a',
        windowLayout: layoutWithEmptyWorkspace,
      },
    ]

    const { result } = renderHook(() => usePanelLayout())

    await act(async () => {
      await result.current.panelActions.assignTerminalToPane(
        'terminal-1',
        'workspace-new'
      )
    })

    // A windowLayoutUpdated event should have been committed
    expect(windowLayoutUpdatedMock).toHaveBeenCalled()

    // The committed layout should contain a panel tab with the terminal assigned
    const lastCall = windowLayoutUpdatedMock.mock.calls.at(-1)?.[0]
    const committedLayout = lastCall?.windowLayout
    expect(committedLayout).toBeDefined()

    // Find the workspace tile leaf in the committed layout
    const tab = committedLayout.tabs[0]
    const wsLeaf = tab?.workspaceLayout
    expect(wsLeaf?._tag).toBe('WorkspaceTileLeaf')
    expect(wsLeaf?.workspaceId).toBe('workspace-new')
    // Should now have a panel tab
    expect(wsLeaf?.panelTabs.length).toBeGreaterThan(0)
    // The panel tab's leaf should have the terminal assigned
    const panelTab = wsLeaf?.panelTabs[0]
    expect(panelTab?.panelLayout._tag).toBe('LeafNode')
    expect(panelTab?.panelLayout.terminalId).toBe('terminal-1')
    expect(panelTab?.panelLayout.paneType).toBe('terminal')
  })

  it('waits to auto-open a new workspace agent until the workspace is running', async () => {
    persistedRowsRef.current = [
      {
        windowId: 'window-a',
        windowLayout: {
          tabs: [
            {
              id: 'win-tab-1',
              label: 'Tab 1',
              workspaceLayout: {
                _tag: 'WorkspaceTileLeaf' as const,
                id: 'ws-tile-existing',
                workspaceId: 'workspace-existing',
                panelTabs: [
                  {
                    id: 'panel-tab-existing',
                    label: 'Terminal',
                    panelLayout: {
                      _tag: 'LeafNode' as const,
                      id: 'pane-existing',
                      paneType: 'terminal' as const,
                      terminalId: 'terminal-existing',
                    },
                  },
                ],
                activePanelTabId: 'panel-tab-existing',
              },
            },
          ],
          activeTabId: 'win-tab-1',
        },
      },
    ]
    workspaceRowsRef.current = [
      {
        id: 'workspace-new',
        projectId: 'project-1',
        branchName: 'feature/new-workspace',
        worktreePath: '/tmp/workspace-new',
        status: 'creating',
        origin: 'laborer',
        createdAt: '2026-04-20T00:00:00.000Z',
      },
    ]

    const { result, rerender } = renderHook(() => usePanelLayout())

    act(() => {
      result.current.panelActions.autoOpenAgentWhenWorkspaceReady?.(
        'workspace-new'
      )
    })

    expect(spawnTerminalMock).not.toHaveBeenCalled()

    workspaceRowsRef.current = [
      {
        id: 'workspace-new',
        projectId: 'project-1',
        branchName: 'feature/new-workspace',
        worktreePath: '/tmp/workspace-new',
        status: 'running',
        origin: 'laborer',
        createdAt: '2026-04-20T00:00:00.000Z',
      },
    ]

    act(() => {
      rerender()
    })

    await waitFor(() => {
      expect(spawnTerminalMock).toHaveBeenCalledWith({
        payload: { workspaceId: 'workspace-new', command: 'opencode' },
      })
    })

    await waitFor(() => {
      const lastCall = windowLayoutUpdatedMock.mock.calls.at(-1)?.[0]
      expect(
        layoutContainsTerminal(lastCall?.windowLayout, 'spawned-terminal')
      ).toBe(true)
    })
  })
})
