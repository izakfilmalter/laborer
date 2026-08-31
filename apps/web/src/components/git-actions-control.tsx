/**
 * The branch's next step, as one button.
 *
 * Getting work reviewed is always the same three moves — commit, push, open a
 * pull request — and which of them are outstanding is already knowable from
 * the worktree's status. So the primary button names the whole remaining
 * journey ("Commit, push & PR") and runs it in order, while the chevron beside
 * it keeps each step available on its own for the times the operator wants
 * only one of them.
 *
 * Nothing is asked for on the way. The operator already reviewed the diff and
 * decided to ship it; making them also narrate it would turn one click into a
 * writing task, so the server hands the diff to a model and the commit message
 * and pull request description come back written. Typing a message is the
 * bypass, available under "Commit…" in the menu, not the main path.
 *
 * The whole-journey button appears only while there is no pull request yet:
 * once the branch has one, the PR badge is the surface that speaks for it, and
 * a second control offering to open another would be a lie. The chevron stays,
 * because a branch under review still gets committed to and pushed — it just
 * drops "Create PR" from its menu.
 *
 * It also stays off a trunk branch. `main`, `master`, and `dev` are what work
 * merges into, so a pull request from one of them has no base to target, and
 * offering the journey there would only produce a failure at the last step.
 *
 * @see apps/web/src/hooks/use-workspace-git-actions.ts — the three calls
 * @see apps/web/src/components/workspace-sync-status.tsx — push/pull alone
 */

import { Button } from '@laborer/ui/components/button'
import { ButtonGroup } from '@laborer/ui/components/button-group'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@laborer/ui/components/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@laborer/ui/components/dropdown-menu'
import { Kbd } from '@laborer/ui/components/kbd'
import { Textarea } from '@laborer/ui/components/textarea'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@laborer/ui/components/tooltip'
import { cn } from '@laborer/ui/lib/utils'
import {
  ArrowUpToLine,
  ChevronDown,
  GitCommitHorizontal,
  GitPullRequestArrow,
} from 'lucide-react'
import { type KeyboardEvent, useState } from 'react'
import { LifecyclePhase } from '@/components/lifecycle-phase-context'
import { useWhenPhase } from '@/hooks/use-when-phase'
import { useWorkspaceGitActions } from '@/hooks/use-workspace-git-actions'
import { useWorkspaceSyncStatus } from '@/hooks/use-workspace-sync-status'
import { extractErrorMessage } from '@/lib/errors'
import { localApi } from '@/lib/local-api'
import { toast } from '@/lib/toast'

interface GitActionsControlProps {
  /** The branch the workspace is on, used to keep the control off trunk. */
  readonly branchName: string
  readonly className?: string | undefined
  /**
   * Whether the branch already has a pull request. The control stands down
   * for one, rather than offering to open a second.
   */
  readonly hasPullRequest: boolean
  readonly workspaceId: string
}

/**
 * Branches work merges into rather than branches work happens on.
 *
 * Matches the server's own base-ref candidates, so the branches it would pick
 * as a pull request's base are exactly the ones the control declines to offer
 * a pull request from.
 *
 * @see packages/server/src/lib/base-ref.ts
 */
const TRUNK_BRANCHES: ReadonlySet<string> = new Set(['dev', 'main', 'master'])

/** The steps the button can run, in the order git requires them. */
type GitStep = 'commit' | 'push' | 'createPr'

/** What the primary button does, given what the worktree still owes. */
interface QuickAction {
  readonly label: string
  readonly steps: readonly GitStep[]
}

/**
 * What a step is doing while it runs, in the operator's terms.
 *
 * A generated commit takes long enough to need naming: "Writing the commit
 * message" is what the wait is actually for, and calling it "Committing"
 * would make a model call look like a hung git command.
 */
