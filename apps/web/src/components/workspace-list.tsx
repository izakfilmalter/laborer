/**
 * Workspace list UI component.
 *
 * Displays a reactive list of workspaces for a given project from LiveStore.
 * Each workspace shows its branch name, port, and status with color-coded
 * badges: creating=yellow, running=green, stopped=gray, errored=red,
 * destroyed=dim.
 * Workspaces with "creating" status show a spinner and progress description
 * to indicate that worktree creation, port allocation, and setup scripts
 * are in progress.
 * Updates reactively when workspace state changes.
 * Includes a destroy button with confirmation dialog per workspace.
 * Includes brrr action buttons (Start Ralph Loop, Review PR,
 * Fix Findings) on every non-destroyed workspace for triggering agent
 * workflows.
 *
 * When a workspace is associated with a plan (branch name matches
 * `plan/<slug>`), a scoped task list is shown inside the workspace card
 * displaying only the plan's issues. Status changes propagate to the
 * sidebar plan progress indicator via LiveStore reactivity.
 *
 * When no workspaces exist (all destroyed or none created), shows an empty
 * state with guidance text and a CTA button to create the first workspace.
 *
 * Accepts a required `projectId` prop to scope workspaces to a single project.
 *
 * @see Issue #41: Workspace list UI component
 * @see Issue #48: Destroy Workspace button + confirmation dialog
 * @see Issue #93: "Start Ralph Loop" button UI
 * @see Issue #97: "Review PR" button + PR number input
 * @see Issue #99: "Fix Findings" button + PR number input
 * @see Issue #119: Empty state — no workspaces
 * @see Issue #121: Loading state — workspace creation
 * @see Issue #113: Project switcher — filter workspaces by active project
 * @see Issue #160: UI for detected workspaces
 * @see Issue #193: Plan workspace scoped task list and brrr integration
 */

import { useAtomSet, useAtomValue } from '@effect-atom/atom-react/Hooks'
import { prds, workspaces } from '@laborer/shared/schema'
import type { WorkspaceOrigin } from '@laborer/shared/types'
import { queryDb } from '@livestore/livestore'
import { ExternalLink, GitBranch, Pause, Play, Trash2 } from 'lucide-react'
import {
  type FC,
  type KeyboardEvent,
  Suspense,
  useCallback,
  useMemo,
  useState,
} from 'react'
import { toast } from 'sonner'
import { ConfigReactivityKeys, LaborerClient } from '@/atoms/laborer-client'
import { CopyButton } from '@/components/copy-button'
import { FixFindingsForm } from '@/components/fix-findings-form'
import { GitHubPrStatusBadge } from '@/components/github-pr-status-badge'
import { PlanIssuesList } from '@/components/plan-issues-list'
import { ReviewFindingsCount } from '@/components/review-findings-count'
import { ReviewPrForm } from '@/components/review-pr-form'
import { ReviewVerdictBadge } from '@/components/review-verdict-badge'
import { TerminalList } from '@/components/terminal-list'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
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
import { isElectron, openExternalUrl } from '@/lib/desktop'
import { isExactEnter, isMetaEnter } from '@/lib/dialog-keys'
import { cn, extractErrorMessage } from '@/lib/utils'
import { useLaborerStore } from '@/livestore/store'
import { usePanelActions } from '@/panels/panel-context'

const allWorkspaces$ = queryDb(workspaces, { label: 'workspaceList' })
const allPrds$ = queryDb(prds, { label: 'workspaceList.prds' })

const destroyWorkspaceMutation = LaborerClient.mutation('workspace.destroy')
const startLoopMutation = LaborerClient.mutation('brrr.startLoop')
const pauseContainerMutation = LaborerClient.mutation('container.pause')
const unpauseContainerMutation = LaborerClient.mutation('container.unpause')

/** Prefix used to associate workspaces with plans by branch name convention. */
const PLAN_BRANCH_PREFIX = 'plan/'

