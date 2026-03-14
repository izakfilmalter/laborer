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
  PanelTreeNode,
  PaneType,
  WorkspaceTileLeaf,
  WorkspaceTileNode,
} from '@laborer/shared/types'
import { queryDb } from '@livestore/livestore'
import { GitBranch, Layers, LayoutGrid, PanelTop } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PanelImperativeHandle } from 'react-resizable-panels'
import { Button } from '@/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { PanelTypePicker } from '@/components/ui/panel-type-picker'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable'
import { ScrollArea } from '@/components/ui/scroll-area'
import { TabBar, type TabBarItem } from '@/components/ui/tab-bar'
import { TabErrorBoundary } from '@/components/ui/tab-error-boundary'
import { useLaborerStore } from '@/livestore/store'
import {
  filterTreeByWorkspace,
  getLeafNodes,
  getWorkspaceIds,
  isWorkspaceFrameData,
  sortWorkspaceLayouts,
  WORKSPACE_FRAME_TYPE,
} from '@/panels/layout-utils'
import { usePanelActions } from '@/panels/panel-context'
import { PanelManager } from '@/panels/panel-manager'
import { getActivePanelTab } from '@/panels/panel-tab-utils'
import { getAllWorkspaceTileLeaves } from '@/panels/window-tab-utils'
import { DiffPane } from '@/panes/diff-pane'
import { ReviewPane } from '@/panes/review-pane'
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
            Select a panel type to create a new tab, or press{' '}
            <kbd className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
              Ctrl+T
            </kbd>{' '}
            to open the panel picker.
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
            This tab has no panels. Select a type below, or press{' '}
            <kbd className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
              Cmd+D
            </kbd>{' '}
            to split.
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

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        onSelect(workspace.id)
      }
    },
    [onSelect, workspace.id]
  )

  return (
    <Button
      className="h-auto justify-start gap-2 px-2 py-1.5 text-xs"
      onClick={handleClick}
      onKeyDown={handleKeyDown}
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
  diffWorkspaceId,
  reviewWorkspaceId,
  closeSidePanel,
}: {
  readonly isEmptyWorkspace: boolean
  readonly workspaceId: string | undefined
  readonly hasSidePanels: boolean
  readonly effectiveLayout: PanelNode | null
  readonly mainPanelSize: string
  readonly sidePanelSize: string
  readonly showDiff: boolean
  readonly showReview: boolean
  readonly diffWorkspaceId: string | null
  readonly reviewWorkspaceId: string | null
  readonly closeSidePanel: (
    togglePanel: ((paneId: string) => boolean) | undefined
  ) => void
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
        <ResizablePanel defaultSize={mainPanelSize} minSize="30%">
          <div className="flex h-full min-h-0 flex-col">
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
  tileLeaf,
}: {
  readonly workspaceId: string | undefined
  readonly subLayout: PanelNode
  readonly activePaneId: string | null
  readonly index: number
  readonly isCollapsible?: boolean
  readonly panelRef?: { readonly current: PanelImperativeHandle | null }
  readonly diffWorkspaceId?: string | null
  readonly reviewWorkspaceId?: string | null
  readonly tileLeaf?: WorkspaceTileLeaf | undefined
}) {
  const frameRef = useRef<HTMLDivElement | null>(null)
  const dragHandleRef = useRef<HTMLDivElement | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [closestEdge, setClosestEdge] = useState<'top' | 'bottom' | null>(null)
  const [isMinimized, setIsMinimized] = useState(false)
  const actions = usePanelActions()

  // Check if the active pane belongs to this workspace frame
  const leaves = useMemo(() => getLeafNodes(subLayout), [subLayout])
  const isActiveFrame = useMemo(
    () => activePaneId != null && leaves.some((l) => l.id === activePaneId),
    [activePaneId, leaves]
  )

  // Handle header click: if minimized, expand; otherwise focus the first pane
  const handleHeaderClick = useCallback(() => {
    if (isMinimized) {
      setIsMinimized(false)
      return
    }
    // Focus the first leaf pane in this workspace frame
    const firstLeaf = leaves[0]
    if (firstLeaf) {
      actions?.setActivePaneId(firstLeaf.id)
    }
  }, [isMinimized, leaves, actions])

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
    } catch (error) {
      // Panel not yet registered with its group — will retry on next render.
      console.warn(
        '[WorkspaceFrame] Panel constraints not yet available:',
        error
      )
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
          setClosestEdge(sourceIdx < targetIdx ? 'bottom' : 'top')
        },
        onDrag: ({ self, source }) => {
          if (!isWorkspaceFrameData(source.data)) {
            return
          }
          const sourceIdx = source.data.index
          const targetIdx = self.data.index as number
          setClosestEdge(sourceIdx < targetIdx ? 'bottom' : 'top')
        },
        onDragLeave: () => setClosestEdge(null),
        onDrop: () => setClosestEdge(null),
      })
    )
  }, [workspaceId, index])

  const showDiff = diffWorkspaceId !== null && diffWorkspaceId === workspaceId
  const showReview =
    reviewWorkspaceId !== null && reviewWorkspaceId === workspaceId
  const hasSidePanels = showDiff || showReview
  const workspacePaneId = useMemo(() => {
    if (
      activePaneId != null &&
      leaves.some((leaf) => leaf.id === activePaneId)
    ) {
      return activePaneId
    }

    return leaves[0]?.id ?? null
  }, [activePaneId, leaves])

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
  const sidePanelCount = (showDiff ? 1 : 0) + (showReview ? 1 : 0)
  const sidePanelSize = sidePanelCount === 2 ? '20%' : '30%'
  const mainPanelSize = sidePanelCount === 2 ? '60%' : '70%'

  // Panel tab bar items and active tab layout (hierarchical mode only)
  const panelTabItems: readonly TabBarItem[] = useMemo(() => {
    if (!tileLeaf) {
      return []
    }
    return tileLeaf.panelTabs.map((tab) => ({
      id: tab.id,
      label: tab.label ?? getPanelTabLabel(tab.panelLayout),
      isActive: tab.id === tileLeaf.activePanelTabId,
    }))
  }, [tileLeaf])

  // Whether this workspace has no panel tabs (empty workspace state)
  const isEmptyWorkspace =
    tileLeaf !== undefined && tileLeaf.panelTabs.length === 0

  // The layout to render: in hierarchical mode, use the active panel tab's layout
  // (cast to PanelNode since PanelManager accepts the legacy type and the structure
  // is compatible at the rendering level). Falls back to subLayout for legacy rendering.
  // Returns null when no active panel tab exists in hierarchical mode (empty workspace).
  const effectiveLayout: PanelNode | null = useMemo(() => {
    if (tileLeaf) {
      const activeTab = getActivePanelTab(tileLeaf)
      if (activeTab) {
        // PanelTreeNode is structurally compatible with PanelNode for rendering.
        // PanelLeafNode has the same shape as LeafNode (without sidebar flags).
        // PanelSplitNode has the same shape as SplitNode.
        return activeTab.panelLayout as unknown as PanelNode
      }
      // No active tab — empty workspace state will be rendered instead
      return null
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

  return (
    <div
      className={`relative flex ${isMinimized ? 'h-auto' : 'h-full'} flex-col border-2 ${isActiveFrame ? 'border-primary' : 'border-transparent'} ${isDragging ? 'opacity-40' : ''}`}
      data-testid="workspace-frame"
      ref={frameRef}
    >
      {closestEdge === 'top' && (
        <div className="absolute inset-x-0 top-0 z-10 h-0.5 bg-primary" />
      )}
      <WorkspaceFrameHeaderContainer
        diffIsOpen={showDiff}
        dragHandleRef={dragHandleRef}
        isMinimized={isMinimized}
        onHeaderClick={handleHeaderClick}
        onMinimize={handleMinimize}
        reviewIsOpen={showReview}
        subLayout={subLayout}
        workspaceId={workspaceId}
      />
      {showPanelTabBar && !isMinimized && (
        <TabBar
          autoHide
          items={panelTabItems}
          newTabTooltip="New panel tab (Ctrl+T)"
          onClose={handlePanelTabClose}
          onNew={handlePanelTabNew}
          onReorder={handlePanelTabReorder}
          onSelect={handlePanelTabSelect}
        />
      )}
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
          sidePanelSize={sidePanelSize}
          workspaceId={workspaceId}
        />
      )}
      {closestEdge === 'bottom' && (
        <div className="absolute inset-x-0 bottom-0 z-10 h-0.5 bg-primary" />
      )}
    </div>
  )
}

