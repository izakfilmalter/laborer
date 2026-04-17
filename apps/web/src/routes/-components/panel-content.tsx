import type { WindowLayout, WindowTab } from '@laborer/shared/types'
import { useCallback, useMemo, useState } from 'react'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable'
import {
  FullscreenPortalContext,
  usePanelActions,
  usePendingCloseWindowTab,
} from '@/panels/panel-context'
import { PanelManager } from '@/panels/panel-manager'
import { findPaneAcrossAllTabs } from '@/panels/window-layout-utils'
import { DiffPane } from '@/panes/diff-pane'
import { ReviewPane } from '@/panes/review-pane'
import { TreePane } from '@/panes/tree-pane'
import { WindowTabCloseConfirmDialog } from './close-dialogs'
import { WorkspaceFrameHeaderContainer } from './workspace-frame-header-container'
import {
  computeSidePanelSizes,
  EmptyWindowTabState,
  WorkspaceFrames,
} from './workspace-frames'

/** No-op callback for fullscreen workspace header handlers. */
const noop = () => undefined

interface FullscreenWorkspaceOverlayProps {
  readonly fullscreenPaneId: string
  readonly fullscreenWorkspaceId: string
  readonly portalRef: (element: HTMLDivElement | null) => void
  readonly showsDiff: boolean
  readonly showsReview: boolean
  readonly showsTree: boolean
}

