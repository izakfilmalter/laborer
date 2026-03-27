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
  /** Base delay in ms for exponential backoff (default: 500). */
  readonly baseDelayMs?: number
  /** Maximum number of retry attempts (default: 5). */
  readonly maxRetries?: number
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

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
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
// Spawn guard — prevents concurrent terminal spawns for the same pane.
// ---------------------------------------------------------------------------

/**
 * Guard that prevents concurrent terminal spawns for the same pane.
 *
 * Follows VS Code's `_isTerminalBeingCreated` pattern: a spawn is tracked
 * by key (typically pane ID) and subsequent spawn requests for the same
 * key are silently dropped while a spawn is in-flight. The guard is
 * cleared in a `.finally()` handler so it always unblocks, even if the
 * spawn fails.
 *
 * @see VS Code `terminalView.ts` — `_isTerminalBeingCreated` boolean flag
 */
interface SpawnGuard {
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

  return {
    isSpawning: (key: string) => inFlight.has(key),
    run: async <T>(
      key: string,
      fn: () => Promise<T>
    ): Promise<T | undefined> => {
      if (inFlight.has(key)) {
        return undefined
      }
      inFlight.add(key)
      try {
        return await fn()
      } catch {
        return undefined
      } finally {
        inFlight.delete(key)
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
