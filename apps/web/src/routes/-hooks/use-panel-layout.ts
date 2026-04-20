import { useAtomSet } from '@effect-atom/atom-react/Hooks'
import {
  panelLayout,
  windowLayoutUpdated,
  workspaces,
} from '@laborer/shared/schema'
import type {
  LeafNode,
  PanelNode,
  PaneType,
  WindowLayout,
} from '@laborer/shared/types'
import { queryDb } from '@livestore/livestore'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LaborerClient } from '@/atoms/laborer-client'
import { TerminalServiceClient } from '@/atoms/terminal-service-client'
import { useSpawnTerminal } from '@/hooks/use-spawn-terminal'
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
import type { NavigationDirection } from '@/panels/panel-tree-utils'
import {
  assignTerminal as assignTerminalInPanelTree,
  closePane as closePaneInTree,
  collectTerminalIds as collectTerminalIdsFromPanelTree,
  computeResize,
  findLeaf,
  findNewLeafAfterSplit,
  findSiblingPaneId,
  getLeafIds as getPanelTreeLeafIds,
  splitPane as splitPaneInTree,
  updateLeafType as updateLeafTypeInTree,
} from '@/panels/panel-tree-utils'
import {
  createSpawnGuard,
  respawnStaleTerminals,
  retryOnInitializing,
} from '@/panels/reconcile-spawn'
import {
  addWindowTab,
  addWorkspaceToTabUnique,
  closeTerminalInWindowLayout,
  collectTerminalIdsFromTileTree,
  decodeWindowLayout,
  findTerminalLocation,
  findWorkspaceLocation,
  getActiveTabLeafIds,
  getActiveWindowTab,
  getAllWorkspaceTileLeaves,
  getStaleTerminalLeavesHierarchical,
  reconcileWindowLayout,
  removeWindowTab,
  removeWorkspaceFromLayout,
  renameWindowTab,
  reorderWindowTabs,
  resolveActivePaneForPanelTab,
  resolveActivePaneForWindowTab,
  saveFocusedPaneId,
  switchWindowTab,
  switchWindowTabByIndex,
  switchWindowTabRelative,
  updateWorkspaceTileLeaf,
} from '@/panels/window-layout-utils'
import {
  addWorkspaceToTab,
  getWorkspaceTileLeaves,
  removeWorkspaceFromTab,
  reorderWorkspaceTiles,
} from '@/panels/workspace-tile-utils'
import { useInitialLayout } from './use-initial-layout'

/** Browser fallback until every renderer boot path has a native window ID. */
const DEFAULT_PANEL_WINDOW_ID = 'default'

/**
 * Close a pane in the hierarchical layout by searching all workspace tile
 * leaves' active panel tabs. Returns the updated layout and terminal IDs
 * to remove.
 */
function closePaneInLayout(
  windowLayout: WindowLayout,
  paneId: string
): {
  resultLayout: WindowLayout
  paneFound: boolean
  terminalIdsToRemove: readonly string[]
} {
  const allLeaves = getAllWorkspaceTileLeaves(windowLayout)
  for (const wsLeaf of allLeaves) {
    const activePanelTab = wsLeaf.panelTabs.find(
      (t) => t.id === wsLeaf.activePanelTabId
    )
    if (!activePanelTab) {
      continue
    }
    const paneNode = findLeaf(activePanelTab.panelLayout, paneId)
    if (!paneNode) {
      continue
    }

    const terminalIdsToRemove: string[] = []
    if (paneNode.terminalId) {
      terminalIdsToRemove.push(paneNode.terminalId)
    }

    const siblingId = findSiblingPaneId(activePanelTab.panelLayout, paneId)
    const newTree = closePaneInTree(activePanelTab.panelLayout, paneId)
    if (newTree) {
      const resultLayout = updateWorkspaceTileLeaf(
        windowLayout,
        wsLeaf.workspaceId,
        (leaf) => ({
          ...leaf,
          panelTabs: leaf.panelTabs.map((tab) =>
            tab.id === activePanelTab.id
              ? {
                  ...tab,
                  panelLayout: newTree,
                  focusedPaneId: siblingId ?? tab.focusedPaneId,
                }
              : tab
          ),
        })
      )
      return { resultLayout, paneFound: true, terminalIdsToRemove }
    }
    // Last pane in the panel tab — remove the panel tab entirely.
    const resultLayout = updateWorkspaceTileLeaf(
      windowLayout,
      wsLeaf.workspaceId,
      (leaf) => removePanelTab(leaf, activePanelTab.id)
    )
    return { resultLayout, paneFound: true, terminalIdsToRemove }
  }
  return {
    resultLayout: windowLayout,
    paneFound: false,
    terminalIdsToRemove: [],
  }
}

/**
 * Find the workspace tile leaf that contains a given pane.
 */
function findWorkspaceForPane(
  windowLayout: WindowLayout,
  paneId: string
): import('@laborer/shared/types').WorkspaceTileLeaf | undefined {
  const allLeaves = getAllWorkspaceTileLeaves(windowLayout)
  for (const wsLeaf of allLeaves) {
    for (const panelTab of wsLeaf.panelTabs) {
      if (findLeaf(panelTab.panelLayout, paneId)) {
        return wsLeaf
      }
    }
  }
  return undefined
}

/**
 * Ensure a workspace exists in the active window tab. If it doesn't,
 * move it from its current location.
 */
function ensureWorkspaceInActiveTab(
  windowLayout: WindowLayout,
  workspaceId: string
): WindowLayout {
  const activeTab = getActiveWindowTab(windowLayout)
  if (!activeTab) {
    return windowLayout
  }
  const existing = findWorkspaceLocation(windowLayout, workspaceId)
  if (existing?.tabId === activeTab.id) {
    return windowLayout
  }
  return addWorkspaceToTabUnique(
    windowLayout,
    workspaceId,
    activeTab.id,
    removeWorkspaceFromTab,
    addWorkspaceToTab
  )
}

/**
 * Navigate to a terminal's exact location in the hierarchical layout.
 * Switches window tab, panel tab, and saves focus.
 */
function navigateToTerminal(
  windowLayout: WindowLayout,
  terminalId: string
): WindowLayout | undefined {
  const location = findTerminalLocation(windowLayout, terminalId)
  if (!location) {
    return undefined
  }
  let result = windowLayout
  if (result.activeTabId !== location.tabId) {
    result = switchWindowTab(result, location.tabId)
  }
  result = updateWorkspaceTileLeaf(result, location.workspaceId, (leaf) =>
    switchPanelTab(leaf, location.panelTabId)
  )
  return saveFocusedPaneId(result, location.paneId)
}

/**
 * Find an empty terminal pane in a panel tree.
 * An empty terminal pane is a LeafNode with paneType 'terminal' and no
 * terminalId assigned. Returns the pane ID if found.
 */
function findEmptyTerminalPaneInTree(node: PanelNode): string | undefined {
  if (node._tag === 'LeafNode') {
    return node.paneType === 'terminal' && node.terminalId === undefined
      ? node.id
      : undefined
  }
  for (const child of node.children) {
    const found = findEmptyTerminalPaneInTree(child)
    if (found) {
      return found
    }
  }
  return undefined
}