/**
 * Derive a display label for a panel tab from its root pane type.
 * Used as a fallback when no explicit label is set on the tab.
 */
function getPanelTabLabel(layout: PanelTreeNode): string {
  if (layout._tag === 'PanelLeafNode') {
    switch (layout.paneType) {
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
  diffWorkspaceId = null,
  reviewWorkspaceId = null,
}: {
  readonly workspaceId: string | undefined
  readonly subLayout: PanelNode
  readonly activePaneId: string | null
  readonly defaultSize: number
  readonly index: number
  readonly diffWorkspaceId?: string | null
  readonly reviewWorkspaceId?: string | null
}) {
  const panelRef = useRef<PanelImperativeHandle | null>(null)

  return (
    <>
      {index > 0 && <ResizableHandle />}
      <ResizablePanel
        collapsedSize="2.5rem"
        collapsible
        defaultSize={`${defaultSize}%`}
        minSize="10%"
        panelRef={panelRef}
      >
        <WorkspaceFrame
          activePaneId={activePaneId}
          diffWorkspaceId={diffWorkspaceId}
          index={index}
          isCollapsible
          panelRef={panelRef}
          reviewWorkspaceId={reviewWorkspaceId}
          subLayout={subLayout}
          workspaceId={workspaceId}
        />
      </ResizablePanel>
    </>
  )
}

// ---------------------------------------------------------------------------
// Hierarchical workspace tile rendering
// ---------------------------------------------------------------------------

/**
 * Renders a WorkspaceTileLeaf as a WorkspaceFrame with panel tab support.
 *
 * When the leaf has panel tabs, the active tab's panel layout is rendered
 * via the WorkspaceFrame's built-in TabBar and PanelManager integration.
 * Falls back to extracting a sub-layout from the legacy flat tree when
 * the leaf has no panel tabs (backward compatibility during migration).
 */
function WorkspaceTileLeafFrame({
  leaf,
  flatLayout,
  activePaneId,
  index,
  diffWorkspaceId = null,
  reviewWorkspaceId = null,
}: {
  readonly leaf: WorkspaceTileLeaf
  readonly flatLayout: PanelNode
  readonly activePaneId: string | null
  readonly index: number
  readonly diffWorkspaceId?: string | null
  readonly reviewWorkspaceId?: string | null
}) {
  // When the leaf has panel tabs, use the active tab's layout.
  // When it doesn't (pre-migration), fall back to extracting from the flat tree.
  const subLayout = useMemo(() => {
    if (leaf.panelTabs.length > 0) {
      // Use a placeholder — the actual rendering is driven by tileLeaf's panelTabs
      // via WorkspaceFrame. We still need a valid PanelNode for the header's
      // getScopedActivePaneId and getLeafNodes calls.
      const activeTab = leaf.panelTabs.find(
        (t) => t.id === leaf.activePanelTabId
      )
      if (activeTab) {
        return activeTab.panelLayout as unknown as PanelNode
      }
    }
    return (
      filterTreeByWorkspace(flatLayout, leaf.workspaceId) ?? {
        _tag: 'LeafNode' as const,
        id: `pane-tile-${leaf.id}`,
        paneType: 'terminal' as const,
        terminalId: undefined,
        workspaceId: leaf.workspaceId,
      }
    )
  }, [flatLayout, leaf])

  return (
    <WorkspaceFrame
      activePaneId={activePaneId}
      diffWorkspaceId={diffWorkspaceId}
      index={index}
      reviewWorkspaceId={reviewWorkspaceId}
      subLayout={subLayout}
      tileLeaf={leaf}
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
  flatLayout,
  activePaneId,
  defaultSize,
  index,
  diffWorkspaceId = null,
  reviewWorkspaceId = null,
}: {
  readonly tileNode: WorkspaceTileNode
  readonly flatLayout: PanelNode
  readonly activePaneId: string | null
  readonly defaultSize: number
  readonly index: number
  readonly diffWorkspaceId?: string | null
  readonly reviewWorkspaceId?: string | null
}) {
  const panelRef = useRef<PanelImperativeHandle | null>(null)

  return (
    <>
      {index > 0 && <ResizableHandle />}
      <ResizablePanel
        collapsedSize="2.5rem"
        collapsible={tileNode._tag === 'WorkspaceTileLeaf'}
        defaultSize={`${defaultSize}%`}
        minSize="10%"
        panelRef={panelRef}
      >
        <WorkspaceTileRenderer
          activePaneId={activePaneId}
          diffWorkspaceId={diffWorkspaceId}
          flatLayout={flatLayout}
          index={index}
          reviewWorkspaceId={reviewWorkspaceId}
          tileNode={tileNode}
        />
      </ResizablePanel>
    </>
  )
}

/**
 * Recursively renders a `WorkspaceTileNode` tree.
 *
 * - `WorkspaceTileLeaf` → renders a `WorkspaceFrame` with the workspace's
 *   sub-layout extracted from the legacy flat tree (bridge for now).
 * - `WorkspaceTileSplit` → renders a `ResizablePanelGroup` with the correct
 *   orientation (horizontal or vertical), recursing into children.
 *
 * This enables bidirectional tiling: workspaces can be arranged both
 * horizontally and vertically, supporting nested split layouts.
 */
function WorkspaceTileRenderer({
  tileNode,
  flatLayout,
  activePaneId,
  index = 0,
  diffWorkspaceId = null,
  reviewWorkspaceId = null,
}: {
  readonly tileNode: WorkspaceTileNode
  readonly flatLayout: PanelNode
  readonly activePaneId: string | null
  readonly index?: number
  readonly diffWorkspaceId?: string | null
  readonly reviewWorkspaceId?: string | null
}) {
  if (tileNode._tag === 'WorkspaceTileLeaf') {
    return (
      <TabErrorBoundary label={tileNode.workspaceId}>
        <WorkspaceTileLeafFrame
          activePaneId={activePaneId}
          diffWorkspaceId={diffWorkspaceId}
          flatLayout={flatLayout}
          index={index}
          leaf={tileNode}
          reviewWorkspaceId={reviewWorkspaceId}
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
            flatLayout={flatLayout}
            index={childIndex}
            key={child.id}
            reviewWorkspaceId={reviewWorkspaceId}
            tileNode={child}
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
  layout,
  activePaneId,
  workspaceOrder,
  workspaceTileLayout,
  diffWorkspaceId = null,
  reviewWorkspaceId = null,
}: {
  readonly layout: PanelNode
  readonly activePaneId: string | null
  readonly workspaceOrder: string[] | null
  readonly workspaceTileLayout?: WorkspaceTileNode | undefined
  readonly diffWorkspaceId?: string | null
  readonly reviewWorkspaceId?: string | null
}) {
  // -------------------------------------------------------------------
  // Hierarchical tile layout path — bidirectional workspace tiling
  // -------------------------------------------------------------------
  // When a workspace tile layout is provided (from the active WindowTab),
  // use the recursive WorkspaceTileRenderer for bidirectional tiling.
  // The flat PanelNode tree is still needed as a bridge to extract
  // per-workspace sub-layouts until panel tabs (issue #10) are wired up.
  if (workspaceTileLayout) {
    return (
      <WorkspaceTileRenderer
        activePaneId={activePaneId}
        diffWorkspaceId={diffWorkspaceId}
        flatLayout={layout}
        reviewWorkspaceId={reviewWorkspaceId}
        tileNode={workspaceTileLayout}
      />
    )
  }

  // -------------------------------------------------------------------
  // Legacy flat layout path — vertical-only workspace stacking
  // -------------------------------------------------------------------
  return (
    <LegacyWorkspaceFrames
      activePaneId={activePaneId}
      diffWorkspaceId={diffWorkspaceId}
      layout={layout}
      reviewWorkspaceId={reviewWorkspaceId}
      workspaceOrder={workspaceOrder}
    />
  )
}

/**
 * Legacy rendering: extracts workspaces from the flat PanelNode tree and
 * stacks them vertically. Preserved for backward compatibility when no
 * hierarchical workspace tile layout is available.
 */
function LegacyWorkspaceFrames({
  layout,
  activePaneId,
  workspaceOrder,
  diffWorkspaceId = null,
  reviewWorkspaceId = null,
}: {
  readonly layout: PanelNode
  readonly activePaneId: string | null
  readonly workspaceOrder: string[] | null
  readonly diffWorkspaceId?: string | null
  readonly reviewWorkspaceId?: string | null
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

    return sortWorkspaceLayouts(layouts, workspaceOrder)
  }, [layout, workspaceIds, workspaceOrder])

  // Wire up the monitor to handle workspace frame drops (reordering)
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
        if (sourceData.index === destData.index) {
          return
        }

        const reordered = reorder({
          list: workspaceLayouts.map((entry) => entry.workspaceId),
          startIndex: sourceData.index,
          finishIndex: destData.index,
        })
        actions?.reorderWorkspaces(reordered)
      },
    })
  }, [workspaceLayouts, actions])

  // Single workspace — no need for resizable splitting
  if (workspaceLayouts.length <= 1) {
    const entry = workspaceLayouts[0]
    if (!entry) {
      return <PanelManager layout={undefined} />
    }
    return (
      <WorkspaceFrame
        activePaneId={activePaneId}
        diffWorkspaceId={diffWorkspaceId}
        index={0}
        reviewWorkspaceId={reviewWorkspaceId}
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
          diffWorkspaceId={diffWorkspaceId}
          index={index}
          key={entry.workspaceId ?? 'no-workspace'}
          reviewWorkspaceId={reviewWorkspaceId}
          subLayout={entry.subLayout}
          workspaceId={entry.workspaceId}
        />
      ))}
    </ResizablePanelGroup>
  )
}
