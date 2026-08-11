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
 * @see Issue #2: LiveStore sync status indicator
 * @see apps/web/src/components/sync-status-context.tsx — the context being updated
 */

import { useAtomValue } from '@effect-atom/atom-react/Hooks'
import { workspaces } from '@laborer/shared/schema'
import { queryDb } from '@livestore/livestore'
import { Effect, Fiber, Stream } from 'effect'
import { useEffect, useMemo, useRef } from 'react'
import { projectViewsAtom } from '@/atoms/shared-state'
import { useSyncStatusUpdate } from '@/components/sync-status-context'
import { useLaborerStore } from '@/livestore/store'

const syncStatusBridgeWorkspaces$ = queryDb(workspaces, {
  label: 'syncStatusBridgeWorkspaces',
})

/**
 * Renderless component that bridges LiveStore sync status to the
 * SyncStatusContext. Place inside `LiveStoreProvider`.
 */
function SyncStatusBridge(): null {
  const store = useLaborerStore()
  const setSyncState = useSyncStatusUpdate()
  const mountedRef = useRef(true)
  const projectList = useAtomValue(projectViewsAtom)
  const workspaceList = store.useQuery(syncStatusBridgeWorkspaces$)
  const liveStoreSnapshot = useMemo(
    () =>
      JSON.stringify({
        projectCount: projectList.length,
        projects: [...projectList]
          .map((project) => ({ id: project.id, name: project.name }))
          .sort((left, right) => left.id.localeCompare(right.id)),
        workspaceCount: workspaceList.length,
        workspaces: [...workspaceList]
          .map((workspace) => ({
            id: workspace.id,
            projectId: workspace.projectId,
          }))
          .sort((left, right) => left.id.localeCompare(right.id)),
      }),
    [projectList, workspaceList]
  )

  useEffect(() => {
    console.info(`[SyncStatusBridge] LiveStore snapshot ${liveStoreSnapshot}`)
  }, [liveStoreSnapshot])

  useEffect(() => {
    mountedRef.current = true

    const applyNetworkStatus = (status: { isConnected: boolean }) => {
      if (!mountedRef.current) {
        return
      }

      setSyncState(
        status.isConnected ? { state: 'healthy' } : { state: 'starting' }
      )
    }

    Effect.runPromise(store.networkStatus.get)
      .then(applyNetworkStatus)
      .catch(() => {
        // If we can't read the initial network status, leave state as-is.
      })

    const networkStatusFiber = Effect.runFork(
      store.networkStatus.changes.pipe(
        Stream.runForEach((status) =>
          Effect.sync(() => applyNetworkStatus(status))
        )
      )
    )

    return () => {
      mountedRef.current = false
      Effect.runFork(Fiber.interrupt(networkStatusFiber))
    }
  }, [store, setSyncState])

  return null
}

export { SyncStatusBridge }
