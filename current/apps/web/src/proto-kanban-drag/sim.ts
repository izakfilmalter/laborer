/** biome-ignore-all lint: throwaway prototype for issue #407 — not production code */
/**
 * PROTOTYPE (#407) — optimistic kanban drag feel. Throwaway.
 *
 * Simulated in-memory "server" (stand-in for laborer.sqlite + the
 * state_changes ledger behind an Effect RPC stream) plus the locked client
 * loop from docs/research/client-reactivity-optimistic-updates.md:
 *
 *   authoritative snapshot atom (cursor + rows)
 *   + optimistic overlay atom (mutationId / expectedRevision / patch)
 *   → derived rendered atom → React
 *
 * The latency/failure knobs only shape the mutation round trip; the poll
 * models the local sidecar's 350ms ledger tail and stays instant.
 */
import { Atom, Registry } from '@effect-atom/atom'

export type ProtoStatus = 'todo' | 'in_progress' | 'in_review' | 'done'

export const STATUSES: readonly ProtoStatus[] = [
  'todo',
  'in_progress',
  'in_review',
  'done',
]

export interface ProtoRow {
  readonly branch: string
  readonly id: string
  readonly revision: number
  readonly sortOrder: number
  readonly status: ProtoStatus
  readonly title: string
}

export interface OverlayEntry {
  readonly expectedRevision: number
  readonly mutationId: string
  readonly patch: {
    readonly status: ProtoStatus
    readonly sortOrder: number
  }
}

export type LogKind =
  | 'drag'
  | 'sent'
  | 'coalesced'
  | 'confirmed'
  | 'ledger'
  | 'conflict'
  | 'lost'
  | 'external'

export interface LogEntry {
  readonly at: number
  readonly id: number
  readonly kind: LogKind
  readonly text: string
}

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

const SEED_SPECS: ReadonlyArray<readonly [string, string, ProtoStatus]> = [
  ['Fix worktree cleanup on cancel', 'fix/worktree-cleanup', 'todo'],
  ['Slack thread binding for sub-tasks', 'feat/subtask-thread-binding', 'todo'],
  ['Add sort_order to task moves', 'feat/task-sort-order', 'todo'],
  ['Debounce board search input', 'fix/board-search-debounce', 'todo'],
  ['Ledger cursor gap fallback', 'feat/ledger-gap-fallback', 'in_progress'],
  ['Optimistic overlay atom', 'feat/optimistic-overlay', 'in_progress'],
  [
    'Project re-registration resurfaces tasks',
    'fix/project-rereg',
    'in_progress',
  ],
  ['Snapshot stream over Effect RPC', 'feat/snapshot-stream', 'in_review'],
  ['Revision CAS on task.move', 'feat/move-revision-cas', 'in_review'],
  [
    'Drop LiveStore from renderer',
    'chore/drop-livestore-renderer',
    'in_review',
  ],
  ['WAL busy-retry wrapper', 'feat/wal-busy-retry', 'done'],
  ['Shared db migrations 0004-0006', 'feat/shared-db-migrations', 'done'],
  ['Ship app_settings KV', 'feat/app-settings-kv', 'done'],
  ['Kill sync-backend relay', 'chore/kill-sync-backend', 'done'],
]

const seedRows = (): ProtoRow[] => {
  const perColumn = new Map<ProtoStatus, number>()
  return SEED_SPECS.map(([title, branch, status], index) => {
    const sortOrder = perColumn.get(status) ?? 0
    perColumn.set(status, sortOrder + 1)
    return {
      id: `task_${String(index + 1).padStart(2, '0')}`,
      title,
      branch,
      status,
      sortOrder,
      revision: 1,
    }
  })
}

const SEED = seedRows()

// ---------------------------------------------------------------------------
// Simulated server (sqlite + ledger + RPC stand-in)
// ---------------------------------------------------------------------------

interface LedgerEntry {
  readonly cursor: number
  readonly mutationId: string | null
  readonly rowId: string
}

export interface MoveCommand {
  readonly expectedRevision: number
  readonly mutationId: string
  readonly rowId: string
  readonly sortOrder: number
  readonly status: ProtoStatus
}

export type MoveResult =
  | {
      readonly _tag: 'confirmed'
      readonly row: ProtoRow
      readonly cursor: number
    }
  | { readonly _tag: 'stale'; readonly row: ProtoRow }
  /** Committed on the server, but the response was lost in transit. */
  | { readonly _tag: 'lost' }

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

class SimServer {
  readonly rows = new Map<string, ProtoRow>()
  cursor = 0
  ledger: LedgerEntry[] = []

