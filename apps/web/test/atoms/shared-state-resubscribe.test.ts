/**
 * Regression coverage for the shared-state subscription retry policy.
 *
 * The renderer owns ONE `state.subscribe` stream for its whole session.
 * Before the retry existed, any single failure — an OS sleep/wake dropping
 * the loopback WebSocket was enough — errored the stream, SharedStateBridge
 * silently stopped pulling, and the board froze on its last projection while
 * task mutations kept landing in the shared database. Newly created cards
 * (Slack or manual) never appeared until an app restart.
 *
 * These tests pin the two properties that prevent that failure mode:
 * 1. a failed subscription is re-run, so a fresh authoritative snapshot
 *    replaces the stale projection, and
 * 2. the schedule never terminates, no matter how many failures occur.
 */

import { describe, expect, it } from '@effect/vitest'
import { Effect, Fiber, Stream } from 'effect'
import { adjust } from 'effect/testing/TestClock'
import { sharedStateResubscribeSchedule } from '../../src/atoms/shared-state'

describe('sharedStateResubscribeSchedule', () => {
  it.effect(
    're-subscribes after a mid-stream failure and receives the fresh snapshot',
    () =>
      Effect.gen(function* () {
        let subscriptions = 0
        // First subscription delivers a snapshot then dies (socket drop);
        // the second delivers the fresh snapshot a real server would send.
        const subscription = Stream.suspend(() => {
          subscriptions += 1
          return subscriptions === 1
            ? Stream.concat(
                Stream.make('snapshot-1'),
                Stream.fail('socket dropped' as const)
              )
            : Stream.make(`snapshot-${subscriptions}`)
        })

        const fiber = yield* subscription.pipe(
          Stream.retry(sharedStateResubscribeSchedule),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild
        )
        yield* adjust('1 minute')

        const collected = yield* Fiber.join(fiber)
        expect([...collected]).toEqual(['snapshot-1', 'snapshot-2'])
        expect(subscriptions).toBe(2)
      })
  )

  it.effect('never exhausts, so the projection cannot freeze permanently', () =>
    Effect.gen(function* () {
      let attempts = 0
      const alwaysFailing = Stream.suspend(() => {
        attempts += 1
        return Stream.fail(`disconnect ${attempts}` as const)
      })

      const fiber = yield* alwaysFailing.pipe(
        Stream.retry(sharedStateResubscribeSchedule),
        Stream.runDrain,
        Effect.ignore,
        Effect.forkChild
      )
      yield* adjust('10 minutes')

      // Ten simulated minutes of outage must keep re-subscribing; a
      // bounded budget here would recreate the frozen-board failure.
      expect(attempts).toBeGreaterThan(8)
      // Still retrying — the schedule must never complete on its own.
      expect(fiber.pollUnsafe()).toBeUndefined()

      yield* Fiber.interrupt(fiber)
    })
  )
})
