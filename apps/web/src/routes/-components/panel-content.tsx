import type { WindowLayout, WindowTab } from '@laborer/shared/types'
import { useCallback, useMemo, useState } from 'react'
import { WorkspaceRightPanel } from '@/components/right-panel/workspace-right-panel'
import {
  FullscreenPortalContext,
  usePendingCloseWindowTab,
} from '@/panels/panel-context'
import { PanelManager } from '@/panels/panel-manager'
import { findPaneAcrossAllTabs } from '@/panels/window-layout-utils'
import { selectActiveRightPanel, useRightPanelStore } from '@/right-panel-store'
import { WindowTabCloseConfirmDialog } from './close-dialogs'
import { WorkspaceFrameHeaderContainer } from './workspace-frame-header-container'
import { EmptyWindowTabState, WorkspaceFrames } from './workspace-frames'

/** No-op callback for fullscreen workspace header handlers. */
const noop = () => undefined

/**
 * Workspace header shown above the fullscreen overlay. The diff/files/
 * comments button states mirror the right panel's active surface, same as
 * the inline frame header.
 */
function FullscreenWorkspaceHeader({
  workspaceId,
}: {
  readonly workspaceId: string
}) {
  const activeRightPanelKind = useRightPanelStore(
    useCallback(
      (store) => selectActiveRightPanel(store.byWorkspaceId, workspaceId),
      [workspaceId]
    )
  )

  return (
    <WorkspaceFrameHeaderContainer
      browserIsOpen={activeRightPanelKind === 'preview'}
      commentsIsOpen={activeRightPanelKind === 'pull-request'}
      diffIsOpen={activeRightPanelKind === 'diff'}
      filesIsOpen={
        activeRightPanelKind === 'files' || activeRightPanelKind === 'file'
      }
      isActiveFrame
      isMinimized={false}
      onHeaderClick={noop}
      onMinimize={noop}
      workspaceId={workspaceId}
    />
  )
}

interface FullscreenWorkspaceOverlayProps {
  readonly fullscreenWorkspaceId: string
  readonly portalRef: (element: HTMLDivElement | null) => void
}

/**
 * The fullscreen overlay keeps the fullscreened workspace's right panel in
 * reach on the right edge (it owns its own width and renders nothing while
 * closed) — the file explorer is one of its surfaces. The inline frame's
 * right panel is suppressed while this overlay owns the workspace, so the
 * surfaces are not mounted twice.
 */
function FullscreenWorkspaceOverlay({
  fullscreenWorkspaceId,
  portalRef,
}: FullscreenWorkspaceOverlayProps) {
  return (
    <div className="absolute inset-0 z-10 flex">
      <div className="h-full min-w-0 flex-1">
        <div className="h-full w-full" ref={portalRef} />
      </div>
      <WorkspaceRightPanel
        isFullscreenOverlay
        workspaceId={fullscreenWorkspaceId}
      />
    </div>
  )
}

/**
 * Renders a single window tab's workspace frames inside a container that
 * is hidden via `display: none` when the tab is inactive. This keeps
 * Ghostty terminal surfaces, attach streams, and RPC
 * subscriptions alive across tab switches (VS Code pattern).
 *
 * We use `display: none` rather than `visibility: hidden` or zero-size
 * tricks because a hidden-but-laid-out element would report a 0x0 box and
 * the surface would refit to 0 cols/rows, causing a storm of resize RPC
 * calls. `display: none` removes the element from layout entirely, so the
 * surface's `ResizeObserver` stays silent for inactive tabs.
 *
 * `isolate` (isolation: isolate) makes this container its own stacking
 * context so pane-level overlays — the hover toolbar (`z-20`) and the
 * terminal notification (`z-30`) — stay contained. Without it those
 * z-indexes compete with the fullscreen overlay (`z-10`) in the shared
 * parent stacking context and paint (and hit-test) on top of the
 * fullscreened pane, letting background panes reveal their hover
 * toolbars over a fullscreen terminal.
 */
function WindowTabContent({
  tab,
  isActive,
  activePaneId,
  suppressedRightPanelWorkspaceId,
}: {
  readonly tab: WindowTab
  readonly isActive: boolean
  readonly activePaneId: string | null
  readonly suppressedRightPanelWorkspaceId: string | null
}) {
  const layout = tab.workspaceLayout
  const pendingCloseWindowTab = usePendingCloseWindowTab()
  if (!layout) {
    return null
  }

  const isClosingTab = pendingCloseWindowTab.tabId === tab.id

  return (
    <div
      className={
        isActive ? 'relative isolate h-full w-full' : 'relative isolate'
      }
      data-testid="window-tab-content"
      data-window-tab-id={tab.id}
      style={isActive ? undefined : { display: 'none' }}
    >
      <WorkspaceFrames
        activePaneId={isActive ? activePaneId : null}
        suppressedRightPanelWorkspaceId={suppressedRightPanelWorkspaceId}
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
  readonly fullscreenPaneId: string | null
  /** True when the active window tab exists but has no workspace layout. */
  readonly isEmptyWindowTab?: boolean
  readonly isReconciling: boolean
  /** The hierarchical window layout — used for fullscreen pane workspace resolution. */
  readonly windowLayout?: WindowLayout | undefined
  /** All window tabs — rendered with display:none for inactive tabs to keep terminals alive. */
  readonly windowTabs?: readonly WindowTab[] | undefined
}

/**
 * Renders the main panel area content, handling the reconciling/loading,
 * workspace frames, empty window tab state, or empty state.
 *
 * Each workspace frame renders its own right panel (diff, files, pull
 * request) on its right edge, spanning the full height of that workspace
 * rather than sitting outside all workspaces.
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
  // to keep terminal surfaces alive across tab switches (VS Code
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
              <FullscreenWorkspaceHeader workspaceId={fullscreenWorkspaceId} />
            </div>
          )}
          <div className="relative min-h-0 flex-1">
            {tabsToRender.map((tab) => (
              <WindowTabContent
                activePaneId={activePaneId}
                isActive={tab.id === activeTabId}
                key={tab.id}
                suppressedRightPanelWorkspaceId={fullscreenWorkspaceId ?? null}
                tab={tab}
              />
            ))}
            {/* Fullscreen portal target — panes portal into this overlay
                when fullscreened. Positioned absolutely to cover the
                workspace frames area (below the workspace header) without
                affecting the normal layout flow. It relies on each
                WindowTabContent being an isolated stacking context so
                background pane overlays cannot paint above it. */}
            {fullscreenPaneId && fullscreenWorkspaceId ? (
              <FullscreenWorkspaceOverlay
                fullscreenWorkspaceId={fullscreenWorkspaceId}
                portalRef={handlePortalRef}
              />
            ) : null}
          </div>
        </div>
      </FullscreenPortalContext.Provider>
    )
  }

  return <PanelManager layout={undefined} />
}