/**
 * Assign a terminal to a pane in a workspace's active panel tab.
 * If a specific paneId is given, assigns to that pane.
 * If no paneId is given, finds an empty pane or splits to create one.
 * Returns the updated layout and the focused pane ID.
 */
function assignTerminalInWorkspace(
  baseLayout: WindowLayout,
  workspaceId: string,
  terminalId: string,
  paneId: string | undefined
): { layout: WindowLayout; focusPaneId: string | undefined } {
  if (paneId) {
    const updated = updateWorkspaceTileLeaf(
      baseLayout,
      workspaceId,
      (leaf) => ({
        ...leaf,
        panelTabs: leaf.panelTabs.map((tab) => ({
          ...tab,
          panelLayout: assignTerminalInPanelTree(
            tab.panelLayout,
            paneId,
            terminalId
          ),
        })),
      })
    )
    return { layout: saveFocusedPaneId(updated, paneId), focusPaneId: paneId }
  }

  // Find the workspace leaf and its active panel tab
  const allLeaves = getAllWorkspaceTileLeaves(baseLayout)
  const wsLeaf = allLeaves.find((l) => l.workspaceId === workspaceId)
  if (!wsLeaf) {
    return { layout: baseLayout, focusPaneId: undefined }
  }

  const activePTab = wsLeaf.panelTabs.find(
    (t) => t.id === wsLeaf.activePanelTabId
  )
  if (!activePTab) {
    // Workspace has no panel tabs — create one with the terminal pre-assigned.
    // This handles the case where a workspace tile was added to the layout
    // (via addWorkspaceToTab) but no terminal panel tab was created yet.
    const updated = updateWorkspaceTileLeaf(baseLayout, workspaceId, (leaf) =>
      addPanelTab(leaf, 'terminal', { terminalId })
    )
    // Resolve the new pane ID for focus
    const updatedLeaves = getAllWorkspaceTileLeaves(updated)
    const updatedWsLeaf = updatedLeaves.find(
      (l) => l.workspaceId === workspaceId
    )
    const newTab = updatedWsLeaf?.panelTabs.at(-1)
    const newPaneId =
      newTab?.panelLayout._tag === 'LeafNode'
        ? newTab.panelLayout.id
        : undefined
    return {
      layout: newPaneId ? saveFocusedPaneId(updated, newPaneId) : updated,
      focusPaneId: newPaneId,
    }
  }

  // Look for an empty terminal pane
  const emptyPaneId = findEmptyTerminalPaneInTree(activePTab.panelLayout)
  if (emptyPaneId) {
    const updated = updateWorkspaceTileLeaf(
      baseLayout,
      workspaceId,
      (leaf) => ({
        ...leaf,
        panelTabs: leaf.panelTabs.map((tab) =>
          tab.id === activePTab.id
            ? {
                ...tab,
                panelLayout: assignTerminalInPanelTree(
                  tab.panelLayout,
                  emptyPaneId,
                  terminalId
                ),
              }
            : tab
        ),
      })
    )
    return {
      layout: saveFocusedPaneId(updated, emptyPaneId),
      focusPaneId: emptyPaneId,
    }
  }

  // No empty pane — split and assign
  const paneIds = getPanelTreeLeafIds(activePTab.panelLayout)
  const lastPaneId = paneIds.at(-1)
  if (!lastPaneId) {
    return { layout: baseLayout, focusPaneId: undefined }
  }

  const oldTree = activePTab.panelLayout
  const newTree = splitPaneInTree(oldTree, lastPaneId, 'vertical', {
    paneType: 'terminal',
    terminalId,
    workspaceId,
  })
  const newLeaf = findNewLeafAfterSplit(oldTree, newTree)
  const updated = updateWorkspaceTileLeaf(baseLayout, workspaceId, (leaf) => ({
    ...leaf,
    panelTabs: leaf.panelTabs.map((tab) =>
      tab.id === activePTab.id
        ? {
            ...tab,
            panelLayout: newTree,
            focusedPaneId: newLeaf?.id ?? tab.focusedPaneId,
          }
        : tab
    ),
  }))
  const focusId = newLeaf?.id
  return {
    layout: focusId ? saveFocusedPaneId(updated, focusId) : updated,
    focusPaneId: focusId,
  }
}

/**
 * Module-level spawn guard — prevents concurrent terminal spawns for the
 * same pane. Follows VS Code's `_isTerminalBeingCreated` pattern.
 * @see reconcile-spawn.ts — createSpawnGuard
 */
const paneSpawnGuard = createSpawnGuard()

/** Query the persisted panel layout from LiveStore. */
const persistedLayout$ = queryDb(panelLayout, {
  label: 'persistedPanelLayout',
})

/** LiveStore query for workspaces (used by isWorkspaceContainerized). */
const allWorkspaces$ = queryDb(workspaces, { label: 'homePanelWorkspaces' })

/** Mutation atom for fetching the project config (used imperatively to resolve the agent provider). */
const configGetMutation = LaborerClient.mutation('config.get')

/**
 * Daytona terminal IDs are prefixed with `daytona:` so the correct
 * RPC endpoint (server vs terminal utility process) can be selected.
 */
const DAYTONA_TERMINAL_PREFIX = 'daytona:'

/** Mutation atom for removing local (Docker/host) terminals via the terminal utility process. */
const localRemoveTerminalMutation =
  TerminalServiceClient.mutation('terminal.remove')

/** Mutation atom for removing Daytona terminals via the server (LaborerRpcs). */
const daytonaRemoveTerminalMutation = LaborerClient.mutation('terminal.remove')

/**
 * Manages the panel layout state, providing split and close actions
 * that mutate the `WindowLayout` and persist changes to LiveStore.
 *
 * Layout persistence flow:
 * 1. Read the persisted `WindowLayout` from LiveStore's `panelLayout` table.
 * 2. If no persisted layout exists, seed from the auto-generated
 *    `WindowLayout` (via `useInitialLayout`) and commit it as a
 *    `windowLayoutUpdated` event.
 * 3. On mutations (split, close, assign, etc.), compute the new
 *    `WindowLayout` and commit a single `windowLayoutUpdated` event.
 * 4. The materializer upserts the row, and the reactive query re-fires.
 */
