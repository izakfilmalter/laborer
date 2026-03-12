/**
 * Floating toolbar rendered over terminal panes.
 *
 * Shows per-pane action buttons (split, fullscreen, close) positioned at
 * the top-right corner of the terminal. These buttons were moved from the
 * workspace frame header because they operate on individual panes, not the
 * whole workspace.
 *
 * The toolbar is only visible when the parent pane container is hovered
 * (via the `group/pane` Tailwind group). This keeps the terminal clean
 * during normal use while still providing quick access to pane actions.
 *
 * @see components/workspace-frame-header.tsx — workspace-level header (close workspace)
 * @see panels/panel-manager.tsx — LeafPaneRenderer (renders this toolbar)
 */

import { Columns2, Maximize, Minimize, Rows2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import type { PanelActions } from '@/panels/panel-context'

interface TerminalOverlayToolbarProps {
  /** Panel layout actions (split, close, fullscreen, etc.). */
  readonly actions: PanelActions | null
  /** Whether the pane is currently in fullscreen mode. */
  readonly isFullscreen: boolean
  /** The pane ID this toolbar operates on. */
  readonly paneId: string
}

function TerminalOverlayToolbar({
  actions,
  isFullscreen,
  paneId,
}: TerminalOverlayToolbarProps) {
  return (
    <div className="absolute top-1 right-1 z-20 flex gap-0.5 rounded-md border bg-background/80 p-0.5 opacity-0 shadow-sm backdrop-blur-sm transition-opacity group-hover/pane:opacity-100">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label="Split horizontally"
              onClick={() => actions?.splitPane(paneId, 'horizontal')}
              size="icon-sm"
              variant="ghost"
            />
          }
        >
          <Columns2 className="size-3.5" />
        </TooltipTrigger>
        <TooltipContent>
          Split horizontally
          <KbdGroup>
            <Kbd>⌘</Kbd>
            <Kbd>D</Kbd>
          </KbdGroup>
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label="Split vertically"
              onClick={() => actions?.splitPane(paneId, 'vertical')}
              size="icon-sm"
              variant="ghost"
            />
          }
        >
          <Rows2 className="size-3.5" />
        </TooltipTrigger>
        <TooltipContent>
          Split vertically
          <KbdGroup>
            <Kbd>⇧</Kbd>
            <Kbd>⌘</Kbd>
            <Kbd>D</Kbd>
          </KbdGroup>
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen pane'}
              onClick={() => actions?.toggleFullscreenPane()}
              size="icon-sm"
              variant="ghost"
            />
          }
        >
          {isFullscreen ? (
            <Minimize className="size-3.5" />
          ) : (
            <Maximize className="size-3.5" />
          )}
        </TooltipTrigger>
        <TooltipContent>
          {isFullscreen ? 'Exit fullscreen' : 'Fullscreen pane'}
          <KbdGroup>
            <Kbd>⇧</Kbd>
            <Kbd>⌘</Kbd>
            <Kbd>↵</Kbd>
          </KbdGroup>
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label="Close pane"
              onClick={() => actions?.closePane(paneId)}
              size="icon-sm"
              variant="ghost"
            />
          }
        >
          <X className="size-3.5" />
        </TooltipTrigger>
        <TooltipContent>
          Close pane
          <KbdGroup>
            <Kbd>⌘</Kbd>
            <Kbd>W</Kbd>
          </KbdGroup>
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

export { TerminalOverlayToolbar }
export type { TerminalOverlayToolbarProps }
