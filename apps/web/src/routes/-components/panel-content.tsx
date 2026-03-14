import type { PanelNode } from '@laborer/shared/types'
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
}

/**
 * Renders the main panel area content, handling the reconciling/loading,
 * workspace frames, or empty state.
 *
 * Side panels (review and/or diff) are rendered inside each workspace frame
 * that matches the panel's workspaceId, spanning the full height of that
 * workspace rather than sitting outside all workspaces.
 */
export function PanelContent({
  isReconciling,
  layout,
  activePaneId,
  fullscreenPaneId,
  workspaceOrder,
  reviewPaneOpen = false,
  reviewWorkspaceId = null,
  diffPaneOpen = false,
  diffWorkspaceId = null,
}: PanelContentProps) {
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
      <WorkspaceFrames
        activePaneId={activePaneId}
        diffWorkspaceId={diffPaneOpen ? diffWorkspaceId : null}
        fullscreenPaneId={fullscreenPaneId}
        layout={layout}
        reviewWorkspaceId={reviewPaneOpen ? reviewWorkspaceId : null}
        workspaceOrder={workspaceOrder}
      />
    )
  }

  return <PanelManager layout={undefined} />
}
