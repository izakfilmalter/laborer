import { EventEmitter } from 'node:events'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Fiber } from 'effect'
import { makeProcessLauncher } from '../../src/services/process-launcher.js'

class FakeChild extends EventEmitter {
  unrefCount = 0

  unref(): this {
    this.unrefCount += 1
    return this
  }
}

describe('ProcessLauncher', () => {
  it.effect(
    'unrefs the child and removes launch listeners on interruption',
    () =>
      Effect.gen(function* () {
        const child = new FakeChild()
        const launcher = makeProcessLauncher(() => child)
        const fiber = yield* Effect.forkChild(
          launcher.launchDetached({
            args: [],
            cwd: '/tmp',
            env: {},
            file: '/bin/test',
          })
        )
        yield* Effect.yieldNow

        assert.strictEqual(child.unrefCount, 1)
        assert.strictEqual(child.listenerCount('error'), 1)
        assert.strictEqual(child.listenerCount('exit'), 1)

        yield* Fiber.interrupt(fiber)

        assert.strictEqual(child.listenerCount('error'), 0)
        assert.strictEqual(child.listenerCount('exit'), 0)
      })
  )
})
