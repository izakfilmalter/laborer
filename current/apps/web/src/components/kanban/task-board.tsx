/**
 * Shared-task-db kanban board — an overlay above the panel area (Cmd+K).
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
import { projects, workspaces } from '@laborer/shared/schema'
import { isSlackMessageUrl } from '@laborer/shared/slack-url'
import { queryDb } from '@livestore/livestore'
import { Cause, Effect, Schedule, Stream } from 'effect'
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
  Slack,
  SquarePen,
  Terminal,
  TriangleAlert,
  X,
} from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { LaborerClient } from '@/atoms/laborer-client'
import { CardShell } from '@/components/card-shell'
import { GitHubPrStatusBadge } from '@/components/github-pr-status-badge'
import {
  applyTaskBoardEvents,
  type BoardTask,
  type BoardTaskStatus,
  boardTaskTitle,
  projectForTask,
  slackAnalysisState,
  workspaceForTask,
} from '@/components/kanban/board-data'
import { BoardSearch } from '@/components/kanban/board-search'
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

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@/components/ui/input-group'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  WorkspaceCard,
  type WorkspaceCardWorkspace,
} from '@/components/workspace-card'
import type { CollapseState } from '@/hooks/use-project-collapse-state'
import { openExternalUrl } from '@/lib/desktop'
import { cn, extractErrorCode, extractErrorMessage } from '@/lib/utils'
import { useLaborerStore } from '@/livestore/store'
import { usePanelActions } from '@/panels/panel-context'
import { TerminalPane } from '@/panes/terminal-pane'

const boardProjects$ = queryDb(projects, { label: 'boardProjects' })
const boardWorkspaces$ = queryDb(workspaces, { label: 'boardWorkspaces' })
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

/**
 * How each card source presents itself. Agent-staged cards are the only
 * source that carries a tint: a card that appeared without a person asking
 * for it is the one worth spotting in a column of otherwise human work.
 * Every source explains its provenance on hover, since the chips are small.
 */
const SOURCE_BADGES: Record<
  BoardTask['source'],
  {
    readonly className: string
    readonly hint: string
    readonly icon: typeof Bot
    readonly label: string
  }
> = {
  agent: {
    className: 'border-primary/30 bg-primary/5 text-foreground',
    hint: 'Staged by an agent — nobody typed this card into a column.',
    icon: Bot,
    label: 'Agent staged',
  },
  execution: {
    className: 'text-muted-foreground',
    hint: 'Mirrored from an agent run.',
    icon: Bot,
    label: 'Agent',
  },
  manual: {
    className: 'text-muted-foreground',
    hint: 'Typed into a column composer.',
    icon: SquarePen,
    label: 'Manual',
  },
  slack_url: {
    className: 'text-muted-foreground',
    hint: 'Created from a Slack message link.',
    icon: MessageSquare,
    label: 'Slack',
  },
  worktree: {
    className: 'text-muted-foreground',
    hint: 'Adopted from an existing git worktree.',
    icon: GitBranch,
    label: 'Worktree',
  },
}

/** Chip showing where the card came from. */
function SourceBadge({ source }: { readonly source: BoardTask['source'] }) {
  const badge = SOURCE_BADGES[source]
  const Icon = badge.icon
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge
            className={cn('shrink-0 gap-1', badge.className)}
            variant="outline"
          />
        }
      >
        <Icon aria-hidden="true" className="size-3" />
        {badge.label}
      </TooltipTrigger>
      <TooltipContent>{badge.hint}</TooltipContent>
    </Tooltip>
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
        title="Reading the Slack thread failed. Open the thread to check it; moving the card into In Progress retries the analysis."
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

/** A card's workspace, and the project context the workspace card needs. */
interface BoardCardWorkspace {
  /** Whether the workspace is the project's own checkout. */
  readonly isRoot: boolean
  readonly projectName: string
  readonly row: WorkspaceCardWorkspace
}

