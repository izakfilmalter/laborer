/**
 * LiveStore Sync Backend — Server-side sync handler for Bun
 *
 * Implements the `SyncWsRpc` protocol from `@livestore/sync-cf` using
 * Bun's built-in SQLite for event storage. This enables real-time
 * bidirectional sync between the server LiveStore and web clients
 * over WebSocket.
 *
 * The RPC group is defined locally with the same tag names as
 * `@livestore/sync-cf`'s `SyncWsRpc` so that the `makeWsSync` client
 * from `@livestore/sync-cf/client` can connect seamlessly.
 *
 * @see packages/shared/src/schema.ts for the LiveStore schema
 * @see Issue #18: LiveStore server-to-client sync
 */

import { Database } from 'bun:sqlite'
import { Rpc, RpcGroup, RpcServer } from '@effect/rpc'
import { env } from '@laborer/env/server'
import {
  Context,
  Effect,
  Layer,
  Option,
  Queue,
  Ref,
  Schema,
  Stream,
} from 'effect'

// ---------------------------------------------------------------------------
// Sync message schemas (mirroring @livestore/sync-cf/common types)
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

type EventEncodedType = typeof EventEncoded.Type

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

/**
 * Error schemas matching `@livestore/common`'s InvalidPullError and
 * InvalidPushError. Effect RPC matches on `_tag` for error routing.
 */
class InvalidPullError extends Schema.TaggedError<InvalidPullError>()(
  'InvalidPullError',
  { cause: Schema.Unknown }
) {}

class InvalidPushError extends Schema.TaggedError<InvalidPushError>()(
  'InvalidPushError',
  { cause: Schema.Unknown }
) {}

// ---------------------------------------------------------------------------
// Pull/Push request types (inline, avoid .members access)
// ---------------------------------------------------------------------------

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

type PullPayloadType = typeof PullPayload.Type

const PushPayload = Schema.Struct({
  storeId: Schema.String,
  payload: Schema.optional(Schema.Unknown),
  batch: Schema.Array(EventEncoded),
  backendId: Schema.Option(BackendId),
})

type PushPayloadType = typeof PushPayload.Type

/**
 * RPC group matching the wire protocol of `@livestore/sync-cf`'s
 * `SyncWsRpc`. The tag names (`SyncWsRpc.Pull`, `SyncWsRpc.Push`)
 * must match exactly for the client's `RpcClient.make(SyncWsRpc)`
 * to route correctly.
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
// Helpers
// ---------------------------------------------------------------------------

const pageInfoNoMore: typeof PullResPageInfo.Type = { _tag: 'NoMore' }
const pageInfoMoreKnown = (remaining: number): typeof PullResPageInfo.Type => ({
  _tag: 'MoreKnown',
  remaining,
})

const makeSyncMetadata = (createdAt: string): typeof SyncMetadata.Type => ({
  _tag: 'SyncMessage.SyncMetadata',
  createdAt,
})

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_PULL_EVENTS_PER_PAGE = 256

// ---------------------------------------------------------------------------
// SQLite Storage
// ---------------------------------------------------------------------------

interface SyncStorageRow {
  args: string | null
  clientId: string
  createdAt: string
  name: string
  parentSeqNum: number
  seqNum: number
  sessionId: string
}

const makeEventlogTableName = (storeId: string) =>
  `eventlog_1_${storeId.replaceAll(/[^a-zA-Z0-9]/g, '_')}`

const CONTEXT_TABLE = 'context_1'

/**
 * Creates and initializes the sync SQLite database.
 */
