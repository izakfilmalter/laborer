/** biome-ignore-all lint: throwaway prototype for issue #407 — not production code */
/**
 * PROTOTYPE (#407) — optimistic kanban drag feel. Throwaway.
 *
 * Real board primitives (vendored reui kanban on dnd-kit + CardShell) over
 * the simulated server in ./sim.ts, plus a control panel of failure knobs.
 */
import { arrayMove } from '@dnd-kit/sortable'
import { useAtomValue } from '@effect-atom/atom-react/Hooks'
import { GitBranch } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { CardShell } from '@/components/card-shell'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  Kanban,
  KanbanBoard,
  KanbanColumn,
  KanbanColumnContent,
  KanbanItem,
  KanbanItemHandle,
  KanbanOverlay,
} from './kanban-vendored'
import {
  applyPull,
  authoritativeAtom,
  botMove,
  dispatchMove,
  type LogEntry,
  logAtom,
  overlayAtom,
  type ProtoRow,
  type ProtoStatus,
  renderedAtom,
  STATUSES,
  sim,
} from './sim'

// ---------------------------------------------------------------------------
// Columns (mirrors BOARD_COLUMNS in components/kanban/task-board.tsx)
// ---------------------------------------------------------------------------

const COLUMNS: ReadonlyArray<{
  readonly id: ProtoStatus
  readonly title: string
  readonly dotClassName: string
}> = [
  { id: 'todo', title: 'Todo', dotClassName: 'bg-muted-foreground/50' },
  { id: 'in_progress', title: 'In Progress', dotClassName: 'bg-success' },
  { id: 'in_review', title: 'In Review', dotClassName: 'bg-purple-500' },
  { id: 'done', title: 'Done', dotClassName: 'bg-primary' },
]