/**
 * One card on the board — the sidebar's card, wherever the work is shown.
 *
 * A card whose work already has a workspace *is* that workspace's card, so a
 * piece of work reads and behaves the same on both surfaces. Until then the
 * card is all there is, and it says so: a lighter shell with the worktree
 * affordances that stand in for a workspace nobody has created yet.
 *
 * Activating a card takes you to its work: the workspace it runs in, or the
 * card's own details while there is none. Editing is its own button — a card
 * whose body opens a workspace cannot also open a form.
 */
function TaskBoardCard({
  task,
  attachBlocked = false,
  attached = false,
  attaching = false,
  isOverlay = false,
  onActivate,
  onAttach,
  onCancel,
  onOpen,
  workspace,
}: {
  readonly task: BoardTask
  readonly attachBlocked?: boolean
  readonly attached?: boolean
  readonly attaching?: boolean
  readonly isOverlay?: boolean
  readonly onActivate?: (task: BoardTask) => void
  readonly onAttach?: (task: BoardTask) => void
  readonly onCancel?: (task: BoardTask) => void
  readonly onOpen?: (task: BoardTask) => void
  /** The workspace this card's work already runs in, if any. */
  readonly workspace?: BoardCardWorkspace | undefined
}) {
  const openSlack = (event: React.MouseEvent) => {
    event.stopPropagation()
    if (task.slackPermalink) {
      openExternalUrl(task.slackPermalink)
    }
  }

  const analysis = slackAnalysisState(task)
  const title = boardTaskTitle(task)
  const activate = isOverlay || !onActivate ? undefined : () => onActivate(task)

  // What the board adds to whichever card shape shows this task: its Slack
  // thread, the form that names it, and the cancel that takes it off the board.
  const boardActions = (
    <>
      {task.slackPermalink && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label="Open Slack thread"
                onClick={openSlack}
                size="icon-xs"
                variant="ghost"
              />
            }
          >
            <ExternalLink className="size-3.5 text-muted-foreground" />
          </TooltipTrigger>
          <TooltipContent>Open Slack thread</TooltipContent>
        </Tooltip>
      )}
      {!isOverlay && onOpen && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label={`Edit ${title.text}`}
                onClick={(event) => {
                  event.stopPropagation()
                  onOpen(task)
                }}
                size="icon-xs"
                variant="ghost"
              />
            }
          >
            <Pencil className="size-3.5 text-muted-foreground" />
          </TooltipTrigger>
          <TooltipContent>Edit card</TooltipContent>
        </Tooltip>
      )}
      {!isOverlay && task.source !== 'execution' && onCancel && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label={`Cancel ${title.text}`}
                className="hover:bg-destructive/10 hover:text-destructive"
                onClick={(event) => {
                  event.stopPropagation()
                  onCancel(task)
                }}
                size="icon-xs"
                variant="ghost"
              />
            }
          >
            <X className="size-3.5 text-muted-foreground" />
          </TooltipTrigger>
          <TooltipContent>Cancel task</TooltipContent>
        </Tooltip>
      )}
    </>
  )

  // Where the card came from, and what is happening to it — the chips a
  // workspace has no way of knowing about.
  const boardBadges = (
    <>
      <SourceBadge source={task.source} />
      {task.description !== null && (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                aria-label="Has description"
                className="inline-flex size-5 shrink-0 items-center justify-center text-muted-foreground"
                role="img"
              />
            }
          >
            <AlignLeft aria-hidden="true" className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent>Has description</TooltipContent>
        </Tooltip>
      )}
      <SlackAnalysisBadge task={task} />
      {/*
        While a Slack card is still being read, its analysis badge already
        speaks for the execution — two badges would say the same thing twice.
        Once the card is named, the mirror is about the run itself, so a failed
        run still surfaces here.
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
    </>
  )

  // Work that already has a workspace is shown as that workspace: same
  // branch, same status, same terminals, same Agent / New controls the
  // sidebar offers. The board keeps only what is its own.
  if (workspace) {
    return (
      <WorkspaceCard
        actions={boardActions}
        activateLabel={`Open workspace for ${title.text}`}
        badges={boardBadges}
        isRootWorkspace={workspace.isRoot}
        onActivate={activate}
        projectName={workspace.projectName}
        showCreateSubWorkspaceAction={false}
        // Destroying a workspace belongs where the workspace lives. The
        // board's destructive act is cancelling the card.
        showDestroyAction={false}
        subtitle={
          <p className="line-clamp-2 text-muted-foreground text-xs">
            {title.text}
          </p>
        }
        workspace={workspace.row}
      />
    )
  }

  // Nothing has started yet, so there is no workspace to wear. The card
  // stands in for one: what it is, and whether a worktree is waiting on disk.
  return (
    <CardShell
      actions={boardActions}
      activateLabel={`Card details for ${title.text}`}
      aria-busy={analysis === 'analyzing' ? true : undefined}
      badges={
        <>
          {boardBadges}
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
        </>
      }
      className={cn(
        attached && 'ring-1 ring-ring/40',
        isOverlay && 'shadow-lg'
      )}
      onActivate={activate}
      subtitle={
        task.branch ? (
          <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
            <GitBranch className="size-3 shrink-0" />
            <span className="truncate font-mono text-xs">{task.branch}</span>
          </div>
        ) : null
      }
      title={
        <span
          className={cn(
            'line-clamp-2',
            // An unnamed Slack card is a stand-in until the planner names it.
            title.isPlaceholder && 'text-muted-foreground italic'
          )}
        >
          {title.text}
        </span>
      }
    />
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
 * The inline card composer for one column: Enter commits, pasting a complete
 * Slack permalink commits immediately, and Esc cancels. It stays open after a
 * commit so several cards can be typed in a row, and it reports what the text
 * will become before it is committed.
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

  const submit = async (text = trimmed) => {
    const submissionText = text.trim()
    if (composerIntent(submissionText) === 'empty' || submitting) {
      return
    }
    setSubmitting(true)
    setError(null)
    setConfirmation(null)
    try {
      const created = await createTask({
        payload: { projectId, status: column.id, text: submissionText },
      })
      openProvisionedAgent(
        created,
        panelActions?.autoOpenAgentWhenWorkspaceReady
      )
      setValue('')
      setConfirmation(
        created.source === 'slack_url'
          ? `Slack card added to ${column.title} — analyzing in the background.`
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
          column.id === 'in_progress'
            ? 'Slack link — analyzed in the background, then a workspace opens.'
            : 'Slack link — analyzed in the background.',
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
          onPaste={(event) => {
            const pastedText = event.clipboardData.getData('text')
            const input = event.currentTarget
            const selectionStart = input.selectionStart ?? input.value.length
            const selectionEnd = input.selectionEnd ?? selectionStart
            const nextValue = `${input.value.slice(0, selectionStart)}${pastedText}${input.value.slice(selectionEnd)}`
            const nextText = nextValue.trim()

            if (!isSlackMessageUrl(nextText)) {
              return
            }

            // Submit the post-paste value directly. Waiting for React state
            // would submit the value from the render before the paste.
            event.preventDefault()
            setValue(nextValue)
            setError(null)
            setConfirmation(null)
            submit(nextText)
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
  onActivateTask,
  onAttach,
  onCancelTask,
  onMoveTask,
  onOpenTask,
  projectId,
  tasks,
  workspaceForCard,
}: {
  readonly attachedTaskId: string | null
  readonly attachingTaskId: string | null
  readonly onActivateTask: (task: BoardTask) => void
  readonly onAttach: (task: BoardTask) => void
  readonly onCancelTask: (task: BoardTask) => void
  readonly onMoveTask: (
    task: BoardTask,
    status: Exclude<BoardTaskStatus, 'cancelled'>
  ) => Promise<void>
  readonly onOpenTask: (task: BoardTask) => void
  readonly projectId: string
  readonly tasks: readonly BoardTask[]
  /** The workspace a card's work runs in, once it has one. */
  readonly workspaceForCard: (task: BoardTask) => BoardCardWorkspace | undefined
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
                          onActivate={onActivateTask}
                          onAttach={onAttach}
                          onCancel={onCancelTask}
                          onOpen={onOpenTask}
                          task={task}
                          workspace={workspaceForCard(task)}
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
          return (
            <TaskBoardCard
              isOverlay
              task={task}
              workspace={workspaceForCard(task)}
            />
          )
        }}
      </KanbanOverlay>
    </Kanban>
  )
}

