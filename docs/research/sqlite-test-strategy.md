# SQLite test strategy for the LiveStore removal in `current/`

How Effect, T3 Code, and OpenCode test code over SQLite, and what `current/` should adopt when
`TestLaborerStore` (livestore) is replaced. Repos inspected: `Effect-TS/effect@main` (note: Effect 4
— architecture relevant, APIs not copyable into current/'s Effect 3.19), `pingdotgg/t3code`,
`anomalyco/opencode@v2`.

## Findings per repo

### Effect monorepo

Real SQLite everywhere; no fake `SqlClient` standing in for SQLite semantics.

- Scoped **temp files** for multi-connection/lock/persistence behavior:
  `packages/sql/sqlite-node/test/Client.test.ts:7-23` (two real clients on one file),
  `SqliteMigrator.test.ts:9-18` (real lock behavior + real migrator).
- **`:memory:`** where file semantics are irrelevant: `SqlEventJournal.test.ts:10`,
  `sqlite-bun/test/Client.test.ts:11-22`.
- Layer substitution only at the infrastructure boundary: production persistence layers provided
  with a real test SQLite client layer (`Persistence.test.ts:11-26`, `KeyValueStore.test.ts:8-28`),
  via `it.layer(...)`.
- Migrations are part of layer construction (`SqliteMigrator.ts:78-90`); scoped clients close via
  finalizer (`SqliteClient.ts:119-142`).

### T3 Code (closest match to Laborer's target architecture)

A reusable `SqlitePersistenceMemory` layer — real `:memory:` SQLite + production pragmas +
**complete production migration chain** + real `SqlClient` — supplied to production repository and
service layers across dozens of test files.

- `apps/server/src/persistence/Layers/Sqlite.ts:33-64` — production and test share `setup`
  (pragmas + `runMigrations()`); the only test substitution is `filename: ":memory:"`.
- `apps/server/src/persistence/NodeSqliteClient.ts:301-331` — real `node:sqlite`
  `DatabaseSync(":memory:")` with `layerMemory()`.
- Production repositories tested against migrated SQLite:
  `Layers/ProjectionRepositories.test.ts:14-22`, `Layers/OrchestrationEventStore.test.ts:15-24`;
  also `auth/SessionStore.test.ts`, `orchestration/Layers/OrchestrationEngine.test.ts`,
  `server.test.ts`, etc.
- **Migration tests construct historical states**: run migrations through version N-1, insert
  legacy rows, then exercise migration N
  (`Migrations/016_CanonicalizeModelSelections.test.ts:9-21`).
- Temp files for physical behavior: `scripts/migrate-dev-db.test.ts:66-82`,
  `ProviderService.test.ts:658-665`, integration harness
  `integration/OrchestrationEngineHarness.integration.ts:258-265`.
- Fakes exist only for unrelated external boundaries — never map-backed SQLite fakes.

### OpenCode V2

Same shape: the default test application graph uses a real in-memory SQLite with real migrations.

- `packages/core/src/database/database.ts:25-52` — one production layer (pragmas + WAL +
  `DatabaseMigration.apply`), parameterized only by path; `Database.node` is
  `configured({ path: ":memory:" })`.
- Service tests use the real db node and verify actual rows
  (`packages/core/test/session-create.test.ts:39-98`); fakes only for unrelated collaborators.
- Migration tests on real memory SQLite inspect `sqlite_master`
  (`test/database-migration.test.ts:17-27, 56-113`); temp file where two initializers must share a
  db (`:32-43`).
- Adapter-level lock contention with temp file + separate native holder
  (`packages/effect-drizzle-sqlite/test/sqlite.test.ts:102-129`).

## Recommendation for `current/`

**Real SQLite behind the same Effect Context.Tag as production.** Replace `TestLaborerStore` with a
drop-in `TestLaborerDatabase` layer that differs from production only in database path (and
possibly clock/ID inputs). Do not build fake map-backed repositories: the behavior under test is
SQLite-defined (append-only migrations + ledger, revision CAS, affected-row counts, transaction
rollback, exactly-one ledger entry per mutation, constraints, cursor ordering, busy/lock behavior,
schema-too-new). A fake would be a second untested persistence engine. Fakes stay for Slack, fs,
git, process, clock boundaries.

Two variants:

1. **Default: real `:memory:`** — fast, deterministic, production migrations run at layer
   acquisition; drop-in for most of the ~15 service test files.
2. **Scoped temp file** — for two independent writers, stale CAS across connections, WAL/lock
   contention, reopen durability, migration idempotence across reopen, older-fixture upgrades.
   (`:memory:` is private to one connection and cannot test these.) Precedent:
   `current/packages/task-db/test/task-database.test.ts:15-21, 56-74, 138-163`.

Isolation: fresh layer per test that expects an empty db; beware `@effect/vitest` `it.layer`
memoization across a block — if shared, use unique IDs.

### Effect 3 layer sketch

```ts
import { Context, Effect, Layer } from 'effect'

export class LaborerDatabase extends Context.Tag('@laborer/server/LaborerDatabase')<
  LaborerDatabase,
  { readonly database: NativeLaborerDatabase }
>() {}

const makeLaborerDatabaseLayer = (
  path: string
): Layer.Layer<LaborerDatabase, LaborerDatabaseError> =>
  Layer.scoped(
    LaborerDatabase,
    Effect.acquireRelease(
      Effect.try({
        try: () => NativeLaborerDatabase.open(path), // opens + migrates
        catch: (cause) => new LaborerDatabaseError({ operation: 'open', cause }),
      }),
      (database) => Effect.sync(() => database.close())
    ).pipe(Effect.map((database) => LaborerDatabase.of({ database })))
  )

export const LaborerDatabaseLive = makeLaborerDatabaseLayer(laborerDatabasePath())
export const TestLaborerDatabase = makeLaborerDatabaseLayer(':memory:')
```

Register the close finalizer before migrations run so a failed migration still closes the handle.
For file-backed tests, add a scoped helper: unique temp dir → `makeLaborerDatabaseLayer(join(dir,
'laborer.sqlite'))` → remove dir in the outer finalizer. The important property: production and
tests wrap the **same native class and migration path**.

### Recommended test split

1. **Native database contract tests** — migrations (fresh + historical fixtures), constraints,
   rollback, CAS + ledger atomicity, cursor bounds, schema-too-new.
2. **Effect adapter contract tests** — error mapping, scoped close, migration failure propagation.
3. **Ported service tests** — `TestLaborerStore` → `TestLaborerDatabase`, real in-memory sqlite,
   fakes only for unrelated services.
4. **Small file-backed suite** — two writers, stale CAS across handles, WAL/locking, reopen.
