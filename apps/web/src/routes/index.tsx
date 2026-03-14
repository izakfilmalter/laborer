import { useAtomSet } from '@effect-atom/atom-react/Hooks'
import { projects, workspaces } from '@laborer/shared/schema'
import type { LeafNode, PaneType } from '@laborer/shared/types'
import { queryDb } from '@livestore/livestore'
import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PanelImperativeHandle } from 'react-resizable-panels'
import { toast } from 'sonner'
import { LaborerClient } from '@/atoms/laborer-client'
import { AddProjectForm } from '@/components/add-project-form'
import { CreatePlanWorkspace } from '@/components/create-plan-workspace'
import { PlanEditor } from '@/components/plan-editor'
import { PlanIssuesList } from '@/components/plan-issues-list'
import { ProjectGroup } from '@/components/project-group'
import { SidebarSearch } from '@/components/sidebar-search'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable'
import { ScrollArea } from '@/components/ui/scroll-area'
import { WorkspaceDashboard } from '@/components/workspace-dashboard'
import { useActivateWorkspace } from '@/hooks/use-activate-workspace'
import { useAgentNotifications } from '@/hooks/use-agent-notifications'
import { useProjectCollapseState } from '@/hooks/use-project-collapse-state'
import { useResponsiveLayout } from '@/hooks/use-responsive-layout'
import { useSidebarWidth } from '@/hooks/use-sidebar-width'
import { useTerminalList } from '@/hooks/use-terminal-list'
import { useTrayWorkspaceCount } from '@/hooks/use-tray-workspace-count'
import { extractErrorMessage } from '@/lib/utils'
import { useLaborerStore } from '@/livestore/store'
import { DiffScrollProvider } from '@/panels/diff-scroll-context'
import {
  computeClosePaneGateAction,
  computeCloseWorkspaceAction,
  findLeafByTerminalId,
  findNodeById,
  getLeafNodes,
} from '@/panels/layout-utils'
import {
  PanelActionsProvider,
  type PendingCloseState,
  type PendingPickerState,
  type PickerMode,
} from '@/panels/panel-context'
import { PanelGroupRegistryProvider } from '@/panels/panel-group-registry'
import { PanelHotkeys } from '@/panels/panel-hotkeys'
import {
  getActiveWindowTab,
  getWorkspaceTileLeaves,
  shouldConfirmClosePanelTab,
  shouldConfirmCloseWindowTab,
} from '@/panels/window-tab-utils'
import {
  CloseAppDialog,
  ClosePanelTabDialog,
  CloseWindowTabDialog,
  CloseWorkspaceDialog,
  DestroyWorkspaceOnCloseDialog,
} from './-components/close-dialogs'
import { PanelContent } from './-components/panel-content'
import type { MainView } from './-components/panel-header-bar'
import { PanelHeaderBar } from './-components/panel-header-bar'
import { WelcomeEmptyState } from './-components/welcome-empty-state'
import { usePanelLayout } from './-hooks/use-panel-layout'

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

/** LiveStore query for projects (used by sidebar and WelcomeEmptyState). */
const sidebarProjects$ = queryDb(projects, { label: 'sidebarProjects' })

const destroyWorkspaceMutation = LaborerClient.mutation('workspace.destroy')

/** LiveStore query for workspaces (used by sidebar search filtering). */
const sidebarWorkspaces$ = queryDb(workspaces, {
  label: 'sidebarWorkspaces',
})

