import { useAtomSet, useAtomValue } from '@effect-atom/atom-react/Hooks'
import {
  layoutPaneAssigned,
  layoutPaneClosed,
  layoutRestored,
  layoutSplit,
  panelLayout,
  projects,
  workspaces,
} from '@laborer/shared/schema'
import type { LeafNode, PanelNode, SplitNode } from '@laborer/shared/types'
import { queryDb } from '@livestore/livestore'
import { createFileRoute } from '@tanstack/react-router'
import {
  Columns2,
  FolderGit2,
  LayoutDashboard,
  PanelLeftClose,
  PanelLeftOpen,
  Rows2,
  Server,
  Terminal,
  X,
} from 'lucide-react'
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { PanelImperativeHandle } from 'react-resizable-panels'
import { LaborerClient } from '@/atoms/laborer-client'
import { TerminalServiceClient } from '@/atoms/terminal-service-client'
import { AddProjectForm } from '@/components/add-project-form'
import { CreatePlanWorkspace } from '@/components/create-plan-workspace'
import { PlanEditor } from '@/components/plan-editor'
import { PlanIssuesList } from '@/components/plan-issues-list'
import { ProjectGroup } from '@/components/project-group'
import { SidebarSearch } from '@/components/sidebar-search'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { WorkspaceDashboard } from '@/components/workspace-dashboard'
import { useProjectCollapseState } from '@/hooks/use-project-collapse-state'
import { useResponsiveLayout } from '@/hooks/use-responsive-layout'
import { useSidebarWidth } from '@/hooks/use-sidebar-width'
import { useTerminalList } from '@/hooks/use-terminal-list'
import { useTrayWorkspaceCount } from '@/hooks/use-tray-workspace-count'
import { isElectron } from '@/lib/desktop'
import { useLaborerStore } from '@/livestore/store'
import type { NavigationDirection } from '@/panels/layout-utils'
import {
  closePane,
  computeResize,
  ensureValidActivePaneId,
  filterTreeByWorkspace,
  findEmptyTerminalPane,
  findLeafByTerminalId,
  findNodeById,
  findSiblingPaneId,
  generateId,
  getFirstLeafId,
  getLeafIds,
  getLeafNodes,
  getStaleTerminalLeaves,
  getWorkspaceIds,
  reconcileLayout,
  replaceNode,
  splitPane,
} from '@/panels/layout-utils'
import {
  PanelActionsProvider,
  useActivePaneId,
  usePanelActions,
} from '@/panels/panel-context'
import {
  PanelGroupRegistryProvider,
  usePanelGroupRegistry,
} from '@/panels/panel-group-registry'
import { PanelHotkeys } from '@/panels/panel-hotkeys'
import { PanelManager } from '@/panels/panel-manager'

/**
 * Route-level wrapper that provides PanelGroupRegistryProvider above
 * HomeComponent so that usePanelLayout can access the registry.
 *
 * @see Issue #79: Keyboard shortcut — resize panes
 */
function HomeRoute() {
  return (
    <PanelGroupRegistryProvider>
      <HomeComponent />
    </PanelGroupRegistryProvider>
  )
}

export const Route = createFileRoute('/')({
  component: HomeRoute,
})

/** LiveStore query for building the default panel layout. */
const allWorkspaces$ = queryDb(workspaces, { label: 'homePanelWorkspaces' })

/** Session ID for the persisted panel layout row. Single-user, single-session. */
const LAYOUT_SESSION_ID = 'default'

/** Query the persisted panel layout from LiveStore. */
const persistedLayout$ = queryDb(panelLayout, {
  label: 'persistedPanelLayout',
})

/** Mutation atom for spawning terminals via the server's terminal.spawn RPC. */
const spawnTerminalMutation = LaborerClient.mutation('terminal.spawn')

/** Mutation atom for removing terminals via the terminal service's terminal.remove RPC. */
const removeTerminalMutation = TerminalServiceClient.mutation('terminal.remove')

/**
 * Health check query atom — subscribes to the server's health.check RPC.
 * Returns a Result<HealthCheckResponse, RpcError>.
 */
// biome-ignore lint/suspicious/noConfusingVoidType: Effect RPC uses void for empty payloads
const healthCheck$ = LaborerClient.query('health.check', undefined as void)

function HealthCheckStatus() {
  const result = useAtomValue(healthCheck$)
  if (result._tag === 'Initial' || result.waiting) {
    return <span className="text-muted-foreground">connecting...</span>
  }
  if (result._tag === 'Failure') {
    return <span className="text-destructive">disconnected</span>
  }
  return (
    <span className="text-success">
      connected (uptime: {Math.round(result.value.uptime)}s)
    </span>
  )
}

/** LiveStore query for projects (used by PanelHeaderBar to resolve names). */
const allProjects$ = queryDb(projects, { label: 'headerProjects' })

/** The two main content views: terminal panels, cross-project dashboard, or plan editor. */
type MainView = 'panels' | 'dashboard' | 'plan'

