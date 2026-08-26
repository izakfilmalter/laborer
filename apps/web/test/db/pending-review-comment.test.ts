import type { ReviewCommentThread } from '@laborer/shared/rpc'
import { describe, expect, it } from 'vitest'
import {
  pendingReviewCommentThread,
  withPendingReviewCommentReply,
} from '@/db/pending-review-comment'

const input = {
  body: 'why this?',
  endLine: 9,
  filePath: 'src/example.ts',
  id: 'thread-one',
  now: 1000,
  replyId: 'reply-one',
  side: 'additions' as const,
  startLine: 4,
  workspaceId: 'workspace-one',
}

describe('pendingReviewCommentThread', () => {
  it('renders a whole thread, because rows travel whole', () => {
    expect(pendingReviewCommentThread(input)).toEqual({
      createdAt: 1000,
      endLine: 9,
      filePath: 'src/example.ts',
      id: 'thread-one',
      replies: [
        {
          author: 'human',
          body: 'why this?',
          createdAt: 1000,
          id: 'reply-one',
          threadId: 'thread-one',
        },
      ],
      revision: 1,
      side: 'additions',
      startLine: 4,
      status: 'open',
      updatedAt: 1000,
      workspaceId: 'workspace-one',
    } satisfies ReviewCommentThread)
  })

  it('keeps the ids the caller minted, which is what the echo lands on', () => {
    // `reviewComment.create` takes `id` and `replyId` precisely so the
    // optimistic row and the stored row are one row, replaced by key rather
    // than rendered twice side by side.
    const pending = pendingReviewCommentThread(input)
    expect(pending.id).toBe(input.id)
    expect(pending.replies[0]?.id).toBe(input.replyId)
    expect(pending.replies[0]?.threadId).toBe(input.id)
  })

  it('starts at the revision a first server insert writes', () => {
    // No client write CASes against this number — resolve and delete read the
    // authoritative row — but a wrong one here would still be a lie on screen.
    expect(pendingReviewCommentThread(input).revision).toBe(1)
  })

  it('opens a new conversation open, and authored by the human', () => {
    const pending = pendingReviewCommentThread(input)
    expect(pending.status).toBe('open')
    expect(pending.replies[0]?.author).toBe('human')
  })
})

describe('withPendingReviewCommentReply', () => {
  const stored = pendingReviewCommentThread(input)

  it('appends, because replies are append-only and read oldest first', () => {
    const replied = withPendingReviewCommentReply(stored, {
      body: 'because of the cache',
      id: 'reply-two',
      now: 2000,
    })
    expect(replied.replies.map(({ id }) => id)).toEqual([
      'reply-one',
      'reply-two',
    ])
    expect(replied.replies.at(-1)?.author).toBe('human')
    expect(replied.updatedAt).toBe(2000)
  })

  it('keeps an agent reply already on the thread', () => {
    // The agent writes over MCP while the pane is open, so an optimistic human
    // reply must not erase what arrived on the shared stream a moment ago.
    const withAgent: ReviewCommentThread = {
      ...stored,
      replies: [
        ...stored.replies,
        {
          author: 'agent',
          body: 'because of the cache',
          createdAt: 1500,
          id: 'agent-one',
          threadId: stored.id,
        },
      ],
    }
    const replied = withPendingReviewCommentReply(withAgent, {
      body: 'got it',
      id: 'reply-two',
      now: 2000,
    })
    expect(replied.replies.map(({ author }) => author)).toEqual([
      'human',
      'agent',
      'human',
    ])
  })

  it('leaves the thread it was given untouched', () => {
    withPendingReviewCommentReply(stored, {
      body: 'again',
      id: 'reply-three',
      now: 3000,
    })
    expect(stored.replies).toHaveLength(1)
    expect(stored.updatedAt).toBe(1000)
  })

  it('does not move status or revision, which only the server owns', () => {
    const replied = withPendingReviewCommentReply(stored, {
      body: 'again',
      id: 'reply-three',
      now: 3000,
    })
    expect(replied.status).toBe(stored.status)
    expect(replied.revision).toBe(stored.revision)
  })
})
