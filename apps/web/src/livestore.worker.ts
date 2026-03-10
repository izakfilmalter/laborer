/**
 * LiveStore dedicated (leader) worker for the Laborer web app.
 *
 * This worker runs in a dedicated Web Worker thread and manages
 * the canonical OPFS-backed SQLite databases for state and eventlog.
 * It handles materializers, sync, and serves state snapshots to
 * client sessions (browser tabs).
 *
 * The worker is imported in the store setup via Vite's `?worker` suffix:
 * ```ts
 * import LiveStoreWorker from "../livestore.worker.ts?worker"
 * ```
 *
 * Sync is configured via `makeWsSync` from `@livestore/sync-cf/client`,
 * which speaks the `SyncWsRpc` protocol over WebSocket to the server's
 * `/rpc` endpoint. The Vite dev proxy forwards `/rpc` to the backend.
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
 * In Tauri production mode, `location.origin` is `tauri://localhost` which
 * can't reach the backend. Use an absolute `ws://localhost:4100/rpc` URL
 * to connect directly to the server sidecar (port 4100, not dev's 2100).
 *
 * In dev mode (browser or `tauri dev`), `location.origin` is the Vite dev
 * server (e.g., `http://localhost:2101`), so `${origin}/rpc` goes through
 * the Vite WebSocket proxy as before.
 */
const syncUrl = globalThis.location.origin.startsWith('tauri://')
  ? 'ws://localhost:4100/rpc'
  : `${globalThis.location.origin}/rpc`

makeWorker({
  schema,
  sync: {
    backend: makeWsSync({ url: syncUrl }),
    initialSyncOptions: { _tag: 'Blocking', timeout: 5000 },
  },
})
