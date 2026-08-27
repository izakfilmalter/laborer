import type { PullRequestComment } from '@laborer/shared/rpc'
import { describe, expect, it } from 'vitest'
import { latestReviewPerReviewer } from '@/components/github-reviewers-hover-card'

const comment = (
  overrides: Partial<PullRequestComment> & Pick<PullRequestComment, 'id'>
): PullRequestComment => ({
  authorAvatarUrl: null,
  authorLogin: 'octocat',
  authorUrl: null,
  body: '',
  createdAt: '2026-01-01T00:00:00Z',
  filePath: null,
  inReplyToId: null,
  kind: 'review',
  line: null,
  reviewState: 'approved',
  url: 'https://github.com/acme/widgets/pull/7#pullrequestreview-1',
  ...overrides,
})

describe('the reviewers behind the verdict', () => {
  it('keeps a reviewer to one standing opinion, the latest', () => {
    const reviewers = latestReviewPerReviewer([
      comment({ id: 1, reviewState: 'changesRequested' }),
      comment({ id: 2, createdAt: '2026-01-02T00:00:00Z' }),
    ])

    expect(reviewers).toHaveLength(1)
    expect(reviewers[0]?.state).toBe('approved')
  })

  it('ignores an earlier review arriving after a later one', () => {
    const reviewers = latestReviewPerReviewer([
      comment({ id: 2, createdAt: '2026-01-02T00:00:00Z' }),
      comment({
        createdAt: '2026-01-01T00:00:00Z',
        id: 1,
        reviewState: 'changesRequested',
      }),
    ])

    expect(reviewers[0]?.state).toBe('approved')
  })

  it('leaves out the remarks that are not reviews', () => {
    const reviewers = latestReviewPerReviewer([
      comment({
        authorLogin: 'hubot',
        id: 3,
        kind: 'issue',
        reviewState: null,
      }),
      comment({
        authorLogin: 'ghost',
        id: 4,
        kind: 'reviewComment',
        reviewState: null,
      }),
      comment({ authorLogin: 'draft-author', id: 5, reviewState: 'pending' }),
    ])

    expect(reviewers).toHaveLength(0)
  })

  it('reads whoever decided something before whoever only spoke', () => {
    const reviewers = latestReviewPerReviewer([
      comment({ authorLogin: 'carol', id: 1, reviewState: 'commented' }),
      comment({ authorLogin: 'bob', id: 2, reviewState: 'approved' }),
      comment({ authorLogin: 'alice', id: 3, reviewState: 'changesRequested' }),
    ])

    expect(reviewers.map((reviewer) => reviewer.authorLogin)).toEqual([
      'alice',
      'bob',
      'carol',
    ])
  })
})