const buildColumns = (
  rows: readonly ProtoRow[]
): Record<string, ProtoRow[]> => {
  const byColumn: Record<string, ProtoRow[]> = {}
  for (const status of STATUSES) {
    byColumn[status] = []
  }
  for (const row of rows) {
    byColumn[row.status]?.push(row)
  }
  for (const status of STATUSES) {
    byColumn[status]?.sort(
      (a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id)
    )
  }
  return byColumn
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

function ProtoCard({
  debug,
  pending,
  row,
}: {
  readonly debug: boolean
  readonly pending: boolean
  readonly row: ProtoRow
}) {
  return (
    <CardShell
      badges={
        debug ? (
          <>
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              rev {row.revision}
            </span>
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              ord {row.sortOrder}
            </span>
            {pending && (
              <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-500">
                optimistic
              </span>
            )}
          </>
        ) : undefined
      }
      subtitle={
        <span className="flex min-w-0 items-center gap-1 text-muted-foreground text-xs">
          <GitBranch aria-hidden className="size-3 shrink-0" />
          <span className="truncate font-mono">{row.branch}</span>
        </span>
      }
      title={
        <span className="line-clamp-2 font-medium text-sm">{row.title}</span>
      }
    />
  )
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

function ProtoBoard({ debug }: { readonly debug: boolean }) {
  const rows = useAtomValue(renderedAtom)
  const overlay = useAtomValue(overlayAtom)
  const [columns, setColumns] = useState<Record<string, ProtoRow[]>>(() =>
    buildColumns(rows)
  )

  // Server-side changes rebuild the local drag state without remounting
  // (same signature-reset trick as the real LaneBoard).
  const signature = useMemo(
    () =>
      rows
        .map(
          (row) => `${row.id}:${row.revision}:${row.status}:${row.sortOrder}`
        )
        .join(','),
    [rows]
  )
  const [syncedSignature, setSyncedSignature] = useState(signature)
  if (syncedSignature !== signature) {
    setSyncedSignature(signature)
    setColumns(buildColumns(rows))
  }

  const columnsRef = useRef(columns)
  columnsRef.current = columns
  const rowsRef = useRef(rows)
  rowsRef.current = rows

  const rowsById = useMemo(() => {
    const byId = new Map<string, ProtoRow>()
    for (const row of rows) {
      byId.set(row.id, row)
    }
    return byId
  }, [rows])

  return (
    <Kanban
      className="w-full min-w-0"
      getItemValue={(row: ProtoRow) => row.id}
      onMove={({ event, overContainer, overIndex }) => {
        const status = overContainer as ProtoStatus
        if (!STATUSES.includes(status)) {
          return
        }
        const rowId = String(event.active.id)
        const row = rowsRef.current.find((r) => r.id === rowId)
        if (!row) {
          return
        }
        // Cross-column entry is previewed in the columns state (dragOver
        // inserted the card); same-column reorder is not (only sortable
        // transforms preview it) — so the landing index comes from the
        // event's overIndex, applied with dnd-kit's own arrayMove semantics.
        const previewList = columnsRef.current[status] ?? []
        const currentIndex = previewList.findIndex((r) => r.id === rowId)
        let landed: ProtoRow[]
        let landedIndex: number
        if (currentIndex === -1) {
          // Card never entered this column's preview: plain insertion.
          landedIndex = Math.min(overIndex, previewList.length)
          landed = [...previewList]
          landed.splice(landedIndex, 0, row)
        } else {
          landedIndex = Math.min(overIndex, previewList.length - 1)
          landed = arrayMove(previewList, currentIndex, landedIndex)
        }
        const before = landed[landedIndex - 1]
        const after = landed[landedIndex + 1]
        if (row.status === status) {
          // Dropped back where it started → no-op, don't send a mutation.
          const settledList = buildColumns(rowsRef.current)[status] ?? []
          const settledIndex = settledList.findIndex((r) => r.id === rowId)
          if (
            settledList[settledIndex - 1]?.id === before?.id &&
            settledList[settledIndex + 1]?.id === after?.id
          ) {
            return
          }
        }
        const sortOrder =
          before === undefined && after === undefined
            ? 0
            : before === undefined && after !== undefined
              ? after.sortOrder - 1
              : before !== undefined && after === undefined
                ? before.sortOrder + 1
                : before !== undefined && after !== undefined
                  ? (before.sortOrder + after.sortOrder) / 2
                  : 0
        dispatchMove(rowId, status, sortOrder)
      }}
      onValueChange={setColumns}
      value={columns}
    >
      {/* Exact production classes: auto-rows-fr equal-height columns are what
          keep dnd-kit collisions stable when a card crosses columns. */}
      <KanbanBoard className="grid min-w-0 grid-cols-4 gap-2 sm:grid-cols-4">
        {COLUMNS.map((column) => (
          <KanbanColumn className="min-w-0" key={column.id} value={column.id}>
            <div className="flex min-w-0 flex-col rounded-lg bg-muted/50">
              <div className="flex min-w-0 items-center gap-2 px-3 pt-1.5 pb-0.5">
                <span
                  className={cn(
                    'inline-block size-2 shrink-0 rounded-full',
                    column.dotClassName
                  )}
                />
                <span className="truncate font-medium text-sm">
                  {column.title}
                </span>
                <span className="text-muted-foreground text-sm tabular-nums">
                  {(columns[column.id] ?? []).length}
                </span>
              </div>
              <KanbanColumnContent
                className="flex min-h-24 flex-1 flex-col gap-2 px-2 pt-1.5 pb-2"
                value={column.id}
              >
                {(columns[column.id] ?? []).map((row) => (
                  <KanbanItem key={row.id} value={row.id}>
                    <KanbanItemHandle>
                      <ProtoCard
                        debug={debug}
                        pending={overlay.has(row.id)}
                        row={row}
                      />
                    </KanbanItemHandle>
                  </KanbanItem>
                ))}
                {(columns[column.id] ?? []).length === 0 && (
                  <div className="rounded-md border border-dashed p-3 text-center text-muted-foreground text-xs">
                    No cards
                  </div>
                )}
              </KanbanColumnContent>
            </div>
          </KanbanColumn>
        ))}
      </KanbanBoard>
      {/* No drop animation: the live preview already has the card in place
          (Linear-style instant drop), and dnd-kit's drop-animation measuring
          loops against the instant optimistic rebuild at drop. */}
      <KanbanOverlay dropAnimation={null}>
        {({ value }) => {
          const row = rowsById.get(String(value))
          if (!row) {
            return null
          }
          return <ProtoCard debug={debug} pending={false} row={row} />
        }}
      </KanbanOverlay>
    </Kanban>
  )
}

// ---------------------------------------------------------------------------
// Control panel
// ---------------------------------------------------------------------------

function Slider({
  format,
  label,
  max,
  min,
  onChange,
  step,
  value,
}: {
  readonly format: (value: number) => string
  readonly label: string
  readonly max: number
  readonly min: number
  readonly onChange: (value: number) => void
  readonly step: number
  readonly value: number
}) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="flex items-center justify-between">
        <span>{label}</span>
        <span className="font-mono text-muted-foreground tabular-nums">
          {format(value)}
        </span>
      </span>
      <input
        className="accent-primary"
        max={max}
        min={min}
        onChange={(event) => onChange(Number(event.target.value))}
        step={step}
        type="range"
        value={value}
      />
    </label>
  )
}

const LOG_STYLES: Record<LogEntry['kind'], string> = {
  drag: 'text-muted-foreground',
  sent: 'text-sky-400',
  coalesced: 'text-amber-400',
  confirmed: 'text-emerald-400',
  ledger: 'text-emerald-600',
  conflict: 'text-red-400',
  lost: 'text-orange-400',
  external: 'text-purple-400',
}

const timestamp = (at: number) =>
  new Date(at).toLocaleTimeString(undefined, { hour12: false }) +
  '.' +
  String(at % 1000).padStart(3, '0')

