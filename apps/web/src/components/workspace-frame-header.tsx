/**
 * Presentational header bar for a single workspace frame.
 *
 * Shows project / branch name, workspace-level action buttons (diff toggle,
 * pane toggles), and a close-workspace button that kills all terminals
 * for this workspace.
 *
 * Per-pane actions (split, fullscreen, close pane) are rendered as an
 * overlay toolbar on each terminal pane instead.
 *
 * The data-fetching wrapper lives in routes/index.tsx and queries
 * shared collections for project/task data and the local preference collection
 * for layout data.
 *
 * @see components/terminal-overlay-toolbar.tsx — per-pane floating toolbar
 */

import type { PullRequestCheckRun } from '@laborer/shared/rpc'
import { Button } from '@laborer/ui/components/button'
import { Kbd, KbdGroup } from '@laborer/ui/components/kbd'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@laborer/ui/components/tooltip'
import { cn } from '@laborer/ui/lib/utils'
import {
  FileCode2,
  FolderTree,
  MessagesSquare,
  Minus,
  Plus,
  Terminal,
  X,
} from 'lucide-react'
import { useCallback } from 'react'
import { AggregateAgentStatusBadge } from '@/components/agent-status-badge'
import { GitHubMergeConflictMark } from '@/components/github-merge-conflict-mark'
import { GitHubPrStatusBadge } from '@/components/github-pr-status-badge'
import { TaskIdentifier } from '@/components/task-identifier'
import { WorkspaceSyncStatus } from '@/components/workspace-sync-status'
import type { AgentDisplayStatus } from '@/lib/agent-attention-projection'
import {
  getAgentStatusSurface,
  showsWorkspaceAgentStatus,
} from '@/lib/agent-status-presentation'
import type { PanelActions } from '@/panels/panel-context'

interface WorkspaceFrameHeaderProps {
  /** Panel layout actions (split, close, toggleDiff, etc.). */
  readonly actions: PanelActions | null
  /** The active pane ID, or null if no pane is active. */
  readonly activePaneId: string | null
  /** Aggregate semantic Agent status for the workspace. */
  readonly agentStatus?: AgentDisplayStatus | null | undefined
  /** The branch name for the workspace (shown in the header). */
  readonly branchName: string | undefined
  /** Whether the PR comments panel is currently open for the active pane. */
  readonly commentsIsOpen?: boolean | undefined
  /** Whether the diff viewer is currently open for the active pane. */
  readonly diffIsOpen: boolean
  /** Ref attached to the header element so it can serve as a drag handle. */
  readonly dragHandleRef?:
    | { readonly current: HTMLDivElement | null }
    | undefined
  /** Whether this workspace frame is the currently active/focused one. */
  readonly isActiveFrame?: boolean | undefined
  /** Whether the workspace frame is minimized (collapsed to header only). */
  readonly isMinimized?: boolean | undefined
  /** Called when the header area is clicked (focus pane or expand if minimized). */
  readonly onHeaderClick?: (() => void) | undefined
  /** Called when the minimize/expand button is clicked. */
  readonly onMinimize?: (() => void) | undefined
  /** Base branch the pull request targets, named in the conflict label. */
  readonly prBaseBranch?: string | null | undefined
  /** Rollup of the pull request's CI checks. */
  readonly prCheckStatus?: 'pending' | 'success' | 'failure' | null | undefined
  /** Individual check runs behind the rollup, for the hover summary. */
  readonly prChecks?: readonly PullRequestCheckRun[] | null | undefined
  /** Whether the pull request merges cleanly into its base branch. */
  readonly prMergeStatus?:
    | 'clean'
    | 'conflicting'
    | 'unknown'
    | null
    | undefined
  /** PR number, if the workspace has an associated pull request. */
  readonly prNumber: number | null
  /** The project ID used to associate the task identifier with its project. */
  readonly projectId: string | undefined
  /** The project name for the workspace (shown in the header). */
  readonly projectName: string | undefined
  /** The project prefix used in the task identifier. */
  readonly projectShortName: string | null
  /** PR state: 'OPEN', 'CLOSED', or 'MERGED'. */
  readonly prState: string | null
  /** PR title for tooltip. */
  readonly prTitle: string | null
  /** Review threads on the pull request that nobody has resolved yet. */
  readonly prUnresolvedThreads?: number | null | undefined
  /** PR URL for linking. */
  readonly prUrl: string | null
  /** Project-scoped task number, absent for the root workspace. */
  readonly taskNumber: number | null
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

/**
 * Icon-only pull request comments toggle.
 *
 * Disabled without a pull request, because the conversation it opens does
 * not exist yet — the tooltip says so rather than letting the pane explain
 * it after the fact.
 */
function CommentsToggleButton({
  commentsIsOpen,
  disabled,
  hasPullRequest,
  onClick,
}: {
  readonly commentsIsOpen: boolean
  readonly disabled: boolean
  readonly hasPullRequest: boolean
  readonly onClick: () => void
}) {
  const label = commentsIsOpen ? 'Close PR comments' : 'Open PR comments'

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            aria-pressed={commentsIsOpen}
            className={commentsIsOpen ? 'bg-accent text-foreground' : ''}
            disabled={disabled || !hasPullRequest}
            onClick={onClick}
            size="icon-sm"
            variant="ghost"
          />
        }
      >
        <MessagesSquare className="size-3.5" />
      </TooltipTrigger>
      <TooltipContent>
        {hasPullRequest ? label : 'No pull request yet'}
      </TooltipContent>
    </Tooltip>
  )
}

