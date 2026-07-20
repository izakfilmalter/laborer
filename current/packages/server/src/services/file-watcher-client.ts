/**
 * FileWatcherClient — Effect Service
 *
 * RPC client connecting to the file-watcher utility process via a direct
 * MessagePort brokered by the Electron main process for zero-copy IPC.
 *
 * Requires a `FileWatcherRpcPort` service tag in the layer context,
 * provided by the server's utility-main.ts when the main process
 * brokers a server-to-file-watcher MessagePort.
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
 * @see PRD-file-watcher-extraction.md
 * @see Issue #14: File-watcher as utility process
 * @see Issue #20: Build script update + port reservation removal
 */

import { NodeSocket } from '@effect/platform-node'
import { RpcClient, RpcSerialization } from '@effect/rpc'
import {
  FileWatcherRpcError,
  FileWatcherRpcs,
  type WatchFileEvent,
} from '@laborer/shared/rpc'
import type { RpcMessagePort } from '@laborer/shared/rpc-transport-messageport'
import { Context, Effect, Layer, Option, Scope, Stream } from 'effect'
import {
  createMessagePortRpcClient,
  sidecarEventStreamSchedule,
} from './sidecar-rpc.js'

/** Logger tag used for structured Effect.log output in this module. */
const logPrefix = 'FileWatcherClient'
const fileWatcherRpcUrl = process.env.LABORER_FILE_WATCHER_RPC_URL ?? null

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
 * Service tag providing a MessagePort for direct RPC to the
 * file-watcher utility process. Required for `FileWatcherClient` to
 * communicate with the file-watcher service.
 *
 * Provided by the server's utility-main.ts when the main process
 * brokers a server-to-file-watcher MessagePort.
 *
 * @see Issue #14: File-watcher as utility process
 */
class FileWatcherRpcPort extends Context.Tag('@laborer/FileWatcherRpcPort')<
  FileWatcherRpcPort,
  { readonly awaitPort: Effect.Effect<RpcMessagePort> }
>() {}

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

      // Check if a MessagePort for the file-watcher is available (utility
      // process mode). When running as an Electron utility process, the
      // main process brokers a direct MessagePort between the server and
      // file-watcher processes.
      const fileWatcherRpcPort = yield* Effect.serviceOption(FileWatcherRpcPort)

      /**
       * Get or create the RPC client. On first call, establishes the
       * connection to the file-watcher utility process via MessagePort
       * and starts the event stream subscription.
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
          const client = yield* (() => {
            if (Option.isSome(fileWatcherRpcPort)) {
              return Effect.gen(function* () {
                const port = yield* fileWatcherRpcPort.value.awaitPort
                return yield* createMessagePortRpcClient(
                  FileWatcherRpcs,
                  port,
                  layerScope
                )
              })
            }

            if (fileWatcherRpcUrl) {
              return Effect.gen(function* () {
                const socketLayer = NodeSocket.layerWebSocket(fileWatcherRpcUrl)
                const context = yield* Layer.build(
                  RpcClient.layerProtocolSocket({
                    retryTransientErrors: true,
                  }).pipe(
                    Layer.provide(
                      Layer.mergeAll(socketLayer, RpcSerialization.layerJson)
                    )
                  )
                )
                return yield* RpcClient.make(FileWatcherRpcs).pipe(
                  Effect.provide(context)
                )
              })
            }

            return Effect.die(
              'FileWatcherRpcPort is not available and LABORER_FILE_WATCHER_RPC_URL is unset — cannot connect to file-watcher service'
            )
          })()

          yield* Effect.log('RPC client created — subscribing to events').pipe(
            Effect.annotateLogs('module', logPrefix)
          )

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
            Effect.retry(sidecarEventStreamSchedule),
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

      const provideLayerScope = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(Effect.provideService(Scope.Scope, layerScope))

      const subscribe: FileWatcherClient['Type']['subscribe'] = (
        path,
        options
      ) =>
        Effect.gen(function* () {
          const client = yield* provideLayerScope(getOrCreateClient)
          return yield* provideLayerScope(
            client.watcher
              .subscribe({
                path,
                recursive: options?.recursive,
                ignoreGlobs:
                  options?.ignoreGlobs !== undefined
                    ? [...options.ignoreGlobs]
                    : undefined,
              })
              .pipe(Effect.mapError(mapError))
          )
        }).pipe(Effect.mapError(mapError))

      const unsubscribe: FileWatcherClient['Type']['unsubscribe'] = (id) =>
        Effect.gen(function* () {
          const client = yield* provideLayerScope(getOrCreateClient)
          return yield* provideLayerScope(
            client.watcher.unsubscribe({ id }).pipe(Effect.mapError(mapError))
          )
        }).pipe(Effect.mapError(mapError))

      const updateIgnore: FileWatcherClient['Type']['updateIgnore'] = (
        id,
        ignoreGlobs
      ) =>
        Effect.gen(function* () {
          const client = yield* provideLayerScope(getOrCreateClient)
          return yield* provideLayerScope(
            client.watcher
              .updateIgnore({ id, ignoreGlobs: [...ignoreGlobs] })
              .pipe(Effect.mapError(mapError))
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

      const listSubscriptions: FileWatcherClient['Type']['listSubscriptions'] =
        () =>
          Effect.gen(function* () {
            const client = yield* provideLayerScope(getOrCreateClient)
            return yield* provideLayerScope(
              client.watcher.list().pipe(Effect.mapError(mapError))
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
}

export {
  FileWatcherClient,
  type FileEventHandler,
  type FileEventSubscription,
  FileWatcherRpcPort,
}
