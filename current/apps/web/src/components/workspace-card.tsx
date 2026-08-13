/**
 * The workspace card — one unit of work, wherever it is shown.
 *
 * The sidebar lists these under their project; the kanban board renders the
 * same component for any card whose work already has a workspace, so a piece
 * of work looks and behaves the same on both surfaces: its branch, its status,
 * its terminals, and the Agent / New controls that start work in it.
 *
 * Surfaces differ only in what they add. `actions` and `badges` are appended
 * to the card's own control cluster and chip row, so the board can hang its
 * card-level affordances (edit, cancel, provenance) off the same card without
 * the sidebar growing them.
 */

import { useAtomSet } from '@effect/atom-react/Hooks'
import type { WorkspaceOrigin } from '@laborer/shared/types'
import { GitBranch, GitBranchPlus, Trash2 } from 'lucide-react'
import {
  type FC,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { LaborerClient } from '@/atoms/laborer-client'
import {
  clearWorkspaceDestroyOverlayAtom,
  installWorkspaceDestroyOverlayAtom,
} from '@/atoms/shared-state'
import { AggregateAgentStatusBadge } from '@/components/agent-status-badge'
import { CardShell } from '@/components/card-shell'
import { CopyButton } from '@/components/copy-button'
import { CreateWorkspaceForm } from '@/components/create-workspace-form'
import { GitHubPrStatusBadge } from '@/components/github-pr-status-badge'
import { LifecyclePhase } from '@/components/lifecycle-phase-context'
import { TerminalList, TerminalSpawnControls } from '@/components/terminal-list'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DialogTrigger } from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'
import { Spinner } from '@/components/ui/spinner'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { WorkspaceSyncStatus } from '@/components/workspace-sync-status'
import type { PendingWorkspaceCreationChangeHandler } from '@/hooks/use-create-workspace'
import {
  type ActiveTerminal,
  useDestroyWorkspaceChecks,
} from '@/hooks/use-destroy-workspace-checks'
import { useWhenPhase } from '@/hooks/use-when-phase'
import type { AgentDisplayStatus } from '@/lib/agent-attention-projection'
import {
  getAgentStatusSurface,
  showsWorkspaceAgentStatus,
} from '@/lib/agent-status-presentation'
import { isExactEnter, isMetaEnter } from '@/lib/dialog-keys'
import { toast } from '@/lib/toast'
import { cn, extractErrorMessage } from '@/lib/utils'
import { getWorktreeSetupLabel } from '@/lib/worktree-setup-labels'
import { useActiveWorkspaceId, usePanelActions } from '@/panels/panel-context'

const destroyWorkspaceMutation = LaborerClient.mutation('workspace.destroy')

const DIALOG_TEXT_CLASS = 'text-balance text-muted-foreground text-xs/relaxed'

type WorkspaceStatus =
  | 'creating'
  | 'running'
  | 'paused'
  | 'stopped'
  | 'errored'
  | 'destroyed'

/**
 * Returns Tailwind classes for a status badge based on workspace status.
 */
