import type { PullRequestReaction } from '@laborer/shared/rpc'
import { describe, expect, it } from 'vitest'
import {
  applyPendingPullRequestReactions,
  pullRequestReactionTooltip,
} from '@/components/pull-request/reactions-logic'

const reaction = (
  overrides: Partial<PullRequestReaction> = {}
): PullRequestReaction => ({
  content: 'thumbsUp',
  count: 2,
  viewerHasReacted: false,
  ...overrides,
})

describe('applyPendingPullRequestReactions', () => {
  it('leaves the list alone with nothing pending', () => {
    const reactions = [reaction()]
    expect(applyPendingPullRequestReactions(reactions, new Map())).toBe(
      reactions
    )
  })

  it('adds a pill for a first reaction in flight', () => {
    const shown = applyPendingPullRequestReactions(
      [],
      new Map([['heart', true] as const])
    )
    expect(shown).toEqual([
      { content: 'heart', count: 1, viewerHasReacted: true },
    ])
  })

  it('bumps and marks an existing pill the viewer just pressed', () => {
    const shown = applyPendingPullRequestReactions(
      [reaction()],
      new Map([['thumbsUp', true] as const])
    )
    expect(shown).toEqual([
      { content: 'thumbsUp', count: 3, viewerHasReacted: true },
    ])
  })

  it('removes a pill whose only reaction was taken back', () => {
    const shown = applyPendingPullRequestReactions(
      [reaction({ count: 1, viewerHasReacted: true })],
      new Map([['thumbsUp', false] as const])
    )
    expect(shown).toEqual([])
  })

  it('ignores a pending state the list already shows', () => {
    const shown = applyPendingPullRequestReactions(
      [reaction({ viewerHasReacted: true })],
      new Map([['thumbsUp', true] as const])
    )
    expect(shown).toEqual([reaction({ viewerHasReacted: true })])
  })
})

describe('pullRequestReactionTooltip', () => {
  it('counts people when the viewer is not among them', () => {
    expect(pullRequestReactionTooltip(reaction({ count: 2 }))).toBe(
      '2 people reacted with thumbs up emoji'
    )
  })

  it('names the viewer first and counts the rest as others', () => {
    expect(
      pullRequestReactionTooltip(reaction({ count: 3, viewerHasReacted: true }))
    ).toBe('You and 2 others reacted with thumbs up emoji')
  })

  it('says only You for a reaction the viewer alone gave', () => {
    expect(
      pullRequestReactionTooltip(reaction({ count: 1, viewerHasReacted: true }))
    ).toBe('You reacted with thumbs up emoji')
  })
})