/** Displays the contextual label for the current view. */
function ViewContextLabel({ mainView }: { readonly mainView: MainView }) {
  if (mainView === 'panels') {
    return <span className="text-foreground">Panels</span>
  }
  if (mainView === 'dashboard') {
    return <span className="text-foreground">Dashboard</span>
  }
  if (mainView === 'plan') {
    return <span className="text-foreground">Plan</span>
  }
  return null
}

/**
 * Bar rendered at the top of the main content area (right of the sidebar).
 *
 * Shows the sidebar toggle, view toggle (panels / dashboard), and view label.
 * Per-pane actions (split, close, diff, dev server) are now in per-workspace
 * frame headers instead.
 *
 * @see Issue #114: Cross-project workspace dashboard
 */
function PanelHeaderBar({
  mainView,
  onViewChange,
  onToggleSidebar,
  sidebarCollapsed,
}: {
  readonly layout?: PanelNode | undefined
  readonly mainView: MainView
  readonly onViewChange: (view: MainView) => void
  readonly onToggleSidebar?: (() => void) | undefined
  readonly sidebarCollapsed?: boolean
}) {
  return (
    <div className="flex h-8 shrink-0 items-center justify-between border-b px-2">
      {/* Left: sidebar toggle + view toggle + view label */}
      <div className="flex items-center gap-2">
        {onToggleSidebar && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label={
                    sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'
                  }
                  onClick={onToggleSidebar}
                  size="icon-sm"
                  variant="ghost"
                />
              }
            >
              {sidebarCollapsed ? (
                <PanelLeftOpen className="size-3.5" />
              ) : (
                <PanelLeftClose className="size-3.5" />
              )}
            </TooltipTrigger>
            <TooltipContent>
              {sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            </TooltipContent>
          </Tooltip>
        )}
        <div className="flex gap-0.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label="Terminal panels"
                  className={mainView === 'panels' ? 'bg-accent' : ''}
                  onClick={() => onViewChange('panels')}
                  size="icon-sm"
                  variant="ghost"
                />
              }
            >
              <Terminal className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent>Terminal panels</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label="Dashboard"
                  className={mainView === 'dashboard' ? 'bg-accent' : ''}
                  onClick={() => onViewChange('dashboard')}
                  size="icon-sm"
                  variant="ghost"
                />
              }
            >
              <LayoutDashboard className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent>Dashboard</TooltipContent>
          </Tooltip>
        </div>
        <div className="min-w-0 truncate text-muted-foreground text-xs">
          <ViewContextLabel mainView={mainView} />
        </div>
      </div>
    </div>
  )
}

/**
 * Computes an initial panel layout from the current LiveStore state.
 *
 * This is used to seed the layout when there's no persisted layout yet.
 *
 * - Multiple running terminals → horizontal SplitNode (side-by-side panes)
 * - Single running terminal → LeafNode
 * - Active workspaces but no terminals → empty terminal pane
 * - No workspaces → undefined (PanelManager shows empty state)
 */