function getStatusClasses(status: string): string {
  switch (status as WorkspaceStatus) {
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

/**
 * Returns a small colored status indicator for the workspace.
 * Uses a spinning loader for "creating" status to emphasize the
 * in-progress operation, and a colored dot for all other statuses.
 */
function StatusDot({ status }: { readonly status: string }) {
  if (status === 'creating') {
    return <Spinner className="size-3 text-warning" />
  }

  const dotColor = (() => {
    switch (status as WorkspaceStatus) {
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

interface CopyableValueProps {
  /** Label for the main copy button tooltip (e.g. "Copy branch name"). */
  readonly copyLabel: string
  /** Extra values that get their own copy button on hover. */
  readonly extraCopyValues?: ReadonlyArray<{
    readonly value: string
    readonly label: string
  }>
  readonly value: string
}

const CopyableValue: FC<CopyableValueProps> = (props) => {
  const { value, copyLabel, extraCopyValues } = props

  return (
    <span className="group/copyable flex w-full min-w-0 items-start justify-between gap-1">
      <span className="line-clamp-2 min-w-0 break-all">{value}</span>
      <span className="-mr-8 flex shrink-0 items-center gap-0.5 opacity-0 transition-all duration-200 group-hover/copyable:mr-0 group-hover/copyable:opacity-100">
        {extraCopyValues?.map((extra) => (
          <CopyButton
            aria-label={extra.label}
            key={extra.label}
            title={extra.label}
            value={extra.value}
          />
        ))}
        <CopyButton title={copyLabel} value={value} />
      </span>
    </span>
  )
}

/**
 * Destroy dialog description text. Extracted to avoid nested ternaries.
 *
 * Shows a checking spinner while dirty/terminal state is loading, then
 * displays any uncommitted files and active terminal sessions that will
 * be lost. When there are no warnings, shows a generic confirmation.
 */
function DestroyDialogBody({
  activeTerminals,
  branchName,
  dirtyFiles,
  isCheckingDirtyFiles,
  isCheckingTerminals,
}: {
  readonly activeTerminals: readonly ActiveTerminal[]
  readonly branchName: string
  readonly dirtyFiles: readonly string[]
  readonly isCheckingDirtyFiles: boolean
  readonly isCheckingTerminals: boolean
}) {
  const isChecking = isCheckingDirtyFiles || isCheckingTerminals
  const hasWarnings = dirtyFiles.length > 0 || activeTerminals.length > 0
  const warningsSummary = [
    dirtyFiles.length > 0 ? ' uncommitted changes' : null,
    activeTerminals.length > 0
      ? ` ${activeTerminals.length} active terminal${activeTerminals.length > 1 ? 's' : ''}`
      : null,
  ].filter((value) => value != null)
  let additionalChecksLabel: string | null = null

  if (isCheckingDirtyFiles && isCheckingTerminals) {
    additionalChecksLabel =
      'Checking for additional uncommitted changes and running terminals...'
  } else if (isCheckingDirtyFiles) {
    additionalChecksLabel = 'Checking for additional uncommitted changes...'
  } else if (isCheckingTerminals) {
    additionalChecksLabel = 'Checking for additional running terminals...'
  }

  if (isChecking && !hasWarnings) {
    return (
      <div className="flex flex-col items-center gap-2 text-center text-muted-foreground text-xs/relaxed">
        <span className="flex flex-col items-center gap-2">
          <Spinner className="size-3" />
          <span>
            Checking workspace{' '}
            <strong className="font-mono text-foreground">{branchName}</strong>{' '}
            for uncommitted changes...
          </span>
        </span>
      </div>
    )
  }

  if (hasWarnings) {
    return (
      <>
        <p className={DIALOG_TEXT_CLASS}>
          Workspace{' '}
          <strong className="font-mono text-foreground">{branchName}</strong>{' '}
          has {warningsSummary.join(' and')} that will be lost. Are you sure you
          want to force destroy it?
        </p>
        {additionalChecksLabel && (
          <p className="flex items-center gap-2 text-muted-foreground text-xs">
            <Spinner className="size-3" />
            {additionalChecksLabel}
          </p>
        )}
        {dirtyFiles.length > 0 && (
          <ul className="max-h-40 list-none overflow-y-auto rounded-md border bg-muted/50 p-2 font-mono text-xs">
            {dirtyFiles.map((file) => (
              <li className="break-all py-0.5 text-muted-foreground" key={file}>
                {file}
              </li>
            ))}
          </ul>
        )}
        {activeTerminals.length > 0 && (
          <ul className="max-h-40 list-none overflow-y-auto rounded-md border bg-muted/50 p-2 font-mono text-xs">
            {activeTerminals.map((terminal) => (
              <li
                className="break-all py-0.5 text-muted-foreground"
                key={terminal.id}
              >
                {terminal.label}
              </li>
            ))}
          </ul>
        )}
      </>
    )
  }

  return (
    <p className={DIALOG_TEXT_CLASS}>
      This will permanently destroy workspace{' '}
      <strong className="font-mono text-foreground">{branchName}</strong>. All
      running processes (terminals, dev servers, agents) will be killed, the git
      worktree will be removed. This action cannot be undone.
    </p>
  )
}

function findVisibleWorkspaceFrameElement(
  workspaceId: string
): HTMLElement | null {
  if (typeof document === 'undefined') {
    return null
  }

  const frames = document.querySelectorAll<HTMLElement>(
    '[data-testid="workspace-frame"]'
  )

  for (const frame of frames) {
    if (frame.dataset.workspaceId !== workspaceId) {
      continue
    }

    if (frame.getClientRects().length === 0) {
      continue
    }

    return frame
  }

  return null
}

function InlineDestroyWorkspaceDialog({
  activeTerminals,
  branchName,
  dirtyFiles,
  hasWarnings,
  isCheckingDirtyFiles,
  isCheckingDestroyState,
  isCheckingTerminals,
  onCancel,
  onConfirm,
}: {
  readonly activeTerminals: readonly ActiveTerminal[]
  readonly branchName: string
  readonly dirtyFiles: readonly string[]
  readonly hasWarnings: boolean
  readonly isCheckingDirtyFiles: boolean
  readonly isCheckingDestroyState: boolean
  readonly isCheckingTerminals: boolean
  readonly onCancel: () => void
  readonly onConfirm: () => void
}) {
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onCancel()
        return
      }

      if (isExactEnter(event.nativeEvent)) {
        event.preventDefault()
        event.stopPropagation()
        return
      }

      if (isMetaEnter(event.nativeEvent) && !isCheckingDestroyState) {
        event.preventDefault()
        event.stopPropagation()
        onConfirm()
      }
    },
    [isCheckingDestroyState, onCancel, onConfirm]
  )

  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: Dialog container needs keyboard event handling for Escape and Cmd+Enter shortcuts
    <div
      className="absolute inset-0 z-50 flex items-center justify-center"
      onKeyDown={handleKeyDown}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onCancel()
        }
      }}
      ref={dialogRef}
      role="alertdialog"
      tabIndex={-1}
    >
      <div className="absolute inset-0 bg-foreground/10 supports-backdrop-filter:backdrop-blur-xs" />
      <div className="relative z-10 grid w-full max-w-sm gap-4 bg-background p-4 ring-1 ring-foreground/10">
        <div className="grid gap-1.5 text-left">
          <h2 className="font-medium text-sm">
            {hasWarnings ? 'Unsaved work' : 'Destroy workspace?'}
          </h2>
          <DestroyDialogBody
            activeTerminals={activeTerminals}
            branchName={branchName}
            dirtyFiles={dirtyFiles}
            isCheckingDirtyFiles={isCheckingDirtyFiles}
            isCheckingTerminals={isCheckingTerminals}
          />
        </div>
        <div className="flex flex-row justify-end gap-2">
          <Button onClick={onCancel} variant="outline">
            Cancel <Kbd>Esc</Kbd>
          </Button>
          <Button
            disabled={isCheckingDestroyState}
            onClick={onConfirm}
            variant="destructive"
          >
            {hasWarnings ? 'Force Destroy' : 'Destroy'}
            <Kbd>⌘</Kbd>
            <Kbd>↵</Kbd>
          </Button>
        </div>
      </div>
    </div>
  )
}