function HomeComponent() {
  const {
    layout,
    panelActions,
    activePaneId,
    leafPaneIds,
    isReconciling,
    liveTerminals,
    workspaceOrder,
  } = usePanelLayout()

  // Derive the active workspace ID from the active pane for sidebar highlighting.
  const activeWorkspaceId = useMemo(() => {
    if (!(activePaneId && layout)) {
      return null
    }
    const node = findNodeById(layout, activePaneId)
    return node?._tag === 'LeafNode' ? (node.workspaceId ?? null) : null
  }, [activePaneId, layout])

  // Extract the active window tab's workspace tile layout for bidirectional tiling.
  // When available, WorkspaceFrames uses this for hierarchical rendering instead
  // of extracting workspaces from the flat PanelNode tree.
  const activeWindowTab = useMemo(() => {
    const windowLayout = panelActions.windowLayout
    if (!windowLayout) {
      return undefined
    }
    return getActiveWindowTab(windowLayout)
  }, [panelActions.windowLayout])

  const workspaceTileLayout = activeWindowTab?.workspaceLayout

  // Detect when the active window tab exists but has no workspaces.
  // This triggers the empty window tab state (workspace picker).
  const isEmptyWindowTab = activeWindowTab !== undefined && !workspaceTileLayout

  const store = useLaborerStore()
  const projectList = store.useQuery(sidebarProjects$)
  const workspaceList = store.useQuery(sidebarWorkspaces$)
  const hasProjects = projectList.length > 0

  const destroyWorkspace = useAtomSet(destroyWorkspaceMutation, {
    mode: 'promise',
  })

  /**
   * Look up the PR state for a workspace by its ID.
   * Returns null if the workspace is not found or has no PR.
   */
  const getWorkspacePrState = useCallback(
    (workspaceId: string): string | null => {
      const ws = workspaceList.find((w) => w.id === workspaceId)
      return ws?.prState ?? null
    },
    [workspaceList]
  )

  /**
   * Look up the PR state for the workspace that owns a given pane.
   * Returns null if the pane or workspace can't be found.
   */
  const getPanePrState = useCallback(
    (paneId: string): string | null => {
      if (!layout) {
        return null
      }
      const node = findNodeById(layout, paneId)
      if (!node || node._tag !== 'LeafNode' || !node.workspaceId) {
        return null
      }
      return getWorkspacePrState(node.workspaceId)
    },
    [layout, getWorkspacePrState]
  )

  // Fullscreen pane state — transient UI mode (not persisted to LiveStore).
  // When set, only the fullscreened pane is shown, hiding all other
  // workspaces and sibling panes. The workspace bar header remains visible.
  const [fullscreenPaneId, setFullscreenPaneId] = useState<string | null>(null)

  // Auto-exit fullscreen when the fullscreened pane no longer exists in the layout
  // (e.g., if the pane was closed while fullscreened).
  useEffect(() => {
    if (fullscreenPaneId && layout) {
      const node = findNodeById(layout, fullscreenPaneId)
      if (!node) {
        setFullscreenPaneId(null)
      }
    }
  }, [fullscreenPaneId, layout])

  const toggleFullscreenPane = useCallback(() => {
    setFullscreenPaneId((current) => {
      if (current) {
        // Already fullscreened — exit fullscreen
        return null
      }
      // Enter fullscreen for the active pane
      return activePaneId
    })
  }, [activePaneId])

  // Review panel state — transient UI mode (not persisted to LiveStore).
  // When set to a workspace ID, the full-height review panel is shown
  // alongside all workspace frames. The panel spans the full height of
  // the panel area, not just a single workspace.
  const [reviewPaneWorkspaceId, setReviewPaneWorkspaceId] = useState<
    string | null
  >(null)

  // Diff panel state — transient UI mode (not persisted to LiveStore).
  // When set to a workspace ID, the full-height diff panel is shown
  // alongside all workspace frames. The panel spans the full height of
  // the panel area, not just a single workspace.
  const [diffPaneWorkspaceId, setDiffPaneWorkspaceId] = useState<string | null>(
    null
  )

  // Auto-close review panel when the workspace no longer exists in the layout
  // (e.g., if the workspace was closed while the review panel was open).
  useEffect(() => {
    if (reviewPaneWorkspaceId && layout) {
      const leaves = getLeafNodes(layout)
      const workspaceExists = leaves.some(
        (l) => l.workspaceId === reviewPaneWorkspaceId
      )
      if (!workspaceExists) {
        setReviewPaneWorkspaceId(null)
      }
    }
  }, [reviewPaneWorkspaceId, layout])

  // Auto-close diff panel when the workspace no longer exists in the layout.
  useEffect(() => {
    if (diffPaneWorkspaceId && layout) {
      const leaves = getLeafNodes(layout)
      const workspaceExists = leaves.some(
        (l) => l.workspaceId === diffPaneWorkspaceId
      )
      if (!workspaceExists) {
        setDiffPaneWorkspaceId(null)
      }
    }
  }, [diffPaneWorkspaceId, layout])

  /**
   * Toggle the full-height review panel for the workspace of the given pane.
   * If the review panel is already open for that workspace, closes it.
   * If it's open for a different workspace, switches to the new workspace.
   *
   * @param paneId - The pane ID to get the workspace from
   * @returns Whether the review panel is now open
   */
  const toggleReviewPane = useCallback(
    (paneId: string): boolean => {
      if (!layout) {
        return false
      }

      const node = findNodeById(layout, paneId)
      if (!node || node._tag !== 'LeafNode' || !node.workspaceId) {
        return false
      }

      const workspaceId = node.workspaceId

      setReviewPaneWorkspaceId((current) => {
        if (current === workspaceId) {
          // Already showing review panel for this workspace — close it
          return null
        }
        // Open review panel for this workspace
        return workspaceId
      })

      // Return true if the panel will be open after this toggle
      return reviewPaneWorkspaceId !== workspaceId
    },
    [layout, reviewPaneWorkspaceId]
  )

  /**
   * Toggle the full-height diff panel for the workspace of the given pane.
   * If the diff panel is already open for that workspace, closes it.
   * If it's open for a different workspace, switches to the new workspace.
   *
   * @param paneId - The pane ID to get the workspace from
   * @returns Whether the diff panel is now open
   */
  const toggleDiffPane = useCallback(
    (paneId: string): boolean => {
      if (!layout) {
        return false
      }

      const node = findNodeById(layout, paneId)
      if (!node || node._tag !== 'LeafNode' || !node.workspaceId) {
        return false
      }

      const workspaceId = node.workspaceId

      setDiffPaneWorkspaceId((current) => {
        if (current === workspaceId) {
          // Already showing diff panel for this workspace — close it
          return null
        }
        // Open diff panel for this workspace
        return workspaceId
      })

      // Return true if the panel will be open after this toggle
      return diffPaneWorkspaceId !== workspaceId
    },
    [layout, diffPaneWorkspaceId]
  )

  // Close-terminal confirmation dialog state — the pane ID is stored in
  // state (not a ref) so that changes trigger a re-render, allowing the
  // LeafPaneRenderer to show the inline confirmation dialog via context.
  const [pendingClosePaneId, setPendingClosePaneId] = useState<string | null>(
    null
  )
  // The workspace ID to offer "close and destroy" for in the inline dialog.
  // Set when the pane being closed is the last for a merged-PR workspace
  // AND the terminal has a running process.
  const pendingDestroyWorkspaceIdRef = useRef<string | null>(null)

  // Destroy-workspace-on-close dialog state — shown when closing the last
  // pane of a merged-PR workspace with no running process.
  const [destroyOnCloseDialogOpen, setDestroyOnCloseDialogOpen] =
    useState(false)
  const destroyOnCloseWorkspaceIdRef = useRef<string | null>(null)
  const destroyOnClosePaneIdRef = useRef<string | null>(null)

  /**
   * Destroy a workspace worktree and close all its panes.
   * Used by both the inline "Close & Destroy" button and the prompt dialog.
   */
  const handleDestroyWorkspaceAndClose = useCallback(
    (workspaceId: string) => {
      const ws = workspaceList.find((w) => w.id === workspaceId)
      const branchName = ws?.branchName ?? 'workspace'

      const toastId = toast.loading(`Destroying workspace "${branchName}"...`)
      destroyWorkspace({
        payload: { workspaceId, force: true },
      })
        .then(() => {
          panelActions.forceCloseWorkspace(workspaceId)
          toast.success(`Workspace "${branchName}" destroyed successfully`, {
            id: toastId,
          })
        })
        .catch((error: unknown) => {
          const message = extractErrorMessage(error)
          toast.error(message, { id: toastId })
        })
    },
    [destroyWorkspace, panelActions, workspaceList]
  )

  /**
   * Gated closePane that checks if the terminal has a running child process
   * and whether the pane is the last for a merged-PR workspace.
   *
   * Uses the cached terminal list (from the 5-second poll) to make an
   * instant, synchronous decision — no RPC calls at close time. This
   * follows the same pattern as VS Code's ChildProcessMonitor: process
   * state is pre-cached and read synchronously at close time.
   *
   * Returns one of four outcomes:
   * - close: close immediately
   * - confirm: show "process running" dialog (Cancel, Close)
   * - confirm-with-destroy: show dialog with 3 actions (Cancel, Close, Close & Destroy)
   * - prompt-destroy: no process but last pane + merged PR — show destroy dialog
   */
  const gatedClosePane = useCallback(
    (paneId: string) => {
      const prState = getPanePrState(paneId)
      const result = computeClosePaneGateAction(
        layout,
        paneId,
        liveTerminals,
        prState
      )

      if (result.action === 'close') {
        panelActions.closePane(paneId)
      } else if (result.action === 'confirm') {
        pendingDestroyWorkspaceIdRef.current = null
        setPendingClosePaneId(paneId)
      } else if (result.action === 'confirm-with-destroy') {
        pendingDestroyWorkspaceIdRef.current = result.workspaceId
        setPendingClosePaneId(paneId)
      } else if (result.action === 'prompt-destroy') {
        destroyOnCloseWorkspaceIdRef.current = result.workspaceId
        destroyOnClosePaneIdRef.current = paneId
        setDestroyOnCloseDialogOpen(true)
      }
    },
    [getPanePrState, layout, liveTerminals, panelActions]
  )

  const handleConfirmCloseTerminal = useCallback(() => {
    if (pendingClosePaneId) {
      panelActions.closePane(pendingClosePaneId)
      setPendingClosePaneId(null)
      pendingDestroyWorkspaceIdRef.current = null
    }
  }, [panelActions, pendingClosePaneId])

  const handleCancelCloseTerminal = useCallback(() => {
    setPendingClosePaneId(null)
    pendingDestroyWorkspaceIdRef.current = null
  }, [])

  /** Close pane AND destroy the workspace worktree. */
  const handleCloseAndDestroyFromInline = useCallback(() => {
    const workspaceId = pendingDestroyWorkspaceIdRef.current
    if (workspaceId) {
      handleDestroyWorkspaceAndClose(workspaceId)
    }
    setPendingClosePaneId(null)
    pendingDestroyWorkspaceIdRef.current = null
  }, [handleDestroyWorkspaceAndClose])

  /** Handle the destroy-on-close dialog confirmation (close & destroy). */
  const handleDestroyOnCloseConfirm = useCallback(() => {
    const workspaceId = destroyOnCloseWorkspaceIdRef.current
    const paneId = destroyOnClosePaneIdRef.current
    if (workspaceId) {
      handleDestroyWorkspaceAndClose(workspaceId)
    } else if (paneId) {
      // Fallback: just close the pane
      panelActions.closePane(paneId)
    }
    destroyOnCloseWorkspaceIdRef.current = null
    destroyOnClosePaneIdRef.current = null
  }, [handleDestroyWorkspaceAndClose, panelActions])

  /** Handle the destroy-on-close dialog "Close" (close pane without destroying). */
  const handleDestroyOnCloseJustClose = useCallback(() => {
    const paneId = destroyOnClosePaneIdRef.current
    if (paneId) {
      panelActions.closePane(paneId)
    }
    destroyOnCloseWorkspaceIdRef.current = null
    destroyOnClosePaneIdRef.current = null
  }, [panelActions])

  /** Context value for the pane-scoped close confirmation dialog. */
  const pendingCloseState: PendingCloseState = useMemo(
    () => ({
      paneId: pendingClosePaneId,
      onConfirm: handleConfirmCloseTerminal,
      onCancel: handleCancelCloseTerminal,
      onCloseAndDestroy:
        pendingDestroyWorkspaceIdRef.current != null
          ? handleCloseAndDestroyFromInline
          : undefined,
    }),
    [
      pendingClosePaneId,
      handleConfirmCloseTerminal,
      handleCancelCloseTerminal,
      handleCloseAndDestroyFromInline,
    ]
  )

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

  // Close-workspace confirmation dialog state
  const [closeWorkspaceDialogOpen, setCloseWorkspaceDialogOpen] =
    useState(false)
  const pendingCloseWorkspaceIdRef = useRef<string | null>(null)

  /**
   * Gated closeWorkspace that checks if any terminal in the workspace has
   * a running child process. Shows a confirmation dialog when there are
   * active processes to prevent accidental loss of running work.
   *
   * Uses the cached terminal list for an instant, synchronous decision —
   * same pattern as gatedClosePane above.
   */
  const gatedCloseWorkspace = useCallback(
    (workspaceId: string) => {
      if (
        computeCloseWorkspaceAction(layout, workspaceId, liveTerminals) ===
        'confirm'
      ) {
        pendingCloseWorkspaceIdRef.current = workspaceId
        setCloseWorkspaceDialogOpen(true)
        return
      }
      panelActions.closeWorkspace(workspaceId)
    },
    [layout, liveTerminals, panelActions]
  )

  const handleConfirmCloseWorkspace = useCallback(() => {
    const workspaceId = pendingCloseWorkspaceIdRef.current
    if (workspaceId) {
      panelActions.closeWorkspace(workspaceId)
      pendingCloseWorkspaceIdRef.current = null
    }
  }, [panelActions])

  // Close-panel-tab confirmation dialog state — shown when the progressive
  // close chain attempts to close a panel tab that has running processes.
  const [closePanelTabDialogOpen, setClosePanelTabDialogOpen] = useState(false)
  const pendingClosePanelTabRef = useRef<{
    workspaceId: string
    tabId: string
  } | null>(null)

  /**
   * Gated removePanelTab that checks if any terminal in the panel tab has
   * a running child process. Shows a confirmation dialog when there are
   * active processes.
   */
  const gatedRemovePanelTab = useCallback(
    (workspaceId: string, tabId: string) => {
      const windowLayout = panelActions.windowLayout
      if (!windowLayout) {
        panelActions.removePanelTab?.(workspaceId, tabId)
        return
      }
      // Find the workspace tile leaf and panel tab
      const activeTab = getActiveWindowTab(windowLayout)
      if (!activeTab?.workspaceLayout) {
        panelActions.removePanelTab?.(workspaceId, tabId)
        return
      }
      const leaves = getWorkspaceTileLeaves(activeTab.workspaceLayout)
      const leaf = leaves.find((l) => l.workspaceId === workspaceId)
      const panelTab = leaf?.panelTabs.find((t) => t.id === tabId)
      if (panelTab && shouldConfirmClosePanelTab(panelTab, liveTerminals)) {
        pendingClosePanelTabRef.current = { workspaceId, tabId }
        setClosePanelTabDialogOpen(true)
        return
      }
      panelActions.removePanelTab?.(workspaceId, tabId)
    },
    [panelActions, liveTerminals]
  )

  const handleConfirmClosePanelTab = useCallback(() => {
    const pending = pendingClosePanelTabRef.current
    if (pending) {
      panelActions.removePanelTab?.(pending.workspaceId, pending.tabId)
      pendingClosePanelTabRef.current = null
    }
  }, [panelActions])

  // Close-window-tab confirmation dialog state — shown when closing a
  // window tab that has terminals with running processes.
  const [closeWindowTabDialogOpen, setCloseWindowTabDialogOpen] =
    useState(false)

  /**
   * Gated closeWindowTab that checks if any terminal across all workspaces
   * in the window tab has a running child process.
   */
  const gatedCloseWindowTab = useCallback(() => {
    const windowLayout = panelActions.windowLayout
    if (!windowLayout) {
      panelActions.closeWindowTab?.()
      return
    }
    const activeTab = getActiveWindowTab(windowLayout)
    if (activeTab && shouldConfirmCloseWindowTab(activeTab, liveTerminals)) {
      setCloseWindowTabDialogOpen(true)
      return
    }
    panelActions.closeWindowTab?.()
  }, [panelActions, liveTerminals])

  const handleConfirmCloseWindowTab = useCallback(() => {
    panelActions.closeWindowTab?.()
  }, [panelActions])

  // Panel type picker state — when set, shows the picker overlay on the
  // specified pane. On type selection, the pending action (split/new tab)
  // is performed. Follows the same pattern as pendingClosePaneId.
  const [pickerMode, setPickerMode] = useState<PickerMode | null>(null)

  /**
   * Show the panel type picker. When a type is selected, the corresponding
   * split or new-tab action is performed and the picker is dismissed.
   */
  const showPanelTypePicker = useCallback((mode: PickerMode) => {
    setPickerMode(mode)
  }, [])

  const handlePickerSelect = useCallback(
    (type: PaneType) => {
      if (!pickerMode) {
        return
      }
      if (pickerMode.kind === 'split-right') {
        panelActions.splitPane(pickerMode.paneId, 'horizontal', {
          paneType: type,
          workspaceId: pickerMode.workspaceId,
        } as Partial<LeafNode>)
      } else if (pickerMode.kind === 'split-down') {
        panelActions.splitPane(pickerMode.paneId, 'vertical', {
          paneType: type,
          workspaceId: pickerMode.workspaceId,
        } as Partial<LeafNode>)
      } else if (pickerMode.kind === 'new-tab') {
        panelActions.addPanelTab?.(pickerMode.workspaceId, type)
      }
      setPickerMode(null)
    },
    [pickerMode, panelActions]
  )

  const handlePickerCancel = useCallback(() => {
    setPickerMode(null)
  }, [])

  /**
   * The pane ID to show the picker on. For split actions, it's the pane
   * being split. For new-tab, it's the workspace's active pane (if any).
   */
  const pickerPaneId = useMemo(() => {
    if (!pickerMode) {
      return null
    }
    if (pickerMode.kind === 'new-tab') {
      // For new-tab, show picker on the workspace's currently active pane
      return activePaneId
    }
    return pickerMode.paneId
  }, [pickerMode, activePaneId])

  /** Context value for the panel type picker overlay. */
  const pendingPickerState: PendingPickerState = useMemo(
    () => ({
      paneId: pickerPaneId,
      onSelect: handlePickerSelect,
      onCancel: handlePickerCancel,
    }),
    [pickerPaneId, handlePickerSelect, handlePickerCancel]
  )

  // Override panelActions.closePane with the gated version and add fullscreen toggle.
  // forceCloseWorkspace bypasses the confirmation gate — used by workspace
  // destruction which has its own confirmation dialog.
  // toggleReviewPane and toggleDiffPane replace the layout-based versions with
  // full-height versions.
  const gatedPanelActions = useMemo(
    () => ({
      ...panelActions,
      closePane: gatedClosePane,
      closeTerminalPane: gatedCloseTerminalPane,
      closeWorkspace: gatedCloseWorkspace,
      closeWindowTab: gatedCloseWindowTab,
      removePanelTab: gatedRemovePanelTab,
      forceCloseWorkspace: panelActions.closeWorkspace,
      toggleFullscreenPane,
      toggleReviewPane,
      toggleDiffPane,
      showPanelTypePicker,
    }),
    [
      panelActions,
      gatedClosePane,
      gatedCloseTerminalPane,
      gatedCloseWorkspace,
      gatedCloseWindowTab,
      gatedRemovePanelTab,
      toggleFullscreenPane,
      toggleReviewPane,
      toggleDiffPane,
      showPanelTypePicker,
    ]
  )

  // Sync running workspace count to Electron system tray tooltip (no-op in browser)
  useTrayWorkspaceCount()

  // Desktop notifications for agent status transitions (no-op in browser)
  const { terminals: notificationTerminals } = useTerminalList()

  const notificationWorkspaces = useMemo(
    () => workspaceList.map((ws) => ({ id: ws.id, branchName: ws.branchName })),
    [workspaceList]
  )

  const handleNotificationClicked = useCallback(
    (workspaceId: string) => {
      if (!layout) {
        return
      }
      // Find the first leaf pane belonging to this workspace and activate it
      const leaf = getLeafNodes(layout).find(
        (l) => l.workspaceId === workspaceId
      )
      if (leaf) {
        panelActions.setActivePaneId(leaf.id)
      }
    },
    [layout, panelActions]
  )

  useAgentNotifications(
    notificationTerminals,
    notificationWorkspaces,
    handleNotificationClicked
  )

  // Subscribe to workspace-activation events from other windows.
  // When another window calls focusWindowForWorkspace, the main process
  // focuses this window and sends an activate-workspace event.
  useActivateWorkspace(handleNotificationClicked)

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
    <DiffScrollProvider>
      <PanelActionsProvider
        activePaneId={activePaneId}
        activeWorkspaceId={activeWorkspaceId}
        fullscreenPaneId={fullscreenPaneId}
        pendingClose={pendingCloseState}
        pendingPicker={pendingPickerState}
        value={gatedPanelActions}
      >
        <CloseWorkspaceDialog
          onConfirm={handleConfirmCloseWorkspace}
          onOpenChange={setCloseWorkspaceDialogOpen}
          open={closeWorkspaceDialogOpen}
        />
        <ClosePanelTabDialog
          onConfirm={handleConfirmClosePanelTab}
          onOpenChange={setClosePanelTabDialogOpen}
          open={closePanelTabDialogOpen}
        />
        <CloseWindowTabDialog
          onConfirm={handleConfirmCloseWindowTab}
          onOpenChange={setCloseWindowTabDialogOpen}
          open={closeWindowTabDialogOpen}
        />
        <CloseAppDialog
          onOpenChange={setIsCloseAppDialogOpen}
          open={isCloseAppDialogOpen}
        />
        <DestroyWorkspaceOnCloseDialog
          onCloseAndDestroy={handleDestroyOnCloseConfirm}
          onConfirm={handleDestroyOnCloseJustClose}
          onOpenChange={setDestroyOnCloseDialogOpen}
          open={destroyOnCloseDialogOpen}
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
            </div>
          </ResizablePanel>

          <ResizableHandle withHandle />

          {/* Main content — Panel system, dashboard, plan editor, or welcome empty state */}
          <ResizablePanel defaultSize="75%" minSize="10%">
            {!hasProjects && <WelcomeEmptyState />}
            {hasProjects && mainView === 'plan' && selectedPlanId && (
              <div className="flex h-full flex-col border-2 border-transparent">
                <PanelHeaderBar
                  mainView={mainView}
                  onToggleSidebar={
                    responsiveSizes.canCollapseSidebar
                      ? toggleSidebar
                      : undefined
                  }
                  onViewChange={setMainView}
                  sidebarCollapsed={sidebarCollapsed}
                />
                <div className="flex min-h-0 flex-1 flex-col md:flex-row">
                  <div className="min-h-0 min-w-0 flex-1">
                    <PlanEditor
                      onBack={handlePlanBack}
                      prdId={selectedPlanId}
                    />
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
                  mainView={mainView}
                  onCloseWindowTab={panelActions.closeWindowTab}
                  onNewWindowTab={panelActions.addWindowTab}
                  onReorderWindowTabs={panelActions.reorderWindowTabsDnd}
                  onSelectWindowTab={panelActions.switchWindowTab}
                  onToggleSidebar={
                    responsiveSizes.canCollapseSidebar
                      ? toggleSidebar
                      : undefined
                  }
                  onViewChange={setMainView}
                  sidebarCollapsed={sidebarCollapsed}
                  windowLayout={panelActions.windowLayout}
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
                      diffPaneOpen={diffPaneWorkspaceId !== null}
                      diffWorkspaceId={diffPaneWorkspaceId}
                      fullscreenPaneId={fullscreenPaneId}
                      isEmptyWindowTab={isEmptyWindowTab}
                      isReconciling={isReconciling}
                      layout={layout}
                      reviewPaneOpen={reviewPaneWorkspaceId !== null}
                      reviewWorkspaceId={reviewPaneWorkspaceId}
                      workspaceOrder={workspaceOrder}
                      workspaceTileLayout={workspaceTileLayout}
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
    </DiffScrollProvider>
  )
}