function useInitialLayout(): PanelNode | undefined {
  const store = useLaborerStore()
  const { terminals: terminalList } = useTerminalList()
  const workspaceList = store.useQuery(allWorkspaces$)

  return useMemo(() => {
    const runningTerminals = terminalList.filter((t) => t.status === 'running')

    // Multiple running terminals → horizontal split
    if (runningTerminals.length > 1) {
      const children: readonly LeafNode[] = runningTerminals.map((t) => ({
        _tag: 'LeafNode' as const,
        id: `pane-${t.id}`,
        paneType: 'terminal' as const,
        terminalId: t.id,
        workspaceId: t.workspaceId,
      }))
      const equalSize = 100 / children.length
      const sizes: readonly number[] = children.map(() => equalSize)
      return {
        _tag: 'SplitNode' as const,
        id: 'split-root',
        direction: 'horizontal' as const,
        children,
        sizes,
      } satisfies SplitNode
    }

    // Single running terminal → single pane
    const runningTerminal = runningTerminals[0]
    if (runningTerminal) {
      return {
        _tag: 'LeafNode' as const,
        id: `pane-${runningTerminal.id}`,
        paneType: 'terminal' as const,
        terminalId: runningTerminal.id,
        workspaceId: runningTerminal.workspaceId,
      } satisfies LeafNode
    }

    // Active workspaces but no terminals → empty terminal pane
    const activeWorkspace = workspaceList.find(
      (ws) => ws.status === 'running' || ws.status === 'creating'
    )
    if (activeWorkspace) {
      return {
        _tag: 'LeafNode' as const,
        id: `pane-empty-${activeWorkspace.id}`,
        paneType: 'terminal' as const,
        terminalId: undefined,
        workspaceId: activeWorkspace.id,
      } satisfies LeafNode
    }

    return undefined
  }, [terminalList, workspaceList])
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
function usePanelLayout() {
  const store = useLaborerStore()
  const initialLayout = useInitialLayout()
  const registry = usePanelGroupRegistry()

  // Read the persisted layout from LiveStore reactively.
  // Returns all rows (should be 0 or 1 for the "default" session).
  const persistedRows = store.useQuery(persistedLayout$)
  const persistedRow = persistedRows.find((row) => row.id === LAYOUT_SESSION_ID)

  // The persisted layout tree, if one exists in LiveStore.
  const persistedLayoutTree = persistedRow?.layoutTree as PanelNode | undefined
  const rawPersistedActivePaneId = persistedRow?.activePaneId ?? null

  // Determine the effective layout: persisted layout takes priority,
  // otherwise fall back to the auto-generated layout from terminals/workspaces.
  const layout = persistedLayoutTree ?? initialLayout

  // Enforce the guaranteed active pane invariant: when a layout exists,
  // activePaneId must reference a valid leaf node. If it's null or stale
  // (pointing to a removed pane), fall back to the first leaf.
  // @see Issue #150: Guaranteed active pane invariant
  const persistedActivePaneId = layout
    ? ensureValidActivePaneId(layout, rawPersistedActivePaneId)
    : null

  // Seed LiveStore with the initial layout when there's no persisted layout
  // but we have an auto-generated one from terminals/workspaces.
  // Sets activePaneId to the first leaf so keyboard shortcuts work immediately.
  // @see Issue #150: Guaranteed active pane invariant
  const hasSeeded = useRef(false)
  useEffect(() => {
    if (!persistedLayoutTree && initialLayout && !hasSeeded.current) {
      hasSeeded.current = true
      store.commit(
        layoutRestored({
          id: LAYOUT_SESSION_ID,
          layoutTree: initialLayout,
          activePaneId: getFirstLeafId(initialLayout) ?? null,
        })
      )
    }
  }, [persistedLayoutTree, initialLayout, store])

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
      const currentRow = currentRows.find((row) => row.id === LAYOUT_SESSION_ID)
      const currentTree = currentRow?.layoutTree as PanelNode | undefined
      if (!currentTree) {
        setIsReconciling(false)
        return
      }

      const reconciled = reconcileLayout(currentTree, liveIds, respawnedIds)
      if (reconciled !== currentTree) {
        store.commit(
          layoutRestored({
            id: LAYOUT_SESSION_ID,
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
    persistedLayoutTree,
    spawnTerminal,
    store,
  ])

  const handleSplitPane = useCallback(
    (paneId: string, direction: 'horizontal' | 'vertical') => {
      const base = persistedLayoutTree ?? initialLayout
      if (!base) {
        return
      }
      const newTree = splitPane(base, paneId, direction)
      store.commit(
        layoutSplit({
          id: LAYOUT_SESSION_ID,
          layoutTree: newTree,
          activePaneId: persistedActivePaneId,
        })
      )
    },
    [persistedLayoutTree, initialLayout, persistedActivePaneId, store]
  )

  const handleClosePane = useCallback(
    (paneId: string) => {
      const base = persistedLayoutTree ?? initialLayout
      if (!base) {
        return
      }

      // Look up the terminal in this pane BEFORE closing, so we can remove
      // it from the terminal service (making it disappear from the sidebar).
      const closingNode = findNodeById(base, paneId)
      if (closingNode?._tag === 'LeafNode' && closingNode.terminalId) {
        removeTerminal({ payload: { id: closingNode.terminalId } }).catch(
          (error) => {
            console.warn('[close-pane] terminal remove failed:', error)
          }
        )
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
            id: LAYOUT_SESSION_ID,
            layoutTree: newTree,
            activePaneId: nextActivePaneId,
          })
        )
      } else {
        // All panes closed — remove the persisted layout so the
        // empty state renders and a new initial layout can seed.
        store.commit(
          layoutPaneClosed({
            id: LAYOUT_SESSION_ID,
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
      initialLayout,
      persistedActivePaneId,
      store,
      removeTerminal,
    ]
  )

  const handleSetActivePaneId = useCallback(
    (paneId: string | null) => {
      const base = persistedLayoutTree ?? initialLayout
      if (!base) {
        return
      }
      // Enforce the invariant: do not accept null when panes exist.
      // If null is passed (e.g., by legacy code), fall back to the first leaf.
      // @see Issue #150: Guaranteed active pane invariant
      const validatedPaneId = ensureValidActivePaneId(base, paneId)
      store.commit(
        layoutPaneAssigned({
          id: LAYOUT_SESSION_ID,
          layoutTree: base,
          activePaneId: validatedPaneId,
        })
      )
    },
    [persistedLayoutTree, initialLayout, store]
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
          id: LAYOUT_SESSION_ID,
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
    [store, isWorkspaceContainerized]
  )

  const handleAssignTerminalToPane = useCallback(
    (terminalId: string, workspaceId: string, paneId?: string) => {
      const base = persistedLayoutTree ?? initialLayout

      // If no specific pane target, check if this terminal already has a pane.
      // If so, just focus it instead of creating a duplicate.
      if (!paneId && base) {
        const existingLeaf = findLeafByTerminalId(base, terminalId)
        if (existingLeaf) {
          commitAssignment(base, existingLeaf.id, workspaceId, false)
          return
        }
      }

      if (!base) {
        // No layout at all — create a new single-pane layout for this terminal
        const newLeafId = generateId('pane')
        const newLeaf: LeafNode = {
          _tag: 'LeafNode' as const,
          id: newLeafId,
          paneType: 'terminal' as const,
          terminalId,
          workspaceId,
        }
        commitAssignment(newLeaf, newLeaf.id, workspaceId, true)
        return
      }

      // If a specific pane ID is given, replace that pane's content
      if (paneId) {
        const targetLeaf: LeafNode = {
          _tag: 'LeafNode' as const,
          id: paneId,
          paneType: 'terminal' as const,
          terminalId,
          workspaceId,
        }
        const newTree = replaceNode(base, paneId, targetLeaf)
        commitAssignment(newTree, paneId, workspaceId, true)
        return
      }

      // No specific pane — find an empty terminal pane or the first pane
      const emptyPane = findEmptyTerminalPane(base)
      if (emptyPane) {
        const updatedLeaf: LeafNode = {
          _tag: 'LeafNode' as const,
          id: emptyPane.id,
          paneType: 'terminal' as const,
          terminalId,
          workspaceId,
        }
        const newTree = replaceNode(base, emptyPane.id, updatedLeaf)
        commitAssignment(newTree, emptyPane.id, workspaceId, true)
        return
      }

      // No empty pane — split the first leaf and assign to the new pane
      const leafIds = getLeafIds(base)
      const firstLeafId = leafIds[0]
      if (firstLeafId) {
        const newPaneContent: Partial<LeafNode> = {
          paneType: 'terminal' as const,
          terminalId,
          workspaceId,
        }
        const newTree = splitPane(
          base,
          firstLeafId,
          'horizontal',
          newPaneContent
        )
        store.commit(
          layoutPaneAssigned({
            id: LAYOUT_SESSION_ID,
            layoutTree: newTree,
            activePaneId: persistedActivePaneId,
          })
        )
      }
    },
    [
      persistedLayoutTree,
      initialLayout,
      persistedActivePaneId,
      store,
      commitAssignment,
    ]
  )

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
      const base = persistedLayoutTree ?? initialLayout
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
    [persistedLayoutTree, initialLayout, registry]
  )

  /**
   * Toggle the integrated diff sidebar on a terminal pane.
   *
   * Flips the `diffOpen` flag on the target LeafNode and persists the
   * updated tree. The diff sidebar is rendered inside the terminal pane
   * container (not as a separate pane in the layout tree).
   *
   * @see Issue #90: Toggle diff alongside terminal
   */
  const handleToggleDiffPane = useCallback(
    (paneId: string): boolean => {
      const base = persistedLayoutTree ?? initialLayout
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

      const nowOpen = !targetNode.diffOpen
      const updatedLeaf: LeafNode = {
        ...targetNode,
        diffOpen: nowOpen,
      }
      const newTree = replaceNode(base, paneId, updatedLeaf)
      store.commit(
        layoutPaneAssigned({
          id: LAYOUT_SESSION_ID,
          layoutTree: newTree,
          activePaneId: persistedActivePaneId,
        })
      )
      return nowOpen
    },
    [persistedLayoutTree, initialLayout, persistedActivePaneId, store]
  )

  /**
   * Toggle the dev server terminal alongside a terminal pane.
   *
   * When toggling ON with no existing dev server terminal: spawns a new
   * container terminal with `autoRun: true` so setup scripts and the dev
   * server start command are auto-typed. Sets `devServerTerminalId` and
   * `devServerOpen` on the leaf node.
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
      const base = persistedLayoutTree ?? initialLayout
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
            id: LAYOUT_SESSION_ID,
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
            id: LAYOUT_SESSION_ID,
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
      const currentRow = currentRows.find((row) => row.id === LAYOUT_SESSION_ID)
      const currentTree = currentRow?.layoutTree as PanelNode | undefined
      const currentBase = currentTree ?? initialLayout
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
          id: LAYOUT_SESSION_ID,
          layoutTree: newTree,
          activePaneId: currentRow?.activePaneId ?? null,
        })
      )
      return true
    },
    [
      persistedLayoutTree,
      initialLayout,
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
      const base = persistedLayoutTree ?? initialLayout
      if (base) {
        const leaf = findLeafByTerminalId(base, terminalId)
        if (leaf) {
          handleClosePane(leaf.id)
          return
        }
      }
      // No pane found — remove the terminal from the service directly
      removeTerminal({ payload: { id: terminalId } }).catch((error) => {
        console.warn('[close-terminal-pane] terminal remove failed:', error)
      })
    },
    [persistedLayoutTree, initialLayout, handleClosePane, removeTerminal]
  )

  const panelActions = useMemo(
    () => ({
      assignTerminalToPane: handleAssignTerminalToPane,
      splitPane: handleSplitPane,
      closePane: handleClosePane,
      setActivePaneId: handleSetActivePaneId,
      toggleDiffPane: handleToggleDiffPane,
      toggleDevServerPane: handleToggleDevServerPane,
      resizePane: handleResizePane,
      closeTerminalPane: handleCloseTerminalPane,
    }),
    [
      handleAssignTerminalToPane,
      handleSplitPane,
      handleClosePane,
      handleSetActivePaneId,
      handleToggleDiffPane,
      handleToggleDevServerPane,
      handleResizePane,
      handleCloseTerminalPane,
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
  }
}

/** LiveStore query for projects (used by sidebar and WelcomeEmptyState). */
const sidebarProjects$ = queryDb(projects, { label: 'sidebarProjects' })

/** LiveStore query for workspaces (used by sidebar search filtering). */
const sidebarWorkspaces$ = queryDb(workspaces, {
  label: 'sidebarWorkspaces',
})

/**
 * Welcome empty state shown in the main content area when no projects
 * are registered. Guides the user to add their first project.
 *
 * @see Issue #118: Empty state — no projects
 */
function WelcomeEmptyState() {
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FolderGit2 />
        </EmptyMedia>
        <EmptyTitle>Welcome to Laborer</EmptyTitle>
        <EmptyDescription>
          Add a git repository to get started. Laborer will create isolated
          workspaces for your AI agents to work in parallel.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <AddProjectForm />
      </EmptyContent>
    </Empty>
  )
}

/**
 * Confirmation dialog shown when attempting to close a terminal pane
 * that has a running process. Prevents accidental loss of running work.
 */
function CloseTerminalDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly onConfirm: () => void
}) {
  const handleConfirm = useCallback(() => {
    onConfirm()
    onOpenChange(false)
  }, [onConfirm, onOpenChange])

  return (
    <AlertDialog onOpenChange={onOpenChange} open={open}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Close terminal?</AlertDialogTitle>
          <AlertDialogDescription>
            This terminal has a running process. Closing the pane will leave the
            process running in the background.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleConfirm}>Close</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function CloseAppDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}) {
  const handleCloseToTray = useCallback(() => {
    if (isElectron()) {
      // In Electron, closing the window is intercepted by the main process
      // which hides it to tray instead of quitting. See Issue 13.
      window.close()
    }
    onOpenChange(false)
  }, [onOpenChange])

  const handleCloseClick = useCallback(() => {
    handleCloseToTray()
  }, [handleCloseToTray])

  return (
    <AlertDialog onOpenChange={onOpenChange} open={open}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Close Laborer?</AlertDialogTitle>
          <AlertDialogDescription>
            The window will be hidden to the system tray. Your workspaces will
            continue running.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleCloseClick}>
            Close
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * Header bar for a single workspace frame. Shows project / branch name
 * and pane action buttons scoped to this workspace's panes.
 */
function WorkspaceFrameHeader({
  workspaceId,
}: {
  readonly workspaceId: string | undefined
}) {
  const store = useLaborerStore()
  const projectList = store.useQuery(allProjects$)
  const workspaceList = store.useQuery(allWorkspaces$)
  const activePaneId = useActivePaneId()
  const actions = usePanelActions()

  const { projectName, branchName, isContainerized } = useMemo(() => {
    if (!workspaceId) {
      return {
        projectName: undefined,
        branchName: undefined,
        isContainerized: false,
      }
    }
    const workspace = workspaceList.find((ws) => ws.id === workspaceId)
    if (!workspace) {
      return {
        projectName: undefined,
        branchName: undefined,
        isContainerized: false,
      }
    }
    const project = projectList.find((p) => p.id === workspace.projectId)
    return {
      projectName: project?.name,
      branchName: workspace.branchName,
      isContainerized: workspace.containerId != null,
    }
  }, [workspaceId, workspaceList, projectList])

  const hasActivePane = !!activePaneId

  return (
    <div className="flex h-8 shrink-0 items-center justify-between border-b px-2">
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1 text-muted-foreground">
          <Terminal className="size-3.5" />
        </div>
        <div className="min-w-0 truncate text-muted-foreground text-xs">
          {projectName && branchName ? (
            <>
              <span className="text-foreground">{projectName}</span>
              <span className="mx-1">/</span>
              <span>{branchName}</span>
            </>
          ) : (
            <span className="text-foreground">Terminal</span>
          )}
        </div>
      </div>
      <div className="flex gap-0.5">
        {isContainerized && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label="Toggle dev server terminal"
                  disabled={!hasActivePane}
                  onClick={() =>
                    activePaneId && actions?.toggleDevServerPane(activePaneId)
                  }
                  size="icon-sm"
                  variant="ghost"
                />
              }
            >
              <Server className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent>Toggle dev server terminal</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label="Split horizontally"
                disabled={!hasActivePane}
                onClick={() =>
                  activePaneId && actions?.splitPane(activePaneId, 'horizontal')
                }
                size="icon-sm"
                variant="ghost"
              />
            }
          >
            <Columns2 className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent>Split horizontally</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label="Split vertically"
                disabled={!hasActivePane}
                onClick={() =>
                  activePaneId && actions?.splitPane(activePaneId, 'vertical')
                }
                size="icon-sm"
                variant="ghost"
              />
            }
          >
            <Rows2 className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent>Split vertically</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label="Close pane"
                disabled={!hasActivePane}
                onClick={() => activePaneId && actions?.closePane(activePaneId)}
                size="icon-sm"
                variant="ghost"
              />
            }
          >
            <X className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent>Close pane</TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}

