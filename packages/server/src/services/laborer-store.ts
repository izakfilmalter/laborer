/**
 * LaborerStore — LiveStore server adapter as an Effect Service
 *
 * Initializes LiveStore with the @livestore/adapter-node adapter using
 * filesystem-backed SQLite persistence and WebSocket sync to the server's
 * own sync backend. The store is created as an Effect Layer that provides
 * the LiveStore context to all server services.
 *
 * The store persists events to `./data/<storeId>/` by default, ensuring
 * state survives server restarts. LiveStore tables (projects,
 * workspaces, diffs, tasks, panelLayout) are available for
 * querying and event commits.
 *
 * Persistence & Shutdown (Issue #129):
 * - On startup, the store materializes state from the persisted SQLite
 *   eventlog. Entity counts are logged to confirm successful restoration.
 * - On shutdown (SIGINT/SIGTERM), an explicit Effect.addFinalizer calls
 *   store.shutdown() which flushes pending writes, closes the client
 *   session, and releases SQLite database handles. The upstream
 *   @livestore/adapter-node also registers its own acquireRelease
 *   finalizers for db.close() — our explicit finalizer provides
 *   observable logging and ensures shutdown ordering is correct.
 * - Shutdown ordering: TerminalManager finalizer runs FIRST (commits
 *   final terminal status events), then LaborerStore finalizer runs
 *   (flushes and closes SQLite), then ServerLive tears down (stops HTTP).
 *
 * Sync: The server-side store connects to the sync backend (SyncRpcLive)
 * via WebSocket at `ws://localhost:PORT/rpc`, following the canonical
 * LiveStore "server-side client" pattern. This ensures events committed
 * by server services are propagated to all connected browser clients,
 * and vice versa. The `makeWsSync` client handles reconnection
 * automatically with a 1-second retry interval.
 *
 * Usage in other services:
 * ```ts
 * import { LaborerStore } from "./services/laborer-store.js"
 *
 * const program = Effect.gen(function* () {
 *   const { store } = yield* LaborerStore
 *   const allProjects = store.query(tables.projects)
 *   store.commit(events.projectCreated({ ... }))
 * })
 * ```
 *
 * Note: The @livestore/adapter-node import is deferred via dynamic import()
 * to avoid eagerly loading @effect/platform-node (a transitive peer dep of
 * @livestore/utils) which conflicts with our @effect/cluster version at
 * module resolution time. The dynamic import ensures the adapter is only
 * loaded when the Effect layer is constructed, not at module evaluation.
 *
 * @see Issue #129: Graceful shutdown — persist LiveStore state
 */

import { env } from "@laborer/env/server";
import { schema, tables } from "@laborer/shared/schema";
import { createStore, provideOtel } from "@livestore/livestore";
import { makeWsSync } from "@livestore/sync-cf/client";
import { Context, Effect, Layer } from "effect";

/**
 * Derive the concrete Store type from our schema so that consumers
 * get full type safety when calling `store.commit()` and `store.query()`.
 */
type LaborerSchema = typeof schema;

/**
 * LaborerStore Effect Context Tag
 *
 * Tagged service that wraps the LiveStore instance.
 * Consume via `yield* LaborerStore` in Effect.gen blocks.
 *
 * The service value is `{ store: Store<LaborerSchema> }`, giving
 * consumers type-safe access to commit events and query tables.
 */
class LaborerStore extends Context.Tag("LaborerStore")<
	LaborerStore,
	{
		readonly store: ReturnType<
			typeof createStore<LaborerSchema>
		> extends Effect.Effect<infer S, infer _E, infer _R>
			? S
			: never;
	}
>() {}

/**
 * Default data directory for SQLite persistence.
 * Database files are stored at `./data/<storeId>/`.
 */
const DATA_DIRECTORY = "./data";

/**
 * WebSocket URL for the server-side store to connect to its own sync
 * backend. Uses the same `/rpc` endpoint that browser clients connect to.
 * The `makeWsSync` client handles reconnection automatically, so the
 * store can start connecting before the HTTP server is fully ready.
 */
const syncUrl = `ws://localhost:${env.PORT}/rpc`;

/**
 * Log prefix for structured logging.
 */
const logPrefix = "[LaborerStore]";

