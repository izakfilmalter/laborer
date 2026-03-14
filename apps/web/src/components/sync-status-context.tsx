/**
 * SyncStatusContext — bridges LiveStore sync status from inside the
 * LiveStoreProvider boundary to components rendered outside it (like Header).
 *
 * Architecture:
 * - `SyncStatusProvider` wraps the app tree above `Header`
 * - `SyncStatusBridge` renders inside `LiveStoreProvider`, subscribes to
 *   `store.networkStatus`, and pushes state updates to the context
 * - `useSyncServiceState()` reads the current sync `ServiceState` from context
 * - `useSyncStatusUpdate()` returns a setter for the sync state (used by the bridge)
 *
 * The context holds a `ServiceState` value:
 * - `{ state: 'unknown' }` — no sync status available (default, before LiveStore loads)
 * - `{ state: 'starting' }` — sync is connecting or actively catching up
 * - `{ state: 'healthy' }` — sync is connected and idle
 *
 * @see Issue #2: LiveStore sync status indicator
 * @see apps/web/src/hooks/use-service-status.ts — consumes this context
 */

import { createContext, useContext, useMemo, useState } from 'react'
import type { ServiceState } from '@/lib/sidecar-statuses'

interface SyncStatusContextValue {
  readonly setSyncState: (state: ServiceState) => void
  readonly syncState: ServiceState
}

const SyncStatusContext = createContext<SyncStatusContextValue>({
  syncState: { state: 'unknown' },
  setSyncState: () => {
    // Default no-op setter — overridden by SyncStatusProvider
  },
})

/**
 * Provider that holds the sync status state. Place above `Header` in the
 * render tree so that `useServiceStatus()` can read the sync state.
 */
function SyncStatusProvider({
  children,
}: {
  readonly children: React.ReactNode
}) {
  const [syncState, setSyncState] = useState<ServiceState>({ state: 'unknown' })

  const value = useMemo(
    (): SyncStatusContextValue => ({ syncState, setSyncState }),
    [syncState]
  )

  return (
    <SyncStatusContext.Provider value={value}>
      {children}
    </SyncStatusContext.Provider>
  )
}

/**
 * Returns the current sync `ServiceState` from context.
 * Used by `useServiceStatus()` to populate the `sync` field.
 */
function useSyncServiceState(): ServiceState {
  return useContext(SyncStatusContext).syncState
}

/**
 * Returns a setter function to update the sync state from inside
 * the LiveStore boundary. Used by `SyncStatusBridge`.
 */
function useSyncStatusUpdate(): (state: ServiceState) => void {
  return useContext(SyncStatusContext).setSyncState
}

export { SyncStatusProvider, useSyncServiceState, useSyncStatusUpdate }
