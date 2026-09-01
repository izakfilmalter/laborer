/**
 * Presentational header bar for a single workspace frame.
 *
 * Shows project / branch name, workspace-level action buttons (diff toggle,
 * pane toggles), and a close-workspace button that kills all terminals
 * for this workspace.
 *
 * The data-fetching wrapper lives in routes/index.tsx and queries
 * shared collections for project/task data and the local preference collection
 * for layout data.
 */

import { isRootWorkspaceId } from '@laborer/shared/root-workspace'
import type {
  PullRequestCheckRun,
  PullRequestReviewDecision,
} from '@laborer/shared/rpc'
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from '@laborer/ui/components/avatar'
import { Button } from '@laborer/ui/components/button'
import { DialogTrigger } from '@laborer/ui/components/dialog'
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
  GitBranchPlus,
  Globe,
  MessagesSquare,
  Minus,
  Plus,
  Terminal,
  X,
} from 'lucide-react'
import { useCallback } from 'react'
import { AggregateAgentStatusBadge } from '@/components/agent-status-badge'
import { CreateWorkspaceForm } from '@/components/create-workspace-form'
import { EditTaskCardButton } from '@/components/edit-task-card-button'
import { GitActionsControl } from '@/components/git-actions-control'
import { GitHubConversationHoverCard } from '@/components/github-conversation-hover-card'
import { GitHubMergeConflictMark } from '@/components/github-merge-conflict-mark'
import { GitHubPrStatusBadge } from '@/components/github-pr-status-badge'
import { ProjectIcon } from '@/components/project-icon'
import { TaskIdentifier } from '@/components/task-identifier'
import { WorkspaceSyncStatus } from '@/components/workspace-sync-status'
import type { AgentDisplayStatus } from '@/lib/agent-attention-projection'
import {
  getAgentStatusSurface,
  showsWorkspaceAgentStatus,
} from '@/lib/agent-status-presentation'
import { workspaceHeaderAccentClassName } from '@/lib/project-accent'
import type { PanelActions } from '@/panels/panel-context'

interface WorkspaceFrameHeaderProps {
  /** Panel layout actions (split, close, toggleDiff, etc.). */
  readonly actions: PanelActions | null
  /** The active pane ID, or null if no pane is active. */
  readonly activePaneId: string | null
  /** Aggregate semantic Agent status for the workspace. */
  readonly agentStatus?: AgentDisplayStatus | null | undefined
  /**
   * The GitHub login this workspace's work belongs to, when it is somebody
   * else's. Null for the reviewer's own or unattributed work.
   */
  readonly authorLogin?: string | null | undefined
  /** The branch name for the workspace (shown in the header). */
  readonly branchName: string | undefined
  /** Whether the right panel's Browser surface is active for the workspace. */
  readonly browserIsOpen?: boolean | undefined
  /** Whether the PR comments panel is currently open for the active pane. */
  readonly commentsIsOpen?: boolean | undefined
  /** Whether the diff viewer is currently open for the active pane. */
  readonly diffIsOpen: boolean
  /** Ref attached to the header element so it can serve as a drag handle. */
  readonly dragHandleRef?:
    | { readonly current: HTMLDivElement | null }
    | undefined
  /** Whether the right panel's Files surface is active for the workspace. */
  readonly filesIsOpen?: boolean | undefined
  /** Whether this workspace frame is the currently active/focused one. */
  readonly isActiveFrame?: boolean | undefined
  /** Whether the workspace frame is minimized (collapsed to header only). */
  readonly isMinimized?: boolean | undefined
  /** Called when the header area is clicked (focus pane or expand if minimized). */
  readonly onHeaderClick?: (() => void) | undefined
  /** Called when the minimize/expand button is clicked. */
  readonly onMinimize?: (() => void) | undefined
  /** How many reviewers' latest review on the pull request is an approval. */
  readonly prApprovals?: number | null | undefined
  /** Base branch the pull request targets, named in the conflict label. */
  readonly prBaseBranch?: string | null | undefined
  /** Rollup of the pull request's CI checks. */
  readonly prCheckStatus?: 'pending' | 'success' | 'failure' | null | undefined
  /** Individual check runs behind the rollup, for the hover summary. */
  readonly prChecks?: readonly PullRequestCheckRun[] | null | undefined
  /** Whether the pull request is still a draft, asking nobody for review. */
  readonly prIsDraft?: boolean | undefined
  /** Whether the pull request merges cleanly into its base branch. */
  readonly prMergeStatus?:
    | 'clean'
    | 'conflicting'
    | 'unknown'
    | null
    | undefined
  /** PR number, if the workspace has an associated pull request. */
  readonly prNumber: number | null
  /** The project's accent token, carried into this bar to identify it. */
  readonly projectColor?: string | null | undefined
  /** The project's favicon as a data URL, when the repository ships one. */
  readonly projectIconDataUrl?: string | null | undefined
  /** The project ID used to associate the task identifier with its project. */
  readonly projectId: string | undefined
  /** The project name for the workspace (shown in the header). */
  readonly projectName: string | undefined
  /** The project prefix used in the task identifier. */
  readonly projectShortName: string | null
  /** GitHub's rolled-up verdict on the pull request's reviews. */
  readonly prReviewDecision?: PullRequestReviewDecision | null | undefined
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
  /** The workspace ID, used for the close-workspace action. */
  readonly workspaceId: string | undefined
  /** Visible sidebar path for the workspace, excluding the project name. */
  readonly workspacePath: readonly string[]
}

