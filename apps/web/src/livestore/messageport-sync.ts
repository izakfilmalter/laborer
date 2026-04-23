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
      // Electron's dedicated sync port already gets explicit invalidation from
      // the main process when the server utility exits. Disable the raw
      // transport heartbeat here to avoid false dead-port detection on an
      // otherwise healthy quiet live-pull channel.
      const ProtocolLive = Layer.scoped(
        RpcClient.Protocol,
        makeClientProtocolMessagePort(port, { heartbeatEnabled: false })
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

      /**
       * Fetches the backendId from the sync backend by issuing a
       * non-live pull with no cursor. This is only needed when we are
       * resuming from a known upstream cursor and must include the
       * backendId in that cursor.
       *
       * We intentionally do not call this from `connect()`. Doing so
       * starts a second full-history pull on the same port during boot,
       * which can race with the real live pull and discard the earliest
       * history pages before the store materializes them.
       */
      const fetchBackendId = Effect.gen(function* () {
        if (currentBackendId._tag === 'Some') {
          return currentBackendId.value
        }
        const stream = pullRpc({
          storeId,
          live: false,
          cursor: Option.none(),
        })
        const head = yield* Stream.runHead(stream)
        if (head._tag === 'Some') {
          currentBackendId = Option.some(head.value.backendId)
          return head.value.backendId
        }
        return yield* new InvalidPullError({
          cause: 'Failed to fetch backendId: empty pull response',
        })
      })

      const ping = SubscriptionRef.set(isConnected, true).pipe(Effect.asVoid)

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
          // Build the cursor with backendId. If we have a cursor but
          // no backendId yet, we MUST learn it first via a non-live
          // pull. Dropping the cursor causes the server to return all
          // events from the beginning, which SyncState.merge rejects
          // as "incoming events must be greater than upstream head".
          const buildRpcCursor = Effect.gen(function* () {
            if (cursor._tag === 'None') {
              return Option.none<{
                eventSequenceNumber: number
                backendId: string
              }>()
            }
            // Ensure we have the backendId before constructing cursor
            const backendId = yield* fetchBackendId
            return Option.some({
              eventSequenceNumber: cursor.value.eventSequenceNumber,
              backendId,
            })
          })

          return Stream.unwrap(
            buildRpcCursor.pipe(
              Effect.map((rpcCursor) =>
                pullRpc({
                  storeId,
                  live: options?.live === true,
                  cursor: rpcCursor,
                }).pipe(
                  Stream.tap((res) =>
                    Effect.sync(() => {
                      currentBackendId = Option.some(res.backendId)
                    })
                  ),
                  Stream.map((res) => ({
                    batch: res.batch,
                    pageInfo: res.pageInfo,
                  }))
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
