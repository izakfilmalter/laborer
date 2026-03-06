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
import { relative } from "node:path";
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

interface FileWatcherSubscribeOptions {
	/**
	 * Glob patterns to pass to the native watcher backend for
	 * early suppression of noisy directories. The fs.watch fallback
	 * ignores this option — filtering happens downstream.
	 */
	readonly ignore?: readonly string[];
	readonly recursive?: boolean;
}

interface FileWatcherService {
	readonly subscribe: (
		path: string,
		onChange: WatchCallback,
		onError: WatchErrorCallback,
		options?: FileWatcherSubscribeOptions
	) => Effect.Effect<WatchSubscription | null, FileWatcherError>;
}

interface FileWatcherDrivers {
	readonly fs: (
		path: string,
		onChange: WatchCallback,
		onError: WatchErrorCallback,
		options?: FileWatcherSubscribeOptions
	) => Effect.Effect<WatchSubscription | null, FileWatcherError>;
	readonly native: (
		path: string,
		onChange: WatchCallback,
		onError: WatchErrorCallback,
		options?: FileWatcherSubscribeOptions
	) => Effect.Effect<WatchSubscription | null, FileWatcherError>;
}

type FileWatcherBackendName = "fs" | "native";

type ParcelWatcherModule = typeof import("@parcel/watcher");

const DEFAULT_FILE_WATCHER_BACKEND: FileWatcherBackendName = "native";

const resolveFileWatcherBackendPreference = (): FileWatcherBackendName =>
	process.env.LABORER_FILE_WATCHER_BACKEND === "fs"
		? "fs"
		: DEFAULT_FILE_WATCHER_BACKEND;

const normalizeRelativeFileName = (
	watchPath: string,
	changedPath: string
): string | null => {
	const relativePath = relative(watchPath, changedPath).replaceAll("\\", "/");
	return relativePath === "" ? null : relativePath;
};

const subscribeWithFsWatch = (
	path: string,
	onChange: WatchCallback,
	onError: WatchErrorCallback,
	options?: FileWatcherSubscribeOptions
): Effect.Effect<WatchSubscription | null, FileWatcherError> =>
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
					message: `Failed to watch ${path} with fs backend: ${String(cause)}`,
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
	});

const subscribeWithNativeWatcher = (
	path: string,
	onChange: WatchCallback,
	onError: WatchErrorCallback,
	options?: FileWatcherSubscribeOptions
): Effect.Effect<WatchSubscription | null, FileWatcherError> =>
	Effect.gen(function* () {
		if (!existsSync(path)) {
			return null;
		}

		const parcelWatcher = yield* Effect.tryPromise({
			try: async () => {
				const imported = await import("@parcel/watcher");
				return (imported.default ?? imported) as ParcelWatcherModule;
			},
			catch: (cause) =>
				new FileWatcherError({
					message: `Failed to load native watcher backend: ${String(cause)}`,
				}),
		});

		const subscribeOptions: { ignore?: string[] } = {};
		if (options?.ignore !== undefined && options.ignore.length > 0) {
			subscribeOptions.ignore = [...options.ignore];
		}

		const subscription = yield* Effect.tryPromise({
			try: () =>
				parcelWatcher.subscribe(
					path,
					(error, events) => {
						if (error !== null) {
							onError(error);
							return;
						}

						for (const event of events) {
							onChange({
								type: event.type === "update" ? "change" : "rename",
								fileName: normalizeRelativeFileName(path, event.path),
							});
						}
					},
					subscribeOptions
				),
			catch: (cause) =>
				new FileWatcherError({
					message: `Failed to watch ${path} with native backend: ${String(cause)}`,
				}),
		});

		return {
			close: () => {
				subscription.unsubscribe().catch(onError);
			},
		} satisfies WatchSubscription;
	});
const defaultFileWatcherDrivers: FileWatcherDrivers = {
	fs: subscribeWithFsWatch,
	native: subscribeWithNativeWatcher,
};

function makeFileWatcher(
	preferredBackend: FileWatcherBackendName,
	drivers: FileWatcherDrivers = defaultFileWatcherDrivers
) {
	return {
		subscribe: (path, onChange, onError, options) =>
			preferredBackend === "fs"
				? drivers.fs(path, onChange, onError, options)
				: drivers
						.native(path, onChange, onError, options)
						.pipe(
							Effect.catchAll((error) =>
								Effect.logWarning(
									`Native file watcher unavailable for ${path}; falling back to fs.watch. ${error.message}`
								).pipe(
									Effect.zipRight(drivers.fs(path, onChange, onError, options))
								)
							)
						),
	} satisfies FileWatcherService;
}

class FileWatcher extends Context.Tag("@laborer/FileWatcher")<
	FileWatcher,
	FileWatcherService
>() {
	/**
	 * Default implementation backed by Node.js `fs.watch`.
	 */
	static readonly layer = Layer.succeed(
		FileWatcher,
		makeFileWatcher(resolveFileWatcherBackendPreference())
	);
}

export {
	DEFAULT_FILE_WATCHER_BACKEND,
	FileWatcher,
	FileWatcherError,
	type FileWatcherBackendName,
	type FileWatcherDrivers,
	type FileWatcherSubscribeOptions,
	makeFileWatcher,
	resolveFileWatcherBackendPreference,
};