function WorkspaceFrameHeader({
  activePaneId,
  actions,
  agentStatus,
  branchName,
  commentsIsOpen = false,
  diffIsOpen,
  dragHandleRef,
  isActiveFrame = false,
  isMinimized,
  onHeaderClick,
  onMinimize,
  prBaseBranch = null,
  prCheckStatus = null,
  prChecks = null,
  prMergeStatus = null,
  prNumber,
  prState,
  prTitle,
  prUnresolvedThreads = null,
  prUrl,
  projectId,
  projectName,
  projectShortName,
  taskNumber,
  treeIsOpen = false,
  workspaceId,
  workspacePath,
}: WorkspaceFrameHeaderProps) {
  const hasActivePane = !!activePaneId
  // The header stays quiet for at-rest states: an idle or unknown agent has
  // nothing to say at workspace level, while working, done, and needs input
  // do. The card in the sidebar answers this with the same predicate.
  const showsAgentStatus = showsWorkspaceAgentStatus(agentStatus)
  // Attention and an unseen result outrank the active-frame accent; a working
  // tint is the quietest layer and yields to the frame the operator is
  // already looking at.
  const agentAccentClassName =
    agentStatus === 'working' && isActiveFrame
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
        {projectId && taskNumber ? (
          <TaskIdentifier
            projectId={projectId}
            projectShortName={projectShortName}
            taskNumber={taskNumber}
          />
        ) : null}
        <GitHubPrStatusBadge
          checkStatus={prCheckStatus}
          checks={prChecks}
          className="shrink-0"
          prNumber={prNumber}
          prState={prState}
          prTitle={prTitle}
          prUrl={prUrl}
          unresolvedThreads={prUnresolvedThreads}
        />
        {workspaceId ? <WorkspaceSyncStatus workspaceId={workspaceId} /> : null}
        {showsAgentStatus ? (
          <AggregateAgentStatusBadge
            className="shrink-0"
            status={agentStatus}
          />
        ) : null}
        {/* Last, and only a mark — the same place the card gives it. */}
        <GitHubMergeConflictMark
          baseBranch={prBaseBranch}
          mergeStatus={prMergeStatus}
          projectId={projectId}
          workspaceId={workspaceId}
        />
      </div>
      <div className="flex gap-0.5">
        {!isMinimized && (
          <>
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
            <CommentsToggleButton
              commentsIsOpen={commentsIsOpen}
              disabled={!hasActivePane}
              hasPullRequest={prNumber !== null && prNumber !== undefined}
              onClick={withFocus((paneId) =>
                actions?.toggleCommentsPane?.(paneId)
              )}
            />
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
