/**
 * DockerDetection e2e test.
 *
 * Exercises the real DockerDetection service against the actual Docker
 * CLI / OrbStack daemon on the host. Verifies that when Docker is
 * available, the service correctly detects it.
 *
 * Requires Docker (OrbStack) to be running on the host.
 */

import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { beforeAll } from 'vitest'
import { DockerDetection } from '../src/services/docker-detection.js'

/** Polyfill Bun.spawn for Node-based vitest. */
const ensureBunSpawnForNodeTests = (): void => {
  const runtimeGlobal = globalThis as unknown as { Bun?: unknown }

  if (runtimeGlobal.Bun !== undefined) {
    return
  }

  runtimeGlobal.Bun = {
    spawn: (
      cmd: string[],
      options?: {
        readonly cwd?: string
        readonly env?: Record<string, string | undefined>
      }
    ) => {
      const child = spawn(cmd[0] ?? '', cmd.slice(1), {
        cwd: options?.cwd,
        env: options?.env,
      })

      return {
        stdout:
          child.stdout === null
            ? new ReadableStream<Uint8Array>()
            : (Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>),
        stderr:
          child.stderr === null
            ? new ReadableStream<Uint8Array>()
            : (Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>),
        exited: new Promise<number>((resolve) => {
          child.on('close', (code) => resolve(code ?? 1))
        }),
      }
    },
  }
}

// Install polyfill before any tests run — DockerDetection.layer runs
// detection eagerly during construction, which happens inside
// Effect.provide(). The polyfill must be installed before that.
beforeAll(() => {
  ensureBunSpawnForNodeTests()
})

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
