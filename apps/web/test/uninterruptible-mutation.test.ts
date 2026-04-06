import { Deferred, Effect, Exit, Fiber } from 'effect'
import { describe, expect, it } from 'vitest'

import { wrapUninterruptible } from '@/lib/uninterruptible-mutation'

describe('uninterruptible mutation wrapper', () => {
  it('runs the effect body to completion even when interrupted', async () => {
    const completed = { value: false }

    const program = Effect.gen(function* () {
      const latch = yield* Deferred.make<void>()

      const mutationEffect = Effect.gen(function* () {
        yield* Deferred.succeed(latch, undefined)
        yield* Effect.yieldNow()
        completed.value = true
        return 'done'
      })

      const wrapped = wrapUninterruptible(mutationEffect)
      const fiber = yield* Effect.fork(wrapped)

      // Wait for the effect to start, then interrupt
      yield* Deferred.await(latch)
      yield* Fiber.interrupt(fiber)
    })

    await Effect.runPromise(program)
    expect(completed.value).toBe(true)
  })

  it('allows the effect to fail normally (not swallow errors)', async () => {
    const exit = await Effect.runPromiseExit(
      wrapUninterruptible(Effect.fail('mutation-error' as const))
    )

    expect(Exit.isFailure(exit)).toBe(true)
  })

  it('returns the effect result when not interrupted', async () => {
    const result = await Effect.runPromise(
      wrapUninterruptible(Effect.succeed(42))
    )

    expect(result).toBe(42)
  })

  it('without the wrapper, interruption prevents completion', async () => {
    const completed = { value: false }

    const program = Effect.gen(function* () {
      const latch = yield* Deferred.make<void>()

      const mutationEffect = Effect.gen(function* () {
        yield* Deferred.succeed(latch, undefined)
        yield* Effect.yieldNow()
        completed.value = true
        return 'done'
      })

      const fiber = yield* Effect.fork(mutationEffect)
      yield* Deferred.await(latch)
      yield* Fiber.interrupt(fiber)
    })

    await Effect.runPromise(program)
    expect(completed.value).toBe(false)
  })
})
