/**
 * LiveStore dedicated (leader) worker for the Laborer web app.
 *
 * This worker runs in a dedicated Web Worker thread and manages
 * the canonical OPFS-backed SQLite databases for state and eventlog.
 * It handles materializers, sync, and serves state snapshots to
 * client sessions (browser tabs).
 *
 * The worker is imported in the store setup via Vite's `?worker&url` suffix:
 * ```ts
 * import LiveStoreWorkerUrl from "../livestore.worker.ts?worker&url"
 * ```
 *
 * Sync is configured via `makeWsSync` from `@livestore/sync-cf/client`,
 * which speaks the `SyncWsRpc` protocol over WebSocket to the server's
 * `/rpc` endpoint. The Vite dev proxy forwards `/rpc` to the backend.
 *
 * Sync uses LiveStore's default non-blocking mode (`{ _tag: 'Skip' }`):
 * the store loads from the local OPFS cache immediately and syncs in the
 * background. This means the Suspense boundary resolves in milliseconds
 * (from OPFS) rather than waiting up to 5s for network sync.
 *
 * @see packages/shared/src/schema.ts for the LiveStore schema definition
 * @see Issue #17: LiveStore client adapter setup
 * @see Issue #18: LiveStore server-to-client sync
 */

import { schema } from '@laborer/shared/schema'
import { makeWorker } from '@livestore/adapter-web/worker'
import { makeWsSync } from '@livestore/sync-cf/client'

/**
 * Resolve the WebSocket sync URL based on the runtime context.
 *
 * In Electron production mode, `location.origin` is `laborer://app` which
 * can't reach the backend via relative URLs. The main thread resolves the
 * real server URL from the DesktopBridge and passes it to this worker as
 * a `syncUrl` search parameter on the worker script URL.
 *
 * In dev mode (browser or Electron dev), `location.origin` is the Vite dev
 * server (e.g., `http://localhost:2101`), so `${origin}/rpc` goes through
 * the Vite WebSocket proxy as before.
 */
const resolveWsSyncUrl = (): string => {
  // The main thread appends ?syncUrl=<url> to the worker script URL
  // when the origin can't be used for WebSocket connections (Electron production).
  const params = new URLSearchParams(globalThis.location.search)
  const injectedUrl = params.get('syncUrl')
  if (injectedUrl) {
    return injectedUrl
  }

  return `${globalThis.location.origin}/rpc`
}

const syncUrl = resolveWsSyncUrl()

console.log(
  `[LiveStore.worker] initializing with syncUrl=${syncUrl} (origin=${globalThis.location.origin})`
)

makeWorker({
  schema,
  sync: {
    backend: makeWsSync({ url: syncUrl }),
  },
})
