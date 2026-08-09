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
  FileCode2,
  FolderTree,
  Minus,
  Plus,
  Server,
  Terminal,
  X,
} from 'lucide-react'
import { useCallback } from 'react'
import { AggregateAgentStatusBadge } from '@/components/agent-status-badge'
import { GitHubPrStatusBadge } from '@/components/github-pr-status-badge'
import { Button } from '@/components/ui/button'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { WorkspaceSyncStatus } from '@/components/workspace-sync-status'
import type { AgentDisplayStatus } from '@/lib/agent-attention-projection'
import { getAgentStatusSurface } from '@/lib/agent-status-presentation'
import { cn } from '@/lib/utils'
import type { PanelActions } from '@/panels/panel-context'

interface WorkspaceFrameHeaderProps {
  /** Panel layout actions (split, close, toggleDiff, etc.). */
  readonly actions: PanelActions | null
  /** The active pane ID, or null if no pane is active. */
  readonly activePaneId: string | null
  /** Aggregate semantic Agent status for the workspace. */
  readonly agentStatus?: AgentDisplayStatus | null | undefined
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
  /** Whether this workspace frame is the currently active/focused one. */
  readonly isActiveFrame?: boolean | undefined
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
  /** Whether the file tree pane is currently open for the active workspace. */
  readonly treeIsOpen?: boolean | undefined
  /** The workspace ID, used for the close-workspace action. */
  readonly workspaceId: string | undefined
  /** Visible sidebar path for the workspace, excluding the project name. */
  readonly workspacePath: readonly string[]
}

function WorkspaceFrameTitle({
  branchName,
  projectName,
  workspacePath,
}: {
  readonly branchName: string | undefined
  readonly projectName: string | undefined
  readonly workspacePath: readonly string[]
}) {
  if (!(projectName && branchName)) {
    return <span className="text-foreground">Terminal</span>
  }

  const pathSegments = workspacePath.length > 0 ? workspacePath : [branchName]

  return (
    <>
      <span className="text-foreground">{projectName}</span>
      {pathSegments.map((segment) => (
        <span key={segment}>
          <span className="mx-1">/</span>
          <span>{segment}</span>
        </span>
      ))}
    </>
  )
}

/**
 * Icon-only file tree toggle button.
 */
function TreeToggleButton({
  disabled,
  onClick,
  treeIsOpen,
}: {
  readonly disabled: boolean
  readonly onClick: () => void
  readonly treeIsOpen: boolean
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={treeIsOpen ? 'Close file tree' : 'Open file tree'}
            aria-pressed={treeIsOpen}
            className={treeIsOpen ? 'bg-accent text-foreground' : ''}
            disabled={disabled}
            onClick={onClick}
            size="icon-sm"
            variant="ghost"
          />
        }
      >
        <FolderTree className="size-3.5" />
      </TooltipTrigger>
      <TooltipContent>
        {treeIsOpen ? 'Close file tree' : 'Open file tree'}
        <KbdGroup>
          <Kbd>^</Kbd>
          <Kbd>B</Kbd>
          <Kbd>T</Kbd>
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
  isActiveFrame = false,
  isContainerized,
  isMinimized,
  onHeaderClick,
  onMinimize,
  prNumber,
  prState,
  prTitle,
  prUrl,
  projectName,
  treeIsOpen = false,
  workspaceId,
  workspacePath,
}: WorkspaceFrameHeaderProps) {
  const hasActivePane = !!activePaneId
  const needsAttention = agentStatus === 'needs_input'
  const isDone = agentStatus === 'done'
  const isWorking = agentStatus === 'working'
  // The header stays quiet for at-rest states: an idle or unknown agent has
  // nothing to say at workspace level, while working, done, and needs input
  // do.
  const showsAgentStatus = needsAttention || isDone || isWorking
  // Attention and an unseen result outrank the active-frame accent; a working
  // tint is the quietest layer and yields to the frame the operator is
  // already looking at.
  const agentAccentClassName =
    isWorking && isActiveFrame
      ? ''
      : getAgentStatusSurface(agentStatus).headerClassName
  // Exactly one bottom edge is ever coloured. When the agent has something
  // to say the accent is its own; otherwise the active frame keeps its
  // primary edge. Two competing borders on one 8px bar read as noise.
  const hasAgentAccent = agentAccentClassName !== ''

  /** Shift focus to this workspace's pane before performing a panel action. */
  const withFocus = useCallback(
    (fn: (paneId: string) => void) => () => {
      if (!activePaneId) {
        return
      }
      actions?.setActivePaneId(activePaneId)
      fn(activePaneId)
    },
    [activePaneId, actions]
  )

  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: Conditional onClick when minimized as fallback for padding gaps; the inner button handles keyboard a11y.
    // biome-ignore lint/a11y/useKeyWithClickEvents: The inner button handles keyboard events; this div onClick is only a mouse fallback for padding gaps.
    // biome-ignore lint/a11y/noStaticElementInteractions: Conditionally interactive div — only has onClick when minimized.
    <div
      className={cn(
        'flex h-8 shrink-0 items-center justify-between border-b px-2',
        isActiveFrame && !hasAgentAccent && 'border-b-2 border-b-primary',
        agentAccentClassName,
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
            <WorkspaceFrameTitle
              branchName={branchName}
              projectName={projectName}
              workspacePath={workspacePath}
            />
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
        {showsAgentStatus && agentStatus ? (
          <AggregateAgentStatusBadge
            className="shrink-0"
            status={agentStatus}
          />
        ) : null}
      </div>
      <div className="flex gap-0.5">
        {!isMinimized && (
          <>
            {isContainerized && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      aria-label="New dev server terminal"
                      disabled={!hasActivePane}
                      onClick={withFocus((paneId) => {
                        if (workspaceId) {
                          actions?.splitPane(paneId, 'horizontal', {
                            paneType: 'devServerTerminal',
                            workspaceId,
                          })
                        }
                      })}
                      size="icon-sm"
                      variant="ghost"
                    />
                  }
                >
                  <Server className="size-3.5" />
                </TooltipTrigger>
                <TooltipContent>
                  New dev server terminal
                  <KbdGroup>
                    <Kbd>^</Kbd>
                    <Kbd>B</Kbd>
                    <Kbd>S</Kbd>
                  </KbdGroup>
                </TooltipContent>
              </Tooltip>
            )}
            <TreeToggleButton
              disabled={!hasActivePane}
              onClick={withFocus((paneId) => actions?.toggleTreePane(paneId))}
              treeIsOpen={treeIsOpen}
            />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label={
                      diffIsOpen ? 'Close diff viewer' : 'Open diff viewer'
                    }
                    aria-pressed={diffIsOpen}
                    className={diffIsOpen ? 'bg-accent text-foreground' : ''}
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
