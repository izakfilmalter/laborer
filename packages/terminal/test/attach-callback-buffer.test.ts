/**
 * `terminal.attach` callback buffer sizing tests.
 *
 * The attach stream buffers events in a bounded callback queue and fails the
 * stream with `TERMINAL_ATTACH_OVERFLOW` when that queue fills. The bound is
 * an *event count*, while PTY flow control (ADR 0002) bounds *characters* in
 * flight, so the count must be large enough to absorb a realistic consumer
 * stall without the flow-control watermark ever being reached — otherwise a
 * momentarily slow renderer is disconnected while the contract is honored.
 *
 * These tests drive `makeAttachStream` directly with a fake TerminalManager
 * that floods the subscriber synchronously before the stream is pulled, which
 * is the worst case a stalled consumer can produce and is fully deterministic.
 *
 * @see docs/adr/0002-flow-control-only-while-attached.md
 */

import { assert, describe, it } from '@effect/vitest'
import type { TerminalAttachEvent } from '@laborer/shared/rpc'
import { Effect, Result, Stream } from 'effect'

import { makeAttachStream } from '../src/rpc/handlers.js'
import type { TerminalManager } from '../src/services/terminal-manager.js'
import { TERMINAL_ATTACH_CALLBACK_ITEMS_DEFAULT } from '../src/services/terminal-transport.js'

/** The event count that used to overflow the attach queue. */
const PREVIOUS_CALLBACK_ITEMS = 64

/**
 * Worst-case in-flight events for a 5s consumer stall: ~125 coalesced deltas
 * per second, plus a 512KB snapshot split into 16KB wire chunks, plus the
 * Meta/Reset/ReplayComplete envelope.
 */
const WORST_CASE_STALL_EVENTS = 125 * 5 + 32 + 3

const delta = (cursor: number): TerminalAttachEvent => ({
  _tag: 'Delta',
  cursor,
  data: `chunk-${cursor}`,
})

/**
 * A TerminalManager whose `attach` synchronously pushes `eventCount` deltas
 * into the subscriber before returning — i.e. the consumer has not pulled a
 * single item yet.
 */
const floodingManager = (eventCount: number): TerminalManager['Service'] => {
  const partial: Pick<TerminalManager['Service'], 'attach' | 'unsubscribe'> = {
    attach: (_terminalId, _options, subscriber) =>
      Effect.sync(() => {
        for (let cursor = 0; cursor < eventCount; cursor++) {
          subscriber(delta(cursor))
        }
        return { subscriberId: 'flood-subscriber' }
      }),
    unsubscribe: () => Effect.void,
  }
  return partial as TerminalManager['Service']
}

const collectBurst = (eventCount: number, callbackItems: number) =>
  makeAttachStream(floodingManager(eventCount), callbackItems, {
    id: 'terminal-1',
    leaseId: 'lease-1',
  }).pipe(
    Stream.take(eventCount),
    // A deliberately slow consumer: yield between every pulled item.
    Stream.tap(() => Effect.yieldNow),
    Stream.runCollect,
    Effect.result,
    Effect.scoped
  )

describe('terminal.attach callback buffer', () => {
  it.effect(
    'delivers a worst-case stall burst without failing the stream',
    () =>
      Effect.gen(function* () {
        const result = yield* collectBurst(
          WORST_CASE_STALL_EVENTS,
          TERMINAL_ATTACH_CALLBACK_ITEMS_DEFAULT
        )

        assert.isTrue(Result.isSuccess(result))
        if (Result.isSuccess(result)) {
          assert.strictEqual(result.success.length, WORST_CASE_STALL_EVENTS)
          assert.deepStrictEqual(result.success[0], delta(0))
          assert.deepStrictEqual(
            result.success.at(-1),
            delta(WORST_CASE_STALL_EVENTS - 1)
          )
        }
      })
  )

  it.effect('absorbs a burst that exceeds the previous 64-item bound', () =>
    Effect.gen(function* () {
      assert.isAbove(
        TERMINAL_ATTACH_CALLBACK_ITEMS_DEFAULT,
        WORST_CASE_STALL_EVENTS
      )

      const result = yield* collectBurst(
        PREVIOUS_CALLBACK_ITEMS + 1,
        TERMINAL_ATTACH_CALLBACK_ITEMS_DEFAULT
      )

      assert.isTrue(Result.isSuccess(result))
    })
  )

  it.effect('still fails loudly when the configured bound is exceeded', () =>
    Effect.gen(function* () {
      const callbackItems = 8
      const result = yield* collectBurst(callbackItems * 4, callbackItems)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure.code, 'TERMINAL_ATTACH_OVERFLOW')
        assert.include(result.failure.message, String(callbackItems))
        assert.include(
          result.failure.message,
          'flow-control contract violation'
        )
      }
    })
  )
})
