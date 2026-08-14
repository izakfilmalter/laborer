/**
 * FileWatcherClient — Effect Service
 *
 * In-process adapter from server workflows to the daemon-owned watcher
 * manager. Browser clients reach the daemon through typed WebSocket RPC.
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
 * without waiting for the file-watcher utility process to be ready.
 *
 * @see Issue #14: File-watcher as utility process
 * @see Issue #20: Build script update + port reservation removal
 */

import { WatcherManager } from '@laborer/file-watcher/services/watcher-manager'
import { FileWatcherRpcError, type WatchFileEvent } from '@laborer/shared/rpc'
import { Context, Effect, Layer, Scope, Stream } from 'effect'

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

/** Selects direct manager calls for the standalone daemon composition. */
class InProcessFileWatcherBackend extends Context.Service<
  InProcessFileWatcherBackend,
  { readonly manager: WatcherManager['Service'] }
>()('@laborer/InProcessFileWatcherBackend') {
  static readonly layer = Layer.effect(
    InProcessFileWatcherBackend,
    Effect.map(WatcherManager, (manager) =>
      InProcessFileWatcherBackend.of({ manager })
    )
  )
}

class FileWatcherClient extends Context.Service<
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
>()('@laborer/FileWatcherClient') {
  static readonly layer = Layer.effect(
    FileWatcherClient,
    Effect.gen(function* () {
      // Capture the layer's scope so lazy connection can use it later.
      // The scope lives for the lifetime of this service layer.
      const layerScope = yield* Effect.scope

      // In-memory event handler list.
      // Mutations are synchronous and single-threaded.
      const handlers: FileEventHandler[] = []

      const inProcessBackend = yield* InProcessFileWatcherBackend

      /**
       * Get or create the RPC client. On first call, establishes the
       * direct connection to the daemon-owned watcher manager and starts the
       * event stream subscription.
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
          const manager = inProcessBackend.manager
          const client = yield* Effect.succeed({
            'watcher.events': () => Stream.fromPubSub(manager.fileEvents),
            'watcher.list': () => manager.list(),
            'watcher.subscribe': (input: {
              readonly ignoreGlobs?: readonly string[] | undefined
              readonly path: string
              readonly recursive?: boolean | undefined
            }) =>
              manager.subscribe(input.path, input.recursive, input.ignoreGlobs),
            'watcher.unsubscribe': ({ id }: { readonly id: string }) =>
              manager.unsubscribe(id),
            'watcher.updateIgnore': ({
              id,
              ignoreGlobs,
            }: {
              readonly id: string
              readonly ignoreGlobs: readonly string[]
            }) => manager.updateIgnore(id, ignoreGlobs),
          })

          yield* Effect.log('RPC client created — subscribing to events').pipe(
            Effect.annotateLogs('module', logPrefix)
          )

          // Start event stream subscription
          yield* client['watcher.events']().pipe(
            Stream.tap((event) =>
              Effect.sync(() => {
                for (const handler of [...handlers]) {
                  handler(event)
                }
              })
            ),
            Stream.runDrain,
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

      const provideLayerScope = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(Effect.provideService(Scope.Scope, layerScope))

      const subscribe: FileWatcherClient['Service']['subscribe'] = (
        path,
        options
      ) =>
        Effect.gen(function* () {
          const client = yield* provideLayerScope(getOrCreateClient)
          return yield* provideLayerScope(
            client['watcher.subscribe']({
              path,
              recursive: options?.recursive,
              ignoreGlobs:
                options?.ignoreGlobs !== undefined
                  ? [...options.ignoreGlobs]
                  : undefined,
            }).pipe(Effect.mapError(mapError))
          )
        }).pipe(Effect.mapError(mapError))

      const unsubscribe: FileWatcherClient['Service']['unsubscribe'] = (id) =>
        Effect.gen(function* () {
          const client = yield* provideLayerScope(getOrCreateClient)
          return yield* provideLayerScope(
            client['watcher.unsubscribe']({ id }).pipe(
              Effect.mapError(mapError)
            )
          )
        }).pipe(Effect.mapError(mapError))

      const updateIgnore: FileWatcherClient['Service']['updateIgnore'] = (
        id,
        ignoreGlobs
      ) =>
        Effect.gen(function* () {
          const client = yield* provideLayerScope(getOrCreateClient)
          return yield* provideLayerScope(
            client['watcher.updateIgnore']({
              id,
              ignoreGlobs: [...ignoreGlobs],
            }).pipe(Effect.mapError(mapError))
          )
        }).pipe(Effect.mapError(mapError))

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

      const listSubscriptions: FileWatcherClient['Service']['listSubscriptions'] =
        () =>
          Effect.gen(function* () {
            const client = yield* provideLayerScope(getOrCreateClient)
            return yield* provideLayerScope(
              client['watcher.list']().pipe(Effect.mapError(mapError))
            )
          }).pipe(Effect.mapError(mapError))

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

  static readonly inProcessLayer = FileWatcherClient.layer.pipe(
    Layer.provide(InProcessFileWatcherBackend.layer)
  )
}

export { FileWatcherClient, type FileEventHandler, type FileEventSubscription }
