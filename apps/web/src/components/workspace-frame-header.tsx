/**
 * Presentational header bar for a single workspace frame.
 *
 * Shows project / branch name, workspace-level action buttons (diff toggle,
 * dev server toggle), and a close-workspace button that kills all terminals
 * for this workspace.
 *
 * Per-pane actions (split, fullscreen, close pane) are rendered as an
 * overlay toolbar on each terminal pane instead.
 *
 * The data-fetching wrapper lives in routes/index.tsx and queries
 * LiveStore for the project, workspace, and layout data.
 *
 * @see components/terminal-overlay-toolbar.tsx — per-pane floating toolbar
 */

import { FileCode2, Minus, Plus, Server, Terminal, X } from 'lucide-react'
import { GitHubPrStatusBadge } from '@/components/github-pr-status-badge'
import { Button } from '@/components/ui/button'
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
  /** Whether the workspace frame is minimized (collapsed to header only). */
  readonly isMinimized?: boolean | undefined
  /** Called when the header area is clicked (focus pane or expand if minimized). */
  readonly onHeaderClick?: (() => void) | undefined
  /** Called when the minimize/expand button is clicked. */
  readonly onMinimize?: (() => void) | undefined
  /** PR number, if the workspace has an associated pull request. */
  readonly prNumber: number | null
  /** The project name for the workspace (shown in the header). */
  readonly projectName: string | undefined
  /** PR state: 'OPEN', 'CLOSED', or 'MERGED'. */
  readonly prState: string | null
  /** PR title for tooltip. */
  readonly prTitle: string | null
  /** PR URL for linking. */
  readonly prUrl: string | null
  /** The workspace ID, used for the close-workspace action. */
  readonly workspaceId: string | undefined
}

function WorkspaceFrameHeader({
  activePaneId,
  actions,
  branchName,
  diffIsOpen,
  dragHandleRef,
  isContainerized,
  isMinimized,
  onHeaderClick,
  onMinimize,
  prNumber,
  prState,
  prTitle,
  prUrl,
  projectName,
  workspaceId,
}: WorkspaceFrameHeaderProps) {
  const hasActivePane = !!activePaneId

  /** Shift focus to this workspace's pane before performing a panel action. */
  const withFocus = (fn: (paneId: string) => void) => () => {
    if (!activePaneId) {
      return
    }
    actions?.setActivePaneId(activePaneId)
    fn(activePaneId)
  }

  return (
    <div
      className="flex h-8 shrink-0 items-center justify-between border-b px-2"
      data-testid="workspace-frame-header"
      ref={dragHandleRef}
    >
      <div className="flex min-w-0 items-center gap-2">
        <button
          className="flex min-w-0 cursor-grab items-center gap-2 active:cursor-grabbing"
          onClick={(e) => {
            e.stopPropagation()
            onHeaderClick?.()
          }}
          type="button"
        >
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
        </button>
        <GitHubPrStatusBadge
          className="shrink-0"
          prNumber={prNumber}
          prState={prState}
          prTitle={prTitle}
          prUrl={prUrl}
        />
      </div>
      <div className="flex gap-0.5">
        {!isMinimized && (
          <>
            {isContainerized && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      aria-label="Toggle dev server terminal"
                      disabled={!hasActivePane}
                      onClick={withFocus((paneId) =>
                        actions?.toggleDevServerPane(paneId)
                      )}
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
                    onClick={withFocus((paneId) =>
                      actions?.toggleDiffPane(paneId)
                    )}
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
                    aria-label="Close workspace"
                    disabled={!workspaceId}
                    onClick={() =>
                      workspaceId && actions?.closeWorkspace(workspaceId)
                    }
                    size="icon-sm"
                    variant="ghost"
                  />
                }
              >
                <X className="size-3.5" />
              </TooltipTrigger>
              <TooltipContent>Close workspace</TooltipContent>
            </Tooltip>
          </>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label={
                  isMinimized ? 'Expand workspace' : 'Minimize workspace'
                }
                onClick={(e) => {
                  e.stopPropagation()
                  onMinimize?.()
                }}
                size="icon-sm"
                variant="ghost"
              />
            }
          >
            {isMinimized ? (
              <Plus className="size-3.5" />
            ) : (
              <Minus className="size-3.5" />
            )}
          </TooltipTrigger>
          <TooltipContent>
            {isMinimized ? 'Expand workspace' : 'Minimize workspace'}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}

export { WorkspaceFrameHeader }
export type { WorkspaceFrameHeaderProps }
