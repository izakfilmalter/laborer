/**
 * Hook that returns a reactive map of per-service health states.
 *
 * Aggregates data from sidecar status events (Electron IPC or dev polling)
 * and includes a `sync` alias for renderer-to-server RPC health.
 *
 * ```tsx
 * const statuses = useServiceStatus()
 * // statuses.server.state → 'healthy' | 'starting' | 'crashed' | ...
 * // statuses.sync.state → 'healthy' | 'reconnecting' | 'down'
 * ```
 *
 * @see Issue #5: useWhenPhase hook and service status hook
 * @see Issue #423: sync-status indicator repurposed to connection health
 */

import { useMemo } from 'react'
import { useSidecarStatuses } from '@/hooks/use-sidecar-statuses'
import type { ServiceState } from '@/lib/sidecar-statuses'

/** Service names that include sidecar services plus server connection health. */
type ServiceName = 'file-watcher' | 'server' | 'sync' | 'terminal'

/** Map of every tracked service to its current UI state. */
type ServiceStatuses = Record<ServiceName, ServiceState>

/**
 * Returns a reactive map of per-service health states.
 *
 * Includes all sidecar services plus a `sync` entry for the server RPC
 * connection. MessagePort RPC shares the server utility process lifecycle.
 */
function useServiceStatus(): ServiceStatuses {
  const sidecarStatuses = useSidecarStatuses()

  return useMemo(
    (): ServiceStatuses => ({
      ...sidecarStatuses,
      sync: sidecarStatuses.server,
    }),
    [sidecarStatuses]
  )
}

export { useServiceStatus }
export type { ServiceName, ServiceStatuses }