interface WorkspaceCardProps {
  /** Surface-specific controls, appended to the card's own control cluster. */
  readonly actions?: ReactNode | undefined
  /** Accessible name for the title's activation button. */
  readonly activateLabel?: string | undefined
  /** Surface-specific chips, appended to the card's own chip row. */
  readonly badges?: ReactNode | undefined
  /**
   * Whether this workspace is the root workspace (main git checkout).
   * Root workspaces cannot be destroyed as they represent the original
   * repository clone.
   */
  readonly isRootWorkspace?: boolean | undefined
  /**
   * Runs when the card is activated. Omit it to leave the card inert — the
   * sidebar's card already sits beside the work it names.
   */
  readonly onActivate?: (() => void) | undefined
  /** Reports temporary state for sub-workspaces created from this item. */
  readonly onPendingCreationChange?:
    | PendingWorkspaceCreationChangeHandler
    | undefined
  /** The project name, used by the sub-workspace creation dialog. */
  readonly projectName: string
  /** Whether to show the sub-workspace creation action in the card header. */
  readonly showCreateSubWorkspaceAction?: boolean | undefined
  /**
   * Whether the card offers to destroy its workspace. The board leaves that
   * to the sidebar, where the workspace lives.
   */
  readonly showDestroyAction?: boolean | undefined
  /** Extra line under the branch — the board names the card's task there. */
  readonly subtitle?: ReactNode | undefined
  readonly workspace: WorkspaceCardWorkspace
}

