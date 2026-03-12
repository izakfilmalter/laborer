import type { LeafNode } from '@laborer/shared/types'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable'
import { useResponsiveLayout } from '@/hooks/use-responsive-layout'
import { DevServerTerminalPane } from '@/panes/dev-server-terminal-pane'
import { DiffPane } from '@/panes/diff-pane'
import { TerminalPane } from '@/panes/terminal-pane'

interface TerminalPaneWithSidebarsProps {
  readonly node: LeafNode
  readonly onTerminalExit?: (() => void) | undefined
}

function TerminalPaneWithSidebars({
  node,
  onTerminalExit,
}: TerminalPaneWithSidebarsProps) {
  const { paneMin } = useResponsiveLayout()

  const showDiff = node.diffOpen === true && node.workspaceId !== undefined
  const showDevServer =
    node.devServerOpen === true && node.devServerTerminalId !== undefined

  if (!(showDiff || showDevServer)) {
    return (
      <TerminalPane
        onTerminalExit={onTerminalExit}
        terminalId={node.terminalId as string}
      />
    )
  }

  if (showDiff && !showDevServer) {
    return (
      <ResizablePanelGroup orientation="horizontal">
        <ResizablePanel defaultSize="60%" minSize={paneMin}>
          <TerminalPane
            onTerminalExit={onTerminalExit}
            terminalId={node.terminalId as string}
          />
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel defaultSize="40%" minSize={paneMin}>
          <DiffPane workspaceId={node.workspaceId as string} />
        </ResizablePanel>
      </ResizablePanelGroup>
    )
  }

  if (showDevServer && !showDiff) {
    return (
      <ResizablePanelGroup orientation="horizontal">
        <ResizablePanel defaultSize="60%" minSize={paneMin}>
          <TerminalPane
            onTerminalExit={onTerminalExit}
            terminalId={node.terminalId as string}
          />
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel defaultSize="40%" minSize={paneMin}>
          <DevServerTerminalPane
            terminalId={node.devServerTerminalId as string}
          />
        </ResizablePanel>
      </ResizablePanelGroup>
    )
  }

  return (
    <ResizablePanelGroup orientation="horizontal">
      <ResizablePanel defaultSize="60%" minSize={paneMin}>
        <TerminalPane
          onTerminalExit={onTerminalExit}
          terminalId={node.terminalId as string}
        />
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel defaultSize="40%" minSize={paneMin}>
        <ResizablePanelGroup orientation="vertical">
          <ResizablePanel defaultSize="60%" minSize={paneMin}>
            <DiffPane workspaceId={node.workspaceId as string} />
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel defaultSize="40%" minSize={paneMin}>
            <DevServerTerminalPane
              terminalId={node.devServerTerminalId as string}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}

export { TerminalPaneWithSidebars }
