/**
 * The comments pane's honesty about how fresh it is.
 *
 * The pane is stale-while-revalidate, which is the right instinct and also
 * the easy way to lie: keeping the last good conversation on screen means a
 * revoked token or a deleted worktree can fail every poll for an hour while
 * the pane looks perfectly healthy. These tests pin the two readings that
 * must not collapse into each other — behind, and broken — plus the one
 * failure that is not a failure at all.
 */

import type { PullRequestConversation } from '@laborer/shared/rpc'
import { RpcError } from '@laborer/shared/rpc'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Option } from 'effect'
import { AsyncResult as Result } from 'effect/unstable/reactivity'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const RETRY_RE = /^Retry/
const STALE_RE = /Showing the last conversation read/

const refreshFn = vi.fn()
let currentResult: Result.AsyncResult<PullRequestConversation, RpcError> =
  Result.initial(true)

vi.mock('@effect/atom-react/Hooks', () => ({
  useAtomRefresh: () => refreshFn,
  useAtomValue: () => currentResult,
}))

// The pane builds its query atom at render time; the runtime never runs in
// jsdom, so `atom` only has to hand back a stable identity.
vi.mock('@/atoms/laborer-client', () => ({
  LaborerClient: {
    runtime: { atom: (effect: unknown) => effect },
  },
}))

vi.mock('@laborer/ui/lib/haptics', async () => {
  const { createHapticsStub } = await import('./haptics-stub')
  return { haptics: createHapticsStub() }
})

const { CommentsPane, POLL_INTERVAL_MS } = await import('@/panes/comments-pane')
const { GitHubConversationPreview } = await import(
  '@/components/github-conversation-hover-card'
)
const { GitHubPrStatusBadge } = await import(
  '@/components/github-pr-status-badge'
)

const conversation = (
  overrides: Partial<PullRequestConversation> = {}
): PullRequestConversation => ({
  comments: [
    {
      authorAvatarUrl: 'https://avatars.example/u/1',
      authorLogin: 'octocat',
      authorUrl: 'https://github.com/octocat',
      body: 'Looks good to me.',
      createdAt: '2026-08-20T11:00:00.000Z',
      filePath: null,
      id: 1,
      inReplyToId: null,
      kind: 'issue',
      line: null,
      reviewState: null,
      url: 'https://github.com/o/r/pull/1#issuecomment-1',
    },
  ],
  number: 42,
  title: 'Restore the pull request conversation',
  url: 'https://github.com/o/r/pull/1',
  ...overrides,
})

const rpcFailure = (message: string, code: string) =>
  Result.fail<RpcError, PullRequestConversation>(
    new RpcError({ message, code })
  )

const staleFailure = (message: string, code: string) =>
  Result.fail<RpcError, PullRequestConversation>(
    new RpcError({ message, code }),
    {
      previousSuccess: Option.some(Result.success(conversation())),
    }
  )

beforeEach(() => {
  refreshFn.mockClear()
  currentResult = Result.initial(true)
})

afterEach(cleanup)

describe('a read that fails after one succeeded', () => {
  it('keeps the conversation on screen', () => {
    currentResult = staleFailure('Bad credentials', 'GH_AUTH')
    render(<CommentsPane workspaceId="ws-1" />)

    expect(screen.getByText('Looks good to me.')).toBeTruthy()
  })

  it('says the conversation is behind, and how', () => {
    currentResult = staleFailure('Bad credentials', 'GH_AUTH')
    render(<CommentsPane workspaceId="ws-1" />)

    expect(screen.getByText(STALE_RE).textContent).toContain('Bad credentials')
  })

  it('offers a way to try again', () => {
    currentResult = staleFailure('Bad credentials', 'GH_AUTH')
    render(<CommentsPane workspaceId="ws-1" />)

    screen.getByRole('button', { name: RETRY_RE }).click()

    expect(refreshFn).toHaveBeenCalled()
  })

  it('reports it without claiming the whole pane', () => {
    currentResult = staleFailure('Bad credentials', 'GH_AUTH')
    render(<CommentsPane workspaceId="ws-1" />)

    expect(screen.queryByText('Could not read GitHub')).toBeNull()
  })
})

describe('a read that succeeds', () => {
  it('says nothing about staleness', () => {
    currentResult = Result.success(conversation())
    render(<CommentsPane workspaceId="ws-1" />)

    expect(screen.queryByText(STALE_RE)).toBeNull()
  })

  it('titles the pane with the pull request', () => {
    currentResult = Result.success(conversation())
    render(<CommentsPane workspaceId="ws-1" />)

    expect(
      screen.getByText('Restore the pull request conversation')
    ).toBeTruthy()
    expect(screen.getByText('#42')).toBeTruthy()
  })
})

describe('the task-card conversation preview', () => {
  it('opens promptly when the comment segment is hovered', () => {
    vi.useFakeTimers()
    currentResult = Result.success(conversation())

    render(
      <GitHubPrStatusBadge
        conversationWorkspaceId="ws-1"
        onOpenConversation={vi.fn()}
        prNumber={42}
        prState="OPEN"
        prTitle="Restore the pull request conversation"
        prUrl="https://github.com/o/r/pull/1"
        unresolvedThreads={1}
      />
    )

    fireEvent.mouseEnter(screen.getByLabelText('1 unresolved conversation'))
    act(() => vi.advanceTimersByTime(200))
    vi.useRealTimers()

    expect(screen.getByText('Looks good to me.')).toBeTruthy()
  })

  it('shows the newest remarks first without mounting the full pane', () => {
    const comments = Array.from({ length: 5 }, (_, index) => ({
      ...conversation().comments[0],
      body: `Comment ${index + 1}`,
      id: index + 1,
    }))
    currentResult = Result.success(conversation({ comments }))

    render(<GitHubConversationPreview now={Date.now()} workspaceId="ws-1" />)

    const cards = screen.getAllByTestId('pr-comment')
    expect(cards).toHaveLength(3)
    expect(cards[0]?.textContent).toContain('Comment 5')
    expect(cards[2]?.textContent).toContain('Comment 3')
    expect(screen.queryByText('Comment 2')).toBeNull()
    expect(
      screen.getByText('5 comments · Click to open the panel')
    ).toBeTruthy()
  })
})

