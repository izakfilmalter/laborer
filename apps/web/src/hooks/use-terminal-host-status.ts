import { useAtomMount, useAtomValue } from '@effect/atom-react/Hooks'
import type { TerminalHostStatus } from '@laborer/shared/rpc'
import { Effect } from 'effect'
import { useCallback, useEffect, useState } from 'react'
import { TerminalServiceClient } from '@/atoms/terminal-service-client'

/** Health is advisory, so a modest poll keeps it off the terminal data path. */
export const TERMINAL_HOST_STATUS_POLL_MS = 2000

/**
 * A failed restart must not leave the optimistic progress state stuck. Keep a
 * newer status observed by polling, otherwise return to the last actionable
 * state so the operator can retry.
 */
export function statusAfterRestartFailure(
  current: TerminalHostStatus | undefined,
  previous: TerminalHostStatus | undefined
): TerminalHostStatus | undefined {
  return current?.state === 'restarting' ? previous : current
}

export function useTerminalHostStatus() {
  useAtomMount(TerminalServiceClient.runtime)
  const runtimeResult = useAtomValue(TerminalServiceClient.runtime)
  const [status, setStatus] = useState<TerminalHostStatus | undefined>()

  useEffect(() => {
    if (runtimeResult._tag !== 'Success') {
      return
    }
    const runtime = runtimeResult.value
    let active = true
    let refreshInFlight = false
    const refresh = async () => {
      if (refreshInFlight) {
        return
      }
      refreshInFlight = true
      try {
        const next = await Effect.runPromiseWith(runtime)(
          Effect.gen(function* () {
            const client = yield* TerminalServiceClient
            return yield* client('terminal.hostStatus', undefined as never)
          })
        )
        if (active) {
          setStatus(next)
        }
      } catch {
        // Connection health owns daemon-level failures. Preserve the last
        // known host state rather than replacing it with transport noise.
      } finally {
        refreshInFlight = false
      }
    }
    refresh().catch(() => undefined)
    const interval = setInterval(refresh, TERMINAL_HOST_STATUS_POLL_MS)
    return () => {
      active = false
      clearInterval(interval)
    }
  }, [runtimeResult])

  const restart = useCallback(async () => {
    if (runtimeResult._tag !== 'Success') {
      throw new Error('Terminal service is unavailable')
    }
    const previousStatus = status
    setStatus({
      expectedVersion: previousStatus?.expectedVersion ?? 'unknown',
      ...(previousStatus?.runningVersion === undefined
        ? {}
        : { runningVersion: previousStatus.runningVersion }),
      state: 'restarting',
    })
    try {
      const next = await Effect.runPromiseWith(runtimeResult.value)(
        Effect.gen(function* () {
          const client = yield* TerminalServiceClient
          return yield* client('terminal.restartHost', undefined as never)
        })
      )
      setStatus(next)
    } catch (error) {
      setStatus((current) => statusAfterRestartFailure(current, previousStatus))
      throw error
    }
  }, [runtimeResult, status])

  return { restart, status }
}
