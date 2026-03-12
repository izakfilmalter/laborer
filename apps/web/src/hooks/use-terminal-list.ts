/**
 * useTerminalList — reactive terminal list from the terminal service.
 *
 * Polls the terminal service's `terminal.list` RPC endpoint at a
 * configurable interval (default 2 seconds) to provide a reactive list
 * of all terminals. Replaces the LiveStore `queryDb(terminals)` pattern
 * for terminal state queries.
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

/** Shape of a terminal from the terminal service's terminal.list RPC. */
interface TerminalInfo {
  readonly args: readonly string[]
  readonly command: string
  readonly cwd: string
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

/** Default polling interval in milliseconds. */
const DEFAULT_POLL_INTERVAL_MS = 2000

const listTerminalsMutation = TerminalServiceClient.mutation('terminal.list')

/**
 * Hook that provides a polled terminal list from the terminal service.
 *
 * Calls `terminal.list` on mount and at each poll interval to keep
 * the terminal list in sync with the terminal service state.
 *
 * @param pollIntervalMs - Polling interval in ms (default 2000).
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
  const [terminals, setTerminals] = useState<readonly TerminalInfo[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [serviceStatus, setServiceStatus] =
    useState<TerminalServiceStatus>('checking')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const mountedRef = useRef(true)

  const fetchAndUpdate = useCallback(async () => {
    try {
      const result = await listTerminals({ payload: undefined })
      if (mountedRef.current) {
        setTerminals(result as readonly TerminalInfo[])
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
    fetchAndUpdate()

    if (pollIntervalMs > 0) {
      const timer = setInterval(fetchAndUpdate, pollIntervalMs)
      return () => {
        mountedRef.current = false
        clearInterval(timer)
      }
    }

    return () => {
      mountedRef.current = false
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
export type { TerminalInfo, TerminalServiceStatus }
