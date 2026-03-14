/**
 * Tests for ReviewPane component.
 *
 * Verifies that the review pane correctly renders fetched PR comments and
 * findings in grouped sections with severity badges. Tests loading, empty,
 * and error states, finding cards with severity sorting, collapsible
 * suggested fixes, comment cards with author info, polling behavior, manual
 * refresh, checkbox selection, reaction state display, selection controls,
 * Fix Selected action, and Unqueue action.
 *
 * @see Issue #5: Grouped display with severity badges
 * @see Issue #6: Polling + manual refresh
 * @see Issue #8: Checkbox selection + reaction state display
 * @see Issue #9: Rocket reaction RPCs + Fix Selected action
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
const mockAddReaction = vi.fn().mockResolvedValue({
  id: 5001,
  content: 'rocket',
  userId: 100,
})
const mockRemoveReaction = vi.fn().mockResolvedValue(undefined)
const mockFixFindings = vi.fn().mockResolvedValue({ id: 'terminal-1' })
const mockEditorOpen = vi.fn().mockResolvedValue(undefined)

vi.mock('@effect-atom/atom-react/Hooks', () => ({
  useAtomValue: () => currentResult,
  useAtomRefresh: () => mockRefresh,
  useAtomSet: (atom: symbol) => {
    switch (atom.description) {
      case 'review.addReaction':
        return mockAddReaction
      case 'review.removeReaction':
        return mockRemoveReaction
      case 'brrr.fix':
        return mockFixFindings
      case 'editor.open':
        return mockEditorOpen
      default:
        return vi.fn()
    }
  },
}))

vi.mock('@/atoms/laborer-client', () => ({
  LaborerClient: {
    query: () => Symbol.for('query:review.fetchComments'),
    mutation: (name: string) => Symbol(name),
  },
}))

const mockAssignTerminalToPane = vi.fn()

vi.mock('@/panels/panel-context', () => ({
  usePanelActions: () => ({
    assignTerminalToPane: mockAssignTerminalToPane,
  }),
}))

const mockScrollDiffToFile = vi.fn()

vi.mock('@/panels/diff-scroll-context', () => ({
  useDiffScrollDispatch: () => mockScrollDiffToFile,
}))

vi.mock('@/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
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

vi.mock('@/components/ui/checkbox', () => ({
  Checkbox: ({
    checked,
    onCheckedChange,
    ...props
  }: {
    checked?: boolean
    onCheckedChange?: () => void
    'aria-label'?: string
    'data-testid'?: string
    className?: string
  }) => (
    <input
      aria-label={props['aria-label']}
      checked={checked}
      data-testid={props['data-testid']}
      onChange={onCheckedChange}
      type="checkbox"
    />
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

/** Finding with a rocket reaction (queued for fix). */
const QUEUED_FINDING = {
  id: 'unvalidated-input',
  file: 'src/api/input.ts',
  line: 20,
  severity: 'warning' as const,
  description: 'User input not validated.',
  suggestedFixes: [],
  category: 'security',
  dependsOn: [],
  commentId: 200,
  reactions: [{ id: 5001, content: 'rocket', userId: 100 }],
}

/** Finding with a thumbs_up reaction (fixed). */
const FIXED_FINDING = {
  id: 'deprecated-api',
  file: 'src/lib/compat.ts',
  line: 55,
  severity: 'info' as const,
  description: 'Using deprecated API.',
  suggestedFixes: ['Use the new API.'],
  category: 'hygiene',
  dependsOn: [],
  commentId: 201,
  reactions: [{ id: 5002, content: 'thumbs_up', userId: 100 }],
}

/** Finding with a confused reaction (won't-fix). */
const WONTFIX_FINDING = {
  id: 'long-function',
  file: 'src/utils/long.ts',
  line: 1,
  severity: 'info' as const,
  description: 'Function exceeds 50 lines.',
  suggestedFixes: [],
  category: 'hygiene',
  dependsOn: [],
  commentId: 202,
  reactions: [{ id: 5003, content: 'confused', userId: 100 }],
}