  // Knobs, poked directly by the control panel.
  latencyMs = 400
  failureRate = 0
  rejectNext = false
  dropNextResponse = false

  constructor(seed: readonly ProtoRow[]) {
    for (const row of seed) {
      this.rows.set(row.id, row)
    }
  }

  private commit(
    rowId: string,
    patch: { status: ProtoStatus; sortOrder: number },
    mutationId: string | null
  ): ProtoRow {
    const row = this.rows.get(rowId)
    if (!row) {
      throw new Error(`missing row ${rowId}`)
    }
    const next: ProtoRow = { ...row, ...patch, revision: row.revision + 1 }
    this.rows.set(rowId, next)
    this.cursor += 1
    this.ledger.push({ cursor: this.cursor, rowId, mutationId })
    return next
  }

  async moveCard(command: MoveCommand): Promise<MoveResult> {
    await sleep(this.latencyMs)
    const row = this.rows.get(command.rowId)
    if (!row) {
      throw new Error(`missing row ${command.rowId}`)
    }
    const injectedFailure = this.rejectNext || Math.random() < this.failureRate
    this.rejectNext = false
    if (injectedFailure || row.revision !== command.expectedRevision) {
      return { _tag: 'stale', row }
    }
    const next = this.commit(
      command.rowId,
      { status: command.status, sortOrder: command.sortOrder },
      command.mutationId
    )
    if (this.dropNextResponse) {
      this.dropNextResponse = false
      return { _tag: 'lost' }
    }
    return { _tag: 'confirmed', row: next, cursor: this.cursor }
  }

  /** Ledger tail. Tiny table, so every poll returns a full snapshot. */
  pull(afterCursor: number): {
    readonly cursor: number
    readonly rows: ProtoRow[]
    readonly mutationIds: string[]
  } {
    const mutationIds = this.ledger
      .filter(
        (entry) => entry.cursor > afterCursor && entry.mutationId !== null
      )
      .map((entry) => entry.mutationId as string)
    return { cursor: this.cursor, rows: [...this.rows.values()], mutationIds }
  }

  /** External writer (next/ or an MCP agent) — commits straight to the db. */
  moveRandomCard(): {
    readonly row: ProtoRow
    readonly to: ProtoStatus
  } | null {
    const rows = [...this.rows.values()]
    if (rows.length === 0) {
      return null
    }
    const row = rows[Math.floor(Math.random() * rows.length)]
    if (!row) {
      return null
    }
    const targets = STATUSES.filter((status) => status !== row.status)
    const to = targets[Math.floor(Math.random() * targets.length)]
    if (!to) {
      return null
    }
    const inColumn = rows.filter((r) => r.status === to)
    const sortOrder =
      inColumn.length === 0
        ? 0
        : Math.min(...inColumn.map((r) => r.sortOrder)) - 1
    const next = this.commit(row.id, { status: to, sortOrder }, null)
    return { row: next, to }
  }
}

export const sim = new SimServer(SEED)

// ---------------------------------------------------------------------------
// Client loop: registry + atoms
// ---------------------------------------------------------------------------

export const registry = Registry.make()

export const authoritativeAtom = Atom.make<{
  readonly cursor: number
  readonly rows: readonly ProtoRow[]
}>({ cursor: 0, rows: SEED }).pipe(Atom.keepAlive)

export const overlayAtom = Atom.make<ReadonlyMap<string, OverlayEntry>>(
  new Map()
).pipe(Atom.keepAlive)

export const renderedAtom = Atom.make((get) => {
  const authoritative = get(authoritativeAtom)
  const overlay = get(overlayAtom)
  return authoritative.rows.map((row) => {
    const entry = overlay.get(row.id)
    return entry ? { ...row, ...entry.patch } : row
  })
})

export const logAtom = Atom.make<readonly LogEntry[]>([]).pipe(Atom.keepAlive)

let logSequence = 0

export const log = (kind: LogKind, text: string) => {
  logSequence += 1
  const entry: LogEntry = { id: logSequence, at: Date.now(), kind, text }
  registry.update(logAtom, (entries) => [...entries.slice(-79), entry])
}

// ---------------------------------------------------------------------------
// Mutation lifecycle — coalesce-to-latest per card ("like Linear")
// ---------------------------------------------------------------------------

interface QueuedMove {
  readonly mutationId: string
  readonly sortOrder: number
  readonly status: ProtoStatus
}

const inFlight = new Set<string>()
const queued = new Map<string, QueuedMove>()

const label = (rowId: string): string => {
  const row = registry.get(authoritativeAtom).rows.find((r) => r.id === rowId)
  return row ? `“${row.title}”` : rowId
}