export function usePanelLayout() {
  const store = useLaborerStore()
  const initialLayout = useInitialLayout()
  const registry = usePanelGroupRegistry()
  const nativeWindowId = getCurrentWindowId()
  const panelWindowId = nativeWindowId ?? DEFAULT_PANEL_WINDOW_ID

  // Read the persisted layout from LiveStore reactively.
  // Returns all rows; this hook still targets a single window-scoped row.
  const persistedRows = store.useQuery(persistedLayout$)
  const persistedRow = persistedRows.find(
    (row) => row.windowId === panelWindowId
  )

  // Read and decode the hierarchical window layout from the persisted row.
  // Uses Effect Schema decode with repair transforms. If the layout was
  // repaired, we'll re-persist it.
  const windowLayoutRepair = useMemo(() => {
    const raw = persistedRow?.windowLayout
    if (!raw) {
      return {
        windowLayout: undefined as WindowLayout | undefined,
        wasRepaired: false,
      }
    }
    return decodeWindowLayout(raw)
  }, [persistedRow])

  // The hierarchical WindowLayout is the single source of truth.
  const persistedWindowLayout = windowLayoutRepair.windowLayout
  const workspaceList = store.useQuery(allWorkspaces$)
  const pendingAgentAutoOpenWorkspaceIdsRef = useRef<Set<string>>(new Set())

  // Derive the active pane ID exclusively from the hierarchical layout.
  // Walks: active window tab > active workspace tile > active panel tab >
  // focusedPaneId. Falls back at each level if the preferred value is
  // unavailable. Returns null when there is no layout.
  const persistedActivePaneId = useMemo(() => {
    if (!persistedWindowLayout) {
      return null
    }
    const activeTab = getActiveWindowTab(persistedWindowLayout)
    if (!activeTab) {
      return null
    }
    return resolveActivePaneForWindowTab(activeTab) ?? null
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
      windowLayoutUpdated({
        windowId: panelWindowId,
        windowLayout: windowLayoutRepair.windowLayout,
        reason: 'window-layout-repair',
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
  // `useInitialLayout` returns a complete `WindowLayout` ready to commit.
  const hasSeeded = useRef(false)
  useEffect(() => {
    if (!persistedRow && initialLayout && !hasSeeded.current) {
      hasSeeded.current = true
      store.commit(
        windowLayoutUpdated({
          windowId: panelWindowId,
          windowLayout: initialLayout,
          reason: 'seed',
        })
      )
    }
  }, [initialLayout, panelWindowId, persistedRow, store])

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
  // Use an independent spawner so concurrent spawns for different panes
  // don't interrupt each other. The mutation atom (AtomResultFn) operates
  // in "latest-wins" mode — calling it a second time interrupts the first
  // in-flight fiber, causing the first spawn to silently fail. This
  // follows VS Code's architecture where each TerminalInstance owns its
  // own TerminalProcessManager for fully independent process creation.
  // @see .reference/vscode/src/vs/workbench/contrib/terminal/browser/terminalProcessManager.ts
  const spawnTerminal = useSpawnTerminal()
  const getConfig = useAtomSet(configGetMutation, {
    mode: 'promise',
  })
  const removeTerminalLocal = useAtomSet(localRemoveTerminalMutation, {
    mode: 'promise',
  })
  const removeTerminalDaytona = useAtomSet(daytonaRemoveTerminalMutation, {
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
      const removeTerminal = terminalId.startsWith(DAYTONA_TERMINAL_PREFIX)
        ? removeTerminalDaytona
        : removeTerminalLocal
      removeTerminal({ payload: { id: terminalId } }).catch((error) => {
        // Silently ignore "not found" — the terminal was already removed
        // by another close path (e.g., progressive close escalation).
        // Follows VS Code's idempotent disposal pattern where calling
        // dispose() on an already-disposed instance is a no-op.
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('not found') || message.includes('NOT_FOUND')) {
          return
        }
        console.warn(`${logContext} terminal remove failed:`, error)
      })
    },
    [removeTerminalLocal, removeTerminalDaytona]
  )

  /**
   * Cancel in-flight spawns and kill assigned terminals for all panes in
   * a panel tree. Used by close handlers to ensure no orphaned terminals
   * survive when a pane, panel tab, or workspace is removed.
   *
   * Follows VS Code's `TerminalProcessManager.dispose()` pattern: marks
   * spawns as cancelled so the async `.then()` handler kills the orphaned
   * terminal instead of assigning it.
   */
  const cancelSpawnsAndKillTerminals = useCallback(
    (panelLayout: PanelNode, logContext: string) => {
      const paneIds = getPanelTreeLeafIds(panelLayout)
      for (const leafPaneId of paneIds) {
        if (paneSpawnGuard.isSpawning(leafPaneId)) {
          paneSpawnGuard.cancel(leafPaneId)
        }
      }
      const terminalIds = collectTerminalIdsFromPanelTree(panelLayout)
      for (const terminalId of terminalIds) {
        removeTerminalOptimistically(terminalId, logContext)
      }
    },
    [removeTerminalOptimistically]
  )

  /**
   * Collect stale terminal leaves from the hierarchical layout.
   */
  const collectStaleLeaves = useCallback(
    (liveIds: ReadonlySet<string>) => {
      return persistedWindowLayout
        ? getStaleTerminalLeavesHierarchical(persistedWindowLayout, liveIds)
        : []
    },
    [persistedWindowLayout]
  )

  /**
   * Commit reconciled layout to LiveStore.
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
      if (effectiveWindowLayout) {
        const reconciledWindow = reconcileWindowLayout(
          effectiveWindowLayout,
          liveIds,
          respawnedIds
        )
        if (reconciledWindow !== currentWindowLayout) {
          store.commit(
            windowLayoutUpdated({
              windowId: panelWindowId,
              windowLayout: reconciledWindow,
              reason: 'reconciliation',
            })
          )
        }
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
    // layout tree with the new terminal IDs. Uses retry logic to handle
    // the case where the server is still initializing at startup, and
    // preserves stale terminal IDs in the layout when all retries fail
    // (preventing a cascading spawn-remove loop).
    respawnStaleTerminals({
      staleLeaves: staleLeavesToRespawn,
      spawnFn: (payload) => spawnTerminal({ payload }),
      liveIds,
      commitReconciledLayouts: (effectiveLiveIds, respawnedIds) => {
        commitReconciledLayouts(effectiveLiveIds, respawnedIds)
        setIsReconciling(false)
      },
      onTerminalSpawned: (result, wsId) => {
        upsertTerminalListItem({
          agentStatus: null,
          args: [],
          command: result.command,
          cwd: '',
          foregroundProcess: null,
          hasChildProcess: false,
          id: result.id,
          processChain: [],
          status: result.status as 'running' | 'stopped',
          workspaceId: wsId,
        })
      },
    })
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
  // process. The main process uses this to route notification clicks and
  // other workspace-targeting actions to the correct window.
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
      newPaneContent?: Partial<LeafNode>
    ): string | undefined => {
      if (!persistedWindowLayout) {
        return undefined
      }

      // Agent panes are terminals running the configured agent command.
      // Store as 'terminal' so the renderer treats them uniformly.
      const effectiveContent =
        newPaneContent?.paneType === 'agent'
          ? { ...newPaneContent, paneType: 'terminal' as const }
          : newPaneContent

      // Find which workspace contains the pane being split, then split
      // the panel tree within the active panel tab of that workspace.
      let newLeaf: LeafNode | undefined
      let resultLayout = persistedWindowLayout
      const allLeaves = getAllWorkspaceTileLeaves(persistedWindowLayout)
      for (const wsLeaf of allLeaves) {
        const activePanelTab = wsLeaf.panelTabs.find(
          (t) => t.id === wsLeaf.activePanelTabId
        )
        if (!activePanelTab) {
          continue
        }
        const paneExists = findLeaf(activePanelTab.panelLayout, paneId)
        if (!paneExists) {
          continue
        }
        const oldTree = activePanelTab.panelLayout
        const newTree = splitPaneInTree(
          oldTree,
          paneId,
          direction,
          effectiveContent
        )
        newLeaf = findNewLeafAfterSplit(oldTree, newTree)
        // Update the panel tab's layout and save focus to the new pane
        resultLayout = updateWorkspaceTileLeaf(
          persistedWindowLayout,
          wsLeaf.workspaceId,
          (leaf) => ({
            ...leaf,
            panelTabs: leaf.panelTabs.map((tab) =>
              tab.id === activePanelTab.id
                ? {
                    ...tab,
                    panelLayout: newTree,
                    focusedPaneId: newLeaf?.id ?? tab.focusedPaneId,
                  }
                : tab
            ),
          })
        )
        break
      }

      if (resultLayout !== persistedWindowLayout) {
        store.commit(
          windowLayoutUpdated({
            windowId: panelWindowId,
            windowLayout: resultLayout,
            reason: 'split',
          })
        )
      }

      if (!newLeaf?.workspaceId) {
        return newLeaf?.id
      }

      // Only auto-spawn a terminal for terminal-type and agent-type
      // panes. Diff, review, and dev server panes handle their own
      // content.
      const newPaneType = newPaneContent?.paneType ?? 'terminal'
      if (newPaneType !== 'terminal' && newPaneType !== 'agent') {
        return newLeaf.id
      }

      // Auto-spawn a terminal in the new pane. For agent panes, resolve
      // the configured agent provider first.
      const wsId = newLeaf.workspaceId
      const newPaneId = newLeaf.id

      const resolveCommand = async (): Promise<string | undefined> => {
        if (newPaneType !== 'agent') {
          return undefined
        }
        const wsList = store.query(allWorkspaces$)
        const ws = wsList.find((w) => w.id === wsId)
        if (!ws?.projectId) {
          return 'opencode'
        }
        try {
          const config = await getConfig({
            payload: { projectId: ws.projectId },
          })
          return config.agent.value ?? 'opencode'
        } catch {
          return 'opencode'
        }
      }

      // Use the spawn guard to prevent concurrent spawns for the same
      // pane. If a spawn is already in-flight for newPaneId, this is a
      // no-op. Follows VS Code's _isTerminalBeingCreated pattern.
      paneSpawnGuard
        .run(newPaneId, async () => {
          const command = await resolveCommand()
          return retryOnInitializing(() =>
            spawnTerminal({ payload: { workspaceId: wsId, command } })
          )
        })
        .then((result) => {
          if (!result) {
            return
          }
          // VS Code pattern: after the async spawn, check if the pane
          // was closed (disposed) while we were awaiting. If so, kill
          // the orphaned terminal immediately instead of assigning it.
          // @see VS Code TerminalProcessManager.createProcess() —
          //   `if (this._isDisposed) { newProcess.shutdown(false); }`
          if (paneSpawnGuard.isCancelled(newPaneId)) {
            removeTerminalOptimistically(result.id, '[split-pane-cancelled]')
            return
          }
          // Read the CURRENT layout from the store — NOT a stale snapshot.
          const currentRows = store.query(persistedLayout$)
          const currentRow = currentRows.find(
            (row) => row.windowId === panelWindowId
          )
          const currentWindowLayout = currentRow?.windowLayout as
            | WindowLayout
            | undefined
          if (!currentWindowLayout) {
            return
          }
          // Double-check the pane still exists in the current layout.
          // It may have been removed by a close action that raced with
          // the spawn but didn't trigger the cancellation path (e.g.
          // a workspace-level close that removed the entire tile).
          const paneStillExists = getAllWorkspaceTileLeaves(
            currentWindowLayout
          ).some((leaf) =>
            leaf.panelTabs.some((tab) => findLeaf(tab.panelLayout, newPaneId))
          )
          if (!paneStillExists) {
            removeTerminalOptimistically(result.id, '[split-pane-orphaned]')
            return
          }
          const updated = updateWorkspaceTileLeaf(
            currentWindowLayout,
            wsId,
            (leaf) => ({
              ...leaf,
              panelTabs: leaf.panelTabs.map((tab) => ({
                ...tab,
                panelLayout: assignTerminalInPanelTree(
                  tab.panelLayout,
                  newPaneId,
                  result.id
                ),
              })),
            })
          )
          store.commit(
            windowLayoutUpdated({
              windowId: panelWindowId,
              windowLayout: updated,
              reason: 'split-terminal-assigned',
            })
          )
        })
        .catch((error) => {
          console.warn('[split-pane] auto-spawn failed:', error)
        })

      return newLeaf.id
    },
    [
      panelWindowId,
      persistedWindowLayout,
      store,
      getConfig,
      spawnTerminal,
      removeTerminalOptimistically,
    ]
  )

  const handleUpdatePaneType = useCallback(
    (paneId: string, paneType: PaneType) => {
      if (!persistedWindowLayout) {
        return
      }

      // Find which workspace contains this pane and update its type
      let resultLayout = persistedWindowLayout
      const allLeaves = getAllWorkspaceTileLeaves(persistedWindowLayout)
      let foundWorkspaceId: string | undefined
      for (const wsLeaf of allLeaves) {
        const activePanelTab = wsLeaf.panelTabs.find(
          (t) => t.id === wsLeaf.activePanelTabId
        )
        if (!activePanelTab) {
          continue
        }
        const leaf = findLeaf(activePanelTab.panelLayout, paneId)
        if (!leaf) {
          continue
        }
        foundWorkspaceId = wsLeaf.workspaceId
        const effectivePaneType =
          paneType === 'agent' ? ('terminal' as const) : paneType
        const newTree = updateLeafTypeInTree(
          activePanelTab.panelLayout,
          paneId,
          effectivePaneType
        )
        resultLayout = updateWorkspaceTileLeaf(
          persistedWindowLayout,
          wsLeaf.workspaceId,
          (wsLeafNode) => ({
            ...wsLeafNode,
            panelTabs: wsLeafNode.panelTabs.map((tab) =>
              tab.id === activePanelTab.id
                ? { ...tab, panelLayout: newTree }
                : tab
            ),
          })
        )
        break
      }

      if (resultLayout !== persistedWindowLayout) {
        store.commit(
          windowLayoutUpdated({
            windowId: panelWindowId,
            windowLayout: resultLayout,
            reason: 'update-pane-type',
          })
        )
      }

      // Auto-spawn a terminal for terminal/agent panes
      if (
        foundWorkspaceId &&
        (paneType === 'terminal' || paneType === 'agent')
      ) {
        const wsId = foundWorkspaceId

        const resolveCommand = async (): Promise<string | undefined> => {
          if (paneType !== 'agent') {
            return undefined
          }
          const wsList = store.query(allWorkspaces$)
          const ws = wsList.find((w) => w.id === wsId)
          if (!ws?.projectId) {
            return 'opencode'
          }
          try {
            const config = await getConfig({
              payload: { projectId: ws.projectId },
            })
            return config.agent.value ?? 'opencode'
          } catch {
            return 'opencode'
          }
        }

        paneSpawnGuard
          .run(paneId, async () => {
            const command = await resolveCommand()
            return retryOnInitializing(() =>
              spawnTerminal({ payload: { workspaceId: wsId, command } })
            )
          })
          .then((result) => {
            if (!result) {
              return
            }
            if (paneSpawnGuard.isCancelled(paneId)) {
              removeTerminalOptimistically(result.id, '[update-type-cancelled]')
              return
            }
            const currentRows = store.query(persistedLayout$)
            const currentRow = currentRows.find(
              (row) => row.windowId === panelWindowId
            )
            const currentWindowLayout = currentRow?.windowLayout as
              | WindowLayout
              | undefined
            if (!currentWindowLayout) {
              return
            }
            const paneStillExists = getAllWorkspaceTileLeaves(
              currentWindowLayout
            ).some((wsLeafNode) =>
              wsLeafNode.panelTabs.some((tab) =>
                findLeaf(tab.panelLayout, paneId)
              )
            )
            if (!paneStillExists) {
              removeTerminalOptimistically(result.id, '[update-type-orphaned]')
              return
            }
            const updated = updateWorkspaceTileLeaf(
              currentWindowLayout,
              wsId,
              (wsLeafNode) => ({
                ...wsLeafNode,
                panelTabs: wsLeafNode.panelTabs.map((tab) => ({
                  ...tab,
                  panelLayout: assignTerminalInPanelTree(
                    tab.panelLayout,
                    paneId,
                    result.id
                  ),
                })),
              })
            )
            store.commit(
              windowLayoutUpdated({
                windowId: panelWindowId,
                windowLayout: updated,
                reason: 'update-type-terminal-assigned',
              })
            )
          })
          .catch((error) => {
            console.warn('[update-pane-type] auto-spawn failed:', error)
          })
      }
    },
    [
      panelWindowId,
      persistedWindowLayout,
      store,
      getConfig,
      spawnTerminal,
      removeTerminalOptimistically,
    ]
  )

  const handleClosePane = useCallback(
    (paneId: string) => {
      if (!persistedWindowLayout) {
        return
      }

      const { resultLayout, paneFound, terminalIdsToRemove } =
        closePaneInLayout(persistedWindowLayout, paneId)

      if (!paneFound) {
        return
      }

      // Cancel any in-flight terminal spawn for this pane. Follows
      // VS Code's TerminalProcessManager.dispose() pattern: set the
      // cancelled flag so that when the async spawn completes, the
      // .then() handler kills the orphaned terminal instead of
      // assigning it to a pane that no longer exists.
      if (paneSpawnGuard.isSpawning(paneId)) {
        paneSpawnGuard.cancel(paneId)
      }

      // Kill terminal processes associated with the pane being closed.
      for (const terminalId of terminalIdsToRemove) {
        removeTerminalOptimistically(terminalId, '[close-pane]')
      }

      if (resultLayout !== persistedWindowLayout) {
        // Check if the layout is effectively empty (no tabs or no workspaces)
        const hasContent = resultLayout.tabs.some((tab) => {
          if (!tab.workspaceLayout) {
            return false
          }
          const leaves = getWorkspaceTileLeaves(tab.workspaceLayout)
          return leaves.some((l) => l.panelTabs.length > 0)
        })

        if (hasContent) {
          store.commit(
            windowLayoutUpdated({
              windowId: panelWindowId,
              windowLayout: resultLayout,
              reason: 'pane-closed',
            })
          )
        } else {
          const emptyLayout: WindowLayout = {
            ...resultLayout,
            tabs: [],
            activeTabId: undefined,
          }
          store.commit(
            windowLayoutUpdated({
              windowId: panelWindowId,
              windowLayout: emptyLayout,
              reason: 'all-panes-closed',
            })
          )
          hasSeeded.current = false
        }
      }
    },
    [panelWindowId, persistedWindowLayout, store, removeTerminalOptimistically]
  )

  const handleSetActivePaneId = useCallback(
    (paneId: string | null) => {
      if (!persistedWindowLayout) {
        return
      }
      // Resolve the effective pane ID. If null is passed, fall back to
      // the hierarchically resolved active pane for the current window tab.
      const activeTab = getActiveWindowTab(persistedWindowLayout)
      const validatedPaneId =
        paneId ?? (activeTab ? resolveActivePaneForWindowTab(activeTab) : null)
      if (!validatedPaneId) {
        return
      }
      // Save focusedPaneId on the hierarchical layout so that
      // switching tabs can restore focus later.
      const updated = saveFocusedPaneId(persistedWindowLayout, validatedPaneId)
      if (updated !== persistedWindowLayout) {
        store.commit(
          windowLayoutUpdated({
            windowId: panelWindowId,
            windowLayout: updated,
            reason: 'focus-changed',
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
      return ws?.sandboxId != null
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
      // navigate to its exact location (switch window tab, panel tab,
      // and focus the pane) instead of creating a new pane.
      if (!paneId) {
        const navLayout = navigateToTerminal(persistedWindowLayout, terminalId)
        if (navLayout) {
          store.commit(
            windowLayoutUpdated({
              windowId: panelWindowId,
              windowLayout: navLayout,
              reason: 'navigate-to-terminal',
            })
          )
          return
        }
      }

      // Ensure the workspace has a tile in the active window tab.
      const baseLayout = ensureWorkspaceInActiveTab(
        persistedWindowLayout,
        workspaceId
      )

      // Assign the terminal directly into the hierarchical layout.
      const { layout: resultLayout, focusPaneId } = assignTerminalInWorkspace(
        baseLayout,
        workspaceId,
        terminalId,
        paneId
      )

      if (resultLayout !== persistedWindowLayout) {
        store.commit(
          windowLayoutUpdated({
            windowId: panelWindowId,
            windowLayout: resultLayout,
            reason: 'terminal-assigned',
          })
        )
      }

      // Auto-open dev server for containerized workspaces
      const shouldAutoOpenDevServer = options?.autoOpenDevServer === true
      if (shouldAutoOpenDevServer && isWorkspaceContainerized(workspaceId)) {
        const devPaneId = focusPaneId ?? paneId
        if (devPaneId) {
          autoOpenDevServerRef.current?.(devPaneId)?.catch((error) => {
            console.warn('[auto-open] dev server spawn failed:', error)
          })
        }
      }
    },
    [persistedWindowLayout, panelWindowId, store, isWorkspaceContainerized]
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

      // Find the pane in the active panel tab's tree and compute resize.
      const allLeaves = getAllWorkspaceTileLeaves(persistedWindowLayout)
      for (const wsLeaf of allLeaves) {
        const activePanelTab = wsLeaf.panelTabs.find(
          (t) => t.id === wsLeaf.activePanelTabId
        )
        if (!activePanelTab) {
          continue
        }
        const paneNode = findLeaf(activePanelTab.panelLayout, paneId)
        if (!paneNode) {
          continue
        }
        const result = computeResize(
          activePanelTab.panelLayout,
          paneId,
          direction
        )
        if (!result) {
          return
        }
        const groupHandle = registry?.getGroupRef(result.splitNodeId)
        if (!groupHandle) {
          return
        }
        groupHandle.setLayout(result.newSizes)
        return
      }
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
   * Toggle the dev server terminal as a panel tab.
   *
   * When toggling ON: creates a new 'devServerTerminal' panel tab in the
   * workspace that contains the given pane, then spawns a container terminal
   * with `autoRun: true`.
   *
   * When toggling OFF: removes the dev server panel tab from the workspace.
   * The terminal session is killed.
   *
   * @see Issue #8: Dev server terminal pane type + toggle
   */
  const handleToggleDevServerPane = useCallback(
    async (paneId: string): Promise<boolean> => {
      if (!persistedWindowLayout) {
        return false
      }

      // Find which workspace the pane belongs to
      const targetWsLeaf = findWorkspaceForPane(persistedWindowLayout, paneId)
      if (!targetWsLeaf) {
        return false
      }

      const wsId = targetWsLeaf.workspaceId

      // Check if a dev server panel tab already exists
      const existingDevTab = targetWsLeaf.panelTabs.find((tab) => {
        return (
          tab.panelLayout._tag === 'LeafNode' &&
          tab.panelLayout.paneType === 'devServerTerminal'
        )
      })

      if (existingDevTab) {
        // Toggle OFF — remove the dev server panel tab and kill its terminal
        const terminalIds = collectTerminalIdsFromPanelTree(
          existingDevTab.panelLayout
        )
        for (const terminalId of terminalIds) {
          removeTerminalOptimistically(terminalId, '[dev-server-toggle-off]')
        }
        const newLayout = updateWorkspaceTileLeaf(
          persistedWindowLayout,
          wsId,
          (leaf) => removePanelTab(leaf, existingDevTab.id)
        )
        store.commit(
          windowLayoutUpdated({
            windowId: panelWindowId,
            windowLayout: newLayout,
            reason: 'dev-server-toggle-off',
          })
        )
        return false
      }

      // Toggle ON — spawn a new dev server terminal with autoRun
      const result = await spawnTerminal({
        payload: {
          workspaceId: wsId,
          autoRun: true,
        },
      })

      // Re-read the layout to avoid overwriting concurrent changes.
      const currentRows = store.query(persistedLayout$)
      const currentRow = currentRows.find(
        (row) => row.windowId === panelWindowId
      )
      const currentWindowLayout = currentRow?.windowLayout as
        | WindowLayout
        | undefined
      if (!currentWindowLayout) {
        return false
      }

      // Add a new dev server panel tab to the workspace
      const newLayout = updateWorkspaceTileLeaf(
        currentWindowLayout,
        wsId,
        (leaf) =>
          addPanelTab(leaf, 'devServerTerminal', { terminalId: result.id })
      )
      store.commit(
        windowLayoutUpdated({
          windowId: panelWindowId,
          windowLayout: newLayout,
          reason: 'dev-server-toggle-on',
        })
      )
      return true
    },
    [
      persistedWindowLayout,
      panelWindowId,
      store,
      spawnTerminal,
      removeTerminalOptimistically,
    ]
  )

  // Keep the auto-open ref in sync with the latest toggle handler
  useEffect(() => {
    autoOpenDevServerRef.current = handleToggleDevServerPane
  }, [handleToggleDevServerPane])

  /**
   * Close a terminal and its associated pane (ungated — no confirmation).
   * If the terminal has no pane, removes it from the service directly.
   *
   * Searches all panel tabs in the hierarchical layout for the terminal.
   */
  const handleCloseTerminalPane = useCallback(
    (terminalId: string) => {
      if (persistedWindowLayout) {
        const newLayout = closeTerminalInWindowLayout(
          persistedWindowLayout,
          terminalId
        )
        if (newLayout !== persistedWindowLayout) {
          removeTerminalOptimistically(terminalId, '[close-terminal-pane]')
          store.commit(
            windowLayoutUpdated({
              windowId: panelWindowId,
              windowLayout: newLayout,
              reason: 'terminal-pane-closed',
            })
          )
          return
        }
      }

      // No pane found — remove the terminal from the service directly
      removeTerminalOptimistically(terminalId, '[close-terminal-pane]')
    },
    [persistedWindowLayout, panelWindowId, store, removeTerminalOptimistically]
  )

  /**
   * Close all panes belonging to a workspace and kill their terminals.
   * This is the ungated version — callers should check for running
   * child processes and show a confirmation dialog before invoking.
   */
  const handleCloseWorkspace = useCallback(
    (workspaceId: string) => {
      if (!persistedWindowLayout) {
        return
      }

      // Cancel in-flight spawns and kill all terminals belonging to
      // this workspace by walking the hierarchical tree.
      const allLeaves = getAllWorkspaceTileLeaves(persistedWindowLayout)
      const wsLeaf = allLeaves.find((l) => l.workspaceId === workspaceId)
      if (wsLeaf) {
        for (const panelTab of wsLeaf.panelTabs) {
          cancelSpawnsAndKillTerminals(
            panelTab.panelLayout,
            '[close-workspace]'
          )
        }
      }

      // Remove the workspace tile from the hierarchical layout
      const updatedWindowLayout = removeWorkspaceFromLayout(
        persistedWindowLayout,
        workspaceId,
        removeWorkspaceFromTab
      )
      if (updatedWindowLayout !== persistedWindowLayout) {
        store.commit(
          windowLayoutUpdated({
            windowId: panelWindowId,
            windowLayout: updatedWindowLayout,
            reason: 'workspace-closed',
          })
        )
      }
    },
    [panelWindowId, persistedWindowLayout, store, cancelSpawnsAndKillTerminals]
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

  /**
   * Toggle a full-height file tree panel for a workspace.
   *
   * NOTE: This is a placeholder implementation. The actual tree panel
   * toggle is handled at the route level (index.tsx) where the full-height
   * tree panel state is managed. This hook's version is overridden by
   * the route's gatedPanelActions to provide the full-height behavior.
   *
   * The tree panel is forced to the left side, unlike diff/review which
   * are on the right.
   *
   * @param _paneId - The pane ID (unused in this stub implementation)
   * @returns Always false since the actual implementation is in index.tsx
   */
  const handleToggleTreePane = useCallback((_paneId: string): boolean => {
    // This is overridden by gatedPanelActions in index.tsx
    // to provide full-height tree panel behavior
    return false
  }, [])

  // -------------------------------------------------------------------
  // Window tab actions — operate on the hierarchical WindowLayout.
  // -------------------------------------------------------------------

  /**
   * Helper to commit a window layout update to LiveStore.
   * All layout mutations use the single `windowLayoutUpdated` event.
   */
  const commitWindowLayout = useCallback(
    (reason: string, newLayout: WindowLayout) => {
      store.commit(
        windowLayoutUpdated({
          windowId: panelWindowId,
          windowLayout: newLayout,
          reason,
        })
      )
    },
    [panelWindowId, store]
  )

  /**
   * Reorder workspace frames by persisting an explicit workspace ID ordering.
   * Called when the user drag-and-drops workspace frames to rearrange them.
   *
   * Updates the WorkspaceTileNode tree within the active WindowTab and
   * commits a single `windowLayoutUpdated` event.
   */
  const handleReorderWorkspaces = useCallback(
    (workspaceOrder: (string | undefined)[]) => {
      // Filter out undefined entries — only persist concrete workspace IDs
      const order = workspaceOrder.filter(
        (id): id is string => id !== undefined
      )

      // Reorder workspace tiles within the active WindowTab
      if (persistedWindowLayout) {
        const activeTab = getActiveWindowTab(persistedWindowLayout)
        if (activeTab?.workspaceLayout) {
          const updatedTab = reorderWorkspaceTiles(activeTab, order)
          if (updatedTab !== activeTab) {
            const newLayout: WindowLayout = {
              ...persistedWindowLayout,
              tabs: persistedWindowLayout.tabs.map((tab) =>
                tab.id === activeTab.id ? updatedTab : tab
              ),
            }
            commitWindowLayout('workspaces-reordered', newLayout)
          }
        }
      }
    },
    [persistedWindowLayout, commitWindowLayout]
  )

  const handleAddWindowTab = useCallback(() => {
    const base = persistedWindowLayout ?? { tabs: [], activeTabId: undefined }
    const newLayout = addWindowTab(base)
    commitWindowLayout('window-tab-created', newLayout)
  }, [persistedWindowLayout, commitWindowLayout])

  const handleRenameWindowTab = useCallback(
    (tabId: string, label: string) => {
      if (!persistedWindowLayout) {
        return
      }
      const newLayout = renameWindowTab(persistedWindowLayout, tabId, label)
      commitWindowLayout('window-tab-renamed', newLayout)
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
    // Save focus to the new active tab's last-focused pane
    const newActiveTab = getActiveWindowTab(newLayout)
    let finalLayout = newLayout
    if (newActiveTab) {
      const paneId = resolveActivePaneForWindowTab(newActiveTab)
      if (paneId) {
        finalLayout = saveFocusedPaneId(finalLayout, paneId)
      }
    }
    commitWindowLayout('window-tab-closed', finalLayout)
  }, [persistedWindowLayout, commitWindowLayout, removeTerminalOptimistically])

  /**
   * Commit a window tab switch and restore `activePaneId` to the
   * destination tab's last-focused pane.  This ensures that keyboard
   * focus follows tab switches instead of being stranded on a pane
   * that is no longer visible.
   */
  const commitWindowTabSwitchWithFocus = useCallback(
    (newLayout: WindowLayout) => {
      // Save focus to the destination tab's last-focused pane
      const activeTab = getActiveWindowTab(newLayout)
      let finalLayout = newLayout
      if (activeTab) {
        const paneId = resolveActivePaneForWindowTab(activeTab)
        if (paneId) {
          finalLayout = saveFocusedPaneId(finalLayout, paneId)
        }
      }
      commitWindowLayout('window-tab-switched', finalLayout)
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
      commitWindowLayout('window-tabs-reordered', newLayout)
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
        commitWindowLayout('window-tab-created', base)
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

      commitWindowLayout('workspace-added', newLayout)
    },
    [persistedWindowLayout, commitWindowLayout]
  )

  // -------------------------------------------------------------------
  // Panel tab actions — operate on workspaces within the WindowLayout.
  // -------------------------------------------------------------------

  /**
   * Helper to commit a panel tab layout update to LiveStore.
   * All panel tab mutations use the single `windowLayoutUpdated` event.
   */
  const commitPanelTabLayout = useCallback(
    (reason: string, newLayout: WindowLayout) => {
      store.commit(
        windowLayoutUpdated({
          windowId: panelWindowId,
          windowLayout: newLayout,
          reason,
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
        commitWindowLayout('window-tab-created', base)
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
        commitWindowLayout('ensure-workspace-in-tab', base)
      }

      // Agent panes are terminals running the configured agent command.
      // Store as 'terminal' so the renderer treats them uniformly.
      const effectivePanelType = panelType === 'agent' ? 'terminal' : panelType

      let newPaneId: string | undefined
      const newLayout = updateWorkspaceTileLeaf(base, workspaceId, (leaf) => {
        const updated = addPanelTab(
          leaf,
          effectivePanelType,
          options?.terminalId ? { terminalId: options.terminalId } : undefined
        )
        // The newly added tab is always the last one and is set as active
        const newTab = updated.panelTabs.at(-1)
        if (newTab?.panelLayout._tag === 'LeafNode') {
          newPaneId = newTab.panelLayout.id
        }
        return updated
      })
      commitPanelTabLayout('panel-tab-created', newLayout)

      // Auto-spawn a terminal for terminal-type and agent-type panel
      // tabs, mirroring the split-pane behaviour at handleSplitPane —
      // but skip if the caller already provided a terminal ID (e.g.
      // sidebar spawn).
      if (
        (panelType === 'terminal' || panelType === 'agent') &&
        newPaneId &&
        !options?.terminalId
      ) {
        const paneId = newPaneId

        // Resolve the spawn command: for agents, look up the workspace's
        // project config to determine which agent provider to use.
        const resolveCommand = async (): Promise<string | undefined> => {
          if (panelType !== 'agent') {
            return undefined
          }
          const wsList = store.query(allWorkspaces$)
          const ws = wsList.find((w) => w.id === workspaceId)
          if (!ws?.projectId) {
            return 'opencode'
          }
          try {
            const config = await getConfig({
              payload: { projectId: ws.projectId },
            })
            return config.agent.value ?? 'opencode'
          } catch {
            return 'opencode'
          }
        }

        // Use the spawn guard to prevent concurrent spawns for the same
        // pane. Follows VS Code's _isTerminalBeingCreated pattern.
        paneSpawnGuard
          .run(paneId, async () => {
            const command = await resolveCommand()
            return retryOnInitializing(() =>
              spawnTerminal({ payload: { workspaceId, command } })
            )
          })
          .then((result) => {
            if (!result) {
              return
            }
            // VS Code pattern: after the async spawn, check if the pane
            // was closed (disposed) while we were awaiting. If so, kill
            // the orphaned terminal immediately instead of assigning it.
            if (paneSpawnGuard.isCancelled(paneId)) {
              removeTerminalOptimistically(
                result.id,
                '[add-panel-tab-cancelled]'
              )
              return
            }
            // Read the CURRENT layout from the store — NOT a stale snapshot.
            // Multiple layout mutations may have occurred between when this
            // spawn was initiated and when it completed. Using a stale
            // snapshot would overwrite those mutations, collapsing the layout.
            const currentRows = store.query(persistedLayout$)
            const currentRow = currentRows.find(
              (row) => row.windowId === panelWindowId
            )
            const currentWindowLayout = currentRow?.windowLayout as
              | WindowLayout
              | undefined
            if (!currentWindowLayout) {
              return
            }
            // Double-check the pane still exists in the current layout.
            const paneStillExists = getAllWorkspaceTileLeaves(
              currentWindowLayout
            ).some((leaf) =>
              leaf.panelTabs.some((tab) => findLeaf(tab.panelLayout, paneId))
            )
            if (!paneStillExists) {
              removeTerminalOptimistically(
                result.id,
                '[add-panel-tab-orphaned]'
              )
              return
            }
            // Assign the terminal to the pane in the hierarchical layout.
            const updated = updateWorkspaceTileLeaf(
              currentWindowLayout,
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
            commitPanelTabLayout('panel-tab-terminal-assigned', updated)
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
      getConfig,
      spawnTerminal,
      store,
      panelWindowId,
      removeTerminalOptimistically,
    ]
  )

  const handleAutoOpenAgentWhenWorkspaceReady = useCallback(
    (workspaceId: string) => {
      const workspace = workspaceList.find((ws) => ws.id === workspaceId)
      if (workspace?.status === 'running') {
        handleAddPanelTab(workspaceId, 'agent')
        return
      }
      if (
        workspace?.status === 'errored' ||
        workspace?.status === 'destroyed'
      ) {
        return
      }
      pendingAgentAutoOpenWorkspaceIdsRef.current.add(workspaceId)
    },
    [workspaceList, handleAddPanelTab]
  )

  useEffect(() => {
    if (pendingAgentAutoOpenWorkspaceIdsRef.current.size === 0) {
      return
    }

    for (const workspaceId of pendingAgentAutoOpenWorkspaceIdsRef.current) {
      const workspace = workspaceList.find((ws) => ws.id === workspaceId)
      if (!workspace) {
        continue
      }
      if (workspace.status === 'running') {
        pendingAgentAutoOpenWorkspaceIdsRef.current.delete(workspaceId)
        handleAddPanelTab(workspaceId, 'agent')
        continue
      }
      if (workspace.status === 'errored' || workspace.status === 'destroyed') {
        pendingAgentAutoOpenWorkspaceIdsRef.current.delete(workspaceId)
      }
    }
  }, [workspaceList, handleAddPanelTab])

  /**
   * When removing a panel tab leaves the workspace empty (zero tabs),
   * auto-close the workspace by removing the workspace tile from the layout.
   *
   * @returns `true` if the workspace was auto-closed, `false` otherwise.
   */
  const autoCloseEmptyWorkspace = useCallback(
    (newLayout: WindowLayout, workspaceId: string): boolean => {
      const newActiveTab = getActiveWindowTab(newLayout)
      const newTileLayout = newActiveTab?.workspaceLayout
      if (!newTileLayout) {
        return false
      }
      const newLeaves = getWorkspaceTileLeaves(newTileLayout)
      const updatedLeaf = newLeaves.find((l) => l.workspaceId === workspaceId)
      if (!updatedLeaf || updatedLeaf.panelTabs.length > 0) {
        return false
      }

      // Remove the workspace tile from the hierarchical layout
      const finalLayout = removeWorkspaceFromLayout(
        newLayout,
        workspaceId,
        removeWorkspaceFromTab
      )
      store.commit(
        windowLayoutUpdated({
          windowId: panelWindowId,
          windowLayout: finalLayout,
          reason: 'auto-close-empty-workspace',
        })
      )
      return true
    },
    [panelWindowId, store]
  )

  const handleRemovePanelTab = useCallback(
    (workspaceId: string, tabId: string) => {
      if (!persistedWindowLayout) {
        return
      }

      // Cancel in-flight spawns and kill terminals for the panel tab.
      const activeTab = getActiveWindowTab(persistedWindowLayout)
      const tileLayout = activeTab?.workspaceLayout
      if (tileLayout) {
        const leaves = getWorkspaceTileLeaves(tileLayout)
        const leaf = leaves.find((l) => l.workspaceId === workspaceId)
        const panelTab = leaf?.panelTabs.find((t) => t.id === tabId)
        if (panelTab) {
          cancelSpawnsAndKillTerminals(
            panelTab.panelLayout,
            '[close-panel-tab]'
          )
        }
      }

      const newLayout = updateWorkspaceTileLeaf(
        persistedWindowLayout,
        workspaceId,
        (leaf) => removePanelTab(leaf, tabId)
      )

      // If this was the last panel tab, auto-close the workspace
      // instead of leaving an empty "No panel tabs" state.
      if (autoCloseEmptyWorkspace(newLayout, workspaceId)) {
        return
      }

      commitPanelTabLayout('panel-tab-closed', newLayout)
    },
    [
      persistedWindowLayout,
      commitPanelTabLayout,
      cancelSpawnsAndKillTerminals,
      autoCloseEmptyWorkspace,
    ]
  )

  /**
   * Commit a panel tab switch and restore `activePaneId` to the
   * destination panel tab's last-focused pane. This ensures keyboard
   * focus follows panel tab switches.
   */
  const commitPanelTabSwitchWithFocus = useCallback(
    (newLayout: WindowLayout, workspaceId: string) => {
      // Save focus to the destination panel tab's last-focused pane
      const activeWinTab = getActiveWindowTab(newLayout)
      const tileLayout = activeWinTab?.workspaceLayout
      const leaves = tileLayout ? getWorkspaceTileLeaves(tileLayout) : []
      const leaf = leaves.find((l) => l.workspaceId === workspaceId)
      let finalLayout = newLayout
      if (leaf) {
        const activeTab = leaf.panelTabs.find(
          (t) => t.id === leaf.activePanelTabId
        )
        if (activeTab) {
          const paneId = resolveActivePaneForPanelTab(activeTab)
          if (paneId) {
            finalLayout = saveFocusedPaneId(finalLayout, paneId)
          }
        }
      }
      commitPanelTabLayout('panel-tab-switched', finalLayout)
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
      commitPanelTabLayout('panel-tabs-reordered', newLayout)
    },
    [persistedWindowLayout, commitPanelTabLayout]
  )

  const panelActions = useMemo(
    () => ({
      addPanelTab: handleAddPanelTab,
      autoOpenAgentWhenWorkspaceReady: handleAutoOpenAgentWhenWorkspaceReady,
      assignTerminalToPane: handleAssignTerminalToPane,
      splitPane: handleSplitPane,
      updatePaneType: handleUpdatePaneType,
      closePane: handleClosePane,
      closeWorkspace: handleCloseWorkspace,
      forceCloseWorkspace: handleCloseWorkspace,
      setActivePaneId: handleSetActivePaneId,
      toggleDiffPane: handleToggleDiffPane,
      toggleDevServerPane: handleToggleDevServerPane,
      toggleReviewPane: handleToggleReviewPane,
      toggleTreePane: handleToggleTreePane,
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
      handleAutoOpenAgentWhenWorkspaceReady,
      handleAssignTerminalToPane,
      handleSplitPane,
      handleUpdatePaneType,
      handleClosePane,
      handleCloseWorkspace,
      handleSetActivePaneId,
      handleToggleDiffPane,
      handleToggleDevServerPane,
      handleToggleReviewPane,
      handleToggleTreePane,
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

  // Compute leaf pane IDs for keyboard navigation from the hierarchical layout.
  // Collects all leaf pane IDs from the active window tab's workspace tile leaves'
  // active panel tabs.
  const leafPaneIds = useMemo(
    () =>
      persistedWindowLayout ? getActiveTabLeafIds(persistedWindowLayout) : [],
    [persistedWindowLayout]
  )

  return {
    panelActions,
    activePaneId: persistedActivePaneId,
    leafPaneIds,
    isReconciling,
    liveTerminals,
  }
}