const DESCRIPTION_LIMIT = 100_000
const TITLE_LIMIT = 100
/** Where the title counter starts earning its place on screen. */
const TITLE_COUNTER_THRESHOLD = 80

/**
 * The card's unchangeable context — which column it sits in, its branch, its
 * Slack thread. Read-only and muted, so it frames the two editable fields
 * without competing with them.
 */
function TaskDetailMeta({ task }: { readonly task: BoardTask }) {
  const column = BOARD_COLUMNS.find(({ id }) => id === task.status)
  const slackPermalink = task.slackPermalink
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-muted/50 px-2.5 py-1.5 text-muted-foreground text-xs">
      {column && (
        <span className="flex items-center gap-1.5">
          <span
            className={cn(
              'inline-block size-2 shrink-0 rounded-full',
              column.dotClassName
            )}
          />
          {column.title}
        </span>
      )}
      {task.branch && (
        <span className="flex min-w-0 items-center gap-1.5">
          <GitBranch aria-hidden="true" className="size-3 shrink-0" />
          <span className="truncate font-mono">{task.branch}</span>
        </span>
      )}
      {slackPermalink && (
        <button
          className="flex items-center gap-1.5 rounded-sm underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => openExternalUrl(slackPermalink)}
          type="button"
        >
          <ExternalLink aria-hidden="true" className="size-3 shrink-0" />
          Slack thread
        </button>
      )}
    </div>
  )
}

