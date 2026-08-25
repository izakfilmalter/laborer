import type { WindowLayout, WindowTab } from '@laborer/shared/types'
import { useCallback, useMemo, useState } from 'react'
import type {
  PanelActions,
  PendingClosePanelTabState,
  PendingCloseWindowTabState,
} from '@/panels/panel-context'
import type { TerminalProcessInfo } from '@/panels/window-layout-utils'
import {
  getActiveWindowTab,
  shouldConfirmClosePanelTab,
  shouldConfirmCloseWindowTab,
} from '@/panels/window-layout-utils'
import { getWorkspaceTileLeaves } from '@/panels/workspace-tile-utils'

type TabCloseActions = Pick<
  PanelActions,
  | 'closeWindowTab'
  | 'removePanelTab'
  | 'switchPanelTab'
  | 'switchWindowTab'
  | 'windowLayout'
>

interface UseTabCloseConfirmationsResult {
  readonly closeWindowTab: (tabId?: string) => void
  readonly pendingClosePanelTab: PendingClosePanelTabState
  readonly pendingCloseWindowTab: PendingCloseWindowTabState
  readonly removePanelTab: (workspaceId: string, tabId: string) => void
}

/**
 * Gates panel-tab and window-tab closes on running-process confirmation.
 * A requested inactive tab is selected before its inline dialog is shown.
 */
export function useTabCloseConfirmations(
  actions: TabCloseActions,
  liveTerminals: readonly TerminalProcessInfo[]
): UseTabCloseConfirmationsResult {
  const [pendingPanelTab, setPendingPanelTab] = useState<{
    workspaceId: string
    tabId: string
  } | null>(null)
  const [pendingWindowTabId, setPendingWindowTabId] = useState<string | null>(
    null
  )

  const removePanelTab = useCallback(
    (workspaceId: string, tabId: string) => {
      const windowLayout = actions.windowLayout
      const activeWindowTab = windowLayout
        ? getActiveWindowTab(windowLayout)
        : undefined
      const workspaceLeaf = activeWindowTab?.workspaceLayout
        ? getWorkspaceTileLeaves(activeWindowTab.workspaceLayout).find(
            (leaf) => leaf.workspaceId === workspaceId
          )
        : undefined
      const panelTab = workspaceLeaf?.panelTabs.find((tab) => tab.id === tabId)

      if (panelTab && shouldConfirmClosePanelTab(panelTab, liveTerminals)) {
        if (workspaceLeaf?.activePanelTabId !== tabId) {
          actions.switchPanelTab?.(workspaceId, tabId)
        }
        setPendingPanelTab({ workspaceId, tabId })
        return
      }

      actions.removePanelTab?.(workspaceId, tabId)
    },
    [actions, liveTerminals]
  )

  const confirmPanelTabClose = useCallback(() => {
    if (!pendingPanelTab) {
      return
    }

    actions.removePanelTab?.(pendingPanelTab.workspaceId, pendingPanelTab.tabId)
    setPendingPanelTab(null)
  }, [actions, pendingPanelTab])

  const cancelPanelTabClose = useCallback(() => {
    setPendingPanelTab(null)
  }, [])

  const closeWindowTab = useCallback(
    (tabId?: string) => {
      const windowLayout: WindowLayout | undefined = actions.windowLayout
      let windowTab: WindowTab | undefined
      if (tabId) {
        windowTab = windowLayout?.tabs.find((tab) => tab.id === tabId)
      } else if (windowLayout) {
        windowTab = getActiveWindowTab(windowLayout)
      }

      if (windowTab && shouldConfirmCloseWindowTab(windowTab, liveTerminals)) {
        if (windowLayout?.activeTabId !== windowTab.id) {
          actions.switchWindowTab?.(windowTab.id)
        }
        setPendingWindowTabId(windowTab.id)
        return
      }

      actions.closeWindowTab?.(tabId)
    },
    [actions, liveTerminals]
  )

  const confirmWindowTabClose = useCallback(() => {
    if (!pendingWindowTabId) {
      return
    }

    actions.closeWindowTab?.(pendingWindowTabId)
    setPendingWindowTabId(null)
  }, [actions, pendingWindowTabId])

  const cancelWindowTabClose = useCallback(() => {
    setPendingWindowTabId(null)
  }, [])

  const pendingClosePanelTab = useMemo<PendingClosePanelTabState>(
    () => ({
      workspaceId: pendingPanelTab?.workspaceId ?? null,
      tabId: pendingPanelTab?.tabId ?? null,
      onConfirm: confirmPanelTabClose,
      onCancel: cancelPanelTabClose,
    }),
    [pendingPanelTab, confirmPanelTabClose, cancelPanelTabClose]
  )

  const pendingCloseWindowTab = useMemo<PendingCloseWindowTabState>(
    () => ({
      tabId: pendingWindowTabId,
      onConfirm: confirmWindowTabClose,
      onCancel: cancelWindowTabClose,
    }),
    [pendingWindowTabId, confirmWindowTabClose, cancelWindowTabClose]
  )

  return {
    closeWindowTab,
    pendingClosePanelTab,
    pendingCloseWindowTab,
    removePanelTab,
  }
}
