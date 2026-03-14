/**
 * React hook that tracks the live status of all sidecar services.
 *
 * In Electron mode, subscribes to SidecarStatusEvent from the DesktopBridge.
 * In browser dev mode, polls health endpoints for each service through the
 * Vite proxy and synthesizes status events.
 *
 * @see packages/shared/src/desktop-bridge.ts — SidecarStatusEvent type
 * @see apps/web/src/lib/sidecar-statuses.ts — pure derivation logic
 * @see apps/web/vite.config.ts — /server-health, /terminal-health, /file-watcher-health proxies
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

  // Electron mode: subscribe to sidecar status events via the DesktopBridge.
  useEffect(() => {
    const bridge = getDesktopBridge()
    if (!bridge) {
      return
    }

    return bridge.onSidecarStatus(handleEvent)
  }, [handleEvent])

  // Dev/browser mode: poll health endpoints for each service.
  useEffect(() => {
    const bridge = getDesktopBridge()
    if (bridge) {
      // In Electron mode, the bridge subscription handles status updates.
      return
    }

    // Track health state per service to avoid duplicate events.
    const healthState = new Map<SidecarName, boolean>()

    async function pollService(name: SidecarName, endpoint: string) {
      try {
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 2000)
        const response = await fetch(endpoint, {
          signal: controller.signal,
          redirect: 'error',
        })
        clearTimeout(timeoutId)

        if (response.ok) {
          if (!healthState.get(name)) {
            healthState.set(name, true)
            handleEvent({ state: 'healthy', name })
          }
          return
        }
      } catch {
        // Connection refused, timeout, etc.
      }

      if (healthState.get(name)) {
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

export { useSidecarStatuses }
