/**
 * Hook that returns a reactive map of per-service health states.
 *
 * Aggregates data from sidecar status events (Electron IPC or dev polling)
 * and includes a `sync` entry for LiveStore sync status. The sync entry
 * is initially `unknown` and will be wired to LiveStore's sync status
 * when Issue #2 (LiveStore sync status indicator) is implemented.
 *
 * ```tsx
 * const statuses = useServiceStatus()
 * // statuses.server.state → 'healthy' | 'starting' | 'crashed' | ...
 * // statuses.sync.state → 'unknown' (until wired in Issue #2)
 * ```
 *
 * @see Issue #5: useWhenPhase hook and service status hook
 * @see Issue #2: LiveStore sync status indicator (future sync wiring)
 */

import { useMemo } from 'react'
import { useSidecarStatuses } from '@/hooks/use-sidecar-statuses'
import type { ServiceState } from '@/lib/sidecar-statuses'

/** Service names that include sidecar services plus LiveStore sync. */
type ServiceName = 'file-watcher' | 'mcp' | 'server' | 'sync' | 'terminal'

/** Map of every tracked service to its current UI state. */
type ServiceStatuses = Record<ServiceName, ServiceState>

/**
 * Returns a reactive map of per-service health states.
 *
 * Includes all sidecar services plus a `sync` entry for LiveStore
 * background sync status. Updates reactively when any service status
 * changes.
 */
function useServiceStatus(): ServiceStatuses {
  const sidecarStatuses = useSidecarStatuses()

  return useMemo(
    (): ServiceStatuses => ({
      ...sidecarStatuses,
      // Sync status placeholder — wired to LiveStore in Issue #2
      sync: { state: 'unknown' },
    }),
    [sidecarStatuses]
  )
}

export { useServiceStatus }
export type { ServiceName, ServiceStatuses }
