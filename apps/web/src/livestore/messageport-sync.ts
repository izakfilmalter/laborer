/**
 * MessagePort-based LiveStore sync adapter.
 *
 * Provides a sync backend constructor that speaks the `SyncWsRpc` protocol
 * (Pull/Push) over a `MessagePort` instead of WebSocket. Used when running
 * inside Electron — the renderer acquires a dedicated sync MessagePort from
 * the server utility process and passes it to the LiveStore worker.
 *
 * This adapter reuses the same `SyncWsRpc` RPC group as the WebSocket
 * adapter (`makeWsSync`), so the server-side sync backend (`sync-backend.ts`)
 * serves both transports with identical handlers.
 *
 * The returned object conforms to LiveStore's `SyncBackend` shape (duck-typed)
 * since we cannot import `@livestore/common` types directly in the web bundle.
 *
 * @see packages/server/src/services/sync-backend.ts — server-side sync
 * @see @livestore/sync-cf/client — WebSocket reference implementation
 * @see Issue #11: LiveStore sync over MessagePort
 */

import { Rpc, RpcClient, RpcGroup } from '@effect/rpc'
import type { RpcMessagePort } from '@laborer/shared/rpc-transport-messageport'
import { makeClientProtocolMessagePort } from '@laborer/shared/rpc-transport-messageport-client'
import { Effect, Layer, Option, Schema, Stream, SubscriptionRef } from 'effect'

// ---------------------------------------------------------------------------
// SyncWsRpc schema — mirrors the server's sync-backend.ts definitions
// ---------------------------------------------------------------------------

const BackendId = Schema.String

const SyncMetadata = Schema.TaggedStruct('SyncMessage.SyncMetadata', {
  createdAt: Schema.String,
})

const EventEncoded = Schema.Struct({
  name: Schema.String,
  args: Schema.Any,
  seqNum: Schema.Number,
  parentSeqNum: Schema.Number,
  clientId: Schema.String,
  sessionId: Schema.String,
})

const PullResPageInfo = Schema.Union(
  Schema.TaggedStruct('MoreUnknown', {}),
  Schema.TaggedStruct('MoreKnown', {
    remaining: Schema.Number,
  }),
  Schema.TaggedStruct('NoMore', {})
)

const PullResponse = Schema.Struct({
  batch: Schema.Array(
    Schema.Struct({
      eventEncoded: EventEncoded,
      metadata: Schema.Option(SyncMetadata),
    })
  ),
  pageInfo: PullResPageInfo,
  backendId: BackendId,
})

type PullResponseType = typeof PullResponse.Type

const PushAck = Schema.Struct({})

class InvalidPullError extends Schema.TaggedError<InvalidPullError>()(
  'InvalidPullError',
  { cause: Schema.Unknown }
) {}

class InvalidPushError extends Schema.TaggedError<InvalidPushError>()(
  'InvalidPushError',
  { cause: Schema.Unknown }
) {}

const PullPayload = Schema.Struct({
  storeId: Schema.String,
  payload: Schema.optional(Schema.Unknown),
  live: Schema.Boolean,
  cursor: Schema.Option(
    Schema.Struct({
      backendId: BackendId,
      eventSequenceNumber: Schema.Number,
    })
  ),
})

const PushPayload = Schema.Struct({
  storeId: Schema.String,
  payload: Schema.optional(Schema.Unknown),
  batch: Schema.Array(EventEncoded),
  backendId: Schema.Option(BackendId),
})

/**
 * RPC group matching the server's SyncWsRpc protocol.
 * Tag names must match exactly for RPC routing.
 */
class SyncWsRpc extends RpcGroup.make(
  Rpc.make('SyncWsRpc.Pull', {
    payload: PullPayload,
    success: PullResponse,
    error: InvalidPullError,
    stream: true,
  }),
  Rpc.make('SyncWsRpc.Push', {
    payload: PushPayload,
    success: PushAck,
    error: InvalidPushError,
  })
) {}

// ---------------------------------------------------------------------------
// RPC client type
// ---------------------------------------------------------------------------

/**
 * Helper to extract the client type from `RpcClient.make(SyncWsRpc)`.
 * The client object has methods keyed by RPC tag names (e.g. `SyncWsRpc.Pull`).
 */
const MakeSyncClient = RpcClient.make(SyncWsRpc)
type SyncRpcClient = Effect.Effect.Success<typeof MakeSyncClient>

// ---------------------------------------------------------------------------
// makeMessagePortSync — the adapter factory
// ---------------------------------------------------------------------------

/**
 * Creates a LiveStore sync backend that communicates over a MessagePort
 * using the `SyncWsRpc` Effect RPC protocol.
 *
 * The MessagePort is connected to the server utility process which serves
 * `SyncWsRpc.Pull` and `SyncWsRpc.Push` handlers via
 * `layerProtocolMessagePort()`.
 *
 * Returns a `SyncBackendConstructor`-compatible function. The returned
 * object is duck-typed to match LiveStore's `SyncBackend` interface.
 *
 * @param port - A MessagePort connected to the server's sync channel.
 */
