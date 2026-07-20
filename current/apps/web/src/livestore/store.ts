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
 * Sync transport: Main thread resolves the desktop-managed backend WebSocket
 * URL from the preload bridge and passes it to the worker. This mirrors
 * t3code's server connection model: a backend process owns WebSocket RPC and
 * clients connect to the resolved loopback endpoint.
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

import { RPC_PORT_DEAD_EVENT } from '@laborer/shared/rpc-transport-messageport-client'
import { schema } from '@laborer/shared/schema'

import { makePersistedAdapter } from '@livestore/adapter-web'
import LiveStoreSharedWorker from '@livestore/adapter-web/shared-worker?sharedworker'
import { useStore } from '@livestore/react'
import { unstable_batchedUpdates as batchUpdates } from 'react-dom'
import { getBackendSyncWsUrl, isElectron } from '../lib/desktop'
import LiveStoreWorkerUrl from '../livestore.worker.ts?worker&url'
import {
  consumePendingPersistenceReset,
  formatRecoverableErrorCause,
  installLiveStoreRuntimeRecovery,
  LIVESTORE_FATAL_ERROR_MESSAGE,
  recoverFromPersistenceError,
  schedulePersistenceResetRecovery,
} from './recovery'

const originalConsoleError = console.error.bind(console)
console.error = (...args: unknown[]) => {
  recoverFromPersistenceError(formatRecoverableErrorCause(args))
  originalConsoleError(...args)
}

installLiveStoreRuntimeRecovery()

/**
 * Whether to reset persistence on load. In dev mode, append `?reset`
 * to the URL to clear the local OPFS databases and start fresh.
 * Production recovery can also request a one-shot reset after a fatal
 * persisted-state boot failure.
 */
const resetPersistenceFromRecovery = consumePendingPersistenceReset()

const resetPersistence =
  import.meta.env.DEV &&
  new URLSearchParams(globalThis.location.search).get('reset') !== null

const shouldResetPersistence = resetPersistence || resetPersistenceFromRecovery

if (resetPersistence) {
  const searchParams = new URLSearchParams(globalThis.location.search)
  searchParams.delete('reset')
  globalThis.history.replaceState(
    null,
    '',
    `${globalThis.location.pathname}?${searchParams.toString()}`
  )
}

if (resetPersistenceFromRecovery) {
  console.warn(
    '[LiveStore.store] Resetting persisted LiveStore cache after a previous fatal boot error'
  )
}

/**
 * Create the LiveStore dedicated worker.
 *
 * The desktop app runs the server as a backend child process, following the
 * same shape as t3code: the renderer resolves a backend WebSocket URL from
 * the preload bridge and the sync client owns connection/retry behavior.
 */
function createLiveStoreWorker(options: { name: string }): Worker {
  const worker = new Worker(LiveStoreWorkerUrl, {
    type: 'module',
    name: options.name,
  })

  worker.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as {
      cause?: string
      recoverablePersistenceError?: boolean
      type?: string
    }

    if (data?.type === RPC_PORT_DEAD_EVENT) {
      console.warn(
        '[LiveStore.store] Worker reported dead RPC port — requesting runtime reset'
      )
      window.dispatchEvent(new Event(RPC_PORT_DEAD_EVENT))
      return
    }

    if (data?.type !== LIVESTORE_FATAL_ERROR_MESSAGE) {
      return
    }

    console.error(
      '[LiveStore.store] Worker exited with fatal error',
      data.cause ?? 'Unknown worker failure'
    )

    if (
      data.recoverablePersistenceError === true &&
      schedulePersistenceResetRecovery()
    ) {
      console.warn(
        '[LiveStore.store] Fatal persisted-state error detected — reloading once with a cleared local LiveStore cache'
      )
      globalThis.location.reload()
      return
    }

    window.dispatchEvent(new Event(RPC_PORT_DEAD_EVENT))
  })

  const backendSyncUrl = getBackendSyncWsUrl()
  if (backendSyncUrl !== null) {
    worker.postMessage({ type: 'sync-url', url: backendSyncUrl })
    return worker
  }

  console.warn(
    '[LiveStore.store] No backend sync WebSocket URL available — starting LiveStore without sync backend'
  )
  worker.postMessage({ type: 'no-sync' })

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
  experimental: {
    // The OPFS fast path can render from a stale snapshot before the leader
    // worker validates the eventlog. In Electron that leaves the UI mounted
    // against a dead LiveStore session if boot later fails.
    disableFastPath: isElectron(),
  },
  resetPersistence: shouldResetPersistence,
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
