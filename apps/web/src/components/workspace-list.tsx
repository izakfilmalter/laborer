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
 * Includes rlph action buttons (Start Ralph Loop, Review PR,
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
 * @see Issue #193: Plan workspace scoped task list and rlph integration
 */

import { useAtomSet } from '@effect-atom/atom-react/Hooks'
import { prds, workspaces } from '@laborer/shared/schema'
import type { WorkspaceOrigin } from '@laborer/shared/types'
import { queryDb } from '@livestore/livestore'
import {
  ExternalLink,
  GitBranch,
  GitPullRequest,
  Pause,
  Play,
  Trash2,
} from 'lucide-react'
import { type FC, useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { LaborerClient } from '@/atoms/laborer-client'
import { CopyButton } from '@/components/copy-button'
import { FixFindingsForm } from '@/components/fix-findings-form'
import { PlanIssuesList } from '@/components/plan-issues-list'
import { ReviewPrForm } from '@/components/review-pr-form'
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
import { Spinner } from '@/components/ui/spinner'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn, extractErrorMessage } from '@/lib/utils'
import { useLaborerStore } from '@/livestore/store'
import { usePanelActions } from '@/panels/panel-context'

const allWorkspaces$ = queryDb(workspaces, { label: 'workspaceList' })
const allPrds$ = queryDb(prds, { label: 'workspaceList.prds' })

const destroyWorkspaceMutation = LaborerClient.mutation('workspace.destroy')
const checkDirtyMutation = LaborerClient.mutation('workspace.checkDirty')
const startLoopMutation = LaborerClient.mutation('rlph.startLoop')
const pauseContainerMutation = LaborerClient.mutation('container.pause')
const unpauseContainerMutation = LaborerClient.mutation('container.unpause')

/** Prefix used to associate workspaces with plans by branch name convention. */
const PLAN_BRANCH_PREFIX = 'plan/'

/** Map PR state to icon color class. */
function getPrStateColorClass(prState: string | null): string {
  if (prState === 'MERGED') {
    return 'text-purple-500'
  }
  if (prState === 'CLOSED') {
    return 'text-destructive'
  }
  return 'text-success'
}

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
 * Returns the label for the destroy button based on current state.
 */
/**
 * Destroy dialog description text. Extracted to avoid nested ternaries.
 */
function DestroyDialogDescription({
  branchName,
  dirtyFiles,
  isCheckingDirty,
}: {
  readonly branchName: string
  readonly dirtyFiles: readonly string[]
  readonly isCheckingDirty: boolean
}) {
  if (isCheckingDirty) {
    return (
      <AlertDialogDescription>
        <span className="flex items-center gap-2">
          <Spinner className="size-3" />
          Checking workspace{' '}
          <strong className="font-mono text-foreground">{branchName}</strong>{' '}
          for uncommitted changes...
        </span>
      </AlertDialogDescription>
    )
  }

  if (dirtyFiles.length > 0) {
    return (
      <>
        <AlertDialogDescription>
          Workspace{' '}
          <strong className="font-mono text-foreground">{branchName}</strong>{' '}
          has uncommitted changes that will be lost. Are you sure you want to
          force destroy it?
        </AlertDialogDescription>
        <ul className="max-h-40 list-none overflow-y-auto rounded-md border bg-muted/50 p-2 font-mono text-xs">
          {dirtyFiles.map((file) => (
            <li className="truncate py-0.5 text-muted-foreground" key={file}>
              {file}
            </li>
          ))}
        </ul>
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
  }
}

function WorkspaceItem({ workspace, associatedPrdId }: WorkspaceItemProps) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [isCheckingDirty, setIsCheckingDirty] = useState(false)
  const [dirtyFiles, setDirtyFiles] = useState<string[]>([])
  const [isStartingLoop, setIsStartingLoop] = useState(false)
  const destroyWorkspace = useAtomSet(destroyWorkspaceMutation, {
    mode: 'promise',
  })
  const checkDirty = useAtomSet(checkDirtyMutation, {
    mode: 'promise',
  })
  const startLoop = useAtomSet(startLoopMutation, {
    mode: 'promise',
  })
  const panelActions = usePanelActions()

  const handleDialogOpen = (open: boolean) => {
    setDialogOpen(open)
    if (!open) {
      setDirtyFiles([])
      setIsCheckingDirty(false)
      return
    }
    // Check for dirty files when the dialog opens
    setIsCheckingDirty(true)
    checkDirty({ payload: { workspaceId: workspace.id } })
      .then((files) => {
        setDirtyFiles(files.length > 0 ? [...files] : [])
        setIsCheckingDirty(false)
      })
      .catch(() => {
        // If check fails, allow destroy without dirty warning
        setIsCheckingDirty(false)
      })
  }

  const handleDestroy = (force?: boolean) => {
    // Close dialog immediately and run destruction in the background
    setDialogOpen(false)
    setDirtyFiles([])

    const toastId = toast.loading(
      `Destroying workspace "${workspace.branchName}"...`
    )

    destroyWorkspace({
      payload: { workspaceId: workspace.id, force },
    })
      .then(() => {
        toast.success(
          `Workspace "${workspace.branchName}" destroyed successfully`,
          { id: toastId }
        )
      })
      .catch((error: unknown) => {
        const message = extractErrorMessage(error)
        toast.error(message, { id: toastId })
      })
  }

  const handleStartLoop = useCallback(async () => {
    setIsStartingLoop(true)
    try {
      const result = await startLoop({
        payload: { workspaceId: workspace.id },
      })
      toast.success('Ralph loop started')
      // Auto-assign the spawned terminal to a pane
      if (panelActions) {
        panelActions.assignTerminalToPane(result.id, workspace.id)
      }
    } catch (error: unknown) {
      toast.error(`Failed to start ralph loop: ${extractErrorMessage(error)}`)
    } finally {
      setIsStartingLoop(false)
    }
  }, [startLoop, workspace.id, panelActions])

  const isContainerized = workspace.containerId != null
  const isContainerPaused = workspace.containerStatus === 'paused'

  /**
   * For containerized workspaces, derive the display status from the
   * container state (paused vs running) rather than the workspace
   * lifecycle status, so the badge accurately reflects container state.
   */
  const displayStatus =
    isContainerized && isContainerPaused ? 'paused' : workspace.status

  return (
    <Card size="sm">
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
            {workspace.prNumber != null && workspace.prUrl != null && (
              <Tooltip>
                <TooltipTrigger>
                  <a
                    className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-xs transition-colors hover:bg-accent"
                    href={workspace.prUrl}
                    rel="noopener"
                    target="_blank"
                  >
                    <GitPullRequest
                      className={cn(
                        'size-3',
                        getPrStateColorClass(workspace.prState)
                      )}
                    />
                    <span>#{workspace.prNumber}</span>
                  </a>
                </TooltipTrigger>
                <TooltipContent>
                  {workspace.prTitle ?? `PR #${workspace.prNumber}`}
                </TooltipContent>
              </Tooltip>
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
          {workspace.containerUrl ? (
            <CardDescription className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
              <span className="group/copyable flex min-w-0 items-center gap-1 overflow-hidden">
                <a
                  className="truncate font-mono text-muted-foreground text-xs hover:text-foreground hover:underline"
                  href={`https://${workspace.containerUrl}`}
                  rel="noopener"
                  target="_blank"
                  title={`Open https://${workspace.containerUrl}`}
                >
                  {workspace.containerUrl}
                </a>
                <span className="-mr-14 flex shrink-0 items-center gap-0.5 opacity-0 transition-all duration-200 group-hover/copyable:mr-0 group-hover/copyable:opacity-100">
                  <CopyButton
                    title="Copy URL"
                    value={`https://${workspace.containerUrl}`}
                  />
                  <a
                    className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                    href={`https://${workspace.containerUrl}`}
                    rel="noopener"
                    target="_blank"
                    title="Open in browser"
                  >
                    <ExternalLink className="size-3" />
                  </a>
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
              workspaceId={workspace.id}
            />
            <FixFindingsForm
              disabled={workspace.prNumber == null}
              workspaceId={workspace.id}
            />
            <AlertDialog onOpenChange={handleDialogOpen} open={dialogOpen}>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <AlertDialogTrigger
                      render={
                        <Button
                          aria-label={`Destroy workspace ${workspace.branchName}`}
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
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {dirtyFiles.length > 0
                      ? 'Uncommitted changes'
                      : 'Destroy workspace?'}
                  </AlertDialogTitle>
                  <DestroyDialogDescription
                    branchName={workspace.branchName}
                    dirtyFiles={dirtyFiles}
                    isCheckingDirty={isCheckingDirty}
                  />
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    disabled={isCheckingDirty}
                    onClick={() =>
                      handleDestroy(dirtyFiles.length > 0 ? true : undefined)
                    }
                    variant="destructive"
                  >
                    {dirtyFiles.length > 0 ? 'Force Destroy' : 'Destroy'}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
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
}

function WorkspaceList({ projectId }: WorkspaceListProps) {
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
          key={workspace.id}
          workspace={workspace}
        />
      ))}
    </div>
  )
}

export { WorkspaceList }
