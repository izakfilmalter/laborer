/**
 * LiveStore client adapter setup for the Laborer web app.
 *
 * Configures the browser-side LiveStore instance with OPFS-backed
 * persistence via Web Workers. The store uses the same schema as the
 * server, enabling reactive state sync between server and client.
 *
 * Architecture:
 * - **Main thread**: Runs the React app with in-memory SQLite for queries
 * - **Dedicated worker**: Owns the canonical OPFS SQLite databases
 * - **Shared worker**: Coordinates leader election across tabs
 *
 * Usage in components:
 * ```tsx
 * const store = useLaborerStore()
 * const projects = store.useQuery(tables.projects)
 * store.commit(events.projectCreated({ ... }))
 * ```
 *
 * @see packages/shared/src/schema.ts for the full LiveStore schema
 * @see Issue #17: LiveStore client adapter setup
 */

import { schema } from '@laborer/shared/schema'

import { makePersistedAdapter } from '@livestore/adapter-web'
import LiveStoreSharedWorker from '@livestore/adapter-web/shared-worker?sharedworker'
import { useStore } from '@livestore/react'
import { unstable_batchedUpdates as batchUpdates } from 'react-dom'
import { serverWsSyncUrl } from '../lib/desktop'
import LiveStoreWorkerUrl from '../livestore.worker.ts?worker&url'

/**
 * Whether to reset persistence on load. In dev mode, append `?reset`
 * to the URL to clear the local OPFS databases and start fresh.
 */
const resetPersistence =
  import.meta.env.DEV &&
  new URLSearchParams(globalThis.location.search).get('reset') !== null

if (resetPersistence) {
  const searchParams = new URLSearchParams(globalThis.location.search)
  searchParams.delete('reset')
  globalThis.history.replaceState(
    null,
    '',
    `${globalThis.location.pathname}?${searchParams.toString()}`
  )
}

/**
 * Create the LiveStore dedicated worker with the sync URL injected as a
 * search parameter.
 *
 * In Electron production, `location.origin` is `laborer://app` which
 * can't resolve WebSocket URLs. The main thread has access to the
 * DesktopBridge and can resolve the real server URL, but the worker
 * runs in an isolated context without `window.desktopBridge`.
 *
 * We solve this by appending `?syncUrl=<wsUrl>` to the worker script URL.
 * The worker reads this from `self.location.search` at initialization time.
 *
 * In dev mode (browser or Electron dev), the worker's origin-based URL
 * resolution works fine through the Vite proxy, so no param is needed.
 */
function createLiveStoreWorker(options: { name: string }): Worker {
  let workerUrl = LiveStoreWorkerUrl

  const syncUrl = serverWsSyncUrl()
  const isOriginBased = syncUrl.startsWith(`${globalThis.location.origin}/`)

  if (!isOriginBased) {
    const separator = workerUrl.includes('?') ? '&' : '?'
    workerUrl = `${workerUrl}${separator}syncUrl=${encodeURIComponent(syncUrl)}`
  }

  return new Worker(workerUrl, { type: 'module', name: options.name })
}

/**
 * LiveStore browser adapter with OPFS persistence.
 *
 * Uses a dedicated Web Worker for the leader thread (SQLite + materializers)
 * and a Shared Worker for cross-tab coordination and leader election.
 */
const adapter = makePersistedAdapter({
  storage: { type: 'opfs' },
  worker: createLiveStoreWorker,
  sharedWorker: LiveStoreSharedWorker,
  resetPersistence,
})

/**
 * React hook that returns the LiveStore instance for the Laborer app.
 *
 * Must be called within a `StoreRegistryProvider` and `Suspense` boundary.
 * The hook suspends on first render until the store is loaded from OPFS.
 *
 * The returned store is augmented with React hooks:
 * - `store.useQuery(queryable)` — reactive query subscription
 * - `store.useClientDocument(table)` — useState-like for client documents
 *
 * Also exposes `store.commit(event)` for committing events,
 * `store.query(table)` for synchronous queries, and
 * `store.networkStatus` (Effect `Subscribable`) for sync connectivity.
 */
const useLaborerStore = () =>
  useStore({
    storeId: 'laborer',
    schema,
    adapter,
    batchUpdates,
  })

export { useLaborerStore }
