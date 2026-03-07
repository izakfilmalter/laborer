import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { makeTestRpcClient } from './test-layer.js'

describe('LaborerRpcs', () => {
  it.scoped('health.check returns ok with uptime', () =>
    Effect.gen(function* () {
      const client = yield* makeTestRpcClient
      const response = yield* client.health.check()

      assert.strictEqual(response.status, 'ok')
      assert.isTrue(Number.isFinite(response.uptime))
      assert.isTrue(response.uptime >= 0)
    })
  )
})
