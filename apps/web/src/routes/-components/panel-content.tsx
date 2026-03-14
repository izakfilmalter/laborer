import type { PanelNode, WorkspaceTileNode } from '@laborer/shared/types'
import { useState } from 'react'
import { FullscreenPortalContext } from '@/panels/panel-context'
import { PanelManager } from '@/panels/panel-manager'
import { WorkspaceFrames } from './workspace-frames'

interface PanelContentProps {
  readonly activePaneId: string | null
  readonly diffPaneOpen?: boolean
  readonly diffWorkspaceId?: string | null
  readonly fullscreenPaneId: string | null
  readonly isReconciling: boolean
  readonly layout: PanelNode | undefined
  readonly reviewPaneOpen?: boolean
  readonly reviewWorkspaceId?: string | null
  readonly workspaceOrder: string[] | null
  readonly workspaceTileLayout?: WorkspaceTileNode | undefined
}

/**
 * Renders the main panel area content, handling the reconciling/loading,
 * workspace frames, or empty state.
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
  reviewPaneOpen = false,
  reviewWorkspaceId = null,
  diffPaneOpen = false,
  diffWorkspaceId = null,
}: PanelContentProps) {
  const [portalElement, setPortalElement] = useState<HTMLElement | null>(null)

  if (isReconciling) {
    return (
      <div className="flex h-full items-center justify-center bg-background">
        <p className="text-muted-foreground text-sm">
          Restoring terminal sessions...
        </p>
      </div>
    )
  }

  if (layout) {
    return (
      <FullscreenPortalContext.Provider value={portalElement}>
        <div className="relative h-full w-full">
          <WorkspaceFrames
            activePaneId={activePaneId}
            diffWorkspaceId={diffPaneOpen ? diffWorkspaceId : null}
            layout={layout}
            reviewWorkspaceId={reviewPaneOpen ? reviewWorkspaceId : null}
            workspaceOrder={workspaceOrder}
            workspaceTileLayout={workspaceTileLayout}
          />
          {/* Fullscreen portal target — panes portal into this overlay
              when fullscreened. Positioned absolutely to cover the entire
              panel area without affecting the normal layout flow. */}
          {fullscreenPaneId && (
            <div className="absolute inset-0 z-10" ref={setPortalElement} />
          )}
        </div>
      </FullscreenPortalContext.Provider>
    )
  }

  return <PanelManager layout={undefined} />
}