const makeSyncStorage = (dataDir: string, storeId: string) => {
  const dbPath = `${dataDir}/sync-${storeId}.db`
  const db = new Database(dbPath, { create: true })
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')

  const tableName = makeEventlogTableName(storeId)

  db.exec(`
    CREATE TABLE IF NOT EXISTS "${tableName}" (
      seqNum INTEGER PRIMARY KEY,
      parentSeqNum INTEGER NOT NULL,
      name TEXT NOT NULL,
      args TEXT,
      createdAt TEXT NOT NULL,
      clientId TEXT NOT NULL,
      sessionId TEXT NOT NULL
    ) STRICT
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS "${CONTEXT_TABLE}" (
      storeId TEXT PRIMARY KEY,
      currentHead INTEGER NOT NULL,
      backendId TEXT NOT NULL
    ) STRICT
  `)

  const contextRow = db
    .query<
      { storeId: string; currentHead: number; backendId: string },
      [string]
    >(`SELECT * FROM "${CONTEXT_TABLE}" WHERE storeId = ?`)
    .get(storeId)

  const backendId = contextRow?.backendId ?? crypto.randomUUID()
  let currentHead = contextRow?.currentHead ?? 0

  if (contextRow === null) {
    db.query(
      `INSERT INTO "${CONTEXT_TABLE}" (storeId, currentHead, backendId) VALUES (?, ?, ?)`
    ).run(storeId, currentHead, backendId)
  }

  const insertStmt = db.query(
    `INSERT INTO "${tableName}" (seqNum, parentSeqNum, args, name, createdAt, clientId, sessionId) VALUES (?, ?, ?, ?, ?, ?, ?)`
  )

  const selectFromCursorStmt = db.query<SyncStorageRow, [number, number]>(
    `SELECT * FROM "${tableName}" WHERE seqNum > ? ORDER BY seqNum ASC LIMIT ?`
  )

  const selectAllStmt = db.query<SyncStorageRow, [number]>(
    `SELECT * FROM "${tableName}" ORDER BY seqNum ASC LIMIT ?`
  )

  const countFromCursorStmt = db.query<{ total: number }, [number]>(
    `SELECT COUNT(*) as total FROM "${tableName}" WHERE seqNum > ?`
  )

  const countAllStmt = db.query<{ total: number }, []>(
    `SELECT COUNT(*) as total FROM "${tableName}"`
  )

  const updateHeadStmt = db.query(
    `INSERT OR REPLACE INTO "${CONTEXT_TABLE}" (storeId, currentHead, backendId) VALUES (?, ?, ?)`
  )

  return {
    backendId,
    getCurrentHead: () => currentHead,

    appendEvents: (batch: readonly EventEncodedType[], createdAt: string) => {
      const insertMany = db.transaction(
        (events: readonly EventEncodedType[]) => {
          for (const event of events) {
            insertStmt.run(
              event.seqNum,
              event.parentSeqNum,
              event.args === undefined ? null : JSON.stringify(event.args),
              event.name,
              createdAt,
              event.clientId,
              event.sessionId
            )
          }
          const lastEvent = events.at(-1)
          if (lastEvent !== undefined) {
            updateHeadStmt.run(storeId, lastEvent.seqNum, backendId)
            currentHead = lastEvent.seqNum
          }
        }
      )
      insertMany(batch)
    },

    getPage: (cursor: number | undefined, limit: number): SyncStorageRow[] => {
      if (cursor === undefined) {
        return selectAllStmt.all(limit)
      }
      return selectFromCursorStmt.all(cursor, limit)
    },

    countEvents: (cursor: number | undefined): number => {
      if (cursor === undefined) {
        return countAllStmt.get()?.total ?? 0
      }
      return countFromCursorStmt.get(cursor)?.total ?? 0
    },

    close: () => {
      db.close()
    },
  }
}

type SyncStorage = ReturnType<typeof makeSyncStorage>

// ---------------------------------------------------------------------------
// SyncBackendService — Effect Service
// ---------------------------------------------------------------------------

interface PullSubscriber {
  queue: Queue.Queue<PullResponseType>
}

