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

import { useAtomSet } from '@effect-atom/atom-react/Hooks'
import { prds, workspaces } from '@laborer/shared/schema'
import type { WorkspaceOrigin } from '@laborer/shared/types'
import {
  buildWorkspaceTree,
  type WorkspaceTreeNode,
} from '@laborer/shared/workspace-tree'
import { queryDb } from '@livestore/livestore'
import {
  ChevronRight,
  ExternalLink,
  GitBranch,
  GitBranchPlus,
  Globe,
  Pause,
  Play,
  Trash2,
} from 'lucide-react'
import {
  type FC,
  type KeyboardEvent,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { LaborerClient } from '@/atoms/laborer-client'
import { CopyButton } from '@/components/copy-button'
import { CreateWorkspaceForm } from '@/components/create-workspace-form'
import { FixFindingsForm } from '@/components/fix-findings-form'
import { GitHubPrStatusBadge } from '@/components/github-pr-status-badge'
import { LifecyclePhase } from '@/components/lifecycle-phase-context'
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
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
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
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
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
import { isElectron, openExternalUrl } from '@/lib/desktop'
import { isExactEnter, isMetaEnter } from '@/lib/dialog-keys'
import { getSandboxSetupLabel } from '@/lib/sandbox-setup-labels'
import { toast } from '@/lib/toast'
import { cn, extractErrorMessage } from '@/lib/utils'
import { useLaborerStore } from '@/livestore/store'
import { useActiveWorkspaceId, usePanelActions } from '@/panels/panel-context'

const allWorkspaces$ = queryDb(workspaces, { label: 'workspaceList' })
const allPrds$ = queryDb(prds, { label: 'workspaceList.prds' })

const destroyWorkspaceMutation = LaborerClient.mutation('workspace.destroy')
const startSandboxMutation = LaborerClient.mutation('workspace.startSandbox')
const setSandboxPortMutation = LaborerClient.mutation('sandbox.setPort')
const pauseSandboxMutation = LaborerClient.mutation('sandbox.pause')
const resumeSandboxMutation = LaborerClient.mutation('sandbox.resume')
const openInVsCodeMutation = LaborerClient.mutation('sandbox.openInVsCode')

/** Prefix used to associate workspaces with plans by branch name convention. */
const PLAN_BRANCH_PREFIX = 'plan/'

/**
 * Detects whether a sandboxUrl is a full URL (Daytona preview URLs start
 * with https://) vs a Docker hostname (e.g., branch--project.orb.local).
 */
const FULL_URL_RE = /^https?:\/\//u
const DIALOG_TEXT_CLASS = 'text-balance text-muted-foreground text-xs/relaxed'

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

// getSandboxSetupLabel is shared with workspace-dashboard.tsx —
// see apps/web/src/lib/sandbox-setup-labels.ts for the implementation.

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
 * Pause/resume toggle button for sandboxed workspaces.
 * Calls `sandbox.pause` or `sandbox.resume` RPC based on current state.
 */
function SandboxPauseButton({
  workspaceId,
  isPaused,
}: {
  readonly workspaceId: string
  readonly isPaused: boolean
}) {
  const isServerReady = useWhenPhase(LifecyclePhase.Ready)
  const [isLoading, setIsLoading] = useState(false)
  const pauseSandbox = useAtomSet(pauseSandboxMutation, {
    mode: 'promise',
  })
  const resumeSandbox = useAtomSet(resumeSandboxMutation, {
    mode: 'promise',
  })

  const handleToggle = useCallback(async () => {
    setIsLoading(true)
    try {
      if (isPaused) {
        await resumeSandbox({ payload: { workspaceId } })
        toast.success('Sandbox resumed')
      } else {
        await pauseSandbox({ payload: { workspaceId } })
        toast.success('Sandbox paused')
      }
    } catch (error: unknown) {
      toast.error(
        `Failed to ${isPaused ? 'resume' : 'pause'} sandbox: ${extractErrorMessage(error)}`
      )
    } finally {
      setIsLoading(false)
    }
  }, [isPaused, pauseSandbox, resumeSandbox, workspaceId])

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={isPaused ? 'Resume sandbox' : 'Pause sandbox'}
            disabled={!isServerReady || isLoading}
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
        {isPaused ? 'Resume sandbox' : 'Pause sandbox'}
      </TooltipContent>
    </Tooltip>
  )
}

