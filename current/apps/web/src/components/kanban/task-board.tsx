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
import { isSlackMessageUrl } from '@laborer/shared/slack-url'
import { queryDb } from '@livestore/livestore'
import { Cause, Effect, Stream } from 'effect'
import {
  AlignLeft,
  Bot,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FolderGit2,
  GitBranch,
  MessageSquare,
  Pencil,
  Plus,
  Search,
  Slack,
  SquarePen,
  Terminal,
  TriangleAlert,
  X,
} from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { LaborerClient } from '@/atoms/laborer-client'
import { GitHubPrStatusBadge } from '@/components/github-pr-status-badge'
import {
  applyTaskBoardEvents,
  type BoardTask,
  type BoardTaskStatus,
  boardTaskTitle,
  projectForTask,
  slackAnalysisState,
} from '@/components/kanban/board-data'
import { openProvisionedAgent } from '@/components/kanban/provisioned-agent'
import {
  TerminalAttachButton,
  WorktreeChip,
} from '@/components/kanban/worktree-affordance'
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@/components/ui/input-group'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import type { CollapseState } from '@/hooks/use-project-collapse-state'
import { openExternalUrl } from '@/lib/desktop'
import { cn, extractErrorCode, extractErrorMessage } from '@/lib/utils'
import { useLaborerStore } from '@/livestore/store'
import { usePanelActions } from '@/panels/panel-context'
import { TerminalPane } from '@/panes/terminal-pane'

const boardProjects$ = queryDb(projects, { label: 'boardProjects' })
const DONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const createTaskMutation = LaborerClient.mutation('task.create')
const moveTaskMutation = LaborerClient.mutation('task.move')
const updateTaskMutation = LaborerClient.mutation('task.update')
const attachTaskTerminalMutation = LaborerClient.mutation(
  'task.terminal.attach'
)

interface BoardColumn {
  readonly dotClassName: string
  readonly id: Exclude<BoardTaskStatus, 'cancelled'>
  readonly title: string
}

