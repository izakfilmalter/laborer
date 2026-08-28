import type { PullRequestComment, PullRequestCommit } from '@laborer/shared/rpc'
import { describe, expect, it } from 'vitest'
import {
  buildPullRequestTimeline,
  groupPullRequestTimelineConversations,
  isPullRequestVerdictStale,
  latestPullRequestReviewOutcomes,
  newestPullRequestCommitAt,
  orderPullRequestComments,
  type PullRequestDetailView,
  pullRequestReviewOutcome,
  readableFailure,
  shouldRefreshPullRequestActivity,
  visibleBody,
} from '@/components/pull-request/detail-logic'

function comment(
  overrides: Partial<PullRequestComment> & { id: number }
): PullRequestComment {
  return {
    kind: 'issue',
    authorLogin: 'octocat',
    authorAvatarUrl: null,
    authorUrl: null,
    body: 'hello',
    createdAt: '2026-08-01T10:00:00Z',
    url: 'https://github.com/o/r/pull/1#issuecomment-1',
    reviewState: null,
    filePath: null,
    line: null,
    inReplyToId: null,
    ...overrides,
  }
}

function commit(oid: string, committedDate: string): PullRequestCommit {
  return {
    oid,
    committedDate,
    messageHeadline: `commit ${oid}`,
    authors: [{ login: 'octocat', avatarUrl: null, name: null }],
    additions: 1,
    deletions: 0,
  }
}

const timelineDetail = (
  overrides: Partial<
    Pick<
      PullRequestDetailView,
      'createdAt' | 'author' | 'commits' | 'comments' | 'mergedAt' | 'closedAt'
    >
  > = {}
) => ({
  createdAt: '2026-08-01T09:00:00Z',
  author: { login: 'octocat', avatarUrl: null, name: null },
  commits: [] as PullRequestCommit[],
  comments: [] as PullRequestComment[],
  mergedAt: null,
  closedAt: null,
  ...overrides,
})

describe('buildPullRequestTimeline', () => {
  it('flattens creation, commits and comments newest-first', () => {
    const events = buildPullRequestTimeline(
      timelineDetail({
        commits: [commit('abc1234', '2026-08-01T11:00:00Z')],
        comments: [comment({ id: 1, createdAt: '2026-08-01T10:00:00Z' })],
      })
    )
    expect(events.map((event) => event.kind)).toEqual([
      'commit',
      'comment',
      'opened',
    ])
  })

  it('reports merged rather than closed when GitHub set both timestamps', () => {
    const events = buildPullRequestTimeline(
      timelineDetail({
        mergedAt: '2026-08-02T10:00:00Z',
        closedAt: '2026-08-02T10:00:00Z',
      })
    )
    expect(events.map((event) => event.kind)).toEqual(['merged', 'opened'])
  })

  it('keeps a closed event when nothing merged', () => {
    const events = buildPullRequestTimeline(
      timelineDetail({ closedAt: '2026-08-02T10:00:00Z' })
    )
    expect(events.map((event) => event.kind)).toEqual(['closed', 'opened'])
  })

  it('drops a body that is nothing but bot bookkeeping', () => {
    const events = buildPullRequestTimeline(
      timelineDetail({
        comments: [comment({ id: 1, body: '<!-- marker -->\n  ' })],
      })
    )
    const entry = events.find((event) => event.kind === 'comment')
    expect(entry?.body).toBeNull()
  })

  it('carries the reaction subject only where GitHub resolved a node id', () => {
    const events = buildPullRequestTimeline(
      timelineDetail({
        comments: [
          comment({ id: 1, nodeId: 'IC_node' }),
          comment({ id: 2, createdAt: '2026-08-01T10:30:00Z' }),
        ],
      })
    )
    const subjects = events
      .filter((event) => event.kind === 'comment')
      .map((event) => event.reactionSubjectId)
    expect(subjects).toContain('IC_node')
    expect(subjects).toContain(null)
  })
})

describe('groupPullRequestTimelineConversations', () => {
  it('folds consecutive comments into one section and keeps verdicts first-class', () => {
    const events = buildPullRequestTimeline(
      timelineDetail({
        comments: [
          comment({ id: 1, createdAt: '2026-08-01T10:00:00Z' }),
          comment({ id: 2, createdAt: '2026-08-01T10:05:00Z' }),
          comment({
            id: 3,
            kind: 'review',
            reviewState: 'approved',
            createdAt: '2026-08-01T10:10:00Z',
          }),
        ],
      })
    )
    const rows = groupPullRequestTimelineConversations(events)
    expect(rows.map((row) => row.kind)).toEqual(['event', 'comments', 'event'])
    const section = rows.find((row) => row.kind === 'comments')
    expect(section?.kind === 'comments' && section.events).toHaveLength(2)
  })

  it('splits a conversation where a commit lands between review rounds', () => {
    const events = buildPullRequestTimeline(
      timelineDetail({
        commits: [commit('abc1234', '2026-08-01T10:03:00Z')],
        comments: [
          comment({ id: 1, createdAt: '2026-08-01T10:00:00Z' }),
          comment({ id: 2, createdAt: '2026-08-01T10:05:00Z' }),
        ],
      })
    )
    const rows = groupPullRequestTimelineConversations(events)
    expect(rows.map((row) => row.kind)).toEqual([
      'comments',
      'event',
      'comments',
      'event',
    ])
  })
})

describe('orderPullRequestComments', () => {
  const comments = [
    comment({ id: 1, createdAt: '2026-08-01T10:00:00Z' }),
    comment({ id: 2, createdAt: '2026-08-01T11:00:00Z' }),
  ]

  it('keeps oldest-first as given and reverses for newest', () => {
    expect(
      orderPullRequestComments(comments, 'oldest').map((c) => c.id)
    ).toEqual([1, 2])
    expect(
      orderPullRequestComments(comments, 'newest').map((c) => c.id)
    ).toEqual([2, 1])
  })
})

