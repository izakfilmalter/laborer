import type { WindowLayout } from '@laborer/shared/types'
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useTabCloseConfirmations } from '../src/routes/-hooks/use-tab-close-confirmations'

const windowLayout: WindowLayout = {
  activeTabId: 'window-tab-active',
  tabs: [
    {
      id: 'window-tab-active',
      workspaceLayout: {
        _tag: 'WorkspaceTileLeaf',
        activePanelTabId: 'panel-tab-active',
        id: 'workspace-tile-active',
        workspaceId: 'workspace-active',
        panelTabs: [
          {
            id: 'panel-tab-active',
            panelLayout: {
              _tag: 'LeafNode',
              id: 'pane-active',
              paneType: 'terminal',
              terminalId: 'terminal-active',
              workspaceId: 'workspace-active',
            },
          },
          {
            id: 'panel-tab-inactive',
            panelLayout: {
              _tag: 'LeafNode',
              id: 'pane-inactive',
              paneType: 'terminal',
              terminalId: 'terminal-panel-inactive',
              workspaceId: 'workspace-active',
            },
          },
        ],
      },
    },
    {
      id: 'window-tab-inactive',
      workspaceLayout: {
        _tag: 'WorkspaceTileLeaf',
        activePanelTabId: 'panel-tab-window-inactive',
        id: 'workspace-tile-window-inactive',
        workspaceId: 'workspace-inactive',
        panelTabs: [
          {
            id: 'panel-tab-window-inactive',
            panelLayout: {
              _tag: 'LeafNode',
              id: 'pane-window-inactive',
              paneType: 'terminal',
              terminalId: 'terminal-window-inactive',
              workspaceId: 'workspace-inactive',
            },
          },
        ],
      },
    },
  ],
}

const runningTerminals = [
  { id: 'terminal-panel-inactive', hasChildProcess: true },
  { id: 'terminal-window-inactive', hasChildProcess: true },
]

function makeActions() {
  return {
    closeWindowTab: vi.fn(),
    removePanelTab: vi.fn(),
    switchPanelTab: vi.fn(),
    switchWindowTab: vi.fn(),
    windowLayout,
  }
}

function VisibleConfirmationHarness({ level }: { level: 'panel' | 'window' }) {
  const [layout, setLayout] = useState(windowLayout)
  const confirmations = useTabCloseConfirmations(
    {
      closeWindowTab: vi.fn(),
      removePanelTab: vi.fn(),
      switchPanelTab: (workspaceId, tabId) => {
        setLayout((current) => ({
          ...current,
          tabs: current.tabs.map((windowTab) => {
            const workspaceLayout = windowTab.workspaceLayout
            if (
              windowTab.id !== current.activeTabId ||
              workspaceLayout?._tag !== 'WorkspaceTileLeaf' ||
              workspaceLayout.workspaceId !== workspaceId
            ) {
              return windowTab
            }
            return {
              ...windowTab,
              workspaceLayout: {
                ...workspaceLayout,
                activePanelTabId: tabId,
              },
            }
          }),
        }))
      },
      switchWindowTab: (tabId) => {
        setLayout((current) => ({ ...current, activeTabId: tabId }))
      },
      windowLayout: layout,
    },
    runningTerminals
  )
  const activeWindowTab = layout.tabs.find(
    (tab) => tab.id === layout.activeTabId
  )
  const activePanelTabId =
    activeWindowTab?.workspaceLayout?._tag === 'WorkspaceTileLeaf'
      ? activeWindowTab.workspaceLayout.activePanelTabId
      : undefined

  return (
    <>
      <button
        onClick={() => {
          if (level === 'window') {
            confirmations.closeWindowTab('window-tab-inactive')
          } else {
            confirmations.removePanelTab(
              'workspace-active',
              'panel-tab-inactive'
            )
          }
        }}
        type="button"
      >
        Request close
      </button>
      <output data-testid="active-window-tab">{layout.activeTabId}</output>
      <output data-testid="active-panel-tab">{activePanelTabId}</output>
      {confirmations.pendingCloseWindowTab.tabId === layout.activeTabId && (
        <div role="alertdialog">Window tab close confirmation</div>
      )}
      {confirmations.pendingClosePanelTab.tabId === activePanelTabId && (
        <div role="alertdialog">Panel tab close confirmation</div>
      )}
    </>
  )
}