/** The four rendered columns, in board order. Cancelled never renders. */
const BOARD_COLUMNS: readonly BoardColumn[] = [
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
  if (source === 'agent') {
    return (
      <Badge
        className="shrink-0 gap-1 border-primary/30 bg-primary/5"
        variant="outline"
      >
        <Bot className="size-3" />
        Agent staged
      </Badge>
    )
  }
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
  if (mirror === 'needs-attention') {
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

/**
 * Background planning progress for a Slack card, derived from the durable
 * card fields rather than from any in-flight client request — so it survives
 * a restart and reads the same on every window.
 */
function SlackAnalysisBadge({ task }: { readonly task: BoardTask }) {
  const state = slackAnalysisState(task)
  if (state === null) {
    return null
  }
  if (state === 'failed') {
    return (
      <Badge
        className="gap-1 border-destructive/30 bg-destructive/10 text-destructive"
        title="Reading the Slack thread failed. The card stays in Todo — open the thread to check it."
        variant="outline"
      >
        <TriangleAlert aria-hidden="true" className="size-3" />
        Analysis failed
      </Badge>
    )
  }
  return (
    <Badge
      className="gap-1 text-muted-foreground"
      title="Reading the Slack thread to name this card and write its prompt."
      variant="outline"
    >
      <Spinner aria-hidden="true" className="size-3" />
      Analyzing…
    </Badge>
  )
}
/** Map PR state onto the existing badge's uppercase vocabulary. */
function toPrBadgeState(state: 'open' | 'merged' | 'closed'): string {
  return state.toUpperCase()
}

/**
 * Stable id for a card's terminal control, so closing the terminal panel can
 * hand keyboard focus back to the control that opened it.
 */
const terminalAttachButtonId = (taskId: string): string =>
  `terminal-attach-${taskId}`

function TaskBoardCard({
  task,
  attachBlocked = false,
  attached = false,
  attaching = false,
  isOverlay = false,
  onAttach,
  onCancel,
  onOpen,
}: {
  readonly task: BoardTask
  readonly attachBlocked?: boolean
  readonly attached?: boolean
  readonly attaching?: boolean
  readonly isOverlay?: boolean
  readonly onAttach?: (task: BoardTask) => void
  readonly onCancel?: (task: BoardTask) => void
  readonly onOpen?: (task: BoardTask) => void
}) {
  const openSlack = (event: React.MouseEvent) => {
    event.stopPropagation()
    if (task.slackPermalink) {
      openExternalUrl(task.slackPermalink)
    }
  }

  const analysis = slackAnalysisState(task)
  const title = boardTaskTitle(task)
  return (
    <Card
      aria-busy={analysis === 'analyzing' ? true : undefined}
      className={cn(
        'cursor-grab gap-0 rounded-md py-0 shadow-xs ring-foreground/10 transition-colors hover:ring-foreground/20',
        attached && 'ring-1 ring-ring/40',
        isOverlay && 'cursor-grabbing shadow-lg'
      )}
      onClick={() => onOpen?.(task)}
    >
      <CardContent className="flex flex-col gap-2 px-3 py-2.5">
        {/* Title row: source chip + slack link pinned right */}
        <div className="flex items-start justify-between gap-2">
          <p
            className={cn(
              'line-clamp-2 min-w-0 font-medium text-sm leading-snug',
              // An unnamed Slack card is a stand-in until the planner names it.
              title.isPlaceholder && 'text-muted-foreground italic'
            )}
          >
            {title.text}
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
          {!isOverlay && onOpen && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    aria-label={`Edit ${task.title}`}
                    className="mt-0.5 shrink-0 rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                    onClick={(event) => {
                      event.stopPropagation()
                      onOpen(task)
                    }}
                    type="button"
                  />
                }
              >
                <Pencil className="size-3.5" />
              </TooltipTrigger>
              <TooltipContent>Edit task details</TooltipContent>
            </Tooltip>
          )}
          {!isOverlay && task.source !== 'execution' && onCancel && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    aria-label={`Cancel ${task.title}`}
                    className="mt-0.5 shrink-0 rounded-sm p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    onClick={(event) => {
                      event.stopPropagation()
                      onCancel(task)
                    }}
                    type="button"
                  />
                }
              >
                <X className="size-3.5" />
              </TooltipTrigger>
              <TooltipContent>Cancel task</TooltipContent>
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

        {/* Meta chips: source, execution mirror, PR, worktree state, terminal */}
        <div className="flex flex-wrap items-center gap-1.5">
          <SourceBadge source={task.source} />
          {task.description !== null && (
            <Tooltip>
              <TooltipTrigger
                render={<span className="text-muted-foreground" />}
              >
                <AlignLeft aria-label="Has description" className="size-3.5" />
              </TooltipTrigger>
              <TooltipContent>Has description</TooltipContent>
            </Tooltip>
          )}
          <SlackAnalysisBadge task={task} />
          {/*
            While a Slack card is still being read, its analysis badge already
            speaks for the execution — two badges would say the same thing
            twice. Once the card is named, the mirror is about the run itself,
            so a failed run still surfaces here.
          */}
          {analysis === null && (
            <ExecutionMirrorBadge mirror={task.executionMirror} />
          )}
          {task.pr && (
            <GitHubPrStatusBadge
              prNumber={task.pr.number}
              prState={toPrBadgeState(task.pr.state)}
              prTitle={task.pr.title}
              prUrl={task.pr.url}
            />
          )}
          <WorktreeChip card={task} />
          {!isOverlay && (
            <TerminalAttachButton
              attached={attached}
              busy={attaching}
              card={task}
              disabled={attachBlocked}
              id={terminalAttachButtonId(task.id)}
              onAttach={() => onAttach?.(task)}
            />
          )}
        </div>
      </CardContent>
    </Card>
  )
}

/** What the typed text will become once committed. */
type ComposerIntent = 'empty' | 'manual' | 'slack' | 'unrecognized-link'

const LINK_LIKE_PATTERN = /^https?:\/\//i

/**
 * Classify composer text the way the server will: a recognized Slack message
 * permalink becomes a Slack card, anything else becomes a manual card. Text
 * that only looks like a link is called out before it silently becomes a card
 * titled with a URL.
 */
const composerIntent = (trimmed: string): ComposerIntent => {
  if (trimmed.length === 0) {
    return 'empty'
  }
  if (isSlackMessageUrl(trimmed)) {
    return 'slack'
  }
  return LINK_LIKE_PATTERN.test(trimmed) ||
    trimmed.toLowerCase().includes('slack.com')
    ? 'unrecognized-link'
    : 'manual'
}