/** The workspace fields the card reads. */
interface WorkspaceCardWorkspace {
  readonly aheadCount: number | null
  readonly behindCount: number | null
  readonly branchName: string
  readonly createdAt: string
  readonly errorMessage: string | null
  readonly id: string
  readonly origin: WorkspaceOrigin | string
  readonly prNumber: number | null
  readonly projectId: string
  readonly prState: string | null
  readonly prTitle: string | null
  readonly prUrl: string | null
  readonly status: string
  readonly taskSource: string | null
  readonly worktreePath: string
  readonly worktreeSetupStep: string | null
}

function DestroyWorkspaceButton({
  workspaceId,
  branchName,
}: {
  readonly workspaceId: string
  readonly branchName: string
}) {
  const isServerReady = useWhenPhase(LifecyclePhase.Ready)
  const [dialogOpen, setDialogOpen] = useState(false)
  const destroyWorkspace = useAtomSet(destroyWorkspaceMutation, {
    mode: 'promise',
  })
  const installDestroyOverlay = useAtomSet(installWorkspaceDestroyOverlayAtom)
  const clearDestroyOverlay = useAtomSet(clearWorkspaceDestroyOverlayAtom)
  const panelActions = usePanelActions()
  const {
    activeTerminals,
    dirtyFiles,
    isCheckingDirtyFiles,
    isCheckingTerminals,
    reset: resetDestroyChecks,
    startChecks,
  } = useDestroyWorkspaceChecks(workspaceId)

  const hasWarnings = dirtyFiles.length > 0 || activeTerminals.length > 0
  const isCheckingDestroyState = isCheckingDirtyFiles || isCheckingTerminals
  const visibleWorkspaceFrameElement = dialogOpen
    ? findVisibleWorkspaceFrameElement(workspaceId)
    : null

  const handleDialogOpen = useCallback(
    (open: boolean) => {
      setDialogOpen(open)
      if (!open) {
        resetDestroyChecks()
        return
      }

      startChecks()
    },
    [resetDestroyChecks, startChecks]
  )

  const handleDestroy = useCallback(
    (force?: boolean) => {
      // Close dialog immediately and run destruction in the background
      setDialogOpen(false)
      resetDestroyChecks()

      // Optimistic: the card leaves the sidebar and its panes close now.
      // The overlay settles when the authoritative row drops its worktree,
      // and is restored if the server rejects the destroy.
      installDestroyOverlay(workspaceId)
      // Use forceCloseWorkspace to bypass the running-process confirmation
      // gate — the user already confirmed destruction in this dialog which
      // warned about active terminals.
      panelActions?.forceCloseWorkspace(workspaceId)

      const toastId = toast.loading(`Destroying workspace "${branchName}"...`)

      destroyWorkspace({
        payload: { workspaceId, force },
      })
        .then(() => {
          toast.success(`Workspace "${branchName}" destroyed successfully`, {
            id: toastId,
          })
        })
        .catch((error: unknown) => {
          clearDestroyOverlay(workspaceId)
          const message = extractErrorMessage(error)
          toast.error(message, { id: toastId })
        })
    },
    [
      branchName,
      clearDestroyOverlay,
      destroyWorkspace,
      installDestroyOverlay,
      panelActions,
      resetDestroyChecks,
      workspaceId,
    ]
  )

  const handleConfirmDestroy = useCallback(() => {
    handleDestroy(hasWarnings ? true : undefined)
  }, [handleDestroy, hasWarnings])

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label={`Destroy workspace ${branchName}`}
              disabled={!isServerReady}
              onClick={() => handleDialogOpen(true)}
              size="icon-xs"
              title={isServerReady ? undefined : 'Connecting to server...'}
              variant="ghost"
            />
          }
        >
          <Trash2 className="size-3.5 text-muted-foreground" />
        </TooltipTrigger>
        <TooltipContent>Destroy workspace</TooltipContent>
      </Tooltip>
      {dialogOpen && visibleWorkspaceFrameElement
        ? createPortal(
            <InlineDestroyWorkspaceDialog
              activeTerminals={activeTerminals}
              branchName={branchName}
              dirtyFiles={dirtyFiles}
              hasWarnings={hasWarnings}
              isCheckingDestroyState={isCheckingDestroyState}
              isCheckingDirtyFiles={isCheckingDirtyFiles}
              isCheckingTerminals={isCheckingTerminals}
              onCancel={() => handleDialogOpen(false)}
              onConfirm={handleConfirmDestroy}
            />,
            visibleWorkspaceFrameElement
          )
        : null}
      <AlertDialog
        onOpenChange={handleDialogOpen}
        open={dialogOpen && visibleWorkspaceFrameElement === null}
      >
        <AlertDialogContent
          onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
            if (isExactEnter(event.nativeEvent)) {
              event.preventDefault()
              event.stopPropagation()
              return
            }
            if (isMetaEnter(event.nativeEvent) && !isCheckingDestroyState) {
              event.preventDefault()
              handleConfirmDestroy()
            }
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              {hasWarnings ? 'Unsaved work' : 'Destroy workspace?'}
            </AlertDialogTitle>
            <DestroyDialogBody
              activeTerminals={activeTerminals}
              branchName={branchName}
              dirtyFiles={dirtyFiles}
              isCheckingDirtyFiles={isCheckingDirtyFiles}
              isCheckingTerminals={isCheckingTerminals}
            />
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              Cancel <Kbd>Esc</Kbd>
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={isCheckingDestroyState}
              onClick={handleConfirmDestroy}
              variant="destructive"
            >
              {hasWarnings ? 'Force Destroy' : 'Destroy'}
              <Kbd>⌘</Kbd>
              <Kbd>↵</Kbd>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/**
 * Whether a workspace's lifecycle state has earned a chip.
 *
 * `running` is what a healthy workspace simply is, so chipping it spends a
 * slot on every card in the sidebar to say nothing — and buries the one
 * workspace that is broken in a column of identical green. The chip speaks
 * only when the state is worth reading: still being built, no longer
 * running, or errored.
 *
 * The agent status beside it asks the same question of its own vocabulary
 * (`showsWorkspaceAgentStatus`), so both halves of the status rail stay
 * quiet when there is nothing to report and a healthy card is just its
 * name and the two ways to work in it.
 */
