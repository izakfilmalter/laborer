/**
 * The review form floated over the Code tab: how many comments the review
 * is holding, its summary, and the verdict that sends the lot. Ported from
 * t3code's `PullRequestReviewBar.tsx`. The card frame belongs to the
 * caller, which is why this only contributes its own padding.
 */
import { useAtomSet } from '@effect/atom-react/Hooks'
import type { PullRequestReviewVerdict } from '@laborer/shared/rpc'
import { Button } from '@laborer/ui/components/button'
import { Textarea } from '@laborer/ui/components/textarea'
import { Check, MessageSquare, XCircle } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { toast } from '@/lib/toast'
import { readableFailure } from './detail-logic'
import { pullRequestSubmitReviewMutation } from './queries'
import {
  usePendingReviewComments,
  usePullRequestReviewStore,
} from './review-store'

const VERDICTS: readonly {
  readonly value: PullRequestReviewVerdict
  readonly label: string
  readonly sent: string
  readonly icon: ReactNode
}[] = [
  {
    value: 'comment',
    label: 'Comment',
    sent: 'Review submitted',
    icon: <MessageSquare className="size-3" />,
  },
  {
    value: 'approve',
    label: 'Approve',
    sent: 'Pull request approved',
    icon: <Check className="size-3" />,
  },
  {
    value: 'requestChanges',
    label: 'Request changes',
    sent: 'Changes requested',
    icon: <XCircle className="size-3" />,
  },
]

export function PullRequestReviewBar({
  workspaceId,
  onSubmitted,
}: {
  workspaceId: string
  onSubmitted: () => void
}) {
  const [pending, setPending] = useState(false)
  const comments = usePendingReviewComments(workspaceId)
  const body = usePullRequestReviewStore(
    (store) => store.summaries[workspaceId] ?? ''
  )
  const clear = usePullRequestReviewStore((store) => store.clear)
  const removeComments = usePullRequestReviewStore(
    (store) => store.removeComments
  )
  const setSummary = usePullRequestReviewStore((store) => store.setSummary)
  const clearSummary = usePullRequestReviewStore((store) => store.clearSummary)
  const submitReview = useAtomSet(pullRequestSubmitReviewMutation, {
    mode: 'promise',
  })

  const submit = async (verdict: (typeof VERDICTS)[number]) => {
    if (pending) {
      return
    }
    const submittedBody = body
    const submittedComments = comments
    setPending(true)
    try {
      await submitReview({
        payload: {
          workspaceId,
          verdict: verdict.value,
          body: submittedBody,
          comments: submittedComments.map(({ id: _id, ...comment }) => comment),
        },
      })
    } catch (error) {
      setPending(false)
      // The draft is kept: whatever went wrong, retyping is not the answer.
      toast.error('The review could not be submitted', {
        description: readableFailure(
          error,
          'GitHub refused the review. Check that you are not approving your own pull request.'
        ),
      })
      return
    }
    setPending(false)
    // More remarks may have been added while GitHub was accepting this
    // snapshot. Leave those ready for the next review.
    removeComments(
      workspaceId,
      submittedComments.map((comment) => comment.id)
    )
    clearSummary(workspaceId, submittedBody)
    toast.success(verdict.sent)
    onSubmitted()
  }

  // An approval needs no words; anything else does, unless it carries line comments.
  const canSubmit = (verdict: PullRequestReviewVerdict) =>
    verdict === 'approve' || body.trim().length > 0 || comments.length > 0

  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-2 text-muted-foreground text-xs">
        <span>
          {comments.length === 0
            ? 'No line comments yet'
            : `${comments.length} ${comments.length === 1 ? 'comment' : 'comments'} pending`}
        </span>
        {comments.length > 0 ? (
          <Button
            disabled={pending}
            onClick={() => clear(workspaceId)}
            size="xs"
            variant="ghost"
          >
            Discard
          </Button>
        ) : null}
      </div>
      <Textarea
        aria-label="Review summary"
        className="mt-2"
        onChange={(event) => setSummary(workspaceId, event.target.value)}
        placeholder="Summarize your review (optional)"
        value={body}
      />
      <div className="mt-2 flex flex-wrap justify-end gap-2">
        {VERDICTS.map((verdict) => (
          <Button
            disabled={pending || !canSubmit(verdict.value)}
            key={verdict.value}
            onClick={() => submit(verdict)}
            size="xs"
            variant={verdict.value === 'comment' ? 'outline' : 'default'}
          >
            <span className="flex items-center gap-1.5">
              {verdict.icon}
              {verdict.label}
            </span>
          </Button>
        ))}
      </div>
    </div>
  )
}
