/**
 * Dev server terminal pane — wraps the standard TerminalPane with a
 * visual indicator to distinguish it from agent terminal panes.
 *
 * Renders a teal/cyan top border and a "Dev Server" label to make it
 * immediately obvious which terminal is the dev server process.
 *
 * The underlying TerminalPane handles all xterm.js, WebSocket, resize,
 * and reconnection logic identically.
 *
 * @see Issue #8: Dev server terminal pane type + toggle
 */

import { Server } from 'lucide-react'
import { TerminalPane } from '@/panes/terminal-pane'

interface DevServerTerminalPaneProps {
  readonly terminalId: string
}

function DevServerTerminalPane({ terminalId }: DevServerTerminalPaneProps) {
  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex h-6 shrink-0 items-center gap-1.5 border-t-2 border-t-teal-500 border-b bg-teal-500/5 px-2">
        <Server className="size-3 text-teal-500" />
        <span className="font-medium text-teal-500 text-xs">Dev Server</span>
      </div>
      <div className="min-h-0 flex-1">
        <TerminalPane terminalId={terminalId} />
      </div>
    </div>
  )
}

export { DevServerTerminalPane }