/** The column header's Plus affordance, which toggles that column's composer. */
function AddCardButton({
  columnTitle,
  composerId,
  id,
  onToggle,
  open,
}: {
  readonly columnTitle: string
  readonly composerId: string
  readonly id: string
  readonly onToggle: () => void
  readonly open: boolean
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            // Only reference the composer while it exists in the tree.
            aria-controls={open ? composerId : undefined}
            aria-expanded={open}
            aria-label={`Add card to ${columnTitle}`}
            className={cn(
              'ml-auto text-muted-foreground',
              open && 'bg-accent text-foreground'
            )}
            id={id}
            onClick={onToggle}
            size="icon-xs"
            type="button"
            variant="ghost"
          />
        }
      >
        <Plus
          className={cn('size-3.5 transition-transform', open && 'rotate-45')}
        />
      </TooltipTrigger>
      <TooltipContent>{open ? 'Close composer' : 'Add card'}</TooltipContent>
    </Tooltip>
  )
}

/**
 * Why the composer closed. Esc is a deliberate cancel, so focus goes back to
 * the control that opened it; a blur means the person is already somewhere
 * else and moving their focus again would yank them back.
 */
type ComposerCloseReason = 'cancel' | 'blur'

/**
 * The inline card composer for one column: Enter commits, Esc cancels. It
 * stays open after a commit so several cards can be typed in a row, and it
 * reports what the text will become before it is committed.
 */
function AddCardComposer({
  column,
  composerId,
  onClose,
  projectId,
}: {
  readonly column: BoardColumn
  readonly composerId: string
  readonly onClose: (reason: ComposerCloseReason) => void
  readonly projectId: string
}) {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const createTask = useAtomSet(createTaskMutation, { mode: 'promise' })
  const panelActions = usePanelActions()
  const trimmed = value.trim()
  const intent = composerIntent(trimmed)

  const submit = async () => {
    if (intent === 'empty' || submitting) {
      return
    }
    setSubmitting(true)
    setError(null)
    setConfirmation(null)
    try {
      const created = await createTask({
        payload: { projectId, status: column.id, text: trimmed },
      })
      openProvisionedAgent(
        created,
        panelActions?.autoOpenAgentWhenWorkspaceReady
      )
      setValue('')
      setConfirmation(
        created.source === 'slack_url'
          ? 'Slack card added to Todo — analyzing in the background.'
          : `Card added to ${column.title}.`
      )
    } catch (cause) {
      // Keep the text so the person can correct it and try again.
      setError(extractErrorMessage(cause))
    } finally {
      setSubmitting(false)
      inputRef.current?.focus()
    }
  }

  const hint = (() => {
    if (submitting) {
      return { className: 'text-muted-foreground', text: 'Adding…' }
    }
    if (error !== null) {
      return { className: 'text-destructive', text: error }
    }
    if (intent === 'slack') {
      return {
        className: 'text-muted-foreground',
        text:
          column.id === 'todo'
            ? 'Slack link — analyzed in the background.'
            : 'Slack link — added to Todo and analyzed in the background.',
      }
    }
    if (intent === 'unrecognized-link') {
      return {
        className: 'text-warning',
        text: 'Not a Slack message link — this becomes a manual card titled with the URL.',
      }
    }
    if (confirmation !== null) {
      return { className: 'text-muted-foreground', text: confirmation }
    }
    return {
      className: 'text-muted-foreground',
      text: 'Enter to add · Esc to close',
    }
  })()

  return (
    <div className="flex flex-col gap-1 px-2 pt-1.5" id={composerId}>
      <InputGroup className="bg-background">
        <InputGroupAddon>
          {submitting && <Spinner aria-hidden="true" className="size-3.5" />}
          {!submitting && intent === 'slack' && (
            <Slack aria-hidden="true" className="size-3.5" />
          )}
          {!(submitting || intent === 'slack') && (
            <SquarePen aria-hidden="true" className="size-3.5" />
          )}
        </InputGroupAddon>
        <InputGroupInput
          aria-describedby={`${composerId}-hint`}
          aria-invalid={error !== null}
          aria-label={`Card title or Slack message link for ${column.title}`}
          autoFocus
          className="text-xs"
          onBlur={() => {
            // An abandoned empty composer closes itself; typed text stays put.
            if (!submitting && trimmed.length === 0) {
              onClose('blur')
            }
          }}
          onChange={(event) => {
            setValue(event.target.value)
            setError(null)
            setConfirmation(null)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              onClose('cancel')
            } else if (event.key === 'Enter') {
              event.preventDefault()
              submit()
            }
          }}
          placeholder="Title, or paste a Slack link"
          // Read-only rather than disabled: a disabled input drops focus, so
          // the caret would leave the composer on every commit.
          readOnly={submitting}
          ref={inputRef}
          value={value}
        />
      </InputGroup>
      <p
        aria-live="polite"
        className={cn('min-h-4 px-0.5 text-[11px]', hint.className)}
        id={`${composerId}-hint`}
      >
        {hint.text}
      </p>
    </div>
  )
}