/**
 * Renders a single workspace's terminal frame: a bordered container with
 * a workspace-specific header and the workspace's panel sub-tree.
 */
function WorkspaceFrame({
  workspaceId,
  subLayout,
  activePaneId,
}: {
  readonly workspaceId: string | undefined
  readonly subLayout: PanelNode
  readonly activePaneId: string | null
}) {
  // Check if the active pane belongs to this workspace frame
  const leaves = useMemo(() => getLeafNodes(subLayout), [subLayout])
  const isActiveFrame = useMemo(
    () => activePaneId != null && leaves.some((l) => l.id === activePaneId),
    [activePaneId, leaves]
  )

  return (
    <div
      className={`flex h-full flex-col border-2 ${isActiveFrame ? 'border-primary' : 'border-transparent'}`}
    >
      <WorkspaceFrameHeader workspaceId={workspaceId} />
      <div className="min-h-0 flex-1">
        <PanelManager layout={subLayout} />
      </div>
    </div>
  )
}

/**
 * Renders workspace frames stacked vertically. Each workspace's terminals
 * get their own frame with a header showing the project / branch name.
 *
 * When there's only one workspace, renders a single frame without
 * resizable splitting overhead. With multiple workspaces, uses
 * ResizablePanelGroup for vertical stacking.
 */
