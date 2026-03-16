import { useAtomSet } from '@effect-atom/atom-react/Hooks'
import {
  panelLayout,
  panelTabClosed,
  panelTabCreated,
  panelTabSwitched,
  panelTabsReordered,
  windowLayoutPaneAssigned,
  windowLayoutPaneClosed,
  windowLayoutRestored,
  windowLayoutSplit,
  windowTabClosed,
  windowTabCreated,
  windowTabRenamed,
  windowTabSwitched,
  windowTabsReordered,
  workspaces,
} from '@laborer/shared/schema'
import type {
  PanelLeafNode,
  PanelTab,
  PanelTreeNode,
  PaneType,
  WindowLayout,
} from '@laborer/shared/types'
import { queryDb } from '@livestore/livestore'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LaborerClient } from '@/atoms/laborer-client'
import { TerminalServiceClient } from '@/atoms/terminal-service-client'
import {
  removeTerminalListItem,
  upsertTerminalListItem,
  useTerminalList,
} from '@/hooks/use-terminal-list'
import {
  focusExistingWindowForWorkspace,
  getCurrentWindowId,
  getDesktopBridge,
} from '@/lib/desktop'
import { useLaborerStore } from '@/livestore/store'
import { generateId } from '@/panels/id-utils'

import type { AssignTerminalToPaneOptions } from '@/panels/panel-context'
import { usePanelGroupRegistry } from '@/panels/panel-group-registry'
import {
  addPanelTab,
  removePanelTab,
  reorderPanelTabs,
  switchPanelTab,
  switchPanelTabByIndex,
  switchPanelTabRelative,
} from '@/panels/panel-tab-utils'
import type { NavigationDirection } from '@/panels/window-tab-utils'
import {
  addWindowTab,
  addWorkspaceToTabUnique,
  assignTerminalInPanelTree,
  closePaneInPanelTree,
  closeTerminalInWindowLayout,
  collectTerminalIdsFromPanelTree,
  collectTerminalIdsFromTileTree,
  computeResizePanelTree,
  findEmptyPanelTreeLeaf,
  findNewPanelTreeLeaf,
  findPanelTreeLeaf,
  findPanelTreeRootForPane,
  findSiblingPaneIdInPanelTree,
  findTerminalLocation,
  findWorkspaceLocation,
  getActiveWindowTab,
  getAllWorkspaceTileLeaves,
  getLastPanelTreeLeafId,
  getPanelTreeLeafIds,
  getStaleTerminalLeavesHierarchical,
  getWorkspaceTileLeaves,
  reconcileWindowLayout,
  removeWindowTab,
  removeWorkspaceFromLayout,
  renameWindowTab,
  reorderWindowTabs,
  repairWindowLayout,
  resolveActivePaneForWindowTab,
  resolveActiveWorkspaceForWindowTab,
  saveFocusedPaneId,
  splitPaneInPanelTree,
  switchWindowTab,
  switchWindowTabByIndex,
  switchWindowTabRelative,
  updateWorkspaceTileLeaf,
} from '@/panels/window-tab-utils'
import {
  addWorkspaceToTab,
  removeWorkspaceFromTab,
  reorderWorkspaceTiles,
} from '@/panels/workspace-tile-utils'
import { useInitialLayout } from './use-initial-layout'

/** Browser fallback until every renderer boot path has a native window ID. */
const DEFAULT_PANEL_WINDOW_ID = 'default'

/**
 * Deterministic blank session used for newly created native windows.
 * Produces a fresh `WindowLayout` with a single empty terminal pane.
 */
function createBlankWindowLayout(): WindowLayout {
  const paneId = generateId('pane')
  const panelTabId = generateId('panel-tab')
  const tileId = generateId('workspace-tile')
  const tabId = generateId('window-tab')
  return {
    tabs: [
      {
        id: tabId,
        label: 'Main',
        workspaceLayout: {
          _tag: 'WorkspaceTileLeaf',
          id: tileId,
          workspaceId: '',
          panelTabs: [
            {
              id: panelTabId,
              panelLayout: {
                _tag: 'PanelLeafNode',
                id: paneId,
                paneType: 'terminal',
              },
              focusedPaneId: paneId,
            },
          ],
          activePanelTabId: panelTabId,
        },
      },
    ],
    activeTabId: tabId,
  }
}

/** Query the persisted panel layout from LiveStore. */
const persistedLayout$ = queryDb(panelLayout, {
  label: 'persistedPanelLayout',
})

/** LiveStore query for workspaces (used by isWorkspaceContainerized). */
const allWorkspaces$ = queryDb(workspaces, { label: 'homePanelWorkspaces' })

/** Mutation atom for spawning terminals via the server's terminal.spawn RPC. */
const spawnTerminalMutation = LaborerClient.mutation('terminal.spawn')

/** Mutation atom for removing terminals via the terminal service's terminal.remove RPC. */
const removeTerminalMutation = TerminalServiceClient.mutation('terminal.remove')

/**
 * Find the workspace ID that contains a given pane ID by searching all
 * workspace tile leaves across every tab in the layout.
 */
/**
 * Look up the PanelTreeNode for a terminal at a known location.
 * Walks the window layout's tabs → workspace tiles → panel tabs
 * to resolve the exact panel tree that contains the terminal.
 */
function findPanelTreeForLocation(
  layout: WindowLayout,
  location: { tabId: string; workspaceId: string; panelTabId: string }
): PanelTreeNode | undefined {
  for (const tab of layout.tabs) {
    if (tab.id !== location.tabId || !tab.workspaceLayout) {
      continue
    }
    const leaves = getWorkspaceTileLeaves(tab.workspaceLayout)
    const tile = leaves.find((l) => l.workspaceId === location.workspaceId)
    const panelTab = tile?.panelTabs.find((t) => t.id === location.panelTabId)
    if (panelTab) {
      return panelTab.panelLayout
    }
  }
  return undefined
}

function findWorkspaceForPane(
  layout: WindowLayout,
  paneId: string
): string | undefined {
  const allLeaves = getAllWorkspaceTileLeaves(layout)
  for (const leaf of allLeaves) {
    for (const panelTab of leaf.panelTabs) {
      if (findPanelTreeLeaf(panelTab.panelLayout, paneId)) {
        return leaf.workspaceId
      }
    }
  }
  return undefined
}

/**
 * Manages the panel layout state, providing split and close actions
 * that mutate the tree and persist changes to LiveStore.
 *
 * Layout persistence flow:
 * 1. Read the persisted `WindowLayout` from LiveStore's `panelLayout` table.
 * 2. If no persisted layout exists, seed with a `WindowLayout` created
 *    directly from running terminals/workspaces.
 * 3. On split/close, compute the new tree and commit the appropriate
 *    hierarchical event (`windowLayoutSplit` / `windowLayoutPaneClosed`).
 * 4. The materializer upserts the row, and the reactive query re-fires.
 *
 * Focus is tracked exclusively within the hierarchical tree via
 * `focusedPaneId` on each `PanelTab`.
 *
 * @see Issue #73: PanelManager — serialize layout to LiveStore
 */
