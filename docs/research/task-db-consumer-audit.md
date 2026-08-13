# Audit of `current` task-db consumers for the shared-wrapper swap

Issue: [#476](https://github.com/izakfilmalter/laborer/issues/476)

## Executive finding

`apps/desktop/` has **11 source-file importers** of the package (counting its three public entry points) plus the package's own Bun-specific test suite. None consumes `TaskDb` or the Drizzle handle, and none imports `@laborer/task-db/schema`. Most server code already executes on Node-compatible runtimes and uses its own `DatabaseSync` adapters. The swap therefore has two real upstream requirements: retain the `taskDatabasePath` and `taskDbMigrations` public entry points, and add `TaskSnapshot`, `TaskDelta`, `TaskRead`, `NativeTaskDatabase.snapshot()`, `NativeTaskDatabase.readChanges()`, and the corresponding `TaskDb` service methods to the shared Node wrapper.

The largest migration work is internal to `packages/task-db`: replace `bun:sqlite`/Bun Drizzle setup and `.query()` calls with `node:sqlite` `DatabaseSync`/`.prepare()`, then convert its Bun-only tests. Server-side `NodeTaskBoardDatabase` and `NativeLaborerDatabase` already prove the same migrations and snapshot/cursor algorithms work with `DatabaseSync`.

## Import inventory and exact surface

A literal grep for `@laborer/task-db` finds these source consumers (lockfile/package metadata omitted):

| Importer | Imported surface | Actual use / compatibility |
|---|---|---|
| `packages/server/src/services/laborer-database.ts:4` | `taskDatabasePath` from `/path` | Default path for `LaborerDatabase.layer` at lines 64-68. Compatible if the shared package preserves `/path` (or call site is redirected to the root export). |
| `packages/server/src/services/native-laborer-database.ts:5` | `taskDbMigrations` from `/migrations` | Its independent `DatabaseSync` wrapper applies and hashes the shared migration list at lines 1307-1347. Compatible if `/migrations` stays exported. It does **not** use `NativeTaskDatabase`. |
| `packages/server/src/services/node-task-board-database.ts:5-15` | Type-only `ExecutionStatus`, `NewTask`, `Task`, `TaskPatch`, `TaskRead`, `TaskSnapshot`, `TaskSource`, `TaskStatus`; runtime `taskDbMigrations` | Basic types remain in next. `TaskRead` and `TaskSnapshot` are absent from next today and break typechecking until upstreamed. Migrations are applied at lines 620-655. This file is itself a duplicate Node wrapper, not a consumer of `NativeTaskDatabase`. |
| `packages/server/src/services/agent-task-service.ts:5-6` | Type-only `Task`, `TaskStatus`; runtime `taskDatabasePath` | Types annotate the Effect service at lines 127-150; path selects the DB for `NodeTaskBoardDatabase` at lines 152-175. Compatible with preserved exports. Uses `snapshot().tasks`, `find`, `insert`, `update` on the *local* adapter at lines 199-295. |
| `packages/server/src/services/task-board-reader.ts:2-3` | Type-only `TaskRead`; runtime `taskDatabasePath` | `TaskRead` drives snapshot/delta event conversion at lines 17-27; path opens local Node adapter at lines 35-45. Missing `TaskRead` breaks compilation. Local `snapshot`/`readChanges` are used at lines 51-83. |
| `packages/server/src/services/task-card-creator.ts:5-6` | Type-only `TaskPatch`, `TaskStatus`; runtime `taskDatabasePath` | Types at lines 21 and 112-135; default path throughout (for example lines 143-163 and 190-193). Calls local Node adapter `find`/`insert`/`update`, not shared `NativeTaskDatabase`. Compatible with retained path/types. |
| `packages/server/src/services/pr-task-transitions.ts:1` | `taskDatabasePath` | Opens the local Node adapter at lines 43-53. Compatible with retained path export. |
| `packages/server/src/services/worktree-task-translator.ts:3` | `taskDatabasePath` | Default target at lines 42-58; operations use the local adapter/interface. Compatible with retained path export. |
| `packages/server/src/services/shared-state-reader.ts:6` | `taskDatabasePath` | Default path at lines 77-92 for the independent, broader `NativeLaborerDatabase`. Compatible with retained path export. |
| `packages/server/src/task-mcp-runtime.ts:5` | `taskDatabasePath` | Selects the DB shared by `LaborerDatabase` and `AgentTaskService` at lines 41-47. Compatible with retained path export. |
| `packages/server/src/rpc/handlers.ts:21-22` | Type-only `Task`, `TaskStatus`; runtime `taskDatabasePath` | Types support move/provisioning code (for example lines 200-236); path is used by handlers further in the module. Compatible with retained exports. Database operations target the two server-local Node wrappers (`NativeLaborerDatabase` and `NodeTaskBoardDatabase`), imported at lines 28-39. |

The package declares the relevant subpath exports at `packages/task-db/package.json:11-15`. `@laborer/server` is the only workspace package declaring a dependency (`packages/server/package.json:18-23`).

### Tests

`packages/task-db/test/task-database.test.ts` imports implementation modules relatively rather than through `@laborer/task-db` (`:1-13`), but it is a direct migration obligation. It uses Bun's `Database`, Bun test, and `.query()` extensively (`:1-2`, fixture setup at `:33-119`, raw assertions/mutations at `:151-192`, `:216-246`, `:277-285`, `:454-461`, `:479-503`). Its behavioral coverage includes migrations, CAS errors, idempotent inserts, bounded ledger reads, snapshots/deltas, cursor fallback, persisted checks, and schema-too-new errors (`:128-507`).

Server tests do not import `@laborer/task-db` directly; they exercise the server-local wrappers. For example, the MCP integration uses `NativeLaborerDatabase` (`packages/server/test/task-mcp-stdio.test.ts:17,143-154`).

## Breakage against next's wrapper

### Definite API breaks

1. **Snapshot/delta types and methods are absent.** Current defines `TaskSnapshot`, `TaskDelta`, and `TaskRead` at `packages/task-db/src/task-database.ts:52-65`; next goes directly from `Task` to `NewTask` at `apps/bot/src/task-db/task-database.ts:30-48`. Current's native methods are `snapshot()` and `readChanges()` at `apps/desktop/.../task-database.ts:341-382`, and its Effect contract exposes both at `:718-722,747-750`. Next's native class and service omit them (`apps/bot/.../task-database.ts:318-448` and `:572-617`). Consequently `node-task-board-database.ts` and `task-board-reader.ts` cannot import their read types after a straight swap, and future replacement of the local adapter cannot provide board subscriptions until these methods are upstreamed.

2. **Public subpaths must survive packaging.** Current callers import `/path` and `/migrations`, while next currently keeps path resolution inline in `task-database.ts:257-267` and imports migrations relatively at `:7`. The merged package needs compatible exports (or every listed call site must change).

### Implementation/test breaks

3. **SQLite constructor and statement API differ.** Current package imports Bun `Database` and Bun Drizzle at `apps/desktop/.../task-database.ts:1,5`, constructs with `{ create: true, strict: true }` at `:315`, and uses `database.query(...).get/all/run` throughout (`:334-337`, `:391-412`, `:456-460`, `:483-487`, `:498-501`, `:575-577`, `:588-624`). Next imports `DatabaseSync` at `apps/bot/.../task-database.ts:5`, constructs it with `{ timeout: 5000 }` at `:299`, and uses `.prepare()` (`:318-321`, `:335-357`, `:401-405`, `:428-447`, `:457-507`). Snapshot/delta SQL must use `.prepare()` as the already-Node implementation in `packages/server/src/services/node-task-board-database.ts:208-299,595-617` demonstrates. `node:sqlite` returns no-row as `undefined` (next `:322,454`), whereas current's Bun wrapper checks `row == null` (`apps/desktop/.../task-database.ts:338,511`).

4. **The Drizzle runtime handle disappears.** Current constructs `readonly drizzle: BunSQLiteDatabase<typeof schema>` (`apps/desktop/.../task-database.ts:283-290`). Next has no Drizzle runtime import/field; raw SQL owns runtime behavior. No external current consumer references `.drizzle` (repository search only finds its declaration/assignment), so removal breaks only code/types inside the old package, not a call site.

5. **Error handling is coupled in a few server-local adapters.** The package's four error classes are ordinary `Error` subclasses in both copies today (current `:96-135`; next `:77-117`), and `TaskDb` preserves three classes via `instanceof` while wrapping other failures (`current :690-705`; next `:555-570`), so a straight current-to-next class-style change is not itself a break. However, server-local code does not consistently consume these classes: `NodeTaskBoardDatabase.update` throws message-only stale errors (`packages/server/src/services/node-task-board-database.ts:344-370`); `task-card-creator.ts:112-133` retries by matching `'stale revision'`; `agent-task-service.ts:104-124` classifies by message; and `rpc/handlers.ts:200-210` uses the separate `LaborerDatabaseStaleRevisionError`. Replacing local operations with shared `NativeTaskDatabase` would require mapping `TaskStaleRevisionError` explicitly or preserving compatible messages. Current coding guidance prefers `Schema.TaggedErrorClass` for expected Effect failures (`apps/desktop/AGENTS.md:38`), but that is a modernization decision, not an existing next-wrapper difference.

### Not a direct wrapper swap

`NativeLaborerDatabase` is a substantially broader Node wrapper (projects, settings, richer task columns, mutation IDs, delete/move operations) and only imports migrations. Its task shape spans `packages/server/src/services/native-laborer-database.ts:31-180`, and its operations continue far beyond shared `NativeTaskDatabase`. Replacing it wholesale with next's narrow wrapper would break this broader API; the immediate shared-wrapper decision should not imply that replacement without a separate design.

Likewise, `NodeTaskBoardDatabase` adds server-specific `move`, worktree adoption, and PR transition operations (`apps/desktop/.../node-task-board-database.ts:380-593`). Upstreaming snapshot/delta enables its read path to collapse onto shared code, but does not cover these extra writes.

## Runtime constraints and `node:sqlite` availability

There are three relevant execution contexts:

1. **Desktop server:** server services (including both local database wrappers and all source importers used by RPC) run in an Electron utility process, not the Electron main process. `packages/server/src/utility-main.ts:1-10` states this explicitly and lines 23-30 include `LaborerDatabaseLive` in that process. The desktop resolves `packages/server/dist/utility-main.mjs` (`apps/desktop/src/utility-process-manager.ts:127-146`) and forks it via Electron `utilityProcess.fork` (`:243-272`). Thus the production DB host is the server utility process; the main process only manages it.

2. **Task MCP:** the MCP is a standalone stdio child launched with an external Node executable. Its entry checks the running Node before dynamically importing the runtime (`packages/server/src/task-mcp-main.ts:3-14`); the integration test spawns `process.execPath` (`packages/server/test/task-mcp-stdio.test.ts:41-46`) and asserts Node 23 is rejected with “Node.js 24 or newer” (`:114-133`). The bundled runtime then uses `LaborerDatabase`/`AgentTaskService` and the shared DB path (`packages/server/src/task-mcp-runtime.ts:41-57`). The build deliberately keeps the guarded launcher separate “so an old Node never resolves node:sqlite” (`packages/server/tsdown.config.ts:35-46`).

3. **Package tests/development:** the old task-db package declares `bun test` (`packages/task-db/package.json:6-9`) and its tests directly use `bun:sqlite`. These must move to the merged package's Node-capable test setup or otherwise run a Node subprocess; retaining them unchanged is the only Bun-specific runtime blocker found.

Current pins Electron `40.6.0` (`apps/desktop/package.json:15-18`). Electron 40 embeds Node 24.11.1 according to the official Electron 40 release announcement, which is well past the introduction of `node:sqlite`: <https://electronjs.org/blog/electron-40-0>. More importantly, this is already proven in-repository rather than merely inferred: both `NativeLaborerDatabase` and `NodeTaskBoardDatabase` import `DatabaseSync` (`packages/server/src/services/native-laborer-database.ts:1-5`; `node-task-board-database.ts:1-5`) and are used in the server utility-process composition/subscriptions. The MCP enforces Node 24 before loading the same code. Therefore `node:sqlite` is available in every production context that hosts current's task-db behavior.

## Full snapshot/delta/read surface to upstream

The public data contracts are exactly:

```ts
export interface TaskSnapshot {
  readonly _tag: 'snapshot'
  readonly cursor: number
  readonly tasks: readonly Task[]
}

export interface TaskDelta {
  readonly _tag: 'delta'
  readonly cursor: number
  readonly deletedTaskIds: readonly string[]
  readonly tasks: readonly Task[]
}

export type TaskRead = TaskSnapshot | TaskDelta
```

Source: `packages/task-db/src/task-database.ts:52-65`.

The corresponding native/service API is:

- `NativeTaskDatabase.snapshot(): TaskSnapshot` (`:341-343`).
- `NativeTaskDatabase.readChanges(sequence: number, limit = 1000): TaskRead` (`:345-382`).
- `TaskDb.snapshot(): Effect<TaskSnapshot, TaskDbFailure>` and `TaskDb.readChanges(sequence, limit?): Effect<TaskRead, TaskDbFailure>` (`:707-733`), wired at `:743-756`.

Behavior that must be retained:

- snapshots and deltas execute inside a deferred read transaction (`:341-343,353-381,647-663`);
- cursor and limit validation (`:345-351`);
- fallback to a complete snapshot if the cursor is ahead, the ledger is empty after a nonzero cursor, history has been pruned, or returned sequences are noncontiguous (`:353-361,514-549`);
- delta IDs are deduplicated, current rows returned, and missing rows reported through `deletedTaskIds` (`:363-380`);
- snapshots are bounded to 10,000 rows and atomically pair rows with `MAX(task_changes.sequence)` (`:147,551-572`).

The logic itself is SQLite-generic. The Bun-specific porting work is mechanical:

- `Database` -> `DatabaseSync` and Bun constructor options -> Node options;
- every `.query(sql)` -> `.prepare(sql)`;
- adapt no-row checks to `undefined`;
- remove `BunSQLiteDatabase`, `drizzle(database, { schema })`, and the `drizzle` property;
- port test fixtures/raw probes from Bun `Database`/`.query()` to Node `DatabaseSync`/`.prepare()` and run them under a Node-capable runner.

`packages/server/src/services/node-task-board-database.ts:208-299,595-617,707-721` is a line-for-line Node reference for this read behavior. The shared wrapper should absorb the canonical version, after which duplicate read code can be removed or delegated.

## Drizzle schema consumption

Runtime schema consumption is confined to the old wrapper itself: it imports `taskChanges`/`tasks`, creates `schema`, and passes it to Bun Drizzle (`packages/task-db/src/task-database.ts:5,9-11,286-290`). No file in `apps/desktop/` imports `@laborer/task-db/schema`, and no external use of `.drizzle` exists. The schema export is therefore currently unused outside declaration/build tooling. It can remain as a declaration-only Drizzle schema, matching next's direction, without runtime consumer breakage.

The migrations are different: they are runtime inputs in both server Node wrappers, and the server bundle copies SQL next to its output because `migrations.ts` reads those files at import time (`packages/server/tsdown.config.ts:8-19`). Packaging must preserve this asset behavior even though the schema declaration is not a runtime dependency.

## Recommended implementation sequence

1. Package next's Node wrapper with stable root, `/path`, `/migrations`, and `/schema` exports.
2. Port the snapshot/delta contracts and bounded transactional read implementation into that wrapper and expose them through `TaskDb`.
3. Port `packages/task-db` behavioral tests to `DatabaseSync` and run them against the shared package.
4. Redirect or remove `NodeTaskBoardDatabase`'s duplicate basic read/CRUD operations while retaining its server-specific move/adoption/PR extensions until separately designed.
5. Leave `NativeLaborerDatabase` as the current legacy aggregate for now; only point its migrations/path imports at the shared package and separately reconcile its broader schema/API.