/**
 * The dialog's action bar. It has two modes: ordinary editing, and the
 * confirmation shown when someone tries to leave with unsaved work — the
 * question and its answers replace the normal actions rather than stacking a
 * second dialog on top of the first.
 */
function TaskDetailFooter({
  canSave,
  confirmingDiscard,
  dirty,
  onCancel,
  onDiscard,
  onKeepEditing,
  saving,
}: {
  readonly canSave: boolean
  readonly confirmingDiscard: boolean
  readonly dirty: boolean
  readonly onCancel: () => void
  readonly onDiscard: () => void
  readonly onKeepEditing: () => void
  readonly saving: boolean
}) {
  const status = (() => {
    if (saving) {
      return 'Saving…'
    }
    return dirty ? 'Unsaved changes' : 'No changes yet'
  })()

  if (confirmingDiscard) {
    return (
      <DialogFooter className="mt-1 sm:items-center sm:justify-between">
        {/* The question replaces the usual actions, so it has to announce
            itself — a screen reader user gets no other signal that the buttons
            under their fingers changed meaning. */}
        <p className="text-sm text-warning" role="alert">
          Discard your unsaved edits?
        </p>
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <Button onClick={onDiscard} type="button" variant="outline">
            Discard
          </Button>
          <Button autoFocus onClick={onKeepEditing} type="button">
            Keep editing
          </Button>
        </div>
      </DialogFooter>
    )
  }

  return (
    <DialogFooter className="mt-1 sm:items-center sm:justify-between">
      <p
        aria-live="polite"
        className="flex min-h-5 items-center gap-1.5 text-muted-foreground text-xs"
      >
        {saving && <Spinner aria-hidden="true" className="size-3" />}
        {status}
      </p>
      <div className="flex flex-col-reverse gap-2 sm:flex-row">
        <Button
          disabled={saving}
          onClick={onCancel}
          type="button"
          variant="outline"
        >
          Cancel
        </Button>
        <Button disabled={!canSave} type="submit">
          Save changes
          {/* Hidden from the accessible name: “Save changes ⌘ ↵” reads as
              gibberish, and the shortcut is a sighted-user affordance. */}
          <KbdGroup aria-hidden="true">
            <Kbd>⌘</Kbd>
            <Kbd>↵</Kbd>
          </KbdGroup>
        </Button>
      </div>
    </DialogFooter>
  )
}

/**
 * The card detail surface: what the card is called, the brief its agent starts
 * from, and where the card came from.
 *
 * The two editable fields are the whole point, so everything else stays quiet —
 * provenance and branch sit in one muted strip above them rather than competing
 * for the eye. Edits are held locally until Save, so an unfinished rewrite is
 * never half-committed, and an attempt to leave with unsaved work asks first
 * instead of dropping it.
 */
