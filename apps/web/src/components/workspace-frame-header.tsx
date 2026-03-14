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

import {
  ClipboardCheck,
  FileCode2,
  Minus,
  Plus,
  Server,
  Terminal,
  X,
} from 'lucide-react'
import { Suspense } from 'react'
import { GitHubPrStatusBadge } from '@/components/github-pr-status-badge'
import { useUnresolvedFindingsCount } from '@/components/review-findings-count'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { WorkspaceSyncStatus } from '@/components/workspace-sync-status'
import { cn } from '@/lib/utils'
import type { PanelActions } from '@/panels/panel-context'

interface WorkspaceFrameHeaderProps {
  /** Panel layout actions (split, close, toggleDiff, etc.). */
  readonly actions: PanelActions | null
  /** The active pane ID, or null if no pane is active. */
  readonly activePaneId: string | null
  /** Aggregate agent status for the workspace (null, active, or waiting_for_input). */
  readonly agentStatus?: 'active' | 'waiting_for_input' | null | undefined
  /** Number of local commits ahead of upstream. */
  readonly aheadCount: number | null
  /** Number of upstream commits not yet pulled locally. */
  readonly behindCount: number | null
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
  /** Whether the review pane is currently open for the active workspace. */
  readonly reviewIsOpen?: boolean | undefined
  /** The workspace ID, used for the close-workspace action. */
  readonly workspaceId: string | undefined
}

/**
 * Icon-only review toggle button (default state, no findings count).
 */
function ReviewIconButton({
  disabled,
  onClick,
  reviewIsOpen,
}: {
  readonly disabled: boolean
  readonly onClick: () => void
  readonly reviewIsOpen: boolean
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={reviewIsOpen ? 'Close review pane' : 'Open review pane'}
            className={reviewIsOpen ? 'bg-accent' : ''}
            disabled={disabled}
            onClick={onClick}
            size="icon-sm"
            variant="ghost"
          />
        }
      >
        <ClipboardCheck className="size-3.5" />
      </TooltipTrigger>
      <TooltipContent>
        {reviewIsOpen ? 'Close review pane' : 'Open review pane'}
        <KbdGroup>
          <Kbd>^</Kbd>
          <Kbd>B</Kbd>
          <Kbd>R</Kbd>
        </KbdGroup>
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * Self-fetching review button that shows the count of unresolved findings.
 * Renders a full "Review (N)" button when unresolved findings exist,
 * otherwise falls back to the icon-only button. Must be in a Suspense boundary.
 */
function ReviewButtonWithCount({
  disabled,
  onClick,
  reviewIsOpen,
  workspaceId,
}: {
  readonly disabled: boolean
  readonly onClick: () => void
  readonly reviewIsOpen: boolean
  readonly workspaceId: string
}) {
  const count = useUnresolvedFindingsCount(workspaceId)

  if (count === 0) {
    return (
      <ReviewIconButton
        disabled={disabled}
        onClick={onClick}
        reviewIsOpen={reviewIsOpen}
      />
    )
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={`Open review pane — ${count} unresolved`}
            className={cn(
              'h-6 gap-1 px-1.5 text-xs',
              reviewIsOpen
                ? 'bg-accent'
                : 'border-orange-500/30 bg-orange-500/10 text-orange-600 hover:bg-orange-500/20 dark:bg-orange-500/20 dark:text-orange-400 dark:hover:bg-orange-500/30'
            )}
            disabled={disabled}
            onClick={onClick}
            size="sm"
            variant={reviewIsOpen ? 'ghost' : 'outline'}
          />
        }
      >
        <ClipboardCheck className="size-3.5" />
        {count}
      </TooltipTrigger>
      <TooltipContent>
        {count} unresolved finding{count === 1 ? '' : 's'}
        <KbdGroup>
          <Kbd>^</Kbd>
          <Kbd>B</Kbd>
          <Kbd>R</Kbd>
        </KbdGroup>
      </TooltipContent>
    </Tooltip>
  )
}

function WorkspaceFrameHeader({
  activePaneId,
  actions,
  agentStatus,
  aheadCount,
  branchName,
  behindCount,
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
  reviewIsOpen = false,
  workspaceId,
}: WorkspaceFrameHeaderProps) {
  const hasActivePane = !!activePaneId
  const needsAttention = agentStatus === 'waiting_for_input'

  /** Shift focus to this workspace's pane before performing a panel action. */
  const withFocus = (fn: (paneId: string) => void) => () => {
    if (!activePaneId) {
      return
    }
    actions?.setActivePaneId(activePaneId)
    fn(activePaneId)
  }

  const reviewButtonOnClick = withFocus((paneId) =>
    actions?.toggleReviewPane(paneId)
  )

  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: Conditional onClick when minimized as fallback for padding gaps; the inner button handles keyboard a11y.
    // biome-ignore lint/a11y/useKeyWithClickEvents: The inner button handles keyboard events; this div onClick is only a mouse fallback for padding gaps.
    // biome-ignore lint/a11y/noStaticElementInteractions: Conditionally interactive div — only has onClick when minimized.
    <div
      className={cn(
        'flex h-8 shrink-0 items-center justify-between border-b px-2',
        needsAttention && 'border-b-amber-400/50 bg-amber-400/5',
        isMinimized && 'cursor-pointer'
      )}
      data-testid="workspace-frame-header"
      onClick={
        isMinimized
          ? () => {
              onHeaderClick?.()
            }
          : undefined
      }
      ref={dragHandleRef}
    >
      <div className="flex min-w-0 items-center gap-2">
        <button
          className={cn(
            'flex min-w-0 items-center gap-2',
            isMinimized
              ? 'flex-1 cursor-pointer'
              : 'cursor-grab active:cursor-grabbing'
          )}
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
        {workspaceId ? (
          <WorkspaceSyncStatus
            aheadCount={aheadCount}
            behindCount={behindCount}
            size="header"
            workspaceId={workspaceId}
          />
        ) : null}
        {needsAttention && (
          <Badge
            className="shrink-0 animate-pulse border border-amber-400/30 bg-amber-400/10 text-[10px] text-amber-400 leading-none"
            variant="outline"
          >
            needs input
          </Badge>
        )}
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
                <TooltipContent>
                  Toggle dev server terminal
                  <KbdGroup>
                    <Kbd>^</Kbd>
                    <Kbd>B</Kbd>
                    <Kbd>S</Kbd>
                  </KbdGroup>
                </TooltipContent>
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
                <KbdGroup>
                  <Kbd>^</Kbd>
                  <Kbd>B</Kbd>
                  <Kbd>D</Kbd>
                </KbdGroup>
              </TooltipContent>
            </Tooltip>
            {workspaceId && prNumber != null ? (
              <Suspense
                fallback={
                  <ReviewIconButton
                    disabled={!hasActivePane}
                    onClick={reviewButtonOnClick}
                    reviewIsOpen={reviewIsOpen}
                  />
                }
              >
                <ReviewButtonWithCount
                  disabled={!hasActivePane}
                  onClick={reviewButtonOnClick}
                  reviewIsOpen={reviewIsOpen}
                  workspaceId={workspaceId}
                />
              </Suspense>
            ) : (
              <ReviewIconButton
                disabled={!hasActivePane}
                onClick={reviewButtonOnClick}
                reviewIsOpen={reviewIsOpen}
              />
            )}
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
