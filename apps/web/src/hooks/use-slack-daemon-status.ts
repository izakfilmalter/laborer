import { useAtomMount, useAtomValue } from '@effect/atom-react/Hooks'
import type { SlackDaemonStatus } from '@laborer/shared/rpc'
import { Effect } from 'effect'
import { useCallback, useEffect, useState } from 'react'
import { BrowserDaemonClient } from '@/atoms/browser-daemon-client'

export const SLACK_DAEMON_STATUS_POLL_MS = 2000

export function useSlackDaemonStatus() {
  useAtomMount(BrowserDaemonClient.runtime)
  const runtimeResult = useAtomValue(BrowserDaemonClient.runtime)
  const [status, setStatus] = useState<SlackDaemonStatus>()
  const [starting, setStarting] = useState(false)
  const [stopping, setStopping] = useState(false)

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
            const client = yield* BrowserDaemonClient
            return yield* client('slackDaemon.status', undefined as never)
          })
        )
        if (active) {
          setStatus(next)
        }
      } catch {
        if (active) {
          setStatus({ status: 'error' })
        }
      } finally {
        refreshInFlight = false
      }
    }

    refresh().catch(() => undefined)
    const interval = setInterval(refresh, SLACK_DAEMON_STATUS_POLL_MS)
    return () => {
      active = false
      clearInterval(interval)
    }
  }, [runtimeResult])

  const start = useCallback(async () => {
    if (runtimeResult._tag !== 'Success' || starting || stopping) {
      throw new Error('Slack daemon control is unavailable')
    }
    setStarting(true)
    try {
      const next = await Effect.runPromiseWith(runtimeResult.value)(
        Effect.gen(function* () {
          const client = yield* BrowserDaemonClient
          return yield* client('slackDaemon.start', undefined as never)
        })
      )
      setStatus(next)
    } catch (error) {
      setStatus({ status: 'error' })
      throw error
    } finally {
      setStarting(false)
    }
  }, [runtimeResult, starting, stopping])

  const stop = useCallback(async () => {
    if (runtimeResult._tag !== 'Success' || starting || stopping) {
      throw new Error('Slack daemon control is unavailable')
    }
    setStopping(true)
    try {
      const next = await Effect.runPromiseWith(runtimeResult.value)(
        Effect.gen(function* () {
          const client = yield* BrowserDaemonClient
          return yield* client('slackDaemon.stop', undefined as never)
        })
      )
      setStatus(next)
    } catch (error) {
      setStatus({ status: 'error' })
      throw error
    } finally {
      setStopping(false)
    }
  }, [runtimeResult, starting, stopping])

  return { start, starting, status, stop, stopping }
}
