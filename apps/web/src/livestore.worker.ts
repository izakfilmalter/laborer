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

/** Regex for converting http(s) URLs to ws(s) URLs. */
const HTTP_TO_WS_RE = /^http/

/**
 * Resolve the WebSocket sync URL based on the runtime context.
 *
 * In Electron production mode, `location.origin` is `laborer://app` which
 * can't reach the backend via relative URLs. The DesktopBridge provides
 * service URLs, but since this runs in a Web Worker (no window.desktopBridge
 * access), we detect the custom protocol and fall back to reading the server
 * URL from a global config.
 *
 * In dev mode (browser or Electron dev), `location.origin` is the Vite dev
 * server (e.g., `http://localhost:2101`), so `${origin}/rpc` goes through
 * the Vite WebSocket proxy as before.
 *
 * The main thread posts the server URL to the worker via the
 * `__LABORER_SERVER_URL__` global, set before the worker is initialized.
 * If not available, we fall back to the origin-based URL.
 */
const resolveWsSyncUrl = (): string => {
  // Check for Electron production protocol (laborer://)
  if (globalThis.location.origin.startsWith('laborer://')) {
    // In Electron production, the server URL is provided via a global
    // that the main thread sets. Fall back to origin-based URL if missing.
    const serverUrl = (
      globalThis as unknown as { __LABORER_SERVER_URL__?: string }
    ).__LABORER_SERVER_URL__
    if (serverUrl) {
      return `${serverUrl.replace(HTTP_TO_WS_RE, 'ws')}/rpc`
    }
  }
  return `${globalThis.location.origin}/rpc`
}

const syncUrl = resolveWsSyncUrl()

makeWorker({
  schema,
  sync: {
    backend: makeWsSync({ url: syncUrl }),
    initialSyncOptions: { _tag: 'Blocking', timeout: 5000 },
  },
})
