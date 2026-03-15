/**
 * React hook that tracks the live status of all sidecar services.
 *
 * In Electron production mode, subscribes to SidecarStatusEvent IPC from the
 * DesktopBridge (events emitted by HealthMonitor in the main process).
 *
 * In dev mode (both browser and Electron dev), polls health endpoints for
 * each service through the Vite proxy and synthesizes status events.
 * The Electron main process does NOT spawn sidecars or emit IPC events in
 * dev mode — services are run separately via `turbo dev`.
 *
 * @see packages/shared/src/desktop-bridge.ts — SidecarStatusEvent type
 * @see apps/web/src/lib/sidecar-statuses.ts — pure derivation logic
 * @see apps/web/vite.config.ts — /server-health, /terminal-health, /file-watcher-health proxies
 * @see apps/desktop/src/main.ts — HealthMonitor only created when !isDev
 */

import type {
  SidecarName,
  SidecarStatusEvent,
} from '@laborer/shared/desktop-bridge'
import { useCallback, useEffect, useRef, useState } from 'react'

import { getDesktopBridge } from '@/lib/desktop'
import {
  deriveSidecarStatuses,
  type SidecarStatuses,
} from '@/lib/sidecar-statuses'

/** Initial state with all services unknown. */
const INITIAL_STATUSES = deriveSidecarStatuses([])

/** Polling interval for dev mode health checks (ms). */
const DEV_POLL_INTERVAL_MS = 3000

/**
 * Whether sidecar status should come from IPC events (Electron production)
 * rather than HTTP health polling (dev mode).
 *
 * In Electron dev mode, the bridge exists but the main process does NOT
 * create a HealthMonitor or emit sidecar status events (sidecars are run
 * externally via `turbo dev`). So we must use HTTP polling in dev mode
 * regardless of whether the bridge is present.
 */
const useIpcEvents = Boolean(getDesktopBridge()) && import.meta.env.PROD

/**
 * Health endpoint paths for each service in dev mode.
 * These are proxied by Vite to the respective service's root endpoint.
 * MCP uses stdio and has no HTTP health endpoint.
 */
const DEV_HEALTH_ENDPOINTS: Partial<Record<SidecarName, string>> = {
  server: '/server-health',
  terminal: '/terminal-health',
  'file-watcher': '/file-watcher-health',
}

/**
 * Track the live status of all sidecar services.
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

  // Electron production: subscribe to sidecar status events via IPC.
  useEffect(() => {
    if (!useIpcEvents) {
      return
    }

    const bridge = getDesktopBridge()
    if (!bridge) {
      return
    }

    return bridge.onSidecarStatus(handleEvent)
  }, [handleEvent])

  // Dev mode (browser or Electron dev): poll health endpoints.
  useEffect(() => {
    if (useIpcEvents) {
      return
    }

    const healthState = new Map<SidecarName, boolean>()
    const failureCount = new Map<SidecarName, number>()

    async function pollService(name: SidecarName, endpoint: string) {
      const ok = await tryFetchHealth(name, endpoint)

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
async function tryFetchHealth(
  _name: SidecarName,
  endpoint: string
): Promise<boolean> {
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
