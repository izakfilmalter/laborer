/**
 * DaytonaClient — Effect service wrapping the `@daytonaio/sdk` `Daytona` class.
 *
 * Provides Effect-wrapped operations for managing Daytona cloud sandboxes.
 * The SDK's Promise-based methods are lifted into `Effect.tryPromise` with
 * proper error mapping to `RpcError`.
 *
 * Issue 11: Daytona SDK client Effect service (thin wrapper)
 */

import type {
  CreateSandboxFromImageParams,
  CreateSandboxFromSnapshotParams,
  Sandbox,
} from '@daytonaio/sdk'
import {
  Daytona,
  DaytonaNotFoundError,
  DaytonaRateLimitError,
  DaytonaTimeoutError,
} from '@daytonaio/sdk'
import { env } from '@laborer/env/server'
import { RpcError } from '@laborer/shared/rpc'
import { Context, Data, Effect, Layer } from 'effect'

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Typed error indicating that `DAYTONA_API_KEY` is not configured.
 *
 * Used by `DaytonaClient.layer` so that callers (e.g. `SandboxProviderRouter`)
 * can catch the error and gracefully degrade when Daytona credentials are not
 * available, instead of crashing the entire service stack.
 */
class DaytonaClientMissingKeyError extends Data.TaggedError(
  'DaytonaClientMissingKeyError'
)<{
  readonly message: string
}> {}

// ---------------------------------------------------------------------------
// SDK type aliases (used by consumers: DaytonaSandboxProvider, etc.)
// ---------------------------------------------------------------------------

/** Sandbox instance type from the Daytona SDK. */
type DaytonaSandbox = Sandbox

/** Paginated sandbox list result — inferred from the SDK's `list()` return. */
type DaytonaPaginatedSandboxes = Awaited<ReturnType<Daytona['list']>>

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/**
 * Map a Daytona SDK error (or any unknown error) to an `RpcError` with a
 * descriptive code.
 *
 * - `DaytonaNotFoundError`   -> code `DAYTONA_NOT_FOUND`
 * - `DaytonaRateLimitError`  -> code `DAYTONA_RATE_LIMIT`
 * - `DaytonaTimeoutError`    -> code `DAYTONA_TIMEOUT`
 * - Other Daytona errors     -> code `DAYTONA_ERROR`
 * - Non-Daytona errors       -> code `DAYTONA_UNKNOWN`
 */
