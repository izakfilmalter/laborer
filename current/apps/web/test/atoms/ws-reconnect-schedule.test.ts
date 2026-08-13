/**
 * Regression coverage for the loopback RPC WebSocket reconnection policy.
 *
 * `RpcClient.makeProtocolSocket` drives ONE schedule instance for the whole
 * client lifetime — every disconnect steps the same schedule and nothing
 * resets it on a successful reconnect. The old bounded schedule
 * (`Schedule.recurs(7)`) therefore budgeted 7 reconnects per app session
 * TOTAL; a few OS sleep/wake cycles exhausted it, the protocol fiber died,
 * and every later RPC failed permanently with
 * `RpcClientError: Error in socket` until the app restarted.
 *
 * These tests pin the two properties that prevent that failure mode:
 * 1. the schedule never terminates, and
 * 2. backoff rewinds to the initial delay after
 *    WS_RECONNECT_RESET_AFTER_MS, so a disconnect following a long stable
 *    connection retries fast instead of at the backoff cap.
 */

import { Clock, Effect, Fiber } from 'effect'
import { TestClock } from 'effect/testing'
import { describe, expect, it } from 'vitest'
import { wsReconnectRetrySchedule } from '@/atoms/laborer-client'
import {
  getWsReconnectDelayMsForRetry,
  WS_RECONNECT_INITIAL_DELAY_MS,
  WS_RECONNECT_MAX_DELAY_MS,
} from '@/atoms/ws-connection-state'

const runWithTestClock = <A>(effect: Effect.Effect<A>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, TestClock.layer()))

describe('wsReconnectRetrySchedule', () => {
  it('never exhausts, unlike the old bounded schedule', async () =>
    runWithTestClock(
      Effect.gen(function* () {
        let attempts = 0
        const alwaysDisconnecting = Effect.suspend(() => {
          attempts += 1
          return Effect.fail(`disconnect ${attempts}`)
        })

        const fiber = yield* Effect.forkChild(
          alwaysDisconnecting.pipe(
            Effect.retry(wsReconnectRetrySchedule),
            Effect.ignore
          )
        )
        yield* TestClock.adjust('10 minutes')

        // The old schedule allowed 8 attempts total (1 + 7 retries) before
        // permanently killing the protocol. Ten simulated minutes of outage
        // must keep retrying far beyond that.
        expect(attempts).toBeGreaterThan(8)
        // Still retrying — the schedule must never complete on its own.
        expect(fiber.pollUnsafe()).toBeUndefined()

        yield* Fiber.interrupt(fiber)
      })
    ))

  it('backs off exponentially, then rewinds to the initial delay', async () =>
    runWithTestClock(
      Effect.gen(function* () {
        const attemptTimes: number[] = []
        const alwaysDisconnecting = Effect.gen(function* () {
          attemptTimes.push(yield* Clock.currentTimeMillis)
          return yield* Effect.fail('disconnect')
        })

        const fiber = yield* Effect.forkChild(
          alwaysDisconnecting.pipe(
            Effect.retry(wsReconnectRetrySchedule),
            Effect.ignore
          )
        )
        yield* TestClock.adjust('40 seconds')
        yield* Fiber.interrupt(fiber)

        const delays = attemptTimes
          .slice(1)
          .map((time, index) => time - attemptTimes[index])

        // 1s → 2s → 4s → 8s → 16s, then 31s of cumulative outage crosses
        // WS_RECONNECT_RESET_AFTER_MS and the backoff rewinds to 1s.
        expect(delays.slice(0, 6)).toEqual([
          1000, 2000, 4000, 8000, 16_000, 1000,
        ])
      })
    ))

  it('retries at the initial delay after a long stable connection', async () =>
    runWithTestClock(
      Effect.gen(function* () {
        const attemptTimes: number[] = []
        let attempts = 0
        // Two quick disconnects, then a connection that stays up for two
        // hours before dropping — the post-sleep scenario.
        const connection = Effect.gen(function* () {
          attempts += 1
          attemptTimes.push(yield* Clock.currentTimeMillis)
          if (attempts === 3) {
            yield* Effect.sleep('2 hours')
          }
          return yield* Effect.fail('disconnect')
        })

        const fiber = yield* Effect.forkChild(
          connection.pipe(Effect.retry(wsReconnectRetrySchedule), Effect.ignore)
        )
        yield* TestClock.adjust('3 hours')
        yield* Fiber.interrupt(fiber)

        // Attempts: t=0 (fails), t=1s (fails), t=3s (stable 2h, then fails).
        // The next retry must come WS_RECONNECT_INITIAL_DELAY_MS after that
        // late failure — not at the 4s the old sequence would continue with,
        // and never "exhausted".
        const stableConnectionStart = attemptTimes[2]
        const failureAfterStable = stableConnectionStart + 2 * 60 * 60 * 1000
        expect(attemptTimes[3]).toBe(
          failureAfterStable + WS_RECONNECT_INITIAL_DELAY_MS
        )
      })
    ))
})

describe('getWsReconnectDelayMsForRetry', () => {
  it('starts at the initial delay', () => {
    expect(getWsReconnectDelayMsForRetry(0)).toBe(WS_RECONNECT_INITIAL_DELAY_MS)
  })

  it('clamps at the max delay instead of exhausting', () => {
    expect(getWsReconnectDelayMsForRetry(6)).toBe(WS_RECONNECT_MAX_DELAY_MS)
    // The old implementation returned null here, which fed the
    // "exhausted" state; reconnection never exhausts now.
    expect(getWsReconnectDelayMsForRetry(7)).toBe(WS_RECONNECT_MAX_DELAY_MS)
    expect(getWsReconnectDelayMsForRetry(100)).toBe(WS_RECONNECT_MAX_DELAY_MS)
  })

  it('treats invalid indexes as the first retry', () => {
    expect(getWsReconnectDelayMsForRetry(-1)).toBe(
      WS_RECONNECT_INITIAL_DELAY_MS
    )
    expect(getWsReconnectDelayMsForRetry(1.5)).toBe(
      WS_RECONNECT_INITIAL_DELAY_MS
    )
  })
})
