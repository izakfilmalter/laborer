import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine'
import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter'
import { reorder } from '@atlaskit/pragmatic-drag-and-drop/reorder'
import { projects, workspaces } from '@laborer/shared/schema'
import type {
  PanelNode,
  PaneType,
  SplitDirection,
  WorkspaceTileLeaf,
  WorkspaceTileNode,
} from '@laborer/shared/types'
import { queryDb } from '@livestore/livestore'
import { GitBranch, Layers, LayoutGrid, PanelTop } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PanelImperativeHandle } from 'react-resizable-panels'
import { LifecyclePhase } from '@/components/lifecycle-phase-context'
import { Button } from '@/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { Kbd } from '@/components/ui/kbd'
import { PanelTypePicker } from '@/components/ui/panel-type-picker'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable'
import { ScrollArea } from '@/components/ui/scroll-area'
import { TabBar, type TabBarItem } from '@/components/ui/tab-bar'
import { TabErrorBoundary } from '@/components/ui/tab-error-boundary'
import { useWhenPhase } from '@/hooks/use-when-phase'
import { useLaborerStore } from '@/livestore/store'
import { usePanelActions } from '@/panels/panel-context'
import { PanelManager } from '@/panels/panel-manager'
import { containsPane, getFirstLeafId } from '@/panels/panel-tree-utils'
import {
  getAllWorkspaceTileLeaves,
  isWorkspaceFrameData,
  WORKSPACE_FRAME_TYPE,
} from '@/panels/window-layout-utils'
import { getWorkspaceTileLeaves } from '@/panels/workspace-tile-utils'
import { DiffPane } from '@/panes/diff-pane'
import { ReviewPane } from '@/panes/review-pane'
import { FileTreePreloader, TreePane } from '@/panes/tree-pane'
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
    <div
      className="flex h-full w-full items-center justify-center bg-background"
      data-testid="empty-workspace-state"
    >
      <Empty>
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
    </div>
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
    <div
      className="flex h-full w-full items-center justify-center bg-background"
      data-testid="empty-panel-tab-state"
    >
      <Empty>
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
    </div>
  )
}

// ---------------------------------------------------------------------------
// LiveStore queries for workspace picker
// ---------------------------------------------------------------------------

const allWorkspacesForPicker$ = queryDb(workspaces, {
  label: 'emptyWindowTabWorkspaces',
})
const allProjectsForPicker$ = queryDb(projects, {
  label: 'emptyWindowTabProjects',
})

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
  const store = useLaborerStore()
  const workspaceList = store.useQuery(allWorkspacesForPicker$)
  const projectList = store.useQuery(allProjectsForPicker$)

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
    <div
      className="flex h-full w-full items-center justify-center bg-background"
      data-testid="empty-window-tab-state"
    >
      <Empty>
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
        <EmptyContent>
          {hasAvailableWorkspaces ? (
            <ScrollArea className="max-h-48 w-full">
              <div className="grid gap-2">
                {groups.map((group) => (
                  <WorkspacePickerGroup
                    group={group}
                    key={group.projectId}
                    onSelect={handleSelectWorkspace}
                  />
                ))}
              </div>
            </ScrollArea>
          ) : (
            <p className="text-muted-foreground text-xs">
              All workspaces are already open. Create a new one from the
              sidebar.
            </p>
          )}
        </EmptyContent>
      </Empty>
    </div>
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
    <div className="grid gap-1">
      <span className="font-medium text-muted-foreground text-xs">
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
 * - Side panel layout (diff/review open alongside main content)
 * - Standard panel manager rendering
 */
