/**
 * useTerminalList — reactive terminal list from the terminal service.
 *
 * **Push-based architecture.** Instead of polling `terminal.list` every N
 * seconds, this module creates a `keepAlive` atom that:
 *
 * 1. Fetches the initial terminal list via `terminal.list` (hydration)
 * 2. Subscribes to `terminal.events` for real-time updates pushed by the
 *    server's 200 ms background detection fiber
 * 3. Applies each event to the in-memory terminal list and emits the
 *    updated list as the atom's value
 *
 * The atom stays alive for the lifetime of the app (via `Atom.keepAlive`)
 * so the event stream connection is never torn down and re-established
 * as components mount/unmount.
 *
 * When the daemon reconnects, the renderer connection generation rebuilds the
 * runtime: `terminal.list` is fetched again before a fresh event subscription.
 *
 * @see packages/terminal/src/services/terminal-manager.ts — detection fiber
 * @see packages/terminal/src/rpc/handlers.ts — terminal.events handler
 */

import { useAtomSet, useAtomValue } from '@effect/atom-react/Hooks'
import type {
  TerminalInfo as SharedTerminalInfo,
  TerminalLifecycleEventSchema,
} from '@laborer/shared/rpc'
import { Effect, Ref, Stream } from 'effect'
import { Atom, AsyncResult as Result } from 'effect/unstable/reactivity'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { TerminalServiceClient } from '@/atoms/terminal-service-client'

type TerminalInfo = SharedTerminalInfo

type TerminalServiceStatus = 'checking' | 'available' | 'unavailable'

// ---------------------------------------------------------------------------
// Shared store — module-level singleton
//
// External callers (e.g., spawn/restart handlers) use
// `upsertTerminalListItem` and `removeTerminalListItem` to apply
// optimistic updates before the server's ProcessChanged event arrives.
//
// **Pending removals set** — follows VS Code's `isDisposed` pattern:
// when a terminal is optimistically removed, its ID is added to
// `pendingRemovals`. The `terminal.events` stream filters out any
// events for pending-removal IDs, preventing a race where a
// `ProcessChanged` event (from the 200ms detection fiber) re-adds
// a terminal that was just closed. The server's `Removed` event
// clears the entry from the set.
//
// @see .reference/vscode/src/vs/workbench/contrib/terminal/browser/
//   terminalInstance.ts — `isDisposed` guard prevents stale operations
// ---------------------------------------------------------------------------

type TerminalListListener = (terminals: readonly TerminalInfo[]) => void

const terminalListListeners = new Set<TerminalListListener>()

let sharedTerminalList: readonly TerminalInfo[] = []
let hasSharedTerminalListSnapshot = false

/**
 * Terminal IDs that have been optimistically removed but not yet
 * confirmed by the server's `Removed` event. Events for these IDs
 * are suppressed by the stream processing to prevent re-addition.
 *
 * Analogous to VS Code's `isDisposed` flag on `TerminalInstance` —
 * once set, the terminal is considered dead and any incoming events
 * (e.g., `ProcessChanged` from the detection fiber) are ignored.
 */
const pendingRemovals = new Set<string>()

const publishTerminalList = (terminals: readonly TerminalInfo[]) => {
  sharedTerminalList = terminals
  hasSharedTerminalListSnapshot = true

  for (const listener of terminalListListeners) {
    listener(terminals)
  }
}

const subscribeToTerminalList = (listener: TerminalListListener) => {
  terminalListListeners.add(listener)

  return () => {
    terminalListListeners.delete(listener)
  }
}

const upsertTerminalListItem = (terminal: TerminalInfo) => {
  const nextTerminals = [...sharedTerminalList]
  const terminalIndex = nextTerminals.findIndex(({ id }) => id === terminal.id)

  if (terminalIndex === -1) {
    nextTerminals.push(terminal)
  } else {
    nextTerminals[terminalIndex] = terminal
  }

  publishTerminalList(nextTerminals)
}

const removeTerminalListItem = (terminalId: string) => {
  pendingRemovals.add(terminalId)
  publishTerminalList(sharedTerminalList.filter(({ id }) => id !== terminalId))
}

