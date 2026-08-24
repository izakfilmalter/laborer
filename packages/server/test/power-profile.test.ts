/**
 * PowerProfile service, payload decoding, and interval lookup tests.
 *
 * The daemon derives its power profile from desktop `powerMonitor`
 * signals pushed to `POST /daemon/power-state`. These tests cover the
 * three pieces that endpoint composes: Schema decoding of the payload,
 * profile transitions in the service, and the per-profile knob lookups
 * (PR polling intervals and PTY coalesce window).
 */

import { assert, describe, it } from '@effect/vitest'
import { Context, Duration, Effect, Fiber, Layer, Schema, Stream } from 'effect'
import { TestClock } from 'effect/testing'
import {
  PR_BACKGROUND_POLL_INTERVAL_MS,
  PR_BACKGROUND_POLL_INTERVAL_PERFORMANCE_MS,
  PR_VISIBLE_POLL_INTERVAL_MS,
  PR_VISIBLE_POLL_INTERVAL_PERFORMANCE_MS,
  prPollIntervalsForProfile,
} from '../src/services/polling-intervals.js'
import {
  BATTERY_SAVER_COALESCE_WINDOW_MS,
  coalesceWindowMsForProfile,
  DEFAULT_POWER_PROFILE,
  PERFORMANCE_COALESCE_WINDOW_MS,
  PowerProfileService,
  PowerStatePayload,
  profileForPowerState,
} from '../src/services/power-profile.js'

const buildService = Effect.gen(function* () {
  const context = yield* Layer.build(PowerProfileService.layer)
  return Context.get(context, PowerProfileService)
})

describe('PowerStatePayload', () => {
  const decode = Schema.decodeUnknownEffect(PowerStatePayload)

  it.effect('decodes ac and battery payloads', () =>
    Effect.gen(function* () {
      const ac = yield* decode({ powerState: 'ac' })
      const battery = yield* decode({ powerState: 'battery' })
      assert.strictEqual(ac.powerState, 'ac')
      assert.strictEqual(battery.powerState, 'battery')
    })
  )

  it.effect('rejects unknown states, missing fields, and non-objects', () =>
    Effect.gen(function* () {
      for (const body of [
        { powerState: 'low-power' },
        { powerState: 1 },
        {},
        null,
        'ac',
        ['ac'],
      ]) {
        const result = yield* decode(body).pipe(Effect.result)
        assert.strictEqual(result._tag, 'Failure', JSON.stringify(body))
      }
    })
  )
})

describe('PowerProfileService', () => {
  it.effect('starts on battery-saver so a missing signal never regresses', () =>
    Effect.gen(function* () {
      const service = yield* buildService
      assert.strictEqual(yield* service.getProfile, 'battery-saver')
      assert.strictEqual(DEFAULT_POWER_PROFILE, 'battery-saver')
    }).pipe(Effect.scoped)
  )

  it.effect('maps ac to performance and battery back to battery-saver', () =>
    Effect.gen(function* () {
      const service = yield* buildService

      assert.strictEqual(yield* service.setPowerState('ac'), 'performance')
      assert.strictEqual(yield* service.getProfile, 'performance')

      assert.strictEqual(
        yield* service.setPowerState('battery'),
        'battery-saver'
      )
      assert.strictEqual(yield* service.getProfile, 'battery-saver')
    }).pipe(Effect.scoped)
  )

  it.effect('publishes profile changes to subscribers', () =>
    Effect.gen(function* () {
      const service = yield* buildService
      const fiber = yield* service.changes.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild
      )
      // Let the subscriber register before the transition so it observes
      // both the initial value and the change (it.effect runs under the
      // TestClock, so adjust instead of sleeping).
      yield* TestClock.adjust(Duration.millis(1))
      yield* service.setPowerState('ac')
      const seen = yield* Fiber.join(fiber)
      assert.deepStrictEqual([...seen], ['battery-saver', 'performance'])
    }).pipe(Effect.scoped)
  )
})

describe('profile knob lookups', () => {
  it('profileForPowerState covers both states', () => {
    assert.strictEqual(profileForPowerState('ac'), 'performance')
    assert.strictEqual(profileForPowerState('battery'), 'battery-saver')
  })

  it('returns the performance PR intervals (5s visible / 60s background)', () => {
    assert.deepStrictEqual(prPollIntervalsForProfile('performance'), {
      backgroundMs: PR_BACKGROUND_POLL_INTERVAL_PERFORMANCE_MS,
      visibleMs: PR_VISIBLE_POLL_INTERVAL_PERFORMANCE_MS,
    })
    assert.strictEqual(PR_VISIBLE_POLL_INTERVAL_PERFORMANCE_MS, 5000)
    assert.strictEqual(PR_BACKGROUND_POLL_INTERVAL_PERFORMANCE_MS, 60_000)
  })

  it('returns the battery-saver PR intervals (60s visible / 5min background)', () => {
    assert.deepStrictEqual(prPollIntervalsForProfile('battery-saver'), {
      backgroundMs: PR_BACKGROUND_POLL_INTERVAL_MS,
      visibleMs: PR_VISIBLE_POLL_INTERVAL_MS,
    })
    assert.strictEqual(PR_VISIBLE_POLL_INTERVAL_MS, 60_000)
    assert.strictEqual(PR_BACKGROUND_POLL_INTERVAL_MS, 300_000)
  })

  it('returns the coalesce window per profile (8ms AC / 16ms battery)', () => {
    assert.strictEqual(
      coalesceWindowMsForProfile('performance'),
      PERFORMANCE_COALESCE_WINDOW_MS
    )
    assert.strictEqual(
      coalesceWindowMsForProfile('battery-saver'),
      BATTERY_SAVER_COALESCE_WINDOW_MS
    )
    assert.strictEqual(PERFORMANCE_COALESCE_WINDOW_MS, 8)
    assert.strictEqual(BATTERY_SAVER_COALESCE_WINDOW_MS, 16)
  })
})