type WorkspaceStatus =
  | 'creating'
  | 'running'
  | 'paused'
  | 'stopped'
  | 'errored'
  | 'destroyed'

/**
 * Human-readable label for worktree setup progress steps.
 * Displayed in the workspace card during background worktree creation.
 */
const getWorktreeSetupLabel = (step: string): string => {
  switch (step) {
    case 'fetching-remote':
      return 'Fetching latest remote refs...'
    case 'creating-worktree':
      return 'Creating git worktree...'
    case 'validating-worktree':
      return 'Validating worktree...'
    case 'running-setup-scripts':
      return 'Running setup scripts...'
    default:
      return 'Setting up workspace...'
  }
}

/**
 * Human-readable label for container setup progress steps.
 * Handles both coarse steps ("building-image") and granular
 * Docker build steps ("Step 4/5: RUN pnpm install").
 */
const getContainerSetupLabel = (step: string): string => {
  if (step.startsWith('Step ')) {
    return step
  }
  switch (step) {
    case 'building-image':
      return 'Building container image...'
    case 'starting-container':
      return 'Starting container...'
    default:
      return 'Setting up container...'
  }
}

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
 * Pause/unpause toggle button for containerized workspaces.
 * Calls `container.pause` or `container.unpause` RPC based on current state.
 */
function ContainerPauseButton({
  workspaceId,
  isPaused,
}: {
  readonly workspaceId: string
  readonly isPaused: boolean
}) {
  const [isLoading, setIsLoading] = useState(false)
  const pauseContainer = useAtomSet(pauseContainerMutation, {
    mode: 'promise',
  })
  const unpauseContainer = useAtomSet(unpauseContainerMutation, {
    mode: 'promise',
  })

  const handleToggle = useCallback(async () => {
    setIsLoading(true)
    try {
      if (isPaused) {
        await unpauseContainer({ payload: { workspaceId } })
        toast.success('Container resumed')
      } else {
        await pauseContainer({ payload: { workspaceId } })
        toast.success('Container paused')
      }
    } catch (error: unknown) {
      toast.error(
        `Failed to ${isPaused ? 'resume' : 'pause'} container: ${extractErrorMessage(error)}`
      )
    } finally {
      setIsLoading(false)
    }
  }, [isPaused, pauseContainer, unpauseContainer, workspaceId])

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={isPaused ? 'Resume container' : 'Pause container'}
            disabled={isLoading}
            onClick={handleToggle}
            size="icon-xs"
            variant="ghost"
          />
        }
      >
        {isPaused ? (
          <Play
            className={cn(
              'size-3.5',
              isLoading ? 'animate-pulse text-muted-foreground' : 'text-success'
            )}
          />
        ) : (
          <Pause
            className={cn(
              'size-3.5',
              isLoading
                ? 'animate-pulse text-muted-foreground'
                : 'text-amber-500'
            )}
          />
        )}
      </TooltipTrigger>
      <TooltipContent>
        {isPaused ? 'Resume container' : 'Pause container'}
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * Destroy dialog description text. Extracted to avoid nested ternaries.
 *
 * Shows a checking spinner while dirty/terminal state is loading, then
 * displays any uncommitted files and active terminal sessions that will
 * be lost. When there are no warnings, shows a generic confirmation.
 */
function DestroyDialogDescription({
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
      <AlertDialogDescription>
        <span className="flex flex-col items-center gap-2">
          <Spinner className="size-3" />
          <span>
            Checking workspace{' '}
            <strong className="font-mono text-foreground">{branchName}</strong>{' '}
            for uncommitted changes...
          </span>
        </span>
      </AlertDialogDescription>
    )
  }

  if (hasWarnings) {
    return (
      <>
        <AlertDialogDescription>
          Workspace{' '}
          <strong className="font-mono text-foreground">{branchName}</strong>{' '}
          has {warningsSummary.join(' and')} that will be lost. Are you sure you
          want to force destroy it?
        </AlertDialogDescription>
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
    <AlertDialogDescription>
      This will permanently destroy workspace{' '}
      <strong className="font-mono text-foreground">{branchName}</strong>. All
      running processes (terminals, dev servers, agents) will be killed, the git
      worktree will be removed, and the allocated port will be freed. This
      action cannot be undone.
    </AlertDialogDescription>
  )
}

