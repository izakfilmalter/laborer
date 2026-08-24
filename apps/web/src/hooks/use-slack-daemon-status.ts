import { useAtomMount, useAtomValue } from '@effect/atom-react/Hooks'
import { RegistryContext } from '@effect/atom-react/RegistryContext'
import { Effect } from 'effect'
import { useCallback, useContext, useState } from 'react'

import { BrowserDaemonClient } from '@/atoms/browser-daemon-client'
import {
  slackDaemonStatusAtom,
  slackDaemonStatusPollerAtom,
} from '@/atoms/slack-daemon-status'

/**
 * Slack daemon status shared across all consumers: N mounts share one poll
 * loop via `slackDaemonStatusPollerAtom`. Start/stop actions update the
 * shared atom so every consumer sees the final status.
 */
export function useSlackDaemonStatus() {
  useAtomMount(slackDaemonStatusPollerAtom)
  const status = useAtomValue(slackDaemonStatusAtom)
  const registry = useContext(RegistryContext)
  const runtimeResult = useAtomValue(BrowserDaemonClient.runtime)
  const [starting, setStarting] = useState(false)
  const [stopping, setStopping] = useState(false)

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
      registry.set(slackDaemonStatusAtom, next)
    } catch (error) {
      registry.set(slackDaemonStatusAtom, { status: 'error' })
      throw error
    } finally {
      setStarting(false)
    }
  }, [registry, runtimeResult, starting, stopping])

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
      registry.set(slackDaemonStatusAtom, next)
    } catch (error) {
      registry.set(slackDaemonStatusAtom, { status: 'error' })
      throw error
    } finally {
      setStopping(false)
    }
  }, [registry, runtimeResult, starting, stopping])

  return { start, starting, status, stop, stopping }
}
