import { useAtomSet } from '@effect-atom/atom-react/Hooks'
import {
  layoutPaneAssigned,
  layoutPaneClosed,
  layoutRestored,
  layoutSplit,
  layoutWorkspacesReordered,
  panelLayout,
  windowTabClosed,
  windowTabCreated,
  windowTabSwitched,
  windowTabsReordered,
  workspaces,
} from '@laborer/shared/schema'
import type { LeafNode, PanelNode, WindowLayout } from '@laborer/shared/types'
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
import type { NavigationDirection } from '@/panels/layout-utils'
import {
  closePane,
  closeWorkspacePanes,
  computeResize,
  computeTerminalPaneAssignment,
  ensureValidActivePaneId,
  findLeafByTerminalId,
  findNewLeafAfterSplit,
  findNodeById,
  findSiblingPaneId,
  getFirstLeafId,
  getLeafIds,
  getLeafNodes,
  getStaleTerminalLeaves,
  getTerminalIdsToRemove,
  getWorkspaceTerminalIds,
  reconcileLayout,
  repairPanelLayoutTree,
  replaceNode,
  splitPane,
} from '@/panels/layout-utils'
import type { AssignTerminalToPaneOptions } from '@/panels/panel-context'
import { usePanelGroupRegistry } from '@/panels/panel-group-registry'
import {
  addWindowTab,
  removeWindowTab,
  reorderWindowTabs,
  switchWindowTab,
  switchWindowTabByIndex,
  switchWindowTabRelative,
} from '@/panels/window-tab-utils'
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
    if (!persistedRow?.layoutTree) {
      return {
        layoutTree: undefined as PanelNode | undefined,
        wasRepaired: false,
      }
    }

    return repairPanelLayoutTree(persistedRow.layoutTree)
  }, [persistedRow])

  // The persisted layout tree, if one exists in LiveStore.
  const persistedLayoutTree = persistedLayoutRepair.layoutTree
  const rawPersistedActivePaneId = persistedRow?.activePaneId ?? null
  const persistedWorkspaceOrder = (persistedRow?.workspaceOrder ?? null) as
    | string[]
    | null

  // Read the hierarchical window layout from the new columns.
  const persistedWindowLayout = (persistedRow?.windowLayout ?? undefined) as
    | WindowLayout
    | undefined

  // Determine the effective layout: persisted layout takes priority,
  // otherwise fall back to the auto-generated layout from terminals/workspaces.
  const layout = persistedLayoutTree ?? defaultLayout

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

    store.commit(
      layoutRestored({
        windowId: panelWindowId,
        layoutTree: layout,
        activePaneId: persistedActivePaneId,
      })
    )
  }, [
    layout,
    panelWindowId,
    persistedActivePaneId,
    persistedLayoutRepair.wasRepaired,
    persistedRow,
    rawPersistedActivePaneId,
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
      store.commit(
        layoutRestored({
          windowId: panelWindowId,
          layoutTree: defaultLayout,
          activePaneId: getFirstLeafId(defaultLayout) ?? null,
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
  const removeTerminal = useAtomSet(removeTerminalMutation, {
    mode: 'promise',
  })
  // Start as "reconciling" when a persisted layout exists — this prevents
  // rendering TerminalPane components with potentially stale terminal IDs
  // before we've checked them against the live terminal service.
  const [isReconciling, setIsReconciling] = useState(
    () => persistedLayoutTree !== undefined
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

  useEffect(() => {
    if (terminalsLoading || hasReconciled.current) {
      return
    }

    if (!persistedLayoutTree) {
      hasReconciled.current = true
      setIsReconciling(false)
      return
    }

    const liveIds = new Set(liveTerminals.map((t) => t.id))
    const staleLeaves = getStaleTerminalLeaves(persistedLayoutTree, liveIds)

    if (staleLeaves.length === 0) {
      hasReconciled.current = true
      setIsReconciling(false)
      return
    }

    // Mark as reconciled immediately to prevent re-entry during the
    // async spawn phase.
    hasReconciled.current = true

    // Spawn new terminals for stale panes sequentially, then update the
    // layout tree with the new terminal IDs. Sequential spawning avoids
    // concurrency issues with the AtomRpc mutation layer.
    const respawnStaleTerminals = async () => {
      const respawnedIds = new Map<string, string>()

      for (const leaf of staleLeaves) {
        if (!(leaf.workspaceId && leaf.terminalId)) {
          continue
        }
        try {
          const result = await spawnTerminal({
            payload: { workspaceId: leaf.workspaceId },
          })
          respawnedIds.set(leaf.terminalId, result.id)
          // Optimistically update the shared terminal list so the
          // sidebar workspace cards show recovered terminals immediately,
          // without waiting for the terminal.events stream (which may
          // not be fully connected during startup).
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
            workspaceId: leaf.workspaceId,
          })
        } catch (error) {
          console.error(
            '[reconcile] spawn failed for workspace:',
            leaf.workspaceId,
            error
          )
        }
      }

      // Re-read the persisted layout to avoid overwriting any changes
      // that occurred during the async spawn phase.
      const currentRows = store.query(persistedLayout$)
      const currentRow = currentRows.find(
        (row) => row.windowId === panelWindowId
      )
      const currentTree = currentRow?.layoutTree as PanelNode | undefined
      if (!currentTree) {
        setIsReconciling(false)
        return
      }

      const reconciled = reconcileLayout(currentTree, liveIds, respawnedIds)
      if (reconciled !== currentTree) {
        store.commit(
          layoutRestored({
            windowId: panelWindowId,
            layoutTree: reconciled,
            activePaneId: ensureValidActivePaneId(
              reconciled,
              currentRow?.activePaneId ?? null
            ),
          })
        )
      }
      setIsReconciling(false)
    }

    respawnStaleTerminals()
  }, [
    terminalsLoading,
    liveTerminals,
    panelWindowId,
    persistedLayoutTree,
    spawnTerminal,
    store,
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
    (paneId: string, direction: 'horizontal' | 'vertical') => {
      const base = persistedLayoutTree ?? defaultLayout
      if (!base) {
        return
      }

      const newTree = splitPane(base, paneId, direction)

      store.commit(
        layoutSplit({
          windowId: panelWindowId,
          layoutTree: newTree,
          activePaneId: persistedActivePaneId,
        })
      )

      // Find the newly created pane via leaf-diffing
      const newLeaf = findNewLeafAfterSplit(base, newTree)
      if (!newLeaf?.workspaceId) {
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
    [
      persistedLayoutTree,
      defaultLayout,
      panelWindowId,
      persistedActivePaneId,
      store,
      spawnTerminal,
    ]
  )

  const handleClosePane = useCallback(
    (paneId: string) => {
      const base = persistedLayoutTree ?? defaultLayout
      if (!base) {
        return
      }

      // Kill terminal processes associated with the pane being closed.
      // You shouldn't have running terminals that aren't in a pane.
      const terminalIds = getTerminalIdsToRemove(base, paneId)
      for (const terminalId of terminalIds) {
        removeTerminalOptimistically(terminalId, '[close-pane]')
      }

      // Compute the sibling BEFORE the close mutation removes the pane.
      // This ensures we can find the correct sibling in the original tree.
      // If the closing pane is the currently active pane, transfer focus
      // to its sibling. Otherwise, keep the current active pane.
      const candidateActivePaneId =
        persistedActivePaneId === paneId
          ? findSiblingPaneId(base, paneId)
          : persistedActivePaneId

      const newTree = closePane(base, paneId)
      if (newTree) {
        // Defense-in-depth: validate the candidate activePaneId is a valid
        // leaf in the post-close tree. Handles edge cases where the active
        // pane reference becomes stale after tree mutations.
        // @see Issue #150: Guaranteed active pane invariant
        const nextActivePaneId = ensureValidActivePaneId(
          newTree,
          candidateActivePaneId
        )

        store.commit(
          layoutPaneClosed({
            windowId: panelWindowId,
            layoutTree: newTree,
            activePaneId: nextActivePaneId,
          })
        )
      } else {
        // All panes closed — remove the persisted layout so the
        // empty state renders and a new initial layout can seed.
        store.commit(
          layoutPaneClosed({
            windowId: panelWindowId,
            // Commit a single empty leaf as a placeholder since
            // the schema requires a valid PanelNode.
            // The PanelManager will show the empty state because
            // the pane has no terminal assigned.
            layoutTree: {
              _tag: 'LeafNode' as const,
              id: 'pane-empty',
              paneType: 'terminal' as const,
              terminalId: undefined,
              workspaceId: undefined,
            },
            activePaneId: null,
          })
        )
        hasSeeded.current = false
      }
    },
    [
      persistedLayoutTree,
      defaultLayout,
      panelWindowId,
      persistedActivePaneId,
      store,
      removeTerminalOptimistically,
    ]
  )

  const handleSetActivePaneId = useCallback(
    (paneId: string | null) => {
      const base = persistedLayoutTree ?? defaultLayout
      if (!base) {
        return
      }
      // Enforce the invariant: do not accept null when panes exist.
      // If null is passed (e.g., by legacy code), fall back to the first leaf.
      // @see Issue #150: Guaranteed active pane invariant
      const validatedPaneId = ensureValidActivePaneId(base, paneId)
      store.commit(
        layoutPaneAssigned({
          windowId: panelWindowId,
          layoutTree: base,
          activePaneId: validatedPaneId,
        })
      )
    },
    [persistedLayoutTree, defaultLayout, panelWindowId, store]
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
      store.commit(
        layoutPaneAssigned({
          windowId: panelWindowId,
          layoutTree,
          activePaneId,
        })
      )
      if (triggerDevServer && isWorkspaceContainerized(workspaceId)) {
        autoOpenDevServerRef.current?.(activePaneId)?.catch((error) => {
          console.warn('[auto-open] dev server spawn failed:', error)
        })
      }
    },
    [panelWindowId, store, isWorkspaceContainerized]
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
    [persistedLayoutTree, defaultLayout, commitAssignment]
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
        const updatedLeaf: LeafNode = {
          ...targetNode,
          devServerOpen: false,
        }
        const newTree = replaceNode(base, paneId, updatedLeaf)
        store.commit(
          layoutPaneAssigned({
            windowId: panelWindowId,
            layoutTree: newTree,
            activePaneId: persistedActivePaneId,
          })
        )
        return false
      }

      // Toggling ON — reconnect to existing terminal if available
      if (targetNode.devServerTerminalId) {
        const updatedLeaf: LeafNode = {
          ...targetNode,
          devServerOpen: true,
        }
        const newTree = replaceNode(base, paneId, updatedLeaf)
        store.commit(
          layoutPaneAssigned({
            windowId: panelWindowId,
            layoutTree: newTree,
            activePaneId: persistedActivePaneId,
          })
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

      // Re-read the layout to avoid overwriting concurrent changes
      const currentRows = store.query(persistedLayout$)
      const currentRow = currentRows.find(
        (row) => row.windowId === panelWindowId
      )
      const currentTree = currentRow?.layoutTree as PanelNode | undefined
      const currentBase = currentTree ?? defaultLayout
      if (!currentBase) {
        return false
      }

      const currentTarget = findNodeById(currentBase, paneId)
      if (!currentTarget || currentTarget._tag !== 'LeafNode') {
        return false
      }

      const updatedLeaf: LeafNode = {
        ...currentTarget,
        devServerOpen: true,
        devServerTerminalId: result.id,
      }
      const newTree = replaceNode(currentBase, paneId, updatedLeaf)
      store.commit(
        layoutPaneAssigned({
          windowId: panelWindowId,
          layoutTree: newTree,
          activePaneId: currentRow?.activePaneId ?? null,
        })
      )
      return true
    },
    [
      persistedLayoutTree,
      defaultLayout,
      panelWindowId,
      persistedActivePaneId,
      spawnTerminal,
      store,
    ]
  )

  // Keep the auto-open ref in sync with the latest toggle handler
  useEffect(() => {
    autoOpenDevServerRef.current = handleToggleDevServerPane
  }, [handleToggleDevServerPane])

  /**
   * Close a terminal and its associated pane (ungated — no confirmation).
   * If the terminal has no pane, removes it from the service directly.
   */
  const handleCloseTerminalPane = useCallback(
    (terminalId: string) => {
      const base = persistedLayoutTree ?? defaultLayout
      if (base) {
        const leaf = findLeafByTerminalId(base, terminalId)
        if (leaf) {
          handleClosePane(leaf.id)
          return
        }
      }
      // No pane found — remove the terminal from the service directly
      removeTerminalOptimistically(terminalId, '[close-terminal-pane]')
    },
    [
      persistedLayoutTree,
      defaultLayout,
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

      // Remove all workspace panes from the layout tree
      const newTree = closeWorkspacePanes(base, workspaceId)
      if (newTree) {
        const nextActivePaneId = ensureValidActivePaneId(
          newTree,
          persistedActivePaneId
        )
        store.commit(
          layoutPaneClosed({
            windowId: panelWindowId,
            layoutTree: newTree,
            activePaneId: nextActivePaneId,
          })
        )
      } else {
        // All panes closed — commit an empty placeholder
        store.commit(
          layoutPaneClosed({
            windowId: panelWindowId,
            layoutTree: {
              _tag: 'LeafNode' as const,
              id: 'pane-empty',
              paneType: 'terminal' as const,
              terminalId: undefined,
              workspaceId: undefined,
            },
            activePaneId: null,
          })
        )
        hasSeeded.current = false
      }
    },
    [
      persistedLayoutTree,
      defaultLayout,
      panelWindowId,
      persistedActivePaneId,
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

  /**
   * Reorder workspace frames by persisting an explicit workspace ID ordering.
   * Called when the user drag-and-drops workspace frames to rearrange them.
   */
  const handleReorderWorkspaces = useCallback(
    (workspaceOrder: (string | undefined)[]) => {
      // Filter out undefined entries — only persist concrete workspace IDs
      const order = workspaceOrder.filter(
        (id): id is string => id !== undefined
      )
      store.commit(
        layoutWorkspacesReordered({
          windowId: panelWindowId,
          workspaceOrder: order,
        })
      )
    },
    [panelWindowId, store]
  )

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
        | typeof windowTabSwitched
        | typeof windowTabsReordered,
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

  const handleAddWindowTab = useCallback(() => {
    const base = persistedWindowLayout ?? { tabs: [], activeTabId: undefined }
    const newLayout = addWindowTab(base)
    commitWindowLayout(windowTabCreated, newLayout)
  }, [persistedWindowLayout, commitWindowLayout])

  const handleCloseWindowTab = useCallback(() => {
    if (!persistedWindowLayout) {
      return
    }
    const activeId = persistedWindowLayout.activeTabId
    if (!activeId) {
      return
    }
    const newLayout = removeWindowTab(persistedWindowLayout, activeId)
    commitWindowLayout(windowTabClosed, newLayout)
  }, [persistedWindowLayout, commitWindowLayout])

  const handleSwitchWindowTab = useCallback(
    (tabId: string) => {
      if (!persistedWindowLayout) {
        return
      }
      const newLayout = switchWindowTab(persistedWindowLayout, tabId)
      commitWindowLayout(windowTabSwitched, newLayout)
    },
    [persistedWindowLayout, commitWindowLayout]
  )

  const handleSwitchWindowTabByIndex = useCallback(
    (index: number) => {
      if (!persistedWindowLayout) {
        return
      }
      const newLayout = switchWindowTabByIndex(persistedWindowLayout, index)
      commitWindowLayout(windowTabSwitched, newLayout)
    },
    [persistedWindowLayout, commitWindowLayout]
  )

  const handleSwitchWindowTabRelative = useCallback(
    (delta: number) => {
      if (!persistedWindowLayout) {
        return
      }
      const newLayout = switchWindowTabRelative(persistedWindowLayout, delta)
      commitWindowLayout(windowTabSwitched, newLayout)
    },
    [persistedWindowLayout, commitWindowLayout]
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

  const panelActions = useMemo(
    () => ({
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
      reorderWorkspaces: handleReorderWorkspaces,
      addWindowTab: handleAddWindowTab,
      closeWindowTab: handleCloseWindowTab,
      switchWindowTab: handleSwitchWindowTab,
      switchWindowTabByIndex: handleSwitchWindowTabByIndex,
      switchWindowTabRelative: handleSwitchWindowTabRelative,
      reorderWindowTabsDnd: handleReorderWindowTabs,
      windowLayout: persistedWindowLayout,
    }),
    [
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
      handleReorderWorkspaces,
      handleAddWindowTab,
      handleCloseWindowTab,
      handleSwitchWindowTab,
      handleSwitchWindowTabByIndex,
      handleSwitchWindowTabRelative,
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