class SyncBackendService extends Context.Tag('@laborer/SyncBackendService')<
  SyncBackendService,
  {
    readonly storage: SyncStorage
    readonly subscribers: Ref.Ref<Map<string, PullSubscriber>>
  }
>() {}

// ---------------------------------------------------------------------------
// Pull handler
// ---------------------------------------------------------------------------

const handlePull = (
  req: PullPayloadType
): Stream.Stream<PullResponseType, InvalidPullError, SyncBackendService> =>
  Effect.gen(function* () {
    const { storage, subscribers } = yield* SyncBackendService
    const { backendId } = storage

    // Validate backendId if cursor provided
    if (
      req.cursor._tag === 'Some' &&
      req.cursor.value.backendId !== backendId
    ) {
      return yield* new InvalidPullError({
        cause: `Backend ID mismatch: expected ${backendId}, got ${req.cursor.value.backendId}`,
      })
    }

    const cursorSeqNum =
      req.cursor._tag === 'Some'
        ? req.cursor.value.eventSequenceNumber
        : undefined

    const total = storage.countEvents(cursorSeqNum)

    // Phase 1: Read existing events from storage in pages
    interface PageState {
      cursor: number | undefined
      remaining: number
    }

    const phase1: Stream.Stream<PullResponseType, never, never> =
      Stream.unfoldEffect(
        { cursor: cursorSeqNum, remaining: total } satisfies PageState,
        (state: PageState) =>
          Effect.sync(
            (): Option.Option<readonly [PullResponseType, PageState]> => {
              if (state.remaining <= 0) {
                return Option.none()
              }

              const rows = storage.getPage(
                state.cursor,
                MAX_PULL_EVENTS_PER_PAGE
              )

              if (rows.length === 0) {
                return Option.none()
              }

              const batch = rows.map((row) => ({
                eventEncoded: {
                  seqNum: row.seqNum,
                  parentSeqNum: row.parentSeqNum,
                  name: row.name,
                  args:
                    row.args === null
                      ? undefined
                      : JSON.parse(row.args as string),
                  clientId: row.clientId,
                  sessionId: row.sessionId,
                },
                metadata: Option.some(makeSyncMetadata(row.createdAt)),
              }))

              const lastRow = rows.at(-1)
              if (lastRow === undefined) {
                return Option.none()
              }
              const lastSeqNum = lastRow.seqNum
              const nextRemaining = Math.max(0, state.remaining - rows.length)

              const response: PullResponseType = {
                batch,
                pageInfo:
                  nextRemaining > 0
                    ? pageInfoMoreKnown(nextRemaining)
                    : pageInfoNoMore,
                backendId,
              }

              const nextState: PageState = {
                cursor: lastSeqNum,
                remaining: nextRemaining,
              }

              return Option.some([response, nextState] as const)
            }
          )
      )

    // Emit at least one response even if there are no events
    const phase1WithEmpty: Stream.Stream<PullResponseType, never, never> =
      total === 0
        ? Stream.make({
            batch: [],
            pageInfo: pageInfoNoMore,
            backendId,
          } as PullResponseType)
        : phase1

    if (!req.live) {
      return phase1WithEmpty
    }

    // Phase 2: Live updates via subscriber queue
    const subscriberId = crypto.randomUUID()
    const queue = yield* Queue.unbounded<PullResponseType>()

    yield* Ref.update(subscribers, (subs) => {
      const next = new Map(subs)
      next.set(subscriberId, { queue })
      return next
    })

    const phase2: Stream.Stream<PullResponseType, never, never> =
      Stream.fromQueue(queue).pipe(
        Stream.ensuring(
          Ref.update(subscribers, (subs) => {
            const next = new Map(subs)
            next.delete(subscriberId)
            return next
          })
        )
      )

    return Stream.concat(phase1WithEmpty, phase2)
  }).pipe(
    Stream.unwrap,
    Stream.mapError((cause) =>
      cause instanceof InvalidPullError
        ? cause
        : new InvalidPullError({ cause })
    )
  )

