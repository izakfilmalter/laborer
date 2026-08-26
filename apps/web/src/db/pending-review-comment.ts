/**
 * The rows an in-flight review-comment write shows before the ledger echoes
 * it back.
 *
 * A review conversation is published as one whole row — thread plus its reply
 * chain — so an optimistic write has to produce that whole shape rather than a
 * fragment. Keeping the construction here, away from the mutation plumbing,
 * makes the reconciliation rule testable: the client mints the thread and
 * reply ids it sends, so the authoritative row that arrives on
 * `state.subscribe` replaces the optimistic one by key instead of
 * double-rendering beside it.
 */

import type {
  ReviewCommentReply,
  ReviewCommentSide,
  ReviewCommentThread,
} from '@laborer/shared/rpc'

export interface PendingReviewCommentThreadInput {
  readonly body: string
  readonly endLine: number
  readonly filePath: string
  /** Minted by the caller and sent as `id`, so the echo lands on this row. */
  readonly id: string
  readonly now: number
  /** Minted by the caller and sent as `replyId`. */
  readonly replyId: string
  readonly side: ReviewCommentSide
  readonly startLine: number
  readonly workspaceId: string
}

/**
 * The thread a just-opened conversation renders as. `revision` starts at 1
 * because that is what the server writes for a first insert; no client write
 * CASes against an optimistic revision — resolve and delete read the
 * authoritative row instead.
 */
export const pendingReviewCommentThread = (
  input: PendingReviewCommentThreadInput
): ReviewCommentThread => ({
  createdAt: input.now,
  endLine: input.endLine,
  filePath: input.filePath,
  id: input.id,
  replies: [
    {
      author: 'human',
      body: input.body,
      createdAt: input.now,
      id: input.replyId,
      threadId: input.id,
    },
  ],
  revision: 1,
  side: input.side,
  startLine: input.startLine,
  status: 'open',
  updatedAt: input.now,
  workspaceId: input.workspaceId,
})

/**
 * The thread as it reads with an unsent human reply appended.
 *
 * Replies are append-only and ordered oldest first, so an optimistic reply
 * goes on the end; when the authoritative row arrives it carries the same
 * reply id and simply replaces this one.
 */
export const withPendingReviewCommentReply = (
  thread: ReviewCommentThread,
  reply: {
    readonly body: string
    readonly id: string
    readonly now: number
  }
): ReviewCommentThread => ({
  ...thread,
  replies: [
    ...thread.replies,
    {
      author: 'human',
      body: reply.body,
      createdAt: reply.now,
      id: reply.id,
      threadId: thread.id,
    } satisfies ReviewCommentReply,
  ],
  updatedAt: reply.now,
})
