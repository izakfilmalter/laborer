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
 * Sync transport: The main thread transfers a `MessagePort` to this
 * worker via `postMessage`. The worker uses `makeMessagePortSync` to
 * speak the `SyncWsRpc` protocol over the port directly to the server
 * utility process — no WebSocket, no HTTP.
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
import type { makeWsSync } from '@livestore/sync-cf/client'
import { Cause, Effect, Exit } from 'effect'
import { makeMessagePortSync } from './livestore/messageport-sync'
import {
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

const formatConsoleArg = (value: unknown): string => {
  if (typeof value === 'string') {
    return value
  }

  if (value instanceof Error) {
    return `${value.message}\n${value.stack ?? ''}`
  }

  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

let didReportRecoverableBootError = false

const maybeReportRecoverableBootError = (...args: readonly unknown[]) => {
  if (didReportRecoverableBootError) {
    return
  }

  const cause = args.map((value) => formatConsoleArg(value)).join(' ')
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
 * Wait for a MessagePort from the main thread.
 *
 * The main thread acquires a sync MessagePort from the server utility
 * process and transfers it to this worker via
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

// Wait for the sync MessagePort from the main thread, then initialize.
waitForSyncPort().then((port) => {
  console.log('[LiveStore.worker] initializing with MessagePort sync')

  // The makeMessagePortSync adapter accepts any duck-typed port with
  // postMessage/onmessage/start/close methods. Browser's MessagePort
  // is compatible. The return type is duck-typed to match LiveStore's
  // SyncBackend interface — we cast through `unknown` because LiveStore
  // uses branded number types (GlobalEventSequenceNumber) internally
  // that are structurally identical to plain numbers at runtime.
  // Cast the browser MessagePort through `unknown` to satisfy the
  // RpcMessagePort interface (structurally compatible, different
  // onmessage signature due to browser vs generic typing).
  const typedPort = port as unknown as Parameters<typeof makeMessagePortSync>[0]

  const runWorker = async () => {
    const exit = await Effect.runPromiseExit(
      makeWorkerEffect({
        schema,
        sync: {
          backend: makeMessagePortSync(typedPort) as unknown as ReturnType<
            typeof makeWsSync
          >,
        },
      })
    )

    if (Exit.isFailure(exit)) {
      const cause = Cause.pretty(exit.cause)
      console.error('[LiveStore.worker] fatal exit', cause)
      reportFatalWorkerError(cause)
    }
  }

  runWorker().catch((error: unknown) => {
    const cause = error instanceof Error ? error.message : String(error)
    console.error('[LiveStore.worker] failed to start', cause)
    reportFatalWorkerError(cause)
  })
})
