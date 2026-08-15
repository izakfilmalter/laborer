/**
 * React hook that tracks the live status of daemon-owned capabilities.
 *
 * Browser and Electron clients poll same-origin daemon health aliases for
 * each capability and synthesize status events. The aliases share one daemon
 * lifecycle but preserve the existing capability-level UI model.
 *
 * @see packages/shared/src/desktop-bridge.ts — SidecarStatusEvent type
 * @see apps/web/src/lib/sidecar-statuses.ts — pure derivation logic
 * @see packages/server/src/daemon-main.ts — capability health aliases
 */

import type {
  SidecarName,
  SidecarStatusEvent,
} from '@laborer/shared/desktop-bridge'
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  deriveSidecarStatuses,
  type SidecarStatuses,
} from '@/lib/sidecar-statuses'

/** Initial state with all services unknown. */
const INITIAL_STATUSES = deriveSidecarStatuses([])

/** Polling interval for daemon health checks (ms). */
const DEV_POLL_INTERVAL_MS = 3000

/**
 * Health aliases for each daemon-owned capability.
 */
const DEV_HEALTH_ENDPOINTS: Partial<Record<SidecarName, string>> = {
  server: '/server-health',
  terminal: '/terminal-health',
  'file-watcher': '/file-watcher-health',
}

/**
 * Track the live status of all daemon-owned capabilities.
 *
 * Returns a `SidecarStatuses` record mapping each service name to its
 * current state (unknown | starting | healthy | crashed | restarting).
 */
function useSidecarStatuses(): SidecarStatuses {
  const [statuses, setStatuses] = useState<SidecarStatuses>(INITIAL_STATUSES)
  const eventsRef = useRef<SidecarStatusEvent[]>([])

  const handleEvent = useCallback((event: SidecarStatusEvent) => {
    eventsRef.current = [...eventsRef.current, event]
    setStatuses(deriveSidecarStatuses(eventsRef.current))
  }, [])

  // Browser and Electron renderers poll the daemon's same-origin aliases.
  useEffect(() => {
    const healthState = new Map<SidecarName, boolean>()
    const failureCount = new Map<SidecarName, number>()

    async function pollService(name: SidecarName, endpoint: string) {
      const ok = await tryFetchHealth(endpoint)

      if (ok) {
        failureCount.set(name, 0)
        if (!healthState.get(name)) {
          healthState.set(name, true)
          handleEvent({ state: 'healthy', name })
        }
        return
      }

      const failures = (failureCount.get(name) ?? 0) + 1
      failureCount.set(name, failures)
      const wasHealthy = healthState.get(name) === true

      if (wasHealthy || failures >= 3) {
        healthState.set(name, false)
        handleEvent({ state: 'crashed', name, error: 'Service unreachable' })
      }
    }

    async function pollAll() {
      const polls = Object.entries(DEV_HEALTH_ENDPOINTS).map(
        ([name, endpoint]) =>
          pollService(name as SidecarName, endpoint as string)
      )
      await Promise.all(polls)
    }

    // Emit initial "starting" events for pollable services so the UI
    // shows yellow/starting instead of gray/unknown while we wait for
    // the first poll result.
    for (const name of Object.keys(DEV_HEALTH_ENDPOINTS)) {
      handleEvent({ state: 'starting', name: name as SidecarName })
    }

    // Run first poll immediately.
    pollAll()

    const intervalId = setInterval(() => {
      pollAll()
    }, DEV_POLL_INTERVAL_MS)

    return () => {
      clearInterval(intervalId)
    }
  }, [handleEvent])

  return statuses
}

/**
 * Attempt to fetch a health endpoint. Returns true if the response is ok.
 */
async function tryFetchHealth(endpoint: string): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 2000)
    const response = await fetch(endpoint, {
      signal: controller.signal,
      redirect: 'error',
    })
    clearTimeout(timeoutId)

    return response.ok
  } catch {
    return false
  }
}

export { useSidecarStatuses }
