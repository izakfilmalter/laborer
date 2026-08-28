import { beforeEach, describe, expect, it } from 'vitest'
import {
  type PendingReviewComment,
  usePullRequestReviewStore,
} from '@/components/pull-request/review-store'

function comment(id: string, body = id): PendingReviewComment {
  return {
    id,
    body,
    path: 'src/app.ts',
    position: { kind: 'added', newLine: 1 },
  }
}

describe('pull request review drafts', () => {
  beforeEach(() => {
    usePullRequestReviewStore.setState({ drafts: {}, summaries: {} })
  })

  it('removes only the line comments included in a submitted snapshot', () => {
    const store = usePullRequestReviewStore.getState()
    store.addComment('ws-a', comment('submitted'))
    const submittedIds =
      usePullRequestReviewStore
        .getState()
        .drafts['ws-a']?.map((entry) => entry.id) ?? []

    usePullRequestReviewStore
      .getState()
      .addComment('ws-a', comment('added-in-flight'))
    usePullRequestReviewStore.getState().removeComments('ws-a', submittedIds)

    expect(usePullRequestReviewStore.getState().drafts['ws-a']).toEqual([
      comment('added-in-flight'),
    ])
  })

  it('keeps summary bodies isolated by workspace key', () => {
    const store = usePullRequestReviewStore.getState()
    store.setSummary('ws-a', 'Summary A')
    store.setSummary('ws-b', 'Summary B')
    store.clearSummary('ws-a', 'Summary A')

    expect(usePullRequestReviewStore.getState().summaries).toEqual({
      'ws-b': 'Summary B',
    })
  })

  it('does not clear a summary revised while submission is in flight', () => {
    const store = usePullRequestReviewStore.getState()
    store.setSummary('ws-a', 'Submitted body')
    usePullRequestReviewStore.getState().setSummary('ws-a', 'Revised body')
    usePullRequestReviewStore.getState().clearSummary('ws-a', 'Submitted body')

    expect(usePullRequestReviewStore.getState().summaries['ws-a']).toBe(
      'Revised body'
    )
  })

  it('drops a draft entry entirely once its last comment is discarded', () => {
    const store = usePullRequestReviewStore.getState()
    store.addComment('ws-a', comment('only'))
    usePullRequestReviewStore.getState().removeComment('ws-a', 'only')

    expect(usePullRequestReviewStore.getState().drafts).toEqual({})
  })
})
