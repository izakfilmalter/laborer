/**
 * Terminal spawn utilities for layout reconciliation.
 *
 * When the app starts, the persisted layout may reference terminal IDs
 * that no longer exist (stale terminals). The reconciliation process
 * respawns these terminals and updates the layout with new IDs.
 *
 * These functions handle the case where the server is still initializing
 * when the reconciliation runs — retrying with exponential backoff and
 * preserving stale terminal IDs in the layout when all retries fail,
 * preventing a cascading spawn-remove loop.
 *
 * @see apps/web/src/routes/-hooks/use-panel-layout.ts
 */

/** Result returned by a successful terminal spawn. */
interface SpawnResult {
  readonly command: string
  readonly id: string
  readonly status: string
}

/** Options for controlling retry behaviour. */
interface SpawnRetryOptions {
  /** Timeout in ms for a single spawn attempt. */
  readonly attemptTimeoutMs?: number
  /** Base delay in ms for exponential backoff (default: 500). */
  readonly baseDelayMs?: number
  /** Maximum number of retry attempts (default: 5). */
  readonly maxRetries?: number
}

class SpawnTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Terminal spawn timed out after ${timeoutMs}ms`)
    this.name = 'SpawnTimeoutError'
  }
}

const runWithAttemptTimeout = <T>(
  fn: () => Promise<T>,
  timeoutMs: number | undefined
): Promise<T> => {
  if (timeoutMs === undefined) {
    return fn()
  }

  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new SpawnTimeoutError(timeoutMs))
    }, timeoutMs)

    fn()
      .then((value) => {
        clearTimeout(timeoutId)
        resolve(value)
      })
      .catch((error: unknown) => {
        clearTimeout(timeoutId)
        reject(error)
      })
  })
}

/**
 * Retry an async operation with exponential backoff when the error
 * indicates the server is still initializing.
 *
 * This is a general-purpose retry wrapper used by both the reconciliation
 * spawn path and the auto-spawn paths in `handleSplitPane` and
 * `handleAddPanelTab`.
 *
 * Returns the result on success, or `undefined` after all retries
 * are exhausted or a non-retriable error occurs.
 */
async function retryOnInitializing<T>(
  fn: () => Promise<T>,
  options?: SpawnRetryOptions
): Promise<T | undefined> {
  const maxRetries = options?.maxRetries ?? 5
  const baseDelayMs = options?.baseDelayMs ?? 500
  const attemptTimeoutMs = options?.attemptTimeoutMs

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await runWithAttemptTimeout(fn, attemptTimeoutMs)
    } catch (error) {
      if (error instanceof SpawnTimeoutError) {
        console.warn(`[reconcile-spawn] ${error.message}`)
      }

      const isInitializing =
        error instanceof Error && error.message.includes('still initializing')
      if (isInitializing && attempt < maxRetries) {
        const delay = baseDelayMs * 2 ** attempt
        await new Promise((resolve) => setTimeout(resolve, delay))
        continue
      }
      return undefined
    }
  }
  return undefined
}

/**
 * Spawn a terminal for a workspace, retrying with exponential backoff
 * when the error indicates the server is still initializing.
 *
 * Convenience wrapper around {@link retryOnInitializing} for the
 * reconciliation spawn path.
 */
function spawnWithRetry(
  workspaceId: string,
  spawnFn: (payload: { workspaceId: string }) => Promise<SpawnResult>,
  options?: SpawnRetryOptions
): Promise<SpawnResult | undefined> {
  return retryOnInitializing(() => spawnFn({ workspaceId }), options)
}

/** A stale leaf that needs its terminal respawned. */
interface StaleLeaf {
  readonly terminalId?: string | undefined
  readonly workspaceId?: string | undefined
}

/** Arguments for {@link respawnStaleTerminals}. */
interface RespawnStaleTerminalsArgs {
  /** Callback to commit the reconciled layouts to the store. */
  readonly commitReconciledLayouts: (
    effectiveLiveIds: ReadonlySet<string>,
    respawnedIds: Map<string, string>
  ) => void
  /** Set of terminal IDs that are currently live on the server. */
  readonly liveIds: ReadonlySet<string>
  /** Callback invoked for each successfully respawned terminal. */
  readonly onTerminalSpawned?: (
    result: SpawnResult,
    workspaceId: string
  ) => void
  /** The spawn function (typically the terminal.spawn RPC mutation). */
  readonly spawnFn: (payload: { workspaceId: string }) => Promise<SpawnResult>
  /** Options for controlling retry behaviour. */
  readonly spawnRetryOptions?: SpawnRetryOptions
  /** Stale leaves collected from the persisted layout. */
  readonly staleLeaves: readonly StaleLeaf[]
}

/**
 * Respawn stale terminals during layout reconciliation.
 *
 * For each stale leaf, attempts to spawn a replacement terminal using
 * {@link spawnWithRetry}. On success, the old terminal ID is mapped to
 * the new one. On failure, the stale terminal ID is added to the
 * effective "live" set so that the reconciliation pass does not strip
 * it from the layout — preventing a cascading spawn-remove loop.
 */
async function respawnStaleTerminals(
  args: RespawnStaleTerminalsArgs
): Promise<void> {
  const {
    commitReconciledLayouts,
    liveIds,
    onTerminalSpawned,
    spawnFn,
    spawnRetryOptions,
    staleLeaves,
  } = args

  const respawnedIds = new Map<string, string>()
  const failedStaleIds = new Set<string>()

  for (const leaf of staleLeaves) {
    const wsId = leaf.workspaceId
    const termId = leaf.terminalId
    if (!(wsId && termId)) {
      continue
    }

    const result = await spawnWithRetry(wsId, spawnFn, spawnRetryOptions)
    if (result) {
      respawnedIds.set(termId, result.id)
      onTerminalSpawned?.(result, wsId)
    } else {
      failedStaleIds.add(termId)
    }
  }

  const effectiveLiveIds =
    failedStaleIds.size > 0 ? new Set([...liveIds, ...failedStaleIds]) : liveIds

  commitReconciledLayouts(effectiveLiveIds, respawnedIds)
}

// ---------------------------------------------------------------------------
// Spawn guard — prevents concurrent terminal spawns for the same pane
// and supports cancellation when a pane is closed mid-spawn.
// ---------------------------------------------------------------------------

/**
 * Guard that prevents concurrent terminal spawns for the same pane and
 * tracks cancellation state for panes closed while a spawn is in-flight.
 *
 * Combines two VS Code patterns:
 * - `_isTerminalBeingCreated`: a spawn is tracked by key (pane ID) and
 *   subsequent spawn requests for the same key are silently dropped.
 * - `_isDisposed` check in `TerminalProcessManager.createProcess()`: after
 *   the async spawn completes, the caller checks whether the pane was
 *   closed (cancelled) during the await and, if so, kills the terminal.
 *
 * @see VS Code `terminalProcessManager.ts` — `_isDisposed` guard after
 *   async process spawn
 */
interface SpawnGuard {
  /**
   * Mark a pane as cancelled. If a spawn is in-flight for this key,
   * {@link isCancelled} will return `true` so the `.then()` handler
   * can kill the orphaned terminal instead of assigning it.
   *
   * Follows VS Code's `TerminalProcessManager.dispose()` pattern:
   * set `_isDisposed = true` so the async `createProcess` path can
   * detect that the instance was torn down during the await.
   */
  readonly cancel: (key: string) => void
  /**
   * Check whether a spawn was cancelled for the given key.
   * The caller should kill the spawned terminal instead of assigning it.
   */
  readonly isCancelled: (key: string) => boolean
  /** Check whether a spawn is currently in-flight for the given key. */
  readonly isSpawning: (key: string) => boolean
  /**
   * Execute `fn` if no spawn is in-flight for `key`.
   * Returns `undefined` immediately if a spawn is already in-flight.
   * Otherwise executes `fn`, tracks its promise, and clears the guard
   * when the promise settles (success or failure).
   */
  readonly run: <T>(key: string, fn: () => Promise<T>) => Promise<T | undefined>
}

function createSpawnGuard(): SpawnGuard {
  const inFlight = new Set<string>()
  const cancelled = new Set<string>()

  return {
    cancel: (key: string) => {
      cancelled.add(key)
    },
    isCancelled: (key: string) => cancelled.has(key),
    isSpawning: (key: string) => inFlight.has(key),
    run: async <T>(
      key: string,
      fn: () => Promise<T>
    ): Promise<T | undefined> => {
      if (inFlight.has(key)) {
        return undefined
      }
      // Clear any stale cancellation from a previous spawn cycle.
      cancelled.delete(key)
      inFlight.add(key)
      try {
        return await fn()
      } catch {
        return undefined
      } finally {
        inFlight.delete(key)
        // NOTE: We intentionally do NOT clear `cancelled` here.
        // The `.then()` handler that checks `isCancelled()` runs
        // as a microtask after this promise resolves. If we cleared
        // the flag here (even via queueMicrotask), it would race
        // with the `.then()` and the cancellation would be missed.
        // The `cancelled` set only holds UUIDs for panes closed
        // mid-spawn — a negligible number per session.
      }
    },
  }
}

export {
  createSpawnGuard,
  respawnStaleTerminals,
  retryOnInitializing,
  spawnWithRetry,
}
export type { SpawnGuard, SpawnResult, SpawnRetryOptions, StaleLeaf }
