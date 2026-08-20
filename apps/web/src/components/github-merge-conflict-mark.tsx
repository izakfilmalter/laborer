/**
 * Merge conflicts, reduced to a mark.
 *
 * A conflict is rare, binary, and always says the same sentence, so it costs
 * a chip's worth of the status rail to repeat that sentence on the few cards
 * that have one. It sits last — after the pull request and the workspace's own
 * state — because it is an obstacle to landing work, not a stage of it, and
 * carries its full sentence in a tooltip.
 *
 * When the project has saved a conflict prompt, the mark becomes the button
 * that clears the obstacle: it opens the workspace and starts a fresh agent on
 * that prompt, the same path a card takes when it is dragged into In Progress.
 * Without a prompt there is nothing to run, so the mark stays a plain status
 * mark rather than a button that does nothing.
 */

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@laborer/ui/components/tooltip'
import { GitCompareArrows } from 'lucide-react'
import type { MouseEvent } from 'react'
import { useProjectConflictPrompt } from '@/hooks/use-project-conflict-prompt'
import { usePanelActions } from '@/panels/panel-context'

const markClassName =
  'inline-flex size-5 shrink-0 items-center justify-center rounded-md border border-destructive/30 bg-destructive/10 text-destructive'

function ConflictStatusMark({ label }: { readonly label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger>
        <span aria-label={label} className={markClassName} role="img">
          <GitCompareArrows aria-hidden="true" className="size-3" />
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function ConflictActionMark({
  label,
  projectId,
  workspaceId,
}: {
  readonly label: string
  readonly projectId: string
  readonly workspaceId: string
}) {
  const conflictPrompt = useProjectConflictPrompt(projectId)
  const panelActions = usePanelActions()
  const openAgent = panelActions?.autoOpenAgentWhenWorkspaceReady

  if (conflictPrompt === null || openAgent === undefined) {
    return <ConflictStatusMark label={label} />
  }

  const actionLabel = `Resolve ${label.toLowerCase()}`

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            aria-label={actionLabel}
            className={`${markClassName} cursor-pointer transition-colors hover:border-destructive/60 hover:bg-destructive/20 focus-visible:outline-2 focus-visible:outline-destructive focus-visible:outline-offset-2`}
            data-testid="resolve-merge-conflict"
            onClick={(event: MouseEvent<HTMLButtonElement>) => {
              // The mark lives inside cards and headers that activate on
              // click; running the prompt should not also move focus for us.
              event.stopPropagation()
              openAgent(workspaceId, { initialPrompt: conflictPrompt })
            }}
            type="button"
          />
        }
      >
        <GitCompareArrows aria-hidden="true" className="size-3" />
      </TooltipTrigger>
      <TooltipContent>
        {`${label}. Run the project's conflict prompt in a new agent.`}
      </TooltipContent>
    </Tooltip>
  )
}

function GitHubMergeConflictMark({
  baseBranch,
  mergeStatus,
  projectId,
  workspaceId,
}: {
  readonly baseBranch: string | null
  readonly mergeStatus: 'clean' | 'conflicting' | 'unknown' | null
  /** Project whose saved conflict prompt the mark would run. */
  readonly projectId?: string | undefined
  /** Workspace the conflict agent opens in. */
  readonly workspaceId?: string | undefined
}) {
  if (mergeStatus !== 'conflicting') {
    return null
  }

  const label = `Conflicts with ${baseBranch ?? 'the base branch'}`

  if (projectId === undefined || workspaceId === undefined) {
    return <ConflictStatusMark label={label} />
  }

  return (
    <ConflictActionMark
      label={label}
      projectId={projectId}
      workspaceId={workspaceId}
    />
  )
}

export { GitHubMergeConflictMark }
