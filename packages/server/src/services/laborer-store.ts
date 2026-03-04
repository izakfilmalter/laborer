/**
 * LaborerStore — LiveStore server adapter as an Effect Service
 *
 * Initializes LiveStore with the @livestore/adapter-node adapter using
 * filesystem-backed SQLite persistence. The store is created as an Effect
 * Layer that provides the LiveStore context to all server services.
 *
 * The store persists events to `./data/<storeId>/` by default, ensuring
 * state survives server restarts. All 6 LiveStore tables (projects,
 * workspaces, terminals, diffs, tasks, panelLayout) are available for
 * querying and event commits.
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
 */

import { schema } from "@laborer/shared/schema";
import { createStore, provideOtel } from "@livestore/livestore";
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
 */
const makeStore = Effect.gen(function* () {
	const { makeAdapter } = yield* Effect.promise(
		() => import("@livestore/adapter-node")
	);

	const adapter = makeAdapter({
		storage: { type: "fs", baseDirectory: DATA_DIRECTORY },
	});

	const store = yield* createStore({
		adapter,
		schema,
		storeId: "laborer",
		batchUpdates: (run) => run(),
		disableDevtools: true,
	});

	return { store };
}).pipe(provideOtel({}));

/**
 * LaborerStoreLive — Layer that provides the LaborerStore service.
 *
 * Creates the LiveStore on layer construction and tears it down
 * automatically when the layer's scope is closed (server shutdown).
 * SQLite databases are flushed and closed on scope finalization.
 */
const LaborerStoreLive = Layer.scoped(LaborerStore, makeStore);

export { LaborerStore, LaborerStoreLive };
