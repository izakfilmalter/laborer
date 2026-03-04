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
 * @see packages/shared/src/schema.ts for the LiveStore schema definition
 * @see Issue #17: LiveStore client adapter setup
 */

import { schema } from "@laborer/shared/schema";
import { makeWorker } from "@livestore/adapter-web/worker";

makeWorker({ schema });
