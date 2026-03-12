/**
 * Presentational header bar for a single workspace frame.
 *
 * Shows project / branch name and pane action buttons scoped to this
 * workspace's panes. All data is received via props — no store coupling.
 *
 * The data-fetching wrapper lives in routes/index.tsx and queries
 * LiveStore for the project, workspace, and layout data.
 */

import {
  Columns2,
  FileCode2,
  Maximize,
  Minimize,
  Rows2,
  Server,
  Terminal,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import type { PanelActions } from '@/panels/panel-context'

interface WorkspaceFrameHeaderProps {
  /** Panel layout actions (split, close, toggleDiff, etc.). */
  readonly actions: PanelActions | null
  /** The active pane ID, or null if no pane is active. */
  readonly activePaneId: string | null
  /** The branch name for the workspace (shown in the header). */
  readonly branchName: string | undefined
  /** Whether the diff viewer is currently open for the active pane. */
  readonly diffIsOpen: boolean
  /** Ref attached to the header element so it can serve as a drag handle. */
  readonly dragHandleRef?:
    | { readonly current: HTMLDivElement | null }
    | undefined
  /** Whether the workspace runs in a container (shows dev server toggle). */
  readonly isContainerized: boolean
  /** Whether the active pane is in fullscreen mode. */
  readonly isFullscreen: boolean
  /** The project name for the workspace (shown in the header). */
  readonly projectName: string | undefined
}

function WorkspaceFrameHeader({
  activePaneId,
  actions,
  branchName,
  diffIsOpen,
  dragHandleRef,
  isContainerized,
  isFullscreen,
  projectName,
}: WorkspaceFrameHeaderProps) {
  const hasActivePane = !!activePaneId

  return (
    <div
      className="flex h-8 shrink-0 items-center justify-between border-b px-2"
      ref={dragHandleRef}
    >
      <div className="flex cursor-grab items-center gap-2 active:cursor-grabbing">
        <div className="flex items-center gap-1 text-muted-foreground">
          <Terminal className="size-3.5" />
        </div>
        <div className="min-w-0 truncate text-muted-foreground text-xs">
          {projectName && branchName ? (
            <>
              <span className="text-foreground">{projectName}</span>
              <span className="mx-1">/</span>
              <span>{branchName}</span>
            </>
          ) : (
            <span className="text-foreground">Terminal</span>
          )}
        </div>
      </div>
      <div className="flex gap-0.5">
        {isContainerized && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label="Toggle dev server terminal"
                  disabled={!hasActivePane}
                  onClick={() =>
                    activePaneId && actions?.toggleDevServerPane(activePaneId)
                  }
                  size="icon-sm"
                  variant="ghost"
                />
              }
            >
              <Server className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent>Toggle dev server terminal</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label={
                  diffIsOpen ? 'Close diff viewer' : 'Open diff viewer'
                }
                className={diffIsOpen ? 'bg-accent' : ''}
                disabled={!hasActivePane}
                onClick={() =>
                  activePaneId && actions?.toggleDiffPane(activePaneId)
                }
                size="icon-sm"
                variant="ghost"
              />
            }
          >
            <FileCode2 className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent>
            {diffIsOpen ? 'Close diff viewer' : 'Open diff viewer'}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label="Split horizontally"
                disabled={!hasActivePane}
                onClick={() =>
                  activePaneId && actions?.splitPane(activePaneId, 'horizontal')
                }
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
                disabled={!hasActivePane}
                onClick={() =>
                  activePaneId && actions?.splitPane(activePaneId, 'vertical')
                }
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
                aria-label={
                  isFullscreen ? 'Exit fullscreen' : 'Fullscreen pane'
                }
                disabled={!hasActivePane}
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
                disabled={!hasActivePane}
                onClick={() => activePaneId && actions?.closePane(activePaneId)}
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
    </div>
  )
}

export { WorkspaceFrameHeader }
export type { WorkspaceFrameHeaderProps }