export function usePanelLayout() {
  const store = useLaborerStore()
  const initialLayout = useInitialLayout()
  const registry = usePanelGroupRegistry()
  const nativeWindowId = getCurrentWindowId()
  const panelWindowId = nativeWindowId ?? DEFAULT_PANEL_WINDOW_ID
  // For new native Electron windows, create a blank WindowLayout.
  // For browser/default windows, use the auto-generated layout from
  // running terminals/workspaces.
  const defaultWindowLayout = useMemo(
    () => (nativeWindowId ? createBlankWindowLayout() : initialLayout),
    [nativeWindowId, initialLayout]
  )

  // Read the persisted layout from LiveStore reactively.
  // Returns all rows; this hook still targets a single window-scoped row.
  const persistedRows = store.useQuery(persistedLayout$)
  const persistedRow = persistedRows.find(
    (row) => row.windowId === panelWindowId
  )

  // Read and repair the hierarchical window layout.
  // If the layout was repaired, we'll re-persist it.
  const windowLayoutRepair = useMemo(() => {
    const raw = persistedRow?.windowLayout
    if (!raw) {
      return {
        windowLayout: undefined as WindowLayout | undefined,
        wasRepaired: false,
      }
    }
    return repairWindowLayout(raw)
  }, [persistedRow])

  // The effective persisted window layout. Uses the repaired layout
  // from the persisted row, or undefined if no row exists.
  const persistedWindowLayout = windowLayoutRepair.windowLayout

  // Derive activePaneId from the hierarchical tree's focus state.
  // Walks: active window tab > workspace tile leaves > active panel tab > focusedPaneId.
  // Falls back to the first leaf at each level.
  // @see Issue #150: Guaranteed active pane invariant
  const persistedActivePaneId = useMemo(() => {
    if (persistedWindowLayout) {
      const activeTab = getActiveWindowTab(persistedWindowLayout)
      if (activeTab) {
        return resolveActivePaneForWindowTab(activeTab) ?? null
      }
    }
    return null
  }, [persistedWindowLayout])

  // Persist repaired window layout to LiveStore.
  // Only fires when repair was needed.
  const hasPersistedWindowRepair = useRef(false)
  useEffect(() => {
    if (
      !(
        windowLayoutRepair.wasRepaired &&
        windowLayoutRepair.windowLayout &&
        persistedRow
      ) ||
      hasPersistedWindowRepair.current
    ) {
      return
    }

    hasPersistedWindowRepair.current = true
    store.commit(
      windowLayoutRestored({
        windowId: panelWindowId,
        windowLayout: windowLayoutRepair.windowLayout,
        activeWindowTabId: windowLayoutRepair.windowLayout.activeTabId ?? null,
      })
    )
  }, [
    windowLayoutRepair.wasRepaired,
    windowLayoutRepair.windowLayout,
    persistedRow,
    panelWindowId,
    store,
  ])

  // Seed LiveStore with the initial layout when there's no persisted layout
  // but we have an auto-generated one from terminals/workspaces.
  // Creates a WindowLayout directly — no legacy PanelNode intermediary.
  // @see Issue #150: Guaranteed active pane invariant
  const hasSeeded = useRef(false)
  useEffect(() => {
    if (!persistedRow && defaultWindowLayout && !hasSeeded.current) {
      hasSeeded.current = true
      store.commit(
        windowLayoutRestored({
          windowId: panelWindowId,
          windowLayout: defaultWindowLayout,
          activeWindowTabId: defaultWindowLayout.activeTabId ?? null,
        })
      )
    }
  }, [defaultWindowLayout, panelWindowId, persistedRow, store])

  // -------------------------------------------------------------------
  // Reconcile persisted layout against live terminal state on startup.
  // -------------------------------------------------------------------
  // After a full app restart the terminal service loses its in-memory
  // state (all PTY processes are gone), but the persisted layout in
  // LiveStore/OPFS still contains stale terminal IDs. Without this
  // reconciliation, the UI renders TerminalPane components that try to
  // connect to non-existent terminals via WebSocket, producing infinite
  // reconnection loops.
  //
  // Following VS Code's approach: on startup we accept the old processes
  // are dead and spawn NEW terminals in the same workspaces. The user
  // gets immediately usable terminals instead of empty panes or error
  // states. Panes without a workspaceId (or where the spawn fails) fall
  // back to the EmptyTerminalPane CTA.
  const { terminals: liveTerminals, isLoading: terminalsLoading } =
    useTerminalList()
  const spawnTerminal = useAtomSet(spawnTerminalMutation, {
    mode: 'promise',
  })
  const removeTerminal = useAtomSet(removeTerminalMutation, {
    mode: 'promise',
  })
  // Start as "reconciling" when a persisted layout exists — this prevents
  // rendering TerminalPane components with potentially stale terminal IDs
  // before we've checked them against the live terminal service.
  const [isReconciling, setIsReconciling] = useState(
    () => persistedWindowLayout !== undefined
  )
  const hasReconciled = useRef(false)

  const removeTerminalOptimistically = useCallback(
    (terminalId: string, logContext: string) => {
      removeTerminalListItem(terminalId)
      removeTerminal({ payload: { id: terminalId } }).catch((error) => {
        console.warn(`${logContext} terminal remove failed:`, error)
      })
    },
    [removeTerminal]
  )

  /**
   * Collect stale terminal leaves from the hierarchical layout.
   */
  const collectStaleLeaves = useCallback(
    (liveIds: ReadonlySet<string>) =>
      persistedWindowLayout
        ? getStaleTerminalLeavesHierarchical(persistedWindowLayout, liveIds)
        : [],
    [persistedWindowLayout]
  )

  /**
   * Commit the reconciled hierarchical layout to LiveStore.
   */
  const commitReconciledLayouts = useCallback(
    (liveIds: ReadonlySet<string>, respawnedIds: Map<string, string>) => {
      const currentRows = store.query(persistedLayout$)
      const currentRow = currentRows.find(
        (row) => row.windowId === panelWindowId
      )

      const currentWindowLayout = currentRow?.windowLayout as
        | WindowLayout
        | undefined
      const effectiveWindowLayout = currentWindowLayout ?? persistedWindowLayout
      if (!effectiveWindowLayout) {
        return
      }

      const reconciledWindow = reconcileWindowLayout(
        effectiveWindowLayout,
        liveIds,
        respawnedIds
      )
      // Persist if the layout changed OR if this is a first-time write
      if (reconciledWindow !== currentWindowLayout) {
        store.commit(
          windowLayoutRestored({
            windowId: panelWindowId,
            windowLayout: reconciledWindow,
            activeWindowTabId: reconciledWindow.activeTabId ?? null,
          })
        )
      }
    },
    [panelWindowId, persistedWindowLayout, store]
  )

  useEffect(() => {
    if (terminalsLoading || hasReconciled.current) {
      return
    }

    if (!persistedWindowLayout) {
      hasReconciled.current = true
      setIsReconciling(false)
      return
    }

    const liveIds = new Set(liveTerminals.map((t) => t.id))
    const staleLeavesToRespawn = collectStaleLeaves(liveIds)

    if (staleLeavesToRespawn.length === 0) {
      hasReconciled.current = true
      setIsReconciling(false)
      return
    }

    // Mark as reconciled immediately to prevent re-entry during the
    // async spawn phase.
    hasReconciled.current = true

    // Spawn new terminals for stale panes sequentially, then update the
    // layout tree with the new terminal IDs.
    const respawnStaleTerminals = async () => {
      const respawnedIds = new Map<string, string>()

      for (const leaf of staleLeavesToRespawn) {
        const wsId = leaf.workspaceId
        const termId = leaf.terminalId
        if (!(wsId && termId)) {
          continue
        }
        try {
          const result = await spawnTerminal({
            payload: { workspaceId: wsId },
          })
          respawnedIds.set(termId, result.id)
          upsertTerminalListItem({
            agentStatus: null,
            args: [],
            command: result.command,
            cwd: '',
            foregroundProcess: null,
            hasChildProcess: false,
            id: result.id,
            processChain: [],
            status: result.status,
            workspaceId: wsId,
          })
        } catch (error) {
          console.error('[reconcile] spawn failed for workspace:', wsId, error)
        }
      }

      commitReconciledLayouts(liveIds, respawnedIds)
      setIsReconciling(false)
    }

    respawnStaleTerminals()
  }, [
    terminalsLoading,
    liveTerminals,
    persistedWindowLayout,
    collectStaleLeaves,
    commitReconciledLayouts,
    spawnTerminal,
  ])

  // -------------------------------------------------------------------
  // Report visible workspaces to the desktop main process.
  // -------------------------------------------------------------------
  // When the layout changes, extract the set of unique workspace IDs
  // from all workspace tile leaves and send them to the Electron main
  // process. The main process uses this to route notification clicks
  // and other workspace-targeting actions to the correct window.
  useEffect(() => {
    const bridge = getDesktopBridge()
    if (!(bridge && persistedWindowLayout)) {
      return
    }

    const allLeaves = getAllWorkspaceTileLeaves(persistedWindowLayout)
    const workspaceIds = [
      ...new Set(
        allLeaves
          .map((leaf) => leaf.workspaceId)
          .filter((id): id is string => id !== undefined)
      ),
    ]

    bridge.reportVisibleWorkspaces(workspaceIds).catch(() => {
      // Silently ignore — reporting is best-effort
    })
  }, [persistedWindowLayout])

  /**
   * Ref to hold the latest `handleAssignTerminalToPane` callback.
   * Used by `handleSplitPane` to assign a newly spawned terminal
   * without creating a circular useCallback dependency.
   */
  const assignTerminalToPaneRef = useRef<
    | ((
        terminalId: string,
        workspaceId: string,
        paneId?: string,
        options?: AssignTerminalToPaneOptions
      ) => void)
    | null
  >(null)

  const handleSplitPane = useCallback(
    (
      paneId: string,
      direction: 'horizontal' | 'vertical',
      newPaneContent?: Partial<PanelLeafNode>
    ) => {
      if (!persistedWindowLayout) {
        return
      }

      // Find the workspace containing the pane being split.
      const splitWorkspaceId = findWorkspaceForPane(
        persistedWindowLayout,
        paneId
      )
      if (!splitWorkspaceId) {
        return
      }

      // Split the panel tree directly within the active panel tab of the
      // workspace that owns the pane. Track the before/after trees so we
      // can diff-find the new leaf.
      let beforeTree: PanelTreeNode | undefined
      let afterTree: PanelTreeNode | undefined
      const updatedLayout = updateWorkspaceTileLeaf(
        persistedWindowLayout,
        splitWorkspaceId,
        (leaf) => {
          const activeTabId = leaf.activePanelTabId
          const updatedTabs = leaf.panelTabs.map((tab) => {
            if (tab.id !== activeTabId) {
              return tab
            }
            beforeTree = tab.panelLayout
            afterTree = splitPaneInPanelTree(
              tab.panelLayout,
              paneId,
              direction,
              newPaneContent
            )
            return { ...tab, panelLayout: afterTree }
          })
          return { ...leaf, panelTabs: updatedTabs }
        }
      )

      if (!(beforeTree && afterTree)) {
        return
      }

      // Find the newly created pane via leaf-diffing
      const newLeaf = findNewPanelTreeLeaf(beforeTree, afterTree)

      // Focus the new pane after splitting so the user can immediately
      // interact with it. This matches the PRD requirement: "After
      // splitting: focus lands on the new pane."
      const finalLayout = newLeaf
        ? saveFocusedPaneId(updatedLayout, newLeaf.id)
        : updatedLayout

      store.commit(
        windowLayoutSplit({
          windowId: panelWindowId,
          windowLayout: finalLayout,
          activeWindowTabId: finalLayout.activeTabId ?? null,
        })
      )

      if (!newLeaf?.workspaceId) {
        return
      }

      // Only auto-spawn a terminal for terminal-type panes.
      // Diff, review, and dev server panes handle their own content.
      const newPaneType = newPaneContent?.paneType ?? 'terminal'
      if (newPaneType !== 'terminal') {
        return
      }

      // Auto-spawn a terminal in the new pane
      const wsId = newLeaf.workspaceId
      const newPaneId = newLeaf.id
      spawnTerminal({ payload: { workspaceId: wsId } })
        .then((result) => {
          assignTerminalToPaneRef.current?.(result.id, wsId, newPaneId)
        })
        .catch((error) => {
          console.warn('[split-pane] auto-spawn failed:', error)
        })
    },
    [panelWindowId, persistedWindowLayout, store, spawnTerminal]
  )

  const handleClosePane = useCallback(
    (paneId: string) => {
      if (!persistedWindowLayout) {
        return
      }

      // Find the workspace containing the pane being closed.
      const closeWorkspaceId = findWorkspaceForPane(
        persistedWindowLayout,
        paneId
      )
      if (!closeWorkspaceId) {
        return
      }

      // Close the pane in the active panel tab's PanelTreeNode.
      // Track the closing leaf's terminal ID and sibling for focus transfer.
      // Both must be computed BEFORE the close mutation removes the pane.
      let closingTerminalId: string | undefined
      let siblingPaneId: string | undefined
      const updatedLayout = updateWorkspaceTileLeaf(
        persistedWindowLayout,
        closeWorkspaceId,
        (leaf) => {
          const activeTabId = leaf.activePanelTabId
          const updatedTabs = leaf.panelTabs.map((tab) => {
            if (tab.id !== activeTabId) {
              return tab
            }
            // Find the closing leaf to get its terminal ID
            const closingLeaf = findPanelTreeLeaf(tab.panelLayout, paneId)
            closingTerminalId = closingLeaf?.terminalId
            // Compute sibling before closing
            siblingPaneId = findSiblingPaneIdInPanelTree(
              tab.panelLayout,
              paneId
            )
            const newTree = closePaneInPanelTree(tab.panelLayout, paneId)
            if (!newTree) {
              // All panes in this tab were closed — return an empty leaf
              // so the panel tab shows the empty state CTA.
              return {
                ...tab,
                panelLayout: {
                  _tag: 'PanelLeafNode' as const,
                  id: `pane-empty-${Math.random().toString(36).slice(2, 8)}`,
                  paneType: 'terminal' as const,
                  terminalId: undefined,
                  workspaceId: leaf.workspaceId,
                },
              }
            }
            return { ...tab, panelLayout: newTree }
          })
          return { ...leaf, panelTabs: updatedTabs }
        }
      )

      // Kill terminal process associated with the closed pane.
      if (closingTerminalId) {
        removeTerminalOptimistically(closingTerminalId, '[close-pane]')
      }

      // Transfer focus to the sibling pane if the closed pane was focused.
      const finalLayout =
        persistedActivePaneId === paneId && siblingPaneId
          ? saveFocusedPaneId(updatedLayout, siblingPaneId)
          : updatedLayout

      store.commit(
        windowLayoutPaneClosed({
          windowId: panelWindowId,
          windowLayout: finalLayout,
          activeWindowTabId: finalLayout.activeTabId ?? null,
        })
      )
    },
    [
      panelWindowId,
      persistedActivePaneId,
      persistedWindowLayout,
      store,
      removeTerminalOptimistically,
    ]
  )

  const handleSetActivePaneId = useCallback(
    (paneId: string | null) => {
      if (!persistedWindowLayout) {
        return
      }
      // Resolve a valid pane ID from the hierarchical tree when null is
      // passed (e.g., by legacy code that doesn't know the active pane).
      const effectivePaneId =
        paneId ??
        (() => {
          const activeTab = getActiveWindowTab(persistedWindowLayout)
          return activeTab
            ? (resolveActivePaneForWindowTab(activeTab) ?? null)
            : null
        })()
      if (!effectivePaneId) {
        return
      }
      // Save focusedPaneId on the hierarchical layout and commit as the
      // single source of truth for focus state.
      const updated = saveFocusedPaneId(persistedWindowLayout, effectivePaneId)
      if (updated !== persistedWindowLayout) {
        store.commit(
          windowLayoutPaneAssigned({
            windowId: panelWindowId,
            windowLayout: updated,
            activeWindowTabId: updated.activeTabId ?? null,
          })
        )
      }
    },
    [panelWindowId, store, persistedWindowLayout]
  )

  /**
   * Check if a workspace is containerized by looking up its LiveStore record.
   * Used to auto-open dev server panes for containerized workspaces.
   */
  const isWorkspaceContainerized = useCallback(
    (workspaceId: string): boolean => {
      const wsList = store.query(allWorkspaces$)
      const ws = wsList.find((w) => w.id === workspaceId)
      return ws?.containerId != null
    },
    [store]
  )

  /**
   * Schedule auto-open of the dev server terminal for a containerized workspace.
   * Fire-and-forget: errors are logged but do not block the layout assignment.
   */
  const autoOpenDevServerRef = useRef<
    ((paneId: string) => Promise<boolean>) | null
  >(null)

  /**
   * Helper: ensure the workspace has a tile in the active window tab.
   * If the workspace is not in the active tab, moves it there so the
   * terminal is visible in the panel area (not just the sidebar).
   *
   * Also ensures the workspace tile has at least one panel tab so
   * terminal assignment has a tree to operate on.
   */
  const ensureWorkspaceInActiveTab = useCallback(
    (layout: WindowLayout, workspaceId: string): WindowLayout => {
      const activeTab = getActiveWindowTab(layout)
      if (!activeTab) {
        return layout
      }
      const existing = findWorkspaceLocation(layout, workspaceId)
      let result = layout
      if (existing?.tabId !== activeTab.id) {
        result = addWorkspaceToTabUnique(
          result,
          workspaceId,
          activeTab.id,
          removeWorkspaceFromTab,
          addWorkspaceToTab
        )
      }
      // Ensure the workspace tile has at least one panel tab
      result = updateWorkspaceTileLeaf(result, workspaceId, (leaf) => {
        if (leaf.panelTabs.length > 0) {
          return leaf
        }
        const newTabId = generateId('panel-tab')
        const newPaneId = generateId('pane')
        const newTab: PanelTab = {
          id: newTabId,
          panelLayout: {
            _tag: 'PanelLeafNode',
            id: newPaneId,
            paneType: 'terminal',
            workspaceId,
          },
        }
        return {
          ...leaf,
          panelTabs: [newTab],
          activePanelTabId: newTabId,
        }
      })
      return result
    },
    []
  )

  /**
   * Helper: get the active panel tab's panel layout for a workspace,
   * plus a function to write it back into the layout.
   */
  const getActivePanelTreeForWorkspace = useCallback(
    (
      layout: WindowLayout,
      workspaceId: string
    ): { panelTree: PanelTreeNode; panelTabId: string } | undefined => {
      const allLeaves = getAllWorkspaceTileLeaves(layout)
      const leaf = allLeaves.find((l) => l.workspaceId === workspaceId)
      if (!leaf) {
        return undefined
      }
      const activeTabId = leaf.activePanelTabId
      const panelTab = activeTabId
        ? leaf.panelTabs.find((t) => t.id === activeTabId)
        : leaf.panelTabs[0]
      if (!panelTab) {
        return undefined
      }
      return { panelTree: panelTab.panelLayout, panelTabId: panelTab.id }
    },
    []
  )

  /**
   * Helper: commit an assignment result and optionally auto-open the dev
   * server pane for containerized workspaces.
   */
  const commitAssignmentResult = useCallback(
    (
      layout: WindowLayout,
      focusPaneId: string,
      workspaceId: string,
      shouldAutoOpenDevServer: boolean
    ) => {
      const focusUpdated = saveFocusedPaneId(layout, focusPaneId)
      store.commit(
        windowLayoutPaneAssigned({
          windowId: panelWindowId,
          windowLayout: focusUpdated,
          activeWindowTabId: focusUpdated.activeTabId ?? null,
        })
      )

      if (shouldAutoOpenDevServer && isWorkspaceContainerized(workspaceId)) {
        autoOpenDevServerRef.current?.(focusPaneId)?.catch((error) => {
          console.warn('[auto-open] dev server spawn failed:', error)
        })
      }
    },
    [panelWindowId, store, isWorkspaceContainerized]
  )

  /**
   * Helper: navigate to an existing terminal in the hierarchical layout.
   * Switches window tab and panel tab as needed, then focuses the pane.
   * Returns true if the terminal was found and navigated to.
   */
  const navigateToExistingTerminal = useCallback(
    (terminalId: string): boolean => {
      if (!persistedWindowLayout) {
        return false
      }
      const location = findTerminalLocation(persistedWindowLayout, terminalId)
      if (!location) {
        return false
      }
      let layout = persistedWindowLayout

      // 1. Switch to the correct window tab (if not already active)
      if (layout.activeTabId !== location.tabId) {
        layout = switchWindowTab(layout, location.tabId)
        store.commit(
          windowTabSwitched({
            windowId: panelWindowId,
            windowLayout: layout,
            activeWindowTabId: layout.activeTabId ?? null,
          })
        )
      }

      // 2. Switch to the correct panel tab within the workspace
      layout = updateWorkspaceTileLeaf(layout, location.workspaceId, (leaf) =>
        switchPanelTab(leaf, location.panelTabId)
      )
      store.commit(
        panelTabSwitched({
          windowId: panelWindowId,
          windowLayout: layout,
          activeWindowTabId: layout.activeTabId ?? null,
        })
      )

      // 3. Focus the pane containing the terminal.
      const focusUpdated = saveFocusedPaneId(layout, location.paneId)
      if (focusUpdated !== layout) {
        store.commit(
          windowLayoutPaneAssigned({
            windowId: panelWindowId,
            windowLayout: focusUpdated,
            activeWindowTabId: focusUpdated.activeTabId ?? null,
          })
        )
      }
      return true
    },
    [persistedWindowLayout, panelWindowId, store]
  )

  /**
   * Helper: assign a terminal to a specific pane in the workspace's active
   * panel tab and update the panel tree. Returns the updated layout.
   */
  const assignTerminalToActivePanelTab = useCallback(
    (
      layout: WindowLayout,
      workspaceId: string,
      targetPaneId: string,
      terminalId: string
    ): WindowLayout =>
      updateWorkspaceTileLeaf(layout, workspaceId, (leaf) => {
        const activeTabId = leaf.activePanelTabId ?? leaf.panelTabs[0]?.id
        if (!activeTabId) {
          return leaf
        }
        const updatedTabs = leaf.panelTabs.map((tab) => {
          if (tab.id !== activeTabId) {
            return tab
          }
          return {
            ...tab,
            panelLayout: assignTerminalInPanelTree(
              tab.panelLayout,
              targetPaneId,
              terminalId
            ),
          }
        })
        return { ...leaf, panelTabs: updatedTabs }
      }),
    []
  )

  const handleAssignTerminalToPane = useCallback(
    async (
      terminalId: string,
      workspaceId: string,
      paneId?: string,
      options?: AssignTerminalToPaneOptions
    ) => {
      // Gate: if the workspace is already visible in another window,
      // focus that window instead of duplicating the workspace here.
      const focusedElsewhere =
        await focusExistingWindowForWorkspace(workspaceId)
      if (focusedElsewhere) {
        return
      }

      if (!persistedWindowLayout) {
        return
      }

      // If the terminal already exists in the hierarchical layout,
      // navigate to its exact location instead of creating a new pane.
      if (!paneId && navigateToExistingTerminal(terminalId)) {
        return
      }

      const shouldAutoOpenDevServer = options?.autoOpenDevServer === true

      // Ensure the workspace has a tile with a panel tab in the active window tab.
      let layout = ensureWorkspaceInActiveTab(
        persistedWindowLayout,
        workspaceId
      )

      // 1. Specific pane ID given — assign terminal to that pane directly.
      if (paneId) {
        layout = assignTerminalToActivePanelTab(
          layout,
          workspaceId,
          paneId,
          terminalId
        )
        commitAssignmentResult(
          layout,
          paneId,
          workspaceId,
          shouldAutoOpenDevServer
        )
        return
      }

      // Get the active panel tab's tree for the workspace.
      const panelInfo = getActivePanelTreeForWorkspace(layout, workspaceId)
      if (!panelInfo) {
        return
      }
      const { panelTree, panelTabId } = panelInfo

      // 2. Find an empty terminal pane and assign the terminal to it.
      const emptyLeaf = findEmptyPanelTreeLeaf(panelTree)
      if (emptyLeaf) {
        layout = assignTerminalToActivePanelTab(
          layout,
          workspaceId,
          emptyLeaf.id,
          terminalId
        )
        commitAssignmentResult(
          layout,
          emptyLeaf.id,
          workspaceId,
          shouldAutoOpenDevServer
        )
        return
      }

      // 3. No empty pane — split the last leaf and assign terminal to the new pane.
      const lastLeafId = getLastPanelTreeLeafId(panelTree)
      if (lastLeafId) {
        const newPaneContent: Partial<PanelLeafNode> = {
          paneType: 'terminal',
          terminalId,
          workspaceId,
        }
        const splitTree = splitPaneInPanelTree(
          panelTree,
          lastLeafId,
          'vertical',
          newPaneContent
        )
        const newLeaf = findNewPanelTreeLeaf(panelTree, splitTree)
        const focusPaneId = newLeaf?.id ?? lastLeafId
        layout = updateWorkspaceTileLeaf(layout, workspaceId, (leaf) => {
          const updatedTabs = leaf.panelTabs.map((tab) => {
            if (tab.id !== panelTabId) {
              return tab
            }
            return { ...tab, panelLayout: splitTree }
          })
          return { ...leaf, panelTabs: updatedTabs }
        })
        commitAssignmentResult(
          layout,
          focusPaneId,
          workspaceId,
          shouldAutoOpenDevServer
        )
        return
      }

      // Fallback — should not happen for valid trees.
      commitAssignmentResult(layout, '', workspaceId, false)
    },
    [
      persistedWindowLayout,
      ensureWorkspaceInActiveTab,
      getActivePanelTreeForWorkspace,
      navigateToExistingTerminal,
      assignTerminalToActivePanelTab,
      commitAssignmentResult,
    ]
  )

  // Keep the assign-terminal ref in sync with the latest handler
  useEffect(() => {
    assignTerminalToPaneRef.current = handleAssignTerminalToPane
  }, [handleAssignTerminalToPane])

  /**
   * Resize a pane in the given direction by adjusting the parent split's
   * sizes via the imperative GroupImperativeHandle API.
   *
   * Finds the nearest ancestor SplitNode matching the direction, computes
   * new sizes (+/- 5%), and calls `groupRef.setLayout()` to apply them.
   *
   * @see Issue #79: Keyboard shortcut — resize panes
   */
  const handleResizePane = useCallback(
    (paneId: string, direction: NavigationDirection) => {
      if (!persistedWindowLayout) {
        return
      }

      const panelTreeRoot = findPanelTreeRootForPane(
        persistedWindowLayout,
        paneId
      )
      if (!panelTreeRoot) {
        return
      }

      const result = computeResizePanelTree(panelTreeRoot, paneId, direction)
      if (!result) {
        return
      }

      const groupHandle = registry?.getGroupRef(result.splitNodeId)
      if (!groupHandle) {
        return
      }

      groupHandle.setLayout(result.newSizes)
    },
    [persistedWindowLayout, registry]
  )

  /**
   * Toggle the integrated diff sidebar on a terminal pane.
   *
   * Toggle a full-height diff panel for a workspace.
   *
   * NOTE: This is a placeholder implementation. The actual diff panel
   * toggle is handled at the route level (index.tsx) where the full-height
   * diff panel state is managed. This hook's version is overridden by
   * the route's gatedPanelActions to provide the full-height behavior.
   *
   * The diff panel now spans all workspace frames rather than being a
   * sidebar within a single terminal pane.
   *
   * @param _paneId - The pane ID (unused in this stub implementation)
   * @returns Always false since the actual implementation is in index.tsx
   */
  const handleToggleDiffPane = useCallback((_paneId: string): boolean => {
    // This is overridden by gatedPanelActions in index.tsx
    // to provide full-height diff panel behavior
    return false
  }, [])

  /**
   * Toggle the dev server terminal alongside a terminal pane.
   *
   * NOTE: Issue 8 will rewrite this as a proper panel tab toggle. This
   * intermediate implementation uses the hierarchical tree directly —
   * toggling creates/removes a `devServerTerminal` panel tab on the
   * workspace's tab list.
   *
   * @see Issue #8: Dev server terminal pane type + toggle
   */
  const handleToggleDevServerPane = useCallback(
    async (paneId: string): Promise<boolean> => {
      if (!persistedWindowLayout) {
        return false
      }

      // Find the workspace containing the pane
      const wsId = findWorkspaceForPane(persistedWindowLayout, paneId)
      if (!wsId) {
        return false
      }

      // Check if a devServerTerminal panel tab already exists for this workspace
      const allLeaves = getAllWorkspaceTileLeaves(persistedWindowLayout)
      const workspaceLeaf = allLeaves.find((l) => l.workspaceId === wsId)
      if (!workspaceLeaf) {
        return false
      }

      const existingDevTab = workspaceLeaf.panelTabs.find(
        (tab) =>
          tab.panelLayout._tag === 'PanelLeafNode' &&
          tab.panelLayout.paneType === 'devServerTerminal'
      )

      if (existingDevTab) {
        // Toggle OFF — remove the devServerTerminal panel tab
        const updatedLayout = updateWorkspaceTileLeaf(
          persistedWindowLayout,
          wsId,
          (leaf) => removePanelTab(leaf, existingDevTab.id)
        )
        store.commit(
          windowLayoutPaneAssigned({
            windowId: panelWindowId,
            windowLayout: updatedLayout,
            activeWindowTabId: updatedLayout.activeTabId ?? null,
          })
        )
        return false
      }

      // Toggle ON — create a new devServerTerminal panel tab
      const result = await spawnTerminal({
        payload: { workspaceId: wsId, autoRun: true },
      })

      // Re-read layout to avoid overwriting concurrent changes
      const currentRows = store.query(persistedLayout$)
      const currentRow = currentRows.find(
        (row) => row.windowId === panelWindowId
      )
      const currentWindowLayout =
        (currentRow?.windowLayout as WindowLayout | undefined) ??
        persistedWindowLayout
      if (!currentWindowLayout) {
        return false
      }

      const updatedLayout = updateWorkspaceTileLeaf(
        currentWindowLayout,
        wsId,
        (leaf) =>
          addPanelTab(leaf, 'devServerTerminal', { terminalId: result.id })
      )
      store.commit(
        windowLayoutPaneAssigned({
          windowId: panelWindowId,
          windowLayout: updatedLayout,
          activeWindowTabId: updatedLayout.activeTabId ?? null,
        })
      )
      return true
    },
    [persistedWindowLayout, panelWindowId, store, spawnTerminal]
  )

  // Keep the auto-open ref in sync with the latest toggle handler
  useEffect(() => {
    autoOpenDevServerRef.current = handleToggleDevServerPane
  }, [handleToggleDevServerPane])

  /**
   * Close a terminal and its associated pane (ungated — no confirmation).
   * If the terminal has no pane, removes it from the service directly.
   *
   * Searches all panel tabs across all window tabs in the hierarchical
   * layout via `closeTerminalInWindowLayout`. This handles terminals in
   * any panel tab (active or not).
   */
  const handleCloseTerminalPane = useCallback(
    (terminalId: string) => {
      if (!persistedWindowLayout) {
        removeTerminalOptimistically(terminalId, '[close-terminal-pane]')
        return
      }

      // Find the terminal's location before closing so we can transfer focus.
      const location = findTerminalLocation(persistedWindowLayout, terminalId)

      // Close the terminal pane in the hierarchical layout.
      const newLayout = closeTerminalInWindowLayout(
        persistedWindowLayout,
        terminalId
      )

      if (newLayout === persistedWindowLayout) {
        // Terminal not found in any pane — remove from service directly.
        removeTerminalOptimistically(terminalId, '[close-terminal-pane]')
        return
      }

      removeTerminalOptimistically(terminalId, '[close-terminal-pane]')

      // Transfer focus if the closed pane was the currently focused pane.
      // Use the sibling from the *original* tree (before close mutation).
      let finalLayout = newLayout
      if (location && persistedActivePaneId === location.paneId) {
        const originalTree = findPanelTreeForLocation(
          persistedWindowLayout,
          location
        )
        const siblingId = originalTree
          ? findSiblingPaneIdInPanelTree(originalTree, location.paneId)
          : undefined
        if (siblingId) {
          finalLayout = saveFocusedPaneId(newLayout, siblingId)
        }
      }

      store.commit(
        windowLayoutPaneClosed({
          windowId: panelWindowId,
          windowLayout: finalLayout,
          activeWindowTabId: finalLayout.activeTabId ?? null,
        })
      )
    },
    [
      persistedWindowLayout,
      persistedActivePaneId,
      panelWindowId,
      store,
      removeTerminalOptimistically,
    ]
  )

  /**
   * Close all panes belonging to a workspace and kill their terminals.
   * This is the ungated version — callers should check for running
   * child processes and show a confirmation dialog before invoking.
   *
   * Operates exclusively on the hierarchical `WindowLayout`:
   * 1. Finds the workspace tile leaf and collects all terminal IDs
   * 2. Kills all terminals
   * 3. Removes the workspace tile from the layout
   * 4. Commits `windowLayoutPaneClosed`
   */
  const handleCloseWorkspace = useCallback(
    (workspaceId: string) => {
      if (!persistedWindowLayout) {
        return
      }

      // Collect all terminal IDs from the workspace's panel tabs in the
      // hierarchical tree, then kill them.
      const workspaceTile = getAllWorkspaceTileLeaves(
        persistedWindowLayout
      ).find((leaf) => leaf.workspaceId === workspaceId)
      if (workspaceTile) {
        const terminalIds = workspaceTile.panelTabs.flatMap((tab) =>
          collectTerminalIdsFromPanelTree(tab.panelLayout)
        )
        for (const terminalId of terminalIds) {
          removeTerminalOptimistically(terminalId, '[close-workspace]')
        }
      }

      // Remove the workspace tile from the hierarchical layout.
      const updatedLayout = removeWorkspaceFromLayout(
        persistedWindowLayout,
        workspaceId,
        removeWorkspaceFromTab
      )

      if (updatedLayout === persistedWindowLayout) {
        // Workspace not found in the layout — nothing to commit.
        return
      }

      store.commit(
        windowLayoutPaneClosed({
          windowId: panelWindowId,
          windowLayout: updatedLayout,
          activeWindowTabId: updatedLayout.activeTabId ?? null,
        })
      )
    },
    [persistedWindowLayout, panelWindowId, store, removeTerminalOptimistically]
  )

  /**
   * Toggle a full-height review panel for a workspace.
   *
   * NOTE: This is a placeholder implementation. The actual review panel
   * toggle is handled at the route level (index.tsx) where the full-height
   * review panel state is managed. This hook's version is overridden by
   * the route's gatedPanelActions to provide the full-height behavior.
   *
   * The review panel now spans all workspace frames rather than being a
   * split within a single workspace's layout tree.
   *
   * @param _paneId - The pane ID (unused in this stub implementation)
   * @returns Always false since the actual implementation is in index.tsx
   */
  const handleToggleReviewPane = useCallback((_paneId: string): boolean => {
    // This is overridden by gatedPanelActions in index.tsx
    // to provide full-height review panel behavior
    return false
  }, [])

  // -------------------------------------------------------------------
  // Window tab actions — operate on the hierarchical WindowLayout.
  // -------------------------------------------------------------------

  /**
   * Helper to commit a window layout event to LiveStore.
   * All window tab events carry the same payload shape.
   */
  const commitWindowLayout = useCallback(
    (
      event:
        | typeof windowTabCreated
        | typeof windowTabClosed
        | typeof windowTabRenamed
        | typeof windowTabSwitched
        | typeof windowTabsReordered
        | typeof windowLayoutRestored
        | typeof windowLayoutSplit
        | typeof windowLayoutPaneClosed,
      newLayout: WindowLayout
    ) => {
      store.commit(
        event({
          windowId: panelWindowId,
          windowLayout: newLayout,
          activeWindowTabId: newLayout.activeTabId ?? null,
        })
      )
    },
    [panelWindowId, store]
  )

  /**
   * Reorder workspace frames by persisting an explicit workspace ID ordering.
   * Called when the user drag-and-drops workspace frames to rearrange them.
   *
   * Updates the WorkspaceTileNode tree within the active WindowTab.
   */
  const handleReorderWorkspaces = useCallback(
    (workspaceOrder: (string | undefined)[]) => {
      if (!persistedWindowLayout) {
        return
      }

      // Filter out undefined entries — only persist concrete workspace IDs
      const order = workspaceOrder.filter(
        (id): id is string => id !== undefined
      )

      const activeTab = getActiveWindowTab(persistedWindowLayout)
      if (!activeTab?.workspaceLayout) {
        return
      }

      const updatedTab = reorderWorkspaceTiles(activeTab, order)
      if (updatedTab !== activeTab) {
        const newLayout: WindowLayout = {
          ...persistedWindowLayout,
          tabs: persistedWindowLayout.tabs.map((tab) =>
            tab.id === activeTab.id ? updatedTab : tab
          ),
        }
        commitWindowLayout(windowLayoutRestored, newLayout)
      }
    },
    [persistedWindowLayout, commitWindowLayout]
  )

  const handleAddWindowTab = useCallback(() => {
    const base = persistedWindowLayout ?? { tabs: [], activeTabId: undefined }
    const newLayout = addWindowTab(base)
    commitWindowLayout(windowTabCreated, newLayout)
  }, [persistedWindowLayout, commitWindowLayout])

  const handleRenameWindowTab = useCallback(
    (tabId: string, label: string) => {
      if (!persistedWindowLayout) {
        return
      }
      const newLayout = renameWindowTab(persistedWindowLayout, tabId, label)
      commitWindowLayout(windowTabRenamed, newLayout)
    },
    [persistedWindowLayout, commitWindowLayout]
  )

  const handleCloseWindowTab = useCallback(() => {
    if (!persistedWindowLayout) {
      return
    }
    const activeId = persistedWindowLayout.activeTabId
    if (!activeId) {
      return
    }

    // Kill terminal processes belonging to the tab being closed.
    const closingTab = getActiveWindowTab(persistedWindowLayout)
    if (closingTab?.workspaceLayout) {
      const terminalIds = collectTerminalIdsFromTileTree(
        closingTab.workspaceLayout
      )
      for (const terminalId of terminalIds) {
        removeTerminalOptimistically(terminalId, '[close-window-tab]')
      }
    }

    const newLayout = removeWindowTab(persistedWindowLayout, activeId)
    // The hierarchical layout already has focusedPaneId saved on each
    // panel tab. Committing the tab close is sufficient — the derived
    // activePaneId will resolve from the new active tab's focus state.
    commitWindowLayout(windowTabClosed, newLayout)
  }, [persistedWindowLayout, commitWindowLayout, removeTerminalOptimistically])

  /**
   * Commit a window tab switch and restore `activePaneId` to the
   * destination tab's last-focused pane.  This ensures that keyboard
   * focus follows tab switches instead of being stranded on a pane
   * that is no longer visible.
   */
  const commitWindowTabSwitchWithFocus = useCallback(
    (newLayout: WindowLayout) => {
      // The hierarchical layout already has focusedPaneId saved on each
      // panel tab. Committing the tab switch via windowTabSwitched is
      // sufficient — the derived activePaneId will resolve from the
      // destination tab's focus state.
      commitWindowLayout(windowTabSwitched, newLayout)
    },
    [commitWindowLayout]
  )

  const handleSwitchWindowTab = useCallback(
    (tabId: string) => {
      if (!persistedWindowLayout) {
        return
      }
      const newLayout = switchWindowTab(persistedWindowLayout, tabId)
      commitWindowTabSwitchWithFocus(newLayout)
    },
    [persistedWindowLayout, commitWindowTabSwitchWithFocus]
  )

  const handleSwitchWindowTabByIndex = useCallback(
    (index: number) => {
      if (!persistedWindowLayout) {
        return
      }
      const newLayout = switchWindowTabByIndex(persistedWindowLayout, index)
      commitWindowTabSwitchWithFocus(newLayout)
    },
    [persistedWindowLayout, commitWindowTabSwitchWithFocus]
  )

  const handleSwitchWindowTabRelative = useCallback(
    (delta: number) => {
      if (!persistedWindowLayout) {
        return
      }
      const newLayout = switchWindowTabRelative(persistedWindowLayout, delta)
      commitWindowTabSwitchWithFocus(newLayout)
    },
    [persistedWindowLayout, commitWindowTabSwitchWithFocus]
  )

  const handleReorderWindowTabs = useCallback(
    (fromIndex: number, toIndex: number) => {
      if (!persistedWindowLayout) {
        return
      }
      const newLayout = reorderWindowTabs(
        persistedWindowLayout,
        fromIndex,
        toIndex
      )
      commitWindowLayout(windowTabsReordered, newLayout)
    },
    [persistedWindowLayout, commitWindowLayout]
  )

  const handleAddWorkspaceToCurrentTab = useCallback(
    async (workspaceId: string) => {
      let base = persistedWindowLayout ?? { tabs: [], activeTabId: undefined }

      // If there are no tabs (all were closed), create a new tab first
      // so the workspace has somewhere to land.
      if (base.tabs.length === 0) {
        base = addWindowTab(base)
        commitWindowLayout(windowTabCreated, base)
      }

      const activeTab = getActiveWindowTab(base)
      if (!activeTab) {
        return
      }

      // Cross-window uniqueness: if the workspace is already open in
      // another Electron window, focus that window instead.
      const focusedElsewhere =
        await focusExistingWindowForWorkspace(workspaceId)
      if (focusedElsewhere) {
        return
      }

      // Within-window uniqueness: if the workspace already exists in
      // another tab, remove it from the old tab before adding.  If it
      // already lives in the active tab, this is a no-op.
      const existing = findWorkspaceLocation(base, workspaceId)
      if (existing?.tabId === activeTab.id) {
        // Already in the target tab — nothing to do
        return
      }

      const newLayout = addWorkspaceToTabUnique(
        base,
        workspaceId,
        activeTab.id,
        removeWorkspaceFromTab,
        addWorkspaceToTab
      )

      commitWindowLayout(windowLayoutRestored, newLayout)
    },
    [persistedWindowLayout, commitWindowLayout]
  )

  // -------------------------------------------------------------------
  // Panel tab actions — operate on workspaces within the WindowLayout.
  // -------------------------------------------------------------------

  /**
   * Helper to commit a panel tab layout event to LiveStore.
   * All panel tab events carry the same window layout payload shape.
   */
  const commitPanelTabLayout = useCallback(
    (
      event:
        | typeof panelTabCreated
        | typeof panelTabClosed
        | typeof panelTabSwitched
        | typeof panelTabsReordered,
      newLayout: WindowLayout
    ) => {
      store.commit(
        event({
          windowId: panelWindowId,
          windowLayout: newLayout,
          activeWindowTabId: newLayout.activeTabId ?? null,
        })
      )
    },
    [panelWindowId, store]
  )

  const handleAddPanelTab = useCallback(
    (
      workspaceId: string,
      panelType: PaneType,
      options?: { terminalId?: string }
    ) => {
      let base = persistedWindowLayout ?? {
        tabs: [] as WindowLayout['tabs'],
        activeTabId: undefined,
      }

      // If there are no window tabs (all were closed), create one so
      // the workspace has somewhere to land.
      if (base.tabs.length === 0) {
        base = addWindowTab(base)
        commitWindowLayout(windowTabCreated, base)
      }

      // Ensure the workspace exists in the active window tab. If it
      // doesn't (e.g. "Empty tab" state), add it first.
      const activeTab = getActiveWindowTab(base)
      if (!activeTab) {
        return
      }
      const existing = findWorkspaceLocation(base, workspaceId)
      if (existing?.tabId !== activeTab.id) {
        base = addWorkspaceToTabUnique(
          base,
          workspaceId,
          activeTab.id,
          removeWorkspaceFromTab,
          addWorkspaceToTab
        )
        commitWindowLayout(windowLayoutRestored, base)
      }

      let newPaneId: string | undefined
      const newLayout = updateWorkspaceTileLeaf(base, workspaceId, (leaf) => {
        const updated = addPanelTab(
          leaf,
          panelType,
          options?.terminalId ? { terminalId: options.terminalId } : undefined
        )
        // The newly added tab is always the last one and is set as active
        const newTab = updated.panelTabs.at(-1)
        if (newTab?.panelLayout._tag === 'PanelLeafNode') {
          newPaneId = newTab.panelLayout.id
        }
        return updated
      })
      commitPanelTabLayout(panelTabCreated, newLayout)

      // Auto-spawn a terminal for terminal-type panel tabs, mirroring
      // the split-pane behaviour at handleSplitPane — but skip if the
      // caller already provided a terminal ID (e.g. sidebar spawn).
      if (panelType === 'terminal' && newPaneId && !options?.terminalId) {
        const paneId = newPaneId
        // Capture the layout that was just committed — the `.then()`
        // callback fires asynchronously and `persistedWindowLayout`
        // may be stale, but `newLayout` is the exact layout we just
        // committed with the empty pane.
        const layoutSnapshot = newLayout

        spawnTerminal({ payload: { workspaceId } })
          .then((result) => {
            // Directly update the hierarchical layout to assign the
            // terminal to the pane. Going through the legacy
            // `assignTerminalToPane` doesn't work here because the
            // pane ID only exists in the hierarchical layout, not in
            // the legacy `persistedLayoutTree`.
            const updated = updateWorkspaceTileLeaf(
              layoutSnapshot,
              workspaceId,
              (leaf) => ({
                ...leaf,
                panelTabs: leaf.panelTabs.map((tab) => ({
                  ...tab,
                  panelLayout: assignTerminalInPanelTree(
                    tab.panelLayout,
                    paneId,
                    result.id
                  ),
                })),
              })
            )
            commitPanelTabLayout(panelTabCreated, updated)
          })
          .catch((error) => {
            console.warn('[add-panel-tab] auto-spawn failed:', error)
          })
      }
    },
    [
      persistedWindowLayout,
      commitPanelTabLayout,
      commitWindowLayout,
      spawnTerminal,
    ]
  )

  const handleRemovePanelTab = useCallback(
    (workspaceId: string, tabId: string) => {
      if (!persistedWindowLayout) {
        return
      }

      // Kill terminal processes owned by the panel tab being removed.
      const activeTab = getActiveWindowTab(persistedWindowLayout)
      const tileLayout = activeTab?.workspaceLayout
      if (tileLayout) {
        const leaves = getWorkspaceTileLeaves(tileLayout)
        const leaf = leaves.find((l) => l.workspaceId === workspaceId)
        const panelTab = leaf?.panelTabs.find((t) => t.id === tabId)
        if (panelTab) {
          const terminalIds = collectTerminalIdsFromPanelTree(
            panelTab.panelLayout
          )
          for (const terminalId of terminalIds) {
            removeTerminalOptimistically(terminalId, '[close-panel-tab]')
          }
        }
      }

      const newLayout = updateWorkspaceTileLeaf(
        persistedWindowLayout,
        workspaceId,
        (leaf) => removePanelTab(leaf, tabId)
      )
      commitPanelTabLayout(panelTabClosed, newLayout)
    },
    [persistedWindowLayout, commitPanelTabLayout, removeTerminalOptimistically]
  )

  /**
   * Commit a panel tab switch and restore `activePaneId` to the
   * destination panel tab's last-focused pane. This ensures keyboard
   * focus follows panel tab switches.
   */
  const commitPanelTabSwitchWithFocus = useCallback(
    (newLayout: WindowLayout, _workspaceId: string) => {
      // The hierarchical layout already has focusedPaneId saved on each
      // panel tab. Committing the panel tab switch is sufficient — the
      // derived activePaneId will resolve from the destination tab's focus.
      commitPanelTabLayout(panelTabSwitched, newLayout)
    },
    [commitPanelTabLayout]
  )

  const handleSwitchPanelTab = useCallback(
    (workspaceId: string, tabId: string) => {
      if (!persistedWindowLayout) {
        return
      }
      const newLayout = updateWorkspaceTileLeaf(
        persistedWindowLayout,
        workspaceId,
        (leaf) => switchPanelTab(leaf, tabId)
      )
      commitPanelTabSwitchWithFocus(newLayout, workspaceId)
    },
    [persistedWindowLayout, commitPanelTabSwitchWithFocus]
  )

  const handleSwitchPanelTabByIndex = useCallback(
    (workspaceId: string, index: number) => {
      if (!persistedWindowLayout) {
        return
      }
      const newLayout = updateWorkspaceTileLeaf(
        persistedWindowLayout,
        workspaceId,
        (leaf) => switchPanelTabByIndex(leaf, index)
      )
      commitPanelTabSwitchWithFocus(newLayout, workspaceId)
    },
    [persistedWindowLayout, commitPanelTabSwitchWithFocus]
  )

  const handleSwitchPanelTabRelative = useCallback(
    (workspaceId: string, delta: number) => {
      if (!persistedWindowLayout) {
        return
      }
      const newLayout = updateWorkspaceTileLeaf(
        persistedWindowLayout,
        workspaceId,
        (leaf) => switchPanelTabRelative(leaf, delta)
      )
      commitPanelTabSwitchWithFocus(newLayout, workspaceId)
    },
    [persistedWindowLayout, commitPanelTabSwitchWithFocus]
  )

  const handleReorderPanelTabs = useCallback(
    (workspaceId: string, fromIndex: number, toIndex: number) => {
      if (!persistedWindowLayout) {
        return
      }
      const newLayout = updateWorkspaceTileLeaf(
        persistedWindowLayout,
        workspaceId,
        (leaf) => reorderPanelTabs(leaf, fromIndex, toIndex)
      )
      commitPanelTabLayout(panelTabsReordered, newLayout)
    },
    [persistedWindowLayout, commitPanelTabLayout]
  )

  const panelActions = useMemo(
    () => ({
      addPanelTab: handleAddPanelTab,
      assignTerminalToPane: handleAssignTerminalToPane,
      splitPane: handleSplitPane,
      closePane: handleClosePane,
      closeWorkspace: handleCloseWorkspace,
      forceCloseWorkspace: handleCloseWorkspace,
      setActivePaneId: handleSetActivePaneId,
      toggleDiffPane: handleToggleDiffPane,
      toggleDevServerPane: handleToggleDevServerPane,
      toggleReviewPane: handleToggleReviewPane,
      resizePane: handleResizePane,
      closeTerminalPane: handleCloseTerminalPane,
      removePanelTab: handleRemovePanelTab,
      reorderPanelTabsDnd: handleReorderPanelTabs,
      reorderWorkspaces: handleReorderWorkspaces,
      addWorkspaceToCurrentTab: handleAddWorkspaceToCurrentTab,
      addWindowTab: handleAddWindowTab,
      closeWindowTab: handleCloseWindowTab,
      renameWindowTab: handleRenameWindowTab,
      switchWindowTab: handleSwitchWindowTab,
      switchWindowTabByIndex: handleSwitchWindowTabByIndex,
      switchWindowTabRelative: handleSwitchWindowTabRelative,
      switchPanelTab: handleSwitchPanelTab,
      switchPanelTabByIndex: handleSwitchPanelTabByIndex,
      switchPanelTabRelative: handleSwitchPanelTabRelative,
      reorderWindowTabsDnd: handleReorderWindowTabs,
      showPanelTypePicker: undefined,
      windowLayout: persistedWindowLayout,
    }),
    [
      handleAddPanelTab,
      handleAssignTerminalToPane,
      handleSplitPane,
      handleClosePane,
      handleCloseWorkspace,
      handleSetActivePaneId,
      handleToggleDiffPane,
      handleToggleDevServerPane,
      handleToggleReviewPane,
      handleResizePane,
      handleCloseTerminalPane,
      handleRemovePanelTab,
      handleReorderPanelTabs,
      handleReorderWorkspaces,
      handleAddWorkspaceToCurrentTab,
      handleAddWindowTab,
      handleCloseWindowTab,
      handleRenameWindowTab,
      handleSwitchWindowTab,
      handleSwitchWindowTabByIndex,
      handleSwitchWindowTabRelative,
      handleSwitchPanelTab,
      handleSwitchPanelTabByIndex,
      handleSwitchPanelTabRelative,
      handleReorderWindowTabs,
      persistedWindowLayout,
    ]
  )

  // Compute leaf pane IDs for keyboard navigation from the active panel tab's
  // hierarchical tree. Falls back to empty array when no layout exists.
  const leafPaneIds = useMemo(() => {
    if (!persistedWindowLayout) {
      return []
    }
    const activeTab = getActiveWindowTab(persistedWindowLayout)
    if (!activeTab) {
      return []
    }
    const leaves = getWorkspaceTileLeaves(
      activeTab.workspaceLayout ?? {
        _tag: 'WorkspaceTileLeaf',
        id: '',
        workspaceId: '',
        panelTabs: [],
      }
    )
    // Collect leaf pane IDs from the active panel tab of each workspace tile
    return leaves.flatMap((leaf) => {
      const activeTabId = leaf.activePanelTabId ?? leaf.panelTabs[0]?.id
      const panelTab = activeTabId
        ? leaf.panelTabs.find((t) => t.id === activeTabId)
        : leaf.panelTabs[0]
      return panelTab ? getPanelTreeLeafIds(panelTab.panelLayout) : []
    })
  }, [persistedWindowLayout])

  // Derive the active workspace ID from the hierarchical tree's focus state.
  // Walks the active window tab's workspace tile leaves to find which
  // workspace contains the currently focused pane.
  const activeWorkspaceId = useMemo(() => {
    if (!persistedWindowLayout) {
      return null
    }
    const activeTab = getActiveWindowTab(persistedWindowLayout)
    if (!activeTab) {
      return null
    }
    return resolveActiveWorkspaceForWindowTab(activeTab) ?? null
  }, [persistedWindowLayout])

  return {
    panelActions,
    activePaneId: persistedActivePaneId,
    activeWorkspaceId,
    leafPaneIds,
    isReconciling,
    liveTerminals,
  }
}