function WorkspaceFrames({
  layout,
  activePaneId,
}: {
  readonly layout: PanelNode
  readonly activePaneId: string | null
}) {
  const workspaceIds = useMemo(() => getWorkspaceIds(layout), [layout])

  const workspaceLayouts = useMemo(() => {
    const layouts: {
      workspaceId: string | undefined
      subLayout: PanelNode
    }[] = []
    for (const wsId of workspaceIds) {
      const subTree = filterTreeByWorkspace(layout, wsId)
      if (subTree) {
        layouts.push({ workspaceId: wsId, subLayout: subTree })
      }
    }
    return layouts
  }, [layout, workspaceIds])

  // Single workspace — no need for resizable splitting
  if (workspaceLayouts.length <= 1) {
    const entry = workspaceLayouts[0]
    if (!entry) {
      return <PanelManager layout={undefined} />
    }
    return (
      <WorkspaceFrame
        activePaneId={activePaneId}
        subLayout={entry.subLayout}
        workspaceId={entry.workspaceId}
      />
    )
  }

  // Multiple workspaces — stack vertically with resizable handles
  const equalSize = 100 / workspaceLayouts.length
  return (
    <ResizablePanelGroup orientation="vertical">
      {workspaceLayouts.map((entry, index) => (
        <WorkspaceFrameResizableChild
          activePaneId={activePaneId}
          defaultSize={equalSize}
          index={index}
          key={entry.workspaceId ?? 'no-workspace'}
          subLayout={entry.subLayout}
          workspaceId={entry.workspaceId}
        />
      ))}
    </ResizablePanelGroup>
  )
}

