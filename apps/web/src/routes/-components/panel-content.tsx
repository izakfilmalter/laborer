import type { PanelNode, WorkspaceTileNode } from '@laborer/shared/types'
import { useMemo, useState } from 'react'
import { findNodeById } from '@/panels/layout-utils'
import { FullscreenPortalContext } from '@/panels/panel-context'
import { PanelManager } from '@/panels/panel-manager'
import { WorkspaceFrameHeaderContainer } from './workspace-frame-header-container'
import { EmptyWindowTabState, WorkspaceFrames } from './workspace-frames'

/** No-op callback for fullscreen workspace header handlers. */
const noop = () => undefined

interface PanelContentProps {
  readonly activePaneId: string | null
  readonly diffPaneOpen?: boolean
  readonly diffWorkspaceId?: string | null
  readonly fullscreenPaneId: string | null
  /** True when the active window tab exists but has no workspace layout. */
  readonly isEmptyWindowTab?: boolean
  readonly isReconciling: boolean
  readonly layout: PanelNode | undefined
  readonly reviewPaneOpen?: boolean
  readonly reviewWorkspaceId?: string | null
  readonly workspaceOrder: string[] | null
  readonly workspaceTileLayout?: WorkspaceTileNode | undefined
}

/**
 * Renders the main panel area content, handling the reconciling/loading,
 * workspace frames, empty window tab state, or empty state.
 *
 * Side panels (review and/or diff) are rendered inside each workspace frame
 * that matches the panel's workspaceId, spanning the full height of that
 * workspace rather than sitting outside all workspaces.
 *
 * Provides a fullscreen portal target: when a pane is fullscreened, it
 * portals its content into an absolutely-positioned overlay rendered here.
 * This keeps sibling terminals mounted and correctly sized — they never
 * unmount during fullscreen transitions.
 */
export function PanelContent({
  isReconciling,
  layout,
  activePaneId,
  fullscreenPaneId,
  workspaceOrder,
  workspaceTileLayout,
  isEmptyWindowTab = false,
  reviewPaneOpen = false,
  reviewWorkspaceId = null,
  diffPaneOpen = false,
  diffWorkspaceId = null,
}: PanelContentProps) {
  const [portalElement, setPortalElement] = useState<HTMLElement | null>(null)

  // Resolve the workspace ID for the fullscreened pane so we can render
  // its workspace header above the fullscreen overlay.
  const fullscreenWorkspaceId = useMemo(() => {
    if (!(fullscreenPaneId && layout)) {
      return undefined
    }
    const node = findNodeById(layout, fullscreenPaneId)
    if (node && node._tag === 'LeafNode') {
      return node.workspaceId
    }
    return undefined
  }, [fullscreenPaneId, layout])

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

  if (layout) {
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
                diffIsOpen={false}
                isMinimized={false}
                onHeaderClick={noop}
                onMinimize={noop}
                reviewIsOpen={false}
                subLayout={layout}
                workspaceId={fullscreenWorkspaceId}
              />
            </div>
          )}
          <div className="relative min-h-0 flex-1">
            <WorkspaceFrames
              activePaneId={activePaneId}
              diffWorkspaceId={diffPaneOpen ? diffWorkspaceId : null}
              layout={layout}
              reviewWorkspaceId={reviewPaneOpen ? reviewWorkspaceId : null}
              workspaceOrder={workspaceOrder}
              workspaceTileLayout={workspaceTileLayout}
            />
            {/* Fullscreen portal target — panes portal into this overlay
                when fullscreened. Positioned absolutely to cover the
                workspace frames area (below the workspace header) without
                affecting the normal layout flow. */}
            {fullscreenPaneId && (
              <div className="absolute inset-0 z-10" ref={setPortalElement} />
            )}
          </div>
        </div>
      </FullscreenPortalContext.Provider>
    )
  }

  return <PanelManager layout={undefined} />
}