function OpenInVsCodeButton({ workspaceId }: { readonly workspaceId: string }) {
  const isServerReady = useWhenPhase(LifecyclePhase.Ready)
  const [isLoading, setIsLoading] = useState(false)
  const openInVsCode = useAtomSet(openInVsCodeMutation, {
    mode: 'promise',
  })

  const handleClick = useCallback(async () => {
    setIsLoading(true)
    try {
      await openInVsCode({ payload: { workspaceId } })
      toast.success('Opening in VS Code...')
    } catch (error: unknown) {
      toast.error(`Failed to open in VS Code: ${extractErrorMessage(error)}`)
    } finally {
      setIsLoading(false)
    }
  }, [openInVsCode, workspaceId])

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label="Open in VS Code"
            disabled={!isServerReady || isLoading}
            onClick={handleClick}
            size="icon-xs"
            variant="ghost"
          />
        }
      >
        <ExternalLink
          className={cn(
            'size-3.5',
            isLoading ? 'animate-pulse text-muted-foreground' : 'text-blue-500'
          )}
        />
      </TooltipTrigger>
      <TooltipContent>Open in VS Code (SSH)</TooltipContent>
    </Tooltip>
  )
}

function SandboxPortButton({
  workspaceId,
  currentPort,
}: {
  readonly workspaceId: string
  readonly currentPort: number | null
}) {
  const isServerReady = useWhenPhase(LifecyclePhase.Ready)
  const [isOpen, setIsOpen] = useState(false)
  const [portValue, setPortValue] = useState(
    currentPort != null ? String(currentPort) : ''
  )
  const setSandboxPort = useAtomSet(setSandboxPortMutation, {
    mode: 'promise',
  })

  const handleSave = useCallback(async () => {
    const parsed = portValue.trim() === '' ? null : Number(portValue)
    if (
      parsed != null &&
      (Number.isNaN(parsed) || parsed < 1 || parsed > 65_535)
    ) {
      toast.error('Port must be between 1 and 65535')
      return
    }
    try {
      await setSandboxPort({
        payload: { workspaceId, port: parsed },
      })
      setIsOpen(false)
      toast.success(parsed != null ? `Port set to ${parsed}` : 'Port cleared')
    } catch (error: unknown) {
      toast.error(`Failed to set port: ${extractErrorMessage(error)}`)
    }
  }, [portValue, setSandboxPort, workspaceId])

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        handleSave()
      }
    },
    [handleSave]
  )

  return (
    <Popover onOpenChange={setIsOpen} open={isOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  aria-label="Set sandbox port"
                  disabled={!isServerReady}
                  size="icon-xs"
                  variant="ghost"
                />
              }
            >
              <Globe
                className={cn(
                  'size-3.5',
                  currentPort != null
                    ? 'text-foreground'
                    : 'text-muted-foreground'
                )}
              />
            </PopoverTrigger>
          }
        />
        <TooltipContent>
          {currentPort != null ? `Port: ${currentPort}` : 'Set sandbox port'}
        </TooltipContent>
      </Tooltip>
      <PopoverContent className="w-48 p-2">
        <div className="flex items-center gap-1">
          <Input
            autoFocus
            className="h-7 text-xs"
            onChange={(event) => setPortValue(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="e.g. 3000"
            type="number"
            value={portValue}
          />
          <Button className="h-7 text-xs" onClick={handleSave} size="sm">
            Set
          </Button>
        </div>
      </PopoverContent>
    </Popover>
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

/**
 * Start Sandbox button — starts a sandbox for a non-sandboxed
 * workspace, converting it into a laborer-managed workspace.
 */
function StartSandboxButton({
  isStarting,
  onClick,
}: {
  readonly isStarting: boolean
  readonly onClick: () => void
}) {
  const isServerReady = useWhenPhase(LifecyclePhase.Ready)

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label="Start sandbox"
            disabled={!isServerReady || isStarting}
            onClick={onClick}
            size="icon-xs"
            title={isServerReady ? undefined : 'Connecting to server...'}
            variant="ghost"
          />
        }
      >
        <Play
          className={cn(
            'size-3.5',
            isStarting ? 'animate-pulse text-muted-foreground' : 'text-success'
          )}
        />
      </TooltipTrigger>
      <TooltipContent>Start Sandbox</TooltipContent>
    </Tooltip>
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
    readonly sandboxId: string | null
    readonly sandboxUrl: string | null
    readonly sandboxPort: number | null
    readonly sandboxStatus: string | null
    readonly sandboxSetupStep: string | null
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

function SandboxActions({
  currentPort,
  isDaytonaSandbox,
  isNoSandbox,
  isPaused,
  isSandboxed,
  isStartingSandbox,
  onStartSandbox,
  workspaceId,
}: {
  readonly currentPort: number | null
  readonly isDaytonaSandbox: boolean
  readonly isNoSandbox: boolean
  readonly isPaused: boolean
  readonly isSandboxed: boolean
  readonly isStartingSandbox: boolean
  readonly onStartSandbox: () => void
  readonly workspaceId: string
}) {
  if (isNoSandbox) {
    return null
  }

  if (!isSandboxed) {
    return (
      <StartSandboxButton
        isStarting={isStartingSandbox}
        onClick={onStartSandbox}
      />
    )
  }

  return (
    <>
      {isDaytonaSandbox && !isPaused && (
        <OpenInVsCodeButton workspaceId={workspaceId} />
      )}
      <SandboxPauseButton isPaused={isPaused} workspaceId={workspaceId} />
      <SandboxPortButton currentPort={currentPort} workspaceId={workspaceId} />
    </>
  )
}

function WorkspaceItem({
  workspace,
  associatedPrdId,
  isRootWorkspace,
  projectName,
  showCreateSubWorkspaceAction = true,
}: WorkspaceItemProps) {
  const [isStartingSandbox, setIsStartingSandbox] = useState(false)
  const [workspaceAgentStatus, setWorkspaceAgentStatus] = useState<
    'active' | 'waiting_for_input' | null
  >(null)
  const startSandbox = useAtomSet(startSandboxMutation, {
    mode: 'promise',
  })
  const activeWorkspaceId = useActiveWorkspaceId()
  const isActiveWorkspace = activeWorkspaceId === workspace.id

  const handleStartSandbox = useCallback(async () => {
    setIsStartingSandbox(true)
    try {
      await startSandbox({
        payload: { workspaceId: workspace.id },
      })
      toast.success('Sandbox started')
    } catch (error: unknown) {
      toast.error(`Failed to start sandbox: ${extractErrorMessage(error)}`)
    } finally {
      setIsStartingSandbox(false)
    }
  }, [startSandbox, workspace.id])

  const isSandboxed = workspace.sandboxId != null
  const isSandboxPaused = workspace.sandboxStatus === 'paused'
  // sandboxProvider is not in LiveStore's inferred queryDb type (column count limit),
  // but it IS in the SQLite table and accessible at runtime.
  const isDaytonaSandbox =
    (workspace as { sandboxProvider?: string | null }).sandboxProvider ===
    'daytona'
  const isNoSandbox =
    (workspace as { sandboxProvider?: string | null }).sandboxProvider ===
    'none'
  const hasSandboxConfig = workspace.sandboxUrl != null
  // Only show the sandbox link when a sandbox actually exists.
  // sandboxUrl is intentionally preserved after sandbox destruction
  // for display purposes, but we don't want to show a clickable link
  // to a sandbox that no longer exists.
  const sandboxLink = (() => {
    if (!(isSandboxed && workspace.sandboxUrl)) {
      return null
    }
    // Daytona preview URLs are stored as full URLs (https://...).
    // Docker sandbox URLs are hostnames (e.g., branch--project.orb.local).
    if (FULL_URL_RE.test(workspace.sandboxUrl)) {
      return workspace.sandboxUrl
    }
    return `http://${workspace.sandboxUrl}${workspace.sandboxPort != null ? `:${workspace.sandboxPort}` : ''}`
  })()

  /**
   * Derive display status from the sandbox state. The badge reflects
   * the sandbox lifecycle, not the workspace lifecycle:
   * - Sandbox running → "running"
   * - Sandbox paused → "paused"
   * - Sandbox gone (was sandboxed but sandboxId cleared) → "stopped"
   * - Never sandboxed → fall back to workspace.status
   */
  const displayStatus = (() => {
    if (isSandboxed) {
      return isSandboxPaused ? 'paused' : 'running'
    }
    if (hasSandboxConfig) {
      return 'stopped'
    }
    return workspace.status
  })()

  const needsAttention = workspaceAgentStatus === 'waiting_for_input'

  const handleSandboxLinkClick = async (
    event: React.MouseEvent<HTMLAnchorElement>
  ) => {
    if (!(isElectron() && sandboxLink)) {
      return
    }

    event.preventDefault()
    await openExternalUrl(sandboxLink)
  }

  let infraLabel: ReactNode = (
    <span className="text-muted-foreground/70 text-xs">No sandbox</span>
  )
  if (sandboxLink) {
    infraLabel = (
      <CardDescription className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
        <span className="group/copyable flex min-w-0 items-center gap-1 overflow-hidden">
          <a
            className="truncate font-mono text-muted-foreground text-xs hover:text-foreground hover:underline"
            href={sandboxLink}
            onClick={handleSandboxLinkClick}
            rel="noopener"
            target="_blank"
            title={`Open ${sandboxLink}`}
          >
            {FULL_URL_RE.test(workspace.sandboxUrl ?? '')
              ? (workspace.sandboxUrl ?? '').replace(FULL_URL_RE, '')
              : workspace.sandboxUrl}
          </a>
          <span className="-mr-14 flex shrink-0 items-center gap-0.5 opacity-0 transition-all duration-200 group-hover/copyable:mr-0 group-hover/copyable:opacity-100">
            <CopyButton title="Copy URL" value={sandboxLink} />
            <Tooltip>
              <TooltipTrigger>
                <a
                  aria-label="Open in browser"
                  className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                  href={sandboxLink}
                  onClick={handleSandboxLinkClick}
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
    )
  }

  return (
    <Card
      className={cn(
        isActiveWorkspace && 'border-primary',
        needsAttention &&
          'animate-pulse border-amber-400/50 shadow-[0_0_8px_rgba(251,191,36,0.15)]'
      )}
      data-testid={`workspace-card-${workspace.branchName}`}
      size="sm"
    >
      <CardHeader className="gap-2">
        {/* Row 1 — Git: branch name, PR info, review/fix actions, destroy */}
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
            {workspace.prNumber != null && (
              <ReviewPrForm
                projectId={workspace.projectId}
                workspaceId={workspace.id}
              />
            )}
            {workspace.prNumber != null && (
              <FixFindingsForm
                projectId={workspace.projectId}
                workspaceId={workspace.id}
              />
            )}
            {!isRootWorkspace && showCreateSubWorkspaceAction && (
              <CreateWorkspaceForm
                baseWorkspace={{
                  id: workspace.id,
                  branchName: workspace.branchName,
                }}
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
          </div>
        </div>
        {/* Row 2 — Infra: sandbox URL, status, pause/play (hidden for root workspace) */}
        {!isRootWorkspace && (
          <div className="flex min-w-0 items-center justify-between gap-2">
            {infraLabel}
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {displayStatus === 'errored' && workspace.errorMessage ? (
                <Tooltip>
                  <TooltipTrigger>
                    <Badge
                      className={cn(
                        'shrink-0 border',
                        getStatusClasses(displayStatus)
                      )}
                      variant="outline"
                    >
                      <StatusDot status={displayStatus} />
                      {displayStatus}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-sm whitespace-pre-wrap font-mono text-xs">
                    {workspace.errorMessage}
                  </TooltipContent>
                </Tooltip>
              ) : (
                <Badge
                  className={cn(
                    'shrink-0 border',
                    getStatusClasses(displayStatus)
                  )}
                  variant="outline"
                >
                  <StatusDot status={displayStatus} />
                  {displayStatus}
                </Badge>
              )}
              <SandboxActions
                currentPort={workspace.sandboxPort}
                isDaytonaSandbox={isDaytonaSandbox}
                isNoSandbox={isNoSandbox}
                isPaused={isSandboxPaused}
                isSandboxed={isSandboxed}
                isStartingSandbox={isStartingSandbox}
                onStartSandbox={handleStartSandbox}
                workspaceId={workspace.id}
              />
            </div>
          </div>
        )}
      </CardHeader>
      <CardContent>
        {workspace.worktreeSetupStep != null && (
          <div className="mb-2 flex items-center gap-2 text-warning text-xs">
            <Spinner className="size-3 text-warning" />
            {getWorktreeSetupLabel(workspace.worktreeSetupStep)}
          </div>
        )}
        {workspace.sandboxSetupStep != null && (
          <div className="mb-2 flex items-center gap-2 text-sky-500 text-xs">
            <Spinner className="size-3 text-sky-500" />
            {getSandboxSetupLabel(workspace.sandboxSetupStep)}
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
  readonly branchToPrdId: ReadonlyMap<string, string>
  readonly collapseState: CollapseState
  readonly node: WorkspaceTreeNode<WorkspaceTreeRow>
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
  branchToPrdId,
  collapseState,
  projectName,
  repoPath,
}: WorkspaceTreeGroupProps) {
  const { workspace, children } = node

  const card = (
    <WorkspaceItem
      associatedPrdId={branchToPrdId.get(workspace.branchName)}
      isRootWorkspace={workspace.worktreePath === repoPath}
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
              branchToPrdId={branchToPrdId}
              collapseState={collapseState}
              key={child.workspace.id}
              node={child}
              projectName={projectName}
              repoPath={repoPath}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function WorkspaceList({
  projectId,
  projectName,
  repoPath,
}: WorkspaceListProps) {
  const store = useLaborerStore()
  const workspaceList = store.useQuery(allWorkspaces$)
  const prdList = store.useQuery(allPrds$)
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
      {workspaceTree.map((node) => (
        <WorkspaceTreeGroup
          branchToPrdId={branchToPrdId}
          collapseState={collapseState}
          key={node.workspace.id}
          node={node}
          projectName={projectName}
          repoPath={repoPath}
        />
      ))}
    </div>
  )
}

export { WorkspaceList }
