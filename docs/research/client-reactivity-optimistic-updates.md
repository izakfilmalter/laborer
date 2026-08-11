# Client reactivity and optimistic updates in OpenCode and T3 Code

Research supporting the LiveStore-removal effort in `current/`: how the two reference apps
handle (a) UI reactivity over their sqlite/server state and (b) optimistic updates, and
what `current/` should copy. Companion to `opencode-sqlite-sync.md` and
`t3code-sqlite-sync.md`, which cover the storage/sync layers; this covers the client layer.

## Executive comparison

| Concern | OpenCode | T3 Code |
|---|---|---|
| Authoritative UI feed | HTTP bootstrap + live SSE | HTTP/cache snapshot + replayable WebSocket stream |
| Client state | Solid stores, supplemented by TanStack Solid Query | Effect `SubscriptionRef` → Effect Atom → React |
| Base collection shape | Mixed: arrays plus maps grouped by parent ID | Snapshot arrays; derived atom families build indexes/maps |
| Stream durability | No global cursor/replay; reconnect refetches | Global sequence, bounded replay, snapshot fallback |
| General optimistic CRUD | No generic framework | Mostly absent for server-owned shell entities |
| Strong optimistic example | Prompt messages/parts in Solid session cache | Project-file draft overlay; mobile preferences (token-guarded) |
| Conflict/version protocol | Stable IDs, no generic row revision | Sequenced authoritative events + command IDs; no client row CAS |
| External SQLite writers | Not observed by process-local PubSub | Unsupported; one server owns SQLite |

The most reusable combination for Laborer:

1. T3's authoritative snapshot + monotonic cursor stream;
2. a separate optimistic overlay atom (T3 mobile preferences / file editor pattern);
3. OpenCode's stable client-generated identity so confirmation matches the speculative entity;
4. per-row revision CAS and client mutation IDs, which neither reference provides generically.

## OpenCode

### Store → server → UI

The renderer never reads SQLite:

```text
SQLite transaction → post-commit Effect PubSub → server SSE /api/event
  → renderer ServerSDK emitter → event reducers / queued bootstrap
  → Solid stores / query caches → components
```

Key files:

- `packages/app/src/context/server-sdk.tsx:110-255` — event stream; 250ms reconnect; ~16ms frame
  buffering; coalesces adjacent text/tool deltas; batched delivery.
- `packages/app/src/context/server-sync.tsx:461-568` — applies events to the central session cache;
  invalidates TanStack queries or schedules bootstrap for non-reducible event types.
- `packages/app/src/context/global-sync/event-reducer.ts` — incremental upserts.
- `packages/app/src/context/global-sync/queue.ts:8-72` — dedup of queued refreshes; ≤2 concurrent
  directory bootstraps.
- `packages/app/src/context/global-sync/bootstrap.ts:260-409` — authoritative pulls.

Hybrid push/pull: initial HTTP bootstrap, SSE for increments, coarse events trigger full refetch.
No global persisted event cursor — reconnect rebootsraps. Fetch/event races handled by preserving
identities touched by live events while an HTTP request was in flight
(`packages/app/src/context/server-session.ts:140-173`).

### Cache shape

Partially normalized (`packages/app/src/context/global-sync/types.ts:26-79`): ordered arrays where
rendering cares, parent-keyed records (`message: Record<sessionID, Message[]>`,
`part: Record<messageID, Part[]>`) for high-churn nested data. Not a normalized entity database.

### Optimistic updates — prompt submission (the strong path)

1. Client generates the final message ID before the request
   (`packages/app/src/components/prompt-input/submit.ts:115-139`).
2. Optimistic message/parts inserted into the session cache pre-RPC (`submit.ts:141-159`,
   `server-session.ts:1281-1314`).
3. Request carries the same ID; server SSE events arrive with those IDs and replace/confirm
   (`server-session.ts:990-1021`, `1054-1110`).
4. Failure removes only still-unconfirmed speculative state (`submit.ts:218-223`,
   `server-session.ts:1315-1337`). If an SSE confirmation beat a failed HTTP response, rollback
   does not delete the confirmed message.

Bookkeeping: `Map<sessionID, Map<messageID, OptimisticItem>>` (`server-session.ts:202-210`), with
granular confirmation and preservation across in-flight page loads. No generic optimistic patch
stack, row CAS, mutation queue, or rebase.

### Verdict

