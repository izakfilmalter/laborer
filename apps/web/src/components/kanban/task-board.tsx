/**
 * Shared-task-db kanban board — an overlay above the panel area (Cmd+K).
 *
 * One global board where each shared-database project is a collapsible swim
 * lane (Todo / In Progress / In Review / Done per lane). Lane collapse
 * shares the sidebar's project collapse state instance, so collapsing a
 * project in either place collapses it in both, live in-session.
 * Cancelled cards are stored but never rendered. Drag uses the vendored
 * reui kanban (dnd-kit); each lane is its own Kanban root so cards can
 * never cross projects.
 *
 * The renderer subscribes to typed snapshots/deltas and never opens SQLite.
 */

import { useAtomSet, useAtomValue } from '@effect/atom-react/Hooks'
import { isSlackMessageUrl } from '@laborer/shared/slack-url'
import { createTaskUlid } from '@laborer/task-db/ulid'
import {
  AlignLeft,
  Bot,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ExternalLink,
  FolderGit2,
  GitBranch,
  Pencil,
  Slack,
  SquarePen,
  Terminal,
  TriangleAlert,
  X,
} from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { LaborerClient } from '@/atoms/laborer-client'
import { pendingTaskRow } from '@/atoms/optimistic-task-writes'
import {
  authoritativeTasksAtom,
  clearTaskCreateOverlayAtom,
  clearTaskOptimisticOverlayAtom,
  confirmTaskOptimisticMoveAtom,
  installTaskCreateOverlayAtom,
  installTaskOptimisticOverlayAtom,
  projectViewsAtom,
  type TaskOptimisticOverlay,
  taskMutationReceiptAtom,
  taskRowsAtom,
  workspaceViewsAtom,
} from '@/atoms/shared-state'
import { CardShell } from '@/components/card-shell'
import { GitHubPrStatusBadge } from '@/components/github-pr-status-badge'
import {
  type ComposerCloseReason,
  ComposerToggleButton,
  InlineComposer,
} from '@/components/inline-composer'
import {
  BOARD_COLUMNS,
  type BoardColumn,
} from '@/components/kanban/board-columns'
import {
  type BoardTask,
  type BoardTaskStatus,
  boardTasksFromSharedRows,
  boardTaskTitle,
  projectForTask,
  slackAnalysisState,
  workspaceForTask,
} from '@/components/kanban/board-data'
import { BoardSearch } from '@/components/kanban/board-search'
import {
  effectiveSortOrder,
  fractionalOrderAt,
  OptimisticTaskMoveQueue,
} from '@/components/kanban/optimistic-task-moves'
import {
  openProvisionedAgent,
  resolvePendingAgentOpen,
} from '@/components/kanban/provisioned-agent'
import { SourceBadge } from '@/components/kanban/source-badge'
import { useTaskEditor } from '@/components/kanban/task-editor'
import {
  TerminalAttachButton,
  WorktreeChip,
} from '@/components/kanban/worktree-affordance'
import {
  ProjectDragHandle,
  ProjectDropIndicator,
  useProjectDragItem,
  useProjectReorderMonitor,
} from '@/components/project-reorder'
import {
  Kanban,
  KanbanBoard,
  KanbanColumn,
  KanbanColumnContent,
  KanbanItem,
  KanbanItemHandle,
  KanbanOverlay,
} from '@/components/reui/kanban'
import { TaskIdentifier } from '@/components/task-identifier'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
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
import { useProjectShortName } from '@/hooks/use-project-short-name'
import { localApi } from '@/lib/local-api'
import { cn, extractErrorCode, extractErrorMessage } from '@/lib/utils'
import { usePanelActions } from '@/panels/panel-context'
import { TerminalPane } from '@/panes/terminal-pane'

const DONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
/**
 * Every column stands at least five cards tall, so a lane reads as a board
 * rather than four ragged stacks, and no column can be shorter than its
 * neighbours.
 */
const COLUMN_MIN_HEIGHT = 'min-h-[24rem]'
/**
 * Done is an archive, not the work. Past this many cards it offers to unfold
 * rather than growing; until then it is already as tall as the lane allows.
 */
