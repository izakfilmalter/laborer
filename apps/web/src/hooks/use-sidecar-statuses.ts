/**
 * React hook that tracks the live status of all sidecar services.
 *
 * In Electron mode, subscribes to SidecarStatusEvent from the DesktopBridge.
 * In browser dev mode, uses the server health check RPC for the server
 * service and marks all other services as unknown.
 *
 * @see packages/shared/src/desktop-bridge.ts — SidecarStatusEvent type
 * @see apps/web/src/lib/sidecar-statuses.ts — pure derivation logic
 */

import type { SidecarStatusEvent } from '@laborer/shared/desktop-bridge'
import { useCallback, useEffect, useRef, useState } from 'react'

import { getDesktopBridge } from '@/lib/desktop'
import {
  deriveSidecarStatuses,
  type SidecarStatuses,
} from '@/lib/sidecar-statuses'

/** Initial state with all services unknown. */
const INITIAL_STATUSES = deriveSidecarStatuses([])

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

  useEffect(() => {
    const bridge = getDesktopBridge()
    if (!bridge) {
      return
    }

    return bridge.onSidecarStatus(handleEvent)
  }, [handleEvent])

  return statuses
}

export { useSidecarStatuses }