const resetTerminalListStore = () => {
  sharedTerminalList = []
  hasSharedTerminalListSnapshot = false
  pendingRemovals.clear()
}

// ---------------------------------------------------------------------------
// Event application
// ---------------------------------------------------------------------------

/**
 * Apply a single lifecycle event from the `terminal.events` stream to
 * an in-memory terminal list (stored in an Effect Ref).
 */
const applyEventToRef = (
  event: TerminalLifecycleEventSchema,
  ref: Ref.Ref<readonly TerminalInfo[]>
): Effect.Effect<readonly TerminalInfo[]> =>
  Ref.updateAndGet(ref, (list) => applyEventToList(event, list))

/**
 * Pure function: apply event to a terminal list, return new list.
 *
 * Respects `pendingRemovals` — events for terminals that have been
 * optimistically removed are suppressed to prevent the `terminal.events`
 * stream from re-adding a terminal that the user just closed. This
 * mirrors VS Code's `isDisposed` guard which prevents stale operations
 * on disposed terminal instances.
 *
 * The `Removed` event is the server confirmation — it clears the
 * pending-removal flag and filters the terminal from the list (idempotent
 * since the optimistic removal already removed it).
 */
const applyEventToList = (
  event: TerminalLifecycleEventSchema,
  list: readonly TerminalInfo[]
): readonly TerminalInfo[] => {
  switch (event._tag) {
    case 'ProcessChanged': {
      if (pendingRemovals.has((event.terminal as TerminalInfo).id)) {
        return list
      }
      return upsertInList(list, event.terminal as TerminalInfo)
    }
    case 'Spawned': {
      if (pendingRemovals.has(event.id)) {
        return list
      }
      return upsertInList(list, {
        agentStatus: null,
        args: [],
        command: event.command,
        cwd: '',
        foregroundProcess: null,
        hasChildProcess: false,
        id: event.id,
        processChain: [],
        status: event.status,
        workspaceId: event.workspaceId,
      })
    }
    case 'StatusChanged': {
      if (pendingRemovals.has(event.id)) {
        return list
      }
      const existing = list.find(({ id }) => id === event.id)
      if (existing !== undefined) {
        return upsertInList(list, { ...existing, status: event.status })
      }
      return list
    }
    case 'Removed': {
      // Server confirmation — keep the ID in pendingRemovals permanently
      // so that any stale ProcessChanged events arriving after the Removed
      // event are still suppressed. Terminal IDs are unique UUIDs so the
      // set won't grow unboundedly within a session. This fixes a race
      // where the detection fiber's ProcessChanged event is queued before
      // the Removed event but delivered after — clearing pendingRemovals
      // on Removed would allow that stale event to re-add the terminal.
      return list.filter(({ id }) => id !== event.id)
    }
    case 'Restarted': {
      if (pendingRemovals.has(event.id)) {
        return list
      }
      const existing = list.find(({ id }) => id === event.id)
      if (existing !== undefined) {
        return upsertInList(list, {
          ...existing,
          status: event.status,
          command: event.command,
          agentStatus: null,
          foregroundProcess: null,
          hasChildProcess: false,
          processChain: [],
        })
      }
      return list
    }
    case 'Exited': {
      // Exited is informational — StatusChanged handles the transition.
      return list
    }
    default: {
      return list
    }
  }
}

/** Upsert a terminal into a list (immutable). */
const upsertInList = (
  list: readonly TerminalInfo[],
  terminal: TerminalInfo
): readonly TerminalInfo[] => {
  const next = [...list]
  const idx = next.findIndex(({ id }) => id === terminal.id)
  if (idx === -1) {
    next.push(terminal)
  } else {
    next[idx] = terminal
  }
  return next
}

// ---------------------------------------------------------------------------
// Terminal list atom — keepAlive, push-based
// ---------------------------------------------------------------------------

