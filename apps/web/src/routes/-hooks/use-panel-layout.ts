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
import {
  convertPanelTree,
  deriveLegacyTreeFromHierarchical,
  migrateToWindowLayout,
} from '@/panels/layout-migration'
import type { NavigationDirection } from '@/panels/layout-utils'
import {
  closePane,
  computeResize,
  computeTerminalPaneAssignment,
  ensureValidActivePaneId,
  filterTreeByWorkspace,
  findLeafByTerminalId,
  findNewLeafAfterSplit,
  findNodeById,
  getLeafIds,
  getLeafNodes,
  getStaleTerminalLeaves,
  getTerminalIdsToRemove,
  getWorkspaceTerminalIds,
  replaceNode,
  splitPane,
} from '@/panels/layout-utils'
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
import {
  assignTerminal as assignTerminalInPanelTree,
  collectTerminalIds as collectTerminalIdsFromPanelTree,
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
  findTerminalLocation,
  findWorkspaceLocation,
  getActiveWindowTab,
  getStaleTerminalLeavesHierarchical,
  reconcileWindowLayout,
  removeWindowTab,
  removeWorkspaceFromLayout,
  renameWindowTab,
  reorderWindowTabs,
  repairWindowLayout,
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

/** Deterministic blank session used for newly created native windows in v1. */
const DEFAULT_NEW_WINDOW_LAYOUT: LeafNode = {
  _tag: 'LeafNode',
  id: 'pane-default',
  paneType: 'terminal',
  terminalId: undefined,
  workspaceId: undefined,
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

/** Mutation atom for spawning terminals via the server's terminal.spawn RPC. */
const spawnTerminalMutation = LaborerClient.mutation('terminal.spawn')

/** Mutation atom for fetching the project config (used imperatively to resolve the agent provider). */
const configGetMutation = LaborerClient.mutation('config.get')

/** Mutation atom for removing terminals via the terminal service's terminal.remove RPC. */
const removeTerminalMutation = TerminalServiceClient.mutation('terminal.remove')

/**
 * Sync a legacy tree mutation to the hierarchical WindowLayout.
 *
 * After a pane-level mutation (split, close, assign terminal) updates the
 * legacy flat `PanelNode` tree, this function mirrors the change into the
 * hierarchical `WindowLayout` by:
 * 1. Extracting the affected workspace's subtree from the mutated legacy tree
 * 2. Converting it to a `PanelNode`
 * 3. Updating the active panel tab's `panelLayout` in the hierarchical tree
 *
 * @param windowLayout - The current hierarchical window layout (may be undefined during migration)
 * @param legacyTree - The mutated legacy PanelNode tree
 * @param workspaceId - The workspace whose panel tab should be updated
 * @returns The updated WindowLayout, or undefined if no sync was possible
 */
function syncLegacyTreeToHierarchical(
  windowLayout: WindowLayout | undefined,
  legacyTree: PanelNode,
  workspaceId: string | undefined
): WindowLayout | undefined {
  if (!(windowLayout && workspaceId)) {
    return undefined
  }

  // Extract the workspace's subtree from the mutated legacy tree
  const workspaceSubTree = filterTreeByWorkspace(legacyTree, workspaceId)
  if (!workspaceSubTree) {
    return undefined
  }

  // Convert to the new PanelNode format
  const newPanelLayout = convertPanelTree(workspaceSubTree)

  // Update the active panel tab's layout in the hierarchical tree.
  // If the workspace tile has no panel tabs yet (e.g. it was just added
  // to the tab by ensureWorkspaceInActiveTab), create a new panel tab
  // from the legacy tree's layout so the terminal has somewhere to render.
  return updateWorkspaceTileLeaf(windowLayout, workspaceId, (leaf) => {
    const activeTabId = leaf.activePanelTabId
    if (!activeTabId || leaf.panelTabs.length === 0) {
      // Create a new panel tab with the synced layout
      const newTabId = `panel-tab-sync-${Math.random().toString(36).slice(2, 8)}`
      const newTab: import('@laborer/shared/types').PanelTab = {
        id: newTabId,
        panelLayout: newPanelLayout,
      }
      return {
        ...leaf,
        panelTabs: [newTab],
        activePanelTabId: newTabId,
      }
    }
    const updatedTabs = leaf.panelTabs.map((tab) => {
      if (tab.id !== activeTabId) {
        return tab
      }
      return { ...tab, panelLayout: newPanelLayout }
    })
    return { ...leaf, panelTabs: updatedTabs }
  })
}

/**
 * Manages the panel layout state, providing split and close actions
 * that mutate the tree and persist changes to LiveStore.
 *
 * Layout persistence flow:
 * 1. Read the persisted layout from LiveStore's `panelLayout` table.
 * 2. If no persisted layout exists, fall back to the auto-generated layout
 *    from terminals/workspaces and commit it as a `layoutRestored` event.
 * 3. On split/close, compute the new tree and commit the appropriate
 *    layout event (`layoutSplit` / `layoutPaneClosed`) to LiveStore.
 * 4. The materializer upserts the row, and the reactive query re-fires.
 *
 * @see Issue #73: PanelManager — serialize layout to LiveStore
 */
export function usePanelLayout() {
  const store = useLaborerStore()
  const initialLayout = useInitialLayout()
  const registry = usePanelGroupRegistry()
  const nativeWindowId = getCurrentWindowId()
  const panelWindowId = nativeWindowId ?? DEFAULT_PANEL_WINDOW_ID
  const defaultLayout = nativeWindowId
    ? DEFAULT_NEW_WINDOW_LAYOUT
    : initialLayout

  // Read the persisted layout from LiveStore reactively.
  // Returns all rows; this hook still targets a single window-scoped row.
  const persistedRows = store.useQuery(persistedLayout$)
  const persistedRow = persistedRows.find(
    (row) => row.windowId === panelWindowId
  )
  const persistedLayoutRepair = useMemo(() => {
    // Legacy `layoutTree` column has been removed from the table.
    // After DB nuke there is no legacy data to repair.
    return {
      layoutTree: undefined as PanelNode | undefined,
      wasRepaired: false,
    }
  }, [])

  // The persisted layout tree, if one exists in LiveStore.
  const persistedLayoutTree = persistedLayoutRepair.layoutTree
  // Legacy columns removed — always null after DB nuke.
  const rawPersistedActivePaneId: string | null = null
  const persistedWorkspaceOrder: string[] | null = null

  // Read and repair the hierarchical window layout from the new columns.
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

  // Effective window layout: repaired if available, or migrated from legacy.
  // Migration only runs in useMemo (no side effects) — the migrated layout
  // is persisted via a one-time effect below.
  const persistedWindowLayout = useMemo(() => {
    if (windowLayoutRepair.windowLayout) {
      return windowLayoutRepair.windowLayout
    }
    // Migrate legacy layout to hierarchical format if the old column has
    // data but the new column is empty. This ensures the hierarchical layout
    // is available immediately on the first render after upgrade.
    if (persistedLayoutTree) {
      return migrateToWindowLayout(
        persistedLayoutTree,
        rawPersistedActivePaneId,
        persistedWorkspaceOrder
      )
    }
    return undefined
  }, [windowLayoutRepair.windowLayout, persistedLayoutTree])

  // Determine the effective layout. When a hierarchical window layout is
  // available, derive the legacy flat tree from it so that hotkeys and other
  // legacy consumers see pane IDs that match the rendered layout. Falls back
  // to the persisted legacy tree or the auto-generated default layout.
  //
  // When a window layout exists but has no tabs (all tabs closed by user),
  // return undefined so the UI shows the empty state instead of falling back
  // to the default layout which would re-create panes.
  const layout = useMemo(() => {
    if (persistedWindowLayout) {
      if (persistedWindowLayout.tabs.length === 0) {
        return undefined
      }
      const derived = deriveLegacyTreeFromHierarchical(persistedWindowLayout)
      if (derived) {
        return derived
      }
    }
    return persistedLayoutTree ?? defaultLayout
  }, [persistedWindowLayout, persistedLayoutTree, defaultLayout])

  // Enforce the guaranteed active pane invariant: when a layout exists,
  // activePaneId must reference a valid leaf node. If it's null or stale
  // (pointing to a removed pane), fall back to the first leaf.
  // @see Issue #150: Guaranteed active pane invariant
  const persistedActivePaneId = layout
    ? ensureValidActivePaneId(layout, rawPersistedActivePaneId)
    : null

  useEffect(() => {
    if (!(persistedRow && layout)) {
      return
    }

    const shouldRepairPersistedSession =
      persistedLayoutRepair.wasRepaired ||
      persistedActivePaneId !== rawPersistedActivePaneId

    if (!shouldRepairPersistedSession) {
      return
    }

    if (persistedWindowLayout) {
      store.commit(
        windowLayoutUpdated({
          windowId: panelWindowId,
          windowLayout: persistedWindowLayout,
          reason: 'repair',
        })
      )
    }
  }, [
    layout,
    panelWindowId,
    persistedActivePaneId,
    persistedLayoutRepair.wasRepaired,
    persistedRow,
    persistedWindowLayout,
    store,
  ])

  // Persist repaired window layout to LiveStore (not migration — that
  // happens during reconciliation). Only fires when repair was needed.
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
  // Sets activePaneId to the first leaf so keyboard shortcuts work immediately.
  // @see Issue #150: Guaranteed active pane invariant
  const hasSeeded = useRef(false)
  useEffect(() => {
    if (!persistedRow && defaultLayout && !hasSeeded.current) {
      hasSeeded.current = true
      // Seed: create a minimal WindowLayout from the default leaf.
      // The legacy seeding path committed layoutRestored; now we commit
      // windowLayoutUpdated with a freshly constructed WindowLayout.
      const seedWorkspaceId =
        defaultLayout._tag === 'LeafNode' ? defaultLayout.workspaceId : ''
      const seedTabId = `wtab-seed-${Math.random().toString(36).slice(2, 8)}`
      const seedPanelTabId = `ptab-seed-${Math.random().toString(36).slice(2, 8)}`
      const seedTileId = `tile-seed-${Math.random().toString(36).slice(2, 8)}`
      const seedLayout: WindowLayout = {
        tabs: [
          {
            id: seedTabId,
            workspaceLayout: {
              _tag: 'WorkspaceTileLeaf' as const,
              id: seedTileId,
              workspaceId: seedWorkspaceId ?? '',
              panelTabs: [
                {
                  id: seedPanelTabId,
                  panelLayout: defaultLayout,
                  focusedPaneId: defaultLayout.id,
                },
              ],
              activePanelTabId: seedPanelTabId,
            },
          },
        ],
        activeTabId: seedTabId,
      }
      store.commit(
        windowLayoutUpdated({
          windowId: panelWindowId,
          windowLayout: seedLayout,
          reason: 'seed',
        })
      )
    }
  }, [defaultLayout, panelWindowId, persistedRow, store])

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
  const getConfig = useAtomSet(configGetMutation, {
    mode: 'promise',
  })
  const removeTerminal = useAtomSet(removeTerminalMutation, {
    mode: 'promise',
  })
  // Start as "reconciling" when any persisted layout exists — this prevents
  // rendering TerminalPane components with potentially stale terminal IDs
  // before we've checked them against the live terminal service.
  const [isReconciling, setIsReconciling] = useState(
    () =>
      persistedLayoutTree !== undefined || persistedWindowLayout !== undefined
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
   * Collect stale terminal leaves from both legacy and hierarchical layouts.
   * Prefers hierarchical when available.
   */
  const collectStaleLeaves = useCallback(
    (liveIds: ReadonlySet<string>) => {
      const hierarchicalStale = persistedWindowLayout
        ? getStaleTerminalLeavesHierarchical(persistedWindowLayout, liveIds)
        : []
      if (hierarchicalStale.length > 0) {
        return hierarchicalStale
      }
      return persistedLayoutTree
        ? getStaleTerminalLeaves(persistedLayoutTree, liveIds)
        : []
    },
    [persistedLayoutTree, persistedWindowLayout]
  )

  /**
   * Commit reconciled layouts (both legacy and hierarchical) to LiveStore.
   */
  const commitReconciledLayouts = useCallback(
    (liveIds: ReadonlySet<string>, respawnedIds: Map<string, string>) => {
      const currentRows = store.query(persistedLayout$)
      const currentRow = currentRows.find(
        (row) => row.windowId === panelWindowId
      )

      // Legacy layout tree reconciliation removed — layoutTree column no longer exists.
      // After DB nuke, only hierarchical windowLayout is used.

      // Reconcile the hierarchical window layout if present.
      // If the layout was migrated from legacy format (no windowLayout in
      // persisted row), also persist the migrated+reconciled layout.
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
        // Persist if the layout changed OR if this is a first-time migration
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

    if (!(persistedLayoutTree || persistedWindowLayout)) {
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
    persistedLayoutTree,
    persistedWindowLayout,
    collectStaleLeaves,
    commitReconciledLayouts,
    spawnTerminal,
  ])

  // -------------------------------------------------------------------
  // Report visible workspaces to the desktop main process.
  // -------------------------------------------------------------------
  // When the layout changes, extract the set of unique workspace IDs
  // from all leaf panes and send them to the Electron main process.
  // The main process uses this to route notification clicks and other
  // workspace-targeting actions to the correct window.
  useEffect(() => {
    const bridge = getDesktopBridge()
    if (!(bridge && layout)) {
      return
    }

    const leafNodes = getLeafNodes(layout)
    const workspaceIds = [
      ...new Set(
        leafNodes
          .map((leaf) => leaf.workspaceId)
          .filter((id): id is string => id !== undefined)
      ),
    ]

    bridge.reportVisibleWorkspaces(workspaceIds).catch(() => {
      // Silently ignore — reporting is best-effort
    })
  }, [layout])

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
    ) => {
      const base = persistedLayoutTree ?? defaultLayout
      if (!base) {
        return
      }

      // Resolve the workspace for the pane being split (needed for hierarchical sync)
      const sourceNode = findNodeById(base, paneId)
      const splitWorkspaceId =
        sourceNode?._tag === 'LeafNode' ? sourceNode.workspaceId : undefined

      // Agent panes are terminals running the configured agent command.
      // Store as 'terminal' so the renderer treats them uniformly.
      const effectiveContent =
        newPaneContent?.paneType === 'agent'
          ? { ...newPaneContent, paneType: 'terminal' as const }
          : newPaneContent

      const newTree = splitPane(base, paneId, direction, effectiveContent)

      // Find the newly created pane via leaf-diffing
      const newLeaf = findNewLeafAfterSplit(base, newTree)

      // Sync the split to the hierarchical tree and commit a single event.
      const currentRows = store.query(persistedLayout$)
      const currentRow = currentRows.find(
        (row) => row.windowId === panelWindowId
      )
      const freshWindowLayout =
        (currentRow?.windowLayout as WindowLayout | undefined) ??
        persistedWindowLayout

      const updatedWindowLayout = syncLegacyTreeToHierarchical(
        freshWindowLayout,
        newTree,
        splitWorkspaceId
      )
      if (updatedWindowLayout) {
        store.commit(
          windowLayoutUpdated({
            windowId: panelWindowId,
            windowLayout: updatedWindowLayout,
            reason: 'split',
          })
        )
      }

      if (!newLeaf?.workspaceId) {
        return
      }

      // Only auto-spawn a terminal for terminal-type and agent-type
      // panes. Diff, review, and dev server panes handle their own
      // content.
      const newPaneType = newPaneContent?.paneType ?? 'terminal'
      if (newPaneType !== 'terminal' && newPaneType !== 'agent') {
        return
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
          // Read the CURRENT layout from the store — NOT a stale snapshot.
          // Multiple splits may have occurred between when this spawn was
          // initiated and when it completed. Using a stale snapshot would
          // overwrite those other splits, collapsing the layout.
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
          // Assign the terminal directly into the hierarchical layout,
          // bypassing the legacy assignTerminalToPane path that can
          // trigger step 5 (auto-split) cascades when pane IDs diverge
          // between the legacy and hierarchical trees.
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
    },
    [
      persistedLayoutTree,
      defaultLayout,
      panelWindowId,
      persistedWindowLayout,
      store,
      getConfig,
      spawnTerminal,
    ]
  )

  const handleClosePane = useCallback(
    (paneId: string) => {
      const base = persistedLayoutTree ?? defaultLayout
      if (!base) {
        return
      }

      // Resolve the workspace for the pane being closed (needed for hierarchical sync)
      const closingNode = findNodeById(base, paneId)
      const closeWorkspaceId =
        closingNode?._tag === 'LeafNode' ? closingNode.workspaceId : undefined

      // Kill terminal processes associated with the pane being closed.
      // You shouldn't have running terminals that aren't in a pane.
      const terminalIds = getTerminalIdsToRemove(base, paneId)
      for (const terminalId of terminalIds) {
        removeTerminalOptimistically(terminalId, '[close-pane]')
      }

      const newTree = closePane(base, paneId)
      if (newTree) {
        // Sync the close to the hierarchical tree and commit a single event
        const updatedWindowLayout = syncLegacyTreeToHierarchical(
          persistedWindowLayout,
          newTree,
          closeWorkspaceId
        )
        if (updatedWindowLayout) {
          store.commit(
            windowLayoutUpdated({
              windowId: panelWindowId,
              windowLayout: updatedWindowLayout,
              reason: 'pane-closed',
            })
          )
        }
      } else {
        // All panes closed — commit an empty window layout so the
        // empty state renders and a new initial layout can seed.
        if (persistedWindowLayout) {
          const emptyLayout: WindowLayout = {
            ...persistedWindowLayout,
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
        }
        hasSeeded.current = false
      }
    },
    [
      persistedLayoutTree,
      defaultLayout,
      panelWindowId,
      persistedWindowLayout,
      store,
      removeTerminalOptimistically,
    ]
  )

  const handleSetActivePaneId = useCallback(
    (paneId: string | null) => {
      // Use the effective layout (which includes pane IDs from the
      // hierarchical window layout) instead of the raw persisted legacy
      // tree. When using the hierarchical layout path, pane IDs are
      // derived from panel tab layouts and may not exist in the legacy
      // tree — validating against the legacy tree would silently replace
      // the clicked pane ID with a stale fallback.
      const effectiveLayout = layout ?? persistedLayoutTree ?? defaultLayout
      if (!effectiveLayout) {
        return
      }
      // Enforce the invariant: do not accept null when panes exist.
      // If null is passed (e.g., by legacy code), fall back to the first leaf.
      // @see Issue #150: Guaranteed active pane invariant
      const validatedPaneId = ensureValidActivePaneId(effectiveLayout, paneId)
      // Save focusedPaneId on the hierarchical layout so that
      // switching tabs can restore focus later.
      if (validatedPaneId && persistedWindowLayout) {
        const updated = saveFocusedPaneId(
          persistedWindowLayout,
          validatedPaneId
        )
        if (updated !== persistedWindowLayout) {
          store.commit(
            windowLayoutUpdated({
              windowId: panelWindowId,
              windowLayout: updated,
              reason: 'focus-changed',
            })
          )
        }
      }
    },
    [
      layout,
      persistedLayoutTree,
      defaultLayout,
      panelWindowId,
      store,
      persistedWindowLayout,
    ]
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
   * Helper: commit a layout assignment and optionally auto-open the dev
   * server pane for containerized workspaces. Extracted to reduce cognitive
   * complexity in `handleAssignTerminalToPane`.
   */
  const commitAssignment = useCallback(
    (
      layoutTree: PanelNode,
      activePaneId: string,
      workspaceId: string,
      triggerDevServer: boolean
    ) => {
      // Ensure the workspace has a tile in the active window tab before
      // syncing the legacy tree. Without this, assigning a terminal for a
      // workspace that has no tile in the current tab leaves the terminal
      // invisible (sidebar shows it, panel area doesn't).
      let baseWindowLayout = persistedWindowLayout
      if (baseWindowLayout) {
        const activeTab = getActiveWindowTab(baseWindowLayout)
        if (activeTab) {
          const existing = findWorkspaceLocation(baseWindowLayout, workspaceId)
          if (existing?.tabId !== activeTab.id) {
            baseWindowLayout = addWorkspaceToTabUnique(
              baseWindowLayout,
              workspaceId,
              activeTab.id,
              removeWorkspaceFromTab,
              addWorkspaceToTab
            )
          }
        }
      }

      // Sync the mutation to the hierarchical tree and commit
      const updatedWindowLayout = syncLegacyTreeToHierarchical(
        baseWindowLayout,
        layoutTree,
        workspaceId
      )
      if (updatedWindowLayout) {
        store.commit(
          windowLayoutUpdated({
            windowId: panelWindowId,
            windowLayout: updatedWindowLayout,
            reason: 'terminal-assigned',
          })
        )
      }

      if (triggerDevServer && isWorkspaceContainerized(workspaceId)) {
        autoOpenDevServerRef.current?.(activePaneId)?.catch((error) => {
          console.warn('[auto-open] dev server spawn failed:', error)
        })
      }
    },
    [panelWindowId, store, isWorkspaceContainerized, persistedWindowLayout]
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

      // If the terminal already exists in the hierarchical layout,
      // navigate to its exact location (switch window tab, panel tab,
      // and focus the pane) instead of creating a new pane.
      if (!paneId && persistedWindowLayout) {
        const location = findTerminalLocation(persistedWindowLayout, terminalId)
        if (location) {
          let layout = persistedWindowLayout

          // 1. Switch to the correct window tab (if not already active)
          if (layout.activeTabId !== location.tabId) {
            layout = switchWindowTab(layout, location.tabId)
          }

          // 2. Switch to the correct panel tab within the workspace
          layout = updateWorkspaceTileLeaf(
            layout,
            location.workspaceId,
            (leaf) => switchPanelTab(leaf, location.panelTabId)
          )

          // 3. Save focus to the pane containing the terminal
          layout = saveFocusedPaneId(layout, location.paneId)

          // Commit the combined navigation as a single event
          store.commit(
            windowLayoutUpdated({
              windowId: panelWindowId,
              windowLayout: layout,
              reason: 'navigate-to-terminal',
            })
          )
          return
        }
      }

      const base = persistedLayoutTree ?? defaultLayout
      const result = computeTerminalPaneAssignment(
        base,
        terminalId,
        workspaceId,
        paneId,
        options
      )
      commitAssignment(
        result.layoutTree,
        result.activePaneId,
        workspaceId,
        result.triggerDevServer
      )
    },
    [
      persistedLayoutTree,
      defaultLayout,
      commitAssignment,
      persistedWindowLayout,
      panelWindowId,
      store,
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
      const base = persistedLayoutTree ?? defaultLayout
      if (!base) {
        return
      }

      const result = computeResize(base, paneId, direction)
      if (!result) {
        return
      }

      const groupHandle = registry?.getGroupRef(result.splitNodeId)
      if (!groupHandle) {
        return
      }

      groupHandle.setLayout(result.newSizes)
    },
    [persistedLayoutTree, defaultLayout, registry]
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
   * When toggling ON with no existing dev server terminal: spawns a new
   * container terminal with `autoRun: true` so setup scripts and the dev
   * server start command are auto-typed. Sets `devServerTerminalId` and
   * `devServerOpen` on the leaf node so the UI renders it in the right-hand
   * sidebar.
   *
   * When toggling ON with an existing `devServerTerminalId`: just flips
   * `devServerOpen` to true (reconnects to the existing terminal).
   *
   * When toggling OFF: flips `devServerOpen` to false. The terminal
   * session stays alive for later reconnection.
   *
   * @see Issue #8: Dev server terminal pane type + toggle
   */
  const commitDevServerUpdate = useCallback(
    (
      tree: PanelNode,
      leafPaneId: string,
      updatedLeaf: LeafNode,
      reason: string
    ) => {
      const newTree = replaceNode(tree, leafPaneId, updatedLeaf)
      const wsId = updatedLeaf.workspaceId
      const updated = wsId
        ? syncLegacyTreeToHierarchical(persistedWindowLayout, newTree, wsId)
        : undefined
      if (updated) {
        store.commit(
          windowLayoutUpdated({
            windowId: panelWindowId,
            windowLayout: updated,
            reason,
          })
        )
      }
    },
    [persistedWindowLayout, panelWindowId, store]
  )

  const handleToggleDevServerPane = useCallback(
    async (paneId: string): Promise<boolean> => {
      const base = persistedLayoutTree ?? defaultLayout
      if (!base) {
        return false
      }

      const targetNode = findNodeById(base, paneId)
      if (
        !targetNode ||
        targetNode._tag !== 'LeafNode' ||
        targetNode.paneType !== 'terminal' ||
        !targetNode.workspaceId
      ) {
        return false
      }

      // Toggling OFF — just hide the dev server pane
      if (targetNode.devServerOpen) {
        commitDevServerUpdate(
          base,
          paneId,
          { ...targetNode, devServerOpen: false },
          'dev-server-toggle-off'
        )
        return false
      }

      // Toggling ON — reconnect to existing terminal if available
      if (targetNode.devServerTerminalId) {
        commitDevServerUpdate(
          base,
          paneId,
          { ...targetNode, devServerOpen: true },
          'dev-server-toggle-on'
        )
        return true
      }

      // Toggling ON — spawn a new dev server terminal with autoRun
      const result = await spawnTerminal({
        payload: {
          workspaceId: targetNode.workspaceId,
          autoRun: true,
        },
      })

      // Re-read the layout to avoid overwriting concurrent changes.
      const currentTree = defaultLayout
      if (!currentTree) {
        return false
      }

      const currentTarget = findNodeById(currentTree, paneId)
      if (!currentTarget || currentTarget._tag !== 'LeafNode') {
        return false
      }

      commitDevServerUpdate(
        currentTree,
        paneId,
        {
          ...currentTarget,
          devServerOpen: true,
          devServerTerminalId: result.id,
        },
        'dev-server-spawn'
      )
      return true
    },
    [persistedLayoutTree, defaultLayout, commitDevServerUpdate, spawnTerminal]
  )

  // Keep the auto-open ref in sync with the latest toggle handler
  useEffect(() => {
    autoOpenDevServerRef.current = handleToggleDevServerPane
  }, [handleToggleDevServerPane])

  /**
   * Close a terminal and its associated pane (ungated — no confirmation).
   * If the terminal has no pane, removes it from the service directly.
   *
   * Searches the active panel tab's legacy tree first (fast path), then
   * falls back to searching all panel tabs in the hierarchical layout.
   * This ensures that closing a terminal from the sidebar works even
   * when the terminal is in a non-active panel tab.
   */
  const handleCloseTerminalPane = useCallback(
    (terminalId: string) => {
      // Fast path: terminal is in the active panel tab's legacy tree
      const base = persistedLayoutTree ?? defaultLayout
      if (base) {
        const leaf = findLeafByTerminalId(base, terminalId)
        if (leaf) {
          handleClosePane(leaf.id)
          return
        }
      }

      // Slow path: search all panel tabs in the hierarchical layout
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

      // No pane found anywhere — remove the terminal from the service directly
      removeTerminalOptimistically(terminalId, '[close-terminal-pane]')
    },
    [
      persistedLayoutTree,
      defaultLayout,
      persistedWindowLayout,
      panelWindowId,
      store,
      handleClosePane,
      removeTerminalOptimistically,
    ]
  )

  /**
   * Close all panes belonging to a workspace and kill their terminals.
   * This is the ungated version — callers should check for running
   * child processes and show a confirmation dialog before invoking.
   */
  const handleCloseWorkspace = useCallback(
    (workspaceId: string) => {
      const base = persistedLayoutTree ?? defaultLayout
      if (!base) {
        return
      }

      // Kill all terminals belonging to this workspace
      const terminalIds = getWorkspaceTerminalIds(base, workspaceId)
      for (const terminalId of terminalIds) {
        removeTerminalOptimistically(terminalId, '[close-workspace]')
      }

      // Remove the workspace tile from the hierarchical layout so the
      // workspace frame disappears from the UI.
      if (persistedWindowLayout) {
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
      }
    },
    [
      persistedLayoutTree,
      defaultLayout,
      panelWindowId,
      persistedWindowLayout,
      store,
      removeTerminalOptimistically,
    ]
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
   * Handles both the hierarchical tile layout path (updates the WorkspaceTileNode
   * tree within the active WindowTab) and the legacy flat layout path (persists
   * a workspaceOrder array).
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
            // Directly update the hierarchical layout to assign the
            // terminal to the pane. Going through the legacy
            // `assignTerminalToPane` doesn't work here because the
            // pane ID only exists in the hierarchical layout, not in
            // the legacy `persistedLayoutTree`.
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
    ]
  )

  /**
   * When removing a panel tab leaves the workspace empty (zero tabs),
   * auto-close the workspace by cleaning up the legacy layout tree and
   * removing the workspace tile from the hierarchical layout.
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
      removeTerminalOptimistically,
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

  // Compute leaf pane IDs for keyboard navigation
  const leafPaneIds = useMemo(
    () => (layout ? getLeafIds(layout) : []),
    [layout]
  )

  return {
    layout,
    panelActions,
    activePaneId: persistedActivePaneId,
    leafPaneIds,
    isReconciling,
    liveTerminals,
    workspaceOrder: persistedWorkspaceOrder,
  }
}
