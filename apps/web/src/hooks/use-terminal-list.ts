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
 * When the stream disconnects, Effect's `Stream.retry` re-establishes
 * the connection with exponential backoff (1 s → 2 s → … → 30 s cap).
 *
 * @see packages/terminal/src/services/terminal-manager.ts — detection fiber
 * @see packages/terminal/src/rpc/handlers.ts — terminal.events handler
 */

import { Atom, Result } from '@effect-atom/atom'
import { useAtomSet, useAtomValue } from '@effect-atom/atom-react/Hooks'
import type { TerminalLifecycleEventSchema } from '@laborer/shared/rpc'
import { Effect, Ref, Schedule, Stream } from 'effect'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { TerminalServiceClient } from '@/atoms/terminal-service-client'

/** Category of a detected foreground process. */
type ProcessCategory = 'agent' | 'editor' | 'devServer' | 'shell' | 'unknown'

/** Information about the foreground process running in a terminal. */
interface ForegroundProcess {
  readonly category: ProcessCategory
  readonly label: string
  readonly rawName: string
}

/**
 * Agent status for a terminal, derived from foreground process transitions.
 *
 * - `active` — an AI agent is currently the foreground process
 * - `waiting_for_input` — an agent was running but is now idle
 *   (needs user input or has completed its task)
 */
type AgentStatus = 'active' | 'waiting_for_input'

/** Shape of a terminal from the terminal service's terminal.list RPC. */
interface TerminalInfo {
  /**
   * Agent status derived from foreground process transitions.
   * Null when no agent has been detected in this terminal.
   */
  readonly agentStatus: AgentStatus | null
  readonly args: readonly string[]
  readonly command: string
  readonly cwd: string
  /**
   * Information about the foreground process running in the terminal.
   * Null when the shell is idle at a prompt or the terminal is stopped.
   */
  readonly foregroundProcess: ForegroundProcess | null
  /**
   * Whether the shell has child processes running (e.g., vim, dev server,
   * opencode). False when the shell is idle at a prompt.
   */
  readonly hasChildProcess: boolean
  readonly id: string
  /**
   * Classified processes along the tree from the shell's first child
   * down to the deepest leaf. Used by the UI to show the full chain,
   * e.g. "OpenCode › biome". Empty when the shell is idle or stopped.
   */
  readonly processChain: readonly ForegroundProcess[]
  readonly status: 'running' | 'stopped'
  readonly workspaceId: string
}

type TerminalServiceStatus = 'checking' | 'available' | 'unavailable'

// ---------------------------------------------------------------------------
// Shared store — module-level singleton
//
// External callers (e.g., spawn/restart handlers) use
// `upsertTerminalListItem` and `removeTerminalListItem` to apply
// optimistic updates before the server's ProcessChanged event arrives.
// ---------------------------------------------------------------------------

type TerminalListListener = (terminals: readonly TerminalInfo[]) => void

const terminalListListeners = new Set<TerminalListListener>()

let sharedTerminalList: readonly TerminalInfo[] = []
let hasSharedTerminalListSnapshot = false

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
  publishTerminalList(sharedTerminalList.filter(({ id }) => id !== terminalId))
}

const resetTerminalListStore = () => {
  sharedTerminalList = []
  hasSharedTerminalListSnapshot = false
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

/** Pure function: apply event to a terminal list, return new list. */
const applyEventToList = (
  event: TerminalLifecycleEventSchema,
  list: readonly TerminalInfo[]
): readonly TerminalInfo[] => {
  switch (event._tag) {
    case 'ProcessChanged': {
      return upsertInList(list, event.terminal as TerminalInfo)
    }
    case 'Spawned': {
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
      const existing = list.find(({ id }) => id === event.id)
      if (existing !== undefined) {
        return upsertInList(list, { ...existing, status: event.status })
      }
      return list
    }
    case 'Removed': {
      return list.filter(({ id }) => id !== event.id)
    }
    case 'Restarted': {
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
 * Retry schedule for the event stream: exponential backoff 1s → 30s cap.
 */
const eventStreamRetrySchedule = Schedule.exponential('1 second').pipe(
  Schedule.union(Schedule.spaced('30 seconds'))
)

/**
 * Atom that holds the current terminal list, updated in real time via the
 * `terminal.events` streaming RPC. Uses `Atom.keepAlive` so the stream
 * stays connected across component mount/unmount cycles.
 *
 * The atom's value is `Result<readonly TerminalInfo[], E>`:
 * - `Waiting` while the initial fetch is in progress
 * - `Success(terminals)` once hydrated and on each subsequent event
 * - `Failure(error)` if the initial fetch and all retries fail
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
      publishTerminalList(initialList as readonly TerminalInfo[])

      // 2. Subscribe to terminal.events in a background fiber.
      //    On each event, update the ref and publish to the shared store.
      yield* client('terminal.events', undefined).pipe(
        Stream.tap((event) =>
          Effect.gen(function* () {
            const updated = yield* applyEventToRef(event, listRef)
            publishTerminalList(updated)
          })
        ),
        Stream.runDrain,
        Effect.retry(eventStreamRetrySchedule),
        Effect.catchAll((error) =>
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
    publishTerminalList(freshTerminals)
    publishStatus('available', null)
    return freshTerminals
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

export { useTerminalList }
export {
  applyEventToList,
  removeTerminalListItem,
  resetTerminalListStore,
  upsertTerminalListItem,
}
export type {
  AgentStatus,
  ForegroundProcess,
  ProcessCategory,
  TerminalInfo,
  TerminalServiceStatus,
}
