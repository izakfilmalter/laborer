/**
 * Tests for ReviewPane component.
 *
 * Verifies that the review pane correctly renders fetched PR comments with
 * author info, handles loading/empty/error states, and displays file:line
 * references for inline review comments.
 *
 * @see Issue #3: Review pane renders fetched comments
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type ResultState =
  | { _tag: 'Initial'; waiting: boolean }
  | { _tag: 'Failure'; waiting: boolean; cause: unknown }
  | { _tag: 'Success'; waiting: boolean; value: unknown }

let currentResult: ResultState = { _tag: 'Initial', waiting: true }

vi.mock('@effect-atom/atom-react/Hooks', () => ({
  useAtomValue: () => currentResult,
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

describe('ReviewPane', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    currentResult = { _tag: 'Initial', waiting: true }
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

  it('renders comments with author info and body', () => {
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
})