function showsWorkspaceStatus(status: string): boolean {
  return status !== 'running'
}

/**
 * The workspace's lifecycle state as a chip. An errored workspace carries its
 * failure in a tooltip rather than on the chip, so one bad workspace cannot
 * push every sibling card out of shape.
 */
function WorkspaceStatusBadge({
  errorMessage,
  status,
}: {
  readonly errorMessage: string | null
  readonly status: string
}) {
  const badge = (
    <Badge
      className={cn('shrink-0 border', getStatusClasses(status))}
      variant="outline"
    >
      <StatusDot status={status} />
      {status}
    </Badge>
  )

  if (status !== 'errored' || errorMessage === null) {
    return badge
  }

  return (
    <Tooltip>
      <TooltipTrigger>{badge}</TooltipTrigger>
      <TooltipContent className="max-w-sm whitespace-pre-wrap font-mono text-xs">
        {errorMessage}
      </TooltipContent>
    </Tooltip>
  )
}

function WorkspaceCard({
  actions,
  activateLabel,
  badges,
  isRootWorkspace,
  onActivate,
  onPendingCreationChange,
  projectName,
  showCreateSubWorkspaceAction = true,
  showDestroyAction = true,
  subtitle,
  workspace,
}: WorkspaceCardProps) {
  const [workspaceAgentStatus, setWorkspaceAgentStatus] =
    useState<AgentDisplayStatus | null>(null)
  const activeWorkspaceId = useActiveWorkspaceId()
  const isActiveWorkspace = activeWorkspaceId === workspace.id

  const agentSurface = getAgentStatusSurface(workspaceAgentStatus)
  // Attention and in-flight work surface at card level; acknowledged idle and
  // unknown stay in the terminal rows that own them. The frame header answers
  // this with the same predicate, so a card and its header never disagree.
  const showsAgentStatus = showsWorkspaceAgentStatus(workspaceAgentStatus)
  // A root workspace has no lifecycle of its own to report, and a healthy one
  // has nothing worth reporting.
  const showsStatus = !isRootWorkspace && showsWorkspaceStatus(workspace.status)

  return (
    <CardShell
      actions={
        <>
          <GitHubPrStatusBadge
            prNumber={workspace.prNumber}
            prState={workspace.prState}
            prTitle={workspace.prTitle}
            prUrl={workspace.prUrl}
          />
          <WorkspaceSyncStatus
            aheadCount={workspace.aheadCount}
            behindCount={workspace.behindCount}
            workspaceId={workspace.id}
          />
          {!isRootWorkspace && showCreateSubWorkspaceAction && (
            <CreateWorkspaceForm
              baseWorkspace={{
                id: workspace.id,
                branchName: workspace.branchName,
              }}
              onPendingCreationChange={onPendingCreationChange}
              projectId={workspace.projectId}
              projectName={projectName}
              trigger={
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <DialogTrigger
                        render={
                          <Button
                            aria-label={`Create sub-workspace from ${workspace.branchName}`}
                            className="size-6"
                            size="icon-sm"
                            variant="ghost"
                          />
                        }
                      />
                    }
                  >
                    <GitBranchPlus className="size-3.5 text-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent>
                    Create sub-workspace from this branch
                  </TooltipContent>
                </Tooltip>
              }
            />
          )}
          {!isRootWorkspace && showDestroyAction && (
            <DestroyWorkspaceButton
              branchName={workspace.branchName}
              workspaceId={workspace.id}
            />
          )}
          {actions}
        </>
      }
      activateLabel={activateLabel}
      badgeActions={
        <TerminalSpawnControls
          projectId={workspace.projectId}
          workspaceId={workspace.id}
        />
      }
      // The card's two live states read side by side: what the workspace is
      // doing, then what its agents are doing. They answer the same question
      // at two depths, so splitting them across the card — one chip in the
      // control cluster, one in the chip row — made the operator assemble the
      // answer themselves.
      //
      badges={
        <>
          {showsStatus ? (
            <WorkspaceStatusBadge
              errorMessage={workspace.errorMessage}
              status={workspace.status}
            />
          ) : null}
          {showsAgentStatus ? (
            <AggregateAgentStatusBadge
              className="shrink-0"
              status={workspaceAgentStatus}
            />
          ) : null}
          {badges}
        </>
      }
      // Steady edges rather than a pulsing card: the whole card animating
      // made its text hard to read, so the motion now lives only in the
      // status badge's dot. A blocked agent glows, an unseen result does
      // not — the sidebar's loudest card should be the one to act on.
      className={agentSurface.cardClassName}
      data-agent-status={workspaceAgentStatus ?? undefined}
      data-testid={`workspace-card-${workspace.branchName}`}
      icon={
        <GitBranch className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      }
      onActivate={onActivate}
      // Two channels, no contest: the agent accent owns the card's edge, the
      // active workspace fills its surface. A card can be both the one you
      // are in and the one waiting on you, and it now says so.
      selected={isActiveWorkspace}
      subtitle={subtitle}
      title={
        <span className="block min-w-0 font-mono">
          <CopyableValue
            copyLabel="Copy branch name"
            extraCopyValues={[
              {
                value: workspace.worktreePath,
                label: 'Copy worktree path',
              },
            ]}
            value={workspace.branchName}
          />
        </span>
      }
    >
      {/* No divider and no heading: the rows below are the only body the card
          has, and a rule drawn across every card in the sidebar costs more
          than it separates. A workspace with nothing running renders nothing
          here at all. */}
      {workspace.worktreeSetupStep != null && (
        <div className="mb-1.5 flex items-center gap-1.5 text-warning text-xs">
          <Spinner className="size-3 text-warning" />
          {getWorktreeSetupLabel(workspace.worktreeSetupStep)}
        </div>
      )}
      <TerminalList
        onAgentStatusChange={setWorkspaceAgentStatus}
        workspaceId={workspace.id}
      />
    </CardShell>
  )
}

export { WorkspaceCard }
export type { WorkspaceCardWorkspace }
