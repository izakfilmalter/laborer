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

  it.effect('routes stdout and stderr to the log file and closes its end', () =>
    Effect.gen(function* () {
      const child = new FakeChild()
      const closed: number[] = []
      let stdio: unknown
      const launcher = makeProcessLauncher(
        (_file, _args, options) => {
          stdio = options.stdio
          return child
        },
        () => 7,
        (descriptor) => closed.push(descriptor)
      )
      const fiber = yield* Effect.forkChild(
        launcher.launchDetached({
          args: [],
          cwd: '/tmp',
          env: {},
          file: '/bin/test',
          logFile: '/tmp/laborer/daemon.log',
        })
      )
      yield* Effect.yieldNow

      assert.deepStrictEqual(stdio, ['ignore', 7, 7])
      assert.deepStrictEqual(closed, [7])

      yield* Fiber.interrupt(fiber)
    })
  )

  it.effect('still launches when the log file cannot be opened', () =>
    Effect.gen(function* () {
      const child = new FakeChild()
      let stdio: unknown
      const launcher = makeProcessLauncher(
        (_file, _args, options) => {
          stdio = options.stdio
          return child
        },
        () => undefined
      )
      const fiber = yield* Effect.forkChild(
        launcher.launchDetached({
          args: [],
          cwd: '/tmp',
          env: {},
          file: '/bin/test',
          logFile: '/unwritable/daemon.log',
        })
      )
      yield* Effect.yieldNow

      assert.strictEqual(stdio, 'ignore')

      yield* Fiber.interrupt(fiber)
    })
  )
})
