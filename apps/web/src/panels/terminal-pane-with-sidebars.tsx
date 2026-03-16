import type { PanelLeafNode } from '@laborer/shared/types'
import { TerminalPane } from '@/panes/terminal-pane'

interface TerminalPaneWithSidebarsProps {
  readonly node: PanelLeafNode
  readonly onTerminalExit?: (() => void) | undefined
}

/**
 * Renders a terminal pane.
 *
 * In the hierarchical layout model, diff, review, and dev server are
 * independent panel types rendered as separate panes or panel tabs rather
 * than sidebar flags on terminal leaves. This component now simply renders
 * a TerminalPane with the node's terminal ID.
 *
 * The component name is kept for backward compatibility with existing
 * imports and tests, even though it no longer renders sidebars.
 */
function TerminalPaneWithSidebars({
  node,
  onTerminalExit,
}: TerminalPaneWithSidebarsProps) {
  return (
    <TerminalPane
      onTerminalExit={onTerminalExit}
      terminalId={node.terminalId as string}
    />
  )
}

export { TerminalPaneWithSidebars }
