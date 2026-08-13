import { assert, describe, it } from '@effect/vitest'
import {
  appendSpecProgress,
  assertPullRequestTargets,
  createSpecPullRequestBody,
  implementationMarker,
  recordReviewedHead,
  reviewedHeadFromBody,
  reviewedHeadMarker,
  specClosureOrder,
} from '../../../.sandcastle/spec-pr-progress/index.ts'

const acceptedHead = 'a'.repeat(40)
const reviewedHead = 'b'.repeat(40)

describe('Sandcastle shared spec PR progress', () => {
  it('creates a draft body that tracks the root without closing it', () => {
    assert.strictEqual(
      createSpecPullRequestBody(266, 267, acceptedHead),
      [
        'Implements the descendant issues of #266 on one cumulative branch.',
        '',
        'Tracks #266',
        '',
        '<!-- sandcastle-pre-publish-review-complete -->',
        `<!-- sandcastle-implemented:#267@${acceptedHead} -->`,
      ].join('\n')
    )
  })

  it('appends missing root, review, and leaf markers without replacing existing PR content', () => {
    assert.strictEqual(
      appendSpecProgress('Human-authored context\n', 266, 267, acceptedHead),
      [
        'Human-authored context',
        '',
        'Tracks #266',
        '<!-- sandcastle-pre-publish-review-complete -->',
        `<!-- sandcastle-implemented:#267@${acceptedHead} -->`,
      ].join('\n')
    )
  })

  it("is idempotent and uses the scheduler's exact implementation marker", () => {
    const body = createSpecPullRequestBody(266, 267, acceptedHead)

    assert.strictEqual(appendSpecProgress(body, 266, 267, acceptedHead), body)
    assert.strictEqual(
      implementationMarker(267, acceptedHead),
      `<!-- sandcastle-implemented:#267@${acceptedHead} -->`
    )
  })

  it('records one reviewed head and invalidates it when new leaf work arrives', () => {
    const body = recordReviewedHead(
      createSpecPullRequestBody(266, 267, acceptedHead),
      reviewedHead
    )

    assert.strictEqual(reviewedHeadFromBody(body), reviewedHead)
    assert.ok(body.includes(reviewedHeadMarker(reviewedHead)))
    assert.strictEqual(
      reviewedHeadFromBody(appendSpecProgress(body, 266, 268, reviewedHead)),
      undefined
    )
  })

  it('rejects ambiguous reviewed-head markers', () => {
    assert.throws(() =>
      reviewedHeadFromBody(
        [
          reviewedHeadMarker(acceptedHead),
          reviewedHeadMarker(reviewedHead),
        ].join('\n')
      )
    )
  })

  it('rejects invalid issue identities', () => {
    assert.throws(() => implementationMarker(0, acceptedHead))
    assert.throws(() => implementationMarker(267, 'not-a-sha'))
    assert.throws(() =>
      createSpecPullRequestBody(266, Number.NaN, acceptedHead)
    )
  })

  it('closes descendants from leaves upward and the root last', () => {
    assert.deepStrictEqual(specClosureOrder([267, 268], 266), [268, 267, 266])
    assert.throws(() => specClosureOrder([267, 267], 266))
    assert.throws(() => specClosureOrder([266], 266))
  })

  it('rejects a same-named PR with the wrong base or repository ownership', () => {
    const identity = {
      baseRefName: 'master',
      headRefName: 'sandcastle/spec-266',
      isCrossRepository: false,
    }

    assert.doesNotThrow(() =>
      assertPullRequestTargets(identity, 'master', 'sandcastle/spec-266')
    )
    assert.throws(() =>
      assertPullRequestTargets(identity, 'release', 'sandcastle/spec-266')
    )
    assert.throws(() =>
      assertPullRequestTargets(
        { ...identity, isCrossRepository: true },
        'master',
        'sandcastle/spec-266'
      )
    )
  })
})
