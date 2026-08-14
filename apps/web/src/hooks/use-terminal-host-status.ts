import { useAtomMount, useAtomValue } from '@effect/atom-react/Hooks'
import type { TerminalHostStatus } from '@laborer/shared/rpc'
import { Effect } from 'effect'
import { useCallback, useEffect, useState } from 'react'
import { TerminalServiceClient } from '@/atoms/terminal-service-client'

/** Health is advisory, so a modest poll keeps it off the terminal data path. */
export const TERMINAL_HOST_STATUS_POLL_MS = 2000

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
    const refresh = async () => {
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
      return
    }
    setStatus((current) => ({
      expectedVersion: current?.expectedVersion ?? 'unknown',
      ...(current?.runningVersion === undefined
        ? {}
        : { runningVersion: current.runningVersion }),
      state: 'restarting',
    }))
    const next = await Effect.runPromiseWith(runtimeResult.value)(
      Effect.gen(function* () {
        const client = yield* TerminalServiceClient
        return yield* client('terminal.restartHost', undefined as never)
      })
    )
    setStatus(next)
  }, [runtimeResult])

  return { restart, status }
}
