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
 * Sync transport: Main thread acquires a sync MessagePort from the server
 * utility process via `desktopBridge.acquireSyncPort()`, then transfers
 * it to the worker. Worker uses `makeMessagePortSync`.
 *
 * Usage in components:
 * ```tsx
 * const store = useLaborerStore()
 * const projects = store.useQuery(tables.projects)
 * store.commit(events.projectCreated({ ... }))
 * ```
 *
 * @see packages/shared/src/schema.ts for the full LiveStore schema
 * @see Issue #11: LiveStore sync over MessagePort
 * @see Issue #17: LiveStore client adapter setup
 */

import { schema } from '@laborer/shared/schema'
import { RPC_PORT_DEAD_EVENT } from '@laborer/shared/rpc-transport-messageport-client'

import { makePersistedAdapter } from '@livestore/adapter-web'
import LiveStoreSharedWorker from '@livestore/adapter-web/shared-worker?sharedworker'
import { useStore } from '@livestore/react'
import { unstable_batchedUpdates as batchUpdates } from 'react-dom'
import { acquireSyncPort } from '../lib/desktop'
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
 * Create the LiveStore dedicated worker.
 *
 * The worker URL includes `?transport=messageport` to signal the worker
 * should wait for a MessagePort transfer instead of creating a WebSocket
 * connection.
 *
 * After creating the worker, the main thread acquires a sync port from
 * the server utility process and transfers it to the worker.
 */
function createLiveStoreWorker(options: { name: string }): Worker {
  let workerUrl = LiveStoreWorkerUrl

  // Signal the worker to wait for a MessagePort transfer.
  const separator = workerUrl.includes('?') ? '&' : '?'
  workerUrl = `${workerUrl}${separator}transport=messageport`

  const worker = new Worker(workerUrl, { type: 'module', name: options.name })

  worker.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: string }
    if (data?.type !== RPC_PORT_DEAD_EVENT) {
      return
    }

    console.warn(
      '[LiveStore.store] Worker reported dead RPC port — requesting runtime reset'
    )
    window.dispatchEvent(new Event(RPC_PORT_DEAD_EVENT))
  })

  // Acquire a sync MessagePort from the server utility process and
  // transfer it to the worker. This happens asynchronously — the worker
  // waits for the port before initializing LiveStore.
  acquireSyncPort()
    .then((port) => {
      if (port) {
        worker.postMessage({ type: 'sync-port' }, [port])
      } else {
        console.warn(
          '[LiveStore.store] Failed to acquire sync port — server utility process may not be running'
        )
      }
    })
    .catch((error: unknown) => {
      console.error('[LiveStore.store] Error acquiring sync port:', error)
    })

  return worker
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