function describeStep(step: GitStep, hasWrittenMessage: boolean): string {
  if (step === 'commit') {
    return hasWrittenMessage ? 'Committing…' : 'Writing the commit message…'
  }
  return step === 'push' ? 'Pushing…' : 'Writing the pull request…'
}

/**
 * The remaining journey to a pull request, named by its first step.
 *
 * Uncommitted work makes a commit the entry point and the rest follows from
 * it; committed work that has never been pushed starts at the push. A clean
 * branch with nothing ahead of its upstream has nothing to offer, and the
 * control disappears rather than presenting a dead button.
 */
function resolveQuickAction({
  aheadCount,
  hasChanges,
  hasUpstream,
}: {
  readonly aheadCount: number | null
  readonly hasChanges: boolean
  readonly hasUpstream: boolean
}): QuickAction | null {
  if (hasChanges) {
    return { label: 'Commit, push & PR', steps: ['commit', 'push', 'createPr'] }
  }

  // A branch with no upstream has never been published, so whatever it holds
  // is unreviewed by definition — the ahead count cannot say how much.
  if (!hasUpstream) {
    return { label: 'Push & PR', steps: ['push', 'createPr'] }
  }

  if ((aheadCount ?? 0) > 0) {
    return { label: 'Push & PR', steps: ['push', 'createPr'] }
  }

  return null
}

/**
 * The dialog for the times the operator wants to name the commit themselves.
 *
 * The field starts empty and submitting it empty is allowed, because a blank
 * message is not a missing one — it means the model writes it, same as the
 * primary button does.
 */
