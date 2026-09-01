import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine'
import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter'
import type {
  PanelNode,
  PaneType,
  WorkspaceTileLeaf,
  WorkspaceTileNode,
  WorkspaceTileSplit,
} from '@laborer/shared/types'
import { Button } from '@laborer/ui/components/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@laborer/ui/components/empty'
import { Kbd } from '@laborer/ui/components/kbd'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@laborer/ui/components/resizable'
import { ScrollArea } from '@laborer/ui/components/scroll-area'
import { TabBar, type TabBarItem } from '@laborer/ui/components/tab-bar'
import { TabErrorBoundary } from '@laborer/ui/components/tab-error-boundary'
import { cn } from '@laborer/ui/lib/utils'
import { useLiveQuery } from '@tanstack/react-db'
import { GitBranch, Layers, LayoutGrid, PanelTop } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  GroupImperativeHandle,
  PanelImperativeHandle,
} from 'react-resizable-panels'
import { PanelTypePicker } from '@/components/panel-type-picker'
import { WorkspacePreviewMiniPlayer } from '@/components/preview/workspace-preview-mini-player'
import { WorkspaceRightPanel } from '@/components/right-panel/workspace-right-panel'
import {
  orderedProjectsFromRows,
  projectCollection,
  taskCollection,
  workspaceViewsFromRows,
} from '@/db/shared-state'
import { useWorkspaceAgentStatus } from '@/hooks/use-workspace-agent-status'
import { getAgentStatusSurface } from '@/lib/agent-status-presentation'
import {
  usePanelActions,
  usePendingClosePanelTab,
  usePendingCloseWorkspace,
  usePendingDestroyOnCloseWorkspace,
} from '@/panels/panel-context'
import { PanelManager } from '@/panels/panel-manager'
import { containsPane, getFirstLeafId } from '@/panels/panel-tree-utils'
import {
  computeWorkspaceDropEdge,
  getAllWorkspaceTileLeaves,
  getWorkspaceDropEdge,
  isWorkspaceFrameData,
  WORKSPACE_FRAME_TYPE,
} from '@/panels/window-layout-utils'
import { computeMinimizedTargetLayout } from '@/panels/workspace-minimize-layout'
import type { WorkspaceDropEdge } from '@/panels/workspace-tile-utils'
import { usePreviewMiniPlayerStore } from '@/preview-mini-player-store'
import {
  emptyWorkspacePreviewState,
  usePreviewStateStore,
} from '@/preview-state-store'
import { selectActiveRightPanel, useRightPanelStore } from '@/right-panel-store'
import {
  PanelTabCloseConfirmDialog,
  WorkspaceCloseConfirmDialog,
  WorkspaceDestroyOnCloseConfirmDialog,
} from './close-dialogs'
import { WorkspaceFrameHeaderContainer } from './workspace-frame-header-container'

// ---------------------------------------------------------------------------
// Empty state components
// ---------------------------------------------------------------------------

/** No-op callback for the PanelTypePicker's cancel handler in embedded contexts. */
const noop = () => undefined

/**
 * Empty state shown when all panel tabs in a workspace have been closed.
 *
 * Displays the panel type picker inline so the user can immediately
 * create a new panel tab without any extra interaction. Keyboard shortcut
 * hints guide the user.
 *
 * @see docs/tabbed-window-layout/issues.md — Issue #19
 */
export function EmptyWorkspaceState({
  workspaceId,
}: {
  readonly workspaceId: string | undefined
}) {
  const actions = usePanelActions()

  const handleSelect = useCallback(
    (type: PaneType) => {
      if (workspaceId) {
        actions?.addPanelTab?.(workspaceId, type)
      }
    },
    [actions, workspaceId]
  )

  return (
    <ScrollArea
      className="h-full w-full bg-background"
      data-testid="empty-workspace-state"
    >
      <Empty className="justify-start pt-12">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Layers />
          </EmptyMedia>
          <EmptyTitle>No panel tabs</EmptyTitle>
          <EmptyDescription>
            Select a panel type to create a new tab, or press <Kbd>Ctrl</Kbd>
            <Kbd>T</Kbd> to open the panel picker.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <PanelTypePicker onCancel={noop} onSelect={handleSelect} />
        </EmptyContent>
      </Empty>
    </ScrollArea>
  )
}

/**
 * Empty state shown when all panes in a panel tab have been closed.
 *
 * Displays a CTA to add a new panel via the type picker. This state
 * is an edge case (the progressive close chain normally removes the
 * panel tab when its last pane is closed), but can appear after
 * layout repair or reconciliation.
 *
 * @see docs/tabbed-window-layout/issues.md — Issue #19
 */
export function EmptyPanelTabState({
  workspaceId,
}: {
  readonly workspaceId: string | undefined
}) {
  const actions = usePanelActions()

  const handleSelect = useCallback(
    (type: PaneType) => {
      if (workspaceId) {
        actions?.addPanelTab?.(workspaceId, type)
      }
    },
    [actions, workspaceId]
  )

  return (
    <ScrollArea
      className="h-full w-full bg-background"
      data-testid="empty-panel-tab-state"
    >
      <Empty className="justify-start pt-12">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <PanelTop />
          </EmptyMedia>
          <EmptyTitle>Empty tab</EmptyTitle>
          <EmptyDescription>
            This tab has no panels. Select a type below, or press <Kbd>Cmd</Kbd>
            <Kbd>D</Kbd> to split.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <PanelTypePicker onCancel={noop} onSelect={handleSelect} />
        </EmptyContent>
      </Empty>
    </ScrollArea>
  )
}

