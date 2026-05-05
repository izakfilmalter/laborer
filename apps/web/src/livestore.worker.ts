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
 * Sync transport: Desktop builds pass the backend WebSocket sync URL to this
 * worker via `postMessage`. MessagePort sync is still accepted for tests and
 * local experiments, but production follows the backend WebSocket model.
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

import { RPC_PORT_DEAD_EVENT } from '@laborer/shared/rpc-transport-messageport-client'
import { schema } from '@laborer/shared/schema'
import { makeWorkerEffect } from '@livestore/adapter-web/worker'
import { makeWsSync } from '@livestore/sync-cf/client'
import { Cause, Effect, Exit } from 'effect'
import { makeMessagePortSync } from './livestore/messageport-sync'
import {
  formatRecoverableErrorCause,
  isRecoverablePersistenceError,
  LIVESTORE_FATAL_ERROR_MESSAGE,
} from './livestore/recovery'

// The sync transport runs inside this worker, so transport-level port death
// events would otherwise stay trapped here. Relay them to the main thread so
// the React-side runtime boundary can recreate the LiveStore session.
self.addEventListener(RPC_PORT_DEAD_EVENT, () => {
  self.postMessage({ type: RPC_PORT_DEAD_EVENT })
})

const reportFatalWorkerError = (cause: string) => {
  self.postMessage({
    cause,
    recoverablePersistenceError: isRecoverablePersistenceError(cause),
    type: LIVESTORE_FATAL_ERROR_MESSAGE,
  })
}

let didReportRecoverableBootError = false

const maybeReportRecoverableBootError = (...args: readonly unknown[]) => {
  if (didReportRecoverableBootError) {
    return
  }

  const cause = formatRecoverableErrorCause(args)
  if (!isRecoverablePersistenceError(cause)) {
    return
  }

  didReportRecoverableBootError = true
  reportFatalWorkerError(cause)
}

const originalConsoleError = console.error.bind(console)
console.error = (...args: unknown[]) => {
  maybeReportRecoverableBootError(...args)
  originalConsoleError(...args)
}

/**
 * Wait for sync configuration from the main thread.
 *
 * Desktop builds use the backend WebSocket URL exposed by the preload bridge.
 * MessagePort sync is still accepted for tests and experiments, but the
 * production connection shape follows t3code's backend WebSocket model.
 */
type SyncConfig =
  | { readonly type: 'message-port'; readonly port: MessagePort }
  | { readonly type: 'websocket'; readonly url: string }
  | { readonly type: 'none' }

const waitForSyncConfig = (): Promise<SyncConfig> =>
  new Promise((resolve) => {
    const handler = (event: MessageEvent) => {
      const data = event.data as { type?: string; url?: unknown }
      if (data?.type === 'no-sync') {
        self.removeEventListener('message', handler)
        resolve({ type: 'none' })
        return
      }
      if (data?.type === 'sync-url' && typeof data.url === 'string') {
        self.removeEventListener('message', handler)
        resolve({ type: 'websocket', url: data.url })
        return
      }
      if (data?.type === 'sync-port' && event.ports.length > 0) {
        self.removeEventListener('message', handler)
        const port = event.ports[0]
        if (port) {
          resolve({ port, type: 'message-port' })
        }
      }
    }
    self.addEventListener('message', handler)
  })

const runWorker = async (syncConfig: SyncConfig) => {
  const syncBackend = (() => {
    if (syncConfig.type === 'websocket') {
      return makeWsSync({ url: syncConfig.url })
    }

    if (syncConfig.type === 'message-port') {
      return makeMessagePortSync(
        syncConfig.port as unknown as Parameters<typeof makeMessagePortSync>[0]
      ) as unknown as ReturnType<typeof makeWsSync>
    }

    return null
  })()

  const workerOptions = syncBackend
    ? { schema, sync: { backend: syncBackend } }
    : { schema }

  const exit = await Effect.runPromiseExit(makeWorkerEffect(workerOptions))

  if (Exit.isFailure(exit)) {
    const cause = Cause.pretty(exit.cause)
    console.error('[LiveStore.worker] fatal exit', cause)
    reportFatalWorkerError(cause)
  }
}

// Wait for the sync configuration from the main thread, then initialize.
waitForSyncConfig().then((syncConfig) => {
  let syncModeMessage = '[LiveStore.worker] initializing without sync backend'
  if (syncConfig.type === 'websocket') {
    syncModeMessage = '[LiveStore.worker] initializing with WebSocket sync'
  } else if (syncConfig.type === 'message-port') {
    syncModeMessage = '[LiveStore.worker] initializing with MessagePort sync'
  }
  console.log(syncModeMessage)

  runWorker(syncConfig).catch((error: unknown) => {
    const cause = error instanceof Error ? error.message : String(error)
    console.error('[LiveStore.worker] failed to start', cause)
    reportFatalWorkerError(cause)
  })
})
