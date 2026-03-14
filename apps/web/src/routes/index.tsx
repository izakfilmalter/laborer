import { projects, workspaces } from '@laborer/shared/schema'
import { queryDb } from '@livestore/livestore'
import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PanelImperativeHandle } from 'react-resizable-panels'
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
import { useLaborerStore } from '@/livestore/store'
import { DiffScrollProvider } from '@/panels/diff-scroll-context'
import {
  computeClosePaneAction,
  computeCloseWorkspaceAction,
  findLeafByTerminalId,
  findNodeById,
  getLeafNodes,
} from '@/panels/layout-utils'
import {
  PanelActionsProvider,
  type PendingCloseState,
} from '@/panels/panel-context'
import { PanelGroupRegistryProvider } from '@/panels/panel-group-registry'
import { PanelHotkeys } from '@/panels/panel-hotkeys'
import {
  CloseAppDialog,
  CloseWorkspaceDialog,
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
  const store = useLaborerStore()
  const projectList = store.useQuery(sidebarProjects$)
  const workspaceList = store.useQuery(sidebarWorkspaces$)
  const hasProjects = projectList.length > 0

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

  /**
   * Gated closePane that checks if the terminal has a running child process.
   * Only shows the confirmation dialog when an actual program (e.g., vim,
   * dev server, opencode) is running inside the shell — not when the shell
   * is idle at a prompt.
   *
   * Uses the cached terminal list (from the 5-second poll) to make an
   * instant, synchronous decision — no RPC calls at close time. This
   * follows the same pattern as VS Code's ChildProcessMonitor: process
   * state is pre-cached and read synchronously at close time.
   *
   * In the rare case where cached data is stale (e.g., user Ctrl+C's a
   * process and closes within the poll window), the user may see an
   * unnecessary confirmation dialog — which they can dismiss instantly.
   * This is the same tradeoff VS Code and cmux make.
   */
  const gatedClosePane = useCallback(
    (paneId: string) => {
      if (computeClosePaneAction(layout, paneId, liveTerminals) === 'confirm') {
        setPendingClosePaneId(paneId)
        return
      }
      // No active child process or no terminal — close immediately
      panelActions.closePane(paneId)
    },
    [layout, liveTerminals, panelActions]
  )

  const handleConfirmCloseTerminal = useCallback(() => {
    if (pendingClosePaneId) {
      panelActions.closePane(pendingClosePaneId)
      setPendingClosePaneId(null)
    }
  }, [panelActions, pendingClosePaneId])

  const handleCancelCloseTerminal = useCallback(() => {
    setPendingClosePaneId(null)
  }, [])

  /** Context value for the pane-scoped close confirmation dialog. */
  const pendingCloseState: PendingCloseState = useMemo(
    () => ({
      paneId: pendingClosePaneId,
      onConfirm: handleConfirmCloseTerminal,
      onCancel: handleCancelCloseTerminal,
    }),
    [pendingClosePaneId, handleConfirmCloseTerminal, handleCancelCloseTerminal]
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
      forceCloseWorkspace: panelActions.closeWorkspace,
      toggleFullscreenPane,
      toggleReviewPane,
      toggleDiffPane,
    }),
    [
      panelActions,
      gatedClosePane,
      gatedCloseTerminalPane,
      gatedCloseWorkspace,
      toggleFullscreenPane,
      toggleReviewPane,
      toggleDiffPane,
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
        fullscreenPaneId={fullscreenPaneId}
        pendingClose={pendingCloseState}
        value={gatedPanelActions}
      >
        <CloseWorkspaceDialog
          onConfirm={handleConfirmCloseWorkspace}
          onOpenChange={setCloseWorkspaceDialogOpen}
          open={closeWorkspaceDialogOpen}
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
                  onToggleSidebar={
                    responsiveSizes.canCollapseSidebar
                      ? toggleSidebar
                      : undefined
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
                      diffPaneOpen={diffPaneWorkspaceId !== null}
                      diffWorkspaceId={diffPaneWorkspaceId}
                      fullscreenPaneId={fullscreenPaneId}
                      isReconciling={isReconciling}
                      layout={layout}
                      reviewPaneOpen={reviewPaneWorkspaceId !== null}
                      reviewWorkspaceId={reviewPaneWorkspaceId}
                      workspaceOrder={workspaceOrder}
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