// ---------------------------------------------------------------------------
// Empty window tab state — workspace picker
// ---------------------------------------------------------------------------

/** A workspace entry grouped by project for the picker. */
interface WorkspacePickerEntry {
  readonly branchName: string
  readonly id: string
  readonly status: string
}

/** A project group with its available workspaces. */
interface ProjectWorkspaceGroup {
  readonly projectId: string
  readonly projectName: string
  readonly workspaces: readonly WorkspacePickerEntry[]
}

/**
 * Empty state shown when a window tab has no workspaces.
 *
 * Displays a workspace picker that lists existing workspaces grouped
 * by project. Workspaces already open in any tab (across all window tabs)
 * are excluded from the list. A "New Workspace" button triggers the
 * sidebar workspace creation flow.
 *
 * @see docs/tabbed-window-layout/issues.md — Issue #18
 */
export function EmptyWindowTabState() {
  const actions = usePanelActions()
  const { data: projects } = useLiveQuery((query) =>
    query.from({ projects: projectCollection })
  )
  const { data: tasks } = useLiveQuery((query) =>
    query.from({ tasks: taskCollection })
  )
  const projectList = useMemo(
    () => orderedProjectsFromRows(projects),
    [projects]
  )
  const workspaceList = useMemo(
    () => workspaceViewsFromRows(tasks, projects),
    [projects, tasks]
  )

  // Collect workspace IDs that are already open in any window tab
  const openWorkspaceIds = useMemo(() => {
    const windowLayout = actions?.windowLayout
    if (!windowLayout) {
      return new Set<string>()
    }
    const leaves = getAllWorkspaceTileLeaves(windowLayout)
    return new Set(leaves.map((l) => l.workspaceId))
  }, [actions?.windowLayout])

  // Build grouped workspace list: only non-destroyed, not-yet-open workspaces
  const groups = useMemo(() => {
    const projectMap = new Map<string, { name: string }>()
    for (const p of projectList) {
      projectMap.set(p.id, { name: p.name })
    }

    const byProject = new Map<string, WorkspacePickerEntry[]>()
    for (const ws of workspaceList) {
      if (ws.status === 'destroyed') {
        continue
      }
      if (openWorkspaceIds.has(ws.id)) {
        continue
      }
      // Skip workspaces whose project has been removed
      if (!projectMap.has(ws.projectId)) {
        continue
      }
      const entries = byProject.get(ws.projectId) ?? []
      entries.push({
        id: ws.id,
        branchName: ws.branchName,
        status: ws.status,
      })
      byProject.set(ws.projectId, entries)
    }

    const result: ProjectWorkspaceGroup[] = []
    for (const [projectId, entries] of byProject) {
      const project = projectMap.get(projectId)
      result.push({
        projectId,
        projectName: project?.name ?? projectId,
        workspaces: entries,
      })
    }
    return result
  }, [workspaceList, projectList, openWorkspaceIds])

  const handleSelectWorkspace = useCallback(
    (workspaceId: string) => {
      actions?.addWorkspaceToCurrentTab?.(workspaceId)
    },
    [actions]
  )

  const hasAvailableWorkspaces = groups.some((g) => g.workspaces.length > 0)

  return (
    <ScrollArea
      className="h-full w-full bg-background"
      data-testid="empty-window-tab-state"
    >
      <Empty className="justify-start pt-12">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <LayoutGrid />
          </EmptyMedia>
          <EmptyTitle>Empty tab</EmptyTitle>
          <EmptyDescription>
            Select a workspace to add to this tab, or create a new one from the
            sidebar.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="items-stretch">
          {hasAvailableWorkspaces ? (
            <div className="grid w-full gap-3">
              {groups.map((group) => (
                <WorkspacePickerGroup
                  group={group}
                  key={group.projectId}
                  onSelect={handleSelectWorkspace}
                />
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-xs">
              All workspaces are already open. Create a new one from the
              sidebar.
            </p>
          )}
        </EmptyContent>
      </Empty>
    </ScrollArea>
  )
}

/**
 * A project group within the workspace picker.
 * Shows the project name as a heading and its available workspaces as
 * clickable items.
 */
function WorkspacePickerGroup({
  group,
  onSelect,
}: {
  readonly group: ProjectWorkspaceGroup
  readonly onSelect: (workspaceId: string) => void
}) {
  if (group.workspaces.length === 0) {
    return null
  }

  return (
    <div className="grid gap-0.5">
      <span className="px-2 py-1 font-medium text-muted-foreground text-xs">
        {group.projectName}
      </span>
      {group.workspaces.map((ws) => (
        <WorkspacePickerItem key={ws.id} onSelect={onSelect} workspace={ws} />
      ))}
    </div>
  )
}

/**
 * A single workspace item in the picker. Shows the branch name and a
 * status indicator. Clicking adds the workspace to the current window tab.
 */
function WorkspacePickerItem({
  workspace,
  onSelect,
}: {
  readonly workspace: WorkspacePickerEntry
  readonly onSelect: (workspaceId: string) => void
}) {
  const handleClick = useCallback(() => {
    onSelect(workspace.id)
  }, [onSelect, workspace.id])

  return (
    <Button
      className="h-auto justify-start gap-2 px-2 py-1.5 text-xs"
      data-testid="workspace-picker-item"
      data-workspace-id={workspace.id}
      onClick={handleClick}
      variant="ghost"
    >
      <GitBranch className="size-3 shrink-0 text-muted-foreground" />
      <span className="truncate">{workspace.branchName}</span>
    </Button>
  )
}

// ---------------------------------------------------------------------------
// WorkspaceContent — extracted to reduce WorkspaceFrame complexity
// ---------------------------------------------------------------------------

/**
 * Renders the main content area of a workspace frame. Dispatches between:
 * - Empty workspace state (no panel tabs)
 * - Standard panel manager rendering
 *
 * The workspace's right panel (diff, files, pull request, and future
 * surfaces) is a flex sibling on the right edge that owns its own width; it
 * renders nothing while closed. It is suppressed while this workspace's
 * pane is fullscreened, because the fullscreen overlay renders its own
 * instance.
 */
function WorkspaceContent({
  isEmptyWorkspace,
  workspaceId,
  panelTabId,
  effectiveLayout,
  suppressRightPanel,
  tabBar,
}: {
  readonly isEmptyWorkspace: boolean
  readonly workspaceId: string | undefined
  readonly panelTabId?: string | undefined
  readonly effectiveLayout: PanelNode | null
  readonly suppressRightPanel: boolean
  readonly tabBar?: React.ReactNode
}) {
  const pendingClosePanelTab = usePendingClosePanelTab()
  const isClosingPanelTab =
    panelTabId !== undefined &&
    pendingClosePanelTab.tabId === panelTabId &&
    pendingClosePanelTab.workspaceId === workspaceId

  const mainPanel = (
    <div className="relative flex h-full min-h-0 flex-col">
      {tabBar}
      <div className="min-h-0 flex-1">
        {isEmptyWorkspace ? (
          <EmptyWorkspaceState workspaceId={workspaceId} />
        ) : (
          <PanelManager layout={effectiveLayout ?? undefined} />
        )}
      </div>
      {isClosingPanelTab && (
        <PanelTabCloseConfirmDialog
          onCancel={pendingClosePanelTab.onCancel}
          onConfirm={pendingClosePanelTab.onConfirm}
        />
      )}
    </div>
  )

  return (
    <div className="flex h-full min-h-0 min-w-0">
      <div className="h-full min-w-0 flex-1">{mainPanel}</div>
      {workspaceId !== undefined && !suppressRightPanel && (
        <WorkspaceRightPanel workspaceId={workspaceId} />
      )}
    </div>
  )
}

function WorkspaceFrameCloseDialog({
  workspaceId,
}: {
  readonly workspaceId: string | undefined
}) {
  const pendingCloseWorkspace = usePendingCloseWorkspace()

  if (
    workspaceId === undefined ||
    pendingCloseWorkspace.workspaceId !== workspaceId
  ) {
    return null
  }

  return (
    <WorkspaceCloseConfirmDialog
      onCancel={pendingCloseWorkspace.onCancel}
      onConfirm={pendingCloseWorkspace.onConfirm}
    />
  )
}

function WorkspaceFrameDestroyOnCloseDialog({
  workspaceId,
}: {
  readonly workspaceId: string | undefined
}) {
  const pendingDestroyOnCloseWorkspace = usePendingDestroyOnCloseWorkspace()

  if (
    workspaceId === undefined ||
    pendingDestroyOnCloseWorkspace.workspaceId !== workspaceId
  ) {
    return null
  }

  return (
    <WorkspaceDestroyOnCloseConfirmDialog
      onCancel={pendingDestroyOnCloseWorkspace.onCancel}
      onCloseAndDestroy={pendingDestroyOnCloseWorkspace.onCloseAndDestroy}
      onConfirm={pendingDestroyOnCloseWorkspace.onConfirm}
    />
  )
}

// ---------------------------------------------------------------------------
// Agent attention outline
// ---------------------------------------------------------------------------

/**
 * Draws the agent attention outline around a whole workspace frame — its
 * header, tab bar, and every terminal in it.
 *
 * Rendered as an absolutely positioned overlay rather than a border on the
 * frame itself for two reasons: a border would inset the panes and reflow
 * every terminal in the workspace the moment an agent finished, and an
 * overlay draws over the panes' own edges instead of being hidden behind
 * them. It is inert to the pointer, so clicking anywhere still lands on the
 * terminal underneath.
 *
 * It shares the drop indicators' stacking level and is rendered before
 * them, so a drag in progress still paints its edge on top of the outline.
 */
function WorkspaceFrameAttentionOutline({
  workspaceId,
}: {
  readonly workspaceId: string | undefined
}) {
  const agentStatus = useWorkspaceAgentStatus(workspaceId)
  const { frameClassName } = getAgentStatusSurface(agentStatus)

  if (frameClassName === '') {
    return null
  }

  return (
    <div
      aria-hidden="true"
      className={cn(
        'pointer-events-none absolute inset-0 z-10 border-2',
        frameClassName
      )}
      data-agent-status={agentStatus ?? undefined}
      data-testid="workspace-frame-attention-outline"
    />
  )
}

// ---------------------------------------------------------------------------
// WorkspaceFrame
// ---------------------------------------------------------------------------

/**
 * Renders a single workspace's terminal frame: a bordered container with
 * a workspace-specific header and the workspace's panel sub-tree.
 *
 * Supports minimized mode where only the header is visible.
 * Clicking the header focuses the first pane in this workspace frame.
 * When minimized, clicking the header expands the frame instead.
 *
 * When `tileLeaf` is provided (hierarchical rendering), panel tabs are
 * rendered via the shared TabBar component, and only the active tab's
 * panel layout is shown. Otherwise, falls back to rendering the flat
 * `subLayout` directly.
 */
/**
 * The region a dropped workspace frame will occupy, painted as a
 * translucent overlay over half the target frame (VS Code's editor-group
 * split preview). Side edges preview a new column beside the target;
 * top/bottom edges preview stacking within the target's column.
 */
const WORKSPACE_DROP_INDICATOR_CLASS: Record<WorkspaceDropEdge, string> = {
  top: 'inset-x-0 top-0 h-1/2 border-b',
  bottom: 'inset-x-0 bottom-0 h-1/2 border-t',
  left: 'inset-y-0 left-0 w-1/2 border-r',
  right: 'inset-y-0 right-0 w-1/2 border-l',
}

function WorkspaceFrameDropIndicator({
  edge,
}: {
  readonly edge: WorkspaceDropEdge | null
}) {
  if (!edge) {
    return null
  }
  return (
    <div
      aria-hidden="true"
      className={cn(
        'pointer-events-none absolute z-10 border-primary bg-primary/20',
        WORKSPACE_DROP_INDICATOR_CLASS[edge]
      )}
      data-drop-edge={edge}
      data-testid="workspace-frame-drop-indicator"
    />
  )
}

function WorkspaceFrame({
  workspaceId,
  subLayout,
  activePaneId,
  index,
  isMinimized: isMinimizedProp,
  onToggleMinimize,
  suppressedRightPanelWorkspaceId,
  tileLeaf,
}: {
  readonly workspaceId: string | undefined
  readonly subLayout: PanelNode
  readonly activePaneId: string | null
  readonly index: number
  /**
   * Controlled minimized state. Provided when this frame is a child of a
   * workspace tile split — the split owns minimize state so it can manage
   * the resizable group layout. When undefined, the frame manages its own
   * (header-only) minimized state locally.
   */
  readonly isMinimized?: boolean | undefined
  /** Toggle callback paired with the controlled `isMinimized` prop. */
  readonly onToggleMinimize?: (() => void) | undefined
  /**
   * The workspace whose right panel is rendered by the fullscreen overlay
   * instead of inline, so the frame does not mount a duplicate instance.
   */
  readonly suppressedRightPanelWorkspaceId?: string | null | undefined
  readonly tileLeaf?: WorkspaceTileLeaf | undefined
}) {
  const frameRef = useRef<HTMLDivElement | null>(null)
  const dragHandleRef = useRef<HTMLDivElement | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [closestEdge, setClosestEdge] = useState<WorkspaceDropEdge | null>(null)
  const [localMinimized, setLocalMinimized] = useState(false)
  const isMinimized = isMinimizedProp ?? localMinimized
  const actions = usePanelActions()

  const handleMinimize = useCallback(() => {
    if (onToggleMinimize) {
      onToggleMinimize()
      return
    }
    setLocalMinimized((prev) => !prev)
  }, [onToggleMinimize])

  // Check if the active pane belongs to this workspace frame
  const activePaneInFrame = useMemo(
    () => activePaneId != null && containsPane(subLayout, activePaneId),
    [activePaneId, subLayout]
  )
  const isActiveFrame = activePaneInFrame

  // Handle header click: if minimized, expand; otherwise focus the first pane
  const handleHeaderClick = useCallback(() => {
    if (isMinimized) {
      handleMinimize()
      return
    }
    // Focus the first leaf pane in this workspace frame
    const firstLeaf = getFirstLeafId(subLayout)
    if (firstLeaf) {
      actions?.setActivePaneId(firstLeaf)
    }
  }, [isMinimized, handleMinimize, subLayout, actions])

  useEffect(() => {
    const frameEl = frameRef.current
    const handleEl = dragHandleRef.current
    if (!(frameEl && handleEl && workspaceId)) {
      return
    }

    /**
     * The indicator edge for the current pointer position, or null when
     * the drop would be a no-op (dropping a frame onto its own top/bottom
     * half — its own left/right edges still split it into a new column).
     */
    const resolveDropIndicatorEdge = (
      selfData: Record<string, unknown>,
      sourceData: Record<string, unknown>
    ): WorkspaceDropEdge | null => {
      if (!isWorkspaceFrameData(sourceData)) {
        return null
      }
      const edge = getWorkspaceDropEdge(selfData)
      if (!edge) {
        return null
      }
      const isSelf = sourceData.workspaceId === workspaceId
      if (isSelf && (edge === 'top' || edge === 'bottom')) {
        return null
      }
      return edge
    }

    return combine(
      draggable({
        element: frameEl,
        dragHandle: handleEl,
        getInitialData: () => ({
          type: WORKSPACE_FRAME_TYPE,
          workspaceId,
          index,
        }),
        onDragStart: () => setIsDragging(true),
        onDrop: () => setIsDragging(false),
      }),
      dropTargetForElements({
        element: frameEl,
        canDrop: ({ source }) => isWorkspaceFrameData(source.data),
        getData: ({ input, element }) => ({
          type: WORKSPACE_FRAME_TYPE,
          workspaceId,
          index,
          edge: computeWorkspaceDropEdge(
            input,
            element.getBoundingClientRect()
          ),
        }),
        onDragEnter: ({ self, source }) => {
          setClosestEdge(resolveDropIndicatorEdge(self.data, source.data))
        },
        onDrag: ({ self, source }) => {
          setClosestEdge(resolveDropIndicatorEdge(self.data, source.data))
        },
        onDragLeave: () => setClosestEdge(null),
        onDrop: () => setClosestEdge(null),
      })
    )
  }, [workspaceId, index])

  // The header's diff/files/comments buttons reflect the right panel's
  // active surface, matching t3's toggle semantics: pressed while the panel
  // is open with that surface active.
  const activeRightPanelKind = useRightPanelStore(
    useCallback(
      (store) => selectActiveRightPanel(store.byWorkspaceId, workspaceId),
      [workspaceId]
    )
  )
  const activeRightPanelSurfaceId = useRightPanelStore(
    useCallback(
      (store) =>
        (workspaceId &&
          store.byWorkspaceId[workspaceId]?.isOpen &&
          store.byWorkspaceId[workspaceId]?.activeSurfaceId) ||
        null,
      [workspaceId]
    )
  )
  const showBrowser = activeRightPanelKind === 'preview'
  const showDiff = activeRightPanelKind === 'diff'
  const showComments = activeRightPanelKind === 'pull-request'
  const showFiles =
    activeRightPanelKind === 'files' || activeRightPanelKind === 'file'
  const miniPlayer = usePreviewMiniPlayerStore(
    (state) => (workspaceId && state.byWorkspaceId[workspaceId]) || null
  )
  const previewState = usePreviewStateStore(
    (state) =>
      (workspaceId && state.byWorkspaceId[workspaceId]) ||
      emptyWorkspacePreviewState
  )

  useEffect(() => {
    if (!(workspaceId && miniPlayer)) {
      return
    }
    const sameTabInPanel =
      activeRightPanelSurfaceId === `browser:${miniPlayer.tabId}`
    if (!previewState.sessions[miniPlayer.tabId] || sameTabInPanel) {
      usePreviewMiniPlayerStore.getState().close(workspaceId)
    }
  }, [
    activeRightPanelSurfaceId,
    miniPlayer,
    previewState.sessions,
    workspaceId,
  ])

  // Panel tab bar items and active tab layout (hierarchical mode only)
  const panelTabItems: readonly TabBarItem[] = useMemo(() => {
    if (!tileLeaf) {
      return []
    }
    return tileLeaf.panelTabs.map((tab, index) => {
      let shortcutHint: React.ReactNode
      if (index < 8) {
        shortcutHint = (
          <>
            <Kbd>Ctrl</Kbd>
            <Kbd>{index + 1}</Kbd>
          </>
        )
      } else if (index === tileLeaf.panelTabs.length - 1) {
        shortcutHint = (
          <>
            <Kbd>Ctrl</Kbd>
            <Kbd>9</Kbd>
          </>
        )
      }

      return {
        id: tab.id,
        label: tab.label ?? getPanelTabLabel(tab.panelLayout),
        isActive: tab.id === tileLeaf.activePanelTabId,
        shortcutHint,
      }
    })
  }, [tileLeaf])

  // Whether this workspace has no panel tabs (empty workspace state)
  const isEmptyWorkspace =
    tileLeaf !== undefined && tileLeaf.panelTabs.length === 0

  // The layout to render: in hierarchical mode, the caller (WorkspaceTileLeafFrame)
  // has already converted the active panel tab's PanelNode to legacy PanelNode
  // and passed it as subLayout. We only need to check for the empty workspace case.
  const effectiveLayout: PanelNode | null = useMemo(() => {
    if (tileLeaf) {
      // When tileLeaf has no panel tabs, render the empty workspace state
      if (tileLeaf.panelTabs.length === 0) {
        return null
      }
      // subLayout already contains the converted active tab layout
      return subLayout
    }
    return subLayout
  }, [tileLeaf, subLayout])

  // Panel tab bar callbacks
  const handlePanelTabSelect = useCallback(
    (tabId: string) => {
      if (workspaceId) {
        actions?.switchPanelTab?.(workspaceId, tabId)
      }
    },
    [actions, workspaceId]
  )

  const handlePanelTabClose = useCallback(
    (tabId: string) => {
      if (workspaceId) {
        actions?.removePanelTab?.(workspaceId, tabId)
      }
    },
    [actions, workspaceId]
  )

  const handlePanelTabNew = useCallback(() => {
    if (workspaceId) {
      actions?.showPanelTypePicker?.({
        kind: 'new-tab',
        workspaceId,
      })
    }
  }, [actions, workspaceId])

  const handlePanelTabReorder = useCallback(
    (fromIndex: number, toIndex: number) => {
      if (workspaceId) {
        actions?.reorderPanelTabsDnd?.(workspaceId, fromIndex, toIndex)
      }
    },
    [actions, workspaceId]
  )

  const showPanelTabBar = tileLeaf !== undefined

  const tabBarElement = showPanelTabBar ? (
    <TabBar
      closeTooltip="Close tab"
      items={panelTabItems}
      label="Panel Tabs"
      newTabTooltip={
        <>
          New panel tab <Kbd>Ctrl</Kbd>
          <Kbd>T</Kbd>
        </>
      }
      onClose={handlePanelTabClose}
      onNew={handlePanelTabNew}
      onReorder={handlePanelTabReorder}
      onSelect={handlePanelTabSelect}
    />
  ) : null

  return (
    <div
      className={cn(
        'relative flex flex-col',
        isMinimized ? 'h-auto' : 'h-full',
        isDragging && 'opacity-40'
      )}
      data-testid="workspace-frame"
      data-workspace-id={workspaceId}
      ref={frameRef}
    >
      <WorkspaceFrameAttentionOutline workspaceId={workspaceId} />
      <WorkspaceFrameHeaderContainer
        browserIsOpen={showBrowser}
        commentsIsOpen={showComments}
        diffIsOpen={showDiff}
        dragHandleRef={dragHandleRef}
        filesIsOpen={showFiles}
        isActiveFrame={isActiveFrame}
        isMinimized={isMinimized}
        onHeaderClick={handleHeaderClick}
        onMinimize={handleMinimize}
        subLayout={subLayout}
        workspaceId={workspaceId}
      />
      {!isMinimized && (
        <>
          <WorkspaceContent
            effectiveLayout={effectiveLayout}
            isEmptyWorkspace={isEmptyWorkspace}
            panelTabId={tileLeaf?.activePanelTabId}
            suppressRightPanel={
              workspaceId !== undefined &&
              suppressedRightPanelWorkspaceId === workspaceId
            }
            tabBar={tabBarElement}
            workspaceId={workspaceId}
          />
          {workspaceId ? (
            <WorkspacePreviewMiniPlayer workspaceId={workspaceId} />
          ) : null}
        </>
      )}
      <WorkspaceFrameCloseDialog workspaceId={workspaceId} />
      <WorkspaceFrameDestroyOnCloseDialog workspaceId={workspaceId} />
      <WorkspaceFrameDropIndicator edge={closestEdge} />
    </div>
  )
}

/**
 * Derive a display label for a panel tab from its root pane type.
 * Used as a fallback when no explicit label is set on the tab.
 */
function getPanelTabLabel(layout: PanelNode): string {
  if (layout._tag === 'LeafNode') {
    switch (layout.paneType) {
      case 'agent':
        return 'Agent'
      case 'terminal':
        return 'Terminal'
      case 'diff':
        return 'Diff'
      case 'devServerTerminal':
        return 'Dev Server'
      default:
        return 'Panel'
    }
  }
  // For split nodes, use the first child's type
  const firstChild = layout.children[0]
  if (firstChild) {
    return getPanelTabLabel(firstChild)
  }
  return 'Panel'
}

// ---------------------------------------------------------------------------
// Hierarchical workspace tile rendering
// ---------------------------------------------------------------------------

/**
 * Renders a WorkspaceTileLeaf as a WorkspaceFrame with panel tab support.
 *
 * When the leaf has panel tabs, the active tab's panel layout is passed
 * directly to PanelManager without conversion. If no active panel tab
 * is found, falls back to an empty terminal leaf.
 */
function WorkspaceTileLeafFrame({
  leaf,
  activePaneId,
  index,
  suppressedRightPanelWorkspaceId,
  isMinimized,
  onToggleMinimize,
}: {
  readonly leaf: WorkspaceTileLeaf
  readonly activePaneId: string | null
  readonly index: number
  readonly suppressedRightPanelWorkspaceId?: string | null | undefined
  readonly isMinimized?: boolean | undefined
  readonly onToggleMinimize?: (() => void) | undefined
}) {
  // Pass the active panel tab's layout directly to PanelManager.
  // PanelNode types are used throughout — no conversion needed.
  const subLayout = useMemo(() => {
    const activeTab = leaf.panelTabs.find((t) => t.id === leaf.activePanelTabId)
    if (activeTab) {
      return activeTab.panelLayout
    }
    // No active tab found — return an empty terminal leaf as fallback.
    const fallbackLeaf: PanelNode = {
      _tag: 'LeafNode' as const,
      id: `pane-tile-${leaf.id}`,
      paneType: 'terminal' as const,
      terminalId: undefined,
      workspaceId: leaf.workspaceId,
    }
    return fallbackLeaf
  }, [leaf])

  return (
    <WorkspaceFrame
      activePaneId={activePaneId}
      index={index}
      isMinimized={isMinimized}
      onToggleMinimize={onToggleMinimize}
      subLayout={subLayout}
      suppressedRightPanelWorkspaceId={suppressedRightPanelWorkspaceId}
      tileLeaf={leaf}
      workspaceId={leaf.workspaceId}
    />
  )
}

/**
 * A resizable child for workspace tile rendering.
 * Wraps a workspace tile leaf or a nested tile renderer in a ResizablePanel.
 *
 * Leaf children are collapsible: their imperative panel handle is registered
 * with the parent split group (by tile id) so the group can collapse and
 * redistribute space when workspaces are minimized.
 */
function WorkspaceTileResizableChild({
  tileNode,
  activePaneId,
  defaultSize,
  index,
  suppressedRightPanelWorkspaceId,
  isMinimized = false,
  onToggleMinimize,
  registerPanelHandle,
}: {
  readonly tileNode: WorkspaceTileNode
  readonly activePaneId: string | null
  readonly defaultSize: number
  readonly index: number
  readonly suppressedRightPanelWorkspaceId?: string | null | undefined
  readonly isMinimized?: boolean
  readonly onToggleMinimize: (tileId: string) => void
  readonly registerPanelHandle: (
    tileId: string,
    handle: PanelImperativeHandle | null
  ) => void
}) {
  const isLeaf = tileNode._tag === 'WorkspaceTileLeaf'
  const tileId = tileNode.id

  const handlePanelRef = useCallback(
    (handle: PanelImperativeHandle | null) => {
      registerPanelHandle(tileId, handle)
    },
    [registerPanelHandle, tileId]
  )

  const handleToggleMinimize = useCallback(() => {
    onToggleMinimize(tileId)
  }, [onToggleMinimize, tileId])

  return (
    <>
      {index > 0 && <ResizableHandle />}
      <ResizablePanel
        collapsedSize="2.5rem"
        collapsible={isLeaf}
        defaultSize={`${defaultSize}%`}
        id={tileId}
        minSize="10%"
        panelRef={isLeaf ? handlePanelRef : undefined}
      >
        <WorkspaceTileRenderer
          activePaneId={activePaneId}
          index={index}
          isMinimized={isLeaf ? isMinimized : undefined}
          onToggleMinimize={isLeaf ? handleToggleMinimize : undefined}
          suppressedRightPanelWorkspaceId={suppressedRightPanelWorkspaceId}
          tileNode={tileNode}
        />
      </ResizablePanel>
    </>
  )
}

/**
 * Collapse a panel if it isn't collapsed already.
 *
 * Swallows the error react-resizable-panels throws when the panel's
 * constraints aren't registered with its group yet (a transient state
 * while the group is mounting) — the onLayoutChanged handler re-asserts
 * once registration completes.
 */
function collapsePanel(handle: PanelImperativeHandle | undefined): void {
  if (!handle) {
    return
  }
  try {
    if (!handle.isCollapsed()) {
      handle.collapse()
    }
  } catch {
    // Panel not registered with its group yet.
  }
}

/**
 * Whether a panel is currently collapsed. Returns undefined when the panel
 * handle is missing or not yet registered with its group.
 */
function isPanelCollapsed(
  handle: PanelImperativeHandle | undefined
): boolean | undefined {
  if (!handle) {
    return undefined
  }
  try {
    return handle.isCollapsed()
  } catch {
    return undefined
  }
}

/**
 * Renders a WorkspaceTileSplit as a resizable panel group and owns the
 * minimize state for its direct children.
 *
 * Owning minimize state at the split level (rather than inside each
 * workspace frame) lets the group:
 *
 * - Distribute the space freed by minimizing a workspace across ALL
 *   expanded siblings proportionally, instead of handing it to the
 *   adjacent panel (react-resizable-panels' default collapse behavior).
 * - Re-assert collapsed sizes after the library rebuilds the layout.
 *   react-resizable-panels caches layouts per panel-id-set, so adding or
 *   removing a workspace rebuilds the layout from default sizes — which
 *   would otherwise silently re-expand a minimized workspace's panel.
 *   The rebuild is detected via `onLayoutChanged`.
 */
function WorkspaceTileSplitGroup({
  tileNode,
  activePaneId,
  suppressedRightPanelWorkspaceId,
}: {
  readonly tileNode: WorkspaceTileSplit
  readonly activePaneId: string | null
  readonly suppressedRightPanelWorkspaceId?: string | null | undefined
}) {
  const groupRef = useRef<GroupImperativeHandle | null>(null)
  const panelHandlesRef = useRef(new Map<string, PanelImperativeHandle>())
  /** Pre-minimize percentage per tile id, restored on expand. */
  const lastExpandedSharesRef = useRef(new Map<string, number>())
  /** Tile ids toggled from minimized to expanded, awaiting size restore. */
  const pendingExpandIdsRef = useRef(new Set<string>())
  /** Guards against onLayoutChanged re-entrancy while applying a layout. */
  const applyingLayoutRef = useRef(false)
  const [minimizedIds, setMinimizedIds] = useState<ReadonlySet<string>>(
    () => new Set<string>()
  )
  const minimizedIdsRef = useRef(minimizedIds)
  minimizedIdsRef.current = minimizedIds

  const childIds = useMemo(
    () => tileNode.children.map((child) => child.id),
    [tileNode.children]
  )
  const childIdsRef = useRef(childIds)
  childIdsRef.current = childIds

  const registerPanelHandle = useCallback(
    (tileId: string, handle: PanelImperativeHandle | null) => {
      if (handle) {
        panelHandlesRef.current.set(tileId, handle)
        return
      }
      panelHandlesRef.current.delete(tileId)
    },
    []
  )

  /**
   * Collapse all minimized panels and distribute the remaining space among
   * expanded panels proportionally to their current sizes. Panels that were
   * just expanded are restored to their remembered pre-minimize share.
   */
  const applyMinimizedLayout = useCallback(() => {
    const group = groupRef.current
    if (!group || applyingLayoutRef.current) {
      return
    }
    const minimized = minimizedIdsRef.current
    const pendingExpand = pendingExpandIdsRef.current
    if (minimized.size === 0 && pendingExpand.size === 0) {
      return
    }

    applyingLayoutRef.current = true
    try {
      const preLayout = group.getLayout()

      // Collapse minimized panels via the imperative API first so the
      // library computes the exact collapsed percentage (it handles unit
      // conversion for collapsedSize values like "2.5rem").
      for (const id of minimized) {
        collapsePanel(panelHandlesRef.current.get(id))
      }

      const target = computeMinimizedTargetLayout({
        childIds: childIdsRef.current,
        minimizedIds: minimized,
        restoreIds: pendingExpand,
        preLayout,
        postLayout: group.getLayout(),
        lastExpandedShares: lastExpandedSharesRef.current,
      })
      pendingExpand.clear()
      group.setLayout(target)
    } finally {
      applyingLayoutRef.current = false
    }
  }, [])

  const handleToggleMinimize = useCallback((tileId: string) => {
    const wasMinimized = minimizedIdsRef.current.has(tileId)
    if (wasMinimized) {
      pendingExpandIdsRef.current.add(tileId)
    } else {
      pendingExpandIdsRef.current.delete(tileId)
      // Remember the current share so expanding restores it.
      const share = groupRef.current?.getLayout()[tileId]
      if (share !== undefined && share > 0) {
        lastExpandedSharesRef.current.set(tileId, share)
      }
    }
    setMinimizedIds((prev) => {
      const next = new Set(prev)
      if (next.has(tileId)) {
        next.delete(tileId)
      } else {
        next.add(tileId)
      }
      return next
    })
  }, [])

  // Apply layout changes whenever minimize state changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `minimizedIds` is the trigger, not a value the body reads — the layout is applied from refs whenever minimize state changes.
  useEffect(() => {
    applyMinimizedLayout()
  }, [applyMinimizedLayout, minimizedIds])

  // Re-assert collapsed sizes when the library rebuilds the layout out from
  // under us (e.g. a workspace was added, changing the panel set).
  const handleLayoutChanged = useCallback(() => {
    if (applyingLayoutRef.current) {
      return
    }
    const needsReassert = [...minimizedIdsRef.current].some(
      (id) => isPanelCollapsed(panelHandlesRef.current.get(id)) === false
    )
    if (needsReassert) {
      applyMinimizedLayout()
    }
  }, [applyMinimizedLayout])

  return (
    <ResizablePanelGroup
      groupRef={groupRef}
      onLayoutChanged={handleLayoutChanged}
      orientation={tileNode.direction}
    >
      {tileNode.children.map((child, childIndex) => {
        const size =
          tileNode.sizes[childIndex] ?? 100 / tileNode.children.length
        return (
          <WorkspaceTileResizableChild
            activePaneId={activePaneId}
            defaultSize={size}
            index={childIndex}
            isMinimized={minimizedIds.has(child.id)}
            key={child.id}
            onToggleMinimize={handleToggleMinimize}
            registerPanelHandle={registerPanelHandle}
            suppressedRightPanelWorkspaceId={suppressedRightPanelWorkspaceId}
            tileNode={child}
          />
        )
      })}
    </ResizablePanelGroup>
  )
}

/**
 * Recursively renders a `WorkspaceTileNode` tree.
 *
 * - `WorkspaceTileLeaf` → renders a `WorkspaceFrame` with the workspace's
 *   panel layout from the active panel tab.
 * - `WorkspaceTileSplit` → renders a `ResizablePanelGroup` with the correct
 *   orientation (horizontal or vertical), recursing into children.
 *
 * This enables bidirectional tiling: workspaces can be arranged both
 * horizontally and vertically, supporting nested split layouts.
 */
function WorkspaceTileRenderer({
  tileNode,
  activePaneId,
  index = 0,
  suppressedRightPanelWorkspaceId,
  isMinimized,
  onToggleMinimize,
}: {
  readonly tileNode: WorkspaceTileNode
  readonly activePaneId: string | null
  readonly index?: number
  readonly suppressedRightPanelWorkspaceId?: string | null | undefined
  readonly isMinimized?: boolean | undefined
  readonly onToggleMinimize?: (() => void) | undefined
}) {
  if (tileNode._tag === 'WorkspaceTileLeaf') {
    return (
      <TabErrorBoundary label={tileNode.workspaceId}>
        <WorkspaceTileLeafFrame
          activePaneId={activePaneId}
          index={index}
          isMinimized={isMinimized}
          leaf={tileNode}
          onToggleMinimize={onToggleMinimize}
          suppressedRightPanelWorkspaceId={suppressedRightPanelWorkspaceId}
        />
      </TabErrorBoundary>
    )
  }

  // WorkspaceTileSplit — render children in a resizable panel group
  if (tileNode.children.length === 0) {
    return <PanelManager layout={undefined} />
  }

  return (
    <WorkspaceTileSplitGroup
      activePaneId={activePaneId}
      suppressedRightPanelWorkspaceId={suppressedRightPanelWorkspaceId}
      tileNode={tileNode}
    />
  )
}

// ---------------------------------------------------------------------------
// Legacy flat layout rendering (original WorkspaceFrames)
// ---------------------------------------------------------------------------

/**
 * Renders workspace frames based on the layout model.
 *
 * When a `workspaceTileLayout` (from the hierarchical WindowLayout model)
 * is provided, renders using the recursive `WorkspaceTileRenderer` which
 * supports both horizontal and vertical workspace tiling.
 *
 * Falls back to the legacy vertical-only stacking when no tile layout
 * is available (backward compatibility).
 */
export function WorkspaceFrames({
  activePaneId,
  workspaceTileLayout,
  suppressedRightPanelWorkspaceId,
}: {
  readonly activePaneId: string | null
  readonly workspaceTileLayout: WorkspaceTileNode
  readonly suppressedRightPanelWorkspaceId?: string | null | undefined
}) {
  // Wire up a monitor for workspace frame drag-and-drop. Drops on a
  // frame's top/bottom half stack the dragged workspace within the
  // target's column; drops on the left/right edge strips place it in a
  // new column beside the target's column.
  const actions = usePanelActions()

  useEffect(() => {
    return monitorForElements({
      canMonitor: ({ source }) => isWorkspaceFrameData(source.data),
      onDrop: ({ source, location }) => {
        const destination = location.current.dropTargets[0]
        if (!destination) {
          return
        }
        const sourceData = source.data
        const destData = destination.data
        if (
          !(isWorkspaceFrameData(sourceData) && isWorkspaceFrameData(destData))
        ) {
          return
        }
        const edge = getWorkspaceDropEdge(destData)
        if (!edge) {
          return
        }
        if (
          sourceData.workspaceId === destData.workspaceId &&
          (edge === 'top' || edge === 'bottom')
        ) {
          return
        }
        actions?.moveWorkspaceInTab?.(
          sourceData.workspaceId,
          destData.workspaceId,
          edge
        )
      },
    })
  }, [actions])

  // Hierarchical tile layout — bidirectional workspace tiling
  return (
    <WorkspaceTileRenderer
      activePaneId={activePaneId}
      suppressedRightPanelWorkspaceId={suppressedRightPanelWorkspaceId}
      tileNode={workspaceTileLayout}
    />
  )
}