const mapDaytonaError = (error: unknown): RpcError => {
  if (error instanceof DaytonaNotFoundError) {
    return new RpcError({
      message: error.message,
      code: 'DAYTONA_NOT_FOUND',
    })
  }
  if (error instanceof DaytonaRateLimitError) {
    return new RpcError({
      message: error.message,
      code: 'DAYTONA_RATE_LIMIT',
    })
  }
  if (error instanceof DaytonaTimeoutError) {
    return new RpcError({
      message: error.message,
      code: 'DAYTONA_TIMEOUT',
    })
  }
  // Generic error (base class check must come after subclass checks)
  if (error instanceof Error) {
    return new RpcError({
      message: error.message,
      code: 'DAYTONA_ERROR',
    })
  }
  return new RpcError({
    message: String(error),
    code: 'DAYTONA_UNKNOWN',
  })
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

/**
 * DaytonaClient Effect service.
 *
 * Thin wrapper around the `@daytonaio/sdk` `Daytona` class that exposes
 * SDK operations as `Effect` values with typed error channels.
 */
class DaytonaClient extends Context.Tag('@laborer/DaytonaClient')<
  DaytonaClient,
  {
    /** Create a new Daytona sandbox from an image. */
    readonly create: (
      params: CreateSandboxFromImageParams,
      options?: {
        onSnapshotCreateLogs?: (chunk: string) => void
        timeout?: number
      }
    ) => Effect.Effect<DaytonaSandbox, RpcError>

    /** Create a new Daytona sandbox from a snapshot. */
    readonly createFromSnapshot: (
      params: CreateSandboxFromSnapshotParams,
      options?: { timeout?: number }
    ) => Effect.Effect<DaytonaSandbox, RpcError>

    /** Get a sandbox by ID or name. */
    readonly get: (
      sandboxIdOrName: string
    ) => Effect.Effect<DaytonaSandbox, RpcError>

    /** List sandboxes, optionally filtered by labels. */
    readonly list: (
      labels?: Record<string, string>,
      page?: number,
      limit?: number
    ) => Effect.Effect<DaytonaPaginatedSandboxes, RpcError>

    /** Start a stopped sandbox. */
    readonly start: (
      sandbox: DaytonaSandbox,
      timeout?: number
    ) => Effect.Effect<void, RpcError>

    /** Stop a running sandbox. */
    readonly stop: (sandbox: DaytonaSandbox) => Effect.Effect<void, RpcError>

    /** Delete a sandbox permanently. */
    readonly delete: (
      sandbox: DaytonaSandbox,
      timeout?: number
    ) => Effect.Effect<void, RpcError>

    /**
     * Set the auto-stop interval for a sandbox.
     * @param sandbox - The sandbox to update
     * @param interval - Minutes of inactivity before auto-stop (0 disables)
     */
    readonly setAutostopInterval: (
      sandbox: DaytonaSandbox,
      interval: number
    ) => Effect.Effect<void, RpcError>

    /**
     * Access to the underlying Daytona snapshot service.
     * Exposed directly since snapshot operations are varied and
     * wrapping every sub-method adds little value.
     */
    readonly snapshot: Daytona['snapshot']

    /** The raw Daytona SDK instance, for cases needing direct access. */
    readonly raw: Daytona
  }
>() {
  /**
   * Build the `DaytonaClient` layer.
   *
   * Reads `DAYTONA_API_KEY`, `DAYTONA_API_URL`, and `DAYTONA_TARGET` from
   * the env service. Fails the layer if `DAYTONA_API_KEY` is not set
   * (the env schema makes it optional, but this service requires it).
   *
   * Uses `Effect.fail` (not `Effect.die`) so that callers like
   * `SandboxProviderRouter` can catch the error and gracefully degrade
   * when Daytona credentials are not configured.
   */
  static readonly layer: Layer.Layer<
    DaytonaClient,
    DaytonaClientMissingKeyError
  > = Layer.effect(
    DaytonaClient,
    Effect.gen(function* () {
      const apiKey = env.DAYTONA_API_KEY
      if (apiKey === undefined) {
        return yield* new DaytonaClientMissingKeyError({
          message:
            'DAYTONA_API_KEY is not set. The DaytonaClient service requires a valid API key.',
        })
      }

      const daytona = new Daytona({
        apiKey,
        apiUrl: env.DAYTONA_API_URL,
        target: env.DAYTONA_TARGET,
      })

      yield* Effect.logInfo('DaytonaClient initialized').pipe(
        Effect.annotateLogs('module', 'DaytonaClient'),
        Effect.annotateLogs('apiUrl', env.DAYTONA_API_URL),
        Effect.annotateLogs('target', env.DAYTONA_TARGET)
      )

      // ── create (from image) ─────────────────────────────────

      const create = Effect.fn('DaytonaClient.create')(function* (
        params: CreateSandboxFromImageParams,
        options?: {
          onSnapshotCreateLogs?: (chunk: string) => void
          timeout?: number
        }
      ) {
        return yield* Effect.tryPromise({
          try: () => daytona.create(params, options),
          catch: mapDaytonaError,
        })
      })

      // ── createFromSnapshot ──────────────────────────────────

      const createFromSnapshot = Effect.fn('DaytonaClient.createFromSnapshot')(
        function* (
          params: CreateSandboxFromSnapshotParams,
          options?: { timeout?: number }
        ) {
          return yield* Effect.tryPromise({
            try: () => daytona.create(params, options),
            catch: mapDaytonaError,
          })
        }
      )

      // ── get ─────────────────────────────────────────────────

      const get = Effect.fn('DaytonaClient.get')(function* (
        sandboxIdOrName: string
      ) {
        return yield* Effect.tryPromise({
          try: () => daytona.get(sandboxIdOrName),
          catch: mapDaytonaError,
        })
      })

      // ── list ────────────────────────────────────────────────

      const list = Effect.fn('DaytonaClient.list')(function* (
        labels?: Record<string, string>,
        page?: number,
        limit?: number
      ) {
        return yield* Effect.tryPromise({
          try: () => daytona.list(labels, page, limit),
          catch: mapDaytonaError,
        })
      })

      // ── start ───────────────────────────────────────────────

      const start = Effect.fn('DaytonaClient.start')(function* (
        sandbox: DaytonaSandbox,
        timeout?: number
      ) {
        yield* Effect.tryPromise({
          try: () => daytona.start(sandbox, timeout),
          catch: mapDaytonaError,
        })
      })

      // ── stop ────────────────────────────────────────────────

      const stop = Effect.fn('DaytonaClient.stop')(function* (
        sandbox: DaytonaSandbox
      ) {
        yield* Effect.tryPromise({
          try: () => daytona.stop(sandbox),
          catch: mapDaytonaError,
        })
      })

      // ── delete ──────────────────────────────────────────────

      const del = Effect.fn('DaytonaClient.delete')(function* (
        sandbox: DaytonaSandbox,
        timeout?: number
      ) {
        yield* Effect.tryPromise({
          try: () => daytona.delete(sandbox, timeout),
          catch: mapDaytonaError,
        })
      })

      // ── setAutostopInterval ───────────────────────────────────

      const setAutostopInterval = Effect.fn(
        'DaytonaClient.setAutostopInterval'
      )(function* (sandbox: DaytonaSandbox, interval: number) {
        yield* Effect.tryPromise({
          try: () => sandbox.setAutostopInterval(interval),
          catch: mapDaytonaError,
        })
      })

      // ── Return the service ──────────────────────────────────

      return DaytonaClient.of({
        create,
        createFromSnapshot,
        get,
        list,
        start,
        stop,
        delete: del,
        setAutostopInterval,
        snapshot: daytona.snapshot,
        raw: daytona,
      })
    })
  )
}

export { DaytonaClient, DaytonaClientMissingKeyError }
export type { DaytonaSandbox, DaytonaPaginatedSandboxes }
export type {
  CreateSandboxFromImageParams,
  CreateSandboxFromSnapshotParams,
} from '@daytonaio/sdk'