/**
 * Effect that creates the LiveStore instance.
 *
 * Uses dynamic import for @livestore/adapter-node to avoid eager loading
 * of its transitive peer dependency tree (@effect/platform-node) which
 * would cause module resolution conflicts with our @effect/cluster version.
 *
 * Uses `createStore` from `@livestore/livestore` which returns an Effect
 * requiring `Scope` and `OtelTracer.OtelTracer`. We satisfy OtelTracer
 * via `provideOtel({})` which provides a no-op tracer (no OpenTelemetry
 * tracing configured in v1).
 *
 * The `batchUpdates` callback is a no-op identity function on the server
 * since there's no React batching needed. In browser contexts this would
 * be `ReactDOM.unstable_batchedUpdates`.
 *
 * Sync is configured via `makeWsSync` to connect to the server's own
 * sync backend at `ws://localhost:PORT/rpc`. This follows the canonical
 * LiveStore "server-side client" pattern where the server store is just
 * another sync participant alongside browser clients.
 *
 * On creation, logs entity counts restored from SQLite persistence.
 * On shutdown (scope close), logs the shutdown and calls store.shutdown()
 * to flush pending writes and close SQLite databases.
 *
 * @see Issue #129: Graceful shutdown — persist LiveStore state
 */
const makeStore = Effect.gen(function* () {
	const { makeAdapter } = yield* Effect.promise(
		() => import("@livestore/adapter-node")
	);

	const adapter = makeAdapter({
		storage: { type: "fs", baseDirectory: DATA_DIRECTORY },
		sync: {
			backend: makeWsSync({ url: syncUrl }),
			onSyncError: "ignore",
		},
	});

	const store = yield* createStore({
		adapter,
		schema,
		storeId: "laborer",
		batchUpdates: (run) => run(),
		disableDevtools: true,
	});

	// --- Startup: log restored entity counts from SQLite persistence ---
	// This confirms state was successfully restored from the previous session.
	const projectCount = store.query(tables.projects).length;
	const workspaceCount = store.query(tables.workspaces).length;
	const taskCount = store.query(tables.tasks).length;

	yield* Effect.logInfo(
		`${logPrefix} Store initialized — restored from SQLite: ` +
			`${projectCount} project(s), ${workspaceCount} workspace(s), ` +
			`${taskCount} task(s)`
	);

	// --- Shutdown finalizer: flush and close LiveStore (Issue #129) ---
	// The upstream @livestore/adapter-node also registers acquireRelease
	// finalizers for db.close(), but our explicit finalizer:
	// 1. Provides observable logging for shutdown diagnostics
	// 2. Calls store.shutdown() to flush pending writes and close the
	//    client session before the adapter's own finalizers run
	// 3. Logs final entity counts for post-mortem verification
	yield* Effect.addFinalizer(() =>
		Effect.gen(function* () {
			yield* Effect.logInfo(
				`${logPrefix} Shutdown: flushing LiveStore state to SQLite...`
			);

			// Log final entity counts before shutdown for post-mortem verification
			const finalProjects = store.query(tables.projects).length;
			const finalWorkspaces = store.query(tables.workspaces).length;
			const finalTasks = store.query(tables.tasks).length;

			yield* Effect.logInfo(
				`${logPrefix} Shutdown: final state — ` +
					`${finalProjects} project(s), ${finalWorkspaces} workspace(s), ` +
					`${finalTasks} task(s)`
			);

			// Call store.shutdown() to flush pending writes and close the
			// client session. This triggers LiveStore's internal cleanup:
			// - Flushes any pending event commits to SQLite
			// - Closes the client session (stops sync fibers)
			// - Closes the lifetimeScope (which cascades to adapter cleanup)
			yield* store.shutdown();

			yield* Effect.logInfo(
				`${logPrefix} Shutdown: LiveStore state persisted to SQLite successfully`
			);
		})
	);

	return { store };
}).pipe(provideOtel({}));

/**
 * LaborerStoreLive — Layer that provides the LaborerStore service.
 *
 * Creates the LiveStore on layer construction and tears it down
 * automatically when the layer's scope is closed (server shutdown).
 *
 * On shutdown (Issue #129):
 * 1. Effect.addFinalizer calls store.shutdown() which flushes pending
 *    writes and closes the LiveStore client session
 * 2. The upstream @livestore/adapter-node acquireRelease finalizers
 *    then close the SQLite databases (state DB + eventlog DB)
 * 3. Entity counts are logged before and after shutdown for diagnostics
 *
 * On startup:
 * - Entity counts are logged to confirm state was restored from SQLite
 */
const LaborerStoreLive: Layer.Layer<LaborerStore> = Layer.scoped(
	LaborerStore,
	makeStore
).pipe(Layer.orDie);

export { LaborerStore, LaborerStoreLive };
