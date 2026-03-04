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

import { schema } from "@laborer/shared/schema";
import { makeWorker } from "@livestore/adapter-web/worker";
import { makeWsSync } from "@livestore/sync-cf/client";

makeWorker({
	schema,
	sync: {
		backend: makeWsSync({ url: `${globalThis.location.origin}/rpc` }),
		initialSyncOptions: { _tag: "Blocking", timeout: 5000 },
	},
});