describe('review outcomes', () => {
  it('maps only verdict states to outcomes', () => {
    expect(pullRequestReviewOutcome('approved')).toBe('approved')
    expect(pullRequestReviewOutcome('changesRequested')).toBe(
      'changes-requested'
    )
    expect(pullRequestReviewOutcome('dismissed')).toBe('dismissed')
    expect(pullRequestReviewOutcome('commented')).toBeNull()
    expect(pullRequestReviewOutcome('pending')).toBeNull()
    expect(pullRequestReviewOutcome(null)).toBeNull()
  })

  it('keeps one entry per reviewer: their newest verdict', () => {
    const outcomes = latestPullRequestReviewOutcomes([
      comment({
        id: 1,
        kind: 'review',
        reviewState: 'approved',
        createdAt: '2026-08-01T10:00:00Z',
      }),
      comment({
        id: 2,
        kind: 'review',
        reviewState: 'changesRequested',
        createdAt: '2026-08-01T11:00:00Z',
      }),
    ])
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]?.outcome).toBe('changes-requested')
  })

  it('lets a dismissal take a verdict back without showing itself', () => {
    const outcomes = latestPullRequestReviewOutcomes([
      comment({
        id: 1,
        kind: 'review',
        reviewState: 'approved',
        createdAt: '2026-08-01T10:00:00Z',
      }),
      comment({
        id: 2,
        kind: 'review',
        reviewState: 'dismissed',
        createdAt: '2026-08-01T11:00:00Z',
      }),
    ])
    expect(outcomes).toHaveLength(0)
  })

  it('keeps two authorless verdicts apart rather than collapsing them', () => {
    const outcomes = latestPullRequestReviewOutcomes([
      comment({
        id: 1,
        kind: 'review',
        authorLogin: '',
        reviewState: 'approved',
        createdAt: '2026-08-01T10:00:00Z',
      }),
      comment({
        id: 2,
        kind: 'review',
        authorLogin: '',
        reviewState: 'changesRequested',
        createdAt: '2026-08-01T11:00:00Z',
      }),
    ])
    expect(outcomes).toHaveLength(2)
  })

  it('dims a verdict given before the newest commit', () => {
    const commits = [commit('abc1234', '2026-08-01T12:00:00Z')]
    const outcomes = latestPullRequestReviewOutcomes(
      [
        comment({
          id: 1,
          kind: 'review',
          reviewState: 'approved',
          createdAt: '2026-08-01T10:00:00Z',
        }),
      ],
      commits
    )
    expect(outcomes[0]?.stale).toBe(true)
  })
})

describe('verdict staleness against commit dates', () => {
  it('finds the newest parseable commit date', () => {
    expect(
      newestPullRequestCommitAt([
        commit('a', '2026-08-01T10:00:00Z'),
        commit('b', 'not-a-date'),
        commit('c', '2026-08-02T10:00:00Z'),
      ])
    ).toBe('2026-08-02T10:00:00Z')
    expect(newestPullRequestCommitAt([])).toBeNull()
  })

  it('sorts by instant rather than by text across offsets', () => {
    // +02:00 sorts after Z as text while falling before it in time.
    expect(
      isPullRequestVerdictStale(
        '2026-07-05T01:00:00+02:00',
        '2026-07-05T00:30:00Z'
      )
    ).toBe(true)
  })

  it('leaves a verdict alone when nothing can be said', () => {
    expect(isPullRequestVerdictStale('2026-08-01T10:00:00Z', null)).toBe(false)
    expect(isPullRequestVerdictStale('garbage', '2026-08-01T10:00:00Z')).toBe(
      false
    )
  })
})

describe('visibleBody', () => {
  it('treats a body that is only HTML comments as no body', () => {
    expect(visibleBody('<!-- a -->\n<!-- b -->')).toBeNull()
  })

  it('passes a real body on whole, markers included', () => {
    expect(visibleBody('  keep <!-- marker --> me  ')).toBe(
      'keep <!-- marker --> me'
    )
  })
})

describe('shouldRefreshPullRequestActivity', () => {
  it('refreshes only when the same pull request reports a newer revision', () => {
    const previous = { key: 'ws-1', updatedAt: '2026-08-01T10:00:00Z' }
    expect(
      shouldRefreshPullRequestActivity(previous, {
        key: 'ws-1',
        updatedAt: '2026-08-01T11:00:00Z',
      })
    ).toBe(true)
    expect(shouldRefreshPullRequestActivity(previous, previous)).toBe(false)
    expect(
      shouldRefreshPullRequestActivity(null, {
        key: 'ws-1',
        updatedAt: '2026-08-01T11:00:00Z',
      })
    ).toBe(false)
    expect(
      shouldRefreshPullRequestActivity(previous, {
        key: 'ws-2',
        updatedAt: '2026-08-01T11:00:00Z',
      })
    ).toBe(false)
  })
})

describe('readableFailure', () => {
  it("prefers the host's own sentence", () => {
    expect(
      readableFailure(
        new Error('Pull request operation merge failed: branch protection'),
        'hint'
      )
    ).toBe('branch protection')
  })

  it('falls back to the hint for tool noise', () => {
    expect(readableFailure(new Error('GitHub CLI failed.'), 'hint')).toBe(
      'hint'
    )
    expect(readableFailure(new Error('exited with code 1'), 'hint')).toBe(
      'hint'
    )
    expect(readableFailure('', 'hint')).toBe('hint')
  })

  it('reads a message off an RpcError-shaped object', () => {
    expect(readableFailure({ message: 'rate limited' }, 'hint')).toBe(
      'rate limited'
    )
  })
})
