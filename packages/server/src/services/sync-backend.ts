/**
 * LiveStore Sync Backend — Server-side sync handler
 *
 * Implements the `SyncWsRpc` protocol from `@livestore/sync-cf` using
 * sql.js (WASM-based SQLite) for event storage. This enables real-time
 * bidirectional sync between the server LiveStore and web clients
 * over MessagePort.
 *
 * Uses sql.js instead of better-sqlite3 to avoid native module
 * compatibility issues with Electron's Node.js ABI version.
 *
 * The RPC group is defined locally with the same tag names as
 * `@livestore/sync-cf`'s `SyncWsRpc` so that the `makeWsSync` client
 * from `@livestore/sync-cf/client` can connect seamlessly.
 *
 * @see packages/shared/src/schema.ts for the LiveStore schema
 * @see Issue #18: LiveStore server-to-client sync
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFile,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { MessageChannel } from 'node:worker_threads'
import { Rpc, RpcClient, RpcGroup, RpcServer } from '@effect/rpc'
import { env } from '@laborer/env/server'
import type { RpcMessagePort } from '@laborer/shared/rpc-transport-messageport'
import { layerProtocolMessagePort } from '@laborer/shared/rpc-transport-messageport'
import { makeClientProtocolMessagePort } from '@laborer/shared/rpc-transport-messageport-client'
import {
  Context,
  Effect,
  Layer,
  Option,
  Schema,
  Stream,
  SubscriptionRef,
} from 'effect'
import type { Database as SqlJsDatabase } from 'sql.js'
import initSqlJs from 'sql.js'

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

class PostMessageError extends Schema.TaggedError<PostMessageError>()(
  'PostMessageError',
  { message: Schema.String, cause: Schema.Unknown }
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
// SQLite Storage (sql.js WASM)
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
 * Flush interval for persisting the in-memory database to disk.
 * Writes are batched to avoid excessive I/O on every push.
 */
const FLUSH_INTERVAL_MS = 1000

/**
 * Creates and initializes the sync SQLite database using sql.js (WASM).
 *
 * sql.js operates on an in-memory database. We load from disk on startup
 * and periodically flush to disk after mutations.
 */
