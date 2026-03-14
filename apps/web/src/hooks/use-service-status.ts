/**
 * Hook that returns a reactive map of per-service health states.
 *
 * Aggregates data from sidecar status events (Electron IPC or dev polling)
 * and includes a `sync` entry for LiveStore sync status from the
 * `SyncStatusContext`.
 *
 * ```tsx
 * const statuses = useServiceStatus()
 * // statuses.server.state → 'healthy' | 'starting' | 'crashed' | ...
 * // statuses.sync.state → 'unknown' | 'starting' | 'healthy'
 * ```
 *
 * @see Issue #5: useWhenPhase hook and service status hook
 * @see Issue #2: LiveStore sync status indicator
 */

import { useMemo } from 'react'
import { useSyncServiceState } from '@/components/sync-status-context'
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
  const syncState = useSyncServiceState()

  return useMemo(
    (): ServiceStatuses => ({
      ...sidecarStatuses,
      sync: syncState,
    }),
    [sidecarStatuses, syncState]
  )
}

export { useServiceStatus }
export type { ServiceName, ServiceStatuses }
