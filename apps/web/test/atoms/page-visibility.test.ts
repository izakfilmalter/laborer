/**
 * Regression coverage for the shared page-visibility polling primitives:
 * polls run immediately and on the interval while visible, pause entirely
 * while the document is hidden, and refresh immediately when visibility
 * returns.
 *
 * The atom registry delivers stream subscriptions through real scheduler
 * tasks that the TestClock cannot flush, so tests interleave `flushTasks`
 * (a real macrotask hop) with TestClock adjustments.
 *
 * @see apps/web/src/atoms/page-visibility.ts
 */

import { describe, expect, it } from '@effect/vitest'
import { Duration, Effect, Fiber } from 'effect'
import { TestClock } from 'effect/testing'
import { AtomRegistry } from 'effect/unstable/reactivity'
import { afterEach } from 'vitest'

import {
  pageVisibleAtom,
  pollWhileVisible,
} from '../../src/atoms/page-visibility'

const setDocumentVisibility = (state: DocumentVisibilityState) => {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

/** Let registry scheduler tasks (stream subscriptions) run for real. */
const flushTasks = Effect.promise(async () => {
  for (let hop = 0; hop < 8; hop += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })
  }
})

afterEach(() => {
  setDocumentVisibility('visible')
})

describe('pageVisibleAtom', () => {
  it('tracks document visibility transitions', () => {
    const registry = AtomRegistry.make()
    const seen: boolean[] = []
    registry.subscribe(pageVisibleAtom, (visible) => seen.push(visible), {
      immediate: true,
    })

    expect(seen).toEqual([true])
    setDocumentVisibility('hidden')
    expect(seen).toEqual([true, false])
    setDocumentVisibility('visible')
    expect(seen).toEqual([true, false, true])
    registry.dispose()
  })
})

describe('pollWhileVisible', () => {
  const countingLoop = (
    registry: AtomRegistry.AtomRegistry,
    onPoll: () => void,
    intervalMs: number
  ) =>
    Effect.forkChild(
      pollWhileVisible(Effect.sync(onPoll), intervalMs).pipe(
        Effect.provideService(AtomRegistry.AtomRegistry, registry)
      )
    )

  it.effect('polls immediately, then once per interval while visible', () =>
    Effect.gen(function* () {
      const registry = AtomRegistry.make()
      let polls = 0
      const fiber = yield* countingLoop(
        registry,
        () => {
          polls += 1
        },
        1000
      )

      yield* flushTasks
      expect(polls).toBe(1)
      yield* TestClock.adjust(Duration.millis(1000))
      yield* flushTasks
      expect(polls).toBe(2)
      yield* TestClock.adjust(Duration.millis(500))
      yield* flushTasks
      expect(polls).toBe(2)
      yield* TestClock.adjust(Duration.millis(500))
      yield* flushTasks
      expect(polls).toBe(3)

      yield* Fiber.interrupt(fiber)
      registry.dispose()
    })
  )

  it.effect('pauses while hidden and polls immediately on return', () =>
    Effect.gen(function* () {
      setDocumentVisibility('hidden')
      const registry = AtomRegistry.make()
      let polls = 0
      const fiber = yield* countingLoop(
        registry,
        () => {
          polls += 1
        },
        1000
      )

      yield* flushTasks
      yield* TestClock.adjust(Duration.millis(5000))
      yield* flushTasks
      expect(polls).toBe(0)

      setDocumentVisibility('visible')
      yield* flushTasks
      expect(polls).toBe(1)

      yield* Fiber.interrupt(fiber)
      registry.dispose()
    })
  )

  it.effect('wakes mid-interval when visibility returns', () =>
    Effect.gen(function* () {
      const registry = AtomRegistry.make()
      let polls = 0
      const fiber = yield* countingLoop(
        registry,
        () => {
          polls += 1
        },
        60_000
      )

      yield* flushTasks
      expect(polls).toBe(1)

      setDocumentVisibility('hidden')
      setDocumentVisibility('visible')
      yield* flushTasks
      expect(polls).toBe(2)

      // The interval keeps ticking from the refreshed poll.
      yield* TestClock.adjust(Duration.millis(60_000))
      yield* flushTasks
      expect(polls).toBe(3)

      yield* Fiber.interrupt(fiber)
      registry.dispose()
    })
  )
})