/**
 * Atom that holds the current terminal list, updated in real time via the
 * `terminal.events` streaming RPC. Uses `Atom.keepAlive` so the stream
 * stays connected across component mount/unmount cycles.
 *
 * The atom's value is `Result<readonly TerminalInfo[], E>`:
 * - `Waiting` while the initial fetch is in progress
 * - `Success(terminals)` once hydrated and on each subsequent event
 * - `Failure(error)` if the current session's initial fetch fails
 */
const terminalListAtom = Atom.keepAlive(
  TerminalServiceClient.runtime.atom(
    Effect.gen(function* () {
      const client = yield* TerminalServiceClient

      // 1. Hydrate from terminal.list
      const initialList = yield* client('terminal.list', undefined)
      const listRef = yield* Ref.make<readonly TerminalInfo[]>(
        initialList as readonly TerminalInfo[]
      )

      // Publish to the shared store for external consumers.
      // Filter out any pending removals (should be empty at startup but
      // guards against re-initialization races).
      const filteredInitial =
        pendingRemovals.size > 0
          ? (initialList as readonly TerminalInfo[]).filter(
              ({ id }) => !pendingRemovals.has(id)
            )
          : (initialList as readonly TerminalInfo[])
      publishTerminalList(filteredInitial)

      // 2. Subscribe to terminal.events in a background fiber.
      //    On each event, update the ref and publish to the shared store.
      //    Filters out terminals with pending optimistic removals before
      //    publishing, preventing the stream from re-adding terminals
      //    that the user just closed (VS Code's `isDisposed` pattern).
      yield* client('terminal.events', undefined).pipe(
        Stream.tap((event) =>
          Effect.gen(function* () {
            const updated = yield* applyEventToRef(event, listRef)
            // Filter out any terminals that were optimistically removed.
            // The listRef may still contain them from before the removal;
            // the pending-removal set acts as a "disposed" guard.
            const filtered =
              pendingRemovals.size > 0
                ? updated.filter(({ id }) => !pendingRemovals.has(id))
                : updated
            publishTerminalList(filtered)
          })
        ),
        Stream.runDrain,
        Effect.catch((error) =>
          Effect.logWarning(`Terminal event stream ended: ${String(error)}`)
        ),
        Effect.forkScoped
      )

      return yield* Ref.get(listRef)
    })
  )
)

// ---------------------------------------------------------------------------
// Mutation for imperative refresh
// ---------------------------------------------------------------------------

const listTerminalsMutation = TerminalServiceClient.mutation('terminal.list')

// ---------------------------------------------------------------------------
// Service status tracking
// ---------------------------------------------------------------------------

type StatusListener = (status: {
  readonly serviceStatus: TerminalServiceStatus
  readonly errorMessage: string | null
}) => void

const statusListeners = new Set<StatusListener>()
let sharedServiceStatus: TerminalServiceStatus = 'checking'
let sharedErrorMessage: string | null = null

const publishStatus = (
  serviceStatus: TerminalServiceStatus,
  errorMessage: string | null
) => {
  sharedServiceStatus = serviceStatus
  sharedErrorMessage = errorMessage
  for (const listener of statusListeners) {
    listener({ serviceStatus, errorMessage })
  }
}

