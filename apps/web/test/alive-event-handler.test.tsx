/**
 * Tests for AliveEventHandler component.
 *
 * Verifies that when Alive events arrive, the component:
 * 1. Calls the correct RPC to fetch the individual item
 * 2. Dispatches the correct DOM event with the fetched data
 * 3. Falls back to alive:review-refresh on fetch failure
 * 4. Always triggers workspace.refreshPr for matching workspaces
 *
 * The system boundary is the Alive WebSocket (mocked via useAliveEvents)
 * and the RPC layer (mocked via useAtomSet).
 */

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Mock setup — must be before imports
// ---------------------------------------------------------------------------

/** Capture the onEvent callback from useAliveEvents so we can trigger events. */
let aliveEventHandler: ((event: unknown) => void) | null = null

vi.mock('@/hooks/use-alive-events', () => ({
  useAliveEvents: (handler: (event: unknown) => void) => {
    aliveEventHandler = handler
  },
}))

/** Mock LiveStore — return workspace list. */
const mockWorkspaces = [
  { id: 'ws-1', prNumber: 42 },
  { id: 'ws-2', prNumber: 99 },
]

vi.mock('@/livestore/store', () => ({
  useLaborerStore: () => ({
    useQuery: () => mockWorkspaces,
  }),
}))

/** Track RPC calls. Default to resolved promises so .then() chains don't break. */
const mockRefreshPr = vi.fn().mockResolvedValue(undefined)
const mockFetchIssueComment = vi.fn().mockResolvedValue({
  comment: { id: 0 },
  verdict: null,
})
const mockFetchReviewComment = vi.fn().mockResolvedValue({
  kind: 'comment',
  comment: { id: 0 },
})
const mockFetchReview = vi.fn().mockResolvedValue({
  reviewId: 0,
  state: 'COMMENTED',
  authorLogin: '',
  body: '',
})

vi.mock('@effect-atom/atom-react/Hooks', () => ({
  useAtomSet: (atom: symbol) => {
    switch (atom.description) {
      case 'workspace.refreshPr':
        return mockRefreshPr
      case 'review.fetchSingleIssueComment':
        return mockFetchIssueComment
      case 'review.fetchSingleReviewComment':
        return mockFetchReviewComment
      case 'review.fetchSingleReview':
        return mockFetchReview
      default:
        return vi.fn()
    }
  },
}))

vi.mock('@/atoms/laborer-client', () => ({
  LaborerClient: {
    mutation: (name: string) => Symbol(name),
  },
}))

// Import after mocks
import { AliveEventHandler } from '@/components/alive-event-handler'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  aliveEventHandler = null
})