function EventLog() {
  const entries = useAtomValue(logAtom)
  const reversed = useMemo(() => [...entries].reverse(), [entries])
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto font-mono text-[11px]">
      {reversed.length === 0 && (
        <p className="text-muted-foreground">Drag a card to start.</p>
      )}
      {reversed.map((entry) => (
        <p
          className={cn('leading-tight', LOG_STYLES[entry.kind])}
          key={entry.id}
        >
          <span className="text-muted-foreground/60">
            {timestamp(entry.at)}
          </span>{' '}
          {entry.text}
        </p>
      ))}
    </div>
  )
}

function ControlPanel({
  debug,
  onDebugChange,
}: {
  readonly debug: boolean
  readonly onDebugChange: (debug: boolean) => void
}) {
  const authoritative = useAtomValue(authoritativeAtom)
  const overlay = useAtomValue(overlayAtom)

  const [latencyMs, setLatencyMs] = useState(sim.latencyMs)
  const [failurePct, setFailurePct] = useState(0)
  const [pollMs, setPollMs] = useState(350)
  const [botOn, setBotOn] = useState(false)
  const [botMs, setBotMs] = useState(2500)
  const [rejectArmed, setRejectArmed] = useState(false)
  const [dropArmed, setDropArmed] = useState(false)

  sim.latencyMs = latencyMs
  sim.failureRate = failurePct / 100

  // Ledger poll — the 350ms tail every renderer runs.
  useEffect(() => {
    const timer = setInterval(() => {
      applyPull()
      // Injected one-shots reset server-side; mirror that in the UI.
      setRejectArmed(sim.rejectNext)
      setDropArmed(sim.dropNextResponse)
    }, pollMs)
    return () => clearInterval(timer)
  }, [pollMs])

  // External writer bot.
  useEffect(() => {
    if (!botOn) {
      return
    }
    const timer = setInterval(() => botMove(), botMs)
    return () => clearInterval(timer)
  }, [botOn, botMs])

  return (
    <aside className="flex w-80 shrink-0 flex-col gap-4 overflow-hidden border-l bg-muted/20 p-4">
      <div>
        <h2 className="font-semibold text-sm">Simulation</h2>
        <p className="text-muted-foreground text-xs">
          cursor {authoritative.cursor} · {overlay.size} optimistic
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <Slider
          format={(v) => `${v}ms`}
          label="Mutation latency"
          max={3000}
          min={0}
          onChange={setLatencyMs}
          step={50}
          value={latencyMs}
        />
        <Slider
          format={(v) => `${v}ms`}
          label="Ledger poll interval"
          max={2000}
          min={100}
          onChange={setPollMs}
          step={50}
          value={pollMs}
        />
        <Slider
          format={(v) => `${v}%`}
          label="Random rejection rate"
          max={100}
          min={0}
          onChange={setFailurePct}
          step={5}
          value={failurePct}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Button
          onClick={() => {
            sim.rejectNext = !sim.rejectNext
            setRejectArmed(sim.rejectNext)
          }}
          size="sm"
          variant={rejectArmed ? 'destructive' : 'outline'}
        >
          {rejectArmed ? 'Next move will be rejected' : 'Reject next move'}
        </Button>
        <Button
          onClick={() => {
            sim.dropNextResponse = !sim.dropNextResponse
            setDropArmed(sim.dropNextResponse)
          }}
          size="sm"
          variant={dropArmed ? 'destructive' : 'outline'}
        >
          {dropArmed
            ? 'Next response will be lost'
            : 'Drop next response (commit anyway)'}
        </Button>
        <Button onClick={() => botMove()} size="sm" variant="outline">
          External writer: move one card
        </Button>
        <Button
          onClick={() => setBotOn((on) => !on)}
          size="sm"
          variant={botOn ? 'default' : 'outline'}
        >
          {botOn ? 'Stop external writer bot' : 'Start external writer bot'}
        </Button>
        {botOn && (
          <Slider
            format={(v) => `${v}ms`}
            label="Bot interval"
            max={10_000}
            min={500}
            onChange={setBotMs}
            step={250}
            value={botMs}
          />
        )}
        <Button
          onClick={() => onDebugChange(!debug)}
          size="sm"
          variant={debug ? 'default' : 'outline'}
        >
          {debug ? 'Hide sync debug' : 'Show sync debug'}
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-1">
        <h2 className="font-semibold text-sm">Events</h2>
        <EventLog />
      </div>
    </aside>
  )
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function ProtoApp() {
  const [debug, setDebug] = useState(false)
  return (
    <div className="flex h-svh bg-background text-foreground">
      <main className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        <header className="flex items-baseline gap-3">
          <h1 className="font-semibold text-base">Optimistic kanban drag</h1>
          <p className="text-muted-foreground text-xs">
            PROTOTYPE (#407) — throwaway. Drag cards; break the network with the
            panel on the right.
          </p>
        </header>
        <ProtoBoard debug={debug} />
      </main>
      <ControlPanel debug={debug} onDebugChange={setDebug} />
    </div>
  )
}