/**
 * One project lane's 4-column kanban. Its own Kanban root, so drags can
 * never cross projects.
 */
function LaneBoard({
  attachedTaskId,
  attachingTaskId,
  onAttach,
  onCancelTask,
  onMoveTask,
  onOpenTask,
  projectId,
  tasks,
}: {
  readonly attachedTaskId: string | null
  readonly attachingTaskId: string | null
  readonly onAttach: (task: BoardTask) => void
  readonly onCancelTask: (task: BoardTask) => void
  readonly onMoveTask: (
    task: BoardTask,
    status: Exclude<BoardTaskStatus, 'cancelled'>
  ) => Promise<void>
  readonly onOpenTask: (task: BoardTask) => void
  readonly projectId: string
  readonly tasks: readonly BoardTask[]
}) {
  const [columnTasks, setColumnTasks] = useState<Record<string, BoardTask[]>>(
    () => buildColumnTasks(tasks)
  )
  // At most one composer per lane, so the board never grows four open inputs.
  const [composerColumn, setComposerColumn] = useState<
    BoardColumn['id'] | null
  >(null)
  const laneId = useId()

  // Server-side card changes reset the local drag state without remounting the
  // lane, so a card arriving in the background never steals a half-typed
  // composer or its focus.
  const signature = useMemo(
    () => tasks.map((task) => `${task.id}:${String(task.revision)}`).join(','),
    [tasks]
  )
  const [syncedSignature, setSyncedSignature] = useState(signature)
  if (syncedSignature !== signature) {
    setSyncedSignature(signature)
    setColumnTasks(buildColumnTasks(tasks))
  }

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

  return (
    <Kanban
      className="w-full min-w-0"
      getItemValue={(task: BoardTask) => task.id}
      onMove={({ event, activeContainer, overContainer }) => {
        if (activeContainer === overContainer) {
          return
        }
        const task = tasksById.get(String(event.active.id))
        const status = BOARD_COLUMNS.find(
          (column) => column.id === overContainer
        )?.id
        if (!(task && status)) {
          setColumnTasks(buildColumnTasks(tasks))
          return
        }
        onMoveTask(task, status).catch(() => {
          setColumnTasks(buildColumnTasks(tasks))
        })
      }}
      onValueChange={setColumnTasks}
      value={columnTasks}
    >
      <KanbanBoard className="grid min-w-0 grid-cols-4 gap-2 sm:grid-cols-4">
        {BOARD_COLUMNS.map((column) => {
          const composerId = `${laneId}-${column.id}-composer`
          const addButtonId = `${laneId}-${column.id}-add`
          const composerOpen = composerColumn === column.id
          const closeComposer = (reason: ComposerCloseReason) => {
            setComposerColumn(null)
            if (reason === 'cancel') {
              document.getElementById(addButtonId)?.focus()
            }
          }

          return (
            <KanbanColumn className="min-w-0" key={column.id} value={column.id}>
              <div className="flex min-w-0 flex-col rounded-lg bg-muted/50">
                <div className="flex min-w-0 items-center gap-2 pt-1.5 pr-1.5 pb-0.5 pl-3">
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
                  <AddCardButton
                    columnTitle={column.title}
                    composerId={composerId}
                    id={addButtonId}
                    onToggle={() =>
                      setComposerColumn(composerOpen ? null : column.id)
                    }
                    open={composerOpen}
                  />
                </div>
                {composerOpen && (
                  <AddCardComposer
                    column={column}
                    composerId={composerId}
                    onClose={closeComposer}
                    projectId={projectId}
                  />
                )}
                <KanbanColumnContent
                  className="flex min-h-24 flex-1 flex-col gap-2 px-2 pt-1.5 pb-2"
                  value={column.id}
                >
                  {(columnTasks[column.id] ?? []).map((task) => (
                    <KanbanItem key={task.id} value={task.id}>
                      <KanbanItemHandle>
                        <TaskBoardCard
                          attachBlocked={
                            attachingTaskId !== null &&
                            attachingTaskId !== task.id
                          }
                          attached={attachedTaskId === task.id}
                          attaching={attachingTaskId === task.id}
                          onAttach={onAttach}
                          onCancel={onCancelTask}
                          onOpen={onOpenTask}
                          task={task}
                        />
                      </KanbanItemHandle>
                    </KanbanItem>
                  ))}
                  {(columnTasks[column.id] ?? []).length === 0 &&
                    (composerOpen ? (
                      <div className="rounded-md border border-dashed p-3 text-center text-muted-foreground text-xs">
                        No cards
                      </div>
                    ) : (
                      <button
                        aria-label={`Add the first card to ${column.title}`}
                        className="rounded-md border border-dashed p-3 text-center text-muted-foreground text-xs transition-colors hover:border-foreground/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => setComposerColumn(column.id)}
                        type="button"
                      >
                        No cards — add one
                      </button>
                    ))}
                </KanbanColumnContent>
                {column.id === 'done' && (
                  <p className="px-3 pb-2 text-[10px] text-muted-foreground/70">
                    Done cards auto-hide after 7 days
                  </p>
                )}
              </div>
            </KanbanColumn>
          )
        })}
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

function TaskDetailDialog({
  onOpenChange,
  task,
}: {
  readonly onOpenChange: (open: boolean) => void
  readonly task: BoardTask
}) {
  const [title, setTitle] = useState(task.title)
  const [description, setDescription] = useState(task.description ?? '')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<{
    readonly conflict: boolean
    readonly message: string
  } | null>(null)
  const updateTask = useAtomSet(updateTaskMutation, { mode: 'promise' })
  const normalizedDescription = description.length === 0 ? null : description
  const dirty = title !== task.title || description !== (task.description ?? '')

  const save = async () => {
    if (saving || !dirty || title.trim().length === 0) {
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      await updateTask({
        payload: {
          description: normalizedDescription,
          expectedRevision: task.revision,
          taskId: task.id,
          title,
        },
      })
      onOpenChange(false)
    } catch (error) {
      const conflict = extractErrorCode(error) === 'CAS_CONFLICT'
      const message = conflict
        ? 'This task changed elsewhere. The latest version will replace this draft when it arrives.'
        : extractErrorMessage(error)
      setSaveError({ conflict, message })
      toast.error(conflict ? 'Task changed elsewhere' : 'Could not save task', {
        description: message,
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader className="gap-3 pr-8">
          <div className="flex flex-wrap items-center gap-2">
            <DialogTitle>Edit task</DialogTitle>
            <SourceBadge source={task.source} />
          </div>
          <DialogDescription>
            Refine the card and the instructions used when its agent launches.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-5"
          onSubmit={(event) => {
            event.preventDefault()
            save()
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="task-detail-title">Title</Label>
            <Input
              autoFocus
              disabled={saving}
              id="task-detail-title"
              maxLength={100}
              onChange={(event) => {
                setTitle(event.target.value)
                setSaveError(null)
              }}
              value={title}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="task-detail-description">Description</Label>
            <Textarea
              aria-describedby="task-detail-description-help"
              className="min-h-40 resize-y"
              disabled={saving}
              id="task-detail-description"
              maxLength={100_000}
              onChange={(event) => {
                setDescription(event.target.value)
                setSaveError(null)
              }}
              placeholder="What should the agent know or do?"
              value={description}
            />
            <div
              className="flex flex-col gap-1 text-muted-foreground text-xs sm:flex-row sm:items-center sm:justify-between"
              id="task-detail-description-help"
            >
              <span>Plain text · used as the agent’s initial prompt</span>
              <span className="tabular-nums">
                {description.length.toLocaleString()} / 100,000
              </span>
            </div>
          </div>
          {saveError && (
            <div
              aria-live="polite"
              className={cn(
                'flex gap-2 rounded-md border px-3 py-2 text-sm',
                saveError.conflict
                  ? 'border-warning/30 bg-warning/10 text-warning'
                  : 'border-destructive/30 bg-destructive/10 text-destructive'
              )}
              role="alert"
            >
              <TriangleAlert
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0"
              />
              <span>{saveError.message}</span>
            </div>
          )}
          <DialogFooter className="mt-1">
            <Button
              disabled={saving}
              onClick={() => onOpenChange(false)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={saving || !dirty || title.trim().length === 0}
              type="submit"
            >
              {saving ? 'Saving…' : 'Save changes'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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
  const panelActions = usePanelActions()
  const [searchQuery, setSearchQuery] = useState('')
  const [boardTasks, setBoardTasks] = useState<readonly BoardTask[]>([])
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [attachingTaskId, setAttachingTaskId] = useState<string | null>(null)
  const attachingTaskIdRef = useRef<string | null>(null)
  const [attachedTerminal, setAttachedTerminal] = useState<{
    readonly botOwned: boolean
    readonly id: string
    readonly taskId: string
    readonly taskTitle: string
    readonly worktreePath: string
  } | null>(null)
  const attachTaskTerminal = useAtomSet(attachTaskTerminalMutation, {
    mode: 'promise',
  })
  const moveTask = useAtomSet(moveTaskMutation, { mode: 'promise' })
  const taskEventsAtom = useMemo(
    () =>
      LaborerClient.runtime.pull(
        LaborerClient.pipe(
          Effect.map((client) =>
            // biome-ignore lint/suspicious/noConfusingVoidType: Effect RPC uses void for empty payloads
            client('task.board.subscribe', undefined as void)
          ),
          Stream.unwrap
        ),
        { disableAccumulation: true }
      ),
    []
  )
  const rpcResult = useAtomValue(taskEventsAtom)
  const pullNext = useAtomSet(taskEventsAtom)

  useEffect(() => {
    if (Result.isSuccess(rpcResult) && !rpcResult.waiting) {
      setBoardTasks((current) =>
        applyTaskBoardEvents(rpcResult.value.items, current)
      )
      // biome-ignore lint/suspicious/noConfusingVoidType: pull atom write type is void
      pullNext(undefined as void)
    } else if (Result.isFailure(rpcResult)) {
      setBoardTasks([])
    }
  }, [pullNext, rpcResult])

  // Closing hands focus back to the card control that opened the terminal, so
  // a keyboard user lands where they left rather than at the top of the board.
  const closeTerminal = () => {
    const returnTo = attachedTerminal
      ? document.getElementById(terminalAttachButtonId(attachedTerminal.taskId))
      : null
    setAttachedTerminal(null)
    returnTo?.focus()
  }

  const handleAttach = (task: BoardTask) => {
    // The control is a toggle once attached: a second press closes the panel
    // it opened rather than spawning a second shell.
    if (attachedTerminal?.taskId === task.id) {
      closeTerminal()
      return
    }
    // State disables the controls visually; the ref closes the same-render
    // double-click window before React has committed that state.
    if (attachingTaskIdRef.current !== null) {
      return
    }
    attachingTaskIdRef.current = task.id
    setAttachingTaskId(task.id)
    attachTaskTerminal({ payload: { taskId: task.id } })
      .then(({ botOwned, terminal }) => {
        setBoardTasks((current) =>
          current.map((candidate) =>
            candidate.id === task.id
              ? {
                  ...candidate,
                  worktreeBotOwned: botOwned,
                  worktreeExists: true,
                  worktreeState: 'exists',
                }
              : candidate
          )
        )
        setAttachedTerminal({
          botOwned,
          id: terminal.id,
          taskId: task.id,
          taskTitle: task.title,
          worktreePath: task.worktreePath ?? '',
        })
      })
      .catch((error: unknown) => {
        if (extractErrorCode(error) === 'WORKTREE_NOT_FOUND') {
          setBoardTasks((current) =>
            current.map((candidate) =>
              candidate.id === task.id
                ? {
                    ...candidate,
                    worktreeBotOwned: false,
                    worktreeExists: false,
                    worktreeState:
                      candidate.worktreeState === 'provisioning'
                        ? 'provisioning'
                        : 'gone',
                  }
                : candidate
            )
          )
          if (task.worktreeState === 'provisioning') {
            toast.info('Worktree is still provisioning', {
              description: 'The terminal opens once it lands on disk.',
            })
          } else {
            toast.error(`Could not open a terminal for ${task.title}`, {
              description: 'The task worktree is no longer available on disk.',
            })
          }
        } else {
          toast.error(`Could not open a terminal for ${task.title}`, {
            description: extractErrorMessage(error),
          })
        }
      })
      .finally(() => {
        attachingTaskIdRef.current = null
        setAttachingTaskId(null)
      })
  }

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
  // Keep the dialog bound to the board projection rather than to the card
  // snapshot that opened it. A CAS conflict's next poll therefore remounts
  // the form with the winning revision instead of leaving stale fields open.
  const selectedTask = boardTasks.find((task) => task.id === selectedTaskId)

  const persistMove = async (
    task: BoardTask,
    status: Exclude<BoardTaskStatus, 'cancelled'>
  ) => {
    try {
      const result = await moveTask({
        payload: {
          expectedRevision: task.revision,
          status,
          taskId: task.id,
        },
      })
      if (result.workspaceId !== null) {
        openProvisionedAgent(
          result,
          panelActions?.autoOpenAgentWhenWorkspaceReady
        )
      }
    } catch (error) {
      toast.error(`Could not move “${task.title}”`, {
        description: extractErrorMessage(error),
      })
      throw error
    }
  }

  const cancelTask = (task: BoardTask) => {
    // Hide immediately; the subscription delta confirms the durable state.
    setBoardTasks((current) => current.filter(({ id }) => id !== task.id))
    moveTask({
      payload: {
        expectedRevision: task.revision,
        status: 'cancelled',
        taskId: task.id,
      },
    }).catch((error) => {
      setBoardTasks((current) =>
        current.some(({ id }) => id === task.id) ? current : [...current, task]
      )
      toast.error(`Could not cancel “${task.title}”`, {
        description: extractErrorMessage(error),
      })
    })
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col">
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
                    attachedTaskId={attachedTerminal?.taskId ?? null}
                    attachingTaskId={attachingTaskId}
                    onAttach={handleAttach}
                    onCancelTask={cancelTask}
                    onMoveTask={persistMove}
                    onOpenTask={(task) => setSelectedTaskId(task.id)}
                    projectId={project.id}
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
      {attachedTerminal && (
        <section
          aria-label={`Terminal for ${attachedTerminal.taskTitle}`}
          className="absolute inset-y-0 right-0 z-30 flex w-[min(48rem,66%)] min-w-96 flex-col border-l bg-background shadow-2xl"
        >
          <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
            <Terminal className="size-4 shrink-0 text-muted-foreground" />
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex min-w-0 items-center gap-1.5">
                <h2 className="min-w-0 truncate font-medium text-sm">
                  {attachedTerminal.taskTitle}
                </h2>
                {attachedTerminal.botOwned && (
                  <Badge
                    className="gap-1 text-muted-foreground"
                    variant="outline"
                  >
                    <Bot className="size-3" />
                    Bot worktree
                  </Badge>
                )}
              </div>
              {attachedTerminal.worktreePath && (
                <span
                  className="truncate font-mono text-[11px] text-muted-foreground"
                  title={attachedTerminal.worktreePath}
                >
                  {attachedTerminal.worktreePath}
                </span>
              )}
            </div>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label={`Close terminal for ${attachedTerminal.taskTitle}`}
                    onClick={closeTerminal}
                    size="icon-sm"
                    variant="ghost"
                  />
                }
              >
                <X className="size-4" />
              </TooltipTrigger>
              <TooltipContent>Close terminal</TooltipContent>
            </Tooltip>
          </header>
          <div className="min-h-0 flex-1">
            <TerminalPane
              onTerminalExit={closeTerminal}
              terminalId={attachedTerminal.id}
            />
          </div>
        </section>
      )}
      {selectedTask && (
        <TaskDetailDialog
          key={`${selectedTask.id}:${String(selectedTask.revision)}`}
          onOpenChange={(open) => {
            if (!open) {
              setSelectedTaskId(null)
            }
          }}
          task={selectedTask}
        />
      )}
    </div>
  )
}

export { TaskBoard, TaskBoardCard, TaskDetailDialog }
