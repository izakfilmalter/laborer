/**
 * DockerDetection — Effect Service
 *
 * Checks whether Docker (via OrbStack) is available on the system.
 * Runs on server startup and caches the result. Exposes the status
 * via the `docker.status` RPC so the web UI can show a warning
 * banner when Docker is missing.
 *
 * Detection logic:
 * 1. Check if `docker` CLI exists on PATH via `which docker`
 * 2. Check if Docker daemon is running via `docker info`
 *
 * The result is cached after the first check — Docker availability
 * is unlikely to change during a server session.
 *
 * Issue 2: Docker prerequisite detection
 */

import { Context, Effect, Layer, Ref } from 'effect'
import { spawn } from '../lib/spawn.js'

/**
 * Result of the Docker prerequisite check.
 */
interface DockerStatus {
  /** Whether Docker is available and the daemon is running. */
  readonly available: boolean
  /** Human-readable error message when Docker is unavailable. */
  readonly error?: string | undefined
}

/** Module-level log annotation for structured logging. */
const logPrefix = 'DockerDetection'

class DockerDetection extends Context.Tag('@laborer/DockerDetection')<
  DockerDetection,
  {
    /**
     * Check whether Docker is available on the system.
     *
     * Returns a cached result after the first invocation. Checks:
     * 1. `which docker` — is the CLI on PATH?
     * 2. `docker info` — is the daemon running?
     */
    readonly check: () => Effect.Effect<DockerStatus>
  }
>() {
  static readonly layer = Layer.effect(
    DockerDetection,
    Effect.gen(function* () {
      const cachedStatus = yield* Ref.make<DockerStatus | null>(null)

      const runDetection = Effect.gen(function* () {
        // Step 1: Check if `docker` CLI exists on PATH
        const whichExitCode = yield* Effect.promise(async () => {
          try {
            const proc = spawn(['which', 'docker'], {
              stdout: 'pipe',
              stderr: 'pipe',
            })
            return await proc.exited
          } catch {
            return 1
          }
        })

        if (whichExitCode !== 0) {
          const status: DockerStatus = {
            available: false,
            error:
              'Docker CLI not found on PATH. Install OrbStack from https://orbstack.dev to enable containerized dev servers.',
          }
          yield* Effect.logWarning('Docker CLI not found on PATH').pipe(
            Effect.annotateLogs('module', logPrefix)
          )
          return status
        }

        // Step 2: Check if Docker daemon is running
        const infoResult = yield* Effect.promise(async () => {
          try {
            const proc = spawn(['docker', 'info'], {
              stdout: 'pipe',
              stderr: 'pipe',
            })
            const exitCode = await proc.exited
            const stderr = await new Response(proc.stderr).text()
            return { exitCode, stderr }
          } catch {
            return { exitCode: 1, stderr: 'Failed to run docker info' }
          }
        })

        if (infoResult.exitCode !== 0) {
          const status: DockerStatus = {
            available: false,
            error:
              'Docker daemon is not running. Start OrbStack or Docker Desktop to enable containerized dev servers.',
          }
          yield* Effect.logWarning(
            `Docker daemon not running: ${infoResult.stderr.trim()}`
          ).pipe(Effect.annotateLogs('module', logPrefix))
          return status
        }

        const status: DockerStatus = { available: true }
        yield* Effect.logInfo('Docker is available').pipe(
          Effect.annotateLogs('module', logPrefix)
        )
        return status
      })

      const check = Effect.fn('DockerDetection.check')(function* () {
        const cached = yield* Ref.get(cachedStatus)
        if (cached !== null) {
          return cached
        }

        const status = yield* runDetection
        yield* Ref.set(cachedStatus, status)
        return status
      })

      // Run detection eagerly on service construction so the result
      // is cached by the time the first RPC call arrives.
      yield* check()

      return DockerDetection.of({
        check,
      })
    })
  )
}

export { DockerDetection }
export type { DockerStatus }
