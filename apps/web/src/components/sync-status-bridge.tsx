/**
 * SyncStatusBridge — renderless component that subscribes to
 * `store.networkStatus` from LiveStore and bridges the connectivity
 * state to the `SyncStatusContext`.
 *
 * Must be rendered inside the `LiveStoreProvider` boundary (it calls
 * `useLaborerStore()`). Updates the `SyncStatusContext` which is
 * consumed by `useServiceStatus()` in the header.
 *
 * Maps LiveStore's `NetworkStatus.isConnected` to `ServiceState`:
 * - `isConnected: true` → `{ state: 'healthy' }` (sync idle, connected)
 * - `isConnected: false` → `{ state: 'starting' }` (sync connecting/catching up)
 *
 * Uses polling on `store.networkStatus.get` since the Effect Subscribable
 * stream API requires an Effect runtime which is heavy for a simple React bridge.
 *
 * @see Issue #2: LiveStore sync status indicator
 * @see apps/web/src/components/sync-status-context.tsx — the context being updated
 */

import { Effect } from 'effect'
import { useEffect, useRef } from 'react'
import { useSyncStatusUpdate } from '@/components/sync-status-context'
import { useLaborerStore } from '@/livestore/store'

/** Polling interval for checking network status (ms). */
const SYNC_STATUS_POLL_INTERVAL_MS = 2000

/**
 * Renderless component that bridges LiveStore sync status to the
 * SyncStatusContext. Place inside `LiveStoreProvider`.
 */
function SyncStatusBridge(): null {
  const store = useLaborerStore()
  const setSyncState = useSyncStatusUpdate()
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true

    function pollNetworkStatus() {
      Effect.runPromise(store.networkStatus.get)
        .then((status) => {
          if (!mountedRef.current) {
            return
          }
          setSyncState(
            status.isConnected ? { state: 'healthy' } : { state: 'starting' }
          )
        })
        .catch(() => {
          // If we can't read network status, leave state as-is
        })
    }

    // Poll immediately, then on interval
    pollNetworkStatus()
    const intervalId = setInterval(
      pollNetworkStatus,
      SYNC_STATUS_POLL_INTERVAL_MS
    )

    return () => {
      mountedRef.current = false
      clearInterval(intervalId)
    }
  }, [store, setSyncState])

  return null
}

export { SyncStatusBridge }