function TaskDetailDialog({
  onOpenChange,
  task,
}: {
  readonly onOpenChange: (open: boolean) => void
  readonly task: BoardTask
}) {
  const presented = boardTaskTitle(task)
  // An unnamed Slack card stores its permalink as the title. A raw URL in the
  // field reads like a mistake to correct, so the field starts empty behind a
  // prompt and the card keeps its stand-in until someone names it.
  const incomingTitle = presented.isPlaceholder ? '' : task.title
  const incomingDescription = task.description ?? ''
  const [title, setTitle] = useState(incomingTitle)
  const [description, setDescription] = useState(incomingDescription)
  // What the draft is measured against: the card as it stood when the form
  // last took its values from the board.
  const [baseline, setBaseline] = useState({
    description: incomingDescription,
    revision: task.revision,
    title: incomingTitle,
  })
  const [saving, setSaving] = useState(false)
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)
  const [changedElsewhere, setChangedElsewhere] = useState(false)
  const [saveError, setSaveError] = useState<{
    readonly conflict: boolean
    readonly message: string
  } | null>(null)
  // The field the caret was last in, so leaving the discard question can put it
  // back where it was instead of dropping focus on the body.
  const lastFieldRef = useRef<HTMLElement | null>(null)
  const fieldId = useId()
  const titleId = `${fieldId}-title`
  const titleMessageId = `${fieldId}-title-message`
  const descriptionId = `${fieldId}-description`
  const descriptionHelpId = `${fieldId}-description-help`
  const updateTask = useAtomSet(updateTaskMutation, { mode: 'promise' })
  const normalizedDescription = description.length === 0 ? null : description
  const trimmedTitle = title.trim()
  const dirty = title !== baseline.title || description !== baseline.description
  // Only scold about an empty title once the person has emptied it themselves.
  const titleMissing = dirty && trimmedTitle.length === 0
  const hasTitleMessage = titleMissing || presented.isPlaceholder
  const canSave = dirty && trimmedTitle.length > 0 && !saving

  // The board keeps polling while this dialog is open. A card that changed
  // elsewhere replaces an untouched form outright, so the fields never show a
  // stale card; a draft in progress is kept instead, because silently wiping a
  // half-written brief is worse than admitting the card moved underneath it.
  useEffect(() => {
    if (task.revision === baseline.revision) {
      return
    }
    if (dirty) {
      setChangedElsewhere(true)
      // Keep the revision the draft started from until a CAS conflict proves
      // it stale. Otherwise a poll arriving just before Save would silently
      // advance the CAS and let this draft overwrite the newer card.
      if (saveError?.conflict) {
        setBaseline((current) => ({ ...current, revision: task.revision }))
      }
      return
    }
    setTitle(incomingTitle)
    setDescription(incomingDescription)
    setBaseline({
      description: incomingDescription,
      revision: task.revision,
      title: incomingTitle,
    })
    setChangedElsewhere(false)
    setSaveError(null)
  }, [
    baseline.revision,
    dirty,
    incomingDescription,
    incomingTitle,
    saveError?.conflict,
    task.revision,
  ])

  // Leaving the discard question takes its buttons away with it. Without this
  // the caret lands nowhere and the next keystroke goes to the page.
  useEffect(() => {
    if (!confirmingDiscard) {
      lastFieldRef.current?.focus()
    }
  }, [confirmingDiscard])

  // One banner at a time: a card that moved underneath the draft is the fresher
  // and more actionable news, so it outranks the failure that preceded it.
  const banner = (() => {
    if (changedElsewhere) {
      return {
        message:
          'This card changed elsewhere. Your edits are still here — Save will report the conflict before you can apply them over the newer version.',
        tone: 'warning' as const,
      }
    }
    if (saveError) {
      return {
        message: saveError.message,
        tone: saveError.conflict ? ('warning' as const) : ('error' as const),
      }
    }
    return null
  })()

  /**
   * Esc, the close button, and Cancel all land here. The first attempt with
   * unsaved work asks; a second one takes the answer and discards.
   */
  const requestClose = () => {
    if (saving) {
      return
    }
    if (dirty && !confirmingDiscard) {
      setConfirmingDiscard(true)
      return
    }
    onOpenChange(false)
  }

  const save = async () => {
    if (!canSave) {
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      await updateTask({
        payload: {
          description: normalizedDescription,
          expectedRevision: baseline.revision,
          taskId: task.id,
          title: trimmedTitle,
        },
      })
      onOpenChange(false)
    } catch (error) {
      const conflict = extractErrorCode(error) === 'CAS_CONFLICT'
      const message = conflict
        ? 'This card changed elsewhere. Your edits are still here — save again once the newer version lands to apply them over it.'
        : extractErrorMessage(error)
      if (conflict && task.revision !== baseline.revision) {
        // The board poll already supplied the winning row. Advance only after
        // surfacing the conflict so the next deliberate Save can overwrite it.
        setBaseline((current) => ({ ...current, revision: task.revision }))
      }
      setSaveError({ conflict, message })
      toast.error(conflict ? 'Card changed elsewhere' : 'Could not save card', {
        description: message,
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          requestClose()
        }
      }}
      open
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader className="gap-2 pr-8">
          <div className="flex flex-wrap items-center gap-2">
            <DialogTitle>Card details</DialogTitle>
            <SourceBadge source={task.source} />
          </div>
          <DialogDescription>
            Name the card and write the brief its agent starts from.
          </DialogDescription>
          <TaskDetailMeta task={task} />
        </DialogHeader>
        {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: ⌘↵ submits from either field */}
        <form
          className="grid gap-5"
          onKeyDown={(event) => {
            // ⌘↵ saves from either field, matching the workspace form.
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              save()
            }
          }}
          onSubmit={(event) => {
            event.preventDefault()
            save()
          }}
        >
          <Field data-invalid={titleMissing}>
            <div className="flex items-baseline justify-between gap-2">
              <FieldLabel htmlFor={titleId}>Title</FieldLabel>
              {title.length >= TITLE_COUNTER_THRESHOLD && (
                <span className="text-muted-foreground text-xs tabular-nums">
                  {TITLE_LIMIT - title.length} left
                </span>
              )}
            </div>
            <Input
              // The message under the field is the only explanation for a
              // disabled Save, so the field has to carry it to a screen reader.
              aria-describedby={hasTitleMessage ? titleMessageId : undefined}
              aria-invalid={titleMissing}
              autoFocus
              className="font-medium"
              id={titleId}
              maxLength={TITLE_LIMIT}
              onChange={(event) => {
                setTitle(event.target.value)
                setSaveError(null)
                setConfirmingDiscard(false)
              }}
              onFocus={(event) => {
                lastFieldRef.current = event.currentTarget
              }}
              placeholder={
                presented.isPlaceholder ? presented.text : 'Name this card'
              }
              // Read-only rather than disabled: a disabled field drops focus
              // mid-save and the caret would jump out of the person's edit.
              readOnly={saving}
              value={title}
            />
            {titleMissing && (
              <FieldError id={titleMessageId}>A card needs a title.</FieldError>
            )}
            {presented.isPlaceholder && !titleMissing && (
              <FieldDescription className="text-xs" id={titleMessageId}>
                Still unnamed — saving a title here replaces the stand-in the
                board shows.
              </FieldDescription>
            )}
          </Field>
          <Field>
            <div className="flex items-baseline justify-between gap-2">
              <FieldLabel htmlFor={descriptionId}>Description</FieldLabel>
              {description.length > 0 && (
                <span
                  className={cn(
                    'text-muted-foreground text-xs tabular-nums',
                    description.length > DESCRIPTION_LIMIT * 0.9 &&
                      'text-warning'
                  )}
                >
                  {description.length.toLocaleString()} characters
                </span>
              )}
            </div>
            <Textarea
              aria-describedby={descriptionHelpId}
              className="min-h-40 resize-y"
              id={descriptionId}
              maxLength={DESCRIPTION_LIMIT}
              onChange={(event) => {
                setDescription(event.target.value)
                setSaveError(null)
                setConfirmingDiscard(false)
              }}
              onFocus={(event) => {
                lastFieldRef.current = event.currentTarget
              }}
              placeholder="What should the agent know or do?"
              readOnly={saving}
              value={description}
            />
            <FieldDescription className="text-xs" id={descriptionHelpId}>
              Plain text — used as the agent’s initial prompt when this card
              enters In Progress.
            </FieldDescription>
          </Field>
          {banner && (
            <div
              aria-live="polite"
              className={cn(
                'flex gap-2 rounded-md border px-3 py-2 text-sm',
                banner.tone === 'warning'
                  ? 'border-warning/30 bg-warning/10 text-warning'
                  : 'border-destructive/30 bg-destructive/10 text-destructive'
              )}
              role="alert"
            >
              <TriangleAlert
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0"
              />
              <span>{banner.message}</span>
            </div>
          )}
          <TaskDetailFooter
            canSave={canSave}
            confirmingDiscard={confirmingDiscard}
            dirty={dirty}
            onCancel={requestClose}
            onDiscard={() => onOpenChange(false)}
            onKeepEditing={() => setConfirmingDiscard(false)}
            saving={saving}
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The kanban board: one lane per LiveStore project, collapse state
 * shared with the sidebar's project groups (same keys, same instance).
 */
