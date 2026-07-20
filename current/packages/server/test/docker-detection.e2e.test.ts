/**
 * DockerDetection e2e test.
 *
 * Exercises the real DockerDetection service against the actual Docker
 * CLI / OrbStack daemon on the host. Verifies that when Docker is
 * available, the service correctly detects it.
 *
 * Requires Docker (OrbStack) to be running on the host.
 */

import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { DockerDetection } from '../src/services/docker-detection.js'

describe('DockerDetection e2e', () => {
  it.scoped(
    'reports Docker as available when OrbStack is running',
    () =>
      Effect.gen(function* () {
        const detection = yield* DockerDetection
        const status = yield* detection.check()

        assert.isTrue(
          status.available,
          `Expected Docker to be available, but got error: ${status.error}`
        )
        assert.isUndefined(status.error)
      }).pipe(Effect.provide(DockerDetection.layer)),
    { timeout: 15_000 }
  )
})
