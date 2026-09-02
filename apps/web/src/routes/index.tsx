import { useAtomSet } from '@effect/atom-react/Hooks'
import type { WorkspaceActivationIntent } from '@laborer/shared/desktop-bridge'
import type { LeafNode, PaneType } from '@laborer/shared/types'
import { ResizeGrip } from '@laborer/ui/components/resizable'
import { ScrollArea } from '@laborer/ui/components/scroll-area'
import { cn } from '@laborer/ui/lib/utils'
import { useLiveQuery } from '@tanstack/react-db'
import { useHotkeySequence } from '@tanstack/react-hotkeys'
import { createFileRoute } from '@tanstack/react-router'
import type { PointerEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { BrowserDaemonClient } from '@/atoms/browser-daemon-client'
import { LaborerClient } from '@/atoms/laborer-client'
import { AddProjectForm } from '@/components/add-project-form'
import { CommandPalette } from '@/components/command-palette/command-palette'
import { TaskBoard } from '@/components/kanban/task-board'
import { ProjectGroup } from '@/components/project-group'
import { useProjectReorderMonitor } from '@/components/project-reorder'
import { rightPanelWidthStorageKey } from '@/components/right-panel/right-panel-shell'
import { SidebarFooter } from '@/components/sidebar-footer'
import { SidebarSearch } from '@/components/sidebar-search'
import { destroyWorkspace as destroyWorkspaceOptimistically } from '@/db/shared-mutations'
import {
  orderedProjectsFromRows,
  projectCollection,
  taskCollection,
  workspaceViewsFromRows,
} from '@/db/shared-state'
import { useActivateWorkspace } from '@/hooks/use-activate-workspace'
import { useBoardOverlayHeight } from '@/hooks/use-board-overlay-height'
import { useProjectCollapseState } from '@/hooks/use-project-collapse-state'
import { useResponsiveLayout } from '@/hooks/use-responsive-layout'
import { useSidebarWidth } from '@/hooks/use-sidebar-width'
import { useTrayWorkspaceCount } from '@/hooks/use-tray-workspace-count'
import { extractErrorMessage } from '@/lib/errors'
import { localApi } from '@/lib/local-api'
import { DiffScrollProvider } from '@/panels/diff-scroll-context'
import {
  PanelActionsProvider,
  type PendingCloseState,
  type PendingCloseWorkspaceState,
  type PendingDestroyOnCloseWorkspaceState,
  type PendingPickerState,
  type PickerMode,
} from '@/panels/panel-context'
import { PanelGroupRegistryProvider } from '@/panels/panel-group-registry'
import { PanelHotkeys } from '@/panels/panel-hotkeys'
import {
  computeClosePaneGateAction,
  computeCloseWorkspaceAction,
  findLeafByTerminalIdInLayout,
  findPaneAcrossAllTabs,
  findPaneInActiveTab,
  getActiveTabLeafNodes,
  getActiveWindowTab,
  resolveActiveWorkspaceId,
} from '@/panels/window-layout-utils'
import { getWorkspaceTileLeaves } from '@/panels/workspace-tile-utils'
import { usePreviewMiniPlayerStore } from '@/preview-mini-player-store'
import { usePreviewStateStore } from '@/preview-state-store'
import { selectActiveRightPanel, useRightPanelStore } from '@/right-panel-store'
import {
  CloseAppDialog,
  DestroyWorkspaceOnCloseDialog,
} from './-components/close-dialogs'
import { PanelContent } from './-components/panel-content'
import { PanelHeaderBar } from './-components/panel-header-bar'
import { WelcomeEmptyState } from './-components/welcome-empty-state'
import { usePanelLayout } from './-hooks/use-panel-layout'
import { useTabCloseConfirmations } from './-hooks/use-tab-close-confirmations'

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

const destroyWorkspaceMutation = LaborerClient.mutation('workspace.destroy')
const closeWorkspacePreviewsMutation =
  BrowserDaemonClient.mutation('preview.close')

function HomeComponent() {
  const {
    panelActions,
    activePaneId,
    leafPaneIds,
    isReconciling,
    liveTerminals,
  } = usePanelLayout()

  // The hierarchical window layout used for all pane lookups
  const windowLayout = panelActions.windowLayout

  // Derive the active workspace ID from the hierarchical window layout.
  // Walks: active window tab > workspace tile leaves > active panel tab >
  // focusedPaneId to find the workspace containing the focused pane.
  const activeWorkspaceId = useMemo(() => {
    const windowLayout = panelActions.windowLayout
    if (!windowLayout) {
      return null
    }
    return resolveActiveWorkspaceId(windowLayout) ?? null
  }, [panelActions.windowLayout])

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

  // Detect when the active window tab exists but has no workspaces,
  // or when the window layout exists but all tabs have been closed.
  // Both cases trigger the empty window tab state (workspace picker).
  const isEmptyWindowTab =
    (activeWindowTab !== undefined && !workspaceTileLayout) ||
    (panelActions.windowLayout !== undefined &&
      panelActions.windowLayout.tabs.length === 0)

  const { data: projectRows } = useLiveQuery((query) =>
    query.from({ projects: projectCollection })
  )
  const { data: taskRows } = useLiveQuery((query) =>
    query.from({ tasks: taskCollection })
  )
  const projectList = useMemo(
    () => orderedProjectsFromRows(projectRows),
    [projectRows]
  )
  const workspaceList = useMemo(
    () => workspaceViewsFromRows(taskRows, projectRows),
    [projectRows, taskRows]
  )
  const hasProjects = projectList.length > 0

  const destroyWorkspace = useAtomSet(destroyWorkspaceMutation, {
    mode: 'promise',
  })
  const closeWorkspacePreviews = useAtomSet(closeWorkspacePreviewsMutation, {
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
      if (!windowLayout) {
        return null
      }
      const found = findPaneInActiveTab(windowLayout, paneId)
      if (!found?.workspaceId) {
        return null
      }
      return getWorkspacePrState(found.workspaceId)
    },
    [windowLayout, getWorkspacePrState]
  )

  // Fullscreen pane state — transient UI mode.
  // When set, only the fullscreened pane is shown, hiding all other
  // workspaces and sibling panes. The workspace bar header remains visible.
  const [fullscreenPaneId, setFullscreenPaneId] = useState<string | null>(null)

  // Auto-exit fullscreen when the fullscreened pane no longer exists in the layout
  // (e.g., if the pane was closed while fullscreened).
  useEffect(() => {
    if (fullscreenPaneId && windowLayout) {
      const found = findPaneAcrossAllTabs(windowLayout, fullscreenPaneId)
      if (!found) {
        setFullscreenPaneId(null)
      }
    }
  }, [fullscreenPaneId, windowLayout])

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

  /**
   * The workspace a pane belongs to, which is the unit the full-height
   * panels are keyed by. Panes are addressed within the active tab, so a
   * pane the operator cannot currently see names no workspace.
   */
  const resolvePaneWorkspaceId = useCallback(
    (paneId: string): string | undefined => {
      if (!windowLayout) {
        return undefined
      }

      return findPaneInActiveTab(windowLayout, paneId)?.workspaceId
    },
    [windowLayout]
  )

  /**
   * Toggle the right panel's Diff surface for the workspace of the given
   * pane: opens the panel with Diff active, or hides the panel when Diff is
   * already the active surface (t3's toggle semantics).
   *
   * @param paneId - The pane ID to get the workspace from
   * @returns Whether the Diff surface is now shown
   */
  const toggleDiffPane = useCallback(
    (paneId: string): boolean => {
      const workspaceId = resolvePaneWorkspaceId(paneId)
      if (workspaceId === undefined) {
        return false
      }
      useRightPanelStore.getState().toggle(workspaceId, 'diff')
      return (
        selectActiveRightPanel(
          useRightPanelStore.getState().byWorkspaceId,
          workspaceId
        ) === 'diff'
      )
    },
    [resolvePaneWorkspaceId]
  )

  /**
   * Toggle the right panel's Files surface for the workspace of the given
   * pane. The old left file-tree panel is retired; the explorer lives in
   * the right panel alongside diff and the pull request.
   *
   * @param paneId - The pane ID to get the workspace from
   * @returns Whether the Files surface is now shown
   */
  const toggleFilesPane = useCallback(
    (paneId: string): boolean => {
      const workspaceId = resolvePaneWorkspaceId(paneId)
      if (workspaceId === undefined) {
        return false
      }
      useRightPanelStore.getState().toggle(workspaceId, 'files')
      return (
        selectActiveRightPanel(
          useRightPanelStore.getState().byWorkspaceId,
          workspaceId
        ) === 'files'
      )
    },
    [resolvePaneWorkspaceId]
  )

  /**
   * Toggle the right panel's Browser surface for the workspace of the given
   * pane. Reuses the workspace's existing preview surface when one is open,
   * so the toggle returns to the page the operator was already looking at.
   *
   * @param paneId - The pane ID to get the workspace from
   * @returns Whether the Browser surface is now shown
   */
  const toggleBrowserPane = useCallback(
    (paneId: string): boolean => {
      const workspaceId = resolvePaneWorkspaceId(paneId)
      if (workspaceId === undefined) {
        return false
      }
      useRightPanelStore.getState().toggle(workspaceId, 'preview')
      return (
        selectActiveRightPanel(
          useRightPanelStore.getState().byWorkspaceId,
          workspaceId
        ) === 'preview'
      )
    },
    [resolvePaneWorkspaceId]
  )

  /**
   * Toggle the right panel's Pull request surface for the workspace of the
   * given pane. Like diff, it sits on the right; unlike diff, it reads
   * GitHub rather than the worktree.
   *
   * @param paneId - The pane ID to get the workspace from
   * @returns Whether the Pull request surface is now shown
   */
  const toggleCommentsPane = useCallback(
    (paneId: string): boolean => {
      const workspaceId = resolvePaneWorkspaceId(paneId)
      if (workspaceId === undefined) {
        return false
      }
      useRightPanelStore.getState().toggle(workspaceId, 'pull-request')
      return (
        selectActiveRightPanel(
          useRightPanelStore.getState().byWorkspaceId,
          workspaceId
        ) === 'pull-request'
      )
    },
    [resolvePaneWorkspaceId]
  )

  /**
   * Reveal a workspace and open — never toggle — its Pull request surface.
   *
   * Callers reach this from a count of unresolved conversations, which can
   * only mean "show me"; a toggle would close the panel out from under an
   * operator who clicked the count while already reading it. The panel
   * state waits in the store, so it applies as soon as the workspace's
   * frame lands in the layout.
   */
  const openCommentsPaneForWorkspace = useCallback(
    (workspaceId: string) => {
      panelActions.focusWorkspace(workspaceId)
      useRightPanelStore.getState().open(workspaceId, 'pull-request')
    },
    [panelActions]
  )

  // Prune right-panel state (and persisted widths) for workspaces that
  // have been destroyed, so removed workspaces do not leave entries behind.
  const destroyedWorkspaceKey = useMemo(
    () =>
      workspaceList
        .filter((ws) => ws.status === 'destroyed')
        .map((ws) => ws.id)
        .sort((left, right) => left.localeCompare(right))
        .join('\n'),
    [workspaceList]
  )
  useEffect(() => {
    if (destroyedWorkspaceKey === '') {
      return
    }
    const destroyedIds = destroyedWorkspaceKey.split('\n')
    for (const workspaceId of destroyedIds) {
      closeWorkspacePreviews({ payload: { workspaceId } }).catch(
        () => undefined
      )
      usePreviewStateStore.getState().removeWorkspace(workspaceId)
      usePreviewMiniPlayerStore.getState().removeWorkspace(workspaceId)
    }
    useRightPanelStore.getState().removeWorkspaces(destroyedIds)
    for (const workspaceId of destroyedIds) {
      window.localStorage.removeItem(rightPanelWidthStorageKey(workspaceId))
    }
  }, [closeWorkspacePreviews, destroyedWorkspaceKey])

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
  const pendingDestroyOnCloseWorkspaceId = destroyOnCloseDialogOpen
    ? destroyOnCloseWorkspaceIdRef.current
    : null
  const isDestroyOnCloseWorkspaceVisible = useMemo(() => {
    if (!(pendingDestroyOnCloseWorkspaceId && workspaceTileLayout)) {
      return false
    }

    return getWorkspaceTileLeaves(workspaceTileLayout).some(
      (leaf) => leaf.workspaceId === pendingDestroyOnCloseWorkspaceId
    )
  }, [pendingDestroyOnCloseWorkspaceId, workspaceTileLayout])

  /**
   * Destroy a workspace worktree and close all its panes.
   * Used by both the inline "Close & Destroy" button and the prompt dialog.
   */
  const handleDestroyWorkspaceAndClose = useCallback(
    (workspaceId: string) => {
      const ws = workspaceList.find((w) => w.id === workspaceId)
      const branchName = ws?.branchName ?? 'workspace'

      // Optimistic: the workspace leaves the sidebar and its panes close
      // now. TanStack settles when the authoritative row disappears and rolls
      // the deletion back if the server definitively rejects the destroy.
      panelActions.forceCloseWorkspace(workspaceId)

      const toastId = toast.loading(`Destroying workspace "${branchName}"...`)
      destroyWorkspaceOptimistically({
        force: true,
        operationId: crypto.randomUUID(),
        send: (payload) => destroyWorkspace({ payload }),
        workspaceId,
      })
        .then(() => {
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
   * Uses the push-based terminal list (updated via the 200ms detection
   * fiber's event stream) to make an instant, synchronous decision — no
   * RPC calls at close time. Process state is pre-cached and read
   * synchronously at close time.
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
        windowLayout,
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
    [getPanePrState, windowLayout, liveTerminals, panelActions]
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
    setDestroyOnCloseDialogOpen(false)
    destroyOnCloseWorkspaceIdRef.current = null
    destroyOnClosePaneIdRef.current = null
  }, [handleDestroyWorkspaceAndClose, panelActions])

  /** Handle the destroy-on-close dialog "Close" (close pane without destroying). */
  const handleDestroyOnCloseJustClose = useCallback(() => {
    const paneId = destroyOnClosePaneIdRef.current
    if (paneId) {
      panelActions.closePane(paneId)
    }
    setDestroyOnCloseDialogOpen(false)
    destroyOnCloseWorkspaceIdRef.current = null
    destroyOnClosePaneIdRef.current = null
  }, [panelActions])

  const handleCancelDestroyOnClose = useCallback(() => {
    setDestroyOnCloseDialogOpen(false)
    destroyOnCloseWorkspaceIdRef.current = null
    destroyOnClosePaneIdRef.current = null
  }, [])

  const handleDestroyOnCloseDialogOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        setDestroyOnCloseDialogOpen(true)
        return
      }

      handleCancelDestroyOnClose()
    },
    [handleCancelDestroyOnClose]
  )

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
   *
   * When the close is initiated from the sidebar, the terminal's pane
   * may not be the active pane. We activate it first so the inline
   * confirmation dialog (if shown) is visible to the user.
   */
  const gatedCloseTerminalPane = useCallback(
    (terminalId: string) => {
      if (windowLayout) {
        const found = findLeafByTerminalIdInLayout(windowLayout, terminalId)
        if (found) {
          // Ensure the pane is active so the inline confirmation dialog
          // is visible even when the close was initiated from the sidebar.
          panelActions.setActivePaneId(found.leaf.id)
          gatedClosePane(found.leaf.id)
          return
        }
      }
      // No pane found — delegate to the ungated handler
      panelActions.closeTerminalPane(terminalId)
    },
    [windowLayout, gatedClosePane, panelActions]
  )

  // Close-workspace confirmation state
  const [pendingCloseWorkspaceId, setPendingCloseWorkspaceId] = useState<
    string | null
  >(null)

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
        computeCloseWorkspaceAction(
          windowLayout,
          workspaceId,
          liveTerminals
        ) === 'confirm'
      ) {
        setPendingCloseWorkspaceId(workspaceId)
        return
      }
      panelActions.closeWorkspace(workspaceId)
    },
    [windowLayout, liveTerminals, panelActions]
  )

  const handleConfirmCloseWorkspace = useCallback(() => {
    if (!pendingCloseWorkspaceId) {
      return
    }

    panelActions.closeWorkspace(pendingCloseWorkspaceId)
    setPendingCloseWorkspaceId(null)
  }, [panelActions, pendingCloseWorkspaceId])

  const handleCancelCloseWorkspace = useCallback(() => {
    setPendingCloseWorkspaceId(null)
  }, [])

  const {
    closeWindowTab: gatedCloseWindowTab,
    pendingClosePanelTab: pendingClosePanelTabState,
    pendingCloseWindowTab: pendingCloseWindowTabState,
    removePanelTab: gatedRemovePanelTab,
  } = useTabCloseConfirmations(panelActions, liveTerminals)

  const pendingCloseWorkspaceState: PendingCloseWorkspaceState = useMemo(
    () => ({
      workspaceId: pendingCloseWorkspaceId,
      onConfirm: handleConfirmCloseWorkspace,
      onCancel: handleCancelCloseWorkspace,
    }),
    [
      pendingCloseWorkspaceId,
      handleConfirmCloseWorkspace,
      handleCancelCloseWorkspace,
    ]
  )

  const pendingDestroyOnCloseWorkspaceState: PendingDestroyOnCloseWorkspaceState =
    useMemo(
      () => ({
        workspaceId: isDestroyOnCloseWorkspaceVisible
          ? pendingDestroyOnCloseWorkspaceId
          : null,
        onConfirm: handleDestroyOnCloseJustClose,
        onCancel: handleCancelDestroyOnClose,
        onCloseAndDestroy: handleDestroyOnCloseConfirm,
      }),
      [
        isDestroyOnCloseWorkspaceVisible,
        pendingDestroyOnCloseWorkspaceId,
        handleDestroyOnCloseJustClose,
        handleCancelDestroyOnClose,
        handleDestroyOnCloseConfirm,
      ]
    )

  // Panel type picker state — when set, shows the picker overlay on the
  // specified pane. On type selection, the pending action (split/new tab)
  // is performed. Follows the same pattern as pendingClosePaneId.
  //
  // For split actions, the split is created immediately with a placeholder
  // type ('diff') so the picker appears on the NEW pane rather than the
  // current one. On selection, the pane type is updated. On cancel, the
  // new pane is removed.
  const [pickerMode, setPickerMode] = useState<PickerMode | null>(null)
  // Track the new pane ID created by a split, so we can show the picker
  // on it and close it on cancel.
  const [splitNewPaneId, setSplitNewPaneId] = useState<string | null>(null)

  /**
   * Show the panel type picker. For split modes, immediately creates the
   * split and shows the picker on the new pane. For new-tab mode, shows
   * the picker on the current active pane.
   */
  const showPanelTypePicker = useCallback(
    (mode: PickerMode) => {
      if (mode.kind === 'split-right' || mode.kind === 'split-down') {
        // Create the split immediately with 'diff' as a non-spawning placeholder.
        // PanelManager suppresses placeholder diff rendering while the picker is
        // open, so expensive diff fetching only starts if Diff is selected.
        const direction =
          mode.kind === 'split-right' ? 'horizontal' : 'vertical'
        const newPaneId = panelActions.splitPane(mode.paneId, direction, {
          paneType: 'diff',
          workspaceId: mode.workspaceId,
        } as Partial<LeafNode>)
        if (newPaneId) {
          setSplitNewPaneId(newPaneId)
          setPickerMode(mode)
        }
      } else {
        setSplitNewPaneId(null)
        setPickerMode(mode)
      }
    },
    [panelActions]
  )

  const handlePickerSelect = useCallback(
    (type: PaneType) => {
      if (!pickerMode) {
        return
      }
      if (
        (pickerMode.kind === 'split-right' ||
          pickerMode.kind === 'split-down') &&
        splitNewPaneId
      ) {
        // The split was already created — just update the pane type
        panelActions.updatePaneType(splitNewPaneId, type)
      } else if (pickerMode.kind === 'new-tab') {
        panelActions.addPanelTab?.(pickerMode.workspaceId, type)
      }
      setPickerMode(null)
      setSplitNewPaneId(null)
    },
    [pickerMode, splitNewPaneId, panelActions]
  )

  const handlePickerCancel = useCallback(() => {
    // If we created a split pane for the picker, remove it on cancel
    if (splitNewPaneId) {
      panelActions.closePane(splitNewPaneId)
    }
    setPickerMode(null)
    setSplitNewPaneId(null)
  }, [splitNewPaneId, panelActions])

  /**
   * The pane ID to show the picker on. For split actions, it's the newly
   * created pane. For new-tab, it's the workspace's active pane (if any).
   */
  const pickerPaneId = useMemo(() => {
    if (!pickerMode) {
      return null
    }
    if (pickerMode.kind === 'new-tab') {
      // For new-tab, show picker on the workspace's currently active pane
      return activePaneId
    }
    // For splits, show picker on the newly created pane
    return splitNewPaneId
  }, [pickerMode, activePaneId, splitNewPaneId])

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
  // toggleDiffPane replaces the layout-based version with a full-height version.
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
      toggleDiffPane,
      toggleFilesPane,
      toggleCommentsPane,
      toggleBrowserPane,
      openCommentsPaneForWorkspace,
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
      toggleDiffPane,
      toggleFilesPane,
      toggleCommentsPane,
      toggleBrowserPane,
      openCommentsPaneForWorkspace,
      showPanelTypePicker,
    ]
  )

  // Sync running workspace count to Electron system tray tooltip (no-op in browser)
  useTrayWorkspaceCount()

  const [pendingActivation, setPendingActivation] =
    useState<WorkspaceActivationIntent | null>(null)

  const handleWorkspaceActivation = useCallback(
    (intent: WorkspaceActivationIntent) => {
      if ('action' in intent && intent.action === 'open-agent-pane') {
        panelActions.openAgentPaneForWorkspace?.(intent.workspaceId, {
          initialPrompt: intent.initialPrompt,
        })
        return
      }
      setPendingActivation(intent)
      // This is also the open-if-absent path. The layout action moves an
      // existing workspace into the active tab or adds it when absent.
      panelActions.addWorkspaceToCurrentTab?.(intent.workspaceId)
    },
    [panelActions]
  )

  useEffect(() => {
    if (!(pendingActivation && windowLayout)) {
      return
    }
    const workspaceLeaves = getActiveTabLeafNodes(windowLayout).filter(
      (leaf) => leaf.workspaceId === pendingActivation.workspaceId
    )
    const target =
      workspaceLeaves.find(
        (leaf) =>
          leaf.terminalId ===
          ('terminalId' in pendingActivation
            ? pendingActivation.terminalId
            : undefined)
      ) ?? workspaceLeaves[0]
    if (target) {
      panelActions.setActivePaneId(target.id)
      setPendingActivation(null)
    }
  }, [panelActions, pendingActivation, windowLayout])

  // Subscribe to workspace-activation events from other windows.
  // When another window calls focusWindowForWorkspace, the main process
  // focuses this window and sends an activate-workspace event.
  useActivateWorkspace(handleWorkspaceActivation)

  // Responsive sizing — adapts sidebar and pane sizes to viewport width
  const responsiveSizes = useResponsiveLayout()

  // Sidebar width persistence — restore from the local preference collection, debounced writes
  const sidebarWidth = useSidebarWidth(
    responsiveSizes.sidebarMinPx,
    responsiveSizes.sidebarMaxPx,
    responsiveSizes.sidebarDefaultPx
  )

  // Project collapse state — persisted to the local preference collection
  const collapseState = useProjectCollapseState()

  // Commits sidebar project drags; the board owns its own monitor.
  useProjectReorderMonitor('sidebar')

  // Sidebar search — filters the project tree in real-time
  const [searchQuery, setSearchQuery] = useState('')

  // Filter projects and determine which to show based on search query.
  // A project is shown if its name matches OR any of its streamed
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

  const homeSnapshot = useMemo(
    () =>
      JSON.stringify({
        filteredProjectCount: filteredProjects.length,
        hasProjects,
        matchingProjectCount: matchingProjectIds.size,
        projectCount: projectList.length,
        projectIds: [...projectList]
          .map((project) => project.id)
          .sort((left, right) => left.localeCompare(right)),
        workspaceCount: workspaceList.length,
      }),
    [
      filteredProjects,
      hasProjects,
      matchingProjectIds,
      projectList,
      workspaceList,
    ]
  )

  useEffect(() => {
    console.info(`[HomeRoute] Snapshot ${homeSnapshot}`)
  }, [homeSnapshot])

  // When search is active, auto-expand matching projects (override collapse state).
  // When search is cleared, the stored collapse state is naturally restored.
  const isSearchActive = searchQuery.trim().length > 0

  // Kanban board overlay — covers the main panel area (not the sidebar).
  // Toggled instantly (no animation) via Cmd+Shift+K or the header bar
  // button; the panels underneath stay mounted so terminal sessions stay
  // alive.
  const [boardOverlayOpen, setBoardOverlayOpen] = useState(false)
  const boardOverlayHeight = useBoardOverlayHeight()
  const mainContentRef = useRef<HTMLDivElement | null>(null)
  const boardResizeRef = useRef<{
    containerHeight: number
    startFraction: number
    startY: number
  } | null>(null)
  const [isCloseAppDialogOpen, setIsCloseAppDialogOpen] = useState(false)

  const toggleBoardOverlay = useCallback(() => {
    setBoardOverlayOpen((open) => !open)
  }, [])

  const closeBoardOverlay = useCallback(() => {
    setBoardOverlayOpen(false)
  }, [])

  useHotkeySequence(['Shift+Meta+K'], (event) => {
    event.preventDefault()
    toggleBoardOverlay()
  })

  // Escape dismisses the board, the same way it dismisses a dialog. Anything
  // layered above the board — the task editor, the command palette, the board
  // search's own clear — answers Escape first and keeps the board open.
  useEffect(() => {
    if (!boardOverlayOpen) {
      return
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return
      }
      const focused = document.activeElement
      if (focused?.closest('[role="dialog"], [role="alertdialog"]')) {
        return
      }
      event.preventDefault()
      closeBoardOverlay()
    }

    window.addEventListener('keydown', handleEscape)
    return () => {
      window.removeEventListener('keydown', handleEscape)
    }
  }, [boardOverlayOpen, closeBoardOverlay])

  const handleBoardResizeStart = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      const containerHeight =
        mainContentRef.current?.getBoundingClientRect().height
      if (event.button !== 0 || !containerHeight) {
        return
      }

      event.preventDefault()
      boardResizeRef.current = {
        containerHeight,
        startFraction: boardOverlayHeight.fraction,
        startY: event.clientY,
      }
      event.currentTarget.setPointerCapture(event.pointerId)
      document.body.style.cursor = 'row-resize'
      document.body.style.userSelect = 'none'
    },
    [boardOverlayHeight.fraction]
  )

  const handleBoardResizeMove = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      const resizeState = boardResizeRef.current
      if (!resizeState) {
        return
      }

      event.preventDefault()
      boardOverlayHeight.setFraction(
        resizeState.startFraction +
          (resizeState.startY - event.clientY) / resizeState.containerHeight
      )
    },
    [boardOverlayHeight.setFraction]
  )

  const handleBoardResizeEnd = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      if (!boardResizeRef.current) {
        return
      }

      boardResizeRef.current = null
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      document.body.style.removeProperty('cursor')
      document.body.style.removeProperty('user-select')
    },
    []
  )

  // Sidebar width is pixel-based, matching t3code's CSS-variable approach so
  // viewport resizes do not proportionally scale the sidebar.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const sidebarResizeRef = useRef<{
    startWidth: number
    startX: number
  } | null>(null)

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((collapsed) => !collapsed)
  }, [])

  const handleSidebarResizeStart = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      if (sidebarCollapsed || event.button !== 0) {
        return
      }

      event.preventDefault()
      sidebarResizeRef.current = {
        startWidth: sidebarWidth.widthPx,
        startX: event.clientX,
      }
      event.currentTarget.setPointerCapture(event.pointerId)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },
    [sidebarCollapsed, sidebarWidth.widthPx]
  )

  const handleSidebarResizeMove = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      const resizeState = sidebarResizeRef.current
      if (!resizeState) {
        return
      }

      event.preventDefault()
      sidebarWidth.setWidthPx(
        resizeState.startWidth + event.clientX - resizeState.startX
      )
    },
    [sidebarWidth.setWidthPx]
  )

  const handleSidebarResizeEnd = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      if (!sidebarResizeRef.current) {
        return
      }

      sidebarResizeRef.current = null
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      document.body.style.removeProperty('cursor')
      document.body.style.removeProperty('user-select')
    },
    []
  )

  useEffect(() => {
    return () => {
      document.body.style.removeProperty('cursor')
      document.body.style.removeProperty('user-select')
    }
  }, [])

  const handleMetaWWithoutPane = useCallback(() => {
    setIsCloseAppDialogOpen(true)
  }, [])

  return (
    <DiffScrollProvider>
      <PanelActionsProvider
        activePaneId={activePaneId}
        activeWorkspaceId={activeWorkspaceId}
        fullscreenPaneId={fullscreenPaneId}
        pendingClose={pendingCloseState}
        pendingClosePanelTab={pendingClosePanelTabState}
        pendingCloseWindowTab={pendingCloseWindowTabState}
        pendingCloseWorkspace={pendingCloseWorkspaceState}
        pendingDestroyOnCloseWorkspace={pendingDestroyOnCloseWorkspaceState}
        pendingPicker={pendingPickerState}
        value={gatedPanelActions}
      >
        <CommandPalette
          onToggleBoard={toggleBoardOverlay}
          onToggleSidebar={
            responsiveSizes.canCollapseSidebar ? toggleSidebar : undefined
          }
          projects={projectList}
          workspaces={workspaceList}
        />
        <CloseAppDialog
          onOpenChange={setIsCloseAppDialogOpen}
          open={isCloseAppDialogOpen}
        />
        <DestroyWorkspaceOnCloseDialog
          onCloseAndDestroy={handleDestroyOnCloseConfirm}
          onConfirm={handleDestroyOnCloseJustClose}
          onOpenChange={handleDestroyOnCloseDialogOpenChange}
          open={destroyOnCloseDialogOpen && !isDestroyOnCloseWorkspaceVisible}
        />
        <div className="flex h-screen min-w-0" data-testid="mission-control">
          {/* Sidebar — search, project groups, workspace list, health check */}
          <aside
            className="min-h-0 shrink-0 overflow-hidden border-r"
            style={{ width: sidebarCollapsed ? 0 : sidebarWidth.widthPx }}
          >
            <div className="flex h-full min-h-0 flex-col">
              {/* Search bar + Add Project — shared top row */}
              {hasProjects && (
                <div
                  className={cn(
                    'drag-region flex h-10 shrink-0 items-center gap-2 px-2',
                    // Reserve room for the macOS traffic lights only in the
                    // Electron shell; the browser has no window chrome.
                    localApi.isDesktop && 'pl-[88px]'
                  )}
                >
                  <SidebarSearch
                    className="min-w-0 flex-1"
                    onChange={setSearchQuery}
                    value={searchQuery}
                  />
                  <AddProjectForm />
                </div>
              )}
              <ScrollArea className="min-h-0 flex-1">
                <div className="grid gap-3 px-2 py-2">
                  {/* Project-grouped tree — each project is a collapsible heading */}
                  {filteredProjects.map((project, projectIndex) => (
                    <ProjectGroup
                      expanded={
                        isSearchActive && matchingProjectIds.has(project.id)
                          ? true
                          : collapseState.isExpanded(project.id)
                      }
                      index={projectIndex}
                      key={project.id}
                      onToggle={() => collapseState.toggle(project.id)}
                      project={project}
                      reorderEnabled={!isSearchActive}
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
              <SidebarFooter />
            </div>
          </aside>

          {!sidebarCollapsed && (
            <button
              aria-label="Resize sidebar"
              className="group relative z-10 flex w-px shrink-0 cursor-col-resize items-center justify-center bg-border ring-offset-background after:absolute after:inset-y-0 after:left-1/2 after:w-2 after:-translate-x-1/2 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
              onPointerCancel={handleSidebarResizeEnd}
              onPointerDown={handleSidebarResizeStart}
              onPointerMove={handleSidebarResizeMove}
              onPointerUp={handleSidebarResizeEnd}
              tabIndex={-1}
              type="button"
            >
              <ResizeGrip />
            </button>
          )}

          {/* Main content — panel system, kanban board, or welcome empty state */}
          <main className="min-w-0 flex-1">
            {!hasProjects && <WelcomeEmptyState />}
            {hasProjects && (
              <div className="flex h-full flex-col">
                <PanelHeaderBar
                  boardOpen={boardOverlayOpen}
                  onCleanUpLayout={panelActions.cleanUpWorkspaceLayout}
                  onCloseWindowTab={gatedPanelActions.closeWindowTab}
                  onNewWindowTab={panelActions.addWindowTab}
                  onRenameWindowTab={panelActions.renameWindowTab}
                  onReorderWindowTabs={panelActions.reorderWindowTabsDnd}
                  onSelectWindowTab={panelActions.switchWindowTab}
                  onToggleBoard={toggleBoardOverlay}
                  onToggleSidebar={
                    responsiveSizes.canCollapseSidebar
                      ? toggleSidebar
                      : undefined
                  }
                  sidebarCollapsed={sidebarCollapsed}
                  windowLayout={panelActions.windowLayout}
                />
                {/* Pane hotkeys stay inert while the board overlay is open so
                    shortcuts cannot invisibly mutate the panes underneath. */}
                {!boardOverlayOpen && (
                  <PanelHotkeys
                    leafPaneIds={leafPaneIds}
                    onMetaWWithoutPane={handleMetaWWithoutPane}
                  />
                )}
                <div className="relative min-h-0 flex-1" ref={mainContentRef}>
                  <PanelContent
                    activePaneId={activePaneId}
                    activeTabId={windowLayout?.activeTabId}
                    fullscreenPaneId={fullscreenPaneId}
                    isEmptyWindowTab={isEmptyWindowTab}
                    isReconciling={isReconciling}
                    windowLayout={windowLayout}
                    windowTabs={windowLayout?.tabs}
                  />
                  {/* Kanban board overlay — semi-transparent so the panel
                      sessions remain visible underneath; cards stay solid
                      (bg-card). Appears/disappears instantly, no animation.
                      Stays mounted while dismissed (hidden via CSS) so board
                      state such as search text survives closing. */}
                  <section
                    aria-label="Task board"
                    className={cn(
                      'absolute inset-x-0 bottom-0 z-20 flex flex-col border-t bg-background/70 shadow-2xl',
                      !boardOverlayOpen && 'hidden'
                    )}
                    style={{
                      height: `${boardOverlayHeight.fraction * 100}%`,
                    }}
                  >
                    <button
                      aria-label="Resize board"
                      className="group relative z-10 flex h-px w-full shrink-0 cursor-row-resize items-center justify-center bg-border ring-offset-background after:absolute after:inset-x-0 after:top-1/2 after:h-2 after:-translate-y-1/2 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                      onPointerCancel={handleBoardResizeEnd}
                      onPointerDown={handleBoardResizeStart}
                      onPointerMove={handleBoardResizeMove}
                      onPointerUp={handleBoardResizeEnd}
                      tabIndex={-1}
                      type="button"
                    >
                      <ResizeGrip className="rotate-90" />
                    </button>
                    <div className="min-h-0 flex-1">
                      <TaskBoard
                        collapseState={collapseState}
                        onDismiss={closeBoardOverlay}
                        open={boardOverlayOpen}
                      />
                    </div>
                  </section>
                </div>
              </div>
            )}
          </main>
        </div>
      </PanelActionsProvider>
    </DiffScrollProvider>
  )
}