afterEach(cleanup)

describe('useTabCloseConfirmations', () => {
  it('selects an inactive panel tab before asking to close it', () => {
    const actions = makeActions()
    const { result } = renderHook(() =>
      useTabCloseConfirmations(actions, runningTerminals)
    )

    act(() => {
      result.current.removePanelTab('workspace-active', 'panel-tab-inactive')
    })

    expect(actions.switchPanelTab).toHaveBeenCalledWith(
      'workspace-active',
      'panel-tab-inactive'
    )
    expect(actions.removePanelTab).not.toHaveBeenCalled()
    expect(result.current.pendingClosePanelTab).toMatchObject({
      workspaceId: 'workspace-active',
      tabId: 'panel-tab-inactive',
    })

    act(() => {
      result.current.pendingClosePanelTab.onCancel()
    })
    expect(actions.removePanelTab).not.toHaveBeenCalled()
    expect(result.current.pendingClosePanelTab.tabId).toBeNull()

    act(() => {
      result.current.removePanelTab('workspace-active', 'panel-tab-inactive')
    })
    act(() => {
      result.current.pendingClosePanelTab.onConfirm()
    })
    expect(actions.removePanelTab).toHaveBeenCalledWith(
      'workspace-active',
      'panel-tab-inactive'
    )
  })

  it('selects an inactive window tab and confirms the close by stable id', () => {
    const actions = makeActions()
    const { result } = renderHook(() =>
      useTabCloseConfirmations(actions, runningTerminals)
    )

    act(() => {
      result.current.closeWindowTab('window-tab-inactive')
    })

    expect(actions.switchWindowTab).toHaveBeenCalledWith('window-tab-inactive')
    expect(actions.closeWindowTab).not.toHaveBeenCalled()
    expect(result.current.pendingCloseWindowTab.tabId).toBe(
      'window-tab-inactive'
    )

    act(() => {
      result.current.pendingCloseWindowTab.onCancel()
    })
    expect(actions.closeWindowTab).not.toHaveBeenCalled()
    expect(result.current.pendingCloseWindowTab.tabId).toBeNull()

    act(() => {
      result.current.closeWindowTab('window-tab-inactive')
    })
    act(() => {
      result.current.pendingCloseWindowTab.onConfirm()
    })
    expect(actions.closeWindowTab).toHaveBeenCalledWith('window-tab-inactive')
  })

  it('closes an idle inactive tab directly without switching to it', () => {
    const actions = makeActions()
    const { result } = renderHook(() => useTabCloseConfirmations(actions, []))

    act(() => {
      result.current.closeWindowTab('window-tab-inactive')
    })

    expect(actions.switchWindowTab).not.toHaveBeenCalled()
    expect(actions.closeWindowTab).toHaveBeenCalledWith('window-tab-inactive')
    expect(result.current.pendingCloseWindowTab.tabId).toBeNull()
  })

  it('keeps keyboard close targeted at the active window tab', () => {
    const actions = makeActions()
    const { result } = renderHook(() =>
      useTabCloseConfirmations(actions, [
        { id: 'terminal-active', hasChildProcess: true },
      ])
    )

    act(() => {
      result.current.closeWindowTab()
    })

    expect(actions.switchWindowTab).not.toHaveBeenCalled()
    expect(result.current.pendingCloseWindowTab.tabId).toBe('window-tab-active')

    act(() => {
      result.current.pendingCloseWindowTab.onConfirm()
    })
    expect(actions.closeWindowTab).toHaveBeenCalledWith('window-tab-active')
  })

  it.each([
    ['panel', 'panel-tab-inactive', 'Panel tab close confirmation'],
    ['window', 'window-tab-inactive', 'Window tab close confirmation'],
  ] as const)('activates an inactive %s tab before rendering its inline confirmation', (level, expectedActiveTab, dialogName) => {
    render(<VisibleConfirmationHarness level={level} />)

    fireEvent.click(screen.getByRole('button', { name: 'Request close' }))

    expect(
      screen.getByTestId(
        level === 'panel' ? 'active-panel-tab' : 'active-window-tab'
      ).textContent
    ).toBe(expectedActiveTab)
    expect(screen.getByRole('alertdialog').textContent).toBe(dialogName)
  })
})
