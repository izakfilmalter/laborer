# OpenCode's SQLite and client synchronization layer, and what Laborer should copy

Research for [#357](https://github.com/izakfilmalter/laborer/issues/357), under the map in [#349](https://github.com/izakfilmalter/laborer/issues/349).

Source inspected: `anomalyco/opencode` at `14f0bf64a19493110b51f5fdeb9c1c1bba5dd3f5` (2026-07-31). Historical claims below also cite repository commits. OpenCode is actively carrying V1 compatibility beside its V2 core, so this document distinguishes the current durable database from the remaining legacy JSON helper.

## Executive answer

OpenCode's current durable application state is one SQLite database backed by Drizzle and an Effect-native adapter. The normal production path is `<XDG data>/opencode/opencode.db`; a server/CLI process opens it, applies WAL, `synchronous=NORMAL`, a 5-second busy timeout, foreign keys, and automatic TypeScript migrations. Bun uses `bun:sqlite`; Node (including the Electron sidecar) uses built-in `node:sqlite`. Sessions, messages, parts, todos, projects, workspaces, permissions, credentials, shares, and durable events live there.

OpenCode is **not** a model of two independently reactive SQLite writers. Each running server process has its own SQLite connection and in-memory Effect `PubSub`. Its clients do not open SQLite: TUI, web, and Electron renderer issue HTTP commands to a server and consume live events over SSE. A database transaction commits a durable event and its projection, then the same process publishes to its own bus. SSE has no persisted global cursor or replay on reconnect; `server.connected` makes the UI refetch authoritative snapshots. A second process can physically write the same WAL database, but its commit does not wake the first process's bus or connected clients. OpenCode itself records that multiple hosts sharing durable Session storage need shared execution coordination or isolated storage before that topology is supported (`CONTEXT.md`, “Client contract architecture”).

For Laborer, OpenCode strengthens rather than changes #350's recommendation. Copy its concrete SQLite startup profile, runtime-specific driver split, schema/migration ownership, immediate transactions for sequence allocation, atomic projection/event writes, stable IDs, uniqueness constraints, and post-commit notification rule. Do **not** copy its process-local `PubSub`/SSE layer as cross-process invalidation, its per-aggregate event store, or assume its migration lock coordinates independent processes. Keep the proposed `task_changes` ledger and cursor polling, bounded busy retry, and per-task compare-and-swap revisions. Those are required precisely where OpenCode's supported topology differs from Laborer's two-independent-writer requirement.

## Current storage architecture (verified evidence)

### Database path and contents

- `Global.Path.data` is `<xdgData>/opencode` (`packages/core/src/global.ts`). `Database.path()` chooses:
  - `OPENCODE_DB` when explicitly set (absolute, `:memory:`, or relative to the data directory);
  - `opencode.db` for `latest`, `beta`, and `prod` channels; or
  - a channel-suffixed preview database otherwise (`packages/core/src/database/database.ts`).
- `Database.node` is process-global in the Effect application graph. It is installed in both the current server route layer (`packages/server/src/routes.ts`) and the V1-compatible OpenCode runtime (`packages/opencode/src/effect/app-runtime.ts`). This is a singleton **per process**, not a machine-wide database-owner service.
- Drizzle table definitions are domain-owned under `packages/core/src/**/*.sql.ts`. The generated baseline schema (`packages/core/src/database/schema.gen.ts`) includes `project`, `project_directory`, `workspace`, `session`, `message`, `part`, `todo`, `session_message`, `session_input`, `session_context_epoch`, `permission`, `credential`, account tables, `session_share`, `event`, `event_sequence`, and migration metadata. Session/message/todo definitions and their FKs/indexes are visible directly in `packages/core/src/session/sql.ts`; durable event tables are in `packages/core/src/event/sql.ts`.
- The surviving `packages/opencode/src/storage/storage.ts` is a JSON-file key/value helper under `<data>/storage`, with process-local per-file reentrant locks. It is not the primary session/message store. In current production code its direct domain use is the legacy session-diff write in `packages/opencode/src/session/revert.ts`. Its name is therefore easy to mistake for the current database architecture.

### Libraries and runtime split

- Query/schema layer: Drizzle ORM plus the vendored `@opencode-ai/effect-drizzle-sqlite` adapter (`packages/core/src/database/database.ts`; package implementation under `packages/effect-drizzle-sqlite`). Queries are Effect values and transactions are Effect-scoped.
- Bun layer: `bun:sqlite.Database` plus `drizzle-orm/bun-sqlite` (`packages/core/src/database/sqlite.bun.ts`).
- Node layer: built-in synchronous `node:sqlite.DatabaseSync` plus `drizzle-orm/node-sqlite`, not `better-sqlite3` (`packages/core/src/database/sqlite.node.ts`).
- Both adapters expose one native connection guarded by an Effect semaphore with one permit, so calls and transactions through a given process's client serialize on that connection (`sqlite.bun.ts` and `sqlite.node.ts`, `make`). This semaphore does not span OS processes.
- Both layers also provide Effect SQL's experimental `Reactivity.layer`, but application UI synchronization does not subscribe to SQLite query invalidations. The observable path described below is domain event publication over SSE.

### Startup pragmas

Before exposing the service, `packages/core/src/database/database.ts` applies:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA cache_size = -64000;
PRAGMA foreign_keys = ON;
PRAGMA wal_checkpoint(PASSIVE);
```

The native Bun/Node layers also request WAL on open unless disabled/read-only (`packages/core/src/database/sqlite.bun.ts`; `sqlite.node.ts`). This gives crash-safe SQLite transactions, reader/writer overlap under WAL, and up to five seconds waiting for a competing lock. There is no database-level lease and no explicit application retry loop for `SQLITE_BUSY` in the core database write path.

### Schema generation and migrations

- The declared schema is generated into one baseline `schema.gen.ts`; timestamp-named incremental TypeScript migrations are generated into `migration.gen.ts` from `packages/core/src/database/migration/*.ts`.
- `DatabaseMigration.apply` (`packages/core/src/database/migration.ts`) handles two cases:
  1. an empty database receives the complete generated schema and a `migration` ledger in one transaction, then all known migration IDs are marked complete;
  2. an existing database with a `session` table runs only incomplete incremental migrations, each in its own transaction.
- It refuses a non-empty database that lacks `session`, avoiding accidental adoption of an unrelated SQLite file. It also imports the old `__drizzle_migrations` journal once into the current `migration` table, preserving the earlier migration lineage (`packages/core/src/database/migration.ts`).
- The only explicit migration mutex is a module-level Effect semaphore (`DatabaseMigration.apply`, `lock`). It protects concurrent initialization inside one JavaScript process. The corresponding test creates two layers in one process against one path (`packages/core/test/database-migration.test.ts`, “serializes concurrent embedded initialization”). It does not prove cross-process migration safety.
- Migration tests also verify empty-schema installation, rejection of unrelated non-empty databases, and data/index backfills (`packages/core/test/database-migration.test.ts`).

### JSON-to-SQLite history

Earlier OpenCode really did persist projects/sessions/messages/parts/todos as JSON below `<data>/storage` (the current JSON helper still shows its old namespace migrations in `packages/opencode/src/storage/storage.ts`). Commit `6d95f0d14` (“sqlite again”, 2026-02-13) introduced `bun:sqlite`, Drizzle migrations, `opencode.db`, and a one-time `JsonMigration` that bulk-copied those JSON namespaces when the database did not yet exist. Commit `ca2acc4f8` (“remove JSON storage migration”, 2026-06-02) removed the startup check and `packages/opencode/src/storage/json-migration.ts`. Thus the inspected architecture is SQLite-first and no longer contains a production JSON-to-SQLite importer; old documentation or code discussions describing JSON as the main store are stale.

## Write ownership and coordination (verified evidence)

### Normal command path

TUI, web, and desktop renderer are clients of an OpenCode server; they do not share a SQLite handle with the server. The Electron main process spawns an OpenCode server in an Electron utility process (`packages/desktop/src/main/server.ts`), whose `sidecar.ts` imports and listens with `virtual:opencode-server`. The renderer receives the server URL and communicates over HTTP/SSE (`packages/desktop/src/main/index.ts`, `server.ts`, `sidecar.ts`). A remote server can be selected as well, reinforcing that database access stays server-side.

Within one server process:

1. A domain operation publishes through `EventV2.Service` (`packages/core/src/event.ts`).
2. For durable definitions, `commitDurableEvent` opens an **immediate** transaction.
3. It reads the aggregate's latest sequence, validates replay/ownership/idempotency, invokes registered projectors and an optional local commit hook, updates `event_sequence`, and inserts the event row atomically.
4. Only after the transaction returns does `publishEvent` call `notify`, which invokes process-local listeners and publishes to typed/all `PubSub`s.

This preserves the important rule “do not tell clients before durable state commits.” Projected session state and its causal durable event cannot partially commit when written through this path.

### Multiple processes

SQLite itself coordinates physical file access through WAL and locks; `busy_timeout=5000` gives another writer time to finish. OpenCode does not wrap all commands in one global queue, does not elect one OS-process writer, and does not acquire a file lock for normal writes. Distinct CLI/server processes can therefore open the same configured database.

However, that should not be read as a supported independent-host synchronization design:

- the one-permit adapter semaphore is process-local (`packages/core/src/database/sqlite.{bun,node}.ts`);
- migration's semaphore is process-local (`packages/core/src/database/migration.ts`);
- event `PubSub`, listener arrays, projector registrations, and durable wake sets are process-local (`packages/core/src/event.ts`);
- `CONTEXT.md` explicitly leaves shared-database multi-host Session execution undefined;
- no core database path adds bounded retries after the busy timeout.

OpenCode prevents event-sequence races better than ordinary mutable-row races: `BEGIN IMMEDIATE` obtains write intent before reading `event_sequence`, and unique `(aggregate_id, seq)` plus unique event IDs enforce consistency (`packages/core/src/event.ts`; `packages/core/src/event/sql.ts`). Ordinary projections primarily use explicit upsert/update policies, timestamps, and stable IDs (for example `packages/core/src/session/projector.ts`); there is no general row revision/CAS protocol for two independent human/system editors.

## Change propagation (verified evidence)

### Server: post-commit bus to SSE

SQLite does not trigger client updates directly.

- `EventV2.notify` publishes to in-memory typed and global Effect `PubSub`s after a durable transaction commits (`packages/core/src/event.ts`).
- The current V2 `/api/event` handler eagerly acquires a bounded live stream (capacity 256), emits `server.connected`, then streams live events as SSE with a 15-second heartbeat (`packages/server/src/handlers/event.ts`; route schema in `packages/protocol/src/groups/event.ts`). Overflow fails the bounded subscriber rather than silently growing memory (`EventV2.allBounded` in `packages/core/src/event.ts`).
- The V1-compatible instance handler similarly installs an eager queue listener, filters by directory/workspace, emits `server.connected`, adds heartbeat events, and streams SSE (`packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts`).
- There is no SQLite polling or watching of `opencode.db`, `-wal`, or `-shm` in this propagation path.

The durable API does have per-aggregate sequence replay: `EventV2.durable({ aggregateID, after })` first installs a local wake subscription, reads rows after a sequence, and re-reads after each wake (`packages/core/src/event.ts`). This closes a same-process subscribe/read race and supports aggregate-local replay. It still cannot notice another process's commit because only the committing process publishes the wake.

### Client reconnect and missed events

The global SSE protocol does **not** implement a durable event cursor:

- SSE frames set transport `id: undefined` in both current and V1-compatible handlers (`packages/server/src/handlers/event.ts`; `packages/opencode/.../handlers/event.ts`).
- `/api/event` accepts no `afterSequence` argument (`packages/protocol/src/groups/event.ts`).
- The app reconnect loop waits 250 ms and opens a fresh stream without a cursor (`packages/app/src/context/server-sdk.tsx`).
- A fresh `server.connected` event causes global and active-directory bootstrap/refetch behavior, restoring authoritative state after a disconnect (`packages/app/src/context/server-sync.tsx`; `global-sync/event-reducer.ts`; `global-sync/bootstrap.ts`).

Consequently, global event delivery is an invalidation/latency aid, not the sole durable truth. If a process crashes after commit but before PubSub publication, SQLite retains the transaction and reconnect bootstrap recovers the state. While the connection stays healthy, however, an external writer's commit produces no local event and no automatic refetch.

The separate V1 sync HTTP endpoints expose persisted durable event history/replay and ownership rules for workspace synchronization (`packages/opencode/src/server/routes/instance/httpapi/handlers/sync.ts`). That specialized session/event synchronization is not the UI's general SQLite change-feed protocol.

## Conflict handling, recovery, and cursors (verified evidence)

- **Atomicity/crash recovery:** SQLite transactions plus WAL protect committed data. Durable event + projector writes use one immediate transaction, and notifications happen after commit (`packages/core/src/database/database.ts`; `packages/core/src/event.ts`).
- **Idempotency/divergence:** durable event replay compares event ID, type/version, aggregate sequence, and encoded data. Exact replay is accepted; divergent replay, duplicate IDs elsewhere, and sequence gaps die with `InvalidDurableEventError` (`packages/core/src/event.ts`).
- **Ownership:** optional `owner_id` on `event_sequence` supports strict aggregate replay ownership and a “claim” operation (`packages/core/src/event.ts`; `packages/core/src/event/sql.ts`). This is sync ownership, not a general writer lease for the database.
- **Sequences:** durable sequences are monotonic **per aggregate**, not one global commit cursor. `event_sequence` stores each aggregate's latest `seq`; `(aggregate_id, seq)` is unique. `history` orders rows by `seq` across aggregates even though equal values can exist, so it is not a total-order UI cursor (`packages/core/src/event/sql.ts`; sync handler).
- **Busy conflicts:** connections wait five seconds. There is no identified bounded retry/jitter loop around SQLite writes after timeout.
- **Semantic row conflicts:** no generic revision/CAS is present. Domain uniqueness, ownership, and event validation cover specific cases; they do not define which of two concurrent status edits wins.
- **Process crash continuation:** committed state survives and UI reconnect refetches it. OpenCode's own `AGENTS.md` notes that V2 Session post-crash continuation recovery remains a separate explicit design; durable database recovery does not imply safe re-execution of in-flight model work.

## UI reactivity (verified evidence)

The application uses a snapshot-plus-live-event client store, but not a cursor-based database subscription:

1. `bootstrapGlobal` and `bootstrapDirectory` fetch authoritative HTTP query results into Solid stores and TanStack Solid Query caches (`packages/app/src/context/global-sync/bootstrap.ts`; `server-sync.tsx`).
2. `server-sdk.tsx` consumes the server SSE stream, coalesces bursts, batches updates, and emits events by directory.
3. `server-sync.tsx` listens and feeds events into `applyGlobalEvent`/`applyDirectoryEvent`, or schedules a directory/global bootstrap through `createRefreshQueue`.
4. `global-sync/event-reducer.ts` incrementally reconciles sessions, messages, parts, todos, statuses, permissions, questions, and VCS state in `solid-js/store`. Solid components react to those stores.
5. TUI uses the same client event abstraction (`packages/tui/src/context/sdk.tsx`, `context/event.ts`, and `context/sync.tsx`) and maintains its own reactive data context.

The Electron renderer follows this same HTTP/SSE path through the sidecar; Electron main is a server lifecycle host, not a query observer that forwards native SQLite notifications.

## Comparison with T3 Code research (#350)

### Agreement

Both systems support the persistence principles recommended in `docs/research/t3code-sqlite-sync.md`:

- one canonical, automatically migrated SQLite database;
- WAL, foreign keys, short transactions, stable identifiers, and uniqueness/idempotency rules;
- server-side ownership of native SQLite handles, with renderers consuming typed process/network boundaries;
- authoritative query/bootstrap state plus events for low-latency reactive updates;
- events/notifications only after their database transaction commits;
- no filesystem watching of SQLite/WAL as a correctness mechanism.

OpenCode adds particularly useful concrete details absent from T3's normal startup: `busy_timeout=5000`, `synchronous=NORMAL`, a passive checkpoint on open, both Bun and built-in Node 24 driver implementations, an immediate transaction before sequence allocation, and an explicit bounded subscriber overflow policy.

### Differences

| Concern | T3 Code | OpenCode | Relevance to Laborer |
| --- | --- | --- | --- |
| Live writer ownership | One server command worker serializes writes. | One connection per server process; no global process owner/queue. | OpenCode is closer physically, but does not solve two-writer reactivity or semantic conflicts. |
| Event order | One global autoincrement orchestration sequence. | Per-aggregate durable sequences; no global total-order SSE cursor. | Laborer still needs a global `task_changes.sequence`. |
| Client catch-up | Snapshot plus bounded persisted replay then live WebSocket. | Live SSE; reconnect sends no cursor and triggers HTTP bootstrap/refetch. | A snapshot fallback is good, but polling needs a durable cursor to notice `next` without disconnecting. |
| External DB writes | Outside the supported owner path. | SQLite permits them, but process-local PubSub never observes them. | Neither design supplies cross-process invalidation. |
| Busy handling | WAL, but normal setup lacks busy timeout/retry. | 5-second busy timeout, no further retry. | Copy timeout; add bounded retry/jitter for Laborer's intentional contention. |
| Semantic conflicts | Avoided by one serialized command owner. | Event stream ownership/sequence validation; no generic mutable-row CAS. | Laborer still needs task revisions and field ownership rules. |
| Migrations | Automatically applied by one server owner. | Auto-applied; only in-process migration semaphore is proven. | Neither proves two-process concurrent upgrades. |
| Renderer state | Effect `SubscriptionRef`/atoms/React. | HTTP bootstrap + SSE reducers into Solid stores/query caches. | Framework choice is incidental; keep DB out of renderer and expose a reactive store. |

### Verdict

Nothing in OpenCode invalidates #350's recommendation. It supplies better implementation references for Effect 4 + Node 24 and Bun, and it confirms that a 5-second busy timeout is a sensible baseline. But its central propagation assumption remains same-process publication. Laborer intentionally requires two peers that can start, migrate, and mutate with the other absent. Therefore Laborer needs the `task_changes` ledger, polling, retries, and revisions that neither reference implements end to end.

## Recommendation for Laborer (inference/adaptation)

The items in this section are recommendations, not claims about OpenCode.

### Copy

1. **One canonical database and portable SQL contract.** Resolve one global Laborer task DB path identically in `next` and `current`. Share migration SQL, persisted schema/fixtures, and behavioral tests. Keep runtime service wrappers separate because Effect 4/Node 24 and Effect 3/Bun are incompatible seams.
2. **OpenCode's connection profile on every writer:** WAL, `synchronous=NORMAL`, `busy_timeout=5000`, foreign keys, and a modest cache. A passive checkpoint on open is optional but reasonable. Keep every write transaction brief.
3. **Runtime-native drivers.** In `next`, prefer the installed Effect 4 Node SQLite support around built-in `node:sqlite`; in `current` Electron main/Bun, use its installed Effect 3 adapter or a thin `bun:sqlite` repository. Do not copy OpenCode's vendored adapter unless Laborer's installed APIs force it, and do not add `better-sqlite3` because OpenCode does not use it.
4. **Explicit migration ledger and transactional migration steps.** Either process must bootstrap alone. Preserve “refuse newer/unknown schema” behavior and prove initialization with two real OS processes. Use a cross-process migration protocol (for example a short `BEGIN IMMEDIATE` around version check/application with timeout/retry), not merely OpenCode's module semaphore.
5. **Immediate transaction when read-before-write determines identity/order.** Allocate task change sequence and mutate the task in one transaction. Publish/IPC only after commit.
6. **Stable IDs and idempotent bot writes.** Key bot cards uniquely by Execution identity and use an explicit upsert/no-op rule. Make all conflict policies visible in SQL rather than relying on incidental last-write behavior.
7. **Bounded consumers and snapshot fallback.** As OpenCode does for SSE overflow/reconnect, treat live deltas as an optimization. If a cursor is invalid/pruned or the consumer falls behind, reload one authoritative board snapshot.

### Retain from #350 because OpenCode does not provide it

1. **Transactional global change ledger.** Every task insert/update/hide commits a `task_changes(sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id, changed_at)` row in the same transaction. This is a total-order invalidation cursor, unlike OpenCode's per-aggregate event sequences.
2. **Electron-main cursor polling.** Only `current` main opens SQLite. While board subscribers exist, poll `task_changes WHERE sequence > ? ORDER BY sequence` (start around 250–500 ms), re-query affected tasks, and push typed deltas/snapshots to the renderer. Trigger the same refresh immediately after local writes. Do not watch DB/WAL files.
3. **Bounded busy retry with jitter.** A timeout handles short overlap; retry handles unlucky or bursty overlap. Classify `SQLITE_BUSY` and `SQLITE_BUSY_SNAPSHOT`, cap attempts/elapsed time, and return a typed contention error when exhausted.
4. **Per-task revision CAS.** Human edits send `expected_revision`; `UPDATE ... WHERE id=? AND revision=?` increments revision. Zero rows means stale data: refresh and surface/resolve according to domain rules. WAL only serializes bytes; it cannot decide whether a human drag or Execution status update wins.

### Do not copy

- OpenCode's full durable event/projector/replay/owner machinery for a tiny mutable board.
- Process-local `PubSub` or SSE as evidence of cross-process database observation.
- Per-aggregate sequence as the board's sole change cursor.
- Renderer database access or native driver imports.
- A migration mutex that exists only in one process.
- The remaining JSON `Storage` helper or its per-file locks.

### Required integration proof

Before relying on the design, run both real runtime stacks against one temporary file in separate OS processes and prove:

- simultaneous empty-db startup applies each migration exactly once;
- `next`-only and `current`-only startup/write work;
- racing writes either commit after bounded waiting/retry or return a typed error;
- racing edits to one task produce one CAS winner, not silent overwrite;
- every committed task mutation has exactly one visible change-ledger row;
- a late/paused Electron poll catches up by sequence and snapshot fallback;
- killing either writer during a transaction leaves a valid database and no published uncommitted state;
- an older binary refuses a schema newer than it understands.

## Evidence versus inference summary

**Verified in OpenCode:** SQLite is the current durable store; its path, schema, Drizzle/Effect adapter, Bun and built-in Node drivers, WAL/foreign-key/busy-timeout startup, automatic transactional migrations, removed one-time JSON importer, immediate per-aggregate event sequencing, atomic projector/event commits, post-commit process-local PubSub, live SSE without a global replay cursor, reconnect bootstrap, and Solid/TUI reactive reducers. External processes are not observed through SQLite and shared-database multi-host Session execution is explicitly unsettled.

**Inferred for Laborer:** share SQL rather than Effect services; harden migrations across processes; append a global transactional task-change ledger; poll it from Electron main; add bounded busy retry and task revision CAS. These are adaptations required by Laborer's two independent writers, not features to attribute to OpenCode.
