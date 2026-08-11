import type {
  BoardTask as RpcBoardTask,
  TaskBoardEvent,
} from '@laborer/shared/rpc'

export type BoardTaskStatus = RpcBoardTask['status']
export type BoardTaskSource = RpcBoardTask['source']
export type ExecutionMirror = RpcBoardTask['executionStatus']
export type WorktreeState = 'exists' | 'provisioning' | 'gone' | 'none'
export type SlackAnalysisState = 'analyzing' | 'failed' | null

export interface BoardPr {
  readonly number: number
  readonly state: 'open' | 'merged' | 'closed'
  readonly title: string
  readonly url: string
}

export interface BoardTask extends RpcBoardTask {
  readonly branch: string | null
  readonly executionMirror: ExecutionMirror
  readonly pr: BoardPr | null
  readonly worktreeState: WorktreeState
}

const worktreeState = (task: RpcBoardTask): WorktreeState => {
  if (task.worktreePath === null) {
    return 'none'
  }
  if (task.worktreeExists) {
    return 'exists'
  }
  return task.status === 'in_progress' &&
    (task.executionStatus === 'queued' || task.executionStatus === 'running')
    ? 'provisioning'
    : 'gone'
}

const toBoardTask = (task: RpcBoardTask): BoardTask => ({
  ...task,
  branch: task.branchName,
  executionMirror: task.executionStatus,
  pr: null,
  worktreeState: worktreeState(task),
})

/** Apply an RPC stream's snapshot/deltas into the renderer's task projection. */
export const applyTaskBoardEvents = (
  events: readonly TaskBoardEvent[],
  initialTasks: readonly RpcBoardTask[] = []
): readonly BoardTask[] => {
  const tasks = new Map(initialTasks.map((task) => [task.id, task]))
  for (const event of events) {
    if (event._tag === 'snapshot') {
      tasks.clear()
    } else {
      for (const taskId of event.deletedTaskIds) {
        tasks.delete(taskId)
      }
    }
    for (const task of event.tasks) {
      tasks.set(task.id, task)
    }
  }
  return [...tasks.values()].map(toBoardTask)
}

export interface BoardProject {
  readonly id: string
  readonly repoPath: string
}

/** The workspace fields the board needs to recognise a card's workspace. */
export interface BoardWorkspace {
  readonly id: string
  readonly status: string
  readonly worktreePath: string
}

/**
 * The workspace a card's work already lives in, if any.
 *
 * The worktree path is the identity both surfaces agree on: a card and a
 * workspace pointing at the same directory are the same piece of work. A card
 * with no worktree — a Todo nobody has started — has no workspace to open, and
 * says so by returning nothing rather than guessing from a branch name.
 */
export const workspaceForTask = <Workspace extends BoardWorkspace>(
  task: Pick<BoardTask, 'worktreePath'>,
  workspaces: readonly Workspace[]
): Workspace | undefined =>
  task.worktreePath === null
    ? undefined
    : workspaces.find(
        (workspace) =>
          workspace.status !== 'destroyed' &&
          workspace.worktreePath === task.worktreePath
      )

export const slackAnalysisState = (
  task: Pick<BoardTask, 'executionMirror' | 'description' | 'source'>
): SlackAnalysisState => {
  if (task.source !== 'slack_url' || task.description !== null) {
    return null
  }
  return task.executionMirror === 'failed' ? 'failed' : 'analyzing'
}

/** Slack conversation IDs: channels, DMs, and group DMs. */
const SLACK_CONVERSATION_PATTERN = /^[CDG][A-Z0-9]{2,}$/

/**
 * A readable stand-in for a Slack card that has not been named yet. The
 * conversation ID keeps concurrently analyzing cards distinguishable.
 */
const slackThreadLabel = (permalink: string): string => {
  let segments: readonly string[] = []
  try {
    segments = new URL(permalink).pathname.split('/').filter(Boolean)
  } catch {
    return 'Slack thread'
  }
  const conversation = segments.find((segment) =>
    SLACK_CONVERSATION_PATTERN.test(segment)
  )
  return conversation ? `Slack thread · ${conversation}` : 'Slack thread'
}

export interface BoardTaskTitle {
  /** True while the card still carries its creation-time placeholder title. */
  readonly isPlaceholder: boolean
  readonly text: string
}

/**
 * What the card shows as its title. A Slack card is stored with its permalink
 * as the title until the planner writes one, and a raw URL reads poorly on a
 * card, so it is presented as a readable thread label until then.
 */
export const boardTaskTitle = (
  task: Pick<BoardTask, 'slackPermalink' | 'source' | 'title'>
): BoardTaskTitle =>
  task.source === 'slack_url' &&
  task.slackPermalink !== null &&
  task.title === task.slackPermalink
    ? { isPlaceholder: true, text: slackThreadLabel(task.slackPermalink) }
    : { isPlaceholder: false, text: task.title }

/** Return the equal or nearest-ancestor project for a canonical task root. */
export const projectForTask = <Project extends BoardProject>(
  task: Pick<BoardTask, 'rootPath'>,
  projects: readonly Project[]
): Project | undefined =>
  projects
    .filter(
      ({ repoPath }) =>
        repoPath === task.rootPath ||
        task.rootPath.startsWith(
          repoPath.endsWith('/') ? repoPath : `${repoPath}/`
        )
    )
    .sort((left, right) => right.repoPath.length - left.repoPath.length)[0]
