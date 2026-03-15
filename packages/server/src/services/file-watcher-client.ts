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
 * - Subscribes to `watcher.events()` lazily for real-time file events
 * - Maintains a local in-memory event bus for server-side subscribers
 *   (DiffService, RepositoryWatchCoordinator)
 * - Provides `subscribe(path, ...)` that delegates to the file-watcher service
 * - Graceful handling of file-watcher service being temporarily unreachable
 *
 * Connection is established lazily on first RPC call, not during layer
 * construction. This allows the server to start and serve health checks
 * without waiting for the file-watcher sidecar to be running.
 *
 * @see PRD-file-watcher-extraction.md
 * @see Issue #16: Lazy sidecar connections
 */

import { FetchHttpClient } from '@effect/platform'
import { RpcClient, RpcSerialization } from '@effect/rpc'
import {
  FileWatcherRpcError,
  FileWatcherRpcs,
  type WatchFileEvent,
} from '@laborer/shared/rpc'
import { Context, Effect, Layer, Schedule, Scope, Stream } from 'effect'

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

/**
 * Creates the RPC client for the file-watcher sidecar with retry logic.
 * Extracted as a standalone function so the return type is properly inferred
 * and can be cached via a mutable closure variable.
 */
const createFileWatcherRpcClient = (url: string) =>
  RpcClient.make(FileWatcherRpcs).pipe(
    Effect.provide(
      RpcClient.layerProtocolHttp({ url }).pipe(
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(RpcSerialization.layerJson)
      )
    ),
    Effect.retry(
      Schedule.exponential('1 second').pipe(
        Schedule.union(Schedule.spaced('30 seconds')),
        Schedule.compose(Schedule.recurs(5))
      )
    )
  )

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
      // Capture the layer's scope so lazy connection can use it later.
      // The scope lives for the lifetime of this service layer.
      const layerScope = yield* Effect.scope

      // In-memory event handler list.
      // Mutations are synchronous and single-threaded.
      const handlers: FileEventHandler[] = []

      /**
       * Get or create the RPC client. On first call, establishes the
       * connection to the file-watcher sidecar and starts the event
       * stream subscription. Retries with exponential backoff if the
       * sidecar is not yet available.
       *
       * Uses Effect.cached to ensure only one fiber runs initialization,
       * preventing duplicate RPC connections and event stream subscriptions
       * when multiple fibers call getOrCreateClient concurrently.
       *
       * The captured layerScope is provided so the RPC client's lifecycle
       * is tied to the layer, and forkScoped for the event stream uses
       * the layer's scope for proper cleanup on shutdown.
       */
      const getOrCreateClient = yield* Effect.cached(
        Effect.gen(function* () {
          // Resolve port lazily to avoid import-time side effects
          const { env } = yield* Effect.promise(
            () => import('@laborer/env/server')
          )
          const fileWatcherServiceUrl = `http://localhost:${env.FILE_WATCHER_PORT}`

          const client = yield* createFileWatcherRpcClient(
            `${fileWatcherServiceUrl}/rpc`
          ).pipe(Effect.provideService(Scope.Scope, layerScope))

          yield* Effect.log(
            `Connected to file-watcher service at ${fileWatcherServiceUrl}`
          ).pipe(Effect.annotateLogs('module', logPrefix))

          // Start event stream subscription
          yield* client.watcher.events().pipe(
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
            Effect.provideService(Scope.Scope, layerScope),
            Effect.forkIn(layerScope)
          )

          return client
        })
      )

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
        Effect.gen(function* () {
          const client = yield* getOrCreateClient
          return yield* client.watcher
            .subscribe({
              path,
              recursive: options?.recursive,
              ignoreGlobs:
                options?.ignoreGlobs !== undefined
                  ? [...options.ignoreGlobs]
                  : undefined,
            })
            .pipe(Effect.mapError(mapError))
        }).pipe(Effect.catchAll((error) => Effect.fail(mapError(error))))

      const unsubscribe: FileWatcherClient['Type']['unsubscribe'] = (id) =>
        Effect.gen(function* () {
          const client = yield* getOrCreateClient
          return yield* client.watcher
            .unsubscribe({ id })
            .pipe(Effect.mapError(mapError))
        }).pipe(Effect.catchAll((error) => Effect.fail(mapError(error))))

      const updateIgnore: FileWatcherClient['Type']['updateIgnore'] = (
        id,
        ignoreGlobs
      ) =>
        Effect.gen(function* () {
          const client = yield* getOrCreateClient
          return yield* client.watcher
            .updateIgnore({ id, ignoreGlobs: [...ignoreGlobs] })
            .pipe(Effect.mapError(mapError))
        }).pipe(Effect.catchAll((error) => Effect.fail(mapError(error))))

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
        () =>
          Effect.gen(function* () {
            const client = yield* getOrCreateClient
            return yield* client.watcher.list().pipe(Effect.mapError(mapError))
          }).pipe(Effect.catchAll((error) => Effect.fail(mapError(error))))

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