const subscribeToStatus = (listener: StatusListener) => {
  statusListeners.add(listener)
  return () => {
    statusListeners.delete(listener)
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Hook that provides a push-based reactive terminal list from the
 * terminal service.
 *
 * Reads from the `terminalListAtom` which maintains a persistent
 * connection to the `terminal.events` streaming RPC. No polling.
 *
 * @returns Object with `terminals` array, loading/status flags, and a
 *   manual `refresh` function.
 */
function useTerminalList(): {
  readonly errorMessage: string | null
  readonly isServiceAvailable: boolean
  readonly terminals: readonly TerminalInfo[]
  readonly isLoading: boolean
  /**
   * Force a fresh `terminal.list` RPC call.
   *
   * Returns the up-to-date terminal list directly so callers can make
   * decisions based on the freshest process state (e.g., checking
   * `hasChildProcess` right before showing a close confirmation dialog).
   *
   * Also publishes the result to the shared store, so all subscribers
   * (sidebar, other hooks) get the update immediately.
   */
  readonly refresh: () => Promise<readonly TerminalInfo[]>
  readonly serviceStatus: TerminalServiceStatus
} {
  const atomResult = useAtomValue(terminalListAtom)
  const listTerminals = useAtomSet(listTerminalsMutation, {
    mode: 'promise',
  })

  // Derive state from the atom result.
  const atomTerminals = useMemo((): readonly TerminalInfo[] => {
    if (Result.isSuccess(atomResult)) {
      return atomResult.value as readonly TerminalInfo[]
    }
    return []
  }, [atomResult])

  // Track terminals from the shared store for external updates
  // (optimistic upserts from spawn/restart).
  const initialSnapshot = hasSharedTerminalListSnapshot
    ? sharedTerminalList
    : atomTerminals
  const [terminals, setTerminals] =
    useState<readonly TerminalInfo[]>(initialSnapshot)

  // Derive initial service status from the atom result so it's
  // correct on the very first render (no effect needed).
  const deriveStatus = (): TerminalServiceStatus => {
    if (Result.isSuccess(atomResult)) {
      return 'available'
    }
    if (Result.isFailure(atomResult)) {
      return 'unavailable'
    }
    return sharedServiceStatus
  }
  const initialStatus = deriveStatus()
  const [serviceStatus, setServiceStatus] =
    useState<TerminalServiceStatus>(initialStatus)
  const [errorMessage, setErrorMessage] = useState<string | null>(
    sharedErrorMessage
  )

  // Sync atom result → service status.
  useEffect(() => {
    if (Result.isSuccess(atomResult)) {
      publishStatus('available', null)
    } else if (Result.isFailure(atomResult)) {
      publishStatus('unavailable', String(atomResult.cause))
    }
  }, [atomResult])

  // Sync shared store → local state.
  useEffect(() => {
    // If atom has data, publish it to shared store (initial sync).
    if (Result.isSuccess(atomResult) && !hasSharedTerminalListSnapshot) {
      publishTerminalList(atomResult.value as readonly TerminalInfo[])
    }

    const unsubTerminals = subscribeToTerminalList((nextTerminals) => {
      setTerminals(nextTerminals)
    })

    const unsubStatus = subscribeToStatus(
      ({ serviceStatus: s, errorMessage: e }) => {
        setServiceStatus(s)
        setErrorMessage(e)
      }
    )

    return () => {
      unsubTerminals()
      unsubStatus()
    }
  }, [atomResult])

  const isLoading = Result.isInitial(atomResult) || atomResult.waiting

  const refresh = useCallback(async (): Promise<readonly TerminalInfo[]> => {
    const result = await listTerminals({ payload: undefined })
    const freshTerminals = result as readonly TerminalInfo[]
    // Filter out terminals that have been optimistically removed but
    // not yet fully cleaned up on the server. Without this filter,
    // the full list from the server could re-add a terminal that was
    // closed by the user, causing the ghost bug.
    const filtered =
      pendingRemovals.size > 0
        ? freshTerminals.filter(({ id }) => !pendingRemovals.has(id))
        : freshTerminals
    publishTerminalList(filtered)
    publishStatus('available', null)
    return filtered
  }, [listTerminals])

  return {
    errorMessage,
    isServiceAvailable: serviceStatus === 'available',
    terminals,
    isLoading,
    refresh,
    serviceStatus,
  }
}

/**
 * Returns the number of running terminals with child processes.
 * Reads directly from the shared module-level store (no hook required).
 * Used by the before-quit handler to decide whether to show a confirmation dialog.
 */
const getRunningTerminalCount = (): number =>
  sharedTerminalList.filter((t) => t.status === 'running' && t.hasChildProcess)
    .length

export { useTerminalList }
export {
  applyEventToList,
  getRunningTerminalCount,
  removeTerminalListItem,
  resetTerminalListStore,
  upsertTerminalListItem,
}
export type { TerminalInfo, TerminalServiceStatus }
export type {
  AgentStatus,
  AgentStatusSnapshot,
  AgentStatusSource,
  ForegroundProcess,
  ProcessCategory,
} from '@laborer/shared/rpc'
