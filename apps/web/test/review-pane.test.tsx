/**
 * Tests for ReviewPane component.
 *
 * Verifies that the review pane correctly renders fetched PR comments and
 * findings in grouped sections with severity badges. Tests loading, empty,
 * and error states, finding cards with severity sorting, collapsible
 * suggested fixes, comment cards with author info, polling behavior, and
 * manual refresh.
 *
 * @see Issue #5: Grouped display with severity badges
 * @see Issue #6: Polling + manual refresh
 */

import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type ResultState =
  | { _tag: 'Initial'; waiting: boolean }
  | { _tag: 'Failure'; waiting: boolean; cause: unknown }
  | { _tag: 'Success'; waiting: boolean; value: unknown }

let currentResult: ResultState = { _tag: 'Initial', waiting: true }
const mockRefresh = vi.fn()

vi.mock('@effect-atom/atom-react/Hooks', () => ({
  useAtomValue: () => currentResult,
  useAtomRefresh: () => mockRefresh,
}))

vi.mock('@/atoms/laborer-client', () => ({
  LaborerClient: {
    query: () => Symbol.for('query:review.fetchComments'),
  },
}))

vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children, ...props }: React.PropsWithChildren) => (
    <div data-testid="scroll-area" {...props}>
      {children}
    </div>
  ),
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}))

vi.mock('@/components/ui/avatar', () => ({
  Avatar: ({ children, ...props }: React.PropsWithChildren) => (
    <div data-testid="avatar" {...props}>
      {children}
    </div>
  ),
  AvatarImage: ({ alt, src }: { alt: string; src: string }) => (
    <img
      alt={alt}
      data-testid="avatar-image"
      height={24}
      src={src}
      width={24}
    />
  ),
  AvatarFallback: ({ children }: React.PropsWithChildren) => (
    <span data-testid="avatar-fallback">{children}</span>
  ),
}))

import { ReviewPane } from '../src/panes/review-pane'

const NO_PR_MESSAGE_RE = /No pull request was found for this workspace's branch/
const SRC_PATH_RE = /src\//

const ISSUE_COMMENT = {
  id: 1,
  commentType: 'issue' as const,
  authorLogin: 'octocat',
  authorAvatarUrl: 'https://github.com/octocat.png',
  body: 'Looks good to me!',
  filePath: null,
  line: null,
  createdAt: '2026-03-10T12:00:00Z',
  reactions: [],
}

const REVIEW_COMMENT = {
  id: 2,
  commentType: 'review' as const,
  authorLogin: 'reviewer',
  authorAvatarUrl: 'https://github.com/reviewer.png',
  body: 'This function should handle the edge case.',
  filePath: 'src/utils/parser.ts',
  line: 42,
  createdAt: '2026-03-10T14:30:00Z',
  reactions: [],
}

const REVIEW_COMMENT_NO_LINE = {
  id: 3,
  commentType: 'review' as const,
  authorLogin: 'dev',
  authorAvatarUrl: 'https://github.com/dev.png',
  body: 'Consider refactoring this module.',
  filePath: 'src/index.ts',
  line: null,
  createdAt: '2026-03-10T15:00:00Z',
  reactions: [],
}

const CRITICAL_FINDING = {
  id: 'sql-injection',
  file: 'src/db/query.ts',
  line: 15,
  severity: 'critical' as const,
  description: 'SQL injection vulnerability in user input handling.',
  suggestedFixes: [
    'Use parameterized queries instead of string concatenation.',
    'Validate and sanitize user input before use.',
  ],
  category: 'security',
  dependsOn: [],
  commentId: 100,
  reactions: [],
}

const WARNING_FINDING = {
  id: 'missing-error-handling',
  file: 'src/api/handler.ts',
  line: 42,
  severity: 'warning' as const,
  description: 'Missing error handling for network request.',
  suggestedFixes: ['Wrap the fetch call in a try-catch block.'],
  category: 'correctness',
  dependsOn: [],
  commentId: 101,
  reactions: [],
}

const INFO_FINDING = {
  id: 'naming-convention',
  file: 'src/utils/helpers.ts',
  line: 8,
  severity: 'info' as const,
  description: 'Function name does not follow camelCase convention.',
  suggestedFixes: [],
  category: null,
  dependsOn: [],
  commentId: 102,
  reactions: [],
}