/**
 * Drop handler: install the overlay immediately (the drop IS the feedback),
 * then send — or, if this card already has a move in flight, coalesce to the
 * latest destination and let the in-flight completion send it.
 */
export const dispatchMove = (
  rowId: string,
  status: ProtoStatus,
  sortOrder: number
) => {
  const authoritative = registry.get(authoritativeAtom)
  const row = authoritative.rows.find((r) => r.id === rowId)
  if (!row) {
    return
  }
  const mutationId = crypto.randomUUID()
  registry.update(overlayAtom, (overlay) => {
    const next = new Map(overlay)
    next.set(rowId, {
      mutationId,
      expectedRevision: row.revision,
      patch: { status, sortOrder },
    })
    return next
  })
  if (inFlight.has(rowId)) {
    queued.set(rowId, { status, sortOrder, mutationId })
    log('coalesced', `${label(rowId)} → ${status} queued (coalesced to latest)`)
    return
  }
  void send(rowId, { status, sortOrder, mutationId })
}

const clearOverlayIfOwner = (rowId: string, mutationId: string): boolean => {
  let cleared = false
  registry.update(overlayAtom, (overlay) => {
    const entry = overlay.get(rowId)
    if (entry === undefined || entry.mutationId !== mutationId) {
      return overlay
    }
    const next = new Map(overlay)
    next.delete(rowId)
    cleared = true
    return next
  })
  return cleared
}

const installRow = (row: ProtoRow, cursor: number) => {
  registry.update(authoritativeAtom, (state) => ({
    cursor: Math.max(state.cursor, cursor),
    rows: state.rows.map((existing) =>
      existing.id === row.id && existing.revision < row.revision
        ? row
        : existing
    ),
  }))
}

const send = async (rowId: string, move: QueuedMove) => {
  inFlight.add(rowId)
  // Thread the latest known revision into the command (research doc §mutation
  // concurrency) — a queued move must not reuse the revision from drag time.
  const row = registry.get(authoritativeAtom).rows.find((r) => r.id === rowId)
  const expectedRevision = row?.revision ?? 0
  const startedAt = performance.now()
  log('sent', `${label(rowId)} → ${move.status} (rev ${expectedRevision})`)
  try {
    const result = await sim.moveCard({
      rowId,
      status: move.status,
      sortOrder: move.sortOrder,
      expectedRevision,
      mutationId: move.mutationId,
    })
    const elapsed = Math.round(performance.now() - startedAt)
    switch (result._tag) {
      case 'confirmed': {
        installRow(result.row, result.cursor)
        const owned = clearOverlayIfOwner(rowId, move.mutationId)
        log(
          'confirmed',
          `${label(rowId)} confirmed in ${elapsed}ms${owned ? '' : ' (overlay already superseded)'}`
        )
        break
      }
      case 'stale': {
        const owned = clearOverlayIfOwner(rowId, move.mutationId)
        log(
          'conflict',
          owned
            ? `${label(rowId)} rejected (stale rev) — snapped back`
            : `${label(rowId)} rejected (stale rev) — newer drag owns the card`
        )
        break
      }
      case 'lost': {
        // Transport ambiguity: the command may have committed. Never blindly
        // undo — keep the overlay; the ledger poll confirms via mutationId.
        log(
          'lost',
          `${label(rowId)} response lost — holding optimistic state for the ledger`
        )
        break
      }
    }
  } finally {
    inFlight.delete(rowId)
    const next = queued.get(rowId)
    if (next) {
      queued.delete(rowId)
      void send(rowId, next)
    }
  }
}

// ---------------------------------------------------------------------------
// Poll loop body + external writer
// ---------------------------------------------------------------------------

/** One ledger-poll tick: apply the snapshot, clear confirmed overlays. */
export const applyPull = () => {
  const authoritative = registry.get(authoritativeAtom)
  const result = sim.pull(authoritative.cursor)
  if (result.cursor === authoritative.cursor) {
    return
  }
  registry.set(authoritativeAtom, {
    cursor: result.cursor,
    rows: result.rows,
  })
  if (result.mutationIds.length === 0) {
    return
  }
  const seen = new Set(result.mutationIds)
  registry.update(overlayAtom, (overlay) => {
    let changed = false
    const next = new Map(overlay)
    for (const [rowId, entry] of overlay) {
      if (seen.has(entry.mutationId)) {
        next.delete(rowId)
        changed = true
        log('ledger', `${label(rowId)} confirmed via ledger poll`)
      }
    }
    return changed ? next : overlay
  })
}

export const botMove = () => {
  const moved = sim.moveRandomCard()
  if (moved) {
    log('external', `external writer moved “${moved.row.title}” → ${moved.to}`)
  }
}