// ---------------------------------------------------------------------------
// Push handler
// ---------------------------------------------------------------------------

const handlePush = Effect.fn('handlePush')(function* (req: PushPayloadType) {
  const { storage, subscribers } = yield* SyncBackendService
  const { backendId } = storage

  if (req.batch.length === 0) {
    return {}
  }

  // Validate backendId
  if (req.backendId._tag === 'Some' && req.backendId.value !== backendId) {
    return yield* new InvalidPushError({
      cause: `Backend ID mismatch: expected ${backendId}, got ${req.backendId.value}`,
    })
  }

  // Validate sequence numbers
  const currentHead = storage.getCurrentHead()
  const firstEvent = req.batch[0]
  if (firstEvent === undefined) {
    return {}
  }
  const firstEventParent = firstEvent.parentSeqNum

  if (firstEventParent !== currentHead) {
    return yield* new InvalidPushError({
      cause: `Server ahead: expected parentSeqNum ${currentHead}, got ${firstEventParent}`,
    })
  }

  // Store events
  const createdAt = new Date().toISOString()
  storage.appendEvents(req.batch, createdAt)

  // Broadcast to live pull subscribers
  const subs = yield* Ref.get(subscribers)

  if (subs.size > 0) {
    const pullResponse: PullResponseType = {
      batch: req.batch.map((eventEncoded: EventEncodedType) => ({
        eventEncoded,
        metadata: Option.some(makeSyncMetadata(createdAt)),
      })),
      pageInfo: pageInfoNoMore,
      backendId,
    }

    for (const sub of subs.values()) {
      yield* Queue.offer(sub.queue, pullResponse)
    }
  }

  return {}
})

// ---------------------------------------------------------------------------
// RPC Handler + Server Layers
// ---------------------------------------------------------------------------

const SyncRpcHandlersLive = SyncWsRpc.toLayer({
  'SyncWsRpc.Pull': (req) =>
    handlePull(req).pipe(
      Stream.mapError((cause) =>
        cause instanceof InvalidPullError
          ? cause
          : new InvalidPullError({ cause })
      )
    ),
  'SyncWsRpc.Push': (req) =>
    handlePush(req).pipe(
      Effect.mapError((cause) =>
        cause instanceof InvalidPushError
          ? cause
          : new InvalidPushError({ cause })
      )
    ),
})

/**
 * Data directory for sync SQLite persistence, configurable via DATA_DIR env var.
 * Defaults to `"./data"` when DATA_DIR is not set.
 */
const DATA_DIRECTORY = env.DATA_DIR
const STORE_ID = 'laborer'

const SyncBackendServiceLive = Layer.scoped(
  SyncBackendService,
  Effect.gen(function* () {
    const storage = makeSyncStorage(DATA_DIRECTORY, STORE_ID)
    const subscribers = yield* Ref.make(new Map<string, PullSubscriber>())

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        storage.close()
      })
    )

    return { storage, subscribers }
  })
)

/**
 * The complete sync RPC server layer.
 *
 * Handles `SyncWsRpc.Pull` and `SyncWsRpc.Push` RPC methods over
 * WebSocket. Uses layerProtocolWebsocket to register a GET /rpc handler
 * for WebSocket upgrade, matching the client's makeWsSync which connects
 * via RpcClient.layerProtocolSocketWithIsConnected (WebSocket).
 *
 * The business RPCs (LaborerRpcs) use layerProtocolHttp on POST /rpc,
 * so both coexist on the same /rpc path with different HTTP methods.
 */
const SyncRpcLive = RpcServer.layer(SyncWsRpc).pipe(
  Layer.provide(RpcServer.layerProtocolWebsocket({ path: '/rpc' })),
  Layer.provide(SyncRpcHandlersLive),
  Layer.provide(SyncBackendServiceLive)
)

export { SyncRpcLive }
