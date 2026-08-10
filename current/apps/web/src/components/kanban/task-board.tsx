/**
 * Prototype kanban board — a new MainView alongside panels/dashboard.
 *
 * Renders the shared-db task shape (faked in board-data.ts) as a per-project
 * board: Todo / In Progress / In Review / Done. Cancelled cards are stored
 * but never rendered. Drag uses the vendored reui kanban (dnd-kit); the
 * board witnesses state and never gates next.
 *
 * Throwaway prototype for wayfinder ticket #354 — no persistence, no RPC.
 */

import {
  Bot,
  ExternalLink,
  FolderX,
  GitBranch,
  MessageSquare,
  SquarePen,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { GitHubPrStatusBadge } from '@/components/github-pr-status-badge'
import {
  type BoardTask,
  type BoardTaskStatus,
  FAKE_PROJECTS,
  FAKE_TASKS,
} from '@/components/kanban/board-data'
import {
  Kanban,
  KanbanBoard,
  KanbanColumn,
  KanbanColumnContent,
  KanbanItem,
  KanbanItemHandle,
  type KanbanMoveEvent,
  KanbanOverlay,
} from '@/components/reui/kanban'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { openExternalUrl } from '@/lib/desktop'
import { cn } from '@/lib/utils'

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
  const sorted = [...tasks].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt)
  )
  for (const task of sorted) {
    if (task.status === 'cancelled') {
      continue
    }
    byColumn[task.status]?.push(task)
  }
  return byColumn
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
  if (mirror === 'running') {
    return (
      <Badge
        className="gap-1 border-success/30 bg-success/10 text-success"
        variant="outline"
      >
        <Spinner className="size-3" />
        Running
      </Badge>
    )
  }
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

/** Map fake PR state onto the existing badge's uppercase vocabulary. */
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
 * Per-project board. Keyed by project root so switching projects resets
 * the drag-preview state cleanly.
 */
function ProjectBoard({ rootPath }: { readonly rootPath: string }) {
  const projectTasks = useMemo(
    () => FAKE_TASKS.filter((task) => task.rootPath === rootPath),
    [rootPath]
  )
  const [columnTasks, setColumnTasks] = useState<Record<string, BoardTask[]>>(
    () => buildColumnTasks(projectTasks)
  )

  const tasksById = useMemo(() => {
    const byId = new Map<string, BoardTask>()
    for (const task of projectTasks) {
      byId.set(task.id, task)
    }
    return byId
  }, [projectTasks])

  const handleMove = (event: KanbanMoveEvent) => {
    // Witness-only: a real drag writes a CAS status update to the shared
    // db here. The prototype just narrates the transition.
    if (event.activeContainer !== event.overContainer) {
      const column = BOARD_COLUMNS.find((c) => c.id === event.overContainer)
      const task = tasksById.get(String(event.event.active.id))
      if (column && task) {
        toast.success(`"${task.title}" → ${column.title}`)
      }
    }
  }

  return (
    <Kanban
      className="flex h-full min-h-0 w-full min-w-0 flex-col"
      getItemValue={(task: BoardTask) => task.id}
      onMove={handleMove}
      onValueChange={setColumnTasks}
      value={columnTasks}
    >
      <ScrollArea className="min-h-0 flex-1">
        <div className="h-full p-3">
          <KanbanBoard className="grid h-full min-h-0 w-max auto-cols-[minmax(17rem,20rem)] grid-flow-col gap-2 sm:grid-cols-none">
            {BOARD_COLUMNS.map((column) => (
              <KanbanColumn
                className="h-full min-h-0"
                key={column.id}
                value={column.id}
              >
                <div className="flex h-full min-h-0 min-w-0 flex-col rounded-lg bg-muted/50">
                  <div className="flex items-center gap-2 px-3 pt-2 pb-0.5">
                    <span
                      className={cn(
                        'inline-block size-2 rounded-full',
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
                    className="flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto px-2 pt-1.5 pb-2"
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
        </div>
      </ScrollArea>
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
 * The kanban MainView: project picker toolbar + per-project board.
 */
function TaskBoard() {
  const [rootPath, setRootPath] = useState<string>(
    FAKE_PROJECTS[0]?.rootPath ?? ''
  )
  const activeProject = FAKE_PROJECTS.find(
    (project) => project.rootPath === rootPath
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <Select
          onValueChange={(value) => {
            if (value) {
              setRootPath(value)
            }
          }}
          value={rootPath}
        >
          <SelectTrigger className="h-7 w-44">
            <SelectValue>{activeProject?.name ?? 'Project'}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {FAKE_PROJECTS.map((project) => (
              <SelectItem key={project.rootPath} value={project.rootPath}>
                {project.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="truncate font-mono text-muted-foreground text-xs">
          {rootPath}
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <ProjectBoard key={rootPath} rootPath={rootPath} />
      </div>
    </div>
  )
}

export { TaskBoard }