const makeSyncStorage = async (dataDir: string, storeId: string) => {
  const dbPath = `${dataDir}/sync-${storeId}.db`

  // Ensure the data directory exists.
  mkdirSync(dirname(dbPath), { recursive: true })

  // Initialize sql.js WASM engine.
  const SQL = await initSqlJs()

  // Load existing database from disk if available.
  let db: SqlJsDatabase
  if (existsSync(dbPath)) {
    const fileBuffer = readFileSync(dbPath)
    db = new SQL.Database(fileBuffer)
  } else {
    db = new SQL.Database()
  }

  const tableName = makeEventlogTableName(storeId)

  db.run(`
    CREATE TABLE IF NOT EXISTS "${tableName}" (
      seqNum INTEGER PRIMARY KEY,
      parentSeqNum INTEGER NOT NULL,
      name TEXT NOT NULL,
      args TEXT,
      createdAt TEXT NOT NULL,
      clientId TEXT NOT NULL,
      sessionId TEXT NOT NULL
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS "${CONTEXT_TABLE}" (
      storeId TEXT PRIMARY KEY,
      currentHead INTEGER NOT NULL,
      backendId TEXT NOT NULL
    )
  `)

  // Read context row.
  const contextStmt = db.prepare(
    `SELECT currentHead, backendId FROM "${CONTEXT_TABLE}" WHERE storeId = ?`
  )
  contextStmt.bind([storeId])
  let backendId: string
  let currentHead: number
  if (contextStmt.step()) {
    const row = contextStmt.getAsObject() as {
      currentHead: number
      backendId: string
    }
    backendId = row.backendId
    currentHead = row.currentHead
  } else {
    backendId = crypto.randomUUID()
    currentHead = 0
    db.run(
      `INSERT INTO "${CONTEXT_TABLE}" (storeId, currentHead, backendId) VALUES (?, ?, ?)`,
      [storeId, currentHead, backendId]
    )
  }
  contextStmt.free()

  // Track whether the database has unflushed changes.
  let dirty = false
  let flushTimer: ReturnType<typeof setInterval> | null = null
  // Guard against concurrent async flushes — if a flush is in progress,
  // the next timer tick will skip and retry on the following interval.
  let flushing = false

  /**
   * Asynchronously persist the in-memory database to disk.
   *
   * `db.export()` is synchronous (sql.js WASM limitation) but typically
   * completes in single-digit milliseconds for databases under ~10 MB.
   * The disk write uses the async `writeFile` so the Node.js event loop
   * stays responsive — this is critical because the same event loop
   * handles RPC ping/pong heartbeats on shared MessagePorts.
   */
  const flushToDisk = () => {
    if (!dirty || flushing) {
      return
    }
    flushing = true
    // db.export() is synchronous but we accept the brief stall —
    // the expensive part (disk I/O) is async below.
    const data = db.export()
    const buffer = Buffer.from(data)
    dirty = false
    writeFile(dbPath, buffer, (err) => {
      flushing = false
      if (err) {
        // Re-mark dirty so the next interval retries.
        dirty = true
        console.error('[sync-backend] async flush failed:', err)
      }
    })
  }

  /**
   * Synchronous flush used only during `close()` to guarantee data is
   * persisted before the database handle is released.
   */
  const flushToDiskSync = () => {
    if (!dirty) {
      return
    }
    const data = db.export()
    const buffer = Buffer.from(data)
    writeFileSync(dbPath, buffer)
    dirty = false
  }

  // Start periodic flush timer.
  flushTimer = setInterval(flushToDisk, FLUSH_INTERVAL_MS)

  return {
    backendId,
    getCurrentHead: () => currentHead,

    appendEvents: (batch: readonly EventEncodedType[], createdAt: string) => {
      db.run('BEGIN TRANSACTION')
      try {
        for (const event of batch) {
          db.run(
            `INSERT OR IGNORE INTO "${tableName}" (seqNum, parentSeqNum, args, name, createdAt, clientId, sessionId) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              event.seqNum,
              event.parentSeqNum,
              event.args === undefined ? null : JSON.stringify(event.args),
              event.name,
              createdAt,
              event.clientId,
              event.sessionId,
            ]
          )
        }
        const lastEvent = batch.at(-1)
        if (lastEvent !== undefined) {
          db.run(
            `INSERT OR REPLACE INTO "${CONTEXT_TABLE}" (storeId, currentHead, backendId) VALUES (?, ?, ?)`,
            [storeId, lastEvent.seqNum, backendId]
          )
          currentHead = lastEvent.seqNum
        }
        db.run('COMMIT')
        dirty = true
      } catch (error) {
        db.run('ROLLBACK')
        throw error
      }
    },

    getPage: (cursor: number | undefined, limit: number): SyncStorageRow[] => {
      const rows: SyncStorageRow[] = []
      const stmt =
        cursor === undefined
          ? db.prepare(
              `SELECT seqNum, parentSeqNum, name, args, createdAt, clientId, sessionId FROM "${tableName}" ORDER BY seqNum ASC LIMIT ?`
            )
          : db.prepare(
              `SELECT seqNum, parentSeqNum, name, args, createdAt, clientId, sessionId FROM "${tableName}" WHERE seqNum > ? ORDER BY seqNum ASC LIMIT ?`
            )
      stmt.bind(cursor === undefined ? [limit] : [cursor, limit])
      while (stmt.step()) {
        const row = stmt.getAsObject() as unknown as SyncStorageRow
        rows.push(row)
      }
      stmt.free()
      return rows
    },

    countEvents: (cursor: number | undefined): number => {
      const stmt =
        cursor === undefined
          ? db.prepare(`SELECT COUNT(*) as total FROM "${tableName}"`)
          : db.prepare(
              `SELECT COUNT(*) as total FROM "${tableName}" WHERE seqNum > ?`
            )
      stmt.bind(cursor === undefined ? [] : [cursor])
      let total = 0
      if (stmt.step()) {
        const row = stmt.getAsObject() as { total: number }
        total = row.total
      }
      stmt.free()
      return total
    },

    close: () => {
      // Final flush before closing — must be synchronous to guarantee
      // data is persisted before the database handle is released.
      if (flushTimer !== null) {
        clearInterval(flushTimer)
        flushTimer = null
      }
      flushToDiskSync()
      db.close()
    },
  }
}

type SyncStorage = Awaited<ReturnType<typeof makeSyncStorage>>

// ---------------------------------------------------------------------------
// SyncBackendService — Effect Service
// ---------------------------------------------------------------------------

/**
 * Tracks a MessagePort with active live pull request IDs.
 *
 * When a client issues a `SyncWsRpc.Pull` with `live: true`, we record
 * its RPC `requestId` and the port it arrived on. On push, we encode
 * `PullResponse` values and inject them as raw `ResponseChunkEncoded`
 * messages directly onto the port — exactly like the reference
 * `@livestore/sync-cf` implementation does with WebSockets.
 *
 * The live pull stream handler returns `Stream.never` to keep the RPC
 * channel open (no `Exit` message sent), while live updates bypass the
 * stream entirely and are injected as raw RPC chunk messages.
 */
interface LivePullPort {
  port: RpcMessagePort
  pullRequestIds: Set<string>
}

class SyncBackendService extends Context.Tag('@laborer/SyncBackendService')<
  SyncBackendService,
  {
    readonly storage: SyncStorage
    readonly livePorts: Map<string, LivePullPort>
  }
>() {}

/**
 * Schema encoder for PullResponse — used to encode values before
 * injecting them as raw RPC chunk messages onto MessagePorts.
 *
 * The RPC server normally encodes stream chunk values through
 * `Schema.encodeUnknown(Schema.Array(successSchema))`. When we
 * bypass the stream, we must do the same encoding ourselves.
 */
const encodePullResponse = Schema.encodeSync(PullResponse)

// ---------------------------------------------------------------------------
// Pull handler
// ---------------------------------------------------------------------------

const handlePull = (
  req: PullPayloadType
): Stream.Stream<PullResponseType, InvalidPullError, SyncBackendService> =>
  Effect.gen(function* () {
    const { storage } = yield* SyncBackendService
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

    // Phase 2: Keep stream alive with Stream.never.
    // Live updates are NOT delivered through this stream. Instead,
    // the push handler injects raw RPC ResponseChunkEncoded messages
    // directly onto the MessagePort. Stream.never prevents the RPC
    // framework from sending an Exit message, keeping the channel open.
    return Stream.concat(
      phase1WithEmpty,
      Stream.never as Stream.Stream<PullResponseType, never, never>
    )
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
  const { storage, livePorts } = yield* SyncBackendService
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

  // Accept all pushes without sequence validation.
  // The sync backend acts as a relay — the authoritative LaborerStore
  // manages its own consistency. Strict sequence validation would
  // reject valid batches when the server-side sync client pushes
  // events in chunks or when the sync db is seeded mid-history.
  const firstEvent = req.batch[0]
  if (firstEvent === undefined) {
    return {}
  }

  // Store events
  const createdAt = new Date().toISOString()
  storage.appendEvents(req.batch, createdAt)

  // Build the PullResponse for broadcasting
  const pullResponse: PullResponseType = {
    batch: req.batch.map((eventEncoded: EventEncodedType) => ({
      eventEncoded,
      metadata: Option.some(makeSyncMetadata(createdAt)),
    })),
    pageInfo: pageInfoNoMore,
    backendId,
  }

  // Encode through the PullResponse schema (converts Option types etc.)
  const encodedValue = encodePullResponse(pullResponse)

  // Inject ResponseChunkEncoded messages directly onto ports.
  // This bypasses the Effect RPC stream mechanism entirely —
  // the client's RPC framework sees these as stream chunks for
  // the still-open Pull request and delivers them seamlessly.
  for (const livePort of livePorts.values()) {
    for (const requestId of livePort.pullRequestIds) {
      const rpcChunk = {
        _tag: 'Chunk' as const,
        requestId,
        values: [encodedValue],
      }
      yield* Effect.try({
        try: () => livePort.port.postMessage(rpcChunk),
        catch: (cause) =>
          new PostMessageError({
            message: `Failed to send chunk to port requestId=${requestId}`,
            cause,
          }),
      }).pipe(
        Effect.catchTag('PostMessageError', (err) =>
          Effect.sync(() =>
            console.error(`[sync-backend] ${err.message}:`, err.cause)
          )
        )
      )
    }
  }

  return {}
})

// ---------------------------------------------------------------------------
// RPC Handler + Server Layers
// ---------------------------------------------------------------------------

const SyncRpcHandlersLive = SyncWsRpc.toLayer({
  'SyncWsRpc.Pull': (req) => {
    console.log(
      `[sync-backend] Pull request: storeId=${req.storeId} live=${String(req.live)} cursor=${req.cursor._tag}`
    )
    return handlePull(req).pipe(
      Stream.tap((res) =>
        Effect.sync(() =>
          console.log(
            `[sync-backend] Pull response: batchLen=${String(res.batch.length)} pageInfo=${res.pageInfo._tag}`
          )
        )
      ),
      Stream.mapError((cause) =>
        cause instanceof InvalidPullError
          ? cause
          : new InvalidPullError({ cause })
      )
    )
  },
  'SyncWsRpc.Push': (req) => {
    console.log(
      `[sync-backend] Push request: storeId=${req.storeId} batchLen=${String(req.batch.length)}`
    )
    return handlePush(req).pipe(
      Effect.tap(() =>
        Effect.sync(() => console.log('[sync-backend] Push completed'))
      ),
      Effect.mapError((cause) =>
        cause instanceof InvalidPushError
          ? cause
          : new InvalidPushError({ cause })
      )
    )
  },
})

/**
 * Data directory for sync SQLite persistence, configurable via DATA_DIR env var.
 * Defaults to `~/.config/laborer/data` when DATA_DIR is not set, ensuring
 * all worktrees of the same repo share the same database.
 */
const DATA_DIRECTORY = env.DATA_DIR
const STORE_ID = 'laborer'

/**
 * Shared singleton SyncBackendService instance.
 *
 * All sync ports (in-process for LaborerStore, renderer clients) share the
 * same underlying sql.js database and subscriber map. This ensures events
 * pushed by the server's LaborerStore are visible to renderer pull requests.
 *
 * Lazily initialized on first use. The `initPromise` ensures the async
 * sql.js initialization happens exactly once.
 */
let sharedServiceContext: Context.Context<SyncBackendService> | null = null
let sharedServiceInitPromise: Promise<
  Context.Context<SyncBackendService>
> | null = null

const getSharedSyncBackendService = (): Promise<
  Context.Context<SyncBackendService>
> => {
  if (sharedServiceContext !== null) {
    return Promise.resolve(sharedServiceContext)
  }
  if (sharedServiceInitPromise !== null) {
    return sharedServiceInitPromise
  }
  sharedServiceInitPromise = (async () => {
    const storage = await makeSyncStorage(DATA_DIRECTORY, STORE_ID)
    const livePorts = new Map<string, LivePullPort>()
    const ctx = Context.make(SyncBackendService, { storage, livePorts })
    sharedServiceContext = ctx
    console.log('[sync-backend] Shared SyncBackendService initialized (sql.js)')
    return ctx
  })()
  return sharedServiceInitPromise
}

/**
 * Layer that provides the shared SyncBackendService singleton.
 * Multiple RPC servers can use this layer and they'll all share
 * the same sql.js database and subscriber map.
 */
const SharedSyncBackendServiceLive = Layer.effect(
  SyncBackendService,
  Effect.promise(getSharedSyncBackendService).pipe(
    Effect.map((ctx) => Context.get(ctx, SyncBackendService))
  )
)

// ---------------------------------------------------------------------------
// MessagePort sync transport (Issue #11)
// ---------------------------------------------------------------------------

/**
 * Serves `SyncWsRpc` (Pull/Push) handlers over a dedicated MessagePort.
 *
 * Each call creates a scoped `RpcServer` on the given port backed by the
 * **shared** `SyncBackendService` singleton (sql.js WASM SQLite). All
 * sync ports share the same database and live port registry, ensuring
 * events pushed by the server's LaborerStore are visible to renderer
 * clients via direct RPC chunk injection.
 *
 * The port's incoming messages are intercepted to track live pull request
 * IDs (following the same pattern as `@livestore/sync-cf`'s WebSocket
 * `onMessage` interceptor). When a `SyncWsRpc.Pull` request arrives with
 * `live: true`, its `requestId` is registered in the shared `livePorts`
 * map. When an `Interrupt` arrives, the corresponding `requestId` is
 * removed. The push handler uses these tracked IDs to inject
 * `ResponseChunkEncoded` messages directly onto the port.
 *
 * @param port - The MessagePort to serve sync RPCs over.
 * @returns A fiber handle that can be interrupted to stop serving.
 */
const serveSyncOnPort = (port: RpcMessagePort) => {
  console.log('[sync-backend] serveSyncOnPort called — building layer')

  // Unique ID for this port in the shared livePorts registry.
  const portId = crypto.randomUUID()

  // Register this port's live pull tracking with the shared service.
  // This runs synchronously because serveSyncOnPort is called after
  // the shared service is initialized.
  const registerLivePort = Effect.promise(getSharedSyncBackendService).pipe(
    Effect.map((ctx) => {
      const service = Context.get(ctx, SyncBackendService)
      const livePort: LivePullPort = {
        port,
        pullRequestIds: new Set(),
      }
      service.livePorts.set(portId, livePort)
      console.log(
        `[sync-backend] Registered port ${portId} (total ports: ${String(service.livePorts.size)})`
      )
      return livePort
    })
  )

  // We need the livePort reference synchronously for the message interceptor.
  // Initialize it via a callback from the Effect.
  let livePort: LivePullPort | null = null
  Effect.runFork(
    registerLivePort.pipe(
      Effect.tap((lp) =>
        Effect.sync(() => {
          livePort = lp
        })
      )
    )
  )

  /**
   * Inspects a raw RPC message and tracks/unregisters live pull request IDs.
   * Called for every inbound message before the RPC server processes it.
   */
  const interceptMessage = (data: unknown): void => {
    if (livePort === null || typeof data !== 'object' || data === null) {
      return
    }
    const msg = data as Record<string, unknown>
    if (
      msg._tag === 'Request' &&
      msg.tag === 'SyncWsRpc.Pull' &&
      typeof msg.id === 'string'
    ) {
      const payload = msg.payload as Record<string, unknown> | undefined
      if (payload?.live === true) {
        livePort.pullRequestIds.add(msg.id)
        console.log(
          `[sync-backend] Live pull REGISTERED: port=${portId} requestId=${msg.id} (total: ${String(livePort.pullRequestIds.size)})`
        )
      }
    } else if (
      msg._tag === 'Interrupt' &&
      typeof msg.requestId === 'string' &&
      livePort.pullRequestIds.delete(msg.requestId)
    ) {
      console.log(
        `[sync-backend] Live pull UNREGISTERED: port=${portId} requestId=${msg.requestId} (total: ${String(livePort.pullRequestIds.size)})`
      )
    }
  }

  // Build a proxy port that intercepts incoming messages to track live
  // pull request IDs, then delegates to the underlying port. This is
  // analogous to the `onMessage` interceptor in the reference sync-cf
  // Durable Object implementation.
  //
  // We use `as RpcMessagePort` because exactOptionalPropertyTypes makes
  // conditional property forwarding (port.close?.bind) incompatible with
  // the optional-but-never-undefined property declarations.
  const interceptingPort = {
    postMessage(value: unknown, transferList?: readonly unknown[]) {
      port.postMessage(value, transferList)
    },
    start: port.start?.bind(port),
    close: port.close?.bind(port),
    off: port.off?.bind(port),
    removeListener: port.removeListener?.bind(port),
  } as RpcMessagePort

  if (typeof port.on === 'function') {
    // Node.js / Electron MessagePortMain style — wrap the `on` method
    ;(interceptingPort as { on: RpcMessagePort['on'] }).on = ((
      event: string,
      listener: (value: unknown) => void
    ) => {
      if (event === 'message') {
        const wrappedListener = (rawEvent: unknown) => {
          const data =
            typeof rawEvent === 'object' &&
            rawEvent !== null &&
            'data' in rawEvent
              ? (rawEvent as { data: unknown }).data
              : rawEvent
          interceptMessage(data)
          listener(rawEvent)
        }
        port.on?.('message', wrappedListener)
      } else {
        port.on?.(event as 'close', listener as () => void)
      }
    }) as RpcMessagePort['on']
  } else {
    // Web MessagePort style — use onmessage getter/setter with interception.
    // The RPC server transport sets port.onmessage = handler, so we
    // intercept that assignment to inject our tracking logic.
    let _onmessage: ((event: { data: unknown }) => void) | null = null
    Object.defineProperty(interceptingPort, 'onmessage', {
      set(handler: ((event: { data: unknown }) => void) | null) {
        _onmessage = handler
        if (handler === null) {
          port.onmessage = null
          return
        }
        port.onmessage = (event: { data: unknown }) => {
          interceptMessage(event.data)
          handler(event)
        }
      },
      get() {
        return _onmessage
      },
    })
  }

  const SyncServerOnPort = RpcServer.layer(SyncWsRpc).pipe(
    Layer.provide(layerProtocolMessagePort(interceptingPort)),
    Layer.provide(SyncRpcHandlersLive),
    Layer.provide(SharedSyncBackendServiceLive)
  )

  // Launch the sync server in a forked fiber. It stays alive until
  // the port closes (triggering scope finalization) or the process exits.
  const program = SyncServerOnPort.pipe(
    Layer.launch,
    Effect.scoped,
    Effect.tap(() =>
      Effect.sync(() => console.log('[sync-backend] Sync RPC server launched'))
    ),
    Effect.ensuring(
      Effect.promise(getSharedSyncBackendService).pipe(
        Effect.tap((ctx) =>
          Effect.sync(() => {
            const service = Context.get(ctx, SyncBackendService)
            service.livePorts.delete(portId)
            console.log(
              `[sync-backend] Unregistered port ${portId} (total ports: ${String(service.livePorts.size)})`
            )
          })
        )
      )
    ),
    Effect.tapErrorCause((cause) =>
      Effect.sync(() =>
        console.error('[sync-backend] Sync RPC server FAILED:', cause)
      )
    )
  )

  return Effect.runFork(program)
}

// ---------------------------------------------------------------------------
// In-process sync backend for LaborerStore (server-side sync client)
// ---------------------------------------------------------------------------

/**
 * RPC client type helper — extracts the client type from `RpcClient.make(SyncWsRpc)`.
 */
const MakeSyncClient = RpcClient.make(SyncWsRpc)
type SyncRpcClient = Effect.Effect.Success<typeof MakeSyncClient>

type PullResponseForSync = typeof PullResponse.Type

/**
 * Creates a sync backend constructor for the server's LaborerStore.
 *
 * Uses a Node.js `MessageChannel` to create an in-process connection
 * between the LaborerStore (as a sync client) and the sync backend
 * (as a sync server). This bridges the server's authoritative store
 * to the sync relay so events flow to connected renderer clients.
 *
 * Returns a `SyncBackendConstructor`-compatible function that can be
 * passed to `makeAdapter({ sync: { backend: ... } })`.
 *
 * @returns A sync backend constructor function.
 */
const makeInProcessSyncBackend = () => {
  // Create an in-process MessageChannel. One port serves the sync RPC
  // server; the other is used by the sync client.
  const { port1: serverPort, port2: clientPort } = new MessageChannel()

  // Serve sync RPC on the server port.
  // Cast through unknown because Node.js MessagePort has a compatible
  // but differently-typed interface than our RpcMessagePort.
  serveSyncOnPort(serverPort as unknown as RpcMessagePort)

  // Return a sync backend constructor that connects through the client port.
  const syncBackendConstructor =
    (typedClientPort: RpcMessagePort) =>
    ({ storeId }: { storeId: string; clientId: string; payload: unknown }) =>
      Effect.gen(function* () {
        const isConnected = yield* SubscriptionRef.make(false)

        // Build the RPC client protocol layer over the MessagePort.
        const ProtocolLive = Layer.scoped(
          RpcClient.Protocol,
          makeClientProtocolMessagePort(typedClientPort)
        )

        const ctx = yield* Layer.build(ProtocolLive)
        const rpcClient: SyncRpcClient = yield* MakeSyncClient.pipe(
          Effect.provide(ctx)
        )

        let currentBackendId: Option.Option<string> = Option.none()

        // Effect RPC client uses nested namespaces for dotted tag names.
        const typedClient = rpcClient as unknown as {
          SyncWsRpc: {
            Pull: (
              args: typeof PullPayload.Type
            ) => Stream.Stream<PullResponseForSync, InvalidPullError>
            Push: (
              args: typeof PushPayload.Type
            ) => Effect.Effect<typeof PushAck.Type, InvalidPushError>
          }
        }

        const pullRpc = typedClient.SyncWsRpc.Pull
        const pushRpc = typedClient.SyncWsRpc.Push

        /**
         * Fetches the backendId from the sync backend by issuing a
         * non-live pull with no cursor. Called during ping and lazily
         * during pull if the backendId hasn't been learned yet.
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

        const ping = Effect.gen(function* () {
          yield* fetchBackendId
          yield* SubscriptionRef.set(isConnected, true)
        }).pipe(
          Effect.catchAll(() => SubscriptionRef.set(isConnected, false)),
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
            name: '@laborer/in-process-sync',
            description:
              'In-process LiveStore sync backend for server-side store',
            protocol: 'messageport',
          },

          supports: {
            pullPageInfoKnown: true,
            pullLive: true,
          },
        }
      })

  return syncBackendConstructor(clientPort as unknown as RpcMessagePort)
}

export { makeInProcessSyncBackend, serveSyncOnPort }