/**
 * A single resizable child within the WorkspaceFrames vertical stack.
 * Extracted to keep the map clean and provide stable keys.
 */
function WorkspaceFrameResizableChild({
  workspaceId,
  subLayout,
  activePaneId,
  defaultSize,
  index,
}: {
  readonly workspaceId: string | undefined
  readonly subLayout: PanelNode
  readonly activePaneId: string | null
  readonly defaultSize: number
  readonly index: number
}) {
  return (
    <>
      {index > 0 && <ResizableHandle />}
      <ResizablePanel defaultSize={`${defaultSize}%`} minSize="10%">
        <WorkspaceFrame
          activePaneId={activePaneId}
          subLayout={subLayout}
          workspaceId={workspaceId}
        />
      </ResizablePanel>
    </>
  )
}

/**
 * Renders the main panel area content, handling the reconciling/loading,
 * workspace frames, or empty state.
 */
function PanelContent({
  isReconciling,
  layout,
  activePaneId,
}: {
  readonly isReconciling: boolean
  readonly layout: PanelNode | undefined
  readonly activePaneId: string | null
}) {
  if (isReconciling) {
    return (
      <div className="flex h-full items-center justify-center bg-background">
        <p className="text-muted-foreground text-sm">
          Restoring terminal sessions...
        </p>
      </div>
    )
  }
  if (layout) {
    return <WorkspaceFrames activePaneId={activePaneId} layout={layout} />
  }
  return <PanelManager layout={undefined} />
}

