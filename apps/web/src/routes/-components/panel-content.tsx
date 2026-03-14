import type { PanelNode } from '@laborer/shared/types'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable'
import { PanelManager } from '@/panels/panel-manager'
import { ReviewPane } from '@/panes/review-pane'
import { WorkspaceFrames } from './workspace-frames'

/**
 * Renders the main panel area content, handling the reconciling/loading,
 * workspace frames, or empty state.
 *
 * When the review panel is open, renders it alongside the workspace frames
 * in a horizontal split. The review panel is a global panel that spans all
 * workspaces rather than being contained within a single workspace's layout.
 */
export function PanelContent({
  isReconciling,
  layout,
  activePaneId,
  fullscreenPaneId,
  workspaceOrder,
  reviewPaneOpen = false,
  reviewWorkspaceId = null,
}: {
  readonly isReconciling: boolean
  readonly layout: PanelNode | undefined
  readonly activePaneId: string | null
  readonly fullscreenPaneId: string | null
  readonly workspaceOrder: string[] | null
  readonly reviewPaneOpen?: boolean
  readonly reviewWorkspaceId?: string | null
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
    // When review panel is open, wrap workspace frames and review panel
    // in a horizontal resizable split
    if (reviewPaneOpen && reviewWorkspaceId) {
      return (
        <ResizablePanelGroup className="h-full" orientation="horizontal">
          <ResizablePanel defaultSize="70%" minSize="30%">
            <WorkspaceFrames
              activePaneId={activePaneId}
              fullscreenPaneId={fullscreenPaneId}
              layout={layout}
              workspaceOrder={workspaceOrder}
            />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel
            className="h-full overflow-hidden"
            defaultSize="30%"
            minSize="15%"
          >
            <ReviewPane workspaceId={reviewWorkspaceId} />
          </ResizablePanel>
        </ResizablePanelGroup>
      )
    }

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