function WorkspaceContent({
  isEmptyWorkspace,
  workspaceId,
  hasSidePanels,
  effectiveLayout,
  mainPanelSize,
  sidePanelSize,
  showDiff,
  showReview,
  showTree,
  diffWorkspaceId,
  reviewWorkspaceId,
  treeWorkspaceId,
  closeSidePanel,
  tabBar,
}: {
  readonly isEmptyWorkspace: boolean
  readonly workspaceId: string | undefined
  readonly hasSidePanels: boolean
  readonly effectiveLayout: PanelNode | null
  readonly mainPanelSize: string
  readonly sidePanelSize: string
  readonly showDiff: boolean
  readonly showReview: boolean
  readonly showTree: boolean
  readonly diffWorkspaceId: string | null
  readonly reviewWorkspaceId: string | null
  readonly treeWorkspaceId: string | null
  readonly closeSidePanel: (
    togglePanel: ((paneId: string) => boolean) | undefined
  ) => void
  readonly tabBar?: React.ReactNode
}) {
  const actions = usePanelActions()

  if (isEmptyWorkspace) {
    return (
      <div className="min-h-0 flex-1">
        <EmptyWorkspaceState workspaceId={workspaceId} />
      </div>
    )
  }

  if (hasSidePanels) {
    return (
      <ResizablePanelGroup className="h-full" orientation="horizontal">
        {showTree && treeWorkspaceId !== null && (
          <>
            <ResizablePanel
              className="h-full overflow-hidden"
              defaultSize={sidePanelSize}
              minSize="15%"
            >
              <TreePane
                onClose={() => closeSidePanel(actions?.toggleTreePane)}
                workspaceId={treeWorkspaceId}
              />
            </ResizablePanel>
            <ResizableHandle withHandle />
          </>
        )}
        <ResizablePanel defaultSize={mainPanelSize} minSize="30%">
          <div className="flex h-full min-h-0 flex-col">
            {tabBar}
            <div className="min-h-0 flex-1">
              <PanelManager layout={effectiveLayout ?? undefined} />
            </div>
          </div>
        </ResizablePanel>
        {showDiff && diffWorkspaceId !== null && (
          <>
            <ResizableHandle withHandle />
            <ResizablePanel
              className="h-full overflow-hidden"
              defaultSize={sidePanelSize}
              minSize="15%"
            >
              <DiffPane
                onClose={() => closeSidePanel(actions?.toggleDiffPane)}
                workspaceId={diffWorkspaceId}
              />
            </ResizablePanel>
          </>
        )}
        {showReview && reviewWorkspaceId !== null && (
          <>
            <ResizableHandle withHandle />
            <ResizablePanel
              className="h-full overflow-hidden"
              defaultSize={sidePanelSize}
              minSize="15%"
            >
              <ReviewPane
                onClose={() => closeSidePanel(actions?.toggleReviewPane)}
                workspaceId={reviewWorkspaceId}
              />
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
    )
  }

  return (
    <div className="min-h-0 flex-1">
      <PanelManager layout={effectiveLayout ?? undefined} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Side panel sizing helpers
// ---------------------------------------------------------------------------

const SIDE_PANEL_SIZES: Record<number, string> = { 1: '30%', 2: '20%' }
const MAIN_PANEL_SIZES: Record<number, string> = { 1: '70%', 2: '60%' }
const DEFAULT_SIDE_PANEL_SIZE = '15%'
const DEFAULT_MAIN_PANEL_SIZE = '55%'

export function computeSidePanelSizes(sidePanelCount: number) {
  return {
    sidePanelSize: SIDE_PANEL_SIZES[sidePanelCount] ?? DEFAULT_SIDE_PANEL_SIZE,
    mainPanelSize: MAIN_PANEL_SIZES[sidePanelCount] ?? DEFAULT_MAIN_PANEL_SIZE,
  }
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
function WorkspaceFrame({
  workspaceId,
  subLayout,
  activePaneId,
  index,
  isCollapsible = false,
  panelRef,
  diffWorkspaceId = null,
  reviewWorkspaceId = null,
  treeWorkspaceId = null,
  tileLeaf,
  parentDirection,
}: {
  readonly workspaceId: string | undefined
  readonly subLayout: PanelNode
  readonly activePaneId: string | null
  readonly index: number
  readonly isCollapsible?: boolean | undefined
  readonly panelRef?:
    | { readonly current: PanelImperativeHandle | null }
    | undefined
  readonly diffWorkspaceId?: string | null
  readonly reviewWorkspaceId?: string | null
  readonly treeWorkspaceId?: string | null
  readonly tileLeaf?: WorkspaceTileLeaf | undefined
  readonly parentDirection?: SplitDirection | undefined
}) {
  const frameRef = useRef<HTMLDivElement | null>(null)
  const dragHandleRef = useRef<HTMLDivElement | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const isHorizontal = parentDirection === 'horizontal'
  type EdgeType = 'top' | 'bottom' | 'left' | 'right'
  const [closestEdge, setClosestEdge] = useState<EdgeType | null>(null)
  const [isMinimized, setIsMinimized] = useState(false)
  const actions = usePanelActions()

  // Check if the active pane belongs to this workspace frame
  const activePaneInFrame = useMemo(
    () => activePaneId != null && containsPane(subLayout, activePaneId),
    [activePaneId, subLayout]
  )
  const isActiveFrame = activePaneInFrame

  // Handle header click: if minimized, expand; otherwise focus the first pane
  const handleHeaderClick = useCallback(() => {
    if (isMinimized) {
      setIsMinimized(false)
      return
    }
    // Focus the first leaf pane in this workspace frame
    const firstLeaf = getFirstLeafId(subLayout)
    if (firstLeaf) {
      actions?.setActivePaneId(firstLeaf)
    }
  }, [isMinimized, subLayout, actions])

  const handleMinimize = useCallback(() => {
    setIsMinimized((prev) => !prev)
  }, [])

  useEffect(() => {
    if (!isCollapsible) {
      return
    }

    const panel = panelRef?.current
    if (!panel) {
      return
    }

    // Panel constraints may not be registered yet when the ResizablePanelGroup
    // first mounts (e.g. transitioning from 1 to 2+ workspaces). The library
    // throws synchronously from isCollapsed/collapse/expand in that case.
    // This is a transient state — React will re-run this effect once the panel
    // is fully registered.
    try {
      if (isMinimized) {
        if (!panel.isCollapsed()) {
          panel.collapse()
        }
        return
      }

      if (panel.isCollapsed()) {
        panel.expand()
      }
    } catch {
      // Panel not yet registered with its group — will retry on next render.
    }
  }, [isCollapsible, isMinimized, panelRef])

  useEffect(() => {
    const frameEl = frameRef.current
    const handleEl = dragHandleRef.current
    if (!(frameEl && handleEl && workspaceId)) {
      return
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
        getData: () => ({
          type: WORKSPACE_FRAME_TYPE,
          workspaceId,
          index,
        }),
        onDragEnter: ({ self, source }) => {
          if (!isWorkspaceFrameData(source.data)) {
            return
          }
          const sourceIdx = source.data.index
          const targetIdx = self.data.index as number
          if (isHorizontal) {
            setClosestEdge(sourceIdx < targetIdx ? 'right' : 'left')
          } else {
            setClosestEdge(sourceIdx < targetIdx ? 'bottom' : 'top')
          }
        },
        onDrag: ({ self, source }) => {
          if (!isWorkspaceFrameData(source.data)) {
            return
          }
          const sourceIdx = source.data.index
          const targetIdx = self.data.index as number
          if (isHorizontal) {
            setClosestEdge(sourceIdx < targetIdx ? 'right' : 'left')
          } else {
            setClosestEdge(sourceIdx < targetIdx ? 'bottom' : 'top')
          }
        },
        onDragLeave: () => setClosestEdge(null),
        onDrop: () => setClosestEdge(null),
      })
    )
  }, [workspaceId, index, isHorizontal])

  const showDiff = diffWorkspaceId !== null && diffWorkspaceId === workspaceId
  const showReview =
    reviewWorkspaceId !== null && reviewWorkspaceId === workspaceId
  const showTree = treeWorkspaceId !== null && treeWorkspaceId === workspaceId
  const hasSidePanels = showDiff || showReview || showTree
  const workspacePaneId = useMemo(() => {
    if (activePaneInFrame) {
      return activePaneId
    }

    return getFirstLeafId(subLayout) ?? null
  }, [activePaneInFrame, activePaneId, subLayout])

  const closeSidePanel = useCallback(
    (togglePanel: ((paneId: string) => boolean) | undefined) => {
      if (!(togglePanel && workspacePaneId)) {
        return
      }

      actions?.setActivePaneId(workspacePaneId)
      togglePanel(workspacePaneId)
    },
    [actions, workspacePaneId]
  )

  // Calculate default sizes based on how many side panels are open
  const sidePanelCount =
    (showTree ? 1 : 0) + (showDiff ? 1 : 0) + (showReview ? 1 : 0)
  const { sidePanelSize, mainPanelSize } = computeSidePanelSizes(sidePanelCount)

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

  // Preload file tree data in the background so it's ready when
  // the user opens the Files panel. The FileTreePreloader starts
  // the `fileTree.subscribe` streaming RPC without rendering anything.
  const isEventually = useWhenPhase(LifecyclePhase.Eventually)

  return (
    <div
      className={`relative flex ${isMinimized ? 'h-auto' : 'h-full'} flex-col ${isDragging ? 'opacity-40' : ''}`}
      data-testid="workspace-frame"
      ref={frameRef}
    >
      {isEventually && workspaceId && (
        <FileTreePreloader workspaceId={workspaceId} />
      )}
      {closestEdge === 'top' && (
        <div className="absolute inset-x-0 top-0 z-10 h-0.5 bg-primary" />
      )}
      {closestEdge === 'left' && (
        <div className="absolute inset-y-0 left-0 z-10 w-0.5 bg-primary" />
      )}
      <WorkspaceFrameHeaderContainer
        diffIsOpen={showDiff}
        dragHandleRef={dragHandleRef}
        isActiveFrame={isActiveFrame}
        isMinimized={isMinimized}
        onHeaderClick={handleHeaderClick}
        onMinimize={handleMinimize}
        reviewIsOpen={showReview}
        subLayout={subLayout}
        treeIsOpen={showTree}
        workspaceId={workspaceId}
      />
      {!(isMinimized || hasSidePanels) && tabBarElement}
      {!isMinimized && (
        <WorkspaceContent
          closeSidePanel={closeSidePanel}
          diffWorkspaceId={diffWorkspaceId}
          effectiveLayout={effectiveLayout}
          hasSidePanels={hasSidePanels}
          isEmptyWorkspace={isEmptyWorkspace}
          mainPanelSize={mainPanelSize}
          reviewWorkspaceId={reviewWorkspaceId}
          showDiff={showDiff}
          showReview={showReview}
          showTree={showTree}
          sidePanelSize={sidePanelSize}
          tabBar={hasSidePanels ? tabBarElement : undefined}
          treeWorkspaceId={treeWorkspaceId}
          workspaceId={workspaceId}
        />
      )}
      {closestEdge === 'bottom' && (
        <div className="absolute inset-x-0 bottom-0 z-10 h-0.5 bg-primary" />
      )}
      {closestEdge === 'right' && (
        <div className="absolute inset-y-0 right-0 z-10 w-0.5 bg-primary" />
      )}
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
      case 'review':
        return 'Review'
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
  diffWorkspaceId = null,
  reviewWorkspaceId = null,
  treeWorkspaceId = null,
  parentDirection,
  isCollapsible = false,
  panelRef,
}: {
  readonly leaf: WorkspaceTileLeaf
  readonly activePaneId: string | null
  readonly index: number
  readonly diffWorkspaceId?: string | null
  readonly reviewWorkspaceId?: string | null
  readonly treeWorkspaceId?: string | null
  readonly parentDirection?: SplitDirection | undefined
  readonly isCollapsible?: boolean | undefined
  readonly panelRef?:
    | { readonly current: PanelImperativeHandle | null }
    | undefined
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
      diffWorkspaceId={diffWorkspaceId}
      index={index}
      isCollapsible={isCollapsible}
      panelRef={panelRef}
      parentDirection={parentDirection}
      reviewWorkspaceId={reviewWorkspaceId}
      subLayout={subLayout}
      tileLeaf={leaf}
      treeWorkspaceId={treeWorkspaceId}
      workspaceId={leaf.workspaceId}
    />
  )
}

/**
 * A resizable child for workspace tile rendering.
 * Wraps a workspace tile leaf or a nested tile renderer in a ResizablePanel.
 */
function WorkspaceTileResizableChild({
  tileNode,
  activePaneId,
  defaultSize,
  index,
  diffWorkspaceId = null,
  reviewWorkspaceId = null,
  treeWorkspaceId = null,
  parentDirection,
}: {
  readonly tileNode: WorkspaceTileNode
  readonly activePaneId: string | null
  readonly defaultSize: number
  readonly index: number
  readonly diffWorkspaceId?: string | null
  readonly reviewWorkspaceId?: string | null
  readonly treeWorkspaceId?: string | null
  readonly parentDirection?: SplitDirection | undefined
}) {
  const panelRef = useRef<PanelImperativeHandle | null>(null)
  const isLeaf = tileNode._tag === 'WorkspaceTileLeaf'

  return (
    <>
      {index > 0 && <ResizableHandle />}
      <ResizablePanel
        collapsedSize="2.5rem"
        collapsible={isLeaf}
        defaultSize={`${defaultSize}%`}
        minSize="10%"
        panelRef={panelRef}
      >
        <WorkspaceTileRenderer
          activePaneId={activePaneId}
          diffWorkspaceId={diffWorkspaceId}
          index={index}
          isCollapsible={isLeaf}
          panelRef={isLeaf ? panelRef : undefined}
          parentDirection={parentDirection}
          reviewWorkspaceId={reviewWorkspaceId}
          tileNode={tileNode}
          treeWorkspaceId={treeWorkspaceId}
        />
      </ResizablePanel>
    </>
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
  diffWorkspaceId = null,
  reviewWorkspaceId = null,
  treeWorkspaceId = null,
  parentDirection,
  isCollapsible = false,
  panelRef,
}: {
  readonly tileNode: WorkspaceTileNode
  readonly activePaneId: string | null
  readonly index?: number
  readonly diffWorkspaceId?: string | null
  readonly reviewWorkspaceId?: string | null
  readonly treeWorkspaceId?: string | null
  readonly parentDirection?: SplitDirection | undefined
  readonly isCollapsible?: boolean | undefined
  readonly panelRef?:
    | { readonly current: PanelImperativeHandle | null }
    | undefined
}) {
  if (tileNode._tag === 'WorkspaceTileLeaf') {
    return (
      <TabErrorBoundary label={tileNode.workspaceId}>
        <WorkspaceTileLeafFrame
          activePaneId={activePaneId}
          diffWorkspaceId={diffWorkspaceId}
          index={index}
          isCollapsible={isCollapsible}
          leaf={tileNode}
          panelRef={panelRef}
          parentDirection={parentDirection}
          reviewWorkspaceId={reviewWorkspaceId}
          treeWorkspaceId={treeWorkspaceId}
        />
      </TabErrorBoundary>
    )
  }

  // WorkspaceTileSplit — render children in a resizable panel group
  if (tileNode.children.length === 0) {
    return <PanelManager layout={undefined} />
  }

  return (
    <ResizablePanelGroup orientation={tileNode.direction}>
      {tileNode.children.map((child, childIndex) => {
        const size =
          tileNode.sizes[childIndex] ?? 100 / tileNode.children.length
        return (
          <WorkspaceTileResizableChild
            activePaneId={activePaneId}
            defaultSize={size}
            diffWorkspaceId={diffWorkspaceId}
            index={childIndex}
            key={child.id}
            parentDirection={tileNode.direction}
            reviewWorkspaceId={reviewWorkspaceId}
            tileNode={child}
            treeWorkspaceId={treeWorkspaceId}
          />
        )
      })}
    </ResizablePanelGroup>
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
  diffWorkspaceId = null,
  reviewWorkspaceId = null,
  treeWorkspaceId = null,
}: {
  readonly activePaneId: string | null
  readonly workspaceTileLayout: WorkspaceTileNode
  readonly diffWorkspaceId?: string | null
  readonly reviewWorkspaceId?: string | null
  readonly treeWorkspaceId?: string | null
}) {
  // Wire up a monitor for workspace frame drag-and-drop reordering.
  // This must run unconditionally (React hooks rule) so it covers both
  // the hierarchical tile layout path and the legacy flat layout path.
  const actions = usePanelActions()

  // Build the workspace ID list from whichever layout path is active.
  const tileWorkspaceIds = useMemo(() => {
    if (!workspaceTileLayout) {
      return null
    }
    return getWorkspaceTileLeaves(workspaceTileLayout).map(
      (leaf) => leaf.workspaceId
    )
  }, [workspaceTileLayout])

  useEffect(() => {
    // Only monitor when the tile layout path is active — the legacy
    // path has its own monitor inside LegacyWorkspaceFrames.
    if (!tileWorkspaceIds) {
      return
    }

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
        if (sourceData.index === destData.index) {
          return
        }

        const reordered = reorder({
          list: tileWorkspaceIds,
          startIndex: sourceData.index,
          finishIndex: destData.index,
        })
        actions?.reorderWorkspaces(reordered)
      },
    })
  }, [tileWorkspaceIds, actions])

  // Hierarchical tile layout — bidirectional workspace tiling
  return (
    <WorkspaceTileRenderer
      activePaneId={activePaneId}
      diffWorkspaceId={diffWorkspaceId}
      reviewWorkspaceId={reviewWorkspaceId}
      tileNode={workspaceTileLayout}
      treeWorkspaceId={treeWorkspaceId}
    />
  )
}