describe('a branch with no pull request', () => {
  it('reads as work not yet opened, not as a failure', () => {
    currentResult = rpcFailure(
      'No pull request for this branch',
      'PR_NOT_FOUND'
    )
    render(<CommentsPane workspaceId="ws-1" />)

    expect(screen.getByText('No pull request yet')).toBeTruthy()
    expect(screen.queryByText('Could not read GitHub')).toBeNull()
  })
})

describe('a first read that fails', () => {
  it('is the whole pane, because there is nothing behind it', () => {
    currentResult = rpcFailure('Bad credentials', 'GH_AUTH')
    render(<CommentsPane workspaceId="ws-1" />)

    expect(screen.getByText('Could not read GitHub')).toBeTruthy()
    expect(screen.getByText('Bad credentials')).toBeTruthy()
    expect(screen.queryByText(STALE_RE)).toBeNull()
  })
})

/**
 * The timeline is oldest-first, so where it opens decides whether the pane
 * answers the question that made someone open it.
 */
describe('opening the timeline', () => {
  const VIEWPORT_HEIGHT = 500
  let scrollHeightDescriptor: PropertyDescriptor | undefined

  const viewport = () =>
    document.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement

  beforeEach(() => {
    // jsdom does no layout, so nothing is scrollable until it is told how
    // tall the content is.
    scrollHeightDescriptor = Object.getOwnPropertyDescriptor(
      Element.prototype,
      'scrollHeight'
    )
    Object.defineProperty(Element.prototype, 'scrollHeight', {
      configurable: true,
      get: () => VIEWPORT_HEIGHT,
    })
  })

  afterEach(() => {
    if (scrollHeightDescriptor) {
      Object.defineProperty(
        Element.prototype,
        'scrollHeight',
        scrollHeightDescriptor
      )
    }
  })

  it('starts at the newest comment, not three weeks ago', () => {
    currentResult = Result.success(conversation())
    render(<CommentsPane workspaceId="ws-1" />)

    expect(viewport().scrollTop).toBe(VIEWPORT_HEIGHT)
  })

  it('leaves a reader where they are when a poll lands', () => {
    currentResult = Result.success(conversation())
    const { rerender } = render(<CommentsPane workspaceId="ws-1" />)

    // Someone scrolls back up to read an older comment.
    viewport().scrollTop = 120

    currentResult = Result.success(
      conversation({
        comments: [
          ...conversation().comments,
          { ...conversation().comments[0], body: 'Ship it.', id: 2 },
        ],
      })
    )
    rerender(<CommentsPane workspaceId="ws-1" />)

    expect(viewport().scrollTop).toBe(120)
  })
})

/**
 * Every poll costs three paginated `gh api` calls against a 5,000/hour
 * budget shared with the rest of the app, so a tiled layout of panes can
 * spend it on nothing. What the loop declines to do matters more than what
 * it does.
 */
describe('polling', () => {
  const setVisibility = (state: 'hidden' | 'visible') => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => state,
    })
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
  }

  // The pane also ticks a clock to keep rendered ages honest, so advancing
  // time re-renders and has to happen inside `act`.
  const advance = (ms: number) => {
    act(() => {
      vi.advanceTimersByTime(ms)
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    setVisibility('visible')
  })

  afterEach(() => {
    vi.useRealTimers()
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })
  })

  it('re-reads on the base interval while the pane is visible', () => {
    currentResult = Result.success(conversation())
    render(<CommentsPane workspaceId="ws-1" />)

    advance(POLL_INTERVAL_MS)

    expect(refreshFn).toHaveBeenCalledTimes(1)
  })

  it('spends nothing while the document is hidden', () => {
    currentResult = Result.success(conversation())
    render(<CommentsPane workspaceId="ws-1" />)

    setVisibility('hidden')
    advance(POLL_INTERVAL_MS * 10)

    expect(refreshFn).not.toHaveBeenCalled()
  })

  it('catches up as soon as a stale pane is looked at again', () => {
    currentResult = Result.success(conversation())
    render(<CommentsPane workspaceId="ws-1" />)

    setVisibility('hidden')
    advance(POLL_INTERVAL_MS * 10)
    setVisibility('visible')
    advance(0)

    expect(refreshFn).toHaveBeenCalledTimes(1)
  })

  it('does not read again early for a pane hidden only briefly', () => {
    currentResult = Result.success(conversation())
    render(<CommentsPane workspaceId="ws-1" />)

    setVisibility('hidden')
    setVisibility('visible')
    advance(0)

    expect(refreshFn).not.toHaveBeenCalled()
  })

  it('widens the gap after a failure instead of hammering the budget', () => {
    currentResult = staleFailure('Bad credentials', 'GH_AUTH')
    render(<CommentsPane workspaceId="ws-1" />)

    // One failure doubles the interval, so the base interval passes with
    // nothing spent on an answer that is not going to change.
    advance(POLL_INTERVAL_MS)
    expect(refreshFn).not.toHaveBeenCalled()

    advance(POLL_INTERVAL_MS)
    expect(refreshFn).toHaveBeenCalledTimes(1)
  })
})
