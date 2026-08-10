import type {
  BoardTask as RpcBoardTask,
  TaskBoardEvent,
} from '@laborer/shared/rpc'

export type BoardTaskStatus = RpcBoardTask['status']
export type BoardTaskSource = RpcBoardTask['source']
export type ExecutionMirror = RpcBoardTask['executionStatus']
export type WorktreeState = 'exists' | 'provisioning' | 'gone' | 'none'

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
  return task.status === 'in_progress' && task.executionStatus === 'running'
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
  events: readonly TaskBoardEvent[]
): readonly BoardTask[] => {
  const tasks = new Map<string, RpcBoardTask>()
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