const DONE_COLLAPSED_CARD_LIMIT = 5
const createTaskMutation = LaborerClient.mutation('task.create')
const moveTaskMutation = LaborerClient.mutation('task.move')
const attachTaskTerminalMutation = LaborerClient.mutation(
  'task.terminal.attach'
)

/**
 * Group tasks into rendered columns. Cards sort by their effective rank —
 * explicit manual rank wins, and unranked new and incoming cards derive a
 * newest-first rank at the top — so a drag that mints a rank between any two
 * neighbors lands exactly where it was dropped.
 */
function buildColumnTasks(
  tasks: readonly BoardTask[]
): Record<string, BoardTask[]> {
  const byColumn: Record<string, BoardTask[]> = {}
  for (const column of BOARD_COLUMNS) {
    byColumn[column.id] = []
  }
  const doneCutoff = Date.now() - DONE_RETENTION_MS
  const sorted = [...tasks].sort(
    (a, b) =>
      effectiveSortOrder(a) - effectiveSortOrder(b) || b.createdAt - a.createdAt
  )
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
  projectId,
  projectShortName,
  task,
  attachBlocked = false,
  attached = false,
  attaching = false,
  isOverlay = false,
  onActivate,
  onAttach,
  onCancel,
  onOpen,
  parentTitle,
  workspace,
}: {
  readonly task: BoardTask
  readonly projectId: string
  readonly projectShortName?: string | null
  readonly attachBlocked?: boolean
  readonly attached?: boolean
  readonly attaching?: boolean
  readonly isOverlay?: boolean
  readonly onActivate?: (task: BoardTask) => void
  readonly onAttach?: (task: BoardTask) => void
  readonly onCancel?: (task: BoardTask) => void
  readonly onOpen?: (task: BoardTask) => void
  readonly parentTitle?: string | undefined
  /** The workspace this card's work already runs in, if any. */
  readonly workspace?: BoardCardWorkspace | undefined
}) {
  const openSlack = (event: React.MouseEvent) => {
    event.stopPropagation()
    if (task.slackPermalink) {
      localApi.openExternal(task.slackPermalink)
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
      {parentTitle && (
        <Badge className="max-w-full shrink truncate" variant="secondary">
          Parent: {parentTitle}
        </Badge>
      )}
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
      {/* A card wearing a workspace gets the PR chip from the workspace's own
          status rail, so the board only carries it while the card is standing
          in for a workspace that does not exist yet. */}
      {task.pr && !workspace && (
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
        projectShortName={projectShortName}
        showCreateSubWorkspaceAction={false}
        // The board hangs its own Pencil off `actions`, alongside the Slack
        // link and cancel that only it has.
        showDestroyAction={false}
        // Destroying a workspace belongs where the workspace lives. The
        // board's destructive act is cancelling the card.
        showEditAction={false}
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
          <TaskIdentifier
            projectId={projectId}
            projectShortName={projectShortName}
            taskNumber={task.taskNumber}
          />
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
    <ComposerToggleButton
      className="ml-auto"
      closedLabel="Add card"
      composerId={composerId}
      id={id}
      label={`Add card to ${columnTitle}`}
      onToggle={onToggle}
      open={open}
    />
  )
}

/**
 * The inline card composer for one column — the shared composer, configured
 * for card titles and Slack links. The card is optimistic: this mints its id
 * so the synthesized row and the stored row share one identity, and withdraws
 * it if the create is rejected.
 */
function AddCardComposer({
  column,
  composerId,
  onClose,
  onSlackCardQueued,
  projectId,
  projectRootPath,
}: {
  readonly column: BoardColumn
  readonly composerId: string
  readonly onClose: (reason: ComposerCloseReason) => void
  /**
   * A Slack card was created directly in In Progress, so its analysis and
   * workspace are being provisioned by a detached server fiber; the board
   * opens the agent once that workspace lands.
   */
  readonly onSlackCardQueued?: (taskId: string) => void
  readonly projectId: string
  /** Canonical repo root for the lane, mirrored onto the optimistic row. */
  readonly projectRootPath: string
}) {
  const createTask = useAtomSet(createTaskMutation, { mode: 'promise' })
  const installCreateOverlay = useAtomSet(installTaskCreateOverlayAtom)
  const clearCreateOverlay = useAtomSet(clearTaskCreateOverlayAtom)
  const panelActions = usePanelActions()

  const commit = (text: string) => {
    // The card renders from the synthesized row now. The overlay settles when
    // the authoritative stream stores the id.
    const id = createTaskUlid()
    installCreateOverlay(
      pendingTaskRow({
        id,
        now: Date.now(),
        rootPath: projectRootPath,
        status: column.id,
        text,
      })
    )

    return createTask({
      payload: { id, projectId, status: column.id, text },
    })
      .then((created) => {
        openProvisionedAgent(
          created,
          panelActions?.autoOpenAgentWhenWorkspaceReady
        )
        if (
          created.source === 'slack_url' &&
          column.id === 'in_progress' &&
          created.workspaceId === null
        ) {
          onSlackCardQueued?.(created.id)
        }
      })
      .catch((cause: unknown) => {
        clearCreateOverlay(id)
        // The composer reports it and puts the text back.
        throw cause
      })
  }

  return (
    <div className="px-2 pt-1.5">
      <InlineComposer
        addon={(trimmed) =>
          composerIntent(trimmed) === 'slack' ? (
            <Slack aria-hidden="true" className="size-3.5" />
          ) : (
            <SquarePen aria-hidden="true" className="size-3.5" />
          )
        }
        ariaLabel={`Card title or Slack message link for ${column.title}`}
        commit={commit}
        commitsOnPaste={isSlackMessageUrl}
        composerId={composerId}
        confirmation={(trimmed) =>
          composerIntent(trimmed) === 'slack'
            ? `Slack card added to ${column.title} — analyzing in the background.`
            : `Card added to ${column.title}.`
        }
        hint={(trimmed) => {
          const intent = composerIntent(trimmed)
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
          return null
        }}
        idleHint={() => 'Enter to add · Esc to close'}
        onClose={onClose}
        placeholder="Title, or paste a Slack link"
      />
    </div>
  )
}

/**
 * A lane's project heading: collapse toggle, card count, and the grab area
 * that reorders the project. Lane order is the shared project order, so a
 * lane dragged here also moves in the sidebar.
 */
function ProjectLane({
  children,
  count,
  expanded,
  index,
  onToggle,
  project,
  reorderEnabled,
}: {
  readonly children: React.ReactNode
  readonly count: number
  readonly expanded: boolean
  readonly index: number
  readonly onToggle: () => void
  readonly project: { readonly id: string; readonly name: string }
  readonly reorderEnabled: boolean
}) {
  const laneRef = useRef<HTMLDivElement | null>(null)
  const headingRef = useRef<HTMLDivElement | null>(null)
  const { closestEdge, isDragging } = useProjectDragItem({
    dragHandleRef: headingRef,
    elementRef: laneRef,
    enabled: reorderEnabled,
    index,
    projectId: project.id,
    surface: 'board',
  })

  return (
    <div
      className={cn(
        'group/project relative flex flex-col gap-1.5 transition-opacity',
        isDragging && 'opacity-40'
      )}
      data-project-id={project.id}
      data-testid="task-board-lane"
      ref={laneRef}
    >
      <ProjectDropIndicator edge={closestEdge} />
      <div className="flex w-fit items-center gap-1" ref={headingRef}>
        <ProjectDragHandle
          disabled={!reorderEnabled}
          projectId={project.id}
          projectName={project.name}
        />
        <Button
          className="h-8 justify-start gap-2 px-2"
          onClick={onToggle}
          variant="ghost"
        >
          {expanded ? (
            <ChevronDown className="size-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-4 text-muted-foreground" />
          )}
          <FolderGit2 className="size-4 text-muted-foreground" />
          <span className="truncate font-medium text-sm">{project.name}</span>
          <span className="text-muted-foreground text-sm tabular-nums">
            {count}
          </span>
        </Button>
      </div>
      {children}
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
  onSlackCardQueued,
  projectId,
  projectRootPath,
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
    status: Exclude<BoardTaskStatus, 'cancelled'>,
    sortOrder: number
  ) => void
  readonly onOpenTask: (task: BoardTask) => void
  readonly onSlackCardQueued: (taskId: string) => void
  readonly projectId: string
  /** Canonical repo root for the lane, mirrored onto optimistic rows. */
  readonly projectRootPath: string
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
  // Done is clipped by default so the archive never sets the lane's height.
  const [doneExpanded, setDoneExpanded] = useState(false)
  const laneId = useId()
  const projectShortName = useProjectShortName(projectId)

  // Server-side card changes reset the local drag state without remounting the
  // lane, so a card arriving in the background never steals a half-typed
  // composer or its focus.
  const signature = useMemo(
    () =>
      tasks
        .map(
          (task) =>
            `${task.id}:${String(task.revision)}:${task.status}:${String(task.sortOrder)}`
        )
        .join(','),
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
      onMove={({ event, overContainer }) => {
        const task = tasksById.get(String(event.active.id))
        const status = BOARD_COLUMNS.find(
          (column) => column.id === overContainer
        )?.id
        if (!(task && status)) {
          setColumnTasks(buildColumnTasks(tasks))
          return
        }
        const destination = columnTasks[overContainer] ?? []
        const index = destination.findIndex(({ id }) => id === task.id)
        if (index < 0) {
          setColumnTasks(buildColumnTasks(tasks))
          return
        }
        onMoveTask(task, status, fractionalOrderAt(destination, index))
      }}
      onValueChange={setColumnTasks}
      value={columnTasks}
    >
      <KanbanBoard className="grid max-h-[80vh] min-h-0 min-w-0 grid-cols-4 grid-rows-[minmax(0,1fr)] gap-2 sm:grid-cols-4">
        {BOARD_COLUMNS.map((column) => {
          const composerId = `${laneId}-${column.id}-composer`
          const addButtonId = `${laneId}-${column.id}-add`
          const composerOpen = composerColumn === column.id
          const cards = columnTasks[column.id] ?? []
          const isDone = column.id === 'done'
          // Clipped Done is laid out over its own footprint, so its cards
          // cannot stretch the lane; every other column still can.
          const clipped = isDone && !doneExpanded
          const closeComposer = (reason: ComposerCloseReason) => {
            setComposerColumn(null)
            if (reason === 'cancel') {
              document.getElementById(addButtonId)?.focus()
            }
          }

          return (
            <KanbanColumn
              className="min-h-0 min-w-0"
              data-status={column.id}
              data-testid="task-board-column"
              key={column.id}
              value={column.id}
            >
              <div className="flex min-h-0 min-w-0 flex-1 flex-col rounded-lg bg-muted/50">
                <div className="flex min-w-0 shrink-0 items-center gap-2 pt-1.5 pr-1.5 pb-0.5 pl-3">
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
                    {cards.length}
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
                    onSlackCardQueued={onSlackCardQueued}
                    projectId={projectId}
                    projectRootPath={projectRootPath}
                  />
                )}
                <div
                  className={cn(
                    'min-h-0 min-w-0 flex-1',
                    COLUMN_MIN_HEIGHT,
                    clipped && 'relative'
                  )}
                >
                  <div className={cn(clipped && 'absolute inset-0')}>
                    <ScrollArea className="min-h-0" overscrollContain>
                      <KanbanColumnContent
                        className="flex min-h-24 flex-col gap-2 px-2 pt-1.5 pb-2"
                        value={column.id}
                      >
                        {cards.map((task) => (
                          <KanbanItem
                            data-task-id={task.id}
                            data-testid="task-board-card"
                            key={task.id}
                            value={task.id}
                          >
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
                                parentTitle={
                                  task.parentTaskId === null
                                    ? undefined
                                    : tasksById.get(task.parentTaskId)?.title
                                }
                                projectId={projectId}
                                projectShortName={projectShortName}
                                task={task}
                                workspace={workspaceForCard(task)}
                              />
                            </KanbanItemHandle>
                          </KanbanItem>
                        ))}
                        {cards.length === 0 &&
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
                    </ScrollArea>
                  </div>
                </div>
                {isDone && (
                  <div className="flex min-w-0 items-center gap-2 px-3 pb-2">
                    <p className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground/70">
                      Done cards auto-hide after 7 days
                    </p>
                    {cards.length > DONE_COLLAPSED_CARD_LIMIT && (
                      <button
                        aria-expanded={doneExpanded}
                        className="flex shrink-0 items-center gap-1 rounded-sm text-[10px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => setDoneExpanded(!doneExpanded)}
                        type="button"
                      >
                        {doneExpanded ? (
                          <>
                            <ChevronUp className="size-3" />
                            Show less
                          </>
                        ) : (
                          <>
                            <ChevronDown className="size-3" />
                            Show all {cards.length}
                          </>
                        )}
                      </button>
                    )}
                  </div>
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
              parentTitle={
                task.parentTaskId === null
                  ? undefined
                  : tasksById.get(task.parentTaskId)?.title
              }
              projectId={projectId}
              projectShortName={projectShortName}
              task={task}
              workspace={workspaceForCard(task)}
            />
          )
        }}
      </KanbanOverlay>
    </Kanban>
  )
}

/**
 * The kanban board: one lane per shared-database project, collapse state
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
  const projectList = useAtomValue(projectViewsAtom)
  const sharedTaskRows = useAtomValue(taskRowsAtom)
  const authoritativeTasks = useAtomValue(authoritativeTasksAtom).rows
  const taskMutationReceipt = useAtomValue(taskMutationReceiptAtom)
  const workspaceList = useAtomValue(workspaceViewsAtom)
  const panelActions = usePanelActions()
  // Commits lane drags; the sidebar owns its own monitor.
  useProjectReorderMonitor('board')
  const [searchQuery, setSearchQuery] = useState('')
  const [boardTasks, setBoardTasks] = useState<readonly BoardTask[]>([])
  // Editing a card is the same act here as in the sidebar, so the board only
  // says which card to open and where the dialog goes.
  const { openTaskEditor, taskEditor } = useTaskEditor(boardTasks)
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
  const installTaskOverlay = useAtomSet(installTaskOptimisticOverlayAtom)
  const clearTaskOverlay = useAtomSet(clearTaskOptimisticOverlayAtom)
  const confirmTaskMove = useAtomSet(confirmTaskOptimisticMoveAtom)
  const authoritativeTasksRef = useRef(authoritativeTasks)
  authoritativeTasksRef.current = authoritativeTasks
  const moveQueueRef = useRef<OptimisticTaskMoveQueue | null>(null)
  const moveDependencies = {
    clear: (taskId: string, mutationId: string) =>
      clearTaskOverlay({ mutationId, taskId }),
    confirm: (
      confirmation: {
        readonly cursor: number
        readonly row: (typeof authoritativeTasks)[number]
      },
      mutationId: string
    ) => confirmTaskMove({ ...confirmation, mutationId }),
    getAuthoritativeTask: (taskId: string) =>
      authoritativeTasksRef.current.find(({ id }) => id === taskId),
    install: (taskId: string, overlay: TaskOptimisticOverlay) =>
      installTaskOverlay({ overlay, taskId }),
    isConflict: (error: unknown) => extractErrorCode(error) === 'CAS_CONFLICT',
    isDefinitiveFailure: (error: unknown) =>
      extractErrorCode(error) !== undefined,
    mutationId: () => crypto.randomUUID(),
    send: async (command: {
      readonly expectedRevision: number
      readonly mutationId: string
      readonly sortOrder: number | null
      readonly status: BoardTaskStatus
      readonly taskId: string
    }) => {
      const result = await moveTask({ payload: command })
      if (result.workspaceId !== null) {
        openProvisionedAgent(
          result,
          panelActions?.autoOpenAgentWhenWorkspaceReady
        )
      }
      return { cursor: result.cursor, row: result.row }
    },
  }
  if (moveQueueRef.current === null) {
    moveQueueRef.current = new OptimisticTaskMoveQueue(moveDependencies)
  } else {
    moveQueueRef.current.configure(moveDependencies)
  }
  useEffect(() => {
    moveQueueRef.current?.observeMutationIds(taskMutationReceipt.mutationIds)
  }, [taskMutationReceipt])
  useEffect(() => {
    setBoardTasks(boardTasksFromSharedRows(sharedTaskRows))
  }, [sharedTaskRows])

  // Slack cards created directly in In Progress are planned and provisioned
  // by a detached server fiber, so their create response carries no workspace
  // id. Remember them and open the agent — seeded with the planned prompt —
  // once the shared-state task and workspace projections agree the work has a
  // workspace.
  const pendingSlackAgentOpensRef = useRef<Set<string>>(new Set())
  const queueSlackAgentOpen = (taskId: string) => {
    pendingSlackAgentOpensRef.current.add(taskId)
  }
  useEffect(() => {
    const pending = pendingSlackAgentOpensRef.current
    for (const taskId of pending) {
      const resolution = resolvePendingAgentOpen(
        boardTasks.find((task) => task.id === taskId),
        workspaceList
      )
      if (resolution._tag === 'wait') {
        continue
      }
      pending.delete(taskId)
      if (resolution._tag === 'open') {
        openProvisionedAgent(
          {
            description: resolution.description,
            workspaceId: resolution.workspaceId,
          },
          panelActions?.autoOpenAgentWhenWorkspaceReady
        )
      }
    }
  }, [boardTasks, workspaceList, panelActions])

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
      openTaskEditor(task.id)
      return
    }
    panelActions?.focusWorkspace(workspace.id)
    onDismiss()
  }

  const persistMove = (
    task: BoardTask,
    status: Exclude<BoardTaskStatus, 'cancelled'>,
    sortOrder: number
  ) => {
    moveQueueRef.current?.move(task.id, { sortOrder, status })
  }

  const cancelTask = (task: BoardTask) => {
    // Hide immediately; the subscription delta confirms the durable state.
    setBoardTasks((current) => current.filter(({ id }) => id !== task.id))
    moveTask({
      payload: {
        expectedRevision: task.revision,
        mutationId: crypto.randomUUID(),
        sortOrder: task.sortOrder,
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
    <div
      className="relative flex h-full min-h-0 flex-col"
      data-testid="task-board"
    >
      <div className="flex h-10 shrink-0 items-center border-b px-3">
        <BoardSearch
          onChange={setSearchQuery}
          open={open}
          value={searchQuery}
        />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-3 p-3">
          {lanes.map(({ project, visibleTasks }, laneIndex) => {
            const expanded = searching || collapseState.isExpanded(project.id)

            return (
              <ProjectLane
                count={visibleTasks.length}
                expanded={expanded}
                index={laneIndex}
                key={project.id}
                onToggle={() => collapseState.toggle(project.id)}
                project={project}
                reorderEnabled={!searching}
              >
                {expanded && (
                  <LaneBoard
                    attachedTaskId={attachedTerminal?.taskId ?? null}
                    attachingTaskId={attachingTaskId}
                    onActivateTask={activateTask}
                    onAttach={handleAttach}
                    onCancelTask={cancelTask}
                    onMoveTask={persistMove}
                    onOpenTask={(task) => openTaskEditor(task.id)}
                    onSlackCardQueued={queueSlackAgentOpen}
                    projectId={project.id}
                    projectRootPath={project.repoPath}
                    tasks={visibleTasks}
                    workspaceForCard={(task) => workspaceForCard(task, project)}
                  />
                )}
              </ProjectLane>
            )
          })}
          {searching && lanes.length === 0 && (
            <div className="flex items-center justify-center p-8 text-muted-foreground text-sm">
              No matching cards
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
      {taskEditor}
    </div>
  )
}

export { AddCardComposer, TaskBoard, TaskBoardCard }