function HomeComponent() {
  const {
    layout,
    panelActions,
    activePaneId,
    leafPaneIds,
    isReconciling,
    liveTerminals,
  } = usePanelLayout()
  const store = useLaborerStore()
  const projectList = store.useQuery(sidebarProjects$)
  const workspaceList = store.useQuery(sidebarWorkspaces$)
  const hasProjects = projectList.length > 0

  // Close-terminal confirmation dialog state
  const [closeTerminalDialogOpen, setCloseTerminalDialogOpen] = useState(false)
  const pendingClosePaneIdRef = useRef<string | null>(null)

  /**
   * Gated closePane that checks if the terminal has a running process.
   * If running, shows a confirmation dialog. Otherwise closes immediately.
   */
  const gatedClosePane = useCallback(
    (paneId: string) => {
      // Resolve the leaf node to get its terminalId
      if (layout) {
        const node = findNodeById(layout, paneId)
        if (node && node._tag === 'LeafNode' && node.terminalId) {
          const terminal = liveTerminals.find((t) => t.id === node.terminalId)
          if (terminal && terminal.status === 'running') {
            // Terminal is running — show confirmation dialog
            pendingClosePaneIdRef.current = paneId
            setCloseTerminalDialogOpen(true)
            return
          }
        }
      }
      // Terminal is stopped or no terminal — close immediately
      panelActions.closePane(paneId)
    },
    [layout, liveTerminals, panelActions]
  )

  const handleConfirmCloseTerminal = useCallback(() => {
    const paneId = pendingClosePaneIdRef.current
    if (paneId) {
      panelActions.closePane(paneId)
      pendingClosePaneIdRef.current = null
    }
  }, [panelActions])

  /**
   * Close a terminal and its associated pane.
   * If the terminal is running, shows a confirmation dialog first.
   * If the terminal has no pane, falls back to the ungated handler
   * which removes it from the service directly.
   */
  const gatedCloseTerminalPane = useCallback(
    (terminalId: string) => {
      if (layout) {
        const leaf = findLeafByTerminalId(layout, terminalId)
        if (leaf) {
          gatedClosePane(leaf.id)
          return
        }
      }
      // No pane found — delegate to the ungated handler
      panelActions.closeTerminalPane(terminalId)
    },
    [layout, gatedClosePane, panelActions]
  )

  // Override panelActions.closePane with the gated version
  const gatedPanelActions = useMemo(
    () => ({
      ...panelActions,
      closePane: gatedClosePane,
      closeTerminalPane: gatedCloseTerminalPane,
    }),
    [panelActions, gatedClosePane, gatedCloseTerminalPane]
  )

  // Sync running workspace count to Electron system tray tooltip (no-op in browser)
  useTrayWorkspaceCount()

  // Responsive sizing — adapts sidebar and pane sizes to viewport width
  const responsiveSizes = useResponsiveLayout()

  // Sidebar width persistence — restore from localStorage, debounced writes
  const sidebarWidth = useSidebarWidth(
    Number.parseFloat(responsiveSizes.sidebarMin),
    Number.parseFloat(responsiveSizes.sidebarMax)
  )

  // Project collapse state — persisted to localStorage
  const collapseState = useProjectCollapseState()

  // Sidebar search — filters the project tree in real-time
  const [searchQuery, setSearchQuery] = useState('')

  // Filter projects and determine which to show based on search query.
  // A project is shown if its name matches OR any of its non-destroyed
  // workspace branch names match. Matching is case-insensitive substring.
  const { filteredProjects, matchingProjectIds } = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (query.length === 0) {
      return {
        filteredProjects: projectList,
        matchingProjectIds: new Set<string>(),
      }
    }
    const matching = new Set<string>()
    const filtered = projectList.filter((project) => {
      const nameMatch = project.name.toLowerCase().includes(query)
      const workspaceMatch = workspaceList.some(
        (ws) =>
          ws.projectId === project.id &&
          ws.status !== 'destroyed' &&
          ws.branchName.toLowerCase().includes(query)
      )
      if (nameMatch || workspaceMatch) {
        matching.add(project.id)
        return true
      }
      return false
    })
    return { filteredProjects: filtered, matchingProjectIds: matching }
  }, [searchQuery, projectList, workspaceList])

  // When search is active, auto-expand matching projects (override collapse state).
  // When search is cleared, the stored collapse state is naturally restored.
  const isSearchActive = searchQuery.trim().length > 0

  // Main content view toggle — panels (terminal panes), dashboard, or plan editor
  const [mainView, setMainView] = useState<MainView>('panels')
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null)
  const [isCloseAppDialogOpen, setIsCloseAppDialogOpen] = useState(false)

  // Handle plan selection from sidebar — switch to plan view
  const handleSelectPlan = useCallback((prdId: string) => {
    setSelectedPlanId(prdId)
    setMainView('plan')
  }, [])

  // Handle back from plan editor — return to panels view
  const handlePlanBack = useCallback(() => {
    setSelectedPlanId(null)
    setMainView('panels')
  }, [])

  // Sidebar collapse via imperative panel ref
  const sidebarPanelRef = useRef<PanelImperativeHandle | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  const handleSidebarResize = useCallback(
    (panelSize: { asPercentage: number }) => {
      const panel = sidebarPanelRef.current
      if (panel) {
        setSidebarCollapsed(panel.isCollapsed())
      }
      sidebarWidth.handleResize(panelSize.asPercentage)
    },
    [sidebarWidth.handleResize]
  )

  const toggleSidebar = useCallback(() => {
    const panel = sidebarPanelRef.current
    if (!panel) {
      return
    }
    if (panel.isCollapsed()) {
      panel.expand()
    } else {
      panel.collapse()
    }
  }, [])

  const handleMetaWWithoutPane = useCallback(() => {
    if (mainView === 'panels') {
      setIsCloseAppDialogOpen(true)
    }
  }, [mainView])

  return (
    <PanelActionsProvider activePaneId={activePaneId} value={gatedPanelActions}>
      <CloseTerminalDialog
        onConfirm={handleConfirmCloseTerminal}
        onOpenChange={setCloseTerminalDialogOpen}
        open={closeTerminalDialogOpen}
      />
      <CloseAppDialog
        onOpenChange={setIsCloseAppDialogOpen}
        open={isCloseAppDialogOpen}
      />
      <ResizablePanelGroup
        orientation="horizontal"
        style={{ height: 'calc(100vh - 53px)' }}
      >
        {/* Sidebar — search, project groups, workspace list, health check */}
        <ResizablePanel
          collapsedSize="0%"
          collapsible={responsiveSizes.canCollapseSidebar}
          defaultSize={
            sidebarWidth.storedDefault ?? responsiveSizes.sidebarDefault
          }
          maxSize={responsiveSizes.sidebarMax}
          minSize={responsiveSizes.sidebarMin}
          onResize={handleSidebarResize}
          panelRef={sidebarPanelRef}
        >
          <div className="flex h-full flex-col">
            <ScrollArea className="min-h-0 flex-1">
              <div className="grid gap-4 p-3">
                {/* Search bar — filters projects and workspaces in real-time */}
                {hasProjects && (
                  <SidebarSearch
                    onChange={setSearchQuery}
                    value={searchQuery}
                  />
                )}
                <div className="flex items-center justify-between">
                  <h2 className="font-medium text-sm">Projects</h2>
                  <AddProjectForm />
                </div>
                {/* Project-grouped tree — each project is a collapsible heading */}
                {filteredProjects.map((project) => (
                  <ProjectGroup
                    expanded={
                      isSearchActive && matchingProjectIds.has(project.id)
                        ? true
                        : collapseState.isExpanded(project.id)
                    }
                    key={project.id}
                    onSelectPlan={handleSelectPlan}
                    onToggle={() => collapseState.toggle(project.id)}
                    project={project}
                    selectedPlanId={selectedPlanId}
                  />
                ))}
                {projectList.length === 0 && (
                  <p className="py-2 text-center text-muted-foreground text-xs">
                    No projects. Add one to get started.
                  </p>
                )}
                {isSearchActive &&
                  filteredProjects.length === 0 &&
                  projectList.length > 0 && (
                    <p className="py-2 text-center text-muted-foreground text-xs">
                      No matching projects or workspaces.
                    </p>
                  )}
              </div>
            </ScrollArea>
            {/* Server Status — sticky footer, always visible outside scroll area */}
            <section className="shrink-0 border-t p-3">
              <h2 className="mb-1 font-medium text-sm">Server Status</h2>
              <p className="text-xs">
                <Suspense
                  fallback={
                    <span className="text-muted-foreground">loading...</span>
                  }
                >
                  <HealthCheckStatus />
                </Suspense>
              </p>
            </section>
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle />

        {/* Main content — Panel system, dashboard, plan editor, or welcome empty state */}
        <ResizablePanel defaultSize="75%" minSize="10%">
          {!hasProjects && <WelcomeEmptyState />}
          {hasProjects && mainView === 'plan' && selectedPlanId && (
            <div className="flex h-full flex-col border-2 border-transparent">
              <PanelHeaderBar
                layout={layout}
                mainView={mainView}
                onToggleSidebar={
                  responsiveSizes.canCollapseSidebar ? toggleSidebar : undefined
                }
                onViewChange={setMainView}
                sidebarCollapsed={sidebarCollapsed}
              />
              <div className="flex min-h-0 flex-1 flex-col md:flex-row">
                <div className="min-h-0 min-w-0 flex-1">
                  <PlanEditor onBack={handlePlanBack} prdId={selectedPlanId} />
                </div>
                <div className="h-64 shrink-0 border-t md:h-auto md:w-80 md:border-t-0 md:border-l">
                  <div className="flex h-8 shrink-0 items-center justify-between border-b px-3">
                    <span className="font-medium text-sm">Issues</span>
                  </div>
                  <ScrollArea className="h-[calc(100%-2rem)]">
                    <div className="grid gap-3 p-3">
                      <CreatePlanWorkspace prdId={selectedPlanId} />
                      <PlanIssuesList prdId={selectedPlanId} />
                    </div>
                  </ScrollArea>
                </div>
              </div>
            </div>
          )}
          {hasProjects && mainView !== 'plan' && (
            <div className="flex h-full flex-col">
              <PanelHeaderBar
                layout={layout}
                mainView={mainView}
                onToggleSidebar={
                  responsiveSizes.canCollapseSidebar ? toggleSidebar : undefined
                }
                onViewChange={setMainView}
                sidebarCollapsed={sidebarCollapsed}
              />
              {mainView === 'panels' && (
                <>
                  <PanelHotkeys
                    layout={layout}
                    leafPaneIds={leafPaneIds}
                    onMetaWWithoutPane={handleMetaWWithoutPane}
                  />
                  <PanelContent
                    activePaneId={activePaneId}
                    isReconciling={isReconciling}
                    layout={layout}
                  />
                </>
              )}
              {mainView === 'dashboard' && (
                <div
                  className={`flex h-full flex-col border-2 ${activePaneId ? 'border-primary' : 'border-transparent'}`}
                >
                  <div className="min-h-0 flex-1">
                    <WorkspaceDashboard />
                  </div>
                </div>
              )}
            </div>
          )}
        </ResizablePanel>
      </ResizablePanelGroup>
    </PanelActionsProvider>
  )
}
