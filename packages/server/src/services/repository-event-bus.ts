/**
 * RepositoryEventBus — Effect Service for normalized repo file events
 *
 * Publishes normalized add/change/delete events from repository file
 * watching. Downstream services subscribe through this bus rather than
 * owning their own watchers, which prevents duplicate watcher setups
 * and keeps the event model stable regardless of the underlying
 * watcher backend.
 *
 * Events are normalized: platform-specific watcher payloads are
 * translated into a stable `RepositoryFileEvent` shape before
 * publishing. The bus also applies centralized ignore rules so that
 * git internals, dependency folders, and build output never reach
 * downstream consumers.
 *
 * @see PRD-opencode-inspired-repo-watching.md — Issue 5
 */

import { relative } from "node:path";
import { Context, Data, Effect, Layer } from "effect";

// ── Event Model ─────────────────────────────────────────────────

/**
 * The type of file change observed in the repository.
 *
 * - "add"    — a new file or directory was created
 * - "change" — an existing file was modified
 * - "delete" — a file or directory was removed
 *
 * Note: the underlying `fs.watch` backend reports "rename" for both
 * add and delete. The coordinator maps these to the appropriate type
 * using existence checks where feasible, but consumers should treat
 * "add" and "delete" as best-effort classifications. The system is
 * eventually consistent — missed classifications are corrected by
 * subsequent events.
 */
type RepositoryFileEventType = "add" | "change" | "delete";

/**
 * A normalized repository file event. This is the stable shape that
 * downstream consumers receive regardless of the underlying watcher
 * backend.
 */
interface RepositoryFileEvent {
	/** The absolute path of the changed file */
	readonly absolutePath: string;
	/** The project this event belongs to */
	readonly projectId: string;
	/** The path of the changed file relative to the repository root */
	readonly relativePath: string;
	/** The canonical repository root this event originated from */
	readonly repoRoot: string;
	/** The type of change */
	readonly type: RepositoryFileEventType;
}

/**
 * Callback for receiving repository file events.
 */
type RepositoryFileEventHandler = (event: RepositoryFileEvent) => void;

/**
 * A handle to an active event bus subscription.
 * Calling `unsubscribe` removes the handler from the bus.
 */
interface EventBusSubscription {
	readonly unsubscribe: () => void;
}

// ── Ignore Rules ────────────────────────────────────────────────

/**
 * Default directory and file patterns to ignore. These suppress
 * events from noisy directories that would flood downstream services
 * with irrelevant refresh work.
 *
 * The ignore model is prefix-based: any relative path whose first
 * segment matches an entry is suppressed.
 */
const DEFAULT_IGNORED_PREFIXES: readonly string[] = [
	// Git internals
	".git",
	// Dependencies
	"node_modules",
	// Build output
	"dist",
	"build",
	"out",
	".next",
	".nuxt",
	".svelte-kit",
	".turbo",
	// Package manager caches
	".yarn",
	".pnpm-store",
	// IDE / editor
	".idea",
	".vscode",
	// OS metadata
	".DS_Store",
	"Thumbs.db",
	// Coverage / test artifacts
	"coverage",
	".nyc_output",
];

/**
 * Determine whether a relative path should be ignored based on
 * prefix matching against the ignore list.
 */
const shouldIgnore = (
	relativePath: string,
	ignoredPrefixes: readonly string[]
): boolean => {
	if (relativePath === "") {
		return true;
	}
	// Extract the first path segment for prefix matching
	const firstSegment = relativePath.split("/")[0] ?? relativePath;
	return ignoredPrefixes.some(
		(prefix) => firstSegment === prefix || relativePath === prefix
	);
};

// ── Error ───────────────────────────────────────────────────────

class RepositoryEventBusError extends Data.TaggedError(
	"RepositoryEventBusError"
)<{
	readonly message: string;
}> {}

// ── Service ─────────────────────────────────────────────────────

class RepositoryEventBus extends Context.Tag("@laborer/RepositoryEventBus")<
	RepositoryEventBus,
	{
		/**
		 * Subscribe to repository file events. Returns a handle that
		 * can be used to unsubscribe.
		 */
		readonly subscribe: (
			handler: RepositoryFileEventHandler
		) => Effect.Effect<EventBusSubscription>;

		/**
		 * Publish a raw watcher event. The bus normalizes the event,
		 * applies ignore rules, and fans out to all subscribers.
		 *
		 * This is called by the RepositoryWatchCoordinator — not by
		 * downstream consumers.
		 */
		readonly publish: (event: RepositoryFileEvent) => Effect.Effect<void>;

		/**
		 * Create a normalized event from a raw watcher signal.
		 * Applies ignore rules and returns null if the event should
		 * be suppressed.
		 */
		readonly normalizeEvent: (params: {
			readonly type: RepositoryFileEventType;
			readonly fileName: string | null;
			readonly repoRoot: string;
			readonly projectId: string;
		}) => RepositoryFileEvent | null;
	}
>() {
	static readonly layer = Layer.effect(
		RepositoryEventBus,
		Effect.sync(() => {
			// Mutable handler list. Mutations are synchronous and
			// single-threaded so no fiber coordination is needed.
			// This avoids Effect.runSync in the synchronous
			// unsubscribe callback.
			const handlers: RepositoryFileEventHandler[] = [];
			const ignoredPrefixes = DEFAULT_IGNORED_PREFIXES;

			const subscribe = (
				handler: RepositoryFileEventHandler
			): Effect.Effect<EventBusSubscription> =>
				Effect.sync(() => {
					handlers.push(handler);

					return {
						unsubscribe: () => {
							const idx = handlers.indexOf(handler);
							if (idx !== -1) {
								handlers.splice(idx, 1);
							}
						},
					} satisfies EventBusSubscription;
				});

			const publish = (event: RepositoryFileEvent): Effect.Effect<void> =>
				Effect.sync(() => {
					for (const handler of [...handlers]) {
						handler(event);
					}
				});

			const normalizeEvent = (params: {
				readonly type: RepositoryFileEventType;
				readonly fileName: string | null;
				readonly repoRoot: string;
				readonly projectId: string;
			}): RepositoryFileEvent | null => {
				const { type, fileName, repoRoot, projectId } = params;

				if (fileName === null) {
					return null;
				}

				// Normalize the relative path (watcher may return OS-specific separators)
				const relativePath = relative(repoRoot, `${repoRoot}/${fileName}`);

				if (shouldIgnore(relativePath, ignoredPrefixes)) {
					return null;
				}

				return {
					type,
					relativePath,
					absolutePath: `${repoRoot}/${fileName}`,
					projectId,
					repoRoot,
				};
			};

			return RepositoryEventBus.of({
				subscribe,
				publish,
				normalizeEvent,
			});
		})
	);
}

export {
	type EventBusSubscription,
	RepositoryEventBus,
	RepositoryEventBusError,
	type RepositoryFileEvent,
	type RepositoryFileEventHandler,
	type RepositoryFileEventType,
	shouldIgnore,
	DEFAULT_IGNORED_PREFIXES,
};