function FullscreenWorkspaceOverlay({
  fullscreenPaneId,
  fullscreenWorkspaceId,
  portalRef,
  showsDiff,
  showsReview,
  showsTree,
}: FullscreenWorkspaceOverlayProps) {
  const actions = usePanelActions()
  const sidePanelCount =
    (showsTree ? 1 : 0) + (showsDiff ? 1 : 0) + (showsReview ? 1 : 0)
  const sidePanelSizes = useMemo(
    () => computeSidePanelSizes(sidePanelCount),
    [sidePanelCount]
  )

  const toggleFullscreenSidePanel = useCallback(
    (togglePanel: ((paneId: string) => boolean) | undefined) => {
      if (!togglePanel) {
        return
      }

      actions?.setActivePaneId(fullscreenPaneId)
      togglePanel(fullscreenPaneId)
    },
    [actions, fullscreenPaneId]
  )

  if (sidePanelCount === 0) {
    return (
      <div className="absolute inset-0 z-10">
        <div className="h-full w-full" ref={portalRef} />
      </div>
    )
  }

  return (
    <div className="absolute inset-0 z-10">
      <ResizablePanelGroup className="h-full" orientation="horizontal">
        {showsTree && (
          <>
            <ResizablePanel
              className="h-full overflow-hidden"
              defaultSize={sidePanelSizes.sidePanelSize}
              minSize="15%"
            >
              <TreePane
                onClose={() =>
                  toggleFullscreenSidePanel(actions?.toggleTreePane)
                }
                workspaceId={fullscreenWorkspaceId}
              />
            </ResizablePanel>
            <ResizableHandle withHandle />
          </>
        )}
        <ResizablePanel
          defaultSize={sidePanelSizes.mainPanelSize}
          minSize="30%"
        >
          <div className="h-full w-full" ref={portalRef} />
        </ResizablePanel>
        {showsDiff && (
          <>
            <ResizableHandle withHandle />
            <ResizablePanel
              className="h-full overflow-hidden"
              defaultSize={sidePanelSizes.sidePanelSize}
              minSize="15%"
            >
              <DiffPane
                onClose={() =>
                  toggleFullscreenSidePanel(actions?.toggleDiffPane)
                }
                workspaceId={fullscreenWorkspaceId}
              />
            </ResizablePanel>
          </>
        )}
        {showsReview && (
          <>
            <ResizableHandle withHandle />
            <ResizablePanel
              className="h-full overflow-hidden"
              defaultSize={sidePanelSizes.sidePanelSize}
              minSize="15%"
            >
              <ReviewPane
                onClose={() =>
                  toggleFullscreenSidePanel(actions?.toggleReviewPane)
                }
                workspaceId={fullscreenWorkspaceId}
              />
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
    </div>
  )
}

/**
 * Renders a single window tab's workspace frames inside a container that
 * is hidden via `display: none` when the tab is inactive. This keeps
 * xterm.js terminal instances, MessagePort data channels, and RPC
 * subscriptions alive across tab switches (VS Code pattern).
 *
 * We use `display: none` rather than `visibility: hidden` or zero-size
 * tricks because xterm.js would attempt to resize to 0 cols/rows for
 * hidden-but-laid-out elements, causing a storm of resize RPC calls.
 * `display: none` removes the element from layout entirely so the
 * FitAddon does not trigger resize calculations for inactive tabs.
 */
function WindowTabContent({
  tab,
  isActive,
  activePaneId,
  diffWorkspaceIds,
  reviewWorkspaceIds,
  treeWorkspaceIds,
}: {
  readonly tab: WindowTab
  readonly isActive: boolean
  readonly activePaneId: string | null
  readonly diffWorkspaceIds: readonly string[]
  readonly reviewWorkspaceIds: readonly string[]
  readonly treeWorkspaceIds: readonly string[]
}) {
  const layout = tab.workspaceLayout
  const pendingCloseWindowTab = usePendingCloseWindowTab()
  if (!layout) {
    return null
  }

  const isClosingTab = pendingCloseWindowTab.tabId === tab.id

  return (
    <div
      className={isActive ? 'relative h-full w-full' : 'relative'}
      data-window-tab-id={tab.id}
      style={isActive ? undefined : { display: 'none' }}
    >
      <WorkspaceFrames
        activePaneId={isActive ? activePaneId : null}
        diffWorkspaceIds={isActive ? diffWorkspaceIds : []}
        reviewWorkspaceIds={isActive ? reviewWorkspaceIds : []}
        treeWorkspaceIds={isActive ? treeWorkspaceIds : []}
        workspaceTileLayout={layout}
      />
      {isClosingTab && (
        <WindowTabCloseConfirmDialog
          onCancel={pendingCloseWindowTab.onCancel}
          onConfirm={pendingCloseWindowTab.onConfirm}
        />
      )}
    </div>
  )
}

interface PanelContentProps {
  readonly activePaneId: string | null
  readonly activeTabId?: string | undefined
  readonly diffWorkspaceIds?: readonly string[]
  readonly fullscreenPaneId: string | null
  /** True when the active window tab exists but has no workspace layout. */
  readonly isEmptyWindowTab?: boolean
  readonly isReconciling: boolean
  readonly reviewWorkspaceIds?: readonly string[]
  readonly treeWorkspaceIds?: readonly string[]
  /** The hierarchical window layout — used for fullscreen pane workspace resolution. */
  readonly windowLayout?: WindowLayout | undefined
  /** All window tabs — rendered with display:none for inactive tabs to keep terminals alive. */
  readonly windowTabs?: readonly WindowTab[] | undefined
}

/**
 * Renders the main panel area content, handling the reconciling/loading,
 * workspace frames, empty window tab state, or empty state.
 *
 * Side panels are rendered inside each workspace frame whose workspace ID is
 * included in the corresponding panel list, spanning the full height of that
 * workspace rather than sitting outside all workspaces.
 *
 * Provides a fullscreen portal target: when a pane is fullscreened, it
 * portals its content into an absolutely-positioned overlay rendered here.
 * This keeps sibling terminals mounted and correctly sized — they never
 * unmount during fullscreen transitions.
 */
export function PanelContent({
  isReconciling,
  activePaneId,
  activeTabId,
  fullscreenPaneId,
  windowLayout,
  windowTabs,
  isEmptyWindowTab = false,
  reviewWorkspaceIds = [],
  treeWorkspaceIds = [],
  diffWorkspaceIds = [],
}: PanelContentProps) {
  const [portalElement, setPortalElement] = useState<HTMLElement | null>(null)
  const handlePortalRef = useCallback((element: HTMLDivElement | null) => {
    setPortalElement(element)
  }, [])

  // Resolve the workspace ID for the fullscreened pane so we can render
  // its workspace header above the fullscreen overlay.
  const fullscreenWorkspaceId = useMemo(() => {
    if (!(fullscreenPaneId && windowLayout)) {
      return undefined
    }
    const found = findPaneAcrossAllTabs(windowLayout, fullscreenPaneId)
    if (found) {
      return found.workspaceId
    }
    return undefined
  }, [fullscreenPaneId, windowLayout])

  const fullscreenShowsDiff =
    fullscreenWorkspaceId !== undefined &&
    diffWorkspaceIds.includes(fullscreenWorkspaceId)
  const fullscreenShowsReview =
    fullscreenWorkspaceId !== undefined &&
    reviewWorkspaceIds.includes(fullscreenWorkspaceId)
  const fullscreenShowsTree =
    fullscreenWorkspaceId !== undefined &&
    treeWorkspaceIds.includes(fullscreenWorkspaceId)

  // Hide side panels for the fullscreened workspace in the normal tree so we
  // don't duplicate expensive panel instances underneath the fullscreen overlay.
  const inlineDiffWorkspaceIds =
    fullscreenWorkspaceId === undefined
      ? diffWorkspaceIds
      : diffWorkspaceIds.filter(
          (workspaceId) => workspaceId !== fullscreenWorkspaceId
        )
  const inlineReviewWorkspaceIds =
    fullscreenWorkspaceId === undefined
      ? reviewWorkspaceIds
      : reviewWorkspaceIds.filter(
          (workspaceId) => workspaceId !== fullscreenWorkspaceId
        )
  const inlineTreeWorkspaceIds =
    fullscreenWorkspaceId === undefined
      ? treeWorkspaceIds
      : treeWorkspaceIds.filter(
          (workspaceId) => workspaceId !== fullscreenWorkspaceId
        )

  if (isReconciling) {
    return (
      <div className="flex h-full items-center justify-center bg-background">
        <p className="text-muted-foreground text-sm">
          Restoring terminal sessions...
        </p>
      </div>
    )
  }

  // Active window tab has no workspaces — show workspace picker
  if (isEmptyWindowTab) {
    return <EmptyWindowTabState />
  }

  // Collect all window tabs that have workspace layouts. Render ALL of them
  // to keep terminal xterm.js instances alive across tab switches (VS Code
  // pattern: hide with `display:none` instead of unmounting). The active
  // tab is visible; inactive tabs are hidden but remain mounted in the DOM.
  const tabsToRender = windowTabs?.filter((tab) => tab.workspaceLayout) ?? []

  if (tabsToRender.length > 0) {
    return (
      <FullscreenPortalContext.Provider value={portalElement}>
        <div className="relative flex h-full w-full flex-col">
          {/* When a pane is fullscreened, render the workspace header for
              its workspace above the fullscreen overlay so the user can
              still see the project name, branch, PR status, and actions. */}
          {fullscreenPaneId && fullscreenWorkspaceId && (
            <div
              data-testid="fullscreen-workspace-header"
              data-workspace-id={fullscreenWorkspaceId}
            >
              <WorkspaceFrameHeaderContainer
                diffIsOpen={fullscreenShowsDiff}
                isActiveFrame
                isMinimized={false}
                onHeaderClick={noop}
                onMinimize={noop}
                reviewIsOpen={fullscreenShowsReview}
                treeIsOpen={fullscreenShowsTree}
                workspaceId={fullscreenWorkspaceId}
              />
            </div>
          )}
          <div className="relative min-h-0 flex-1">
            {tabsToRender.map((tab) => (
              <WindowTabContent
                activePaneId={activePaneId}
                diffWorkspaceIds={inlineDiffWorkspaceIds}
                isActive={tab.id === activeTabId}
                key={tab.id}
                reviewWorkspaceIds={inlineReviewWorkspaceIds}
                tab={tab}
                treeWorkspaceIds={inlineTreeWorkspaceIds}
              />
            ))}
            {/* Fullscreen portal target — panes portal into this overlay
                when fullscreened. Positioned absolutely to cover the
                workspace frames area (below the workspace header) without
                affecting the normal layout flow. */}
            {fullscreenPaneId && fullscreenWorkspaceId ? (
              <FullscreenWorkspaceOverlay
                fullscreenPaneId={fullscreenPaneId}
                fullscreenWorkspaceId={fullscreenWorkspaceId}
                portalRef={handlePortalRef}
                showsDiff={fullscreenShowsDiff}
                showsReview={fullscreenShowsReview}
                showsTree={fullscreenShowsTree}
              />
            ) : null}
          </div>
        </div>
      </FullscreenPortalContext.Provider>
    )
  }

  return <PanelManager layout={undefined} />
}
