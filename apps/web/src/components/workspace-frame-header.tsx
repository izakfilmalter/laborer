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
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  Maximize,
  Minimize,
  Rows2,
  Server,
  Terminal,
  X,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Spinner } from '@/components/ui/spinner'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { PanelActions } from '@/panels/panel-context'

/** Returns the appropriate icon component for a PR state. */
function PrStateIcon({
  prState,
  className,
}: {
  readonly prState: string | null
  readonly className?: string
}) {
  if (prState === 'MERGED') {
    return <GitMerge className={cn('text-purple-500', className)} />
  }
  if (prState === 'CLOSED') {
    return (
      <GitPullRequestClosed className={cn('text-destructive', className)} />
    )
  }
  return <GitPullRequest className={cn('text-success', className)} />
}

/** Returns the human-readable label for a PR state. */
function getPrStateLabel(prState: string | null): string {
  if (prState === 'MERGED') {
    return 'merged'
  }
  if (prState === 'CLOSED') {
    return 'closed'
  }
  return 'open'
}

/** Returns Tailwind classes for PR state badge styling. */
function getPrStateClasses(prState: string | null): string {
  if (prState === 'MERGED') {
    return 'border-purple-500/30 bg-purple-500/10 text-purple-500'
  }
  if (prState === 'CLOSED') {
    return 'border-destructive/30 bg-destructive/10 text-destructive'
  }
  return 'border-success/30 bg-success/10 text-success'
}

type WorkspaceDisplayStatus =
  | 'creating'
  | 'running'
  | 'paused'
  | 'stopped'
  | 'errored'
  | 'destroyed'

/** Returns Tailwind classes for a workspace status badge. */
function getStatusClasses(status: string): string {
  switch (status as WorkspaceDisplayStatus) {
    case 'creating':
      return 'border-warning/30 bg-warning/10 text-warning'
    case 'running':
      return 'border-success/30 bg-success/10 text-success'
    case 'paused':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-500'
    case 'stopped':
      return 'border-muted-foreground/30 bg-muted text-muted-foreground'
    case 'errored':
      return 'border-destructive/30 bg-destructive/10 text-destructive'
    case 'destroyed':
      return 'border-muted-foreground/20 bg-muted/50 text-muted-foreground/60'
    default:
      return 'border-muted-foreground/30 bg-muted text-muted-foreground'
  }
}

/** Small colored status indicator dot / spinner. */
function StatusDot({ status }: { readonly status: string }) {
  if (status === 'creating') {
    return <Spinner className="size-3 text-warning" />
  }

  const dotColor = (() => {
    switch (status as WorkspaceDisplayStatus) {
      case 'running':
        return 'bg-success'
      case 'paused':
        return 'bg-amber-500'
      case 'stopped':
        return 'bg-muted-foreground/50'
      case 'errored':
        return 'bg-destructive'
      case 'destroyed':
        return 'bg-muted-foreground/30'
      default:
        return 'bg-muted-foreground/50'
    }
  })()

  return <span className={cn('inline-block size-2 rounded-full', dotColor)} />
}

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
  /** Display status of the workspace (e.g. 'running', 'paused'). */
  readonly workspaceStatus: string | undefined
}

function WorkspaceFrameHeader({
  activePaneId,
  actions,
  branchName,
  diffIsOpen,
  dragHandleRef,
  isContainerized,
  isFullscreen,
  prNumber,
  prState,
  prTitle,
  prUrl,
  projectName,
  workspaceStatus,
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
        {prNumber != null && prUrl != null && (
          <Tooltip>
            <TooltipTrigger>
              <a
                className={cn(
                  'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-xs transition-colors hover:bg-accent',
                  getPrStateClasses(prState)
                )}
                href={prUrl}
                rel="noopener"
                target="_blank"
              >
                <PrStateIcon className="size-3" prState={prState} />
                <span>#{prNumber}</span>
                <span>{getPrStateLabel(prState)}</span>
              </a>
            </TooltipTrigger>
            <TooltipContent>{prTitle ?? `PR #${prNumber}`}</TooltipContent>
          </Tooltip>
        )}
        {workspaceStatus && (
          <Badge
            className={cn(
              'shrink-0 border text-[10px] leading-none',
              getStatusClasses(workspaceStatus)
            )}
            variant="outline"
          >
            <StatusDot status={workspaceStatus} />
            {workspaceStatus}
          </Badge>
        )}
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
