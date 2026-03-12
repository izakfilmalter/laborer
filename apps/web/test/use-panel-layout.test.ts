import type { PanelNode } from '@laborer/shared/types'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  currentWindowIdRef,
  initialLayoutRef,
  layoutPaneAssignedMock,
  layoutPaneClosedMock,
  layoutRestoredMock,
  layoutSplitMock,
  layoutWorkspacesReorderedMock,
  persistedRowsRef,
  storeCommitMock,
  storeQueryMock,
  storeUseQueryMock,
} = vi.hoisted(() => ({
  currentWindowIdRef: { current: 'window-a' as string | null },
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
  persistedRowsRef: {
    current: [] as Array<{
      readonly activePaneId: string | null
      readonly layoutTree: PanelNode
      readonly windowId: string
      readonly workspaceOrder?: readonly string[] | null
    }>,
  },
  storeCommitMock: vi.fn(),
  storeQueryMock: vi.fn(),
  storeUseQueryMock: vi.fn(),
}))

vi.mock('@effect-atom/atom-react/Hooks', () => ({
  useAtomSet: () =>
    vi.fn(async () => ({
      id: 'spawned-terminal',
    })),
}))

vi.mock('@laborer/shared/schema', () => ({
  layoutPaneAssigned: layoutPaneAssignedMock,
  layoutPaneClosed: layoutPaneClosedMock,
  layoutRestored: layoutRestoredMock,
  layoutSplit: layoutSplitMock,
  layoutWorkspacesReordered: layoutWorkspacesReorderedMock,
  panelLayout: { table: 'panel_layout' },
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
  useTerminalList: vi.fn(() => ({
    isLoading: false,
    terminals: [],
  })),
}))

vi.mock('@/lib/desktop', () => ({
  getCurrentWindowId: vi.fn(() => currentWindowIdRef.current),
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

type PersistedLayoutRow = (typeof persistedRowsRef.current)[number]

type PersistedLayoutEvent =
  | ReturnType<typeof layoutPaneAssignedMock>
  | ReturnType<typeof layoutPaneClosedMock>
  | ReturnType<typeof layoutRestoredMock>
  | ReturnType<typeof layoutSplitMock>
  | ReturnType<typeof layoutWorkspacesReorderedMock>

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
    layoutPaneAssignedMock.mockClear()
    layoutPaneClosedMock.mockClear()
    layoutRestoredMock.mockClear()
    layoutSplitMock.mockClear()
    layoutWorkspacesReorderedMock.mockClear()
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

  it('scopes terminal assignment and workspace reorder writes to the current window', () => {
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

    act(() => {
      result.current.panelActions.assignTerminalToPane(
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
})
