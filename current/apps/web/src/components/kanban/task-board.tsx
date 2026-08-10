/**
 * Shared-task-db kanban board — a MainView alongside panels/dashboard.
 *
 * One global board where each LiveStore project is a collapsible swim
 * lane (Todo / In Progress / In Review / Done per lane). Lane collapse
 * shares the sidebar's project collapse state instance, so collapsing a
 * project in either place collapses it in both, live in-session.
 * Cancelled cards are stored but never rendered. Drag uses the vendored
 * reui kanban (dnd-kit); each lane is its own Kanban root so cards can
 * never cross projects.
 *
 * The renderer subscribes to typed snapshots/deltas and never opens SQLite.
 */

import { Result } from '@effect-atom/atom'
import { useAtomSet, useAtomValue } from '@effect-atom/atom-react/Hooks'
import { projects } from '@laborer/shared/schema'
import { queryDb } from '@livestore/livestore'
import { Cause } from 'effect'
import {
  Bot,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FolderGit2,
  FolderX,
  GitBranch,
  MessageSquare,
  Search,
  SquarePen,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { LaborerClient } from '@/atoms/laborer-client'
import { GitHubPrStatusBadge } from '@/components/github-pr-status-badge'
import {
  applyTaskBoardEvents,
  type BoardTask,
  type BoardTaskStatus,
  projectForTask,
} from '@/components/kanban/board-data'
import {
  Kanban,
  KanbanBoard,
  KanbanColumn,
  KanbanColumnContent,
  KanbanItem,
  KanbanItemHandle,
  KanbanOverlay,
} from '@/components/reui/kanban'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import type { CollapseState } from '@/hooks/use-project-collapse-state'
import { openExternalUrl } from '@/lib/desktop'
import { cn } from '@/lib/utils'
import { useLaborerStore } from '@/livestore/store'

const boardProjects$ = queryDb(projects, { label: 'boardProjects' })
const DONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** The four rendered columns, in board order. Cancelled never renders. */
const BOARD_COLUMNS: ReadonlyArray<{
  readonly id: Exclude<BoardTaskStatus, 'cancelled'>
  readonly title: string
  readonly dotClassName: string
}> = [
  { id: 'todo', title: 'Todo', dotClassName: 'bg-muted-foreground/50' },
  { id: 'in_progress', title: 'In Progress', dotClassName: 'bg-success' },
  { id: 'in_review', title: 'In Review', dotClassName: 'bg-purple-500' },
  { id: 'done', title: 'Done', dotClassName: 'bg-primary' },
]

/**
 * Group tasks into rendered columns, newest first. Cancelled cards are
 * dropped here — the board never shows them.
 */
function buildColumnTasks(
  tasks: readonly BoardTask[]
): Record<string, BoardTask[]> {
  const byColumn: Record<string, BoardTask[]> = {}
  for (const column of BOARD_COLUMNS) {
    byColumn[column.id] = []
  }
  const doneCutoff = Date.now() - DONE_RETENTION_MS
  const sorted = [...tasks].sort((a, b) => b.createdAt - a.createdAt)
  for (const task of sorted) {
    if (
      task.status === 'cancelled' ||
      (task.status === 'done' && task.updatedAt < doneCutoff)
    ) {
      continue
    }
    byColumn[task.status]?.push(task)
  }
  return byColumn
}

/** Case-insensitive substring match against title, branch, or PR. */
function matchesQuery(task: BoardTask, query: string): boolean {
  // "#212" and "212" both match PR #212.
  const prNumberQuery = query.startsWith('#') ? query.slice(1) : query
  return (
    task.title.toLowerCase().includes(query) ||
    (task.branch?.toLowerCase().includes(query) ?? false) ||
    (task.pr !== null &&
      ((prNumberQuery.length > 0 &&
        String(task.pr.number).includes(prNumberQuery)) ||
        task.pr.title.toLowerCase().includes(query)))
  )
}

/** Local search input for the board toolbar. */
function BoardSearch({
  value,
  onChange,
}: {
  readonly value: string
  readonly onChange: (value: string) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  const handleClear = () => {
    onChange('')
    inputRef.current?.focus()
  }

  return (
    <div className="relative w-64">
      <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        aria-label="Search cards"
        className="h-7 pr-7 pl-7"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value.length > 0) {
            e.preventDefault()
            handleClear()
          }
        }}
        placeholder="Search cards..."
        ref={inputRef}
        type="text"
        value={value}
      />
      {value.length > 0 && (
        <button
          aria-label="Clear search"
          className="absolute top-1/2 right-1.5 flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={handleClear}
          type="button"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  )
}

/** Chip showing where the card came from. */
function SourceBadge({ source }: { readonly source: BoardTask['source'] }) {
  if (source === 'execution') {
    return (
      <Badge className="shrink-0 gap-1 text-muted-foreground" variant="outline">
        <Bot className="size-3" />
        Agent
      </Badge>
    )
  }
  if (source === 'slack_url') {
    return (
      <Badge className="shrink-0 gap-1 text-muted-foreground" variant="outline">
        <MessageSquare className="size-3" />
        Slack
      </Badge>
    )
  }
  return (
    <Badge className="shrink-0 gap-1 text-muted-foreground" variant="outline">
      <SquarePen className="size-3" />
      Manual
    </Badge>
  )
}

/**
 * Next-owned execution mirror. Failed / needs-attention cards keep their
 * stored In Progress status; only this badge changes.
 */
function ExecutionMirrorBadge({
  mirror,
}: {
  readonly mirror: BoardTask['executionMirror']
}) {
  if (mirror === 'needs_attention') {
    return (
      <Badge
        className="gap-1 border-warning/30 bg-warning/10 text-warning"
        variant="outline"
      >
        Needs attention
      </Badge>
    )
  }
  if (mirror === 'failed') {
    return (
      <Badge
        className="gap-1 border-destructive/30 bg-destructive/10 text-destructive"
        variant="outline"
      >
        Failed
      </Badge>
    )
  }
  return null
}

/** Worktree binding state affordance (derived on the real board). */
function WorktreeChip({ task }: { readonly task: BoardTask }) {
  if (task.worktreeState === 'provisioning') {
    return (
      <Badge className="gap-1 text-muted-foreground" variant="outline">
        <Spinner className="size-3" />
        Provisioning…
      </Badge>
    )
  }
  if (task.worktreeState === 'gone') {
    return (
      <Badge className="gap-1 text-muted-foreground/70" variant="outline">
        <FolderX className="size-3" />
        Worktree gone
      </Badge>
    )
  }
  return null
}

/** Map PR state onto the existing badge's uppercase vocabulary. */
function toPrBadgeState(state: 'open' | 'merged' | 'closed'): string {
  return state.toUpperCase()
}

function describeJump(task: BoardTask): string {
  switch (task.worktreeState) {
    case 'exists':
      return `Would jump into workspace ${task.branch ?? task.worktreePath}`
    case 'provisioning':
      return 'Worktree is still provisioning — nothing to open yet'
    case 'gone':
      return 'Worktree no longer exists on disk'
    default:
      return 'No workspace yet — leaving Todo provisions one'
  }
}

function TaskBoardCard({
  task,
  isOverlay = false,
}: {
  readonly task: BoardTask
  readonly isOverlay?: boolean
}) {
  const openSlack = (event: React.MouseEvent) => {
    event.stopPropagation()
    if (task.slackPermalink) {
      openExternalUrl(task.slackPermalink)
    }
  }

  const jumpDisabled =
    task.worktreeState === 'provisioning' || task.worktreeState === 'gone'

  return (
    <Card
      className={cn(
        'cursor-pointer gap-0 rounded-md py-0 shadow-xs ring-foreground/10 transition-colors hover:ring-foreground/20',
        jumpDisabled && 'opacity-80',
        isOverlay && 'shadow-lg'
      )}
      onClick={() => {
        toast.info(describeJump(task))
      }}
    >
      <CardContent className="flex flex-col gap-2 px-3 py-2.5">
        {/* Title row: source chip + slack link pinned right */}
        <div className="flex items-start justify-between gap-2">
          <p className="line-clamp-2 min-w-0 font-medium text-sm leading-snug">
            {task.title}
          </p>
          {task.slackPermalink && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    aria-label="Open Slack thread"
                    className="mt-0.5 shrink-0 rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                    onClick={openSlack}
                    type="button"
                  />
                }
              >
                <ExternalLink className="size-3.5" />
              </TooltipTrigger>
              <TooltipContent>Open Slack thread</TooltipContent>
            </Tooltip>
          )}
        </div>

        {/* Branch row */}
        {task.branch && (
          <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
            <GitBranch className="size-3 shrink-0" />
            <span className="truncate font-mono text-xs">{task.branch}</span>
          </div>
        )}

        {/* Meta chips: source, execution mirror, PR, worktree state */}
        <div className="flex flex-wrap items-center gap-1.5">
          <SourceBadge source={task.source} />
          <ExecutionMirrorBadge mirror={task.executionMirror} />
          {task.pr && (
            <GitHubPrStatusBadge
              prNumber={task.pr.number}
              prState={toPrBadgeState(task.pr.state)}
              prTitle={task.pr.title}
              prUrl={task.pr.url}
            />
          )}
          <WorktreeChip task={task} />
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * One project lane's 4-column kanban. Its own Kanban root, so drags can
 * never cross projects.
 */
function LaneBoard({ tasks }: { readonly tasks: readonly BoardTask[] }) {
  const [columnTasks, setColumnTasks] = useState<Record<string, BoardTask[]>>(
    () => buildColumnTasks(tasks)
  )

  // Derived from local column state so add-task cards resolve too.
  const tasksById = useMemo(() => {
    const byId = new Map<string, BoardTask>()
    for (const columnList of Object.values(columnTasks)) {
      for (const task of columnList) {
        byId.set(task.id, task)
      }
    }
    return byId
  }, [columnTasks])

  // Persistence for human moves is intentionally a later slice. Keeping the
  // controlled local value preserves the prototype's reorder behavior without
  // claiming a durable write occurred.
  return (
    <Kanban
      className="w-full min-w-0"
      getItemValue={(task: BoardTask) => task.id}
      onValueChange={setColumnTasks}
      value={columnTasks}
    >
      <KanbanBoard className="grid min-w-0 grid-cols-4 gap-2 sm:grid-cols-4">
        {BOARD_COLUMNS.map((column) => (
          <KanbanColumn className="min-w-0" key={column.id} value={column.id}>
            <div className="flex min-w-0 flex-col rounded-lg bg-muted/50">
              <div className="flex min-w-0 items-center gap-2 px-3 pt-2 pb-0.5">
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
                  {(columnTasks[column.id] ?? []).length}
                </span>
              </div>
              <KanbanColumnContent
                className="flex min-h-24 flex-1 flex-col gap-2 px-2 pt-1.5 pb-2"
                value={column.id}
              >
                {(columnTasks[column.id] ?? []).map((task) => (
                  <KanbanItem key={task.id} value={task.id}>
                    <KanbanItemHandle>
                      <TaskBoardCard task={task} />
                    </KanbanItemHandle>
                  </KanbanItem>
                ))}
                {(columnTasks[column.id] ?? []).length === 0 && (
                  <div className="rounded-md border border-dashed p-3 text-center text-muted-foreground text-xs">
                    No cards
                  </div>
                )}
              </KanbanColumnContent>
              {column.id === 'done' && (
                <p className="px-3 pb-2 text-[10px] text-muted-foreground/70">
                  Done cards auto-hide after 7 days
                </p>
              )}
            </div>
          </KanbanColumn>
        ))}
      </KanbanBoard>
      <KanbanOverlay>
        {({ value }) => {
          const task = tasksById.get(String(value))
          if (!task) {
            return null
          }
          return <TaskBoardCard isOverlay task={task} />
        }}
      </KanbanOverlay>
    </Kanban>
  )
}

/**
 * The kanban MainView: one lane per LiveStore project, collapse state
 * shared with the sidebar's project groups (same keys, same instance).
 */
function TaskBoard({
  collapseState,
}: {
  readonly collapseState: CollapseState
}) {
  const store = useLaborerStore()
  const projectList = store.useQuery(boardProjects$)
  const [searchQuery, setSearchQuery] = useState('')
  const taskEventsAtom = useMemo(
    () =>
      // biome-ignore lint/suspicious/noConfusingVoidType: Effect RPC uses void for empty payloads
      LaborerClient.query('task.board.subscribe', undefined as void),
    []
  )
  const rpcResult = useAtomValue(taskEventsAtom)
  const pullNext = useAtomSet(taskEventsAtom)

  useEffect(() => {
    const interval = setInterval(() => {
      // biome-ignore lint/suspicious/noConfusingVoidType: pull atom write type is void
      pullNext(undefined as void)
    }, 250)
    return () => clearInterval(interval)
  }, [pullNext])

  const boardTasks = useMemo(
    () =>
      Result.isSuccess(rpcResult)
        ? applyTaskBoardEvents(rpcResult.value.items)
        : [],
    [rpcResult]
  )

  const query = searchQuery.trim().toLowerCase()
  const searching = query.length > 0

  // Lanes with zero matches are hidden while searching; matches force-
  // expand their lane without mutating the stored collapse state.
  const lanes = projectList
    .map((project) => {
      const laneTasks = boardTasks.filter(
        (task) => projectForTask(task, projectList)?.id === project.id
      )
      const visibleTasks = laneTasks.filter(
        (task) =>
          task.status !== 'cancelled' &&
          !(
            task.status === 'done' &&
            task.updatedAt < Date.now() - DONE_RETENTION_MS
          ) &&
          (!searching || matchesQuery(task, query))
      )
      return { project, visibleTasks }
    })
    .filter((lane) => !searching || lane.visibleTasks.length > 0)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center border-b px-3">
        <BoardSearch onChange={setSearchQuery} value={searchQuery} />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-3 p-3">
          {lanes.map(({ project, visibleTasks }) => {
            const expanded = searching || collapseState.isExpanded(project.id)

            return (
              <div className="flex flex-col gap-1.5" key={project.id}>
                <Button
                  className="h-8 w-fit justify-start gap-2 px-2"
                  onClick={() => collapseState.toggle(project.id)}
                  variant="ghost"
                >
                  {expanded ? (
                    <ChevronDown className="size-4 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="size-4 text-muted-foreground" />
                  )}
                  <FolderGit2 className="size-4 text-muted-foreground" />
                  <span className="truncate font-medium text-sm">
                    {project.name}
                  </span>
                  <span className="text-muted-foreground text-sm tabular-nums">
                    {visibleTasks.length}
                  </span>
                </Button>
                {expanded && (
                  <LaneBoard
                    key={`${query}:${visibleTasks.map((task) => `${task.id}:${String(task.revision)}`).join(',')}`}
                    tasks={visibleTasks}
                  />
                )}
              </div>
            )
          })}
          {searching && lanes.length === 0 && (
            <div className="flex items-center justify-center p-8 text-muted-foreground text-sm">
              No matching cards
            </div>
          )}
          {Result.isFailure(rpcResult) && (
            <div className="flex items-center justify-center p-8 text-destructive text-sm">
              Task board unavailable: {String(Cause.squash(rpcResult.cause))}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

export { TaskBoard }