function TaskBoard({
  collapseState,
  onDismiss,
  open,
}: {
  readonly collapseState: CollapseState
  /**
   * Put the board away. It is an overlay over the very panes a card sends you
   * to, so following a card has to close it; only the owner of the overlay
   * knows how.
   */
  readonly onDismiss: () => void
  readonly open: boolean
}) {
  const store = useLaborerStore()
  const projectList = store.useQuery(boardProjects$)
  const workspaceList = store.useQuery(boardWorkspaces$)
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
          Stream.unwrap,
          // A dropped backend socket (OS sleep/wake) fails this stream even
          // though the protocol reconnects underneath. Every fresh
          // subscription starts with a full snapshot and
          // `applyTaskBoardEvents` clears on snapshot, so resubscribing is
          // safe — the board self-heals instead of dying with "Task board
          // unavailable" until app restart. Defects still surface.
          Stream.tapErrorCause((cause) =>
            Effect.sync(() => {
              console.warn(
                '[TaskBoard] subscription failed, resubscribing',
                Cause.squash(cause)
              )
            })
          ),
          Stream.retry(Schedule.spaced('2 seconds'))
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
  // snapshot that opened it, so a card that changes elsewhere reaches the open
  // form — which decides for itself whether to adopt it or protect a draft.
  const selectedTask = boardTasks.find((task) => task.id === selectedTaskId)

  /**
   * The workspace a card's work runs in, resolved once per card so the card
   * it renders and the click it answers never disagree about where it leads.
   */
  const workspaceForCard = (
    task: BoardTask,
    project: { readonly name: string; readonly repoPath: string }
  ) => {
    const row = workspaceForTask(task, workspaceList)
    return row === undefined
      ? undefined
      : {
          isRoot: row.worktreePath === project.repoPath,
          projectName: project.name,
          row,
        }
  }

  /**
   * A card's body leads to its work. Once the work has a workspace, the board
   * hands the operator over to it and gets out of the way; until then the card
   * itself is all there is, so the form opens rather than leaving the click
   * unanswered.
   */
  const activateTask = (task: BoardTask) => {
    const workspace = workspaceForTask(task, workspaceList)
    if (workspace === undefined) {
      setSelectedTaskId(task.id)
      return
    }
    panelActions?.focusWorkspace(workspace.id)
    onDismiss()
  }

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
        <BoardSearch
          onChange={setSearchQuery}
          open={open}
          value={searchQuery}
        />
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
                    onActivateTask={activateTask}
                    onAttach={handleAttach}
                    onCancelTask={cancelTask}
                    onMoveTask={persistMove}
                    onOpenTask={(task) => setSelectedTaskId(task.id)}
                    projectId={project.id}
                    tasks={visibleTasks}
                    workspaceForCard={(task) => workspaceForCard(task, project)}
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
          key={selectedTask.id}
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

export { AddCardComposer, TaskBoard, TaskBoardCard, TaskDetailDialog }
