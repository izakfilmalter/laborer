import type { WindowLayout, WorkspaceTileNode } from '@laborer/shared/types'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { panelLayoutCollection } from '@/db/local-preferences'

const {
  currentWindowIdRef,
  focusExistingWindowForWorkspaceMock,
  initialLayoutRef,
  reportWindowWorkspacesMock,
  reportWorkspacePresenceMock,
  spawnTerminalMock,
  terminalListRef,
  upsertTerminalListItemMock,
  workspaceRowsRef,
} = vi.hoisted(() => ({
  currentWindowIdRef: { current: 'window-a' as string | null },
  focusExistingWindowForWorkspaceMock: vi.fn(
    async (_workspaceId: string) => false
  ),
  reportWindowWorkspacesMock: vi.fn(async () => undefined),
  reportWorkspacePresenceMock: vi.fn(async () => undefined),
  initialLayoutRef: { current: undefined as WindowLayout | undefined },
  spawnTerminalMock: vi.fn(async () => ({
    id: 'spawned-terminal',
    command: '/bin/zsh',
    status: 'running' as const,
    workspaceId: 'workspace-a',
  })),
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

vi.mock('@effect/atom-react/Hooks', () => ({
  useAtomSet: (atom: symbol) =>
    atom === Symbol.for('reportWorkspacePresence')
      ? reportWorkspacePresenceMock
      : spawnTerminalMock,
  useAtomValue: () => workspaceRowsRef.current,
}))

vi.mock('@/db/shared-state', () => ({
  projectCollection: Symbol.for('projectCollection'),
  taskCollection: Symbol.for('taskCollection'),
  workspaceViewsFromRows: () => workspaceRowsRef.current,
}))

vi.mock('@tanstack/react-db', () => ({
  useLiveQuery: (
    build: (query: {
      from: (sources: object) => { where: (predicate: unknown) => object }
    }) => object
  ) => {
    let sources: Record<string, unknown> = {}
    build({
      from: (next: object) => {
        sources = next as Record<string, unknown>
        return { where: () => next }
      },
    })
    return {
      data:
        'layout' in sources
          ? Array.from(panelLayoutCollection.values()).filter(
              ({ id }) => id === currentWindowIdRef.current
            )
          : [],
    }
  },
}))

vi.mock('@/atoms/laborer-client', () => ({
  LaborerClient: {
    mutation: vi.fn(() => Symbol('laborer-mutation')),
  },
}))

vi.mock('@/atoms/terminal-service-client', () => ({
  TerminalServiceClient: {
    mutation: vi.fn((name: string) =>
      name === 'terminal.reportWorkspacePresence'
        ? Symbol.for('reportWorkspacePresence')
        : Symbol('terminal-mutation')
    ),
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

vi.mock('@/lib/local-api', () => ({
  focusExistingWindowForWorkspace: (workspaceId: string) =>
    focusExistingWindowForWorkspaceMock(workspaceId),
  getCurrentWindowId: vi.fn(() => currentWindowIdRef.current),
  localApi: {
    get desktopBridge() {
      return currentWindowIdRef.current
        ? { reportWindowWorkspaces: reportWindowWorkspacesMock }
        : undefined
    },
  },
}))

vi.mock('@/panels/panel-group-registry', () => ({
  usePanelGroupRegistry: vi.fn(() => null),
}))

vi.mock('../src/routes/-hooks/use-initial-layout', () => ({
  useInitialLayout: vi.fn(() => initialLayoutRef.current),
}))

import { usePanelLayout } from '../src/routes/-hooks/use-panel-layout'

const makeWindowLayout = (
  paneId: string,
  workspaceId: string
): WindowLayout => ({
  activeTabId: `window-tab-${paneId}`,
  tabs: [
    {
      id: `window-tab-${paneId}`,
      label: 'Tab 1',
      workspaceLayout: {
        _tag: 'WorkspaceTileLeaf',
        activePanelTabId: `panel-tab-${paneId}`,
        id: `workspace-tile-${paneId}`,
        panelTabs: [
          {
            focusedPaneId: paneId,
            id: `panel-tab-${paneId}`,
            label: 'Terminal',
            panelLayout: {
              _tag: 'LeafNode',
              id: paneId,
              paneType: 'terminal',
              workspaceId,
            },
          },
        ],
        workspaceId,
      },
    },
  ],
})

const readStoredWindowLayout = (windowId: string): unknown =>
  panelLayoutCollection.get(windowId)?.windowLayout

const writeStoredWindowLayout = (windowId: string, windowLayout: unknown) => {
  if (panelLayoutCollection.has(windowId)) {
    panelLayoutCollection.update(windowId, (draft) => {
      draft.windowLayout = structuredClone(
        windowLayout
      ) as typeof draft.windowLayout
    })
  } else {
    panelLayoutCollection.insert({
      id: windowId,
      windowLayout: windowLayout as WindowLayout,
    })
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

const workspaceIdsInActiveTab = (layout: WindowLayout): readonly string[] => {
  const activeTab = layout.tabs.find((tab) => tab.id === layout.activeTabId)
  const collect = (node: WorkspaceTileNode): readonly string[] =>
    node._tag === 'WorkspaceTileLeaf'
      ? [node.workspaceId]
      : node.children.flatMap(collect)
  return activeTab?.workspaceLayout ? collect(activeTab.workspaceLayout) : []
}

/**
 * A tab holding two side-by-side workspaces, with focus recorded on the
 * second. Both are on screen; only the focused one is attended.
 */
const makeSplitWindowLayout = (): WindowLayout => {
  const [first, second] = ['pane-left', 'pane-right'].map((paneId, index) => ({
    _tag: 'WorkspaceTileLeaf' as const,
    activePanelTabId: `panel-tab-${paneId}`,
    id: `workspace-tile-${paneId}`,
    panelTabs: [
      {
        focusedPaneId: paneId,
        id: `panel-tab-${paneId}`,
        label: 'Terminal',
        panelLayout: {
          _tag: 'LeafNode' as const,
          id: paneId,
          paneType: 'terminal' as const,
          workspaceId: index === 0 ? 'workspace-left' : 'workspace-right',
        },
      },
    ],
    workspaceId: index === 0 ? 'workspace-left' : 'workspace-right',
  }))

  return {
    activeTabId: 'window-tab-split',
    tabs: [
      {
        focusedWorkspaceTileId: 'workspace-tile-pane-right',
        id: 'window-tab-split',
        label: 'Tab 1',
        workspaceLayout: {
          _tag: 'WorkspaceTileSplit',
          children: [first, second],
          direction: 'horizontal',
          id: 'ws-split',
          sizes: [50, 50],
        },
      },
    ],
  } as WindowLayout
}

describe('usePanelLayout', () => {
  beforeEach(() => {
    currentWindowIdRef.current = 'window-a'
    window.localStorage.clear()
    for (const windowId of ['window-a', 'window-b', 'default']) {
      if (panelLayoutCollection.has(windowId)) {
        panelLayoutCollection.delete(windowId)
      }
    }
    initialLayoutRef.current = undefined
    workspaceRowsRef.current = []
    terminalListRef.current = { isLoading: false, terminals: [] }
    focusExistingWindowForWorkspaceMock.mockReset()
    focusExistingWindowForWorkspaceMock.mockResolvedValue(false)
    reportWindowWorkspacesMock.mockClear()
    reportWorkspacePresenceMock.mockClear()
    spawnTerminalMock.mockClear()
    spawnTerminalMock.mockImplementation(async () => ({
      id: 'spawned-terminal',
      command: '/bin/zsh',
      status: 'running' as const,
      workspaceId: 'workspace-a',
    }))
    upsertTerminalListItemMock.mockClear()
  })

  afterEach(() => {
    cleanup()
    window.localStorage.clear()
  })

  it('selects only the current native-window layout', async () => {
    writeStoredWindowLayout(
      'window-a',
      makeWindowLayout('pane-window-a', 'workspace-a')
    )
    writeStoredWindowLayout(
      'window-b',
      makeWindowLayout('pane-window-b', 'workspace-b')
    )

    const { result, rerender } = renderHook(() => usePanelLayout())

    await waitFor(() => {
      expect(result.current.activePaneId).toBe('pane-window-a')
    })

    currentWindowIdRef.current = 'window-b'
    rerender()

    await waitFor(() => {
      expect(result.current.activePaneId).toBe('pane-window-b')
    })
  })

  it('reports only the focused workspace as observed', async () => {
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    writeStoredWindowLayout('window-a', makeSplitWindowLayout())

    renderHook(() => usePanelLayout())

    // Both workspaces are on screen, so reporting both would mark a
    // completion in the unfocused pane seen and hide its attention badge.
    await waitFor(() => {
      expect(reportWorkspacePresenceMock).toHaveBeenCalled()
    })
    const lastCall = reportWorkspacePresenceMock.mock.calls.at(-1)?.[0] as
      | { payload: { workspaceIds: readonly string[] } }
      | undefined
    expect(lastCall?.payload.workspaceIds).toEqual(['workspace-right'])
    hasFocus.mockRestore()
  })

  it('repairs and persists stale current-window layout pointers', async () => {
    const repairableLayout = {
      ...makeWindowLayout('pane-window-a', 'workspace-a'),
      activeTabId: 'missing-window-tab',
    }
    writeStoredWindowLayout('window-a', repairableLayout)

    const { result } = renderHook(() => usePanelLayout())

    await waitFor(() => {
      expect(result.current.activePaneId).toBe('pane-window-a')
    })
    await waitFor(() => {
      expect(
        (readStoredWindowLayout('window-a') as WindowLayout).activeTabId
      ).toBe('window-tab-pane-window-a')
    })
  })

  it('seeds only a native window with no stored layout', async () => {
    const initialLayout = makeWindowLayout('pane-seeded', 'workspace-seeded')
    const windowBLayout = makeWindowLayout('pane-window-b', 'workspace-b')
    initialLayoutRef.current = initialLayout
    writeStoredWindowLayout('window-b', windowBLayout)

    renderHook(() => usePanelLayout())

    await waitFor(() => {
      expect(readStoredWindowLayout('window-a')).toEqual(initialLayout)
    })
    expect(readStoredWindowLayout('window-b')).toEqual(windowBLayout)
  })

  it('skips terminal assignment when the workspace is already open in another window', async () => {
    const windowALayout = makeWindowLayout('pane-a', 'workspace-a')
    writeStoredWindowLayout('window-a', windowALayout)
    writeStoredWindowLayout(
      'window-b',
      makeWindowLayout('pane-b', 'workspace-c')
    )

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
    expect(readStoredWindowLayout('window-a')).toEqual(windowALayout)
  })

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
    writeStoredWindowLayout('window-a', layoutWithEmptyWorkspace)

    const { result } = renderHook(() => usePanelLayout())

    await act(async () => {
      await result.current.panelActions.assignTerminalToPane(
        'terminal-1',
        'workspace-new'
      )
    })

    // The committed layout should contain a panel tab with the terminal assigned
    const committedLayout = readStoredWindowLayout('window-a')
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
    writeStoredWindowLayout('window-a', {
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
    })
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
        'workspace-new',
        { initialPrompt: 'Investigate the Slack report.' }
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
        payload: {
          workspaceId: 'workspace-new',
          command: 'opencode2',
          initialPrompt: 'Investigate the Slack report.',
        },
      })
    })

    await waitFor(() => {
      expect(
        layoutContainsTerminal(
          readStoredWindowLayout('window-a'),
          'spawned-terminal'
        )
      ).toBe(true)
    })
  })

  it('opens a sub-workspace directly below its open parent', async () => {
    const parentLayout = makeWindowLayout('pane-parent', 'workspace-parent')
    const parentTab = parentLayout.tabs[0]
    const parentTile = parentTab?.workspaceLayout
    if (!(parentTab && parentTile)) {
      throw new Error('Expected parent layout fixture')
    }
    writeStoredWindowLayout('window-a', {
      activeTabId: 'window-tab-other',
      tabs: [
        {
          ...parentTab,
          workspaceLayout: {
            _tag: 'WorkspaceTileSplit',
            children: [
              parentTile,
              {
                _tag: 'WorkspaceTileLeaf',
                activePanelTabId: undefined,
                id: 'workspace-tile-sibling',
                panelTabs: [],
                workspaceId: 'workspace-sibling',
              },
              {
                _tag: 'WorkspaceTileLeaf',
                activePanelTabId: undefined,
                id: 'workspace-tile-child',
                panelTabs: [],
                workspaceId: 'workspace-child',
              },
            ],
            direction: 'vertical',
            id: 'workspace-stack',
            sizes: [50, 30, 20],
          },
        },
        {
          id: 'window-tab-other',
          label: 'Other tab',
          workspaceLayout: {
            _tag: 'WorkspaceTileLeaf',
            activePanelTabId: undefined,
            id: 'workspace-tile-other',
            panelTabs: [],
            workspaceId: 'workspace-other',
          },
        },
      ],
    })
    workspaceRowsRef.current = [
      {
        id: 'workspace-child',
        parentTaskId: 'workspace-parent',
        projectId: 'project-1',
        branchName: 'feature/child',
        worktreePath: '/tmp/workspace-child',
        status: 'creating',
        origin: 'laborer',
        createdAt: '2026-04-20T00:00:00.000Z',
      },
    ]

    const { result } = renderHook(() => usePanelLayout())

    act(() => {
      result.current.panelActions.autoOpenAgentWhenWorkspaceReady?.(
        'workspace-child'
      )
    })

    await waitFor(() => {
      const stored = readStoredWindowLayout('window-a') as WindowLayout
      expect(stored.activeTabId).toBe(parentTab.id)
      expect(workspaceIdsInActiveTab(stored)).toEqual([
        'workspace-parent',
        'workspace-child',
        'workspace-sibling',
      ])
      const activeTab = stored.tabs.find((tab) => tab.id === stored.activeTabId)
      const activeLayout = activeTab?.workspaceLayout
      if (activeLayout?._tag !== 'WorkspaceTileSplit') {
        throw new Error('Expected the parent workspace stack')
      }
      expect(activeLayout.sizes).toEqual([50, 20, 30])
    })
    expect(spawnTerminalMock).not.toHaveBeenCalled()
  })

  it('inserts a new sub-workspace below its parent instead of at the end', async () => {
    const parentLayout = makeWindowLayout('pane-parent', 'workspace-parent')
    const parentTab = parentLayout.tabs[0]
    const parentTile = parentTab?.workspaceLayout
    if (!(parentTab && parentTile)) {
      throw new Error('Expected parent layout fixture')
    }
    writeStoredWindowLayout('window-a', {
      activeTabId: parentTab.id,
      tabs: [
        {
          ...parentTab,
          workspaceLayout: {
            _tag: 'WorkspaceTileSplit',
            children: [
              parentTile,
              {
                _tag: 'WorkspaceTileLeaf',
                activePanelTabId: undefined,
                id: 'workspace-tile-sibling',
                panelTabs: [],
                workspaceId: 'workspace-sibling',
              },
            ],
            direction: 'vertical',
            id: 'workspace-stack',
            sizes: [70, 30],
          },
        },
      ],
    })
    workspaceRowsRef.current = [
      {
        id: 'workspace-child',
        parentTaskId: 'workspace-parent',
        projectId: 'project-1',
        branchName: 'feature/child',
        worktreePath: '/tmp/workspace-child',
        status: 'creating',
        origin: 'laborer',
        createdAt: '2026-04-20T00:00:00.000Z',
      },
    ]

    const { result } = renderHook(() => usePanelLayout())
    act(() => {
      result.current.panelActions.autoOpenAgentWhenWorkspaceReady?.(
        'workspace-child'
      )
    })

    await waitFor(() => {
      const stored = readStoredWindowLayout('window-a') as WindowLayout
      expect(workspaceIdsInActiveTab(stored)).toEqual([
        'workspace-parent',
        'workspace-child',
        'workspace-sibling',
      ])
      const activeTab = stored.tabs.find((tab) => tab.id === stored.activeTabId)
      const activeLayout = activeTab?.workspaceLayout
      if (activeLayout?._tag !== 'WorkspaceTileSplit') {
        throw new Error('Expected the parent workspace stack')
      }
      expect(activeLayout.sizes).toEqual([35, 35, 30])
    })
  })
})
