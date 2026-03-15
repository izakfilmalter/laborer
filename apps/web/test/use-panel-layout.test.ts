import type { PanelNode } from '@laborer/shared/types'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  currentWindowIdRef,
  focusExistingWindowForWorkspaceMock,
  initialLayoutRef,
  layoutPaneAssignedMock,
  layoutPaneClosedMock,
  layoutRestoredMock,
  layoutSplitMock,
  layoutWorkspacesReorderedMock,
  panelTabClosedMock,
  panelTabCreatedMock,
  panelTabSwitchedMock,
  panelTabsReorderedMock,
  persistedRowsRef,
  reportVisibleWorkspacesMock,
  spawnTerminalMock,
  storeCommitMock,
  storeQueryMock,
  storeUseQueryMock,
  terminalListRef,
  upsertTerminalListItemMock,
  windowLayoutRestoredMock,
  windowTabClosedMock,
  windowTabCreatedMock,
  windowTabSwitchedMock,
  windowTabsReorderedMock,
} = vi.hoisted(() => ({
  currentWindowIdRef: { current: 'window-a' as string | null },
  focusExistingWindowForWorkspaceMock: vi.fn(
    async (_workspaceId: string) => false
  ),
  reportVisibleWorkspacesMock: vi.fn(async () => undefined),
  initialLayoutRef: { current: undefined as PanelNode | undefined },
  layoutPaneAssignedMock: vi.fn((payload) => ({
    payload,
    type: 'layoutPaneAssigned',
  })),
  layoutPaneClosedMock: vi.fn((payload) => ({
    payload,
    type: 'layoutPaneClosed',
  })),
  layoutRestoredMock: vi.fn((payload) => ({ payload, type: 'layoutRestored' })),
  layoutSplitMock: vi.fn((payload) => ({ payload, type: 'layoutSplit' })),
  layoutWorkspacesReorderedMock: vi.fn((payload) => ({
    payload,
    type: 'layoutWorkspacesReordered',
  })),
  windowLayoutRestoredMock: vi.fn((payload) => ({
    payload,
    type: 'windowLayoutRestored',
  })),
  panelTabCreatedMock: vi.fn((payload) => ({
    payload,
    type: 'panelTabCreated',
  })),
  panelTabClosedMock: vi.fn((payload) => ({
    payload,
    type: 'panelTabClosed',
  })),
  panelTabSwitchedMock: vi.fn((payload) => ({
    payload,
    type: 'panelTabSwitched',
  })),
  panelTabsReorderedMock: vi.fn((payload) => ({
    payload,
    type: 'panelTabsReordered',
  })),
  windowTabCreatedMock: vi.fn((payload) => ({
    payload,
    type: 'windowTabCreated',
  })),
  windowTabClosedMock: vi.fn((payload) => ({
    payload,
    type: 'windowTabClosed',
  })),
  windowTabSwitchedMock: vi.fn((payload) => ({
    payload,
    type: 'windowTabSwitched',
  })),
  windowTabsReorderedMock: vi.fn((payload) => ({
    payload,
    type: 'windowTabsReordered',
  })),
  persistedRowsRef: {
    current: [] as Array<{
      readonly activePaneId: string | null
      readonly layoutTree: PanelNode
      readonly windowId: string
      readonly windowLayout?: unknown
      readonly workspaceOrder?: readonly string[] | null
    }>,
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
}))

vi.mock('@effect-atom/atom-react/Hooks', () => ({
  useAtomSet: () => spawnTerminalMock,
}))

vi.mock('@laborer/shared/schema', () => ({
  layoutPaneAssigned: layoutPaneAssignedMock,
  layoutPaneClosed: layoutPaneClosedMock,
  layoutRestored: layoutRestoredMock,
  layoutSplit: layoutSplitMock,
  layoutWorkspacesReordered: layoutWorkspacesReorderedMock,
  panelLayout: { table: 'panel_layout' },
  panelTabCreated: panelTabCreatedMock,
  panelTabClosed: panelTabClosedMock,
  panelTabSwitched: panelTabSwitchedMock,
  panelTabsReordered: panelTabsReorderedMock,
  windowLayoutRestored: windowLayoutRestoredMock,
  windowTabCreated: windowTabCreatedMock,
  windowTabClosed: windowTabClosedMock,
  windowTabSwitched: windowTabSwitchedMock,
  windowTabsReordered: windowTabsReorderedMock,
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

const DEFAULT_NEW_WINDOW_LAYOUT: PanelNode = {
  _tag: 'LeafNode',
  id: 'pane-default',
  paneType: 'terminal',
  terminalId: undefined,
  workspaceId: undefined,
}

const CORRUPTED_LAYOUT = {
  _tag: 'SplitNode',
  children: [],
  direction: 'horizontal',
  id: 'split-corrupted',
  sizes: [],
} as unknown as PanelNode

type PersistedLayoutRow = (typeof persistedRowsRef.current)[number]

type PersistedLayoutEvent =
  | ReturnType<typeof layoutPaneAssignedMock>
  | ReturnType<typeof layoutPaneClosedMock>
  | ReturnType<typeof layoutRestoredMock>
  | ReturnType<typeof layoutSplitMock>
  | ReturnType<typeof layoutWorkspacesReorderedMock>
  | ReturnType<typeof windowLayoutRestoredMock>

/** Window layout event types that only update the windowLayout column. */
const WINDOW_LAYOUT_EVENT_TYPES = new Set([
  'windowLayoutRestored',
  'windowTabCreated',
  'windowTabClosed',
  'windowTabSwitched',
  'windowTabsReordered',
  'panelTabCreated',
  'panelTabClosed',
  'panelTabSwitched',
  'panelTabsReordered',
])

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

  // Handle window layout events — they only update the windowLayout column
  if (WINDOW_LAYOUT_EVENT_TYPES.has(type)) {
    const windowPayload = payload as {
      windowId: string
      windowLayout: unknown
      activeWindowTabId?: string | null
    }
    upsertPersistedRow(windowPayload.windowId, (currentRow) => ({
      activePaneId: currentRow?.activePaneId ?? null,
      layoutTree: currentRow?.layoutTree ?? WINDOW_B_LAYOUT,
      windowId: windowPayload.windowId,
      windowLayout: windowPayload.windowLayout,
      workspaceOrder: currentRow?.workspaceOrder ?? null,
    }))
    return
  }

  if (type === 'layoutWorkspacesReordered') {
    upsertPersistedRow(payload.windowId, (currentRow) => ({
      activePaneId: currentRow?.activePaneId ?? null,
      layoutTree: currentRow?.layoutTree ?? WINDOW_B_LAYOUT,
      windowId: payload.windowId,
      workspaceOrder: payload.workspaceOrder,
    }))
    return
  }

  upsertPersistedRow(payload.windowId, (currentRow) => {
    const nextRow: PersistedLayoutRow = {
      activePaneId: payload.activePaneId,
      layoutTree: payload.layoutTree,
      windowId: payload.windowId,
    }
    if (currentRow?.workspaceOrder !== undefined) {
      return {
        ...nextRow,
        workspaceOrder: currentRow.workspaceOrder,
      }
    }
    return nextRow
  })
}

describe('usePanelLayout', () => {
  beforeEach(() => {
    currentWindowIdRef.current = 'window-a'
    initialLayoutRef.current = undefined
    persistedRowsRef.current = []
    terminalListRef.current = { isLoading: false, terminals: [] }
    focusExistingWindowForWorkspaceMock.mockReset()
    focusExistingWindowForWorkspaceMock.mockResolvedValue(false)
    layoutPaneAssignedMock.mockClear()
    layoutPaneClosedMock.mockClear()
    layoutRestoredMock.mockClear()
    layoutSplitMock.mockClear()
    layoutWorkspacesReorderedMock.mockClear()
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
    storeUseQueryMock.mockImplementation(() => persistedRowsRef.current)
    storeQueryMock.mockImplementation(() => persistedRowsRef.current)
  })

  afterEach(() => {
    cleanup()
  })

  it('hydrates only the persisted session for the current window id', () => {
    persistedRowsRef.current = [
      {
        activePaneId: 'pane-a-right',
        layoutTree: WINDOW_A_LAYOUT,
        windowId: 'window-a',
        workspaceOrder: ['workspace-b', 'workspace-a'],
      },
      {
        activePaneId: 'pane-b-only',
        layoutTree: WINDOW_B_LAYOUT,
        windowId: 'window-b',
        workspaceOrder: ['workspace-c'],
      },
    ]

    const { result } = renderHook(() => usePanelLayout())

    expect(result.current.layout).toEqual(WINDOW_A_LAYOUT)
    expect(result.current.activePaneId).toBe('pane-a-right')
    expect(result.current.leafPaneIds).toEqual(['pane-a-left', 'pane-a-right'])
    expect(result.current.workspaceOrder).toEqual([
      'workspace-b',
      'workspace-a',
    ])
    expect(storeCommitMock).not.toHaveBeenCalled()
  })

  it('derives active pane selection from the current window session only', () => {
    persistedRowsRef.current = [
      {
        activePaneId: 'pane-from-other-window',
        layoutTree: WINDOW_A_LAYOUT,
        windowId: 'window-a',
      },
      {
        activePaneId: 'pane-b-only',
        layoutTree: WINDOW_B_LAYOUT,
        windowId: 'window-b',
      },
    ]

    const { result } = renderHook(() => usePanelLayout())

    expect(result.current.layout).toEqual(WINDOW_A_LAYOUT)
    expect(result.current.activePaneId).toBe('pane-a-left')
    expect(result.current.activePaneId).not.toBe('pane-b-only')
  })

  it('repairs stale active-pane pointers during restore', () => {
    persistedRowsRef.current = [
      {
        activePaneId: 'pane-missing',
        layoutTree: WINDOW_A_LAYOUT,
        windowId: 'window-a',
      },
    ]

    const { result, rerender } = renderHook(() => usePanelLayout())

    rerender()

    expect(result.current.layout).toEqual(WINDOW_A_LAYOUT)
    expect(result.current.activePaneId).toBe('pane-a-left')
    expect(layoutRestoredMock).toHaveBeenCalledWith({
      activePaneId: 'pane-a-left',
      layoutTree: WINDOW_A_LAYOUT,
      windowId: 'window-a',
    })
    expect(getPersistedRow('window-a')).toEqual({
      activePaneId: 'pane-a-left',
      layoutTree: WINDOW_A_LAYOUT,
      windowId: 'window-a',
    })
  })

  it('reads a different persisted session when bootstrapped with another window id', () => {
    persistedRowsRef.current = [
      {
        activePaneId: 'pane-a-right',
        layoutTree: WINDOW_A_LAYOUT,
        windowId: 'window-a',
      },
      {
        activePaneId: 'pane-b-only',
        layoutTree: WINDOW_B_LAYOUT,
        windowId: 'window-b',
      },
    ]
    currentWindowIdRef.current = 'window-b'

    const { result } = renderHook(() => usePanelLayout())

    expect(result.current.layout).toEqual(WINDOW_B_LAYOUT)
    expect(result.current.activePaneId).toBe('pane-b-only')
    expect(result.current.leafPaneIds).toEqual(['pane-b-only'])
  })

  it('falls back to the default session when the persisted layout is corrupted', () => {
    currentWindowIdRef.current = 'window-corrupted'
    initialLayoutRef.current = WINDOW_A_LAYOUT
    persistedRowsRef.current = [
      {
        activePaneId: 'pane-corrupted',
        layoutTree: CORRUPTED_LAYOUT,
        windowId: 'window-corrupted',
      },
    ]

    const { result, rerender } = renderHook(() => usePanelLayout())

    rerender()

    expect(result.current.layout).toEqual(DEFAULT_NEW_WINDOW_LAYOUT)
    expect(result.current.activePaneId).toBe('pane-default')
    expect(layoutRestoredMock).toHaveBeenCalledWith({
      activePaneId: 'pane-default',
      layoutTree: DEFAULT_NEW_WINDOW_LAYOUT,
      windowId: 'window-corrupted',
    })
    expect(getPersistedRow('window-corrupted')).toEqual({
      activePaneId: 'pane-default',
      layoutTree: DEFAULT_NEW_WINDOW_LAYOUT,
      windowId: 'window-corrupted',
    })
  })

  it('seeds a new native window with the blank default session instead of cloning existing layout state', () => {
    currentWindowIdRef.current = 'window-new'
    initialLayoutRef.current = WINDOW_A_LAYOUT
    persistedRowsRef.current = [
      {
        activePaneId: 'pane-a-right',
        layoutTree: WINDOW_A_LAYOUT,
        windowId: 'window-a',
      },
    ]

    const { result, rerender } = renderHook(() => usePanelLayout())

    rerender()

    expect(result.current.layout).toEqual(DEFAULT_NEW_WINDOW_LAYOUT)
    expect(result.current.activePaneId).toBe('pane-default')
    expect(layoutRestoredMock).toHaveBeenCalledWith({
      activePaneId: 'pane-default',
      layoutTree: DEFAULT_NEW_WINDOW_LAYOUT,
      windowId: 'window-new',
    })
    expect(getPersistedRow('window-new')).toEqual({
      activePaneId: 'pane-default',
      layoutTree: DEFAULT_NEW_WINDOW_LAYOUT,
      windowId: 'window-new',
    })
    expect(getPersistedRow('window-a')).toEqual({
      activePaneId: 'pane-a-right',
      layoutTree: WINDOW_A_LAYOUT,
      windowId: 'window-a',
    })
  })

  it('gives repeated native windows the same default starting session', () => {
    initialLayoutRef.current = WINDOW_A_LAYOUT

    currentWindowIdRef.current = 'window-new-a'
    renderHook(() => usePanelLayout())

    currentWindowIdRef.current = 'window-new-b'
    renderHook(() => usePanelLayout())

    expect(getPersistedRow('window-new-a')).toEqual({
      activePaneId: 'pane-default',
      layoutTree: DEFAULT_NEW_WINDOW_LAYOUT,
      windowId: 'window-new-a',
    })
    expect(getPersistedRow('window-new-b')).toEqual({
      activePaneId: 'pane-default',
      layoutTree: DEFAULT_NEW_WINDOW_LAYOUT,
      windowId: 'window-new-b',
    })
  })

  it('writes split operations back only to the current window session', () => {
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

    const { result, rerender } = renderHook(() => usePanelLayout())

    act(() => {
      result.current.panelActions.splitPane('pane-a-left', 'vertical')
    })
    rerender()

    const windowARow = getPersistedRow('window-a')
    const windowBRow = getPersistedRow('window-b')

    expect(layoutSplitMock).toHaveBeenCalledWith(
      expect.objectContaining({ windowId: 'window-a' })
    )
    expect(result.current.leafPaneIds).toHaveLength(3)
    expect(windowARow?.layoutTree).not.toEqual(WINDOW_A_LAYOUT)
    expect(windowBRow).toEqual({
      activePaneId: 'pane-b-only',
      layoutTree: WINDOW_B_LAYOUT,
      windowId: 'window-b',
    })
  })

  it('writes close operations back only to the current window session', () => {
    persistedRowsRef.current = [
      {
        activePaneId: 'pane-a-right',
        layoutTree: WINDOW_A_LAYOUT,
        windowId: 'window-a',
      },
      {
        activePaneId: 'pane-b-only',
        layoutTree: WINDOW_B_LAYOUT,
        windowId: 'window-b',
      },
    ]

    const { result, rerender } = renderHook(() => usePanelLayout())

    act(() => {
      result.current.panelActions.closePane('pane-a-left')
    })
    rerender()

    const windowARow = getPersistedRow('window-a')
    const windowBRow = getPersistedRow('window-b')

    expect(layoutPaneClosedMock).toHaveBeenCalledWith(
      expect.objectContaining({ windowId: 'window-a' })
    )
    expect(result.current.leafPaneIds).toEqual(['pane-a-right'])
    expect(windowARow).toEqual({
      activePaneId: 'pane-a-right',
      layoutTree: {
        _tag: 'LeafNode',
        id: 'pane-a-right',
        paneType: 'terminal',
        terminalId: undefined,
        workspaceId: 'workspace-b',
      },
      windowId: 'window-a',
    })
    expect(windowBRow).toEqual({
      activePaneId: 'pane-b-only',
      layoutTree: WINDOW_B_LAYOUT,
      windowId: 'window-b',
    })
  })

  it('scopes terminal assignment and workspace reorder writes to the current window', async () => {
    persistedRowsRef.current = [
      {
        activePaneId: 'pane-a-right',
        layoutTree: WINDOW_A_LAYOUT,
        windowId: 'window-a',
        workspaceOrder: ['workspace-a', 'workspace-b'],
      },
      {
        activePaneId: 'pane-b-only',
        layoutTree: WINDOW_B_LAYOUT,
        windowId: 'window-b',
        workspaceOrder: ['workspace-c'],
      },
    ]

    const { result, rerender } = renderHook(() => usePanelLayout())

    await act(async () => {
      await result.current.panelActions.assignTerminalToPane(
        'terminal-a-1',
        'workspace-assigned'
      )
      result.current.panelActions.reorderWorkspaces([
        'workspace-b',
        'workspace-assigned',
      ])
    })
    rerender()

    const windowARow = getPersistedRow('window-a')
    const windowBRow = getPersistedRow('window-b')

    expect(layoutPaneAssignedMock).toHaveBeenCalledWith(
      expect.objectContaining({ windowId: 'window-a' })
    )
    expect(layoutWorkspacesReorderedMock).toHaveBeenCalledWith(
      expect.objectContaining({ windowId: 'window-a' })
    )
    expect(windowARow?.activePaneId).toBe('pane-a-left')
    expect(windowARow?.workspaceOrder).toEqual([
      'workspace-b',
      'workspace-assigned',
    ])
    expect(windowARow?.layoutTree).toEqual({
      _tag: 'SplitNode',
      children: [
        {
          _tag: 'LeafNode',
          id: 'pane-a-left',
          paneType: 'terminal',
          terminalId: 'terminal-a-1',
          workspaceId: 'workspace-assigned',
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
    })
    expect(windowBRow).toEqual({
      activePaneId: 'pane-b-only',
      layoutTree: WINDOW_B_LAYOUT,
      windowId: 'window-b',
      workspaceOrder: ['workspace-c'],
    })
  })

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
    expect(layoutPaneAssignedMock).not.toHaveBeenCalled()
    // Window A's layout should be unchanged
    const windowARow = getPersistedRow('window-a')
    expect(windowARow?.layoutTree).toEqual(WINDOW_A_LAYOUT)
  })

  it('proceeds with terminal assignment when the workspace is not open elsewhere', async () => {
    persistedRowsRef.current = [
      {
        activePaneId: 'pane-a-left',
        layoutTree: WINDOW_A_LAYOUT,
        windowId: 'window-a',
      },
    ]

    // No other window has the workspace
    focusExistingWindowForWorkspaceMock.mockResolvedValue(false)

    const { result } = renderHook(() => usePanelLayout())

    await act(async () => {
      await result.current.panelActions.assignTerminalToPane(
        'terminal-new',
        'workspace-new'
      )
    })

    // The assignment should proceed normally
    expect(focusExistingWindowForWorkspaceMock).toHaveBeenCalledWith(
      'workspace-new'
    )
    expect(layoutPaneAssignedMock).toHaveBeenCalledWith(
      expect.objectContaining({ windowId: 'window-a' })
    )
  })

  it('optimistically updates the terminal list when reconciling stale terminals on startup', async () => {
    // Persisted layout has a terminal ID that no longer exists
    const STALE_LAYOUT: PanelNode = {
      _tag: 'LeafNode',
      id: 'pane-a',
      paneType: 'terminal',
      terminalId: 'term-stale',
      workspaceId: 'workspace-a',
    }
    persistedRowsRef.current = [
      {
        activePaneId: 'pane-a',
        layoutTree: STALE_LAYOUT,
        windowId: 'window-a',
      },
    ]

    // Terminal service returns no live terminals (fresh restart)
    terminalListRef.current = { isLoading: false, terminals: [] }

    // Spawn returns a new terminal
    spawnTerminalMock.mockResolvedValue({
      id: 'term-new',
      command: '/bin/zsh',
      status: 'running' as const,
      workspaceId: 'workspace-a',
    })

    const { rerender } = renderHook(() => usePanelLayout())

    // Allow the reconciliation effect and async spawn to complete
    await act(async () => {
      rerender()
      // Wait for the spawn promise to resolve
      await new Promise((resolve) => setTimeout(resolve, 50))
    })

    // The fix: upsertTerminalListItem should have been called with the
    // new terminal info, so the sidebar shows the recovered terminal
    // immediately without waiting for the event stream.
    expect(upsertTerminalListItemMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'term-new',
        workspaceId: 'workspace-a',
        status: 'running',
        command: '/bin/zsh',
      })
    )
  })

  it('reconciles the persisted layout tree with new terminal IDs after respawning', async () => {
    const STALE_LAYOUT: PanelNode = {
      _tag: 'SplitNode',
      id: 'split-root',
      direction: 'horizontal',
      children: [
        {
          _tag: 'LeafNode',
          id: 'pane-a',
          paneType: 'terminal',
          terminalId: 'term-stale-1',
          workspaceId: 'workspace-a',
        },
        {
          _tag: 'LeafNode',
          id: 'pane-b',
          paneType: 'terminal',
          terminalId: 'term-stale-2',
          workspaceId: 'workspace-b',
        },
      ],
      sizes: [50, 50],
    }
    persistedRowsRef.current = [
      {
        activePaneId: 'pane-a',
        layoutTree: STALE_LAYOUT,
        windowId: 'window-a',
      },
    ]

    terminalListRef.current = { isLoading: false, terminals: [] }

    let spawnCount = 0
    spawnTerminalMock.mockImplementation(() => {
      spawnCount++
      return Promise.resolve({
        id: `term-new-${spawnCount}`,
        command: '/bin/zsh',
        status: 'running' as const,
        workspaceId: `workspace-${spawnCount === 1 ? 'a' : 'b'}`,
      })
    })

    const { rerender } = renderHook(() => usePanelLayout())

    await act(async () => {
      rerender()
      await new Promise((resolve) => setTimeout(resolve, 100))
    })

    // Both stale terminals should have been respawned
    expect(spawnTerminalMock).toHaveBeenCalledTimes(2)

    // Both should have optimistic upserts
    expect(upsertTerminalListItemMock).toHaveBeenCalledTimes(2)

    // The layout should be updated with the new terminal IDs
    expect(layoutRestoredMock).toHaveBeenCalledWith(
      expect.objectContaining({
        windowId: 'window-a',
        layoutTree: expect.objectContaining({
          _tag: 'SplitNode',
          children: expect.arrayContaining([
            expect.objectContaining({ terminalId: 'term-new-1' }),
            expect.objectContaining({ terminalId: 'term-new-2' }),
          ]),
        }),
      })
    )
  })
})
