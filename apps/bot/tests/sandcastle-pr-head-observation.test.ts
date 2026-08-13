import { describe, expect, it } from '@effect/vitest'
import {
  PrHeadObservationError,
  waitForExpectedPrHead,
} from '../../.sandcastle/pr-head-observation/index.ts'

describe('Sandcastle PR head observation', () => {
  it("allows GitHub's PR head view to converge after a push", async () => {
    const heads = ['old', 'old', 'expected']
    let now = 0

    await waitForExpectedPrHead({
      expectedHead: 'expected',
      now: () => now,
      pause: () => {
        now += 1000
        return Promise.resolve()
      },
      readHead: () => heads.shift() ?? 'expected',
      timeoutMs: 5000,
    })
  })

  it('fails closed when the observed head never converges', async () => {
    let now = 0

    await expect(
      waitForExpectedPrHead({
        expectedHead: 'expected',
        now: () => now,
        pause: () => {
          now += 1000
          return Promise.resolve()
        },
        readHead: () => 'wrong',
        timeoutMs: 2000,
      })
    ).rejects.toBeInstanceOf(PrHeadObservationError)
  })
})