describe('ReviewPane', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  beforeEach(() => {
    currentResult = { _tag: 'Initial', waiting: true }
    mockRefresh.mockReset()
    mockAddReaction.mockReset()
    mockAddReaction.mockResolvedValue({
      id: 5001,
      content: 'rocket',
      userId: 100,
    })
    mockRemoveReaction.mockReset()
    mockRemoveReaction.mockResolvedValue(undefined)
    mockFixFindings.mockReset()
    mockFixFindings.mockResolvedValue({ id: 'terminal-1' })
    mockEditorOpen.mockReset()
    mockEditorOpen.mockResolvedValue(undefined)
    mockAssignTerminalToPane.mockReset()
    mockScrollDiffToFile.mockReset()
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
      cause: {
        _tag: 'Fail',
        error: { code: 'PR_NOT_FOUND', message: 'No PR found' },
      },
    }
    render(<ReviewPane workspaceId="ws-1" />)

    expect(screen.getByText('No pull request')).toBeTruthy()
    expect(screen.getByText(NO_PR_MESSAGE_RE)).toBeTruthy()
  })

  it('renders error state when RPC fails', () => {
    currentResult = {
      _tag: 'Failure',
      waiting: false,
      cause: {
        _tag: 'Fail',
        error: { message: 'Authentication required' },
      },
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
      cause: {
        _tag: 'Fail',
        error: { message: 'Network error' },
      },
    }
    const { unmount } = render(<ReviewPane workspaceId="ws-1" />)
    expect(screen.getByTestId('refresh-button')).toBeTruthy()
    unmount()

    // Test with no-PR state
    currentResult = {
      _tag: 'Failure',
      waiting: false,
      cause: {
        _tag: 'Fail',
        error: { code: 'PR_NOT_FOUND', message: 'No PR found' },
      },
    }
    render(<ReviewPane workspaceId="ws-1" />)
    expect(screen.getByTestId('refresh-button')).toBeTruthy()
  })

  // -------------------------------------------------------------------------
  // Issue #8: Checkbox selection + reaction state display
  // -------------------------------------------------------------------------

  it('renders a checkbox on each finding card', () => {
    currentResult = {
      _tag: 'Success',
      waiting: false,
      value: {
        verdict: null,
        findings: [CRITICAL_FINDING, WARNING_FINDING],
        comments: [],
      },
    }
    render(<ReviewPane workspaceId="ws-1" />)

    const checkboxes = screen.getAllByTestId('finding-checkbox')
    expect(checkboxes).toHaveLength(2)
  })

  it('toggles finding selection when checkbox is clicked', async () => {
    const user = userEvent.setup()
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

    const checkbox = screen.getByTestId('finding-checkbox')
    const findingCard = screen.getByTestId('finding-card')

    // Initially not selected
    expect(findingCard.getAttribute('data-selected')).toBeNull()

    // Click to select
    await user.click(checkbox)
    expect(findingCard.getAttribute('data-selected')).toBe('true')

    // Click again to deselect
    await user.click(checkbox)
    expect(findingCard.getAttribute('data-selected')).toBeNull()
  })

  it('shows selected count when findings are selected', async () => {
    const user = userEvent.setup()
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

    // No selected count initially
    expect(screen.queryByTestId('selected-count')).toBeNull()

    // Select two findings
    const checkboxes = screen.getAllByTestId('finding-checkbox')
    if (!(checkboxes[0] && checkboxes[1])) {
      throw new Error('Expected at least 2 checkboxes')
    }
    await user.click(checkboxes[0])
    await user.click(checkboxes[1])

    expect(screen.getByTestId('selected-count')).toBeTruthy()
    expect(screen.getByText('2 selected')).toBeTruthy()
  })

  it('selected findings have highlighted background', async () => {
    const user = userEvent.setup()
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

    const checkbox = screen.getByTestId('finding-checkbox')
    const findingCard = screen.getByTestId('finding-card')

    // Select the finding
    await user.click(checkbox)

    // Should have data-selected attribute
    expect(findingCard.getAttribute('data-selected')).toBe('true')
  })

  it('renders rocket reaction indicator for queued findings', () => {
    currentResult = {
      _tag: 'Success',
      waiting: false,
      value: {
        verdict: null,
        findings: [QUEUED_FINDING],
        comments: [],
      },
    }
    render(<ReviewPane workspaceId="ws-1" />)

    expect(screen.getByTestId('reaction-rocket')).toBeTruthy()
  })

  it('renders thumbs-up reaction indicator for fixed findings', () => {
    currentResult = {
      _tag: 'Success',
      waiting: false,
      value: {
        verdict: null,
        findings: [FIXED_FINDING],
        comments: [],
      },
    }
    render(<ReviewPane workspaceId="ws-1" />)

    expect(screen.getByTestId('reaction-thumbs-up')).toBeTruthy()
  })

  it("renders confused reaction indicator for won't-fix findings", () => {
    currentResult = {
      _tag: 'Success',
      waiting: false,
      value: {
        verdict: null,
        findings: [WONTFIX_FINDING],
        comments: [],
      },
    }
    render(<ReviewPane workspaceId="ws-1" />)

    expect(screen.getByTestId('reaction-confused')).toBeTruthy()
  })

  it('does not render reaction indicators when finding has no reactions', () => {
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

    expect(screen.queryByTestId('reaction-indicators')).toBeNull()
  })

  it('dims resolved findings (thumbs-up or confused)', () => {
    currentResult = {
      _tag: 'Success',
      waiting: false,
      value: {
        verdict: null,
        findings: [FIXED_FINDING, WONTFIX_FINDING, CRITICAL_FINDING],
        comments: [],
      },
    }
    render(<ReviewPane workspaceId="ws-1" />)

    const findingCards = screen.getAllByTestId('finding-card')
    // FIXED_FINDING and WONTFIX_FINDING are info severity, sorted last;
    // CRITICAL_FINDING sorted first
    const resolvedCards = findingCards.filter(
      (card) => card.getAttribute('data-resolved') === 'true'
    )
    const unresolvedCards = findingCards.filter(
      (card) => card.getAttribute('data-resolved') === null
    )

    expect(resolvedCards).toHaveLength(2)
    expect(unresolvedCards).toHaveLength(1)
  })

  it('select all button selects all findings', async () => {
    const user = userEvent.setup()
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

    // Click "Select all"
    const selectAllButton = screen.getByTestId('select-toggle-button')
    expect(selectAllButton).toBeTruthy()
    expect(selectAllButton.textContent).toBe('Select all')

    await user.click(selectAllButton)

    // All finding cards should be selected
    const findingCards = screen.getAllByTestId('finding-card')
    for (const card of findingCards) {
      expect(card.getAttribute('data-selected')).toBe('true')
    }

    expect(screen.getByText('3 selected')).toBeTruthy()
  })

  it('deselect all button deselects all findings', async () => {
    const user = userEvent.setup()
    currentResult = {
      _tag: 'Success',
      waiting: false,
      value: {
        verdict: null,
        findings: [CRITICAL_FINDING, WARNING_FINDING],
        comments: [],
      },
    }
    render(<ReviewPane workspaceId="ws-1" />)

    // Select all first
    const selectToggle = screen.getByTestId('select-toggle-button')
    await user.click(selectToggle)
    expect(screen.getByText('2 selected')).toBeTruthy()

    // Button should now say "Deselect all"
    expect(selectToggle.textContent).toBe('Deselect all')

    // Click to deselect all
    await user.click(selectToggle)

    // No findings should be selected
    const findingCards = screen.getAllByTestId('finding-card')
    for (const card of findingCards) {
      expect(card.getAttribute('data-selected')).toBeNull()
    }

    expect(screen.queryByTestId('selected-count')).toBeNull()
  })

  it('does not show selection controls when there are no findings', () => {
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

    expect(screen.queryByTestId('selection-controls')).toBeNull()
    expect(screen.queryByTestId('select-toggle-button')).toBeNull()
  })

  // -------------------------------------------------------------------------
  // Issue #9: Rocket reaction RPCs + Fix Selected action
  // -------------------------------------------------------------------------

  it('renders Fix Selected button when findings exist', () => {
    currentResult = {
      _tag: 'Success',
      waiting: false,
      value: {
        verdict: null,
        findings: [CRITICAL_FINDING, WARNING_FINDING],
        comments: [],
      },
    }
    render(<ReviewPane workspaceId="ws-1" />)

    const fixButton = screen.getByTestId('fix-selected-button')
    expect(fixButton).toBeTruthy()
  })

  it('Fix Selected button is disabled when no findings are selected', () => {
    currentResult = {
      _tag: 'Success',
      waiting: false,
      value: {
        verdict: null,
        findings: [CRITICAL_FINDING, WARNING_FINDING],
        comments: [],
      },
    }
    render(<ReviewPane workspaceId="ws-1" />)

    const fixButton = screen.getByTestId('fix-selected-button')
    expect(fixButton.getAttribute('disabled')).not.toBeNull()
  })

  it('Fix Selected button is enabled when findings are selected', async () => {
    const user = userEvent.setup()
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

    // Select a finding
    const checkbox = screen.getByTestId('finding-checkbox')
    await user.click(checkbox)

    const fixButton = screen.getByTestId('fix-selected-button')
    expect(fixButton.getAttribute('disabled')).toBeNull()
  })

  it('Fix Selected button shows count when findings are selected', async () => {
    const user = userEvent.setup()
    currentResult = {
      _tag: 'Success',
      waiting: false,
      value: {
        verdict: null,
        findings: [CRITICAL_FINDING, WARNING_FINDING],
        comments: [],
      },
    }
    render(<ReviewPane workspaceId="ws-1" />)

    // Select both findings
    const checkboxes = screen.getAllByTestId('finding-checkbox')
    if (!(checkboxes[0] && checkboxes[1])) {
      throw new Error('Expected at least 2 checkboxes')
    }
    await user.click(checkboxes[0])
    await user.click(checkboxes[1])

    const fixButton = screen.getByTestId('fix-selected-button')
    expect(fixButton.textContent).toContain('(2)')
  })

  it('queues a finding immediately when its checkbox is clicked', async () => {
    const user = userEvent.setup()
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

    await user.click(screen.getByTestId('finding-checkbox'))

    expect(screen.getByTestId('reaction-rocket')).toBeTruthy()
    expect(mockAddReaction).toHaveBeenCalledWith({
      payload: {
        workspaceId: 'ws-1',
        commentId: 100,
        content: 'rocket',
      },
    })
  })

  it('Fix Selected button starts fix after findings are queued', async () => {
    const user = userEvent.setup()
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

    await user.click(screen.getByTestId('finding-checkbox'))
    await user.click(screen.getByTestId('fix-selected-button'))

    expect(mockAddReaction).toHaveBeenCalledTimes(1)
    expect(mockFixFindings).toHaveBeenCalledWith({
      payload: { workspaceId: 'ws-1' },
    })
  })

  it('does not render Fix Selected button when no findings exist', () => {
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

    expect(screen.queryByTestId('fix-selected-button')).toBeNull()
  })

  it('renders Unqueue button on findings with rocket reaction', () => {
    currentResult = {
      _tag: 'Success',
      waiting: false,
      value: {
        verdict: null,
        findings: [QUEUED_FINDING],
        comments: [],
      },
    }
    render(<ReviewPane workspaceId="ws-1" />)

    const unqueueButton = screen.getByTestId('unqueue-button')
    expect(unqueueButton).toBeTruthy()
    expect(unqueueButton.textContent).toContain('Unqueue')
  })

  it('does not render Unqueue button on findings without rocket reaction', () => {
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

    expect(screen.queryByTestId('unqueue-button')).toBeNull()
  })

  it('does not render Unqueue button on findings with only thumbs-up reaction', () => {
    currentResult = {
      _tag: 'Success',
      waiting: false,
      value: {
        verdict: null,
        findings: [FIXED_FINDING],
        comments: [],
      },
    }
    render(<ReviewPane workspaceId="ws-1" />)

    expect(screen.queryByTestId('unqueue-button')).toBeNull()
  })

  // -------------------------------------------------------------------------
  // Issue #10: Click-to-open-in-editor
  // -------------------------------------------------------------------------

  it('renders file:line references as clickable links in finding cards', () => {
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

    const fileLink = screen.getByTestId('file-line-link')
    expect(fileLink).toBeTruthy()
    expect(fileLink.tagName).toBe('BUTTON')
    expect(fileLink.textContent).toContain('src/db/query.ts:15')
    expect(fileLink.getAttribute('title')).toBe(
      'Open src/db/query.ts:15 in editor'
    )
  })

  it('renders file:line references as clickable links in inline comment cards', () => {
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

    const fileLink = screen.getByTestId('file-line-link')
    expect(fileLink).toBeTruthy()
    expect(fileLink.tagName).toBe('BUTTON')
    expect(fileLink.textContent).toContain('src/utils/parser.ts:42')
    expect(fileLink.getAttribute('title')).toBe(
      'Open src/utils/parser.ts:42 in editor'
    )
  })

  it('clicking file:line in finding card triggers editor.open RPC', async () => {
    const user = userEvent.setup()
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

    const fileLink = screen.getByTestId('file-line-link')
    await user.click(fileLink)

    expect(mockEditorOpen).toHaveBeenCalledWith({
      payload: { workspaceId: 'ws-1', filePath: 'src/db/query.ts' },
    })
  })

  it('clicking file:line in comment card triggers editor.open RPC', async () => {
    const user = userEvent.setup()
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

    const fileLink = screen.getByTestId('file-line-link')
    await user.click(fileLink)

    expect(mockEditorOpen).toHaveBeenCalledWith({
      payload: { workspaceId: 'ws-1', filePath: 'src/utils/parser.ts' },
    })
  })

  it('does not render file:line link for issue comments without file path', () => {
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

    expect(screen.queryByTestId('file-line-link')).toBeNull()
  })

  it('file:line link has visual affordance (underline styling)', () => {
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

    const fileLink = screen.getByTestId('file-line-link')
    expect(fileLink.className).toContain('underline')
  })

  // -------------------------------------------------------------------------
  // Issue #11: Cross-pane diff scroll
  // -------------------------------------------------------------------------

  it('clicking file:line in finding card dispatches diff scroll event', async () => {
    const user = userEvent.setup()
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

    const fileLink = screen.getByTestId('file-line-link')
    await user.click(fileLink)

    expect(mockScrollDiffToFile).toHaveBeenCalledWith(
      'ws-1',
      'src/db/query.ts',
      15
    )
  })

  it('clicking file:line in comment card dispatches diff scroll event with line', async () => {
    const user = userEvent.setup()
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

    const fileLink = screen.getByTestId('file-line-link')
    await user.click(fileLink)

    expect(mockScrollDiffToFile).toHaveBeenCalledWith(
      'ws-1',
      'src/utils/parser.ts',
      42
    )
  })

  it('clicking file:line in comment card without line does not dispatch diff scroll event', async () => {
    const user = userEvent.setup()
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

    const fileLink = screen.getByTestId('file-line-link')
    await user.click(fileLink)

    // line is null, so no diff scroll dispatch
    expect(mockScrollDiffToFile).not.toHaveBeenCalled()
  })

  it('clicking file:line dispatches both editor open and diff scroll', async () => {
    const user = userEvent.setup()
    currentResult = {
      _tag: 'Success',
      waiting: false,
      value: {
        verdict: null,
        findings: [WARNING_FINDING],
        comments: [],
      },
    }
    render(<ReviewPane workspaceId="ws-1" />)

    const fileLink = screen.getByTestId('file-line-link')
    await user.click(fileLink)

    // Both actions should fire on the same click
    expect(mockScrollDiffToFile).toHaveBeenCalledWith(
      'ws-1',
      'src/api/handler.ts',
      42
    )
    expect(mockEditorOpen).toHaveBeenCalledWith({
      payload: { workspaceId: 'ws-1', filePath: 'src/api/handler.ts' },
    })
  })
})
