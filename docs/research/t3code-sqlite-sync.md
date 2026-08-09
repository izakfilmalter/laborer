# T3 Code's SQLite synchronization layer, and the slice Laborer should copy

Research for [#350](https://github.com/izakfilmalter/laborer/issues/350), under the map in [#349](https://github.com/izakfilmalter/laborer/issues/349).

Source inspected: `pingdotgg/t3code` at `963ebf5bd7cce00d40ff60c258b34c12dcab271e` (2026-08-09).

## Executive answer

T3 Code does **not** synchronize independent SQLite writers. One T3 server process owns SQLite and serializes all orchestration commands through one in-memory queue. Web, Electron-renderer, and mobile clients never open the database; they send commands to that server and receive an initial snapshot plus ordered domain events over a durable WebSocket subscription. SQLite WAL improves the server's local read/write behavior, but it is not the UI notification mechanism.

Laborer therefore cannot copy T3 Code's whole coordination design while retaining the requirement that `next/` and `current/` independently write the same file. It should copy only these ideas:

1. one canonical database path and an automatically migrated schema;
2. WAL, foreign keys, short atomic transactions, stable IDs, and idempotent writes;
3. an authoritative snapshot followed by monotonic change cursors, with duplicate suppression;
4. a reactive UI state holder fed from a process boundary, not SQLite in the renderer.

For the experiment, both Laborer processes should open the task database directly and let SQLite serialize brief writes. Add a busy timeout and bounded `SQLITE_BUSY` retry, which T3 Code's normal setup notably does not add. Every mutation should atomically update the task and append a small row to a monotonic `task_changes(sequence, task_id, changed_at)` table. `current`'s Electron main process should poll changes after its last sequence (250–500 ms while the board is visible), re-query affected tasks, and push snapshots/deltas over the existing main-to-renderer boundary; local writes should trigger the same refresh immediately. This is smaller and more reliable than filesystem watching, and it continues to work when either app is absent.

## Architecture found (evidence)

### Database location and ownership

- The server derives `stateDir` as `<baseDir>/userdata` in normal operation or `<baseDir>/dev` for non-explicit development homes, then sets `dbPath` to `<stateDir>/state.sqlite` (`apps/server/src/config.ts:99-132`). T3 Code's own contributor guide names the normal live location as `~/.t3/userdata/state.sqlite` (`AGENTS.md`, “Test data”).
- The Electron app does not embed a second persistence implementation in the renderer. It spawns a backend server child in Node mode (`apps/desktop/src/backend/DesktopBackendManager.ts:435-499`), and clients communicate with servers over HTTP/WebSocket. The repository overview states this directly: “A Node WebSocket server wraps provider CLIs … and serves web, desktop, and mobile clients” (`AGENTS.md`, opening description and “How it works”).
- Multiple desktop backend *instances* are separate environments (for example primary Windows and WSL), listening on different ports and reporting distinct environment IDs (`apps/desktop/src/backend/DesktopBackendPool.ts:1-78`). This is not two processes sharing one SQLite writer domain.

### SQLite libraries: Effect SQL, not Drizzle

- Runtime persistence uses Effect 4's SQL interfaces and direct SQL templates (`effect/unstable/sql/SqlClient` and `SqlSchema`). There are no Drizzle imports in `apps/server/src/persistence`; repository implementations issue `INSERT`, `SELECT`, and `ON CONFLICT` SQL directly (for example `apps/server/src/persistence/Layers/OrchestrationEventStore.ts:99-209` and `apps/server/src/persistence/Layers/ProjectionProjects.ts`).
- On Bun, the loader uses `@effect/sql-sqlite-bun/SqliteClient`; on Node, it uses T3 Code's local `NodeSqliteClient` (`apps/server/src/persistence/Layers/Sqlite.ts:16-31`). The inspected lock/catalog pins Effect and the Bun SQLite adapter to `4.0.0-beta.103` (`pnpm-workspace.yaml:33-47`).
- `NodeSqliteClient` is a port of Effect's SQLite Node adapter onto the built-in synchronous `node:sqlite`, explicitly not `better-sqlite3` (`apps/server/src/persistence/NodeSqliteClient.ts:1-7`). It requires Node versions with `StatementSync.columns()`, opens one `DatabaseSync`, caches prepared statements, and wraps access to that one connection with a one-permit Effect semaphore (`apps/server/src/persistence/NodeSqliteClient.ts:70-92, 105-186, 264-299`).
- T3 Code has a transitive Drizzle installation elsewhere in its monorepo lockfile, but the SQLite persistence layer under investigation does not use it.

### Schema and migrations

- Startup creates the database directory, opens the client, enables `PRAGMA foreign_keys = ON`, switches to `PRAGMA journal_mode = WAL`, and runs migrations before exposing the persistence layer (`apps/server/src/persistence/Layers/Sqlite.ts:33-58`).
- Migrations are statically imported Effect programs containing direct DDL/DML. `Migrator.fromRecord` orders entries by numeric ID; Effect's migrator creates/uses `effect_sql_migrations` and runs pending entries automatically (`apps/server/src/persistence/Migrations.ts:1-8, 15-55, 57-125, 131-150`).
- The durable source is an append-only `orchestration_events` table with an autoincrement global `sequence`, unique `event_id`, and unique `(aggregate_kind, stream_id, stream_version)` (`apps/server/src/persistence/Migrations/001_OrchestrationEvents.ts`). Materialized query tables and per-projector sequence watermarks are created separately (`apps/server/src/persistence/Migrations/005_Projections.ts`).
- The schema is not declared through an ORM model. Runtime boundary validation uses Effect Schema/`SqlSchema`; for example event insert requests and returned rows are schema-decoded around direct SQL (`apps/server/src/persistence/Layers/OrchestrationEventStore.ts:31-67, 99-209`).

### Write path and coordination

The write path is single-process and single-command-worker:

1. RPC handlers dispatch typed commands to the orchestration engine (the server wiring is in `apps/server/src/ws.ts`; the engine contract is `apps/server/src/orchestration/Services/OrchestrationEngine.ts`).
2. `dispatch` puts each command envelope into one unbounded queue and awaits its `Deferred` result (`apps/server/src/orchestration/Layers/OrchestrationEngine.ts:79-92, 303-321`).
3. One forever-running worker drains that queue sequentially (`apps/server/src/orchestration/Layers/OrchestrationEngine.ts:300-305`).
4. For an accepted command, one SQL transaction appends its event(s), projects them into query tables, and writes the idempotency receipt before commit (`apps/server/src/orchestration/Layers/OrchestrationEngine.ts:138-213`).
5. Only after commit does the engine replace its in-memory read model and publish events to its in-process `PubSub` (`apps/server/src/orchestration/Layers/OrchestrationEngine.ts:215-231`).

There are two additional serialization layers: T3's Node adapter permits only one operation on its connection at a time (`apps/server/src/persistence/NodeSqliteClient.ts:264-280`), and each projector records its watermark in a transaction and all projectors run with concurrency 1 (`apps/server/src/orchestration/Layers/ProjectionPipeline.ts:1648-1704`).

WAL is enabled, but the normal server setup does not configure `busy_timeout`, implement a database-level lease, or coordinate an external peer writer (`apps/server/src/persistence/Layers/Sqlite.ts:33-39`). A maintenance CLI sets `busy_timeout = 5000`, while a destructive migration helper deliberately sets it to zero to detect an in-use database (`apps/server/scripts/t3-sqlite-state.ts:204`; `apps/server/scripts/migrate-dev-db.ts:213`). Those scripts reinforce that external tooling is exceptional, not the live write architecture.

### Change propagation: commit → PubSub → WebSocket

SQLite itself emits no application notification in this design.

- After a transaction commits, the orchestration engine publishes each event to an Effect `PubSub`; every access to `streamDomainEvents` creates a fresh subscription (`apps/server/src/orchestration/Layers/OrchestrationEngine.ts:215-217, 323-336`).
- `subscribeShell` attaches a live PubSub consumer to an in-memory queue **before** reading a snapshot. It then sends either a snapshot or persisted catch-up events, followed by buffered/live events. This ordering closes the snapshot/subscription race (`apps/server/src/ws.ts:1178-1203, 1233-1281`).
- Resuming clients send `afterSequence`. The server replays persisted events through a captured head; if the cursor is ahead or the gap exceeds a bound, it sends a fresh snapshot instead (`apps/server/src/ws.ts:1233-1271`).
- Thread detail uses the same pattern: attach live first, replay through a bounded head or fall back to a fresh snapshot, then consume buffered/live events (`apps/server/src/ws.ts:1302-1427`).
- The shell stream coalesces bursts before doing projection refetches (`apps/server/src/ws.ts:1182-1186, 1202`; coalescing helpers are earlier in the same file). Thus events are invalidation/cursor signals and the server can return current projected rows, rather than treating SQLite as reactive.

There is no polling of SQLite, `fs.watch` of `state.sqlite`/`-wal`, SQLite update hook, or reactive-query ORM in this path. `FileSystem.watch` occurrences in the server concern settings, Git traces, and other files, not the task/read-model database.

### Conflict handling and offline behavior

T3 Code prevents most write conflicts architecturally rather than reconciling them:

- One queue decides commands against one in-memory read model. Stable command IDs are persisted as receipts, so retries return the accepted sequence or the prior rejection instead of applying twice (`apps/server/src/orchestration/Layers/OrchestrationEngine.ts:138-151, 190-198, 312-321`).
- Event IDs and stream versions have uniqueness constraints (`apps/server/src/persistence/Migrations/001_OrchestrationEvents.ts:8-28`). Projection repositories use explicit `ON CONFLICT` rules (for example `apps/server/src/persistence/Layers/ProjectionProjects.ts:29-61`). These are deterministic server policies, not client-side merge algorithms.
- A failed transaction is reconciled by reading persisted events after the prior in-memory sequence, projecting them, and publishing them (`apps/server/src/orchestration/Layers/OrchestrationEngine.ts:105-126, 264-277`).

Clients can render cached snapshots while disconnected. Shell state loads a persisted client cache, reports `cached`/`synchronizing`/`live`, retries expected subscription failures, and persists updated snapshots after a debounce (`packages/client-runtime/src/state/shell.ts:30-77, 79-107, 181-267`). On reconnect it obtains an authoritative HTTP snapshot when needed, then resumes from its sequence; duplicate or overlapping events are ignored by sequence (`packages/client-runtime/src/state/shell.ts:138-179, 187-253`). Thread detail follows the same cache/snapshot/resume pattern and discards events at or below its last sequence (`packages/client-runtime/src/state/threads.ts:134-210, 317-367, 534-645`).

This is offline **reading and reconnect catch-up**, not offline mutation sync. No client writes a local SQLite replica or merges concurrent offline edits.

### Renderer reactivity

- Client-runtime turns a WebSocket stream into an Effect `SubscriptionRef`, applying snapshot/event items through pure reducers (`packages/client-runtime/src/state/shell.ts:69-73, 138-179, 187-269`; thread equivalent in `packages/client-runtime/src/state/threads.ts:155-188, 317-406`).
- `runtime.atom(stream, { initialValue })` exposes those state changes as Effect reactive atoms; atom families provide per-environment and per-thread identities (`packages/client-runtime/src/state/shell.ts:393-414`; `packages/client-runtime/src/state/threads.ts:696-724`).
- Derived atoms index and group the shell snapshot (`packages/client-runtime/src/state/threadShell.ts:32-184`). React hooks call `useAtomValue` on those atoms; for example `useThreadShells()` and `useThreadShellsForProjectRefs()` are in `apps/web/src/state/entities.ts:119-131`. The web app wires the runtime atom families in `apps/web/src/state/shell.ts:14-23`.

So the reactive chain is **server commit → in-memory event publication → WebSocket snapshot/events → SubscriptionRef → Effect Atom → React**. It is not **SQLite → renderer query subscription**.

## What Laborer should copy

The following is a recommendation/inference for Laborer, not a claim about existing T3 Code behavior.

### Copy

1. **Canonical path and a tiny persistence boundary.** Put one task database under the Laborer global state root, not under a project or `current`'s Electron user-data/LiveStore directory. Both apps resolve the identical path. Expose task operations through a small repository contract in each Effect generation; share persisted schemas/SQL as framework-neutral data where practical, but do not try to share Effect 3 and Effect 4 service code.
2. **Plain versioned SQL migrations.** Keep an ordered manifest of small SQL migrations and one migration ledger. Both processes must be able to initialize/upgrade because either may start alone. Serialize startup migration with SQLite (an exclusive/immediate transaction plus busy timeout), make each migration transactional, and reject database schema versions newer than the binary understands. Do not copy T3's 40-file event-sourced projection stack or its Effect 4 migrator into `current`.
3. **SQLite safety settings on every connection.** Enable WAL and foreign keys; also set a meaningful busy timeout (for example 5 seconds). Keep transactions short and add a bounded retry with jitter for `SQLITE_BUSY`/`SQLITE_BUSY_SNAPSHOT`. T3's WAL setting is useful, but its in-process queue is why it can omit normal multi-process contention handling.
4. **Stable identity and explicit conflict semantics.** Bot-created rows should key uniquely by Execution identity so replayed emission is an upsert/no-op. Add a monotonically increasing `revision` to each task. Human edits use compare-and-swap (`UPDATE ... WHERE id = ? AND revision = ?`) and return an explicit stale-write result, then refresh. This avoids silent last-writer-wins when a system status update and a drag race.
5. **Snapshot + cursor propagation.** Add `task_changes(sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id, changed_at)` and append one row in the same transaction as every task mutation. A reader loads an authoritative board snapshot plus current max sequence in one read transaction, then polls `task_changes WHERE sequence > ? ORDER BY sequence`. Deduplicate by sequence and fall back to a full snapshot if its cursor is missing/too old. This is the minimal analogue of T3's event sequence and snapshot/live race handling without adopting event sourcing.
6. **Main-process reactive adapter.** Only Electron main/Bun should open the shared DB. It polls while a board subscriber exists, immediately refreshes after its own writes, and pushes typed snapshots/deltas to the renderer over the app's existing process boundary. Renderer state can be a current-compatible reactive store/hook; it should never watch SQLite files or import a native driver. The UI derives columns from that state, as T3's React UI derives views from atoms.

### Do not copy

- **Do not add Drizzle or `better-sqlite3` because of T3 Code.** Its persistence path uses neither.
- **Do not copy T3's custom `NodeSqliteClient`.** `next/` already has the Effect 4 Node SQLite adapter, and `current` is Bun/Effect 3. Use the runtime-appropriate installed adapter or a thin `bun:sqlite` boundary in `current`; share the file format and SQL contract, not the driver implementation.
- **Do not copy the full command/event/projector/read-model architecture.** The board needs one small mutable task model, not an orchestration event store plus nine projections.
- **Do not copy the WebSocket server solely for local DB invalidation.** T3 needs sockets for remote and multi-surface clients. Laborer's two local independent writers have no always-present owner, so a socket owner would either violate independence or introduce a third service.
- **Do not use `fs.watch` on `state.sqlite` or its WAL files.** WAL writes can touch `-wal`/`-shm`, checkpointing changes files, events coalesce, and rename/watch behavior is platform-dependent. Polling a monotonic SQL cursor is deterministic and testable.
- **Do not assume WAL resolves semantic conflicts.** It serializes database writes; it does not decide whether a human drag or Execution-driven transition should win.

## Mapping to Laborer's two-process constraint

| Situation | Recommended behavior |
| --- | --- |
| Only `next` daemon runs | It opens/migrates the shared DB, upserts the Execution-keyed task and appends `task_changes`; no UI or broker is required. |
| Only `current` runs | Electron main opens/migrates the same DB, creates/edits manual tasks, and locally notifies its board subscriber immediately. |
| Both run | WAL allows readers during a writer; SQLite serializes brief write transactions; busy timeout/retry handles overlap. Current's cursor poll observes `next` commits and refreshes affected cards. |
| Both edit one task | Revision compare-and-swap makes the loser explicit; it refreshes instead of silently overwriting. Domain tickets must still decide which fields/system transitions humans may override. |
| Current starts late or resumes | It reads an authoritative snapshot and max sequence, then tails later changes. No missed file-watch window exists. |
| Current is closed during `next` writes | Changes remain in SQLite. On next launch, the snapshot includes them; retained `task_changes` only support efficient live catch-up. |
| Schema versions differ | Older binary refuses a newer schema; concurrent upgrades serialize under SQLite. Either process can bootstrap when alone. |

### Suggested minimal transaction

```sql
BEGIN IMMEDIATE;

UPDATE tasks
SET status = :status,
    revision = revision + 1,
    updated_at = :updated_at
WHERE id = :id
  AND revision = :expected_revision;

-- Require exactly one changed row, or return StaleTaskRevision.
INSERT INTO task_changes(task_id, changed_at)
VALUES (:id, :updated_at);

COMMIT;
```

Creation should use a stable primary key and/or a unique Execution ID with an explicit `ON CONFLICT` policy. The exact columns and ownership rules belong in later #349 design tickets.

## Risks and open decisions

- Cross-version migration behavior needs a focused two-process integration test: start two real runtime-specific connections against one temporary file, race initialization, race writes, and prove cursor catch-up. T3's single writer does not supply this proof.
- `current` and `next` use incompatible Effect major versions. Sharing generated TypeScript repository code is likely more coupling than value; share migration SQL, persisted wire/domain schemas, and behavioral tests/fixtures instead.
- Poll cadence trades latency for wakeups. Start at 250–500 ms only while the board has a subscriber, back off or stop when hidden, and measure before adding IPC/socket complexity.
- A change ledger needs retention. For this experiment it can remain tiny; later compact entries below the minimum active cursor or simply keep them while task volume is low. Every startup still begins from a snapshot, so pruning never loses state.
- Revision checks detect conflicts but do not establish field ownership. Follow-up specs must say whether Execution-driven state may overwrite a human move and how derived “In Review” interacts with stored status.

## Verified versus inferred summary

**Verified in T3 Code:** one server owns SQLite; direct Effect SQL on Bun or built-in `node:sqlite`; WAL and foreign keys; ordered automatic migrations; one queued command worker; transactional event/projection/receipt writes; post-commit in-memory PubSub; snapshot/cursor replay/live WebSocket streams; cache-backed reconnect; SubscriptionRef/Effect Atom/React reactivity; no SQLite file watch or reactive ORM for this path.

**Inferred/recommended for Laborer:** direct two-process access with busy handling; revision compare-and-swap; a compact change ledger; polling from Electron main and pushing to renderer; sharing SQL contracts rather than Effect implementations. These are adaptations required because Laborer's stated independent-writer constraint is materially different from T3 Code's architecture.