function CommitMessageDialog({
  isPending,
  message,
  onMessageChange,
  onOpenChange,
  onSubmit,
  open,
}: {
  readonly isPending: boolean
  readonly message: string
  readonly onMessageChange: (message: string) => void
  readonly onOpenChange: (open: boolean) => void
  readonly onSubmit: () => void
  readonly open: boolean
}) {
  const submitOnMetaEnter = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      onSubmit()
    }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Commit changes</DialogTitle>
          <DialogDescription>
            Everything in the worktree is staged and committed together — the
            same diff the workspace has been showing. Leave the message blank to
            have it written for you.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          // The dialog exists to collect this one value, so it takes the
          // focus the moment it opens.
          autoFocus
          data-testid="commit-message-input"
          onChange={(event) => onMessageChange(event.target.value)}
          onKeyDown={submitOnMetaEnter}
          placeholder="Leave blank to write it automatically"
          rows={3}
          value={message}
        />
        <DialogFooter>
          <Button
            data-testid="commit-message-submit"
            disabled={isPending}
            loading={isPending}
            onClick={onSubmit}
          >
            Commit
            <Kbd>⌘</Kbd>
            <Kbd>↵</Kbd>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function GitActionsControl({
  branchName,
  className,
  hasPullRequest,
  workspaceId,
}: GitActionsControlProps) {
  const isServerReady = useWhenPhase(LifecyclePhase.Ready)
  const { aheadCount, hasChanges, hasUpstream, isKnown } =
    useWorkspaceSyncStatus(workspaceId)
  const { commitWorkspace, createPullRequest, pushWorkspace } =
    useWorkspaceGitActions()
  const [runningLabel, setRunningLabel] = useState<string | null>(null)
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [commitMessage, setCommitMessage] = useState('')

  // Until git has answered, the workspace owes nothing that can be proven, so
  // the control stays out of the card rather than guessing at a first step.
  const quickAction = isKnown
    ? resolveQuickAction({ aheadCount, hasChanges, hasUpstream })
    : null

  if (quickAction === null || TRUNK_BRANCHES.has(branchName)) {
    return null
  }

  const isRunning = runningLabel !== null
  const canPush = hasUpstream ? (aheadCount ?? 0) > 0 : true

  /**
   * Run the steps in order, stopping at the first failure.
   *
   * One toast follows the whole run and is rewritten as each step starts, so
   * a chain that spends thirty seconds writing a pull request description
   * says so rather than sitting on a spinner.
   */
  const runSteps = async (
    steps: readonly GitStep[],
    label: string,
    message?: string
  ) => {
    const hasWrittenMessage = (message?.trim() ?? '') !== ''
    const toastId = toast.loading(
      describeStep(steps[0] ?? 'commit', hasWrittenMessage)
    )
    setRunningLabel(label)
    try {
      let prUrl: string | null = null
      for (const step of steps) {
        toast.loading(describeStep(step, hasWrittenMessage), { id: toastId })
        if (step === 'commit') {
          await commitWorkspace(workspaceId, message)
        } else if (step === 'push') {
          await pushWorkspace(workspaceId)
        } else {
          const pullRequest = await createPullRequest(workspaceId)
          prUrl = pullRequest.url
        }
      }
      const openable = prUrl
      toast.success(`${label} finished`, {
        id: toastId,
        ...(openable === null
          ? {}
          : {
              action: {
                label: 'View PR',
                onClick: () => {
                  localApi.openExternal(openable).catch(() => {
                    // The toast already reported the success this action is a
                    // convenience on; a failed hand-off to the browser is not
                    // worth a second one.
                  })
                },
              },
            }),
      })
    } catch (error: unknown) {
      toast.error(`${label} failed: ${extractErrorMessage(error)}`, {
        id: toastId,
      })
    } finally {
      setRunningLabel(null)
    }
  }

  const start = (
    steps: readonly GitStep[],
    label: string,
    message?: string
  ) => {
    runSteps(steps, label, message).catch(() => {
      // runSteps reports its own failures; nothing is left to handle here.
    })
  }

  return (
    <>
      <ButtonGroup className={cn('shrink-0', className)}>
        {hasPullRequest ? null : (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label={quickAction.label}
                  className="h-6 gap-1.5 px-1.5 text-xs [&>svg]:size-3.5"
                  data-testid="git-actions-quick-action"
                  disabled={!isServerReady || isRunning}
                  loading={isRunning}
                  onClick={() => start(quickAction.steps, quickAction.label)}
                  size="xs"
                  variant="outline"
                />
              }
            >
              <GitPullRequestArrow className="size-3.5" />
              <span>{runningLabel ?? quickAction.label}</span>
            </TooltipTrigger>
            <TooltipContent>
              {quickAction.label} for this workspace
            </TooltipContent>
          </Tooltip>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                aria-label="Git action options"
                className="h-6 w-6"
                data-testid="git-actions-menu-trigger"
                disabled={!isServerReady || isRunning}
                loading={isRunning && hasPullRequest}
                size="icon-xs"
                variant="outline"
              >
                <ChevronDown className="size-3.5" />
              </Button>
            }
          />
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              disabled={!hasChanges}
              onClick={() => setIsDialogOpen(true)}
            >
              <GitCommitHorizontal className="size-3.5" />
              Commit…
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!canPush}
              onClick={() => start(['push'], 'Push')}
            >
              <ArrowUpToLine className="size-3.5" />
              Push
            </DropdownMenuItem>
            {/* The branch already has its pull request; a second one is not an
                option worth listing. */}
            {hasPullRequest ? null : (
              <DropdownMenuItem
                // A pull request can only describe commits the remote has, so
                // it waits behind anything still uncommitted or unpushed.
                disabled={hasChanges || canPush}
                onClick={() => start(['createPr'], 'Create PR')}
              >
                <GitPullRequestArrow className="size-3.5" />
                Create PR
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </ButtonGroup>
      <CommitMessageDialog
        isPending={isRunning}
        message={commitMessage}
        onMessageChange={setCommitMessage}
        onOpenChange={setIsDialogOpen}
        onSubmit={() => {
          setIsDialogOpen(false)
          start(['commit'], 'Commit', commitMessage)
          setCommitMessage('')
        }}
        open={isDialogOpen}
      />
    </>
  )
}

export { GitActionsControl }