describe('ReviewPane', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  beforeEach(() => {
    currentResult = { _tag: 'Initial', waiting: true }
    mockRefresh.mockReset()
  })

  it('renders loading state during initial fetch', () => {
    currentResult = { _tag: 'Initial', waiting: true }
    render(<ReviewPane workspaceId="ws-1" />)

    expect(screen.getByText('Loading comments...')).toBeTruthy()
    expect(screen.getByRole('status')).toBeTruthy() // Spinner has role="status"
  })

  it('renders loading state when waiting for data', () => {
    currentResult = { _tag: 'Initial', waiting: true }
    render(<ReviewPane workspaceId="ws-1" />)

    expect(screen.getByText('Loading comments...')).toBeTruthy()
  })

  it('renders empty state when no PR exists', () => {
    currentResult = {
      _tag: 'Failure',
      waiting: false,
      cause: { code: 'PR_NOT_FOUND', message: 'No PR found' },
    }
    render(<ReviewPane workspaceId="ws-1" />)

    expect(screen.getByText('No pull request')).toBeTruthy()
    expect(screen.getByText(NO_PR_MESSAGE_RE)).toBeTruthy()
  })

  it('renders error state when RPC fails', () => {
    currentResult = {
      _tag: 'Failure',
      waiting: false,
      cause: { message: 'Authentication required' },
    }
    render(<ReviewPane workspaceId="ws-1" />)

    expect(screen.getByText('Failed to load comments')).toBeTruthy()
    expect(screen.getByText('Authentication required')).toBeTruthy()
  })

  it('renders comments with author info and body in Comments section', () => {
    currentResult = {
      _tag: 'Success',
      waiting: false,
      value: {
        verdict: null,
        findings: [],
        comments: [ISSUE_COMMENT],
      },
    }
    render(<ReviewPane workspaceId="ws-1" />)

    expect(screen.getByText('Comments')).toBeTruthy()
    expect(screen.getByText('octocat')).toBeTruthy()
    expect(screen.getByText('Looks good to me!')).toBeTruthy()
    expect(screen.getByTestId('avatar-image').getAttribute('src')).toBe(
      'https://github.com/octocat.png'
    )
  })

  it('renders inline review comments with file path and line number', () => {
    currentResult = {
      _tag: 'Success',
      waiting: false,
      value: {
        verdict: null,
        findings: [],
        comments: [REVIEW_COMMENT],
      },
    }
    render(<ReviewPane workspaceId="ws-1" />)

    expect(screen.getByText('reviewer')).toBeTruthy()
    expect(
      screen.getByText('This function should handle the edge case.')
    ).toBeTruthy()
    expect(screen.getByText('src/utils/parser.ts:42')).toBeTruthy()
  })

  it('renders file path without line number when line is null', () => {
    currentResult = {
      _tag: 'Success',
      waiting: false,
      value: {
        verdict: null,
        findings: [],
        comments: [REVIEW_COMMENT_NO_LINE],
      },
    }
    render(<ReviewPane workspaceId="ws-1" />)

    expect(screen.getByText('src/index.ts')).toBeTruthy()
  })

  it('does not show file reference for issue comments', () => {
    currentResult = {
      _tag: 'Success',
      waiting: false,
      value: {
        verdict: null,
        findings: [],
        comments: [ISSUE_COMMENT],
      },
    }
    render(<ReviewPane workspaceId="ws-1" />)

    // Issue comments have no file path, so no FileCode icon / reference
    expect(screen.queryByText(SRC_PATH_RE)).toBeNull()
  })

  it('renders multiple comments', () => {
    currentResult = {
      _tag: 'Success',
      waiting: false,
      value: {
        verdict: null,
        findings: [],
        comments: [ISSUE_COMMENT, REVIEW_COMMENT, REVIEW_COMMENT_NO_LINE],
      },
    }
    render(<ReviewPane workspaceId="ws-1" />)

    expect(screen.getByText('octocat')).toBeTruthy()
    expect(screen.getByText('reviewer')).toBeTruthy()
    expect(screen.getByText('dev')).toBeTruthy()
  })

  it('renders empty state when PR has no comments or findings', () => {
    currentResult = {
      _tag: 'Success',
      waiting: false,
      value: {
        verdict: null,
        findings: [],
        comments: [],
      },
    }
    render(<ReviewPane workspaceId="ws-1" />)

    expect(screen.getByText('No comments yet')).toBeTruthy()
  })

  it('renders the review header bar', () => {
    currentResult = { _tag: 'Initial', waiting: true }
    render(<ReviewPane workspaceId="ws-1" />)

    expect(screen.getByText('Review')).toBeTruthy()
  })

  // -------------------------------------------------------------------------
  // Issue #5: Grouped display with severity badges
  // -------------------------------------------------------------------------

  it('renders findings with correct severity badges', () => {
    currentResult = {
      _tag: 'Success',
      waiting: false,
      value: {
        verdict: null,
        findings: [CRITICAL_FINDING, WARNING_FINDING, INFO_FINDING],
        comments: [],
      },
    }
    render(<ReviewPane workspaceId="ws-1" />)

    expect(screen.getByText('critical')).toBeTruthy()
    expect(screen.getByText('warning')).toBeTruthy()
    expect(screen.getByText('info')).toBeTruthy()
  })

  it('renders finding cards with file:line reference, category, and description', () => {
    currentResult = {
      _tag: 'Success',
      waiting: false,
      value: {
        verdict: null,
        findings: [CRITICAL_FINDING],
        comments: [],
      },
    }
    render(<ReviewPane workspaceId="ws-1" />)

    expect(screen.getByText('src/db/query.ts:15')).toBeTruthy()
    expect(screen.getByText('security')).toBeTruthy()
    expect(
      screen.getByText('SQL injection vulnerability in user input handling.')
    ).toBeTruthy()
  })

  it('renders Findings and Comments as separate grouped sections', () => {
    currentResult = {
      _tag: 'Success',
      waiting: false,
      value: {
        verdict: null,
        findings: [WARNING_FINDING],
        comments: [ISSUE_COMMENT],
      },
    }
    render(<ReviewPane workspaceId="ws-1" />)

    expect(screen.getByText('Findings')).toBeTruthy()
    expect(screen.getByText('Comments')).toBeTruthy()
  })

  it('shows section counts in badges', () => {
    currentResult = {
      _tag: 'Success',
      waiting: false,
      value: {
        verdict: null,
        findings: [CRITICAL_FINDING, WARNING_FINDING],
        comments: [ISSUE_COMMENT, REVIEW_COMMENT, REVIEW_COMMENT_NO_LINE],
      },
    }
    render(<ReviewPane workspaceId="ws-1" />)

    // Findings section trigger should show count 2
    const findingsTrigger = screen.getByTestId('section-trigger-findings')
    expect(within(findingsTrigger).getByText('2')).toBeTruthy()

    // Comments section trigger should show count 3
    const commentsTrigger = screen.getByTestId('section-trigger-comments')
    expect(within(commentsTrigger).getByText('3')).toBeTruthy()
  })

  it('sorts findings by severity: critical first, then warning, then info', () => {
    currentResult = {
      _tag: 'Success',
      waiting: false,
      value: {
        verdict: null,
        // Provide findings in reverse order
        findings: [INFO_FINDING, WARNING_FINDING, CRITICAL_FINDING],
        comments: [],
      },
    }
    render(<ReviewPane workspaceId="ws-1" />)

    const findingCards = screen.getAllByTestId('finding-card')
    expect(findingCards).toHaveLength(3)

    const firstCard = findingCards[0]
    const secondCard = findingCards[1]
    const thirdCard = findingCards[2]

    if (!(firstCard && secondCard && thirdCard)) {
      throw new Error('Expected 3 finding cards')
    }

    // First card should be the critical finding
    expect(within(firstCard).getByText('critical')).toBeTruthy()
    // Second card should be the warning finding
    expect(within(secondCard).getByText('warning')).toBeTruthy()
    // Third card should be the info finding
    expect(within(thirdCard).getByText('info')).toBeTruthy()
  })

  it('renders collapsible suggested fixes on finding cards', async () => {
    currentResult = {
      _tag: 'Success',
      waiting: false,
      value: {
        verdict: null,
        findings: [CRITICAL_FINDING],
        comments: [],
      },
    }
    render(<ReviewPane workspaceId="ws-1" />)

    // The trigger should be visible
    const trigger = screen.getByTestId('suggested-fixes-trigger')
    expect(trigger).toBeTruthy()
    expect(screen.getByText('Suggested fixes (2)')).toBeTruthy()

    // Click to expand
    const user = userEvent.setup()
    await user.click(trigger)

    // Suggested fixes should now be visible
    expect(
      screen.getByText(
        'Use parameterized queries instead of string concatenation.'
      )
    ).toBeTruthy()
    expect(
      screen.getByText('Validate and sanitize user input before use.')
    ).toBeTruthy()
  })

  it('does not show suggested fixes trigger when no fixes exist', () => {
    currentResult = {
      _tag: 'Success',
      waiting: false,
      value: {
        verdict: null,
        findings: [INFO_FINDING],
        comments: [],
      },
    }
    render(<ReviewPane workspaceId="ws-1" />)

    expect(screen.queryByTestId('suggested-fixes-trigger')).toBeNull()
  })

  it('does not render Findings section when there are no findings', () => {
    currentResult = {
      _tag: 'Success',
      waiting: false,
      value: {
        verdict: null,
        findings: [],
        comments: [ISSUE_COMMENT],
      },
    }
    render(<ReviewPane workspaceId="ws-1" />)

    expect(screen.queryByText('Findings')).toBeNull()
    expect(screen.getByText('Comments')).toBeTruthy()
  })

  it('does not render Comments section when there are no comments', () => {
    currentResult = {
      _tag: 'Success',
      waiting: false,
      value: {
        verdict: null,
        findings: [CRITICAL_FINDING],
        comments: [],
      },
    }
    render(<ReviewPane workspaceId="ws-1" />)

    expect(screen.getByText('Findings')).toBeTruthy()
    expect(screen.queryByText('Comments')).toBeNull()
  })

  it('renders finding without category when category is null', () => {
    currentResult = {
      _tag: 'Success',
      waiting: false,
      value: {
        verdict: null,
        findings: [INFO_FINDING],
        comments: [],
      },
    }
    render(<ReviewPane workspaceId="ws-1" />)

    // INFO_FINDING has category: null, so no category badge
    // Only severity badge should be in the badge row
    const findingCard = screen.getByTestId('finding-card')
    expect(within(findingCard).getByText('info')).toBeTruthy()
    // Should not have security/correctness/etc
    expect(within(findingCard).queryByText('security')).toBeNull()
    expect(within(findingCard).queryByText('correctness')).toBeNull()
  })

  it('renders severity badges with correct data-severity attributes', () => {
    currentResult = {
      _tag: 'Success',
      waiting: false,
      value: {
        verdict: null,
        findings: [CRITICAL_FINDING, WARNING_FINDING, INFO_FINDING],
        comments: [],
      },
    }
    render(<ReviewPane workspaceId="ws-1" />)

    const criticalBadge = screen.getByText('critical')
    expect(criticalBadge.getAttribute('data-severity')).toBe('critical')

    const warningBadge = screen.getByText('warning')
    expect(warningBadge.getAttribute('data-severity')).toBe('warning')

    const infoBadge = screen.getByText('info')
    expect(infoBadge.getAttribute('data-severity')).toBe('info')
  })

  it('renders comments with author info in Comments section', () => {
    currentResult = {
      _tag: 'Success',
      waiting: false,
      value: {
        verdict: null,
        findings: [],
        comments: [REVIEW_COMMENT],
      },
    }
    render(<ReviewPane workspaceId="ws-1" />)

    expect(screen.getByText('Comments')).toBeTruthy()
    expect(screen.getByText('reviewer')).toBeTruthy()
    expect(
      screen.getByText('This function should handle the edge case.')
    ).toBeTruthy()
    expect(screen.getByText('src/utils/parser.ts:42')).toBeTruthy()
  })

  // -------------------------------------------------------------------------
  // Issue #6: Polling + manual refresh
  // -------------------------------------------------------------------------

  it('starts polling on mount and calls refresh after 30 seconds', () => {
    vi.useFakeTimers()

    currentResult = {
      _tag: 'Success',
      waiting: false,
      value: { verdict: null, findings: [], comments: [ISSUE_COMMENT] },
    }
    render(<ReviewPane workspaceId="ws-1" />)

    // No refresh calls yet (initial render only)
    expect(mockRefresh).not.toHaveBeenCalled()

    // Advance 30 seconds — one polling cycle
    vi.advanceTimersByTime(30_000)
    expect(mockRefresh).toHaveBeenCalledTimes(1)

    // Advance another 30 seconds
    vi.advanceTimersByTime(30_000)
    expect(mockRefresh).toHaveBeenCalledTimes(2)

    vi.useRealTimers()
  })

  it('stops polling when the pane is unmounted', () => {
    vi.useFakeTimers()

    currentResult = {
      _tag: 'Success',
      waiting: false,
      value: { verdict: null, findings: [], comments: [ISSUE_COMMENT] },
    }
    const { unmount } = render(<ReviewPane workspaceId="ws-1" />)

    // Advance one cycle to confirm polling is working
    vi.advanceTimersByTime(30_000)
    expect(mockRefresh).toHaveBeenCalledTimes(1)

    // Unmount the component
    unmount()

    // Advance another cycle — no additional calls
    vi.advanceTimersByTime(30_000)
    expect(mockRefresh).toHaveBeenCalledTimes(1)

    vi.useRealTimers()
  })

  it('renders the refresh button', () => {
    currentResult = {
      _tag: 'Success',
      waiting: false,
      value: { verdict: null, findings: [], comments: [ISSUE_COMMENT] },
    }
    render(<ReviewPane workspaceId="ws-1" />)

    expect(screen.getByTestId('refresh-button')).toBeTruthy()
    expect(screen.getByLabelText('Refresh comments')).toBeTruthy()
  })

  it('calls refresh immediately when manual refresh button is clicked', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({
      advanceTimers: vi.advanceTimersByTime,
    })

    currentResult = {
      _tag: 'Success',
      waiting: false,
      value: { verdict: null, findings: [], comments: [ISSUE_COMMENT] },
    }
    render(<ReviewPane workspaceId="ws-1" />)

    expect(mockRefresh).not.toHaveBeenCalled()

    // Click manual refresh
    await user.click(screen.getByTestId('refresh-button'))

    // Should have called refresh immediately
    expect(mockRefresh).toHaveBeenCalledTimes(1)

    vi.useRealTimers()
  })

  it('resets the polling timer when manual refresh is clicked', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({
      advanceTimers: vi.advanceTimersByTime,
    })

    currentResult = {
      _tag: 'Success',
      waiting: false,
      value: { verdict: null, findings: [], comments: [ISSUE_COMMENT] },
    }
    render(<ReviewPane workspaceId="ws-1" />)

    // Advance 20 seconds (before the first automatic poll)
    vi.advanceTimersByTime(20_000)
    expect(mockRefresh).not.toHaveBeenCalled()

    // Click manual refresh at t=20s
    await user.click(screen.getByTestId('refresh-button'))
    expect(mockRefresh).toHaveBeenCalledTimes(1)

    // Advance 15 seconds (t=35s) — would have been past the original 30s
    // but the timer was reset, so no automatic poll yet
    vi.advanceTimersByTime(15_000)
    expect(mockRefresh).toHaveBeenCalledTimes(1)

    // Advance to 30s after the manual refresh (t=50s)
    vi.advanceTimersByTime(15_000)
    expect(mockRefresh).toHaveBeenCalledTimes(2)

    vi.useRealTimers()
  })

  it('shows subtle refresh indicator when refetching with existing data', () => {
    currentResult = {
      _tag: 'Success',
      waiting: true, // Indicates a background refetch is in progress
      value: { verdict: null, findings: [], comments: [ISSUE_COMMENT] },
    }
    render(<ReviewPane workspaceId="ws-1" />)

    // The refresh indicator should be visible
    expect(screen.getByTestId('refresh-indicator')).toBeTruthy()
    expect(screen.getByText('Refreshing...')).toBeTruthy()

    // The existing content should still be rendered (not replaced by spinner)
    expect(screen.getByText('Comments')).toBeTruthy()
    expect(screen.getByText('Looks good to me!')).toBeTruthy()
  })

  it('does not show refresh indicator when not refetching', () => {
    currentResult = {
      _tag: 'Success',
      waiting: false,
      value: { verdict: null, findings: [], comments: [ISSUE_COMMENT] },
    }
    render(<ReviewPane workspaceId="ws-1" />)

    expect(screen.queryByTestId('refresh-indicator')).toBeNull()
  })

  it('renders refresh button in all content states', () => {
    // Test with error state
    currentResult = {
      _tag: 'Failure',
      waiting: false,
      cause: { message: 'Network error' },
    }
    const { unmount } = render(<ReviewPane workspaceId="ws-1" />)
    expect(screen.getByTestId('refresh-button')).toBeTruthy()
    unmount()

    // Test with no-PR state
    currentResult = {
      _tag: 'Failure',
      waiting: false,
      cause: { code: 'PR_NOT_FOUND', message: 'No PR found' },
    }
    render(<ReviewPane workspaceId="ws-1" />)
    expect(screen.getByTestId('refresh-button')).toBeTruthy()
  })
})
