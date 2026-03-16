import type { WindowLayout } from '@laborer/shared/types'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  currentWindowIdRef,
  focusExistingWindowForWorkspaceMock,
  initialLayoutRef,
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
  windowLayoutPaneAssignedMock,
  windowLayoutPaneClosedMock,
  windowLayoutRestoredMock,
  windowLayoutSplitMock,
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
  initialLayoutRef: { current: undefined as WindowLayout | undefined },
  windowLayoutPaneAssignedMock: vi.fn((payload) => ({
    payload,
    type: 'windowLayoutPaneAssigned',
  })),
  windowLayoutPaneClosedMock: vi.fn((payload) => ({
    payload,
    type: 'windowLayoutPaneClosed',
  })),
  windowLayoutRestoredMock: vi.fn((payload) => ({
    payload,
    type: 'windowLayoutRestored',
  })),
  windowLayoutSplitMock: vi.fn((payload) => ({
    payload,
    type: 'windowLayoutSplit',
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
      readonly windowId: string
      readonly windowLayout: WindowLayout | null
      readonly activeWindowTabId: string | null
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
  panelLayout: { table: 'panel_layout' },
  panelTabCreated: panelTabCreatedMock,
  panelTabClosed: panelTabClosedMock,
  panelTabSwitched: panelTabSwitchedMock,
  panelTabsReordered: panelTabsReorderedMock,
  windowLayoutPaneAssigned: windowLayoutPaneAssignedMock,
  windowLayoutPaneClosed: windowLayoutPaneClosedMock,
  windowLayoutRestored: windowLayoutRestoredMock,
  windowLayoutSplit: windowLayoutSplitMock,
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

// --- Hierarchical WindowLayout fixtures ---

/** Two workspaces (a, b) in a horizontal split, pane-a-left focused. */
const WINDOW_A_LAYOUT: WindowLayout = {
  tabs: [
    {
      id: 'tab-a',
      label: 'Main',
      workspaceLayout: {
        _tag: 'WorkspaceTileSplit',
        id: 'tile-split-a',
        direction: 'horizontal',
        children: [
          {
            _tag: 'WorkspaceTileLeaf',
            id: 'tile-ws-a',
            workspaceId: 'workspace-a',
            panelTabs: [
              {
                id: 'pt-ws-a',
                panelLayout: {
                  _tag: 'PanelLeafNode',
                  id: 'pane-a-left',
                  paneType: 'terminal',
                  workspaceId: 'workspace-a',
                },
                focusedPaneId: 'pane-a-left',
              },
            ],
            activePanelTabId: 'pt-ws-a',
          },
          {
            _tag: 'WorkspaceTileLeaf',
            id: 'tile-ws-b',
            workspaceId: 'workspace-b',
            panelTabs: [
              {
                id: 'pt-ws-b',
                panelLayout: {
                  _tag: 'PanelLeafNode',
                  id: 'pane-a-right',
                  paneType: 'terminal',
                  workspaceId: 'workspace-b',
                },
                focusedPaneId: 'pane-a-right',
              },
            ],
            activePanelTabId: 'pt-ws-b',
          },
        ],
        sizes: [50, 50],
      },
    },
  ],
  activeTabId: 'tab-a',
}

/** Single workspace (c) with one pane. */
const WINDOW_B_LAYOUT: WindowLayout = {
  tabs: [
    {
      id: 'tab-b',
      label: 'Main',
      workspaceLayout: {
        _tag: 'WorkspaceTileLeaf',
        id: 'tile-ws-c',
        workspaceId: 'workspace-c',
        panelTabs: [
          {
            id: 'pt-ws-c',
            panelLayout: {
              _tag: 'PanelLeafNode',
              id: 'pane-b-only',
              paneType: 'terminal',
              workspaceId: 'workspace-c',
            },
            focusedPaneId: 'pane-b-only',
          },
        ],
        activePanelTabId: 'pt-ws-c',
      },
    },
  ],
  activeTabId: 'tab-b',
}

type PersistedLayoutRow = (typeof persistedRowsRef.current)[number]

type PersistedLayoutEvent =
  | ReturnType<typeof windowLayoutPaneAssignedMock>
  | ReturnType<typeof windowLayoutPaneClosedMock>
  | ReturnType<typeof windowLayoutRestoredMock>
  | ReturnType<typeof windowLayoutSplitMock>

/** Window layout event types that update the windowLayout column. */
const WINDOW_LAYOUT_EVENT_TYPES = new Set([
  'windowLayoutPaneAssigned',
  'windowLayoutPaneClosed',
  'windowLayoutRestored',
  'windowLayoutSplit',
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

  // Handle window layout events — they update the windowLayout column
  if (WINDOW_LAYOUT_EVENT_TYPES.has(type)) {
    const windowPayload = payload as {
      windowId: string
      windowLayout: WindowLayout
      activeWindowTabId?: string | null
    }
    upsertPersistedRow(windowPayload.windowId, (currentRow) => ({
      windowId: windowPayload.windowId,
      windowLayout: windowPayload.windowLayout,
      activeWindowTabId:
        windowPayload.activeWindowTabId ??
        currentRow?.activeWindowTabId ??
        null,
    }))
    return
  }

  // Legacy events are no-ops — the hook no longer commits them.
}

describe('usePanelLayout', () => {
  beforeEach(() => {
    currentWindowIdRef.current = 'window-a'
    initialLayoutRef.current = undefined
    persistedRowsRef.current = []
    terminalListRef.current = { isLoading: false, terminals: [] }
    focusExistingWindowForWorkspaceMock.mockReset()
    focusExistingWindowForWorkspaceMock.mockResolvedValue(false)
    windowLayoutPaneAssignedMock.mockClear()
    windowLayoutPaneClosedMock.mockClear()
    windowLayoutSplitMock.mockClear()
    windowLayoutRestoredMock.mockClear()
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
        windowId: 'window-a',
        windowLayout: WINDOW_A_LAYOUT,
        activeWindowTabId: 'tab-a',
      },
      {
        windowId: 'window-b',
        windowLayout: WINDOW_B_LAYOUT,
        activeWindowTabId: 'tab-b',
      },
    ]

    const { result } = renderHook(() => usePanelLayout())

    // activePaneId resolves from the hierarchical tree's focus state.
    // The first workspace (workspace-a) has focusedPaneId 'pane-a-left'.
    expect(result.current.activePaneId).toBe('pane-a-left')
  })

  it('derives active pane selection from the current window session only', () => {
    persistedRowsRef.current = [
      {
        windowId: 'window-a',
        windowLayout: WINDOW_A_LAYOUT,
        activeWindowTabId: 'tab-a',
      },
      {
        windowId: 'window-b',
        windowLayout: WINDOW_B_LAYOUT,
        activeWindowTabId: 'tab-b',
      },
    ]

    const { result } = renderHook(() => usePanelLayout())

    expect(result.current.activePaneId).toBe('pane-a-left')
    expect(result.current.activePaneId).not.toBe('pane-b-only')
  })

  it('reads a different persisted session when bootstrapped with another window id', () => {
    persistedRowsRef.current = [
      {
        windowId: 'window-a',
        windowLayout: WINDOW_A_LAYOUT,
        activeWindowTabId: 'tab-a',
      },
      {
        windowId: 'window-b',
        windowLayout: WINDOW_B_LAYOUT,
        activeWindowTabId: 'tab-b',
      },
    ]
    currentWindowIdRef.current = 'window-b'

    const { result } = renderHook(() => usePanelLayout())

    // The active pane is derived from WINDOW_B_LAYOUT
    expect(result.current.activePaneId).toBe('pane-b-only')
    expect(result.current.leafPaneIds).toEqual(['pane-b-only'])
  })

  it('seeds a new native window with a blank WindowLayout', () => {
    currentWindowIdRef.current = 'window-new'
    persistedRowsRef.current = [
      {
        windowId: 'window-a',
        windowLayout: WINDOW_A_LAYOUT,
        activeWindowTabId: 'tab-a',
      },
    ]

    const { result, rerender } = renderHook(() => usePanelLayout())

    rerender()

    // Seeding now commits windowLayoutRestored (not layoutRestored)
    expect(windowLayoutRestoredMock).toHaveBeenCalledWith(
      expect.objectContaining({
        windowId: 'window-new',
      })
    )
    // The seeded layout should produce a valid active pane
    expect(result.current.activePaneId).toBeDefined()
    // Window A should be unaffected
    const windowARow = getPersistedRow('window-a')
    expect(windowARow?.windowId).toBe('window-a')
    expect(windowARow?.windowLayout).toEqual(WINDOW_A_LAYOUT)
  })

  it('gives repeated native windows the same default starting session structure', () => {
    currentWindowIdRef.current = 'window-new-a'
    renderHook(() => usePanelLayout())

    currentWindowIdRef.current = 'window-new-b'
    renderHook(() => usePanelLayout())

    const rowA = getPersistedRow('window-new-a')
    const rowB = getPersistedRow('window-new-b')

    // Both should have a valid WindowLayout
    expect(rowA?.windowLayout).toBeDefined()
    expect(rowB?.windowLayout).toBeDefined()

    // Both should have the same structure (single tab with single workspace)
    const layoutA = rowA?.windowLayout as WindowLayout
    const layoutB = rowB?.windowLayout as WindowLayout
    expect(layoutA.tabs).toHaveLength(1)
    expect(layoutB.tabs).toHaveLength(1)
    expect(layoutA.tabs[0]?.workspaceLayout?._tag).toBe('WorkspaceTileLeaf')
    expect(layoutB.tabs[0]?.workspaceLayout?._tag).toBe('WorkspaceTileLeaf')
  })

  it('writes split operations back only to the current window session', () => {
    persistedRowsRef.current = [
      {
        windowId: 'window-a',
        windowLayout: WINDOW_A_LAYOUT,
        activeWindowTabId: 'tab-a',
      },
      {
        windowId: 'window-b',
        windowLayout: WINDOW_B_LAYOUT,
        activeWindowTabId: 'tab-b',
      },
    ]

    const { result, rerender } = renderHook(() => usePanelLayout())

    act(() => {
      result.current.panelActions.splitPane('pane-a-left', 'vertical')
    })
    rerender()

    const windowBRow = getPersistedRow('window-b')

    expect(windowLayoutSplitMock).toHaveBeenCalledWith(
      expect.objectContaining({ windowId: 'window-a' })
    )
    expect(result.current.leafPaneIds.length).toBeGreaterThanOrEqual(3)
    // Window B should be unaffected
    expect(windowBRow?.windowLayout).toEqual(WINDOW_B_LAYOUT)
  })

  it('writes close operations back only to the current window session', () => {
    persistedRowsRef.current = [
      {
        windowId: 'window-a',
        windowLayout: WINDOW_A_LAYOUT,
        activeWindowTabId: 'tab-a',
      },
      {
        windowId: 'window-b',
        windowLayout: WINDOW_B_LAYOUT,
        activeWindowTabId: 'tab-b',
      },
    ]

    const { result, rerender } = renderHook(() => usePanelLayout())

    act(() => {
      result.current.panelActions.closePane('pane-a-left')
    })
    rerender()

    const windowBRow = getPersistedRow('window-b')

    expect(windowLayoutPaneClosedMock).toHaveBeenCalledWith(
      expect.objectContaining({ windowId: 'window-a' })
    )
    // After closing pane-a-left, workspace-a gets an empty placeholder pane.
    expect(result.current.leafPaneIds).toHaveLength(2)
    expect(result.current.leafPaneIds).toContain('pane-a-right')
    // Window B should be unaffected.
    expect(windowBRow?.windowLayout).toEqual(WINDOW_B_LAYOUT)
  })

  it('scopes terminal assignment and workspace reorder writes to the current window', async () => {
    persistedRowsRef.current = [
      {
        windowId: 'window-a',
        windowLayout: WINDOW_A_LAYOUT,
        activeWindowTabId: 'tab-a',
      },
      {
        windowId: 'window-b',
        windowLayout: WINDOW_B_LAYOUT,
        activeWindowTabId: 'tab-b',
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

    const windowBRow = getPersistedRow('window-b')

    // Terminal assignment commits windowLayoutPaneAssigned (hierarchical)
    expect(windowLayoutPaneAssignedMock).toHaveBeenCalledWith(
      expect.objectContaining({ windowId: 'window-a' })
    )
    // Window B should remain unchanged
    expect(windowBRow?.windowId).toBe('window-b')
  })

  it('skips terminal assignment when the workspace is already open in another window', async () => {
    persistedRowsRef.current = [
      {
        windowId: 'window-a',
        windowLayout: WINDOW_A_LAYOUT,
        activeWindowTabId: 'tab-a',
      },
      {
        windowId: 'window-b',
        windowLayout: WINDOW_B_LAYOUT,
        activeWindowTabId: 'tab-b',
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
    expect(windowLayoutPaneAssignedMock).not.toHaveBeenCalled()
    // Window A's layout should be unchanged
    const windowARow = getPersistedRow('window-a')
    expect(windowARow?.windowLayout).toEqual(WINDOW_A_LAYOUT)
  })

  it('proceeds with terminal assignment when the workspace is not open elsewhere', async () => {
    persistedRowsRef.current = [
      {
        windowId: 'window-a',
        windowLayout: WINDOW_A_LAYOUT,
        activeWindowTabId: 'tab-a',
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

    // The assignment should proceed normally — commits hierarchical
    // windowLayoutPaneAssigned instead of legacy layoutPaneAssigned.
    expect(focusExistingWindowForWorkspaceMock).toHaveBeenCalledWith(
      'workspace-new'
    )
    expect(windowLayoutPaneAssignedMock).toHaveBeenCalledWith(
      expect.objectContaining({ windowId: 'window-a' })
    )
  })

  it('optimistically updates the terminal list when reconciling stale terminals on startup', async () => {
    // Persisted layout has a terminal ID that no longer exists
    const STALE_LAYOUT: WindowLayout = {
      tabs: [
        {
          id: 'tab-stale',
          label: 'Main',
          workspaceLayout: {
            _tag: 'WorkspaceTileLeaf',
            id: 'tile-ws-stale',
            workspaceId: 'workspace-a',
            panelTabs: [
              {
                id: 'pt-ws-stale',
                panelLayout: {
                  _tag: 'PanelLeafNode',
                  id: 'pane-a',
                  paneType: 'terminal',
                  terminalId: 'term-stale',
                  workspaceId: 'workspace-a',
                },
                focusedPaneId: 'pane-a',
              },
            ],
            activePanelTabId: 'pt-ws-stale',
          },
        },
      ],
      activeTabId: 'tab-stale',
    }
    persistedRowsRef.current = [
      {
        windowId: 'window-a',
        windowLayout: STALE_LAYOUT,
        activeWindowTabId: 'tab-stale',
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

    // upsertTerminalListItem should have been called with the
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
    const STALE_LAYOUT: WindowLayout = {
      tabs: [
        {
          id: 'tab-stale',
          label: 'Main',
          workspaceLayout: {
            _tag: 'WorkspaceTileSplit',
            id: 'tile-split-stale',
            direction: 'horizontal',
            children: [
              {
                _tag: 'WorkspaceTileLeaf',
                id: 'tile-ws-a',
                workspaceId: 'workspace-a',
                panelTabs: [
                  {
                    id: 'pt-a',
                    panelLayout: {
                      _tag: 'PanelLeafNode',
                      id: 'pane-a',
                      paneType: 'terminal',
                      terminalId: 'term-stale-1',
                      workspaceId: 'workspace-a',
                    },
                    focusedPaneId: 'pane-a',
                  },
                ],
                activePanelTabId: 'pt-a',
              },
              {
                _tag: 'WorkspaceTileLeaf',
                id: 'tile-ws-b',
                workspaceId: 'workspace-b',
                panelTabs: [
                  {
                    id: 'pt-b',
                    panelLayout: {
                      _tag: 'PanelLeafNode',
                      id: 'pane-b',
                      paneType: 'terminal',
                      terminalId: 'term-stale-2',
                      workspaceId: 'workspace-b',
                    },
                    focusedPaneId: 'pane-b',
                  },
                ],
                activePanelTabId: 'pt-b',
              },
            ],
            sizes: [50, 50],
          },
        },
      ],
      activeTabId: 'tab-stale',
    }
    persistedRowsRef.current = [
      {
        windowId: 'window-a',
        windowLayout: STALE_LAYOUT,
        activeWindowTabId: 'tab-stale',
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

    // The reconciled layout should be committed via windowLayoutRestored
    expect(windowLayoutRestoredMock).toHaveBeenCalledWith(
      expect.objectContaining({
        windowId: 'window-a',
        windowLayout: expect.objectContaining({
          tabs: expect.arrayContaining([
            expect.objectContaining({
              id: 'tab-stale',
            }),
          ]),
        }),
      })
    )
  })
})
