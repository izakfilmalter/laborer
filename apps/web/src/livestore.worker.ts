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
 * Sync transport selection:
 * - **Electron mode**: The main thread transfers a `MessagePort` to this
 *   worker via `postMessage`. The worker uses `makeMessagePortSync` to
 *   speak the `SyncWsRpc` protocol over the port directly to the server
 *   utility process — no WebSocket, no HTTP.
 * - **Browser dev mode**: Uses `makeWsSync` from `@livestore/sync-cf/client`
 *   which speaks `SyncWsRpc` over WebSocket to the server's `/rpc` endpoint.
 *   The Vite dev proxy forwards `/rpc` to the backend.
 *
 * Sync uses LiveStore's default non-blocking mode (`{ _tag: 'Skip' }`):
 * the store loads from the local OPFS cache immediately and syncs in the
 * background. This means the Suspense boundary resolves in milliseconds
 * (from OPFS) rather than waiting up to 5s for network sync.
 *
 * @see packages/shared/src/schema.ts for the LiveStore schema definition
 * @see Issue #11: LiveStore sync over MessagePort
 * @see Issue #17: LiveStore client adapter setup
 * @see Issue #18: LiveStore server-to-client sync
 */

import { schema } from '@laborer/shared/schema'
import { makeWorker } from '@livestore/adapter-web/worker'
import { makeWsSync } from '@livestore/sync-cf/client'
import { makeMessagePortSync } from './livestore/messageport-sync'

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

/**
 * Check if the main thread signaled Electron MessagePort sync mode.
 *
 * The main thread appends `?transport=messageport` to the worker URL
 * when a sync MessagePort will be transferred. The worker then waits
 * for the port before initializing LiveStore.
 */
const isMessagePortMode = (): boolean => {
  const params = new URLSearchParams(globalThis.location.search)
  return params.get('transport') === 'messageport'
}

/**
 * Wait for a MessagePort from the main thread.
 *
 * In Electron mode, the main thread acquires a sync MessagePort from
 * the server utility process and transfers it to this worker via
 * `worker.postMessage({ type: 'sync-port' }, [port])`.
 */
const waitForSyncPort = (): Promise<MessagePort> =>
  new Promise((resolve) => {
    const handler = (event: MessageEvent) => {
      const data = event.data as { type?: string }
      if (data?.type === 'sync-port' && event.ports.length > 0) {
        self.removeEventListener('message', handler)
        const port = event.ports[0]
        if (port) {
          resolve(port)
        }
      }
    }
    self.addEventListener('message', handler)
  })

if (isMessagePortMode()) {
  // Electron MessagePort sync mode: wait for the port, then initialize.
  waitForSyncPort().then((port) => {
    console.log(
      '[LiveStore.worker] initializing with MessagePort sync (Electron mode)'
    )

    // The makeMessagePortSync adapter accepts any duck-typed port with
    // postMessage/onmessage/start/close methods. Browser's MessagePort
    // is compatible. The return type is duck-typed to match LiveStore's
    // SyncBackend interface — we cast through `unknown` because LiveStore
    // uses branded number types (GlobalEventSequenceNumber) internally
    // that are structurally identical to plain numbers at runtime.
    // Cast the browser MessagePort through `unknown` to satisfy the
    // RpcMessagePort interface (structurally compatible, different
    // onmessage signature due to browser vs generic typing).
    const typedPort = port as unknown as Parameters<
      typeof makeMessagePortSync
    >[0]

    makeWorker({
      schema,
      sync: {
        backend: makeMessagePortSync(typedPort) as unknown as ReturnType<
          typeof makeWsSync
        >,
      },
    })
  })
} else {
  // Browser/dev mode: use WebSocket sync.
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
}