export const makeMessagePortSync =
  (port: RpcMessagePort) =>
  ({ storeId }: { storeId: string; clientId: string; payload: unknown }) =>
    Effect.gen(function* () {
      const isConnected = yield* SubscriptionRef.make(false)

      // Build the RPC client protocol layer over the MessagePort.
      const ProtocolLive = Layer.scoped(
        RpcClient.Protocol,
        makeClientProtocolMessagePort(port)
      )

      // Build the layer eagerly to tie it to the enclosing scope.
      const ctx = yield* Layer.build(ProtocolLive)
      const rpcClient: SyncRpcClient = yield* MakeSyncClient.pipe(
        Effect.provide(ctx)
      )

      // Track the backend ID across pull responses for push requests.
      let currentBackendId: Option.Option<string> = Option.none()

      // Effect RPC client objects use nested namespaces for dotted tag
      // names. For `SyncWsRpc.Pull` the runtime structure is:
      //   { SyncWsRpc: { Pull: fn, Push: fn } }
      // We cast through `unknown` because TypeScript resolves the mapped
      // types to `never` for input parameters on prefixed RPC methods.
      const typedClient = rpcClient as unknown as {
        SyncWsRpc: {
          Pull: (
            args: typeof PullPayload.Type
          ) => Stream.Stream<PullResponseType, InvalidPullError>
          Push: (
            args: typeof PushPayload.Type
          ) => Effect.Effect<typeof PushAck.Type, InvalidPushError>
        }
      }

      const pullRpc = typedClient.SyncWsRpc.Pull
      const pushRpc = typedClient.SyncWsRpc.Push

      const ping = Effect.gen(function* () {
        console.log('[messageport-sync] ping: issuing non-live pull')
        // Ping by issuing a non-live pull with no cursor — if it succeeds,
        // the connection is healthy.
        const stream = pullRpc({
          storeId,
          live: false,
          cursor: Option.none(),
        })
        // Take the first response to confirm connectivity.
        yield* Stream.runHead(stream)
        console.log('[messageport-sync] ping: success, marking connected')
        yield* SubscriptionRef.set(isConnected, true)
      }).pipe(
        Effect.catchAll((err) => {
          console.error('[messageport-sync] ping: FAILED', err)
          return SubscriptionRef.set(isConnected, false)
        }),
        Effect.asVoid
      )

      return {
        isConnected,
        connect: ping,

        pull: (
          cursor: Option.Option<{
            eventSequenceNumber: number
            metadata: Option.Option<unknown>
          }>,
          options?: { live?: boolean }
        ) => {
          const isLive = options?.live === true
          // If we have a cursor but no backendId yet (e.g. resumed session
          // before the first pull/ping response), drop the cursor entirely.
          // A cursor without a valid backendId would cause a Backend ID
          // mismatch error on the server.
          const rpcCursor = Option.flatMap(cursor, (c) =>
            Option.map(currentBackendId, (backendId) => ({
              eventSequenceNumber: c.eventSequenceNumber,
              backendId,
            }))
          )

          console.log(
            `[messageport-sync] pull called: live=${String(isLive)} cursor=${cursor._tag === 'Some' ? String(cursor.value.eventSequenceNumber) : 'None'} backendId=${Option.getOrElse(currentBackendId, () => 'None')}`
          )

          let chunkCount = 0

          return pullRpc({
            storeId,
            live: isLive,
            cursor: rpcCursor,
          }).pipe(
            Stream.tap((res) =>
              Effect.sync(() => {
                chunkCount++
                currentBackendId = Option.some(res.backendId)
                console.log(
                  `[messageport-sync] pull chunk #${String(chunkCount)}: live=${String(isLive)} batchLen=${String(res.batch.length)} pageInfo=${res.pageInfo._tag}`
                )
              })
            ),
            Stream.map((res) => ({
              batch: res.batch,
              pageInfo: res.pageInfo,
            })),
            Stream.tapError((err) =>
              Effect.sync(() =>
                console.error(
                  `[messageport-sync] pull stream ERROR: live=${String(isLive)}`,
                  err
                )
              )
            ),
            Stream.ensuring(
              Effect.sync(() =>
                console.log(
                  `[messageport-sync] pull stream FINALIZED: live=${String(isLive)} totalChunks=${String(chunkCount)}`
                )
              )
            )
          )
        },

        push: (batch: readonly Record<string, unknown>[]) =>
          Effect.gen(function* () {
            if (batch.length === 0) {
              return
            }

            console.log(
              `[messageport-sync] push: batchLen=${String(batch.length)}`
            )

            yield* pushRpc({
              storeId,
              batch: batch as readonly (typeof EventEncoded.Type)[],
              backendId: currentBackendId,
            })
          }).pipe(Effect.asVoid),

        ping,

        metadata: {
          name: '@laborer/messageport-sync',
          description: 'LiveStore sync backend over Electron MessagePort IPC',
          protocol: 'messageport',
        },

        supports: {
          pullPageInfoKnown: true,
          pullLive: true,
        },
      }
    })
