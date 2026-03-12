/**
 * useTerminalList — reactive terminal list from the terminal service.
 *
 * Polls the terminal service's `terminal.list` RPC endpoint at a
 * configurable interval (default 5 seconds) to provide a reactive list
 * of all terminals. Replaces the LiveStore `queryDb(terminals)` pattern
 * for terminal state queries.
 *
 * The poll interval is aligned with the server-side process detection
 * cache refresh (5 seconds) since the server caches foreground process
 * info asynchronously. Polling faster would return stale cache data
 * without benefit.
 *
 * Uses the TerminalServiceClient (AtomRpc) for type-safe RPC calls
 * instead of raw fetch, ensuring the correct Effect RPC JSON wire
 * protocol is used.
 *
 * @see Issue #144: Web app LiveStore terminal query replacement
 * @see packages/terminal/src/rpc/handlers.ts — terminal.list handler
 */

import { useAtomSet } from '@effect-atom/atom-react/Hooks'
import { useCallback, useEffect, useRef, useState } from 'react'

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
  readonly status: 'running' | 'stopped'
  readonly workspaceId: string
}

type TerminalServiceStatus = 'checking' | 'available' | 'unavailable'

type TerminalListListener = (terminals: readonly TerminalInfo[]) => void

const terminalListListeners = new Set<TerminalListListener>()

let sharedTerminalList: readonly TerminalInfo[] = []
let hasSharedTerminalListSnapshot = false

const getSharedTerminalListSnapshot = (): readonly TerminalInfo[] | null => {
  return hasSharedTerminalListSnapshot ? sharedTerminalList : null
}

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

/**
 * Default polling interval in milliseconds.
 *
 * Set to 5 seconds to align with the server-side process detection cache
 * refresh interval. The server detects foreground processes (for sidebar
 * display) via a background timer using a single async `ps` call. Polling
 * faster than the cache refresh provides no benefit — results would be
 * identical — and reduces unnecessary network + RPC overhead.
 *
 * Prior value was 2000ms, which with the old synchronous `execSync`-based
 * process detection caused O(N×12) event loop blocking per poll cycle.
 */
const DEFAULT_POLL_INTERVAL_MS = 5000

const listTerminalsMutation = TerminalServiceClient.mutation('terminal.list')

/**
 * Hook that provides a polled terminal list from the terminal service.
 *
 * Calls `terminal.list` on mount and at each poll interval to keep
 * the terminal list in sync with the terminal service state.
 *
 * The server-side `listTerminals()` is now non-blocking — it reads from
 * a pre-computed process detection cache instead of spawning synchronous
 * shell commands. This makes polling safe at any interval.
 *
 * @param pollIntervalMs - Polling interval in ms (default 5000).
 * @returns Object with `terminals` array and `isLoading` flag.
 */
function useTerminalList(pollIntervalMs = DEFAULT_POLL_INTERVAL_MS): {
  readonly errorMessage: string | null
  readonly isServiceAvailable: boolean
  readonly terminals: readonly TerminalInfo[]
  readonly isLoading: boolean
  readonly serviceStatus: TerminalServiceStatus
} {
  const listTerminals = useAtomSet(listTerminalsMutation, {
    mode: 'promise',
  })
  const initialSnapshot = getSharedTerminalListSnapshot()
  const [terminals, setTerminals] = useState<readonly TerminalInfo[]>(
    initialSnapshot ?? []
  )
  const [isLoading, setIsLoading] = useState(initialSnapshot === null)
  const [serviceStatus, setServiceStatus] = useState<TerminalServiceStatus>(
    initialSnapshot === null ? 'checking' : 'available'
  )
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const mountedRef = useRef(true)

  const fetchAndUpdate = useCallback(async () => {
    try {
      const result = await listTerminals({ payload: undefined })
      if (mountedRef.current) {
        publishTerminalList(result as readonly TerminalInfo[])
        setIsLoading(false)
        setServiceStatus('available')
        setErrorMessage(null)
      }
    } catch (error) {
      // Keep the last known terminal list, but surface service availability
      // so the UI can show a clear "Terminal service unavailable" warning.
      if (mountedRef.current) {
        setIsLoading(false)
        setServiceStatus('unavailable')
        const message =
          error instanceof Error
            ? error.message
            : 'Unknown terminal service error'
        setErrorMessage(message)
      }
    }
  }, [listTerminals])

  useEffect(() => {
    mountedRef.current = true
    const unsubscribe = subscribeToTerminalList((nextTerminals) => {
      if (!mountedRef.current) {
        return
      }

      setTerminals(nextTerminals)
      setIsLoading(false)
      setServiceStatus('available')
      setErrorMessage(null)
    })

    fetchAndUpdate()

    if (pollIntervalMs > 0) {
      const timer = setInterval(fetchAndUpdate, pollIntervalMs)
      return () => {
        mountedRef.current = false
        unsubscribe()
        clearInterval(timer)
      }
    }

    return () => {
      mountedRef.current = false
      unsubscribe()
    }
  }, [fetchAndUpdate, pollIntervalMs])

  return {
    errorMessage,
    isServiceAvailable: serviceStatus === 'available',
    terminals,
    isLoading,
    serviceStatus,
  }
}

export { useTerminalList }
export {
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
