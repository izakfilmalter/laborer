import type { PanelNode } from '@laborer/shared/types'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable'
import { PanelManager } from '@/panels/panel-manager'
import { DiffPane } from '@/panes/diff-pane'
import { ReviewPane } from '@/panes/review-pane'
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
 * Renders full-height side panels (diff and/or review) with resize handles.
 */
function SidePanels({
  diffWorkspaceId,
  reviewWorkspaceId,
  sidePanelSize,
}: {
  readonly diffWorkspaceId: string | null
  readonly reviewWorkspaceId: string | null
  readonly sidePanelSize: string
}) {
  return (
    <>
      {diffWorkspaceId && (
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
      {reviewWorkspaceId && (
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
    </>
  )
}

/**
 * Renders workspace frames with optional full-height side panels.
 */
function LayoutWithSidePanels({
  activePaneId,
  diffWorkspaceId,
  fullscreenPaneId,
  layout,
  reviewWorkspaceId,
  workspaceOrder,
}: {
  readonly activePaneId: string | null
  readonly diffWorkspaceId: string | null
  readonly fullscreenPaneId: string | null
  readonly layout: PanelNode
  readonly reviewWorkspaceId: string | null
  readonly workspaceOrder: string[] | null
}) {
  const hasSidePanels = diffWorkspaceId !== null || reviewWorkspaceId !== null

  if (!hasSidePanels) {
    return (
      <WorkspaceFrames
        activePaneId={activePaneId}
        fullscreenPaneId={fullscreenPaneId}
        layout={layout}
        workspaceOrder={workspaceOrder}
      />
    )
  }

  // Calculate default sizes based on how many panels are open
  const panelCount = (diffWorkspaceId ? 1 : 0) + (reviewWorkspaceId ? 1 : 0)
  const sidePanelSize = panelCount === 2 ? '20%' : '30%'
  const mainPanelSize = panelCount === 2 ? '60%' : '70%'

  return (
    <ResizablePanelGroup className="h-full" orientation="horizontal">
      <ResizablePanel defaultSize={mainPanelSize} minSize="30%">
        <WorkspaceFrames
          activePaneId={activePaneId}
          fullscreenPaneId={fullscreenPaneId}
          layout={layout}
          workspaceOrder={workspaceOrder}
        />
      </ResizablePanel>
      <SidePanels
        diffWorkspaceId={diffWorkspaceId}
        reviewWorkspaceId={reviewWorkspaceId}
        sidePanelSize={sidePanelSize}
      />
    </ResizablePanelGroup>
  )
}

/**
 * Renders the main panel area content, handling the reconciling/loading,
 * workspace frames, or empty state.
 *
 * When side panels (review and/or diff) are open, renders them alongside
 * the workspace frames in a horizontal split. These panels are global and
 * span all workspaces rather than being contained within a single workspace's
 * layout.
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
      <LayoutWithSidePanels
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
