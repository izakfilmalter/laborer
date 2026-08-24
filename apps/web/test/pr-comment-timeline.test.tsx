import type { PullRequestComment } from '@laborer/shared/rpc'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { formatRelativeTime } from '@/panes/comments-pane/relative-time'
import { CommentTimelineItem } from '@/panes/comments-pane/timeline-item'

const NOW = Date.parse('2026-08-20T12:00:00.000Z')
const RELATIVE_AGE_RE = /ago$/
const PULL_REQUEST_URL = 'https://github.com/o/r/pull/1'

const comment = (
  overrides: Partial<PullRequestComment> = {}
): PullRequestComment => ({
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
  ...overrides,
})

afterEach(cleanup)

describe('comment age', () => {
  it.each([
    ['2026-08-20T11:59:30.000Z', 'just now'],
    ['2026-08-20T11:56:00.000Z', '4m ago'],
    ['2026-08-20T09:00:00.000Z', '3h ago'],
    ['2026-08-18T12:00:00.000Z', '2d ago'],
  ])('reads %s as %s', (timestamp, expected) => {
    expect(formatRelativeTime(timestamp, NOW)).toBe(expected)
  })

  it('falls back to a date once a week has passed', () => {
    expect(formatRelativeTime('2026-06-01T12:00:00.000Z', NOW)).not.toMatch(
      RELATIVE_AGE_RE
    )
  })

  it('renders nothing for a timestamp GitHub omitted', () => {
    expect(formatRelativeTime('', NOW)).toBe('')
  })
})

describe('timeline item', () => {
  it('states the verdict a review carries', () => {
    render(
      <CommentTimelineItem
        comment={comment({ body: '', kind: 'review', reviewState: 'approved' })}
        now={NOW}
      />
    )

    expect(screen.getByText('Approved')).toBeTruthy()
  })

  it('renders a review with no body as a summary line alone', () => {
    const { container } = render(
      <CommentTimelineItem
        comment={comment({ body: '', kind: 'review', reviewState: 'approved' })}
        now={NOW}
      />
    )

    expect(container.querySelector('.markdown-body')).toBeNull()
  })

  it('renders a comment body as markdown', () => {
    render(
      <CommentTimelineItem
        comment={comment({ body: '**Ship it**' })}
        now={NOW}
      />
    )

    expect(screen.getByText('Ship it').tagName).toBe('STRONG')
  })

  it('uses the quiet card treatment from the pull request summary', () => {
    const { container } = render(
      <CommentTimelineItem comment={comment()} now={NOW} />
    )

    const card = container.querySelector('[data-slot="pr-comment-card"]')
    const body = container.querySelector('[data-slot="pr-comment-body"]')

    expect(card?.className).toContain('rounded-lg')
    expect(card?.className).toContain('border-border/60')
    expect(body?.className).not.toContain('border')
  })

  it('anchors a review comment to its file and line', () => {
    render(
      <CommentTimelineItem
        comment={comment({
          filePath: 'apps/web/src/panes/comments-pane.tsx',
          kind: 'reviewComment',
          line: 42,
        })}
        now={NOW}
      />
    )

    expect(screen.getByText('comments-pane.tsx:42')).toBeTruthy()
    expect(
      screen.getByTitle('apps/web/src/panes/comments-pane.tsx:42')
    ).toBeTruthy()
  })

  it('distinguishes a reply from a first comment', () => {
    render(
      <CommentTimelineItem
        comment={comment({ inReplyToId: 7, kind: 'reviewComment' })}
        now={NOW}
      />
    )

    expect(screen.getByText('Replied')).toBeTruthy()
  })

  it('links the author and the comment back to GitHub', () => {
    render(<CommentTimelineItem comment={comment()} now={NOW} />)

    expect(
      screen.getByRole('link', { name: 'octocat' }).getAttribute('href')
    ).toBe('https://github.com/octocat')
    expect(
      screen.getByRole('link', { name: '1h ago' }).getAttribute('href')
    ).toBe('https://github.com/o/r/pull/1#issuecomment-1')
  })
})

describe('links inside a comment body', () => {
  it('sends a relative link to GitHub rather than to the app origin', () => {
    render(
      <CommentTimelineItem
        baseHref={PULL_REQUEST_URL}
        comment={comment({ body: 'See [the fix](/o/r/issues/5).' })}
        now={NOW}
      />
    )

    expect(
      screen.getByRole('link', { name: 'the fix' }).getAttribute('href')
    ).toBe('https://github.com/o/r/issues/5')
  })

  it('reads a bare fragment as a place on the pull request', () => {
    render(
      <CommentTimelineItem
        baseHref={PULL_REQUEST_URL}
        comment={comment({ body: 'As in [#123](#123).' })}
        now={NOW}
      />
    )

    expect(
      screen.getByRole('link', { name: '#123' }).getAttribute('href')
    ).toBe(`${PULL_REQUEST_URL}#123`)
  })

  it('leaves a relative link alone when there is nothing to resolve against', () => {
    render(
      <CommentTimelineItem
        baseHref={null}
        comment={comment({ body: 'See [the fix](/o/r/issues/5).' })}
        now={NOW}
      />
    )

    expect(
      screen.getByRole('link', { name: 'the fix' }).getAttribute('href')
    ).toBe('/o/r/issues/5')
  })

  it('passes an absolute link through untouched', () => {
    render(
      <CommentTimelineItem
        baseHref={PULL_REQUEST_URL}
        comment={comment({
          body: 'See [the docs](https://example.com/a?b=c).',
        })}
        now={NOW}
      />
    )

    expect(
      screen.getByRole('link', { name: 'the docs' }).getAttribute('href')
    ).toBe('https://example.com/a?b=c')
  })

  it('leaves a link written inside a code span as written', () => {
    render(
      <CommentTimelineItem
        baseHref={PULL_REQUEST_URL}
        comment={comment({ body: 'Write `[the fix](/o/r/issues/5)` instead.' })}
        now={NOW}
      />
    )

    expect(screen.getByText('[the fix](/o/r/issues/5)').tagName).toBe('CODE')
  })
})
