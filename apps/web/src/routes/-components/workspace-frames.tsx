import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine'
import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter'
import { reorder } from '@atlaskit/pragmatic-drag-and-drop/reorder'
import type { PanelNode } from '@laborer/shared/types'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PanelImperativeHandle } from 'react-resizable-panels'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable'
import {
  filterTreeByWorkspace,
  findNodeById,
  getLeafNodes,
  getWorkspaceIds,
  isWorkspaceFrameData,
  sortWorkspaceLayouts,
  WORKSPACE_FRAME_TYPE,
} from '@/panels/layout-utils'
import { usePanelActions } from '@/panels/panel-context'
import { PanelManager } from '@/panels/panel-manager'
import { DiffPane } from '@/panes/diff-pane'
import { ReviewPane } from '@/panes/review-pane'
import { WorkspaceFrameHeaderContainer } from './workspace-frame-header-container'

/**
 * Renders a single workspace's terminal frame: a bordered container with
 * a workspace-specific header and the workspace's panel sub-tree.
 *
 * Supports minimized mode where only the header is visible.
 * Clicking the header focuses the first pane in this workspace frame.
 * When minimized, clicking the header expands the frame instead.
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
}: {
  readonly workspaceId: string | undefined
  readonly subLayout: PanelNode
  readonly activePaneId: string | null
  readonly index: number
  readonly isCollapsible?: boolean
  readonly panelRef?: { readonly current: PanelImperativeHandle | null }
  readonly diffWorkspaceId?: string | null
  readonly reviewWorkspaceId?: string | null
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

  // Calculate default sizes based on how many side panels are open
  const sidePanelCount = (showDiff ? 1 : 0) + (showReview ? 1 : 0)
  const sidePanelSize = sidePanelCount === 2 ? '20%' : '30%'
  const mainPanelSize = sidePanelCount === 2 ? '60%' : '70%'

  const mainContent = (
    <>
      <WorkspaceFrameHeaderContainer
        dragHandleRef={dragHandleRef}
        isMinimized={isMinimized}
        onHeaderClick={handleHeaderClick}
        onMinimize={handleMinimize}
        subLayout={subLayout}
        workspaceId={workspaceId}
      />
      {!isMinimized && (
        <div className="min-h-0 flex-1">
          <PanelManager layout={subLayout} />
        </div>
      )}
    </>
  )

  return (
    <div
      className={`relative flex ${isMinimized ? 'h-auto' : 'h-full'} flex-col border-2 ${isActiveFrame ? 'border-primary' : 'border-transparent'} ${isDragging ? 'opacity-40' : ''}`}
      ref={frameRef}
    >
      {closestEdge === 'top' && (
        <div className="absolute inset-x-0 top-0 z-10 h-0.5 bg-primary" />
      )}
      {hasSidePanels && !isMinimized ? (
        <ResizablePanelGroup className="h-full" orientation="horizontal">
          <ResizablePanel defaultSize={mainPanelSize} minSize="30%">
            <div className="flex h-full flex-col">{mainContent}</div>
          </ResizablePanel>
          {showDiff && (
            <>
              <ResizableHandle withHandle />
              <ResizablePanel
                className="h-full overflow-hidden"
                defaultSize={sidePanelSize}
                minSize="15%"
              >
                <DiffPane workspaceId={diffWorkspaceId} />
              </ResizablePanel>
            </>
          )}
          {showReview && (
            <>
              <ResizableHandle withHandle />
              <ResizablePanel
                className="h-full overflow-hidden"
                defaultSize={sidePanelSize}
                minSize="15%"
              >
                <ReviewPane workspaceId={reviewWorkspaceId} />
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      ) : (
        mainContent
      )}
      {closestEdge === 'bottom' && (
        <div className="absolute inset-x-0 bottom-0 z-10 h-0.5 bg-primary" />
      )}
    </div>
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

/**
 * Renders workspace frames stacked vertically. Each workspace's terminals
 * get their own frame with a header showing the project / branch name.
 *
 * When there's only one workspace, renders a single frame without
 * resizable splitting overhead. With multiple workspaces, uses
 * ResizablePanelGroup for vertical stacking.
 */
export function WorkspaceFrames({
  layout,
  activePaneId,
  fullscreenPaneId,
  workspaceOrder,
  diffWorkspaceId = null,
  reviewWorkspaceId = null,
}: {
  readonly layout: PanelNode
  readonly activePaneId: string | null
  readonly fullscreenPaneId: string | null
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

  // When a pane is fullscreened, find the workspace it belongs to and
  // render only that workspace with just the fullscreened pane's LeafNode.
  const fullscreenLayout = useMemo(() => {
    if (!fullscreenPaneId) {
      return null
    }
    const node = findNodeById(layout, fullscreenPaneId)
    if (!node || node._tag !== 'LeafNode') {
      return null
    }
    // Find which workspace this pane belongs to
    const wsEntry = workspaceLayouts.find((entry) => {
      const leaves = getLeafNodes(entry.subLayout)
      return leaves.some((l) => l.id === fullscreenPaneId)
    })
    return wsEntry
      ? { workspaceId: wsEntry.workspaceId, subLayout: node }
      : null
  }, [fullscreenPaneId, layout, workspaceLayouts])

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

  // Fullscreen mode — render only the fullscreened pane in its workspace frame
  if (fullscreenLayout) {
    return (
      <WorkspaceFrame
        activePaneId={activePaneId}
        diffWorkspaceId={diffWorkspaceId}
        index={0}
        reviewWorkspaceId={reviewWorkspaceId}
        subLayout={fullscreenLayout.subLayout}
        workspaceId={fullscreenLayout.workspaceId}
      />
    )
  }

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