Copy: stable client-generated mutation/entity IDs; separate optimistic bookkeeping; "confirmed
event may beat RPC completion" handling; preserving live-touched identities across refetches;
snapshot fallback on reconnect. Don't copy: cursorless SSE (our cross-process ledger needs a
cursor); assuming process-local PubSub sees other SQLite writers (it doesn't — our exact problem).

## T3 Code

### Store → server → UI

```text
SQLite events + projections txn → in-memory read model → post-commit PubSub
  → replayable WebSocket subscription → SubscriptionRef → Effect Atom
  → derived atom families → @effect/atom-react hooks → React
```

- `apps/server/src/ws.ts:1180-1284` — shell subscription: attach live PubSub consumer **before**
  reading snapshot/replay; buffer live events while loading; replay persisted events after
  `afterSequence`; cursor ahead / gap too large → fresh snapshot; drain buffer; `synchronized`.
  Same pattern for thread detail (`ws.ts:1304-1429`). True snapshot+ordered-delta protocol.
- `packages/client-runtime/src/state/shell.ts:52-269` — persisted client snapshot; `empty`/
  `cached`/`synchronizing`/`live` phases; HTTP snapshot on new session; resume from
  `snapshotSequence`; 250ms retry; 500ms-debounced snapshot persistence.
- `packages/client-runtime/src/state/shellReducer.ts:12-45` — pure, sequence-guarded reduction;
  events ≤ `snapshotSequence` ignored.
- `packages/contracts/src/orchestration.ts:486-539` — snapshot `{snapshotSequence, projects[],
  threads[], updatedAt}`; every delta has a global `sequence`.

### Cache shape

Denormalized snapshot arrays; normalized *derived* views via atom families
(`packages/client-runtime/src/state/projectEntities.ts:18-105`, `threadShell.ts:32-186`), with
deliberate reference-equality retention. React consumes derived atoms via `useAtomValue`
(`apps/web/src/state/entities.ts:83-145`). No Zustand/TanStack Query for shell state.

### Optimistic updates

Shell entity mutations are generally **not** optimistic — send command → await result → consume
authoritative stream event (`packages/client-runtime/src/state/projectCommands.ts:42-105`;
rename flow `apps/web/src/components/LegacySidebar.tsx:2052-2090`). Command IDs are idempotency
tokens, not optimistic cache tokens. Keyed command scheduling (parallel / serial FIFO /
single-flight / latest-coalescing) in `packages/client-runtime/src/state/runtime.ts:87-253`.

Strong optimistic examples:

- **Project-file overlay** (`projectFilesQueryState.ts:47-108,175-198`): separate writable atom
  family; reads prefer optimistic contents; confirmation clears the overlay only if it is still
  the same optimistic object. `fileSaveCoordinator.ts:10-75` adds a local revision counter and
  serial saves — an older save can never mark a newer revision settled.
- **Mobile preferences** (`apps/mobile/src/state/preferences.ts:13-117`) — the cleanest generic
  pattern: confirmed values + optimistic patch + per-field optimistic version; completion removes
  only fields whose optimistic version still belongs to that invocation.
- **Mobile outbox** (`apps/mobile/src/state/thread-outbox-manager.ts:40-124`) — rollback by object
  reference, not just ID, so an older failed enqueue cannot remove a replacement attempt.

### Verdict

Copy: snapshot + monotonic cursor + bounded replay/snapshot fallback; subscribe-before-snapshot
race handling; Stream → Effect Atom → React bridge; derived indexes over per-table mutable client
stores; token/version guards; keyed mutation scheduling. Note: T3 does not provide optimistic
server-entity CRUD generically — it waits for the authoritative stream.

## What `current/` should copy

### Minimal state model

```ts
type AuthoritativeTable<Row> = { cursor: number; rows: ReadonlyArray<Row> }
type OptimisticEntry<Row> = {
  mutationId: string
  expectedRevision: number
  patch: Partial<Row>
}
```

1. **Authoritative snapshot atom** fed by an Effect RPC stream — whole projects/workspaces arrays
   plus ledger cursor.
2. **Optimistic overlay atom** — `Map<RowId, OptimisticEntry<Row>>`.
3. **Rendered atom** — authoritative rows with overlay applied.
4. Optional derived atom families/indexes (T3 pattern).

Full-table arrays beat normalized mutation stores at these row counts.

### Server stream

```ts
type TableUpdate<Row> =
  | { type: 'snapshot'; cursor: number; rows: ReadonlyArray<Row> }
  | { type: 'delta'; cursor: number; rows: ReadonlyArray<Row>; mutationIds?: ReadonlyArray<string> }
```

- Load rows + current cursor in one read transaction; tail ledger strictly after the cursor.
- Per poll batch: re-query affected rows and emit deltas — or, for tiny tables, emit a full
  snapshot.
- Emit immediately after the server's own local write; external writers surface within the
  250–500ms poll.
- Ignore cursors ≤ current; full-snapshot fallback on reconnect, cursor pruning, decode failure,
  or overflow.

### Optimistic drag lifecycle (kanban)

1. Generate `mutationId`; read the card's current `revision`.
2. Insert overlay patch `{status, position}`; render immediately.
3. Send `MoveCard({cardId, status, position, expectedRevision, mutationId})`.
4. Server txn: `UPDATE ... WHERE revision = expectedRevision`; bump revision; append ledger row;
   return authoritative row + committed cursor.
5. Success: clear the overlay when the stream reaches the returned cursor, or atomically install
   the returned row and clear.
6. Stale revision/rejection: remove the overlay **only if its `mutationId` is still current**;
   keep the latest authoritative row; surface the conflict.
7. Transport ambiguity: never blindly undo — the command may have committed; use `mutationId` to
   dedupe/refetch.

The "clear only if this mutation still owns the overlay" rule is the key lesson from T3; stable
client-generated identity is the key lesson from OpenCode.

### Mutation concurrency

Start with one in-flight mutation per entity, serialized by key. If repeated drags must queue:
serialize by card ID, thread the returned revision into the next command, optionally coalesce to
the latest destination.

### Final shape

```text
SQLite + change ledger
  → Effect server poll/wakeup stream
  → authoritative whole-table atom with cursor
  + separate mutation-token optimistic overlay atom
  → derived rendered atom
  → React
```
