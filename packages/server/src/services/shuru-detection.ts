/**
 * ShuruDetection — Effect Service
 *
 * Checks whether Shuru can be used on the current machine.
 *
 * Availability requirements for v1:
 * 1. macOS 14+ only
 * 2. Apple Silicon only
 * 3. `shuru` CLI must be available on PATH
 */

import { Context, Effect, Layer, Ref } from 'effect'
import { spawn } from '../lib/spawn.js'

interface ShuruStatus {
  readonly available: boolean
  readonly error?: string | undefined
}

const logPrefix = 'ShuruDetection'
const UNSUPPORTED_PLATFORM_MESSAGE =
  'Shuru requires macOS 14 or newer on Apple Silicon.'
const UNKNOWN_VERSION_MESSAGE =
  'Could not determine the macOS version. Shuru requires macOS 14 or newer on Apple Silicon.'
const MISSING_CLI_MESSAGE =
  'Shuru CLI not found on PATH. Install shuru to enable local microVM sandboxes.'

const getMacOsVersion = (): Effect.Effect<string | null> =>
  Effect.promise(async () => {
    try {
      const proc = spawn(['sw_vers', '-productVersion'], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const exitCode = await proc.exited
      if (exitCode !== 0) {
        return null
      }
      const stdout = await new Response(proc.stdout).text()
      const version = stdout.trim()
      return version.length > 0 ? version : null
    } catch {
      return null
    }
  })

const getMajorVersion = (version: string): number | null => {
  const [majorSegment] = version.split('.')
  if (majorSegment === undefined) {
    return null
  }

  const major = Number.parseInt(majorSegment, 10)
  return Number.isFinite(major) ? major : null
}

class ShuruDetection extends Context.Tag('@laborer/ShuruDetection')<
  ShuruDetection,
  {
    readonly check: () => Effect.Effect<ShuruStatus>
  }
>() {
  static readonly layer = Layer.effect(
    ShuruDetection,
    Effect.gen(function* () {
      const cachedStatus = yield* Ref.make<ShuruStatus | null>(null)

      const runDetection = Effect.gen(function* () {
        if (process.platform !== 'darwin' || process.arch !== 'arm64') {
          yield* Effect.logWarning(UNSUPPORTED_PLATFORM_MESSAGE).pipe(
            Effect.annotateLogs('module', logPrefix)
          )
          return {
            available: false,
            error: UNSUPPORTED_PLATFORM_MESSAGE,
          } satisfies ShuruStatus
        }

        const version = yield* getMacOsVersion()
        if (version === null) {
          yield* Effect.logWarning(UNKNOWN_VERSION_MESSAGE).pipe(
            Effect.annotateLogs('module', logPrefix)
          )
          return {
            available: false,
            error: UNKNOWN_VERSION_MESSAGE,
          } satisfies ShuruStatus
        }

        const majorVersion = getMajorVersion(version)
        if (majorVersion === null || majorVersion < 14) {
          const error = `${UNSUPPORTED_PLATFORM_MESSAGE} This machine is running macOS ${version}.`
          yield* Effect.logWarning(error).pipe(
            Effect.annotateLogs('module', logPrefix)
          )
          return {
            available: false,
            error,
          } satisfies ShuruStatus
        }

        const whichExitCode = yield* Effect.promise(async () => {
          try {
            const proc = spawn(['which', 'shuru'], {
              stdout: 'pipe',
              stderr: 'pipe',
            })
            return await proc.exited
          } catch {
            return 1
          }
        })

        if (whichExitCode !== 0) {
          yield* Effect.logWarning(MISSING_CLI_MESSAGE).pipe(
            Effect.annotateLogs('module', logPrefix)
          )
          return {
            available: false,
            error: MISSING_CLI_MESSAGE,
          } satisfies ShuruStatus
        }

        yield* Effect.logInfo('Shuru is available').pipe(
          Effect.annotateLogs('module', logPrefix)
        )
        return { available: true } satisfies ShuruStatus
      })

      const check = Effect.fn('ShuruDetection.check')(function* () {
        const cached = yield* Ref.get(cachedStatus)
        if (cached !== null) {
          return cached
        }

        const status = yield* runDetection
        yield* Ref.set(cachedStatus, status)
        return status
      })

      yield* check()

      return ShuruDetection.of({ check })
    })
  )
}

export { ShuruDetection }
export type { ShuruStatus }
