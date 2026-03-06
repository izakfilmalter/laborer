/**
 * FileWatcher — Abstracted filesystem watcher backend
 *
 * Provides a platform-independent interface for subscribing to
 * filesystem changes. The default implementation uses Node.js
 * `fs.watch` (recursive where supported). The interface is designed
 * to be swappable with a more robust native backend (e.g.
 * @parcel/watcher) without changing the consuming services.
 *
 * Each subscription returns a handle that can be closed to release
 * the underlying watcher resources.
 *
 * @see PRD-opencode-inspired-repo-watching.md — Issue 3
 */

import { existsSync, type FSWatcher, watch } from "node:fs";
import { Context, Data, Effect, Layer } from "effect";

/**
 * Events emitted by the file watcher. Intentionally minimal —
 * downstream services interpret the signals, not the watcher.
 */
export interface WatchEvent {
	/** Name of the changed file/directory relative to the watched root, or null if unavailable */
	readonly fileName: string | null;
	/** The type of filesystem event reported by the backend */
	readonly type: "rename" | "change";
}

/**
 * A handle to an active watcher subscription.
 * Calling `close` releases all underlying resources.
 */
export interface WatchSubscription {
	readonly close: () => void;
}

class FileWatcherError extends Data.TaggedError("FileWatcherError")<{
	readonly message: string;
}> {}

/**
 * Callback invoked when the watched path emits a filesystem event.
 */
type WatchCallback = (event: WatchEvent) => void;

/**
 * Callback invoked when the watcher encounters an error.
 */
type WatchErrorCallback = (error: Error) => void;

class FileWatcher extends Context.Tag("@laborer/FileWatcher")<
	FileWatcher,
	{
		/**
		 * Subscribe to filesystem events for the given path.
		 * Returns a subscription handle or null if the path does not exist.
		 *
		 * @param path — Absolute path to watch
		 * @param onChange — Called on each filesystem event
		 * @param onError — Called when the underlying watcher fails
		 * @param options — Optional configuration (recursive watching)
		 */
		readonly subscribe: (
			path: string,
			onChange: WatchCallback,
			onError: WatchErrorCallback,
			options?: { readonly recursive?: boolean }
		) => Effect.Effect<WatchSubscription | null, FileWatcherError>;
	}
>() {
	/**
	 * Default implementation backed by Node.js `fs.watch`.
	 */
	static readonly layer = Layer.succeed(
		FileWatcher,
		FileWatcher.of({
			subscribe: (path, onChange, onError, options) =>
				Effect.gen(function* () {
					if (!existsSync(path)) {
						return null;
					}

					const watcher = yield* Effect.try({
						try: (): FSWatcher =>
							watch(
								path,
								{ recursive: options?.recursive ?? false },
								(eventType, fileName) => {
									onChange({
										type: eventType as "rename" | "change",
										fileName: fileName ?? null,
									});
								}
							),
						catch: (cause) =>
							new FileWatcherError({
								message: `Failed to watch ${path}: ${String(cause)}`,
							}),
					});

					watcher.on("error", (error: Error) => {
						onError(error);
					});

					return {
						close: () => {
							watcher.close();
						},
					} satisfies WatchSubscription;
				}),
		})
	);
}

export { FileWatcher, FileWatcherError };
