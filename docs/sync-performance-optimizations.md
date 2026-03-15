# LiveStore Sync Performance Optimizations

Tracking remaining optimizations for the ~9-second `GetRecreateSnapshot` delay on initial load.

## Context

On initial load (or after any schema change), LiveStore falls back from the OPFS fast path to full rematerialization of all events in the eventlog. As of March 2025, the eventlog contains ~3,186 events with ~5MB of payload data.

The OPFS state DB filename includes a schema hash (`state${schemaHash}.db`). When the schema changes during development, the hash changes, the old cached file isn't found, and full rematerialization is triggered every time.

## Completed

### Backward-compat event stubs for deleted events

Added `Schema.Struct` definitions and no-op materializers for 6 events from the old window/tab layout model that were removed during the panel layout refactor:

- `v1.WindowLayoutRestored` (30 events)
- `v1.WindowTabSwitched` (21 events)
- `v1.WindowTabClosed` (16 events)
- `v1.WindowTabCreated` (6 events)
- `v1.PanelTabClosed` (6 events)
- `v1.PanelTabCreated` (4 events)

This eliminates ~83 `@livestore/common:schema:unknown-event` warnings per boot. The events are still skipped during materialization (no-op), but LiveStore no longer needs to log a warning for each one.

**Impact**: Minor — these events were already skipped cheaply. The main benefit is cleaner logs.

## Remaining Optimizations

### 1. Reset the server-side eventlog (nuclear option, quick dev win)

Delete the sync database to start fresh:

```bash
rm ~/.config/laborer/data/sync-laborer.db*
```

Then clear browser OPFS data (append `?reset` to URL in dev mode). Drops eventlog to 0 events, making rematerialization instant.

**Impact**: Immediate fix for development. Not a production solution.

### 2. Reduce `v1.DiffUpdated` event frequency

315 diff events with 4.1MB total payload is the single biggest contributor to eventlog size. The diff service polls and emits events even when content hasn't changed.

Options:
- Only emit `v1.DiffUpdated` when diff content actually changes (content hash check)
- Store diffs outside LiveStore entirely — they're ephemeral state, not really event-sourced data
- Debounce diff updates to reduce frequency

**Impact**: High — would reduce eventlog size by ~80% and cut rematerialization time proportionally.

### 3. Reduce `v1.LayoutPaneAssigned` volume

1,367 pane assignment events is high. Each carries a full `PanelNodeSchema` JSON tree (~780KB total).

Options:
- Debounce rapid layout changes
- Coalesce sequential layout events for the same window

**Impact**: Medium — second largest event type by count.

### 4. LiveStore upstream issues (not actionable by us)

These are performance characteristics of LiveStore's rematerialization path:

- **No transaction batching during rematerialization**: Each event is materialized with its own autocommit. The sync `materializeEventsBatch` path wraps batches in `BEGIN/COMMIT`, but `rematerializeFromEventlog` does not.
- **In-memory DB optimization disabled**: `recreate-db.ts` has a `TODO bring back` comment for rematerializing into an in-memory DB instead of writing directly to OPFS-backed SQLite.
- **Double schema decode per event**: Event args are decoded once for validation in `rematerializeFromEventlog`, then again inside `getExecStatementsFromMaterializer`.
- **Changeset tracking during rematerialization**: Every event records a changeset in `SESSION_CHANGESET_META_TABLE` for rollback support, but during initial rematerialization from clean state this is unnecessary overhead.

**Impact**: These are the fundamental reasons rematerialization is slow per-event. Would need upstream changes to LiveStore.
