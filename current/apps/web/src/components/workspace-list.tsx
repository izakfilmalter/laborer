/**
 * Workspace list UI component.
 *
 * Displays a reactive list of workspaces for a given project from LiveStore.
 * Each workspace shows its branch name and status with color-coded
 * badges: creating=yellow, running=green, stopped=gray, errored=red,
 * destroyed=dim.
 * Workspaces with "creating" status show a spinner and progress description
 * to indicate that worktree creation and setup scripts
 * are in progress.
 * Updates reactively when workspace state changes.
 * Includes a destroy button with confirmation dialog per workspace.
 *
 * When no workspaces exist (all destroyed or none created), shows an empty
 * state with guidance text and a CTA button to create the first workspace.
 *
 * Accepts a required `projectId` prop to scope workspaces to a single project.
 *
 * @see Issue #41: Workspace list UI component
 * @see Issue #48: Destroy Workspace button + confirmation dialog
 * @see Issue #119: Empty state — no workspaces
 * @see Issue #121: Loading state — workspace creation
 * @see Issue #113: Project switcher — filter workspaces by active project
 * @see Issue #160: UI for detected workspaces
 */

import { useAtomSet } from '@effect-atom/atom-react/Hooks'
import { workspaces } from '@laborer/shared/schema'
import type { WorkspaceOrigin } from '@laborer/shared/types'
import {
  buildWorkspaceTree,
  type WorkspaceTreeNode,
} from '@laborer/shared/workspace-tree'
import { queryDb } from '@livestore/livestore'
import { ChevronRight, GitBranch, GitBranchPlus, Trash2 } from 'lucide-react'
import {
  type FC,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { LaborerClient } from '@/atoms/laborer-client'
import { AggregateAgentStatusBadge } from '@/components/agent-status-badge'
import { CardShell } from '@/components/card-shell'
import { CopyButton } from '@/components/copy-button'
import {
  CreateWorkspaceForm,
  type PendingWorkspaceCreation,
  type PendingWorkspaceCreationChangeHandler,
} from '@/components/create-workspace-form'
import { GitHubPrStatusBadge } from '@/components/github-pr-status-badge'
import { LifecyclePhase } from '@/components/lifecycle-phase-context'
import { TerminalList } from '@/components/terminal-list'
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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { DialogTrigger } from '@/components/ui/dialog'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { Kbd } from '@/components/ui/kbd'
import { Spinner } from '@/components/ui/spinner'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { WorkspaceSyncStatus } from '@/components/workspace-sync-status'
import {
  type ActiveTerminal,
  useDestroyWorkspaceChecks,
} from '@/hooks/use-destroy-workspace-checks'
import {
  type CollapseState,
  useWorkspaceGroupCollapseState,
} from '@/hooks/use-project-collapse-state'
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
import { useLaborerStore } from '@/livestore/store'
import { useActiveWorkspaceId, usePanelActions } from '@/panels/panel-context'

const allWorkspaces$ = queryDb(workspaces, { label: 'workspaceList' })

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

interface WorkspaceItemProps {
  /**
   * Whether this workspace is the root workspace (main git checkout).
   * Root workspaces cannot be destroyed as they represent the original
   * repository clone.
   */
  readonly isRootWorkspace?: boolean | undefined
  /** Reports temporary state for sub-workspaces created from this item. */
  readonly onPendingCreationChange?:
    | PendingWorkspaceCreationChangeHandler
    | undefined
  /** The project name, used by the sub-workspace creation dialog. */
  readonly projectName: string
  /** Whether to show the sub-workspace creation action in the card header. */
  readonly showCreateSubWorkspaceAction?: boolean | undefined
  readonly workspace: {
    readonly id: string
    readonly projectId: string
    readonly branchName: string
    readonly worktreePath: string
    readonly status: string
    readonly origin: WorkspaceOrigin | string
    readonly createdAt: string
    readonly taskSource: string | null
    readonly worktreeSetupStep: string | null
    readonly prNumber: number | null
    readonly prUrl: string | null
    readonly prTitle: string | null
    readonly prState: string | null
    readonly aheadCount: number | null
    readonly behindCount: number | null
    readonly errorMessage: string | null
  }
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

      const toastId = toast.loading(`Destroying workspace "${branchName}"...`)

      destroyWorkspace({
        payload: { workspaceId, force },
      })
        .then(() => {
          // Use forceCloseWorkspace to bypass the running-process confirmation
          // gate — the user already confirmed destruction in this dialog which
          // warned about active terminals.
          panelActions?.forceCloseWorkspace(workspaceId)
          toast.success(`Workspace "${branchName}" destroyed successfully`, {
            id: toastId,
          })
        })
        .catch((error: unknown) => {
          const message = extractErrorMessage(error)
          toast.error(message, { id: toastId })
        })
    },
    [
      branchName,
      destroyWorkspace,
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

function WorkspaceItem({
  workspace,
  isRootWorkspace,
  onPendingCreationChange,
  projectName,
  showCreateSubWorkspaceAction = true,
}: WorkspaceItemProps) {
  const [workspaceAgentStatus, setWorkspaceAgentStatus] =
    useState<AgentDisplayStatus | null>(null)
  const activeWorkspaceId = useActiveWorkspaceId()
  const isActiveWorkspace = activeWorkspaceId === workspace.id

  const agentSurface = getAgentStatusSurface(workspaceAgentStatus)
  // One card, one coloured edge. When an agent wants the operator the edge
  // is its own; otherwise the active workspace keeps its primary edge.
  // Emitting both leaves the winner to stylesheet ordering rather than to
  // intent.
  const hasAgentAccent = agentSurface.cardClassName !== ''
  // Attention and in-flight work surface at card level; acknowledged idle and
  // unknown stay in the terminal rows that own them. The frame header answers
  // this with the same predicate, so a card and its header never disagree.
  const showsAgentStatus = showsWorkspaceAgentStatus(workspaceAgentStatus)

  return (
    <CardShell
      actions={
        <>
          {showsAgentStatus ? (
            <AggregateAgentStatusBadge
              className="shrink-0"
              status={workspaceAgentStatus}
            />
          ) : null}
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
          {!isRootWorkspace && (
            <DestroyWorkspaceButton
              branchName={workspace.branchName}
              workspaceId={workspace.id}
            />
          )}
        </>
      }
      badges={
        isRootWorkspace ? null : (
          <WorkspaceStatusBadge
            errorMessage={workspace.errorMessage}
            status={workspace.status}
          />
        )
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
      // One card, one coloured edge — an agent asking for the operator wins
      // the edge over the merely active workspace.
      selected={isActiveWorkspace && !hasAgentAccent}
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
      {workspace.worktreeSetupStep != null && (
        <div className="mb-2 flex items-center gap-2 text-warning text-xs">
          <Spinner className="size-3 text-warning" />
          {getWorktreeSetupLabel(workspace.worktreeSetupStep)}
        </div>
      )}
      <div className="border-t pt-2">
        <TerminalList
          onAgentStatusChange={setWorkspaceAgentStatus}
          projectId={workspace.projectId}
          workspaceId={workspace.id}
        />
      </div>
    </CardShell>
  )
}

interface WorkspaceListProps {
  /** Reports pending sub-workspace creation changes to the project group. */
  readonly onPendingCreationChange?:
    | PendingWorkspaceCreationChangeHandler
    | undefined
  /** Temporary workspace items shown while planning or creation is in flight. */
  readonly pendingCreations?: readonly PendingWorkspaceCreation[] | undefined
  /** Only workspaces belonging to this project are shown. */
  readonly projectId: string
  /** The project name, used by the sub-workspace creation dialog. */
  readonly projectName: string
  /**
   * The repository path (project.repoPath) used to identify the root workspace.
   * The root workspace is the one where worktreePath matches this path.
   */
  readonly repoPath: string
}

/** Workspace row shape used by the sidebar tree. */
type WorkspaceTreeRow = WorkspaceItemProps['workspace'] & {
  readonly baseBranch: string | null
}

interface WorkspaceTreeGroupProps {
  readonly collapseState: CollapseState
  readonly node: WorkspaceTreeNode<WorkspaceTreeRow>
  readonly onPendingCreationChange?:
    | PendingWorkspaceCreationChangeHandler
    | undefined
  readonly projectName: string
  readonly repoPath: string
}

/**
 * Renders one node of the workspace tree. Childless workspaces render as a
 * plain card. A workspace with sub-workspaces gets a thin, collapsible,
 * branch-named group header wrapping its own card plus its children —
 * recursively, so stacks can nest arbitrarily deep.
 *
 * Lineage is derived from branch names, not stored parent IDs
 * (docs/adr/0001-branch-keyed-workspace-lineage.md): destroying a parent
 * simply dissolves its group, and recreating a workspace on the same branch
 * re-adopts its children.
 */
function WorkspaceTreeGroup({
  node,
  collapseState,
  onPendingCreationChange,
  projectName,
  repoPath,
}: WorkspaceTreeGroupProps) {
  const { workspace, children } = node

  const card = (
    <WorkspaceItem
      isRootWorkspace={workspace.worktreePath === repoPath}
      onPendingCreationChange={onPendingCreationChange}
      projectName={projectName}
      showCreateSubWorkspaceAction={children.length === 0}
      workspace={workspace}
    />
  )

  if (children.length === 0) {
    return card
  }

  // Keyed by branch so collapse state survives destroy/recreate cycles.
  const groupKey = `${workspace.projectId}:${workspace.branchName}`
  const expanded = collapseState.isExpanded(groupKey)

  return (
    <Collapsible open={expanded}>
      <div className="flex items-center gap-1">
        <CollapsibleTrigger
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-0.5 text-left font-medium text-muted-foreground text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
          data-testid={`workspace-group-${workspace.branchName}`}
          onClick={() => collapseState.toggle(groupKey)}
        >
          <ChevronRight
            className={cn(
              'size-3 shrink-0 transition-transform duration-200',
              expanded && 'rotate-90'
            )}
          />
          <GitBranch className="size-3 shrink-0" />
          <span className="min-w-0 truncate font-mono">
            {workspace.branchName}
          </span>
          <span className="ml-auto shrink-0 tabular-nums">
            {children.length}
          </span>
        </CollapsibleTrigger>
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
      </div>
      <CollapsibleContent>
        <div className="mt-1 ml-1.5 grid gap-2 border-l pl-1.5">
          {card}
          {children.map((child) => (
            <WorkspaceTreeGroup
              collapseState={collapseState}
              key={child.workspace.id}
              node={child}
              onPendingCreationChange={onPendingCreationChange}
              projectName={projectName}
              repoPath={repoPath}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function PendingWorkspaceItem({
  creation,
}: {
  readonly creation: PendingWorkspaceCreation
}) {
  const isAnalyzing = creation.phase === 'analyzing'
  const branchLabel =
    creation.branchName ?? (isAnalyzing ? 'Slack workspace' : 'New workspace')
  const phaseLabel = isAnalyzing ? 'Reading Slack thread' : 'Creating workspace'

  return (
    <CardShell
      actions={
        <Badge
          className="shrink-0 border border-warning/30 bg-warning/10 text-warning"
          variant="outline"
        >
          <Spinner className="size-3" />
          {isAnalyzing ? 'planning' : 'creating'}
        </Badge>
      }
      aria-label={`${phaseLabel}: ${branchLabel}`}
      aria-live="polite"
      className="border-warning/30 bg-warning/5"
      data-testid={`pending-workspace-${creation.id}`}
      icon={<GitBranch className="size-4 shrink-0 text-muted-foreground" />}
      role="status"
      subtitle={<p className="text-muted-foreground text-xs">{phaseLabel}</p>}
      title={<span className="block truncate font-mono">{branchLabel}</span>}
    />
  )
}

function WorkspaceList({
  onPendingCreationChange,
  pendingCreations = [],
  projectId,
  projectName,
  repoPath,
}: WorkspaceListProps) {
  const store = useLaborerStore()
  const workspaceList = store.useQuery(allWorkspaces$)
  const collapseState = useWorkspaceGroupCollapseState()

  // Filter out destroyed workspaces, scoped to the given project
  const activeWorkspaces = useMemo(
    () =>
      workspaceList.filter(
        (ws) => ws.status !== 'destroyed' && ws.projectId === projectId
      ),
    [workspaceList, projectId]
  )

  // Derive the sub-workspace tree by matching each workspace's baseBranch
  // against live workspaces' branchName.
  const workspaceTree = useMemo(
    () =>
      buildWorkspaceTree(
        activeWorkspaces.map(
          (ws): WorkspaceTreeRow => ({
            ...ws,
            // baseBranch is not in LiveStore's inferred queryDb type
            // (column count limit), but it IS in the SQLite table and
            // accessible at runtime.
            baseBranch:
              (ws as { baseBranch?: string | null }).baseBranch ?? null,
          })
        )
      ),
    [activeWorkspaces]
  )

  if (activeWorkspaces.length === 0 && pendingCreations.length === 0) {
    return (
      <Empty className="py-4">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <GitBranchPlus />
          </EmptyMedia>
          <EmptyTitle>No workspaces</EmptyTitle>
          <EmptyDescription>
            Create a workspace to start working on isolated branches with AI
            agents.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <div className="grid gap-2">
      {pendingCreations.map((creation) => (
        <PendingWorkspaceItem creation={creation} key={creation.id} />
      ))}
      {workspaceTree.map((node) => (
        <WorkspaceTreeGroup
          collapseState={collapseState}
          key={node.workspace.id}
          node={node}
          onPendingCreationChange={onPendingCreationChange}
          projectName={projectName}
          repoPath={repoPath}
        />
      ))}
    </div>
  )
}

export { WorkspaceList }
