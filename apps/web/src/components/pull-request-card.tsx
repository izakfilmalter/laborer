/**
 * A pull request that is open on the remote but has no worktree here.
 *
 * The sidebar's author heading gathers what somebody has open. Half of that is
 * branches already pulled in, which are ordinary workspace cards; the other
 * half is this — the same branch, named the same way, sitting in the same
 * list, but with nothing local behind it yet. Showing it as a card rather than
 * omitting it is what turns "here is what I have of theirs" into "here is what
 * they have", and makes the gap between the two a thing you can point at.
 *
 * It says so quietly. A dashed edge and a muted surface read as an outline of
 * a card rather than a card, which is what a branch with no worktree, no
 * terminals, and no local status actually is. One action fills it in.
 *
 * @see apps/web/src/components/workspace-card.tsx — what this becomes
 */

import type { OpenPullRequest } from '@laborer/shared/rpc'
import { Button } from '@laborer/ui/components/button'
import { Spinner } from '@laborer/ui/components/spinner'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@laborer/ui/components/tooltip'
import { CloudDownload, GitPullRequest } from 'lucide-react'
import { useState } from 'react'
import { CardDescriptionHover } from '@/components/card-description-hover'
import { CardShell } from '@/components/card-shell'
import { CopyableValue } from '@/components/copyable-value'
import { GitHubPrStatusBadge } from '@/components/github-pr-status-badge'
import type { PendingWorkspaceCreationChangeHandler } from '@/hooks/use-create-workspace'
import { useCreateWorkspace } from '@/hooks/use-create-workspace'
import { extractErrorMessage } from '@/lib/errors'
import { toast } from '@/lib/toast'

/**
 * Check a pull request's branch out into a workspace.
 *
 * This is ordinary workspace creation with the branch name filled in: the
 * server already reuses an existing branch on origin rather than starting a
 * new one, so pulling a pull request in is the same operation as typing its
 * branch name into the composer, minus the typing.
 */
function PullInPullRequestButton({
  branchName,
  onPendingCreationChange,
  projectId,
}: {
  readonly branchName: string
  readonly onPendingCreationChange?:
    | PendingWorkspaceCreationChangeHandler
    | undefined
  readonly projectId: string
}) {
  const createWorkspace = useCreateWorkspace(onPendingCreationChange)
  const [isPulling, setIsPulling] = useState(false)

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={`Pull in ${branchName}`}
            disabled={isPulling}
            onClick={async () => {
              setIsPulling(true)
              try {
                await createWorkspace({
                  branchNameOrSlackUrl: branchName,
                  projectId,
                })
                toast.success(`Workspace "${branchName}" is being set up`)
              } catch (error: unknown) {
                toast.error(extractErrorMessage(error))
              } finally {
                setIsPulling(false)
              }
            }}
            size="icon-xs"
            variant="ghost"
          />
        }
      >
        {isPulling ? (
          <Spinner className="size-3.5" />
        ) : (
          <CloudDownload className="size-3.5 text-muted-foreground" />
        )}
      </TooltipTrigger>
      <TooltipContent>Pull in branch</TooltipContent>
    </Tooltip>
  )
}

function PullRequestCard({
  onPendingCreationChange,
  projectId,
  pullRequest,
}: {
  readonly onPendingCreationChange?:
    | PendingWorkspaceCreationChangeHandler
    | undefined
  readonly projectId: string
  readonly pullRequest: OpenPullRequest
}) {
  return (
    <CardShell
      actions={
        <PullInPullRequestButton
          branchName={pullRequest.branchName}
          onPendingCreationChange={onPendingCreationChange}
          projectId={projectId}
        />
      }
      badges={
        <GitHubPrStatusBadge
          prIsDraft={pullRequest.isDraft}
          prNumber={pullRequest.number}
          prState="open"
          prTitle={pullRequest.title}
          prUrl={pullRequest.url}
        />
      }
      // Dashed and dimmed: an outline of a card, because that is what a
      // branch with no worktree behind it is. It fills in once pulled in.
      className="border-dashed bg-transparent opacity-80 transition-opacity hover:opacity-100"
      data-testid={`pull-request-card-${pullRequest.branchName}`}
      icon={
        <GitPullRequest className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      }
      subtitle={
        <p className="truncate text-muted-foreground text-xs">
          Not pulled in yet
        </p>
      }
      title={
        <CardDescriptionHover
          description={pullRequest.body}
          heading={`What #${pullRequest.number} is for`}
        >
          <span className="block min-w-0 font-mono">
            <CopyableValue
              copyLabel="Copy branch name"
              value={pullRequest.branchName}
            />
          </span>
        </CardDescriptionHover>
      }
    />
  )
}

export { PullRequestCard }
