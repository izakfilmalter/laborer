/**
 * Asking someone to review, from the row that says who is already
 * reviewing. Ported from t3code's `PullRequestReviewerPicker.tsx`.
 *
 * The people who may be asked are read only once this opens: on a large
 * repository that is a list of everyone with access, which is worth a
 * request when somebody wants it and worth nothing on every pull request
 * they merely open.
 *
 * Laborer adaptations: the popup is the app's Popover rather than a Base
 * UI menu (an input inside a menu fights its typeahead), and permission is
 * `viewerCanWrite` — disabled with the reason rather than hidden.
 */
import {
  useAtomRefresh,
  useAtomSet,
  useAtomValue,
} from '@effect/atom-react/Hooks'
import type { PullRequestReviewerCandidate } from '@laborer/shared/rpc'
import { Button } from '@laborer/ui/components/button'
import { Input } from '@laborer/ui/components/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@laborer/ui/components/popover'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@laborer/ui/components/tooltip'
import { Cause } from 'effect'
import { AsyncResult as Result } from 'effect/unstable/reactivity'
import { Check, UserPlus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { extractErrorMessage } from '@/lib/errors'
import { toast } from '@/lib/toast'
import { readableFailure } from './detail-logic'
import { PullRequestPeopleGhost } from './ghosts'
import { PullRequestActorLabel } from './presentation'
import {
  pullRequestRequestReviewersMutation,
  pullRequestReviewerCandidatesQuery,
} from './queries'

/** Narrows only what arrived: GitHub is asked once, when the picker opens. */
function matches(
  candidate: PullRequestReviewerCandidate,
  query: string
): boolean {
  if (query.length === 0) {
    return true
  }
  const needle = query.toLowerCase()
  return (
    candidate.login.toLowerCase().includes(needle) ||
    (candidate.name ?? '').toLowerCase().includes(needle)
  )
}

/** Mounted only while the picker is open, so nothing is asked until then. */
function CandidatesList({
  workspaceId,
  query,
  pending,
  onToggle,
}: {
  workspaceId: string
  query: string
  pending: string | null
  onToggle: (candidate: PullRequestReviewerCandidate) => void
}) {
  const atom = useMemo(
    () => pullRequestReviewerCandidatesQuery(workspaceId),
    [workspaceId]
  )
  const result = useAtomValue(atom)

  if (Result.isFailure(result)) {
    return (
      <p className="p-2 text-muted-foreground text-xs">
        The people with access could not be read.{' '}
        {extractErrorMessage(Cause.squash(result.cause))}
      </p>
    )
  }
  if (!Result.isSuccess(result)) {
    return <PullRequestPeopleGhost rows={4} />
  }

  const candidates = result.value.candidates.filter((entry) =>
    matches(entry, query)
  )
  if (candidates.length === 0) {
    return (
      <p className="p-2 text-muted-foreground text-xs">
        {query.length > 0
          ? 'Nobody with access matches that.'
          : 'Nobody else has access to this repository.'}
      </p>
    )
  }
  return (
    <>
      {candidates.map((candidate) => (
        <button
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent/60 disabled:opacity-60"
          disabled={pending !== null}
          key={`${candidate.kind}:${candidate.id}`}
          onClick={() => onToggle(candidate)}
          type="button"
        >
          <PullRequestActorLabel
            actor={candidate}
            className="min-w-0 flex-1 truncate"
            tooltip={false}
          />
          {candidate.kind === 'team' ? (
            <span className="shrink-0 text-muted-foreground">team</span>
          ) : null}
          {candidate.isRequested ? (
            <Check aria-label="Already asked" className="size-3.5 shrink-0" />
          ) : null}
        </button>
      ))}
      {result.value.truncated ? (
        // Typing filters what arrived; it does not ask GitHub again.
        <p className="px-2 py-1.5 text-muted-foreground text-xs">
          This repository has more people with access than are listed here. Ask
          for the rest on GitHub.
        </p>
      ) : null}
    </>
  )
}

export function PullRequestReviewerPicker({
  workspaceId,
  allowed,
  onRequested,
}: {
  workspaceId: string
  /** False where GitHub would refuse this account's request — said, not hidden. */
  allowed: boolean
  /** The detail carries who is requested, so it is re-read once GitHub took it. */
  onRequested: () => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const requestReviewers = useAtomSet(pullRequestRequestReviewersMutation, {
    mode: 'promise',
  })
  const refreshCandidates = useAtomRefresh(
    pullRequestReviewerCandidatesQuery(workspaceId)
  )

  const toggle = async (candidate: PullRequestReviewerCandidate) => {
    if (pending !== null) {
      return
    }
    setPending(candidate.id)
    try {
      await requestReviewers({
        payload: {
          workspaceId,
          reviewers: [{ id: candidate.id, kind: candidate.kind }],
          requested: !candidate.isRequested,
        },
      })
    } catch (error) {
      setPending(null)
      toast.error(
        candidate.isRequested
          ? `Could not take back the review request to ${candidate.login}`
          : `Could not ask ${candidate.login} for a review`,
        {
          description: readableFailure(
            error,
            'GitHub refused it. Check that you have write access on this repository, and that they still have access to it.'
          ),
        }
      )
      return
    }
    setPending(null)
    toast.success(
      candidate.isRequested
        ? `Review request to ${candidate.login} taken back`
        : `Review requested from ${candidate.login}`
    )
    onRequested()
    refreshCandidates()
  }

  if (!allowed) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label="Request a review"
              disabled
              size="icon-xs"
              variant="ghost"
            >
              <UserPlus className="size-3.5" />
            </Button>
          }
        />
        <TooltipContent side="bottom">
          Asking someone to review needs write access on this repository
        </TooltipContent>
      </Tooltip>
    )
  }

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        render={
          <Button
            aria-label="Request a review"
            size="icon-xs"
            variant="ghost"
          />
        }
      >
        <UserPlus className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0" side="bottom">
        <div className="border-border/60 border-b p-2">
          <Input
            aria-label="Search people with access"
            autoFocus
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search people with access"
            value={query}
          />
        </div>
        <div className="max-h-72 overflow-y-auto p-1">
          {open ? (
            <CandidatesList
              onToggle={(candidate) => toggle(candidate)}
              pending={pending}
              query={query}
              workspaceId={workspaceId}
            />
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}