interface WorkspaceItemProps {
  /** The prdId of the plan this workspace is associated with, if any. */
  readonly associatedPrdId?: string | undefined
  /**
   * Whether this workspace is the root workspace (main git checkout).
   * Root workspaces cannot be destroyed as they represent the original
   * repository clone.
   */
  readonly isRootWorkspace?: boolean | undefined
  readonly workspace: {
    readonly id: string
    readonly projectId: string
    readonly branchName: string
    readonly worktreePath: string
    readonly port: number
    readonly status: string
    readonly origin: WorkspaceOrigin | string
    readonly createdAt: string
    readonly taskSource: string | null
    readonly containerId: string | null
    readonly containerUrl: string | null
    readonly containerStatus: string | null
    readonly containerSetupStep: string | null
    readonly worktreeSetupStep: string | null
    readonly prNumber: number | null
    readonly prUrl: string | null
    readonly prTitle: string | null
    readonly prState: string | null
    readonly aheadCount: number | null
    readonly behindCount: number | null
  }
}

function DestroyWorkspaceButton({
  workspaceId,
  branchName,
}: {
  readonly workspaceId: string
  readonly branchName: string
}) {
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

  const handleDialogOpen = (open: boolean) => {
    setDialogOpen(open)
    if (!open) {
      resetDestroyChecks()
      return
    }

    startChecks()
  }

  const handleDestroy = (force?: boolean) => {
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
  }

  return (
    <AlertDialog onOpenChange={handleDialogOpen} open={dialogOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <AlertDialogTrigger
              render={
                <Button
                  aria-label={`Destroy workspace ${branchName}`}
                  size="icon-xs"
                  variant="ghost"
                />
              }
            />
          }
        >
          <Trash2 className="size-3.5 text-muted-foreground" />
        </TooltipTrigger>
        <TooltipContent>Destroy workspace</TooltipContent>
      </Tooltip>
      <AlertDialogContent
        onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
          if (isExactEnter(event.nativeEvent)) {
            event.preventDefault()
            event.stopPropagation()
            return
          }
          if (isMetaEnter(event.nativeEvent) && !isCheckingDestroyState) {
            event.preventDefault()
            handleDestroy(hasWarnings ? true : undefined)
          }
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>
            {hasWarnings ? 'Unsaved work' : 'Destroy workspace?'}
          </AlertDialogTitle>
          <DestroyDialogDescription
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
            onClick={() => handleDestroy(hasWarnings ? true : undefined)}
            variant="destructive"
          >
            {hasWarnings ? 'Force Destroy' : 'Destroy'}
            <Kbd>⌘</Kbd>
            <Kbd>↵</Kbd>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function WorkspaceItem({
  workspace,
  associatedPrdId,
  isRootWorkspace,
}: WorkspaceItemProps) {
  const [isStartingLoop, setIsStartingLoop] = useState(false)
  const [workspaceAgentStatus, setWorkspaceAgentStatus] = useState<
    'active' | 'waiting_for_input' | null
  >(null)
  const startLoop = useAtomSet(startLoopMutation, {
    mode: 'promise',
  })
  const panelActions = usePanelActions()
  const configGet$ = useMemo(
    () =>
      LaborerClient.query(
        'config.get',
        { projectId: workspace.projectId },
        { reactivityKeys: ConfigReactivityKeys }
      ),
    [workspace.projectId]
  )
  const configResult = useAtomValue(configGet$)
  const autoOpenDevServer =
    configResult._tag === 'Success'
      ? configResult.value.devServer.autoOpen.value
      : false

  const handleStartLoop = useCallback(async () => {
    setIsStartingLoop(true)
    try {
      const result = await startLoop({
        payload: { workspaceId: workspace.id },
      })
      toast.success('Ralph loop started')
      // Auto-assign the spawned terminal to a pane
      if (panelActions) {
        panelActions.assignTerminalToPane(result.id, workspace.id, undefined, {
          autoOpenDevServer,
        })
      }
    } catch (error: unknown) {
      toast.error(`Failed to start ralph loop: ${extractErrorMessage(error)}`)
    } finally {
      setIsStartingLoop(false)
    }
  }, [autoOpenDevServer, startLoop, workspace.id, panelActions])

  const isContainerized = workspace.containerId != null
  const isContainerPaused = workspace.containerStatus === 'paused'
  const containerLink = workspace.containerUrl
    ? `https://${workspace.containerUrl}`
    : null

  /**
   * For containerized workspaces, derive the display status from the
   * container state (paused vs running) rather than the workspace
   * lifecycle status, so the badge accurately reflects container state.
   */
  const displayStatus =
    isContainerized && isContainerPaused ? 'paused' : workspace.status

  const needsAttention = workspaceAgentStatus === 'waiting_for_input'

  const handleContainerLinkClick = async (
    event: React.MouseEvent<HTMLAnchorElement>
  ) => {
    if (!(isElectron() && containerLink)) {
      return
    }

    event.preventDefault()
    await openExternalUrl(containerLink)
  }

  return (
    <Card
      className={cn(
        needsAttention &&
          'animate-pulse border-amber-400/50 shadow-[0_0_8px_rgba(251,191,36,0.15)]'
      )}
      size="sm"
    >
      <CardHeader className="gap-2">
        <div className="flex min-w-0 flex-wrap items-start gap-2">
          <div className="flex min-w-0 flex-1 items-start gap-2 overflow-hidden">
            <GitBranch className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <CardTitle className="min-w-0 font-mono text-sm">
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
            </CardTitle>
          </div>
          <div className="flex shrink-0 items-center gap-1">
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
            {workspace.prNumber != null && (
              <Suspense fallback={null}>
                <ReviewVerdictBadge workspaceId={workspace.id} />
              </Suspense>
            )}
            {workspace.prNumber != null && (
              <Suspense fallback={null}>
                <ReviewFindingsCount workspaceId={workspace.id} />
              </Suspense>
            )}
            <Badge
              className={cn('shrink-0 border', getStatusClasses(displayStatus))}
              variant="outline"
            >
              <StatusDot status={displayStatus} />
              {displayStatus}
            </Badge>
          </div>
        </div>
        <div className="flex min-w-0 items-center justify-between gap-2">
          {containerLink ? (
            <CardDescription className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
              <span className="group/copyable flex min-w-0 items-center gap-1 overflow-hidden">
                <a
                  className="truncate font-mono text-muted-foreground text-xs hover:text-foreground hover:underline"
                  href={containerLink}
                  onClick={handleContainerLinkClick}
                  rel="noopener"
                  target="_blank"
                  title={`Open ${containerLink}`}
                >
                  {workspace.containerUrl}
                </a>
                <span className="-mr-14 flex shrink-0 items-center gap-0.5 opacity-0 transition-all duration-200 group-hover/copyable:mr-0 group-hover/copyable:opacity-100">
                  <CopyButton title="Copy URL" value={containerLink} />
                  <Tooltip>
                    <TooltipTrigger>
                      <a
                        aria-label="Open in browser"
                        className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                        href={containerLink}
                        onClick={handleContainerLinkClick}
                        rel="noopener"
                        target="_blank"
                      >
                        <ExternalLink className="size-3" />
                      </a>
                    </TooltipTrigger>
                    <TooltipContent>Open in browser</TooltipContent>
                  </Tooltip>
                </span>
              </span>
            </CardDescription>
          ) : (
            workspace.port > 0 && (
              <CardDescription className="flex items-center gap-2">
                <span className="font-mono text-muted-foreground">
                  :{workspace.port}
                </span>
              </CardDescription>
            )
          )}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {isContainerized ? (
              <ContainerPauseButton
                isPaused={isContainerPaused}
                workspaceId={workspace.id}
              />
            ) : (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      aria-label="Start ralph loop"
                      disabled={isStartingLoop}
                      onClick={handleStartLoop}
                      size="icon-xs"
                      variant="ghost"
                    />
                  }
                >
                  <Play
                    className={cn(
                      'size-3.5',
                      isStartingLoop
                        ? 'animate-pulse text-muted-foreground'
                        : 'text-success'
                    )}
                  />
                </TooltipTrigger>
                <TooltipContent>Start Ralph Loop</TooltipContent>
              </Tooltip>
            )}
            <ReviewPrForm
              disabled={workspace.prNumber == null}
              projectId={workspace.projectId}
              workspaceId={workspace.id}
            />
            <FixFindingsForm
              disabled={workspace.prNumber == null}
              projectId={workspace.projectId}
              workspaceId={workspace.id}
            />
            {!isRootWorkspace && (
              <DestroyWorkspaceButton
                branchName={workspace.branchName}
                workspaceId={workspace.id}
              />
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {workspace.worktreeSetupStep != null && (
          <div className="mb-2 flex items-center gap-2 text-warning text-xs">
            <Spinner className="size-3 text-warning" />
            {getWorktreeSetupLabel(workspace.worktreeSetupStep)}
          </div>
        )}
        {workspace.containerSetupStep != null && (
          <div className="mb-2 flex items-center gap-2 text-sky-500 text-xs">
            <Spinner className="size-3 text-sky-500" />
            {getContainerSetupLabel(workspace.containerSetupStep)}
          </div>
        )}
        <div className="border-t pt-2">
          <TerminalList
            onAgentStatusChange={setWorkspaceAgentStatus}
            projectId={workspace.projectId}
            workspaceId={workspace.id}
          />
        </div>
        {associatedPrdId && (
          <div className="border-t pt-2">
            <h4 className="mb-2 font-medium text-muted-foreground text-xs">
              Plan Issues
            </h4>
            <PlanIssuesList prdId={associatedPrdId} />
          </div>
        )}
      </CardContent>
    </Card>
  )
}

interface WorkspaceListProps {
  /** Only workspaces belonging to this project are shown. */
  readonly projectId: string
  /**
   * The repository path (project.repoPath) used to identify the root workspace.
   * The root workspace is the one where worktreePath matches this path.
   */
  readonly repoPath: string
}

function WorkspaceList({ projectId, repoPath }: WorkspaceListProps) {
  const store = useLaborerStore()
  const workspaceList = store.useQuery(allWorkspaces$)
  const prdList = store.useQuery(allPrds$)

  // Filter out destroyed workspaces, scoped to the given project
  const activeWorkspaces = workspaceList.filter(
    (ws) => ws.status !== 'destroyed' && ws.projectId === projectId
  )

  // Build a map of plan/<slug> branch name → prdId for this project,
  // so we can detect which workspaces are associated with a plan.
  const branchToPrdId = useMemo(() => {
    const map = new Map<string, string>()
    for (const prd of prdList) {
      if (prd.projectId === projectId) {
        map.set(`${PLAN_BRANCH_PREFIX}${prd.slug}`, prd.id)
      }
    }
    return map
  }, [prdList, projectId])

  if (activeWorkspaces.length === 0) {
    return <p className="py-2 text-muted-foreground text-xs">No workspaces</p>
  }

  return (
    <div className="grid gap-2">
      {activeWorkspaces.map((workspace) => (
        <WorkspaceItem
          associatedPrdId={branchToPrdId.get(workspace.branchName)}
          isRootWorkspace={workspace.worktreePath === repoPath}
          key={workspace.id}
          workspace={workspace}
        />
      ))}
    </div>
  )
}

export { WorkspaceList }