describe('AliveEventHandler', () => {
  it('calls refreshPr for matching workspaces on any event', () => {
    render(<AliveEventHandler />)
    expect(aliveEventHandler).toBeTruthy()

    aliveEventHandler?.({
      type: 'pr-comment',
      subtype: 'issue-comment',
      pull_request_number: 42,
      comment_id: '3001',
      owner: 'acme',
      repo: 'repo',
      timestamp: Date.now(),
    })

    expect(mockRefreshPr).toHaveBeenCalledWith({
      payload: { workspaceId: 'ws-1' },
    })
    // ws-2 has prNumber 99, not 42
    expect(mockRefreshPr).toHaveBeenCalledTimes(1)
  })

  it('does not call any RPC when no workspace matches', () => {
    render(<AliveEventHandler />)

    aliveEventHandler?.({
      type: 'pr-comment',
      subtype: 'issue-comment',
      pull_request_number: 999,
      comment_id: '3001',
      owner: 'acme',
      repo: 'repo',
      timestamp: Date.now(),
    })

    expect(mockRefreshPr).not.toHaveBeenCalled()
    expect(mockFetchIssueComment).not.toHaveBeenCalled()
  })

  it('fetches a single issue comment on pr-comment (subtype: issue-comment)', async () => {
    const commentData = {
      comment: {
        id: 3001,
        commentType: 'issue',
        authorLogin: 'alice',
        body: 'LGTM',
      },
      verdict: null,
    }
    mockFetchIssueComment.mockResolvedValue(commentData)

    const events: CustomEvent[] = []
    const handler = (e: Event) => events.push(e as CustomEvent)
    window.addEventListener('alive:issue-comment', handler)

    render(<AliveEventHandler />)

    aliveEventHandler?.({
      type: 'pr-comment',
      subtype: 'issue-comment',
      pull_request_number: 42,
      comment_id: '3001',
      owner: 'acme',
      repo: 'repo',
      timestamp: Date.now(),
    })

    // Wait for the async fetch to resolve
    await vi.waitFor(() => {
      expect(events.length).toBe(1)
    })

    expect(mockFetchIssueComment).toHaveBeenCalledWith({
      payload: { workspaceId: 'ws-1', commentId: 3001 },
    })
    expect(events[0]?.detail.workspaceId).toBe('ws-1')
    expect(events[0]?.detail.comment.id).toBe(3001)
    expect(events[0]?.detail.verdict).toBeNull()

    window.removeEventListener('alive:issue-comment', handler)
  })

  it('fetches a single review comment on pr-comment (subtype: review-comment)', async () => {
    const commentData = {
      kind: 'comment',
      comment: {
        id: 4001,
        commentType: 'review',
        authorLogin: 'bob',
        body: 'Fix this',
      },
    }
    mockFetchReviewComment.mockResolvedValue(commentData)

    const events: CustomEvent[] = []
    const handler = (e: Event) => events.push(e as CustomEvent)
    window.addEventListener('alive:review-comment', handler)

    render(<AliveEventHandler />)

    aliveEventHandler?.({
      type: 'pr-comment',
      subtype: 'review-comment',
      pull_request_number: 42,
      comment_id: '4001',
      owner: 'acme',
      repo: 'repo',
      timestamp: Date.now(),
    })

    await vi.waitFor(() => {
      expect(events.length).toBe(1)
    })

    expect(mockFetchReviewComment).toHaveBeenCalledWith({
      payload: { workspaceId: 'ws-1', commentId: 4001 },
    })
    expect(events[0]?.detail.kind).toBe('comment')
    expect(events[0]?.detail.workspaceId).toBe('ws-1')

    window.removeEventListener('alive:review-comment', handler)
  })

  it('fetches a review on pr-review-submit', async () => {
    const reviewData = {
      reviewId: 9001,
      state: 'APPROVED',
      authorLogin: 'lead-dev',
      body: 'Ship it!',
    }
    mockFetchReview.mockResolvedValue(reviewData)

    const events: CustomEvent[] = []
    const handler = (e: Event) => events.push(e as CustomEvent)
    window.addEventListener('alive:review-submit', handler)

    render(<AliveEventHandler />)

    aliveEventHandler?.({
      type: 'pr-review-submit',
      pull_request_number: 42,
      review_id: '9001',
      state: 'APPROVED',
      owner: 'acme',
      repo: 'repo',
      timestamp: Date.now(),
    })

    await vi.waitFor(() => {
      expect(events.length).toBe(1)
    })

    expect(mockFetchReview).toHaveBeenCalledWith({
      payload: { workspaceId: 'ws-1', reviewId: 9001 },
    })
    expect(events[0]?.detail.state).toBe('APPROVED')
    expect(events[0]?.detail.workspaceId).toBe('ws-1')

    window.removeEventListener('alive:review-submit', handler)
  })

  it('dispatches alive:review-refresh when fetch fails', async () => {
    mockFetchIssueComment.mockRejectedValue(new Error('Network error'))

    const events: CustomEvent[] = []
    const handler = (e: Event) => events.push(e as CustomEvent)
    window.addEventListener('alive:review-refresh', handler)

    render(<AliveEventHandler />)

    aliveEventHandler?.({
      type: 'pr-comment',
      subtype: 'issue-comment',
      pull_request_number: 42,
      comment_id: '3001',
      owner: 'acme',
      repo: 'repo',
      timestamp: Date.now(),
    })

    await vi.waitFor(() => {
      expect(events.length).toBe(1)
    })

    expect(events[0]?.detail.workspaceId).toBe('ws-1')

    window.removeEventListener('alive:review-refresh', handler)
  })
})