/**
 * Project, then whose work this is, then the branch path.
 *
 * The sidebar files another author's branch under their login, so a frame
 * pulled out of that group would otherwise lose the one fact that explains why
 * it is here. Naming the author before the branch keeps the title reading as
 * an address — project, person, branch — and stays absent for the reviewer's
 * own work, where "mine" is the default and needs no label.
 */
function WorkspaceFrameTitle({
  authorLogin,
  branchName,
  projectName,
  workspacePath,
}: {
  readonly authorLogin: string | null
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
      {authorLogin === null ? null : (
        <span
          className="inline-flex items-center gap-1"
          data-testid={`workspace-frame-author-${authorLogin}`}
        >
          <span className="mx-1">/</span>
          <Avatar className="size-3.5">
            <AvatarImage
              alt=""
              src={`https://github.com/${authorLogin}.png?s=32`}
            />
            <AvatarFallback className="text-[7px]">
              {authorLogin.slice(0, 1).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <span>{authorLogin}</span>
        </span>
      )}
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
 * Icon-only toggle for the right panel's Files surface.
 */
function FilesToggleButton({
  disabled,
  onClick,
  filesIsOpen,
}: {
  readonly disabled: boolean
  readonly onClick: () => void
  readonly filesIsOpen: boolean
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={
              filesIsOpen ? 'Close file explorer' : 'Open file explorer'
            }
            aria-pressed={filesIsOpen}
            className={filesIsOpen ? 'bg-accent text-foreground' : ''}
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
        {filesIsOpen ? 'Close file explorer' : 'Open file explorer'}
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
 * Icon-only toggle for the right panel's Browser surface.
 *
 * The browser is a right-panel surface like files, diff, and the pull
 * request, so the header names it with an icon of its own rather than
 * leaving it reachable only from the panel's own tab strip.
 */
function BrowserToggleButton({
  browserIsOpen,
  disabled,
  onClick,
}: {
  readonly browserIsOpen: boolean
  readonly disabled: boolean
  readonly onClick: () => void
}) {
  const label = browserIsOpen ? 'Close browser' : 'Open browser'
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            aria-pressed={browserIsOpen}
            className={browserIsOpen ? 'bg-accent text-foreground' : ''}
            disabled={disabled}
            onClick={onClick}
            size="icon-sm"
            variant="ghost"
          />
        }
      >
        <Globe className="size-3.5" />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/**
 * Icon-only pull request comments toggle.
 *
 * Disabled without a pull request, because the conversation it opens does
 * not exist yet — the tooltip says so rather than letting the pane explain
 * it after the fact.
 *
 * Once a pull request exists the hover shows the conversation itself instead
 * of a tooltip naming the button, matching the PR status badge: the same
 * preview answers "anything new?" without opening the pane, and the label
 * still lives on the button for assistive technology.
 */
function CommentsToggleButton({
  commentsIsOpen,
  disabled,
  hasPullRequest,
  onClick,
  workspaceId,
}: {
  readonly commentsIsOpen: boolean
  readonly disabled: boolean
  readonly hasPullRequest: boolean
  readonly onClick: () => void
  readonly workspaceId: string | undefined
}) {
  const label = commentsIsOpen ? 'Close PR comments' : 'Open PR comments'
  const button = (
    <Button
      aria-label={label}
      aria-pressed={commentsIsOpen}
      className={commentsIsOpen ? 'bg-accent text-foreground' : ''}
      disabled={disabled || !hasPullRequest}
      onClick={onClick}
      size="icon-sm"
      variant="ghost"
    >
      <MessagesSquare className="size-3.5" />
    </Button>
  )

  if (hasPullRequest && workspaceId !== undefined) {
    return (
      <GitHubConversationHoverCard trigger={button} workspaceId={workspaceId} />
    )
  }

  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent>
        {hasPullRequest ? label : 'No pull request yet'}
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * Action buttons shown only while the frame is expanded: card actions
 * (sub-workspace, edit card), pane toggles, and close-workspace.
 */
function ExpandedFrameActions({
  actions,
  branchName,
  browserIsOpen,
  commentsIsOpen,
  diffIsOpen,
  hasActivePane,
  prNumber,
  projectId,
  projectName,
  taskBackedWorkspaceId,
  filesIsOpen,
  withFocus,
  workspaceId,
}: {
  readonly actions: PanelActions | null
  readonly branchName: string | undefined
  readonly browserIsOpen: boolean
  readonly commentsIsOpen: boolean
  readonly diffIsOpen: boolean
  readonly hasActivePane: boolean
  readonly prNumber: number | null
  readonly projectId: string | undefined
  readonly projectName: string | undefined
  readonly taskBackedWorkspaceId: string | null
  readonly filesIsOpen: boolean
  readonly withFocus: (fn: (paneId: string) => void) => () => void
  readonly workspaceId: string | undefined
}) {
  return (
    <>
      {/* The card's own actions, on the frame doing its work: branch off
          this workspace, and read or edit the card describing it. */}
      {taskBackedWorkspaceId && projectId && projectName && branchName ? (
        <>
          <CreateWorkspaceForm
            baseWorkspace={{ id: taskBackedWorkspaceId, branchName }}
            projectId={projectId}
            projectName={projectName}
            trigger={
              <Tooltip>
                <TooltipTrigger
                  render={
                    <DialogTrigger
                      render={
                        <Button
                          aria-label={`Create sub-workspace from ${branchName}`}
                          size="icon-sm"
                          variant="ghost"
                        />
                      }
                    />
                  }
                >
                  <GitBranchPlus className="size-3.5" />
                </TooltipTrigger>
                <TooltipContent>
                  Create sub-workspace from this branch
                </TooltipContent>
              </Tooltip>
            }
          />
          <EditTaskCardButton
            branchName={branchName}
            size="icon-sm"
            workspaceId={taskBackedWorkspaceId}
          />
        </>
      ) : null}
      <FilesToggleButton
        disabled={!hasActivePane}
        filesIsOpen={filesIsOpen}
        onClick={withFocus((paneId) => actions?.toggleFilesPane(paneId))}
      />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label={diffIsOpen ? 'Close diff viewer' : 'Open diff viewer'}
              aria-pressed={diffIsOpen}
              className={diffIsOpen ? 'bg-accent text-foreground' : ''}
              disabled={!hasActivePane}
              onClick={withFocus((paneId) => actions?.toggleDiffPane(paneId))}
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
      <BrowserToggleButton
        browserIsOpen={browserIsOpen}
        disabled={!(hasActivePane && actions?.toggleBrowserPane)}
        onClick={withFocus((paneId) => actions?.toggleBrowserPane?.(paneId))}
      />
      <CommentsToggleButton
        commentsIsOpen={commentsIsOpen}
        disabled={!hasActivePane}
        hasPullRequest={prNumber !== null && prNumber !== undefined}
        onClick={withFocus((paneId) => actions?.toggleCommentsPane?.(paneId))}
        workspaceId={workspaceId}
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
  )
}

/**
 * The branch's next git step, as the frame can offer it.
 *
 * Without a branch or a workspace there is nothing to commit or push, so the
 * control is absent rather than disabled. With a pull request it narrows to
 * the chevron and rides inside the PR pill; without one it is the whole
 * journey as a button of its own.
 */
function FrameGitActions({
  branchName,
  hasPullRequest,
  workspaceId,
}: {
  readonly branchName: string | undefined
  readonly hasPullRequest: boolean
  readonly workspaceId: string | undefined
}) {
  if (branchName === undefined || workspaceId === undefined) {
    return null
  }

  return (
    <GitActionsControl
      appearance={hasPullRequest ? 'segment' : 'standalone'}
      branchName={branchName}
      hasPullRequest={hasPullRequest}
      workspaceId={workspaceId}
    />
  )
}

/**
 * The frame's identity and drag handle: the project's mark, then the
 * project / author / branch address.
 *
 * The mark is the project's favicon or accent glyph, matching the sidebar
 * row the frame was opened from, so the same symbol answers "which project?"
 * in both places. A frame with no project behind it falls back to the generic
 * terminal glyph the title already reads as "Terminal".
 */
function FrameIdentityButton({
  authorLogin,
  branchName,
  isMinimized,
  onHeaderClick,
  projectColor,
  projectIconDataUrl,
  projectName,
  workspacePath,
}: {
  readonly authorLogin: string | null
  readonly branchName: string | undefined
  readonly isMinimized: boolean | undefined
  readonly onHeaderClick: (() => void) | undefined
  readonly projectColor: string | null
  readonly projectIconDataUrl: string | null
  readonly projectName: string | undefined
  readonly workspacePath: readonly string[]
}) {
  return (
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
        {projectName === undefined ? (
          <Terminal className="size-3.5" />
        ) : (
          <ProjectIcon
            project={{
              color: projectColor,
              iconDataUrl: projectIconDataUrl,
              name: projectName,
            }}
          />
        )}
      </div>
      <div className="min-w-0 truncate text-muted-foreground text-xs">
        <WorkspaceFrameTitle
          authorLogin={authorLogin}
          branchName={branchName}
          projectName={projectName}
          workspacePath={workspacePath}
        />
      </div>
    </button>
  )
}

function WorkspaceFrameHeader({
  activePaneId,
  actions,
  agentStatus,
  authorLogin = null,
  branchName,
  browserIsOpen = false,
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
  prApprovals = null,
  prIsDraft = false,
  prNumber,
  prReviewDecision = null,
  prState,
  prTitle,
  prUnresolvedThreads = null,
  prUrl,
  projectColor = null,
  projectIconDataUrl = null,
  projectId,
  projectName,
  projectShortName,
  taskNumber,
  filesIsOpen = false,
  workspaceId,
  workspacePath,
}: WorkspaceFrameHeaderProps) {
  const hasActivePane = !!activePaneId
  // Branching and card editing only mean something for a workspace backed by a
  // task; the root workspace is a checkout with no card behind it.
  const taskBackedWorkspaceId =
    workspaceId !== undefined && !isRootWorkspaceId(workspaceId)
      ? workspaceId
      : null
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
  const projectAccentClassName = workspaceHeaderAccentClassName({
    agentAccentClassName,
    isActiveFrame,
    projectColor,
    projectName,
  })
  // The frame carries the branch's next git step for the same reason the
  // sidebar card does: it is the surface naming the branch. Without a pull
  // request the whole journey is a button of its own here; with one, the
  // menu hangs off the end of the PR pill so the two read as one control.
  const hasPullRequest = prNumber !== null
  const gitActions = (
    <FrameGitActions
      branchName={branchName}
      hasPullRequest={hasPullRequest}
      workspaceId={workspaceId}
    />
  )

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

  /**
   * Open — not toggle — the conversation the PR badge is counting.
   *
   * The badge is a link to a fact, so it can only ever mean "show me". A
   * toggle here would close the pane out from under an operator who clicked
   * the count while already reading it; an already-open pane just takes the
   * focus instead.
   */
  const openCommentsPane = useCallback(() => {
    if (!activePaneId) {
      return
    }
    actions?.setActivePaneId(activePaneId)
    if (commentsIsOpen) {
      return
    }
    actions?.toggleCommentsPane?.(activePaneId)
  }, [actions, activePaneId, commentsIsOpen])

  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: Conditional onClick when minimized as fallback for padding gaps; the inner button handles keyboard a11y.
    // biome-ignore lint/a11y/useKeyWithClickEvents: The inner button handles keyboard events; this div onClick is only a mouse fallback for padding gaps.
    // biome-ignore lint/a11y/noStaticElementInteractions: Conditionally interactive div — only has onClick when minimized.
    <div
      className={cn(
        'flex h-8 shrink-0 items-center justify-between border-b px-2',
        isActiveFrame &&
          projectAccentClassName === '' &&
          !hasAgentAccent &&
          'border-b-2 border-b-primary',
        projectAccentClassName,
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
        <FrameIdentityButton
          authorLogin={authorLogin}
          branchName={branchName}
          isMinimized={isMinimized}
          onHeaderClick={onHeaderClick}
          projectColor={projectColor}
          projectIconDataUrl={projectIconDataUrl}
          projectName={projectName}
          workspacePath={workspacePath}
        />
        {projectId && taskNumber ? (
          <TaskIdentifier
            projectId={projectId}
            projectShortName={projectShortName}
            taskNumber={taskNumber}
          />
        ) : null}
        {/* The frame that owns the conversation pane is the one surface that
            can answer the badge's count in place, so here the count opens it
            rather than leaving for a browser tab. */}
        {hasPullRequest ? null : gitActions}
        <GitHubPrStatusBadge
          approvals={prApprovals}
          checkStatus={prCheckStatus}
          checks={prChecks}
          className="shrink-0"
          onOpenConversation={
            hasActivePane && actions?.toggleCommentsPane
              ? openCommentsPane
              : undefined
          }
          prIsDraft={prIsDraft}
          prNumber={prNumber}
          prState={prState}
          prTitle={prTitle}
          prUrl={prUrl}
          reviewDecision={prReviewDecision}
          trailing={hasPullRequest ? gitActions : null}
          unresolvedThreads={prUnresolvedThreads}
        />
        {workspaceId ? <WorkspaceSyncStatus workspaceId={workspaceId} /> : null}
        {/* Only a mark, closing out the GitHub group before the agent's own
            status has the last word. */}
        <GitHubMergeConflictMark
          baseBranch={prBaseBranch}
          mergeStatus={prMergeStatus}
          projectId={projectId}
          workspaceId={workspaceId}
        />
        {showsAgentStatus ? (
          <AggregateAgentStatusBadge
            className="shrink-0"
            status={agentStatus}
          />
        ) : null}
      </div>
      <div className="flex gap-0.5">
        {!isMinimized && (
          <ExpandedFrameActions
            actions={actions}
            branchName={branchName}
            browserIsOpen={browserIsOpen}
            commentsIsOpen={commentsIsOpen}
            diffIsOpen={diffIsOpen}
            filesIsOpen={filesIsOpen}
            hasActivePane={hasActivePane}
            prNumber={prNumber}
            projectId={projectId}
            projectName={projectName}
            taskBackedWorkspaceId={taskBackedWorkspaceId}
            withFocus={withFocus}
            workspaceId={workspaceId}
          />
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
