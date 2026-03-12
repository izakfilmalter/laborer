import type { PanelNode } from '@laborer/shared/types'
import { PanelManager } from '@/panels/panel-manager'
import { WorkspaceFrames } from './workspace-frames'

/**
 * Renders the main panel area content, handling the reconciling/loading,
 * workspace frames, or empty state.
 */
export function PanelContent({
  isReconciling,
  layout,
  activePaneId,
  fullscreenPaneId,
  workspaceOrder,
}: {
  readonly isReconciling: boolean
  readonly layout: PanelNode | undefined
  readonly activePaneId: string | null
  readonly fullscreenPaneId: string | null
  readonly workspaceOrder: string[] | null
}) {
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
        fullscreenPaneId={fullscreenPaneId}
        layout={layout}
        workspaceOrder={workspaceOrder}
      />
    )
  }
  return <PanelManager layout={undefined} />
}
