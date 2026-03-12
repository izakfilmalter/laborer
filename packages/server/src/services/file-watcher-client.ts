/**
 * FileWatcherClient — Effect Service
 *
 * RPC client connecting to the standalone file-watcher service at
 * `http://localhost:${FILE_WATCHER_PORT}`. This service replaces the
 * server's local FileWatcher and RepositoryEventBus by delegating
 * filesystem watching to the extracted file-watcher service.
 *
 * Responsibilities:
 * - RPC client for FileWatcherRpcs operations (subscribe, unsubscribe, list)
 * - Subscribes to `watcher.events()` on startup for real-time file events
 * - Maintains a local in-memory event bus for server-side subscribers
 *   (DiffService, RepositoryWatchCoordinator)
 * - Provides `subscribe(path, ...)` that delegates to the file-watcher service
 * - Graceful handling of file-watcher service being temporarily unreachable
 *
 * @see PRD-file-watcher-extraction.md
 */

import { FetchHttpClient } from '@effect/platform'
import { RpcClient, RpcSerialization } from '@effect/rpc'
import {
  FileWatcherRpcError,
  FileWatcherRpcs,
  type WatchFileEvent,
} from '@laborer/shared/rpc'
import { Context, Effect, Layer, Schedule, Stream } from 'effect'

/** Logger tag used for structured Effect.log output in this module. */
const logPrefix = 'FileWatcherClient'

/**
 * Callback for receiving file events from the file-watcher service.
 */
type FileEventHandler = (event: WatchFileEvent) => void

/**
 * A handle to an active event subscription on the client side.
 */
interface FileEventSubscription {
  readonly unsubscribe: () => void
}

class FileWatcherClient extends Context.Tag('@laborer/FileWatcherClient')<
  FileWatcherClient,
  {
    /**
     * Start watching a directory path via the file-watcher service.
     * Returns a subscription ID that can be used to unsubscribe later.
     */
    readonly subscribe: (
      path: string,
      options?: {
        readonly recursive?: boolean
        readonly ignoreGlobs?: readonly string[]
      }
    ) => Effect.Effect<
      {
        readonly id: string
        readonly ignoreGlobs: readonly string[]
        readonly path: string
        readonly recursive: boolean
      },
      FileWatcherRpcError
    >

    /**
     * Stop watching by subscription ID.
     */
    readonly unsubscribe: (
      id: string
    ) => Effect.Effect<void, FileWatcherRpcError>

    /**
     * Update ignore patterns for an active subscription.
     */
    readonly updateIgnore: (
      id: string,
      ignoreGlobs: readonly string[]
    ) => Effect.Effect<void, FileWatcherRpcError>

    /**
     * Subscribe to file events from the file-watcher service.
     * Returns a handle that can be used to unsubscribe.
     * Events are streamed in real-time from the file-watcher service.
     */
    readonly onFileEvent: (handler: FileEventHandler) => FileEventSubscription

    /**
     * List all active watch subscriptions.
     */
    readonly listSubscriptions: () => Effect.Effect<
      ReadonlyArray<{
        readonly id: string
        readonly ignoreGlobs: readonly string[]
        readonly path: string
        readonly recursive: boolean
      }>,
      FileWatcherRpcError
    >
  }
>() {
  static readonly layer = Layer.scoped(
    FileWatcherClient,
    Effect.gen(function* () {
      // Build the RPC client for the file-watcher service.
      const { env } = yield* Effect.promise(() => import('@laborer/env/server'))
      const fileWatcherServiceUrl = `http://localhost:${env.FILE_WATCHER_PORT}`

      const rpcClient = yield* RpcClient.make(FileWatcherRpcs).pipe(
        Effect.provide(
          RpcClient.layerProtocolHttp({
            url: `${fileWatcherServiceUrl}/rpc`,
          }).pipe(
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(RpcSerialization.layerJson)
          )
        )
      )

      // In-memory event handler list.
      // Mutations are synchronous and single-threaded.
      const handlers: FileEventHandler[] = []

      // Subscribe to file events from the file-watcher service.
      // This stream runs as a background daemon fiber for the lifetime
      // of this layer's scope. It distributes events to all registered
      // handlers.
      yield* rpcClient.watcher.events().pipe(
        Stream.tap((event) =>
          Effect.sync(() => {
            for (const handler of [...handlers]) {
              handler(event)
            }
          })
        ),
        Stream.runDrain,
        // Retry with exponential backoff if the file-watcher service disconnects
        Effect.retry(
          Schedule.exponential('1 second').pipe(
            Schedule.union(Schedule.spaced('30 seconds'))
          )
        ),
        Effect.catchAll((error) =>
          Effect.logWarning(
            `File watcher event stream ended: ${String(error)}`
          ).pipe(Effect.annotateLogs('module', logPrefix))
        ),
        Effect.forkScoped
      )

      yield* Effect.log(
        `Connected to file-watcher service at ${fileWatcherServiceUrl}`
      ).pipe(Effect.annotateLogs('module', logPrefix))
      /**
       * Map any RPC transport error to a FileWatcherRpcError for
       * consistent error types across the client interface.
       */
      const mapError = (error: unknown): FileWatcherRpcError =>
        error instanceof FileWatcherRpcError
          ? error
          : new FileWatcherRpcError({
              message: error instanceof Error ? error.message : String(error),
              code: 'INTERNAL_ERROR',
            })

      const subscribe: FileWatcherClient['Type']['subscribe'] = (
        path,
        options
      ) =>
        rpcClient.watcher
          .subscribe({
            path,
            recursive: options?.recursive,
            ignoreGlobs:
              options?.ignoreGlobs !== undefined
                ? [...options.ignoreGlobs]
                : undefined,
          })
          .pipe(Effect.mapError(mapError))

      const unsubscribe: FileWatcherClient['Type']['unsubscribe'] = (id) =>
        rpcClient.watcher.unsubscribe({ id }).pipe(Effect.mapError(mapError))

      const updateIgnore: FileWatcherClient['Type']['updateIgnore'] = (
        id,
        ignoreGlobs
      ) =>
        rpcClient.watcher
          .updateIgnore({ id, ignoreGlobs: [...ignoreGlobs] })
          .pipe(Effect.mapError(mapError))

      const onFileEvent = (
        handler: FileEventHandler
      ): FileEventSubscription => {
        handlers.push(handler)
        return {
          unsubscribe: () => {
            const idx = handlers.indexOf(handler)
            if (idx !== -1) {
              handlers.splice(idx, 1)
            }
          },
        }
      }

      const listSubscriptions: FileWatcherClient['Type']['listSubscriptions'] =
        () => rpcClient.watcher.list().pipe(Effect.mapError(mapError))

      yield* Effect.addFinalizer(() =>
        Effect.log('Shutdown: disconnecting from file-watcher service').pipe(
          Effect.annotateLogs('module', logPrefix)
        )
      )

      return FileWatcherClient.of({
        subscribe,
        unsubscribe,
        updateIgnore,
        onFileEvent,
        listSubscriptions,
      })
    })
  )
}

export { FileWatcherClient, type FileEventHandler, type FileEventSubscription }
